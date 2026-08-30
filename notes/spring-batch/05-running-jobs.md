---
title: "Job 실행 — JobLauncher·JobOperator·JobExplorer"
series: spring-batch
part: "Job과 실행"
order: 5
summary: "Job을 띄우고 멈추고 다시 돌리는 세 인터페이스의 역할 분담과 동기·비동기 실행, JobParameters 식별 규칙을 정리한다."
tags: [Spring Batch, JobLauncher, JobOperator, JobExplorer, JobParameters]
sources: [batch/2026-05-17-batch-job-operator.md, batch/2026-05-17-batch-running-job.md, batch/2026-05-17-batch-advanced-metadata.md]
updated: 2026-08-29
---

실행 진입점이 정리되어 있지 않으면 애플리케이션 시작 시 등록된 Job이 전부 자동으로 돌고, REST 요청 스레드가 Job이 끝날 때까지 블로킹되고, 실패한 실행을 이어 돌리는 대신 DB 상태를 손으로 고치게 된다. Spring Batch는 실행 엔진(JobLauncher), 제어(JobOperator), 조회(JobExplorer)를 분리해 이 문제를 다룬다.

## 핵심 개념

JobLauncher는 `run(Job, JobParameters)` 하나로 JobExecution을 만들어 반환하는 저수준 엔진이다. JobOperator는 `start`·`startNextInstance`·`stop`·`restart`·`abandon`으로 라이프사이클을 제어하며, `start`는 내부에서 JobLauncher를 호출한다. JobExplorer는 `findRunningJobExecutions`·`getJobExecution` 같은 read-only 조회만 담당한다. Spring Boot는 세 bean과 이름으로 Job을 찾는 JobRegistry를 자동 구성한다.

### 라이프사이클 제어

- `start`: 새 JobInstance를 시작한다. 같은 identifying 파라미터로 이미 COMPLETED면 `JobInstanceAlreadyCompleteException`, 실행 중이면 `JobExecutionAlreadyRunningException`이 발생한다.
- `startNextInstance`: Job의 `JobParametersIncrementer`(예: `RunIdIncrementer`)로 파라미터를 증가시켜 새 instance를 만든다.
- `stop`: STOPPING으로 바꾼 뒤 진행 중인 chunk 커밋 경계에서 멈추고 STOPPED가 된다. 즉시 중지가 아니다.
- `restart`: STOPPED·FAILED execution 위에 새 JobExecution을 만들고 ExecutionContext부터 이어 간다. `preventRestart()` Job이나 ABANDONED 상태면 `JobRestartException`이 발생한다.
- `abandon`: execution을 ABANDONED로 옮겨 재시작을 영구히 막는다.

Batch 5.x의 `start(String jobName, Properties)`는 execution id(Long)를 반환한다. Batch 6.0부터는 JobOperator가 JobLauncher를 확장해 JobExecution을 반환하고, FAILED execution을 복구 완료로 표시하는 `recover`가 추가되며, JobExplorer는 JobRepository로 합쳐진다.

### 동기와 비동기

`TaskExecutorJobLauncher`의 기본 `SyncTaskExecutor`는 호출 스레드에서 Job을 끝까지 돌리므로 `run` 반환 시점이 곧 완료 시점이다. 스레드 풀을 주면 JobExecution을 즉시 반환하고 Job은 별도 스레드에서 돈다. CLI 일회성 실행은 동기, `@Scheduled`와 HTTP 트리거는 비동기가 맞다.

### JobParameters와 JobInstance 식별

JobInstance는 Job 이름과 identifying 파라미터의 조합으로 식별된다. 타입은 String·Long·Double·Date·LocalDate·LocalDateTime을 명시하며, `addString("count", "100")`과 `addLong("count", 100L)`은 다른 instance가 된다. 세 번째 인자를 `false`로 주면 non-identifying이 되어 식별에서 빠진다. 비즈니스 키는 identifying, `traceId` 같은 실행 환경 값은 non-identifying으로 둔다.

## 코드

JobOperator로 실행하는 서비스. 예외별로 의미가 다르므로 나누어 처리한다.

```java
@Service
public class JobLaunchService {

    private final JobOperator jobOperator;

    public JobLaunchService(JobOperator jobOperator) {
        this.jobOperator = jobOperator;
    }

    public Long launch(String jobName, LocalDate targetDate) {
        Properties params = new Properties();
        params.setProperty("targetDate", targetDate.toString());
        try {
            return jobOperator.start(jobName, params);
        } catch (JobInstanceAlreadyCompleteException e) {
            throw new IllegalStateException("이미 완료된 파라미터: " + params, e);
        } catch (JobExecutionAlreadyRunningException e) {
            throw new IllegalStateException("같은 instance가 실행 중", e);
        } catch (NoSuchJobException | JobParametersInvalidException e) {
            throw new IllegalArgumentException(e);
        }
    }

    public Long restart(long executionId) throws Exception {
        return jobOperator.restart(executionId);
    }
}
```

