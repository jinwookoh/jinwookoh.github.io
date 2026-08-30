---
title: "Scaling — Multi-thread·Partitioning·Remote Chunking"
series: spring-batch
part: "확장과 운영"
order: 17
summary: "병목 위치에 따라 Multi-threaded Step·AsyncItemProcessor·Partitioning·Remote Chunking 중 무엇을 고를지 정리한다"
tags: [Spring Batch, Partitioning, Remote Chunking, Multi-threaded Step, AsyncItemProcessor]
sources: [batch/2026-05-17-batch-scaling-parallel.md, batch/2026-05-17-batch-async-externalization.md]
updated: 2026-08-29
---

단일 스레드·단일 JVM의 chunk 지향 Step은 수백 MB 파일을 분 단위로 처리한다. 문제는 외부 API 호출이 item당 100ms처럼 처리 시간이 배치 윈도우를 넘길 때다. 전략을 잘못 고르면 스레드 안전성 문제로 데이터가 깨지거나 처리량은 그대로가 된다. 병목이 read·process·write 중 어디인지, 단일 JVM으로 충분한지 측정한 뒤 고른다.

## 핵심 개념

확장 전략은 단일 프로세스(Multi-threaded Step, Parallel Steps, AsyncItemProcessor, Spring Batch 6의 Local Chunking)와 다중 프로세스(Remote Chunking, Remote Partitioning, Spring Batch 6의 RemoteStep)로 나뉜다. Partitioning은 PartitionHandler 구현에 따라 양쪽 모두 가능하다.

**Multi-threaded Step**은 `.taskExecutor()` 한 줄로 각 스레드가 chunk 하나를 read·process·write까지 수행하므로 Reader·Processor·Writer 모두 스레드 안전해야 한다. `FlatFileItemReader`·`JdbcCursorItemReader`는 `SynchronizedItemStreamReader`로 감싸야 하고, ==감싸더라도 읽기 위치가 스레드 순서를 보장하지 못해 실패 지점 재시작은 신뢰할 수 없다==.

**AsyncItemProcessor**는 process만 TaskExecutor로 넘겨 `Future`를 반환하고, 짝인 `AsyncItemWriter`가 chunk의 Future를 전부 resolve한 뒤 delegate에 넘긴다. Reader 안전성이 필요 없고, ==예외는 `Future.get()` 시점인 Writer 단계에서 드러나 skip·retry도 그때 적용된다==.

**Partitioning**은 `Partitioner`가 입력을 N등분한 `Map<String, ExecutionContext>`를 만들고, `PartitionHandler`가 각 컨텍스트로 worker Step 인스턴스를 실행한다. worker가 Reader·Writer·트랜잭션을 각자 가지므로 스레드 안전성 문제가 없고 실패한 partition만 재시작된다. 로컬은 `TaskExecutorPartitionHandler`, 원격은 `MessageChannelPartitionHandler`다.

**Remote Chunking**은 manager가 read만 하고 `ChunkMessageChannelItemWriter`가 chunk를 메시지로 보내며, worker의 `ChunkProcessorChunkHandler`가 process·write 후 응답한다. read보다 process가 확실히 비쌀 때만 유효하고, I/O가 병목이면 Remote Partitioning이 맞다.

선택 순서는 서로 다른 작업이면 Parallel Steps, process만 무겁고 단일 JVM이면 AsyncItemProcessor, 입력을 나눌 수 있으면 Partitioning, 다중 JVM이 필요하면 Remote Chunking이다. 운영에서 가장 흔한 것은 AsyncItemProcessor와 로컬 Partitioning이다.

## 코드

ID 범위 기반 Partitioner와 manager Step. Reader가 `stepExecutionContext`에서 자기 범위를 받는다.

```java
@Bean
public Partitioner rangePartitioner(JdbcTemplate jdbc) {
    return gridSize -> {
        long minId = jdbc.queryForObject("SELECT MIN(id) FROM customer", Long.class);
        long maxId = jdbc.queryForObject("SELECT MAX(id) FROM customer", Long.class);
        long range = (maxId - minId + 1) / gridSize;
        Map<String, ExecutionContext> result = new HashMap<>();
        for (int i = 0; i < gridSize; i++) {
            ExecutionContext ctx = new ExecutionContext();
            ctx.putLong("startId", minId + i * range);
            ctx.putLong("endId", i == gridSize - 1 ? maxId : minId + (i + 1) * range - 1);
            result.put("partition-" + i, ctx);
        }
        return result;
    };
}

@Bean
@StepScope
public JdbcCursorItemReader<Customer> workerReader(
        DataSource ds,
        @Value("#{stepExecutionContext['startId']}") Long startId,
        @Value("#{stepExecutionContext['endId']}") Long endId) {
    return new JdbcCursorItemReaderBuilder<Customer>()
        .name("workerReader")
        .dataSource(ds)
        .sql("SELECT id, name, email FROM customer WHERE id BETWEEN ? AND ?")
        .queryArguments(startId, endId)
        .rowMapper(BeanPropertyRowMapper.newInstance(Customer.class))
        .build();
}

@Bean
public Step workerStep(JobRepository repo, PlatformTransactionManager tx,
                       JdbcCursorItemReader<Customer> workerReader,
                       JdbcBatchItemWriter<Customer> writer) {
    return new StepBuilder("workerStep", repo)
        .<Customer, Customer>chunk(100, tx)
        .reader(workerReader)
        .writer(writer)
        .build();
}

@Bean
public Step managerStep(JobRepository repo, Partitioner rangePartitioner,
                        Step workerStep, TaskExecutor taskExecutor) {
    return new StepBuilder("managerStep", repo)
        .partitioner("workerStep", rangePartitioner)
        .step(workerStep)
        .gridSize(8)
        .taskExecutor(taskExecutor)
        .build();
}
```

