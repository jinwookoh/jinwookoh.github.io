---
title: "Flow 제어 — Decision·Split·Late Binding"
series: spring-batch
part: "Step"
order: 8
summary: "ExitStatus·Decider·Split으로 Job 흐름을 분기·병렬화하고, 실행 시점 값을 @StepScope로 주입하는 방법"
tags: [Spring Batch, JobExecutionDecider, Split, StepScope, Late Binding]
sources: [batch/2026-05-17-batch-controlling-flow.md, batch/2026-05-17-batch-late-binding.md, 2026-05-03-spring-batch-job-flow.md]
updated: 2026-08-29
---

`.start(a).next(b)`만으로 Job을 구성하면 Step은 항상 같은 순서로 돌고, 하나라도 FAILED면 Job 전체가 실패한다. 결과에 따른 분기나 병렬 실행은 순차 연결로 표현할 수 없다. 입력값도 문제다. ==파일 경로는 실행 시 JobParameters로 들어오지만 ItemReader Bean은 컨텍스트 초기화 시점에 만들어지므로 그 값을 받을 수 없고, 시스템 프로퍼티로 우회하면 JobRepository에 파라미터가 남지 않아 재시작이 무너진다.==

## 핵심 개념

### ExitStatus가 분기 키다

조건 분기는 `.on(pattern).to(step)`으로 쓴다. ==`on()`이 비교하는 값은 enum인 `BatchStatus`가 아니라 문자열 `ExitStatus.exitCode`이며, `StepExecutionListener.afterStep()`의 반환값으로 바꿀 수 있다.== 패턴에는 `*`(0개 이상)와 `?`(1개 문자)를 쓰고, 구체적인 패턴부터 매칭되므로 선언 순서는 무관하다. 어느 전이에도 매칭되지 않는 ExitStatus가 나오면 Job이 FAILED로 끝나므로 `.on("*")`을 기본 경로로 둔다.

`to(step)` 자리에는 종료 방식을 넣을 수 있다.

| 종료 | BatchStatus | 재시작 | 용도 |
|:---|:---|:---|:---|
| `end()` | COMPLETED | 불가 | 재실행 시 `JobInstanceAlreadyCompleteException` |
| `fail()` | FAILED | 가능 | 재실행하면 실패 Step부터 재개 |
| `stopAndRestart(step)` | STOPPED | 가능 | 재시작 시 지정 Step부터 실행 |

### JobExecutionDecider

파일 존재 여부나 ExecutionContext 값처럼 ExitStatus 밖의 조건은 `JobExecutionDecider`로 분기한다. `decide()`가 반환하는 `FlowExecutionStatus` 문자열이 `on()` 매칭 키가 되며, `.next(decider)`처럼 Step 자리에 놓는다.

### Split과 Externalized Flow

`FlowBuilder<SimpleFlow>`로 분리한 `Flow` Bean은 여러 Job에서 재사용할 수 있고, `.split(taskExecutor).add(flow)`로 병렬 실행할 수 있다. 모든 Flow가 끝나야 다음 Step으로 넘어가고, 한 Flow가 FAILED면 Job도 FAILED다. 다른 Job을 새 JobExecution으로 띄우는 `JobStep`은 별도 Job으로 기록된다.

### Late Binding — @StepScope와 @JobScope

`@StepScope` Bean은 Step 시작마다 생성되고 종료 시 폐기된다. 생성이 늦춰지므로 그때 존재하는 JobParameters와 ExecutionContext를 SpEL로 주입할 수 있다. `@JobScope`는 Job 시작마다 한 번 생성된다. Step 자체의 동적 설정은 `@JobScope`, Step 내부 컴포넌트는 `@StepScope`를 쓴다.

SpEL 소스는 `jobParameters`, Step 간 전달용 `jobExecutionContext`, Partition 범위용 `stepExecutionContext` 세 가지다. 맵 키에는 따옴표가 필수고, 인자 타입에 맞춰 `LocalDate`·`Resource` 등으로 자동 변환되며 `?:`로 null 기본값을 줄 수 있다.

## 코드

skip 발생 시 커스텀 ExitStatus를 부여하고 그 값으로 분기한다.

```java
public class SkipCheckingListener implements StepExecutionListener {
    @Override
    public ExitStatus afterStep(StepExecution stepExecution) {
        String exitCode = stepExecution.getExitStatus().getExitCode();
        if (!exitCode.equals(ExitStatus.FAILED.getExitCode())
                && stepExecution.getSkipCount() > 0) {
            return new ExitStatus("COMPLETED WITH SKIPS");
        }
        return null; // null 반환 시 기존 ExitStatus 유지
    }
}

@Bean
public Job reportJob(JobRepository repo, Step mainStep,
                     Step skipReportStep, Step successReportStep) {
    return new JobBuilder("reportJob", repo)
        .start(mainStep).on("FAILED").fail()
        .from(mainStep).on("COMPLETED WITH SKIPS").to(skipReportStep)
        .from(mainStep).on("*").to(successReportStep)
        .end()
        .build();
}
```

