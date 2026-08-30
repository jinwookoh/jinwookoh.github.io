---
title: "Step 재시작과 ItemStream"
series: spring-batch
part: "Step"
order: 7
summary: "재시작이 실패 지점부터 이어지려면 Step 재시작 설정과 ItemStream 등록이 함께 맞아야 한다"
tags: [Spring Batch, ItemStream, ExecutionContext, allowStartIfComplete, startLimit]
sources: [batch/2026-05-17-batch-step-restart.md, batch/2026-05-17-batch-item-stream-registering.md, batch/2026-05-17-batch-item-stream.md]
updated: 2026-08-29
---

천만 건을 적재하는 Step이 600만 건에서 실패했을 때 재시작이 처음부터 다시 돈다면 처리 시간 전체를 잃고 적재한 600만 건은 중복으로 남는다. Spring Batch는 Step별 진행 상태를 JobRepository에 기록해 실패 지점부터 재개하지만, 이 동작은 두 조건이 맞아야 성립한다. ==어떤 Step을 건너뛸지 정하는 Step 설정, 그리고 Reader·Writer가 위치를 ExecutionContext에 남기는 ItemStream 구현이다.==

## 핵심 개념

### 재시작 시 Step의 동작

같은 JobInstance에서 이전 JobExecution이 FAILED로 끝난 뒤 재시작하면 새 JobExecution이 만들어진다. 이미 COMPLETED인 Step은 건너뛰고, FAILED Step은 직전 StepExecution이 남긴 ExecutionContext를 받아 그 위치부터 재개한다.

`allowStartIfComplete(true)`는 COMPLETED 상태를 무시하고 매 재시작마다 다시 실행한다. 사전 검증, 외부 lock 해제에 쓴다. `startLimit(N)`은 총 시작 횟수를 N으로 제한하고 초과하면 `StartLimitExceededException`을 던진다. 재시작 횟수가 아니라 시작 횟수를 세므로 `startLimit(1)`은 첫 실행만 허용한다. DDL 실행, 결제 요청에 적용한다. Job 수준의 `preventRestart()`는 재시작 자체를 거부한다.

### ItemStream — 위치를 남기는 계약

| 메서드 | 호출 시점 | 책임 |
|:---|:---|:---|
| `open(ExecutionContext)` | Step 시작 시 1회 | 이전 위치 복구, 자원 열기 |
| `update(ExecutionContext)` | 매 chunk commit 직전 | 현재 위치 기록 |
| `close()` | Step 종료 시 1회 | 자원 정리 |

==`update()`가 commit 직전에 같은 트랜잭션 안에서 호출된다는 점이 핵심이다.== chunk의 write 결과와 ExecutionContext가 원자적으로 commit되므로 commit 직후 프로세스가 죽어도 데이터와 위치가 어긋나지 않고, rollback되면 위치 변경도 함께 되돌아간다. 재시작에서는 직전 실행의 ExecutionContext가 `open()`에 전달되므로 `containsKey` 분기 하나로 첫 실행과 재시작을 같은 코드로 처리한다.

값은 `putLong`·`putString` 같은 기본 타입으로 제한한다. 임의 객체는 직렬화에 실패할 수 있고, 내용이 커지면 BLOB 컬럼 부담과 chunk마다 반복되는 쓰기 증폭으로 돌아온다.

### Step에 ItemStream 등록하기

Step은 등록된 ItemStream에 대해서만 세 메서드를 호출한다. ItemStream을 구현한 객체가 `StepBuilder`의 `reader()`·`processor()`·`writer()` 인자로 직접 전달되면 자동 등록되며, 표준 구현체 대부분이 여기 해당한다. 그 외에는 `StepBuilder.stream(itemStream)`으로 수동 등록한다.

자동 등록은 `reader()`에 넘긴 객체 자체만 검사한다. ItemStream을 구현하지 않은 wrapper 안에 `FlatFileItemReader`가 있어도 delegate의 `open`·`update`는 호출되지 않는다. delegate를 `stream()`으로 따로 등록하거나, wrapper가 ItemStream을 구현해 delegate에 위임한다. Tasklet 안에서 ItemReader를 직접 쓰는 경우도 수동 등록이 필요하다. `ItemStreamSupport`를 상속하면 `setName()`의 이름이 ExecutionContext 키의 접두어가 되어 같은 클래스의 인스턴스가 여럿이어도 키가 충돌하지 않는다.

## 코드

재시작 정책을 Step별로 다르게 준 Job이다. 검증 Step은 매 재시작마다 실행되고, DDL Step은 한 번만 허용되며, 적재 Step은 실패 지점부터 재개된다.