AsyncItemProcessor·AsyncItemWriter 쌍. chunk 출력 타입이 `Future<EnrichedCustomer>`가 된다.

```java
@Bean
public TaskExecutor asyncTaskExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(20);
    executor.setMaxPoolSize(50);
    executor.setQueueCapacity(100);
    executor.setThreadNamePrefix("async-batch-");
    executor.initialize();
    return executor;
}

@Bean
public AsyncItemProcessor<Customer, EnrichedCustomer> asyncProcessor(
        ApiClient client, TaskExecutor asyncTaskExecutor) {
    AsyncItemProcessor<Customer, EnrichedCustomer> async = new AsyncItemProcessor<>();
    async.setDelegate(c -> new EnrichedCustomer(c, client.fetch(c.id())));
    async.setTaskExecutor(asyncTaskExecutor);
    return async;
}

@Bean
public AsyncItemWriter<EnrichedCustomer> asyncWriter(ItemWriter<EnrichedCustomer> delegate) {
    AsyncItemWriter<EnrichedCustomer> async = new AsyncItemWriter<>();
    async.setDelegate(delegate);
    return async;
}

@Bean
public Step asyncStep(JobRepository repo, PlatformTransactionManager tx,
                      ItemReader<Customer> reader,
                      AsyncItemProcessor<Customer, EnrichedCustomer> asyncProcessor,
                      AsyncItemWriter<EnrichedCustomer> asyncWriter) {
    return new StepBuilder("asyncStep", repo)
        .<Customer, Future<EnrichedCustomer>>chunk(100, tx)
        .reader(reader)
        .processor(asyncProcessor)
        .writer(asyncWriter)
        .build();
}
```

`@EnableBatchIntegration`으로 Remote Chunking의 manager와 worker를 구성한다. 채널은 durable 브로커에 연결된 것을 주입한다.

```java
@Configuration
@EnableBatchIntegration
public class RemoteChunkingConfig {

    @Configuration
    static class Manager {
        @Bean
        public TaskletStep managerStep(RemoteChunkingManagerStepBuilderFactory factory,
                                       ItemReader<Order> reader,
                                       DirectChannel requests, QueueChannel replies) {
            return factory.get("managerStep")
                .chunk(500)
                .reader(reader)
                .outputChannel(requests)
                .inputChannel(replies)
                .build();
        }
    }

    @Configuration
    static class Worker {
        @Bean
        public IntegrationFlow workerFlow(RemoteChunkingWorkerBuilder<Order, Order> builder,
                                          ItemProcessor<Order, Order> processor,
                                          ItemWriter<Order> writer,
                                          DirectChannel requests, DirectChannel replies) {
            return builder
                .itemProcessor(processor)
                .itemWriter(writer)
                .inputChannel(requests)
                .outputChannel(replies)
                .build();
        }
    }
}
```

## 실무에서 걸리는 지점

- **커넥션 풀이 스레드 수보다 작다.** 스레드 16개에 풀 8개면 절반이 커넥션 대기로 멈춘다.
- **Multi-threaded Step의 ChunkListener.** 다중 스레드에서 호환성이 보장되지 않으므로 `StepExecutionListener`로 옮기거나 Partitioning으로 전환한다.
- **Async 짝 누락.** `AsyncItemProcessor`에 일반 Writer를 붙이면 Future 캐스팅에 실패하고, 일반 Processor에 `AsyncItemWriter`를 붙이면 비동기 효과가 없다. process가 수 ms면 스레드 전환 비용이 이득을 상쇄한다.
- **Partition skew와 key 불일치.** 범위 분할이 데이터 분포와 맞지 않으면 한 partition이 대부분을 갖는다. hash 분할로 균등화한다. Partitioner의 key와 `#{stepExecutionContext['key']}`가 다르면 Reader가 null을 받는다.
- **원격 구성의 메시지 손실.** `DirectChannel`은 in-memory라 프로세스가 죽으면 chunk가 사라진다. durable queue와 ack, 멱등한 worker가 필요하다. worker 처리가 `MessagingTemplate.receiveTimeout`을 넘기면 manager가 먼저 끊는다. ==manager와 worker는 같은 JobRepository를 공유해야 한다.==

## 관련 글

- [Step — Chunk 지향과 Tasklet·Commit Interval](/notes/spring-batch/step-chunk-tasklet/)
- [Flow 제어 — Decision·Split·Late Binding](/notes/spring-batch/flow-control-late-binding/)
- [Spring Batch Integration — 메시지로 Job 실행](/notes/spring-batch/spring-batch-integration/)