Decider로 분기한 뒤 두 Flow를 병렬로 돌리고 통합 Step으로 합류한다.

```java
@Component
public class DataSourceDecider implements JobExecutionDecider {
    @Override
    public FlowExecutionStatus decide(JobExecution jobExecution,
                                      StepExecution stepExecution) {
        String source = jobExecution.getExecutionContext()
            .getString("dataSource", "UNKNOWN");
        return switch (source) {
            case "CSV" -> new FlowExecutionStatus("CSV_SOURCE");
            case "DB"  -> new FlowExecutionStatus("DB_SOURCE");
            default    -> new FlowExecutionStatus("UNKNOWN_SOURCE");
        };
    }
}

@Bean
public Flow orderFlow(Step orderStep) {
    return new FlowBuilder<SimpleFlow>("orderFlow").start(orderStep).build();
}

@Bean
public Flow inventoryFlow(Step inventoryStep) {
    return new FlowBuilder<SimpleFlow>("inventoryFlow").start(inventoryStep).build();
}

@Bean
public Job pipelineJob(JobRepository repo, Step initStep, DataSourceDecider decider,
                       Step csvStep, Step dbStep, Flow orderFlow, Flow inventoryFlow,
                       Step reportStep, TaskExecutor batchTaskExecutor) {
    return new JobBuilder("pipelineJob", repo)
        .start(initStep)
        .next(decider)
            .on("CSV_SOURCE").to(csvStep)
        .from(decider).on("DB_SOURCE").to(dbStep)
        .from(decider).on("UNKNOWN_SOURCE").fail()
        .from(csvStep).on("*").to(orderFlow)
        .from(dbStep).on("*").to(orderFlow)
        .from(orderFlow)
            .split(batchTaskExecutor).add(inventoryFlow)
        .next(reportStep)
        .end()
        .build();
}

@Bean
public TaskExecutor batchTaskExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(4);
    executor.setThreadNamePrefix("batch-split-");
    executor.initialize();
    return executor;
}
```

JobParameters의 파일 경로를 `@StepScope` Reader에 주입하고, 앞 Step이 남긴 건수로 `@JobScope` Step의 chunk 크기를 정한다.

```java
@Bean
@StepScope
public FlatFileItemReader<Customer> customerReader(
        @Value("#{jobParameters['input.file']}") Resource resource) {
    return new FlatFileItemReaderBuilder<Customer>()
        .name("customerReader")
        .resource(resource)
        .delimited()
        .names("id", "name", "email")
        .targetType(Customer.class)
        .build();
}

@Bean
public Step countStep(JobRepository repo, PlatformTransactionManager tx) {
    return new StepBuilder("countStep", repo)
        .tasklet((contribution, chunkContext) -> {
            long count = countLines();
            chunkContext.getStepContext().getStepExecution()
                .getJobExecution().getExecutionContext()
                .putLong("totalCount", count);
            return RepeatStatus.FINISHED;
        }, tx)
        .build();
}

@Bean
@JobScope
public Step processStep(JobRepository repo, PlatformTransactionManager tx,
        FlatFileItemReader<Customer> customerReader, ItemWriter<Customer> writer,
        @Value("#{jobExecutionContext['totalCount'] ?: 1000L}") long totalCount) {
    int chunkSize = (int) Math.max(100, Math.min(1000, totalCount / 10));
    return new StepBuilder("processStep", repo)
        .<Customer, Customer>chunk(chunkSize, tx)
        .reader(customerReader)
        .writer(writer)
        .build();
}
```

## 실무에서 걸리는 지점

- **`end()`로 닫은 Job은 되돌릴 수 없다.** 부분 실패를 `end()`로 마무리하면 같은 파라미터로 재실행할 수 없다. 재시도가 필요하면 `fail()`이나 `stopAndRestart()`를 쓴다.
- **Split은 TaskExecutor에 달려 있다.** `SyncTaskExecutor`를 넘기면 순차 실행이 된다. `ThreadPoolTaskExecutor`를 쓰고, 병렬 Flow 안에서는 thread-safe하지 않은 `JdbcCursorItemReader` 대신 `JdbcPagingItemReader`를 택한다.
- **`@StepScope` Bean의 반환 타입.** ==`ItemReader<T>`로 선언하면 CGLIB 프록시가 `ItemStream`을 구현하지 않아 `open`·`update`·`close`가 호출되지 않고 재시작 안전성이 사라진다.== 구체 타입이나 `ItemStreamReader<T>`로 선언한다.
- **JobParameters가 null이다.** 키 오타보다 `@StepScope` 누락이 흔하다. `DefaultJobParametersValidator`로 필수 키를 걸어 둔다.
- **`proxyBeanMethods = false`.** Flow 정의 안에서 `stepA()`를 두 번 호출하면 다른 Step 인스턴스가 만들어져 흐름이 엉킨다. Step은 `@Bean` 메서드 파라미터로 주입받는다. Partitioned Step에서는 `@JobScope` 대신 `@StepScope`를 쓴다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Step Listener](/notes/spring-batch/step-listeners/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
