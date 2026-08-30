---
title: "Spring Batch란 — 아키텍처와 도메인 언어"
series: spring-batch
part: "개념"
order: 1
summary: "대량 일괄 처리의 재시작·트랜잭션·통계를 프레임워크가 맡는 구조를 3계층과 Job·Step·Chunk 어휘로 읽는다."
tags: [Spring Batch, JobRepository, JobInstance, Chunk, Architecture]
sources: [batch/2026-05-17-batch-intro.md, batch/2026-05-17-batch-architecture.md, batch/2026-05-17-batch-domain-language.md, 2026-05-03-spring-batch-basics.md]
updated: 2026-08-29
---

야간 정산, 월말 청구서 발행, CSV 일괄 적재는 사용자 요청 없이 정해진 시점에 수백만 건을 읽고 변환해 저장한다. 반복문으로 직접 짜면 실패 지점부터의 재시작, 커밋 주기, 손상 레코드의 skip·retry, 처리 건수 기록이 전부 개별 코드로 쌓이고 배치마다 구현이 달라진다. Spring Batch는 이 공통 뼈대를 프레임워크가 맡고 개발자는 읽기·가공·쓰기 로직만 구현하도록 만든 경량 배치 프레임워크다. 별도 서버 없이 일반 Java 애플리케이션 안에서 동작한다.

## 핵심 개념

### 스케줄러가 아니다

"언제 실행할지"는 Quartz, Spring `@Scheduled`, cron, Kubernetes CronJob의 몫이고, Spring Batch는 "실행되었을 때 대량 데이터를 어떻게 안정적으로 처리할지"를 맡는다. 건별 즉시 처리, 사용자 요청 응답, 소량 데이터에는 맞지 않으며, 대량·주기적 실행·재시작 보장이 동시에 요구될 때 선택한다.

### 3계층 아키텍처

- **Application** — 개발자가 작성하는 Job·Step 정의, 커스텀 Processor, 비즈니스 규칙.
- **Core** — Job 실행과 라이프사이클 관리. `Job`, `Step`, `JobLauncher`, `JobOperator`, `JobRepository`.
- **Infrastructure** — 공통 재사용 도구. `ItemReader`·`ItemWriter` 구현체, `RepeatTemplate`, retry, 트랜잭션 관리.

Application과 Core 모두 Infrastructure 위에 놓인다. 개발자 코드와 프레임워크 코드가 같은 Reader·Writer 인터페이스를 쓰므로 데이터 소스가 바뀌어도 Reader 구현체만 교체하면 된다. I/O 최소화 원칙은 N건씩 묶어 커밋하는 Chunk 지향 처리로, 데이터 무결성 원칙은 실행 상태를 영속화하는 JobRepository로 구현된다.

### 도메인 언어

Job은 하나 이상의 Step으로 구성되고, 각 Step은 하나의 ItemReader, 선택적 ItemProcessor, 하나의 ItemWriter를 가진다.

- **Job** — 이름, Step 순서, 재시작 가능 여부를 정의하는 템플릿.
- **JobParameters** — identifying(기본값)은 JobInstance 식별에 쓰이고, non-identifying은 참조 값이다.
- **JobInstance** — Job + identifying JobParameters로 식별되는 논리적 실행 1회. 실패해 다음 날 재실행해도 같은 JobInstance다.
- **JobExecution** — JobInstance의 물리적 실행 시도. 재시도마다 새로 생긴다.
- **Step** — Reader·Processor·Writer로 흐르는 Chunk 지향 Step과 단일 작업용 Tasklet Step.
- **StepExecution** — Step 실행 1회. `readCount`, `writeCount`, `skipCount`를 추적한다.
- **ExecutionContext** — Job·Step 단위 key-value 상태 저장소. JobRepository에 자동 영속되어 재시작의 근거가 된다.
- **Chunk** — N건 묶음이자 커밋 단위. Reader와 Processor는 한 건씩, Writer만 묶음을 받는다. Processor가 `null`을 반환하면 필터링된다.

## 코드

`spring-boot-starter-batch`와 DB 드라이버만 추가하면 `JobRepository`, `JobLauncher`가 자동 구성된다. 메타데이터 영속화를 위해 DB는 필수다.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-batch</artifactId>
</dependency>
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
    <scope>runtime</scope>
