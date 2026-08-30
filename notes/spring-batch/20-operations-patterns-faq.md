---
title: "운영 패턴과 FAQ"
series: spring-batch
part: "확장과 운영"
order: 20
summary: "Job 중단·Footer 집계·Driving Query·Step 간 데이터 전달 패턴과 재실행·Chunk 크기·스케줄링 FAQ를 정리한다"
tags: [Spring Batch, ExecutionContextPromotionListener, Driving Query, RunIdIncrementer, Chunk Size]
sources: [batch/2026-05-17-batch-common-patterns.md, batch/2026-05-17-batch-faq-and-wrapup.md]
updated: 2026-08-29
---

Reader·Writer·Skip·Retry를 개별로 이해해도 운영에서는 조합 문제가 남는다. 파일 끝 집계가 재시작 후 0부터 시작하고, 특정 데이터에서 Job을 멈춰야 하는데 Skip 설정이 예외를 삼키며, 0건을 읽고도 COMPLETED로 끝나 잘못된 파일명을 뒤늦게 발견한다. 같은 파라미터로 다시 돌리면 `JobInstanceAlreadyCompleteException`이 나고, 강제 종료 후에는 STARTED 상태가 남아 재시작이 막힌다.

## 핵심 개념

### Job을 로직 안에서 멈추는 세 가지 방법

| 방법 | BatchStatus | 재시작 | 용도 |
|:---|:---|:---|:---|
| 예외 throw | FAILED | 가능 | 진짜 오류, 즉시 중단 |
| Reader가 null 반환 | COMPLETED | 불가 | 자연스러운 종료 |
| `StepExecution.setTerminateOnly()` | STOPPED | 가능 | 운영자 검토 후 재개 |

예외 방식은 Skip·Retry 대상에서 제외된 예외 타입을 써야 한다. ==`setTerminateOnly()`는 플래그만 세우고 프레임워크가 다음 item 처리 직전에 확인해 `JobInterruptedException`을 던지므로, 현재 chunk는 끝까지 진행된다.==

### Footer 집계

Writer가 `FlatFileFooterCallback`을 함께 구현해 누적 합계를 파일 끝에 쓴다. 합산은 delegate의 `write()`가 성공한 뒤에 해야 rollback 시 어긋나지 않고, `ItemStream`으로 합계를 ExecutionContext에 저장해야 재시작 시 복구된다.

### Driving Query

큰 테이블을 cursor로 훑으면 잠금이 길어져 온라인 시스템에 영향을 준다. key만 select하고 ItemProcessor에서 상세를 조회하면 cursor 부담이 줄고 기존 DAO를 재사용한다. 대신 N+1 구조라 throughput이 떨어진다.

### Step 간 데이터 전달

==Step ExecutionContext는 chunk commit마다, Job ExecutionContext는 Step 종료 시 저장된다.== Step 안에서 Job ExecutionContext에 직접 put하면 Step 실패 시 유실되므로, Step ExecutionContext에 저장한 뒤 `ExecutionContextPromotionListener`가 Step 종료 시 지정 key를 Job ExecutionContext로 복사하게 한다. 다음 Step은 `@StepScope` + `#{jobExecutionContext['key']}`로 받는다.

### 운영 FAQ

- **같은 파라미터로 재실행 불가** — identifying parameter가 같은 COMPLETED JobInstance는 다시 실행할 수 없다. `RunIdIncrementer`를 Job에 등록하거나 실행 시각을 파라미터에 넣는다.
- **STARTED로 멈춘 실행** — JVM crash·OOM 이후 남은 상태다. `BATCH_JOB_EXECUTION`의 STATUS·EXIT_CODE를 ABANDONED로 갱신하고 VERSION을 올린 뒤 재시작한다.
- **Chunk 크기** — ==DB→DB 500~1,000, 외부 API 10~50, 큰 객체 50~200, 단순 변환 1,000 이상에서 시작해 throughput과 heap을 측정하며 조정한다.==
- **Skip vs Retry** — 같은 입력을 다시 처리해도 실패하면 Skip, 다시 하면 성공할 수 있으면 Retry다. 예외 타입을 나누어 둘 다 적용할 수 있다.
- **스케줄링** — Spring Batch는 scheduler가 아니다. `@Scheduled`·Quartz·cron이 trigger를 맡는다.

## 코드

Footer 집계 Writer. write 성공 후 합산하고, ItemStream으로 합계를 보존한다.

