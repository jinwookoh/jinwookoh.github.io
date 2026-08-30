---
title: "Job 설정 — JobBuilder·Validator·Listener"
series: spring-batch
part: "Job과 실행"
order: 3
summary: "JobBuilder로 Step 흐름·재시작 정책·파라미터 검증·Incrementer·Listener를 한 번에 정의하는 방법"
tags: [Spring Batch, JobBuilder, JobParametersValidator, JobParametersIncrementer, JobExecutionListener]
sources: [batch/2026-05-17-batch-configuring-job.md, 2026-05-03-spring-batch-job-config.md]
updated: 2026-08-29
---

Job 정의를 소홀히 하면 같은 문제가 반복된다. 같은 JobParameters로 두 번째 실행하면 JobInstance가 이미 완료됐다는 이유로 거부되고, 필수 파라미터가 빠진 Job은 Step 중간에서 NullPointerException으로 죽는다. JobBuilder의 Validator·Incrementer·Listener·restart 옵션은 이 문제를 정의 시점에 고정하는 장치다.

## 핵심 개념

### JobBuilder와 Step 연결

Spring Batch 5부터 `JobBuilderFactory`·`StepBuilderFactory`는 deprecated 되었고 6에서 제거됐다. `@EnableBatchProcessing`도 Spring Boot 3.x에서는 붙이지 않는다. 붙이면 Boot 자동 구성이 물러난다. Job은 `new JobBuilder(name, jobRepository)`로 정의하고 `start()`·`next()`로 Step을 잇는다. 앞 Step이 실패하면 뒤 Step은 실행되지 않고 Job은 FAILED가 된다.

Job·Step 이름은 메타데이터 테이블에 저장되므로, 이름을 바꾸면 이전 이력과 끊긴다.

### 조건부 흐름

Step의 ExitStatus에 따라 분기할 때는 `on()`·`to()`·`from()`을 조합한다. 이 체인을 쓰면 빌더가 `FlowJobBuilder`로 바뀌고, `build()` 직전에 반드시 `end()`를 호출해야 한다.

| 메서드 | 역할 |
|:---|:---|
| `on("CODE")` | ExitStatus 패턴. `*`는 전체, `PREFIX_*`는 접두사 |
| `to(step)` | 조건 충족 시 이동할 Step |
| `from(step)` | 이미 등장한 Step에서 분기 추가 |
| `end()` / `fail()` | 경로를 COMPLETED / FAILED로 종료 |

ExitStatus는 애플리케이션이 임의 문자열로 정하는 흐름 제어용 값이다. `StepExecutionListener.afterStep()`이 반환한 값이 Step의 종료 코드가 되므로 처리 건수 같은 결과를 분기 조건으로 쓸 수 있다.

### 재시작 정책

Job은 기본적으로 restartable이다. 실패한 JobExecution은 같은 JobInstance의 새 JobExecution으로 재시작되며 완료된 Step은 건너뛴다. `preventRestart()`를 지정하면 재시작이 `JobRestartException`으로 거부된다. 멱등성이 없는 작업에만 쓴다.

### Validator와 Incrementer

`JobParametersValidator`는 시작 전에 파라미터를 검사하고 위반 시 `JobParametersInvalidException`으로 실행을 막는다. `DefaultJobParametersValidator`에 필수 키와 선택 키 배열만 넘기면 구현 없이 쓸 수 있다.

`JobParametersIncrementer`는 직전 파라미터로 다음 실행용 파라미터를 만든다. `RunIdIncrementer`는 `run.id`를 1씩 올려 매번 새 JobInstance를 만든다. Incrementer는 `JobOperator.startNextInstance()`와 Boot 커맨드라인 경로에서만 호출된다.

### JobExecutionListener

`beforeJob()`·`afterJob()`으로 Job 전후에 개입한다. 외부 시스템 lock 획득·해제, 완료·실패 통지가 주된 용도다. `afterJob()`에서 `setExitStatus()`를 호출하면 Job의 ExitStatus를 커스텀 코드로 바꿀 수 있다. `@BeforeJob`·`@AfterJob`을 붙인 일반 빈을 `listener()`에 넘겨도 동일하다.

## 코드

필수 파라미터 검증·run.id 증가·전후 리스너를 갖춘 순차 Job이다.