</dependency>
```

Chunk 지향 Step과 Tasklet Step을 순서대로 실행하는 Job. Spring Batch 5부터 `JobBuilderFactory`·`StepBuilderFactory`는 제거되었고 `JobBuilder`·`StepBuilder`에 `JobRepository`와 `PlatformTransactionManager`를 직접 넘긴다.

```java
@Configuration
public class SettlementJobConfig {

    @Bean
    public Job settlementJob(JobRepository jobRepository, Step loadStep, Step archiveStep) {
        return new JobBuilder("settlementJob", jobRepository)
                .incrementer(new RunIdIncrementer())
                .start(loadStep)
                .next(archiveStep)
                .build();
    }

    @Bean
    public Step loadStep(JobRepository jobRepository, PlatformTransactionManager tx,
                         ItemReader<Order> orderReader,
                         ItemProcessor<Order, Settlement> settlementProcessor,
                         ItemWriter<Settlement> settlementWriter) {
        return new StepBuilder("loadStep", jobRepository)
                .<Order, Settlement>chunk(100, tx)
                .reader(orderReader)
                .processor(settlementProcessor)
                .writer(settlementWriter)
                .build();
    }

    @Bean
    public Step archiveStep(JobRepository jobRepository, PlatformTransactionManager tx) {
        return new StepBuilder("archiveStep", jobRepository)
                .tasklet((contribution, chunkContext) -> {
                    // 파일 압축·정리 같은 단일 작업
                    return RepeatStatus.FINISHED;
                }, tx)
                .build();
    }
}
```

JobParameters로 JobInstance를 식별해 실행하고 Step별 통계를 확인하는 코드.

```java
@Service
public class SettlementRunner {

    private final JobLauncher jobLauncher;
    private final Job settlementJob;

    public SettlementRunner(JobLauncher jobLauncher, Job settlementJob) {
        this.jobLauncher = jobLauncher;
        this.settlementJob = settlementJob;
    }

    public BatchStatus run(LocalDate targetDate) throws Exception {
        JobParameters params = new JobParametersBuilder()
                .addLocalDate("targetDate", targetDate, true)
                .addString("requestId", UUID.randomUUID().toString(), false)
                .toJobParameters();

        JobExecution execution = jobLauncher.run(settlementJob, params);
        for (StepExecution step : execution.getStepExecutions()) {
            System.out.printf("%s read=%d write=%d skip=%d%n",
                    step.getStepName(), step.getReadCount(),
                    step.getWriteCount(), step.getSkipCount());
        }
        return execution.getStatus();
    }
}
```

## 실무에서 걸리는 지점

- **같은 파라미터 재실행** — COMPLETED된 JobInstance를 같은 identifying 파라미터로 다시 실행하면 `JobInstanceAlreadyCompleteException`이 발생한다. 개발 중 반복 실행에만 `RunIdIncrementer`를 붙인다.
- **기동 시 자동 실행** — Spring Boot는 시작 시 등록된 Job을 자동 실행한다. 실행 시점을 직접 제어하려면 `spring.batch.job.enabled=false`로 끄고, Job이 여럿이면 `spring.batch.job.name`으로 대상을 지정한다.
- **메타데이터 스키마** — H2 인메모리는 재기동 시 이력이 사라진다. 운영에서는 `spring.batch.jdbc.initialize-schema=never`로 두고 마이그레이션 도구로 `BATCH_*` 테이블을 관리한다.
- **Chunk 크기** — 키우면 커밋 횟수는 줄지만 메모리 점유, 실패 시 롤백 범위, DB lock 유지 시간이 함께 커진다.
- **Tasklet의 `CONTINUABLE`** — 종료 조건 없이 `RepeatStatus.CONTINUABLE`을 반환하면 무한 반복된다. 기본은 `FINISHED`다.

## 관련 글

- [첫 Job — Infrastructure 설정과 v5/v6 변경 사항](/notes/spring-batch/first-job-infrastructure/)
- [JobRepository와 메타데이터 스키마](/notes/spring-batch/job-repository-schema/)
- [Step — Chunk 지향과 Tasklet·Commit Interval](/notes/spring-batch/step-chunk-tasklet/)
