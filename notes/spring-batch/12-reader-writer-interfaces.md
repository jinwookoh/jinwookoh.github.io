---
title: "ItemReader·ItemWriter 인터페이스와 구현체 카탈로그"
series: spring-batch
part: "Reader·Processor·Writer"
order: 12
summary: "read()의 null 종료·forward-only 계약과 write(Chunk)의 멱등성 책임을 기준으로 표준 구현체를 고르는 법"
tags: [Spring Batch, ItemReader, ItemWriter, Delegate Pattern, CompositeItemWriter]
sources: [batch/2026-05-17-batch-item-reader.md, batch/2026-05-17-batch-item-writer.md, batch/2026-05-17-batch-reader-writer-impls.md]
updated: 2026-08-29
---

입출력을 소스별로 따로 짜면 CSV 파서, JDBC 커서, Kafka 컨슈머가 각자 다른 종료 조건과 재시작 규칙을 갖게 되고, Step의 skip·retry 로직이 그 차이를 흡수하지 못한다. Spring Batch는 읽기와 쓰기를 메서드 하나짜리 인터페이스로 고정하고 그 위에 표준 구현체를 제공한다.

## 핵심 개념

### ItemReader의 read() 계약

`ItemReader<T>`는 `T read()` 하나만 가진다. 호출 한 번이 item 하나를 돌려주고 더 이상 없으면 `null`을 반환한다. `null`이 Step 종료 신호이므로 0건 조회에서도 예외를 던지지 않는다.

Reader는 forward-only다. JMS·Kafka 같은 transactional 소스는 rollback 시 같은 item을 다시 read하지만, 파일·DB cursor는 그렇지 않으므로 `ItemStream`으로 `ExecutionContext`에 위치를 저장하고 재시작 시 `open()`에서 복원한다.

### ItemWriter의 write(Chunk) 계약

`ItemWriter<T>`는 `void write(Chunk<? extends T> items)` 하나를 가진다. commit-interval만큼 모인 묶음을 한 트랜잭션 안에서 처리한다. 빈 chunk로도 호출되므로 `isEmpty()` 가드가 필요하다.

`write()`가 예외를 던지면 chunk가 rollback되고 retry가 같은 묶음으로 다시 호출한다. 외부 API 호출이나 파일 append는 되돌아가지 않으므로 Writer는 멱등해야 한다. UPSERT와 idempotency key를 쓴다.

### Delegate Pattern과 Step 등록

`.reader()`·`.writer()`에 직접 넘긴 객체는 `ItemStream`을 구현했을 때 자동 등록된다. wrapper 안의 delegate는 Step이 알지 못해 `open`·`update`·`close`가 호출되지 않으므로 `.stream(delegate)`로 명시 등록한다. delegate의 `ItemStream` 호출을 내부에서 전파하는 표준 wrapper는 예외다.

### 표준 구현체 카탈로그

| 범주 | Reader | Writer |
|:---|:---|:---|
| File | `FlatFileItemReader`, `StaxEventItemReader` | `FlatFileItemWriter`, `StaxEventItemWriter` |
| DB | `JdbcCursorItemReader`, `JdbcPagingItemReader` | `JdbcBatchItemWriter`, `JpaItemWriter` |
| Messaging | `KafkaItemReader`, `JmsItemReader` | `KafkaItemWriter`, `JmsItemWriter` |
| Decorator | `SynchronizedItemStreamReader` | `CompositeItemWriter`, `ClassifierCompositeItemWriter`, `MultiResourceItemWriter` |

cursor Reader는 connection 하나로 row를 스트리밍해 메모리 점유가 낮지만 timeout 위험이 있고, paging Reader는 page마다 connection을 반납해 장시간 실행에 안전하다. `JdbcBatchItemWriter`는 chunk 전체를 한 batch로 보내고, `JpaItemWriter`는 `merge()`를 건별로 호출한다. Decorator는 기존 구현체에 한 겹을 더해 thread-safety·파일 분할·라우팅을 맡는다.

## 코드

재시작 가능한 custom Reader. `setName()`이 `ExecutionContext` key의 prefix가 된다.