HTTP 트리거용 비동기 JobLauncher와 컨트롤러. 202와 execution id를 반환하고 상태는 JobExplorer로 조회한다.

```java
@Configuration
public class BatchLauncherConfig {

    @Bean
    public JobLauncher jobLauncher(JobRepository jobRepository) throws Exception {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setThreadNamePrefix("batch-");
        executor.initialize();

        TaskExecutorJobLauncher launcher = new TaskExecutorJobLauncher();
        launcher.setJobRepository(jobRepository);
        launcher.setTaskExecutor(executor);
        launcher.afterPropertiesSet();
        return launcher;
    }
}

@RestController
@RequestMapping("/api/jobs")
public class JobController {

    private final JobRegistry jobRegistry;
    private final JobLauncher jobLauncher;
    private final JobExplorer jobExplorer;

    public JobController(JobRegistry jobRegistry, JobLauncher jobLauncher, JobExplorer jobExplorer) {
        this.jobRegistry = jobRegistry;
        this.jobLauncher = jobLauncher;
        this.jobExplorer = jobExplorer;
    }

    @PostMapping("/{name}")
    public ResponseEntity<Map<String, Object>> trigger(@PathVariable String name,
                                                       @RequestParam LocalDate targetDate) throws Exception {
        Job job = jobRegistry.getJob(name);
        JobParameters params = new JobParametersBuilder()
                .addLocalDate("targetDate", targetDate)
                .toJobParameters();
        JobExecution execution = jobLauncher.run(job, params);
        return ResponseEntity.accepted()
                .body(Map.of("executionId", execution.getId(), "status", execution.getStatus()));
    }

    @GetMapping("/executions/{id}")
    public ResponseEntity<Map<String, Object>> status(@PathVariable long id) {
        JobExecution execution = jobExplorer.getJobExecution(id);
        if (execution == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(Map.of(
                "status", execution.getStatus(),
                "exitCode", execution.getExitStatus().getExitCode()));
    }
}
```

JobExplorer로 2시간 이상 STARTED인 execution을 찾아 알리는 감시 작업.

```java
@Component
public class StuckJobMonitor {

    private final JobExplorer jobExplorer;
    private final AlertService alertService;

    public StuckJobMonitor(JobExplorer jobExplorer, AlertService alertService) {
        this.jobExplorer = jobExplorer;
        this.alertService = alertService;
    }

    @Scheduled(fixedDelay = 60_000)
    public void check() {
        for (String jobName : jobExplorer.getJobNames()) {
            for (JobExecution execution : jobExplorer.findRunningJobExecutions(jobName)) {
                Duration age = Duration.between(execution.getStartTime(), LocalDateTime.now());
                if (age.toHours() >= 2) {
                    alertService.alert(jobName, execution.getId(), age);
                }
            }
        }
    }
}
```

## 실무에서 걸리는 지점

- **Spring Boot 자동 실행.** `spring.batch.job.enabled` 기본값이 true라 시작 시 등록된 Job이 전부 실행된다. 운영에서는 false로 두거나 `spring.batch.job.name`으로 대상을 한정한다.
- **동기 launcher의 스레드 점유.** `@Scheduled`에서 동기 launcher를 쓰면 스케줄러 스레드가 묶여 다음 cron이 밀리고, HTTP에서는 응답이 Job 완료까지 지연된다.
- **stop 이후 polling.** `stop`은 STOPPING 마킹만 하고 반환한다. 곧바로 `restart`하면 아직 STARTED라 실패하므로 STOPPED를 확인한 뒤 다음 명령을 보낸다.
- **파라미터 타입 drift.** 코드는 `addLong`, CLI는 String으로 넘기면 다른 JobInstance가 되어 재시작이 이어지지 않는다. CLI에서는 `param(long)=123`처럼 타입 힌트를 붙인다.
- **메타데이터 누적.** `BATCH_*` 테이블은 계속 쌓이므로 대시보드 polling이 잦으면 DB 부담이 커진다. 조회 결과를 캐시하고 오래된 이력은 FK 순서로 정리한다.

## 관련 글

- [JobRepository와 메타데이터 스키마](/notes/spring-batch/job-repository-schema/)
- [Job 설정 — JobBuilder·Validator·Listener](/notes/spring-batch/configuring-job/)
- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