```java
@Configuration
public class SettlementJobConfig {

    @Bean
    public Step validationStep(JobRepository repo, PlatformTransactionManager tx,
                               Tasklet validationTasklet) {
        return new StepBuilder("validationStep", repo)
            .tasklet(validationTasklet, tx)
            .allowStartIfComplete(true)
            .build();
    }

    @Bean
    public Step ddlStep(JobRepository repo, PlatformTransactionManager tx,
                        Tasklet ddlTasklet) {
        return new StepBuilder("ddlStep", repo)
            .tasklet(ddlTasklet, tx)
            .startLimit(1)
            .build();
    }

    @Bean
    public Step loadStep(JobRepository repo, PlatformTransactionManager tx,
                         FlatFileItemReader<Settlement> reader,
                         JdbcBatchItemWriter<Settlement> writer) {
        return new StepBuilder("loadStep", repo)
            .<Settlement, Settlement>chunk(500, tx)
            .reader(reader)
            .writer(writer)
            .build();
    }

    @Bean
    public Job settlementJob(JobRepository repo, Step validationStep,
                             Step ddlStep, Step loadStep) {
        return new JobBuilder("settlementJob", repo)
            .start(validationStep)
            .next(ddlStep)
            .next(loadStep)
            .build();
    }
}
```

delegate를 감싸면서 자체 상태도 추적하는 Reader다. 세 메서드를 delegate에 위임하므로 `reader()`에 넘기면 자동 등록된다.

```java
public class CountingReader<T> extends ItemStreamSupport implements ItemReader<T> {

    private static final String COUNT_KEY = "count";

    private final ItemReader<T> delegate;
    private long count;

    public CountingReader(ItemReader<T> delegate, String name) {
        this.delegate = delegate;
        setName(name);
    }

    @Override
    public T read() throws Exception {
        T item = delegate.read();
        if (item != null) {
            count++;
        }
        return item;
    }

    @Override
    public void open(ExecutionContext context) throws ItemStreamException {
        super.open(context);
        if (delegate instanceof ItemStream stream) {
            stream.open(context);
        }
        count = context.getLong(getExecutionContextKey(COUNT_KEY), 0L);
    }

    @Override
    public void update(ExecutionContext context) throws ItemStreamException {
        super.update(context);
        if (delegate instanceof ItemStream stream) {
            stream.update(context);
        }
        context.putLong(getExecutionContextKey(COUNT_KEY), count);
    }

    @Override
    public void close() throws ItemStreamException {
        if (delegate instanceof ItemStream stream) {
            stream.close();
        }
        super.close();
    }
}
```

Tasklet 안에서 ItemReader를 직접 사용하는 경우다. `stream()`으로 등록하지 않으면 `open`·`update`가 호출되지 않는다.

```java
@Bean
public Step reportStep(JobRepository repo, PlatformTransactionManager tx,
                       FlatFileItemReader<Row> rowReader) {
    Tasklet tasklet = (contribution, chunkContext) -> {
        Row row;
        while ((row = rowReader.read()) != null) {
            contribution.incrementReadCount();
        }
        return RepeatStatus.FINISHED;
    };
    return new StepBuilder("reportStep", repo)
        .tasklet(tasklet, tx)
        .stream(rowReader)
        .build();
}
```

## 실무에서 걸리는 지점

- ==재시작이 처음부터 다시 처리된다면 원인은 거의 등록 누락이다.== wrapper가 ItemStream을 구현하지 않았거나, Tasklet 안 Reader를 `stream()`에 넣지 않은 경우다.
- `allowStartIfComplete(true)`는 재시작마다 Step 전체를 다시 돌린다. 짧은 Tasklet에만 붙인다.
- `startLimit(1)` Step이 실패하면 코드 수정 후에도 같은 JobInstance로는 재시작할 수 없다. 새 JobInstance로 실행하는 운영 절차가 필요하다.
- multi-threaded Step에서는 `read()`와 `update()`가 동시에 호출되므로 상태 변경이 thread-safe하거나 partitioning으로 스레드마다 독립 인스턴스를 준다.
- `open()`에서 이전 위치까지 파일을 처음부터 읽어 skip하면 재시작 자체가 느려진다. `close()`는 정상 종료에서만 보장되므로 파일 핸들·커넥션은 `java.lang.ref.Cleaner` 같은 안전망을 둔다.

## 관련 글

- [Step — Chunk 지향과 Tasklet·Commit Interval](/notes/spring-batch/step-chunk-tasklet/)
- [JobRepository와 메타데이터 스키마](/notes/spring-batch/job-repository-schema/)
- [ItemReader·ItemWriter 인터페이스와 구현체 카탈로그](/notes/spring-batch/reader-writer-interfaces/)