```java
public class ResumableListReader<T> extends ItemStreamSupport implements ItemReader<T> {

    private static final String INDEX_KEY = "index";
    private final List<T> items;
    private int index = 0;

    public ResumableListReader(List<T> items) {
        this.items = items;
        setName("listReader");
    }

    @Override
    public void open(ExecutionContext context) {
        super.open(context);
        String key = getExecutionContextKey(INDEX_KEY);
        if (context.containsKey(key)) {
            index = context.getInt(key);
        }
    }

    @Override
    public void update(ExecutionContext context) {
        super.update(context);
        context.putInt(getExecutionContextKey(INDEX_KEY), index);
    }

    @Override
    public T read() {
        return index < items.size() ? items.get(index++) : null;
    }
}
```

멱등 Writer. UPSERT가 retry 시 중복 INSERT를 막고, 외부 API Writer는 idempotency key를 쓴다.

```java
@Bean
public JdbcBatchItemWriter<Customer> customerWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<Customer>()
        .dataSource(dataSource)
        .sql("""
            INSERT INTO customers (id, name, email)
            VALUES (:id, :name, :email)
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
            """)
        .beanMapped()
        .build();
}

public class ExternalApiWriter implements ItemWriter<Notification> {

    private final ApiClient client;

    public ExternalApiWriter(ApiClient client) {
        this.client = client;
    }

    @Override
    public void write(Chunk<? extends Notification> items) {
        if (items.isEmpty()) {
            return;
        }
        for (Notification n : items) {
            client.send(n.id(), n);   // id 를 idempotency key 로 사용
        }
    }
}
```

Decorator 조합. DB 라우팅과 thread-safe 파일 Writer를 `CompositeItemWriter`로 묶는다.

```java
@Bean
public ClassifierCompositeItemWriter<Order> dbRouter(
        JdbcBatchItemWriter<Order> regularWriter,
        JdbcBatchItemWriter<Order> priorityWriter) {
    return new ClassifierCompositeItemWriterBuilder<Order>()
        .classifier(order -> order.priority() ? priorityWriter : regularWriter)
        .build();
}

@Bean
public SynchronizedItemStreamWriter<Order> auditWriter(FlatFileItemWriter<Order> fileWriter) {
    return new SynchronizedItemStreamWriterBuilder<Order>()
        .delegate(fileWriter)
        .build();
}

@Bean
public CompositeItemWriter<Order> orderWriter(
        ClassifierCompositeItemWriter<Order> dbRouter,
        SynchronizedItemStreamWriter<Order> auditWriter) {
    return new CompositeItemWriterBuilder<Order>()
        .delegates(List.of(dbRouter, auditWriter))
        .build();
}

@Bean
public Step orderStep(JobRepository jobRepository, PlatformTransactionManager txManager,
                      ItemReader<Order> orderReader, CompositeItemWriter<Order> orderWriter) {
    return new StepBuilder("orderStep", jobRepository)
        .<Order, Order>chunk(100, txManager)
        .reader(orderReader)
        .writer(orderWriter)
        .build();
}
```

## 실무에서 걸리는 지점

- **Reader의 thread-safety.** `FlatFileItemReader`·`JdbcCursorItemReader`는 multi-threaded Step에서 `SynchronizedItemStreamReader`로 감싸거나 partitioning으로 바꾼다.
- **Cursor connection timeout.** `JdbcCursorItemReader`는 Step 종료까지 connection을 붙들어 idle timeout에 걸린다.
- **CompositeItemWriter의 부분 실패.** ==파일 delegate가 실패하면 chunk는 rollback되지만 파일 기록은 남는다.== 파일 출력은 Step을 분리한다.
- **JpaItemWriter의 batch insert.** ==`hibernate.jdbc.batch_size` 설정과 `SEQUENCE` ID 전략일 때만 JDBC batch가 동작한다.==
- **Classifier의 default branch.** classifier가 `null`을 돌려주면 NPE가 나므로 default delegate를 둔다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Database Reader·Writer — Cursor vs Paging](/notes/spring-batch/database-reader-writer/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