```java
public class TradeSummaryWriter implements ItemWriter<Trade>, FlatFileFooterCallback, ItemStream {

    private static final String KEY = "trade.total.amount";
    private final ItemWriter<Trade> delegate;
    private BigDecimal totalAmount = BigDecimal.ZERO;

    public TradeSummaryWriter(ItemWriter<Trade> delegate) {
        this.delegate = delegate;
    }

    @Override
    public void write(Chunk<? extends Trade> chunk) throws Exception {
        BigDecimal chunkTotal = chunk.getItems().stream()
            .map(Trade::amount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        delegate.write(chunk);
        totalAmount = totalAmount.add(chunkTotal);
    }

    @Override
    public void writeFooter(Writer writer) throws IOException {
        writer.write("Total Amount Processed: " + totalAmount);
    }

    @Override
    public void open(ExecutionContext context) {
        if (context.containsKey(KEY)) {
            totalAmount = new BigDecimal(context.getString(KEY));
        }
    }

    @Override
    public void update(ExecutionContext context) {
        context.putString(KEY, totalAmount.toPlainString());
    }
}
```

Step 간 데이터 전달. step1이 Step ExecutionContext에 저장한 값을 Promotion Listener가 올리고, 다음 Step이 Late Binding으로 받는다.

```java
@Bean
public ExecutionContextPromotionListener promotionListener() {
    ExecutionContextPromotionListener listener = new ExecutionContextPromotionListener();
    listener.setKeys(new String[] {"processedCount"});
    listener.setStatuses(new String[] {"COMPLETED"});
    return listener;
}

@Bean
public Step step1(JobRepository repo, PlatformTransactionManager tx,
                  ItemReader<Order> reader, ItemWriter<Order> writer,
                  ExecutionContextPromotionListener promotionListener) {
    return new StepBuilder("step1", repo)
        .<Order, Order>chunk(100, tx)
        .reader(reader)
        .writer(writer)
        .listener(new StepExecutionListener() {
            @Override
            public ExitStatus afterStep(StepExecution stepExecution) {
                stepExecution.getExecutionContext()
                    .putLong("processedCount", stepExecution.getWriteCount());
                return null;
            }
        })
        .listener(promotionListener)
        .build();
}

@Bean
@StepScope
public Tasklet reportTasklet(
        @Value("#{jobExecutionContext['processedCount']}") Long processedCount) {
    return (contribution, chunkContext) -> {
        System.out.println("step1 processed " + processedCount);
        return RepeatStatus.FINISHED;
    };
}
```

재실행과 0건 처리. `RunIdIncrementer`로 매 실행마다 새 JobInstance를 만들고, readCount가 0이면 FAILED로 끝낸다.

```java
@Bean
public Job dailyJob(JobRepository repo, Step step) {
    return new JobBuilder("dailyJob", repo)
        .incrementer(new RunIdIncrementer())
        .start(step)
        .build();
}

public class NoWorkFoundListener implements StepExecutionListener {
    @Override
    public ExitStatus afterStep(StepExecution stepExecution) {
        return stepExecution.getReadCount() == 0 ? ExitStatus.FAILED : null;
    }
}

@Scheduled(cron = "0 0 2 * * *")
public void launch() throws Exception {
    JobParameters params = new JobParametersBuilder(jobExplorer)
        .getNextJobParameters(dailyJob)
        .toJobParameters();
    jobLauncher.run(dailyJob, params);
}
```

## 실무에서 걸리는 지점

- **Listener 안의 DB 로깅이 rollback과 함께 사라진다.** `onReadError`·`onWriteError`에서 DB에 기록하면 chunk 트랜잭션 rollback 시 같이 지워진다. `REQUIRES_NEW`로 분리하거나 commit 직전 호출이 보장되는 `SkipListener`를 쓴다.
- **Multi-threaded Step에서 Reader가 thread-safe하지 않다.** `FlatFileItemReader`·`JdbcCursorItemReader`는 동기화되지 않는다. `SynchronizedItemStreamReader`로 감싸면 재시작 안전성을 잃으므로 `saveState(false)`를 두거나 Partitioning으로 전환한다.
- **Promotion Listener가 동작하지 않는다.** `setKeys` 누락, ExitStatus와 `setStatuses` 불일치, Step ExecutionContext에 key 부재가 대부분의 원인이다.
- **Driving Query의 N+1.** key별 단건 조회가 throughput을 깎는다. Writer에서 `WHERE id IN (...)`으로 묶어 조회하면 절충된다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Skip과 Retry](/notes/spring-batch/skip-retry/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