```java
@Configuration
public class DailyReportJobConfig {

    @Bean
    public Job dailyReportJob(JobRepository jobRepository,
                              Step extractStep, Step transformStep, Step loadStep,
                              JobExecutionListener reportJobListener) {
        return new JobBuilder("dailyReportJob", jobRepository)
                .incrementer(new RunIdIncrementer())
                .validator(new DefaultJobParametersValidator(
                        new String[] {"targetDate"},
                        new String[] {"limit"}))
                .listener(reportJobListener)
                .start(extractStep)
                .next(transformStep)
                .next(loadStep)
                .build();
    }

    @Bean
    public JobExecutionListener reportJobListener() {
        return new JobExecutionListener() {
            private static final Logger log = LoggerFactory.getLogger("reportJob");

            @Override
            public void beforeJob(JobExecution jobExecution) {
                log.info("start {} params={}",
                        jobExecution.getJobInstance().getJobName(),
                        jobExecution.getJobParameters());
            }

            @Override
            public void afterJob(JobExecution jobExecution) {
                if (jobExecution.getStatus() == BatchStatus.COMPLETED) {
                    log.info("completed in {}",
                            Duration.between(jobExecution.getStartTime(), jobExecution.getEndTime()));
                } else {
                    log.error("failed: {}", jobExecution.getAllFailureExceptions());
                }
            }
        };
    }
}
```

Step의 쓰기 건수를 커스텀 ExitStatus로 바꾸고 그 값으로 후속 Step을 분기하는 Job이다.

```java
@Component
public class ProductStepListener implements StepExecutionListener {

    @Override
    public ExitStatus afterStep(StepExecution stepExecution) {
        if (stepExecution.getStatus().isUnsuccessful()) {
            return stepExecution.getExitStatus();
        }
        if (stepExecution.getWriteCount() == 0) {
            return new ExitStatus("NO_DATA");
        }
        return ExitStatus.COMPLETED;
    }
}

@Bean
public Job productJob(JobRepository jobRepository,
                      Step productStep, Step reportStep, Step notifyStep) {
    return new JobBuilder("productJob", jobRepository)
            .start(productStep)
                .on("NO_DATA").to(notifyStep)
                .on("FAILED").fail()
                .on("*").to(reportStep)
            .from(notifyStep).on("*").end()
            .from(reportStep).on("*").end()
            .end()
            .build();
}
```

날짜를 하루씩 넘기는 도메인 Incrementer다. `startNextInstance()`로 호출하면 직전 `targetDate`의 다음 날이 들어간다.

```java
public class TargetDateIncrementer implements JobParametersIncrementer {

    @Override
    public JobParameters getNext(JobParameters parameters) {
        String last = parameters == null ? null : parameters.getString("targetDate");
        LocalDate next = last == null ? LocalDate.now() : LocalDate.parse(last).plusDays(1);
        return new JobParametersBuilder(parameters == null ? new JobParameters() : parameters)
                .addString("targetDate", next.toString())
                .toJobParameters();
    }
}
```

## 실무에서 걸리는 지점

- **Incrementer가 있어도 파라미터를 직접 넘기면 적용되지 않는다.** `JobLauncher.run(job, params)`로 실행한다면 타임스탬프 같은 식별 파라미터를 직접 추가한다. 빠뜨리면 두 번째 호출부터 `JobInstanceAlreadyCompleteException`이 난다.
- **`end()` 누락은 컴파일 시점에 잡히지 않는다.** `on()`을 쓴 뒤 `end()` 없이 `build()`하면 런타임 예외로 컨텍스트 기동이 실패한다.
- **`afterJob()` 안의 외부 호출 실패는 Job 상태를 오염시킨다.** 알림 발송에서 예외가 나면 COMPLETED로 끝난 Job이 FAILED로 기록된다. 리스너 내부에서 예외를 잡아 별도 로그로 남긴다.
- **분기가 다섯 개를 넘으면 Job을 나눈다.** 재시작 시 어느 Step부터 이어지는지 추적하기 어려워진다. 독립 단계는 별도 Job으로 분리한다.
- **Boot 3.x에서 자동 실행을 끄지 않으면 기동마다 모든 Job이 돈다.** 외부에서 실행을 제어하려면 `spring.batch.job.enabled=false`를 둔다.

## 관련 글

- [첫 Job — Infrastructure 설정과 v5/v6 변경 사항](/notes/spring-batch/first-job-infrastructure/)
- [Job 실행 — JobLauncher·JobOperator·JobExplorer](/notes/spring-batch/running-jobs/)
- [Flow 제어 — Decision·Split·Late Binding](/notes/spring-batch/flow-control-late-binding/)
