---
title: "ItemProcessor·서비스 재사용·커스텀 구현"
series: spring-batch
part: "Reader·Processor·Writer"
order: 16
summary: "ItemProcessor의 null·예외 분기, 기존 서비스를 Adapter로 감싸는 조건, 커스텀 Reader·Writer의 재시작 안전성 확보 방법을 정리한다."
tags: [Spring Batch, ItemProcessor, ItemReaderAdapter, ItemStream, Process Indicator]
sources: [batch/2026-05-17-batch-item-processor.md, batch/2026-05-17-batch-reusing-services.md, batch/2026-05-17-batch-custom-reader-writer.md]
updated: 2026-08-29
---

Reader와 Writer만으로는 읽은 것을 그대로 쓰는 복사 작업밖에 못 한다. 변환·필터·검증을 Writer에 밀어 넣으면 테스트가 어렵고 롤백 후 재처리 때 같은 로직이 두 번 적용된다. 온라인 서비스의 DAO를 두고 배치용 Reader를 다시 작성하면 로직이 두 곳으로 갈라지고, 표준 구현체가 없는 소스를 직접 구현하면 재시작 시 처음부터 읽거나 ExecutionContext 키가 충돌한다.

## 핵심 개념

### ItemProcessor의 세 가지 반환

`ItemProcessor<I, O>`는 `O process(I item)` 하나짜리 함수형 인터페이스다. 입출력 타입이 달라도 되며 `chunk(N, tx)`의 `<I, O>`와 일치해야 한다.

| 반환 | 처리 | 통계 | 의미 |
|:---|:---|:---|:---|
| non-null | Writer로 전달 | writeCount | 정상 변환 |
| null | Writer로 보내지 않음 | filterCount | 대상 아님 |
| 예외 | skip 정책으로 위임 | skipCount | 잘못된 레코드 |

지원하지 않는 DELETE 레코드를 제외하는 것은 filter이고, 수량이 음수인 레코드는 skip이다. ==invalid 레코드를 `return null`로 처리하면 skipCount가 올라가지 않는다.== `CompositeItemProcessor`는 순차 체인이며 중간 단계의 null은 filter로 집계된다. `ValidatingItemProcessor`는 `Validator<T>`를, `BeanValidatingItemProcessor`는 Jakarta Bean Validation 어노테이션을 쓰고, `setFilter(true)`면 검증 실패를 예외 대신 null로 바꾼다.

==chunk가 롤백되면 캐시된 item이 다시 `process()`를 거친다.== 입력 객체를 직접 수정하면 변환이 중첩되므로 새 인스턴스를 반환하고, Processor 안의 DB 쓰기나 외부 호출은 UPSERT·idempotency key로 멱등하게 만든다.

### 기존 서비스 재사용

`ItemReaderAdapter`는 `targetObject`·`targetMethod`로 지정한 메서드를 `read()`마다 호출한다. ==대상 메서드는 소진 시 null을 반환해야 하며 빈 `Optional`은 종료로 인식되지 않는다.== `ItemWriterAdapter`는 item마다 개별 호출하고, `PropertyExtractingDelegatingItemWriter`는 item 프로퍼티를 추출해 다중 인자 메서드에 넘긴다. 기존 메서드가 배치 계약과 거의 같을 때만 Adapter를 쓴다.

### Process Indicator

재실행 위치를 입력 row의 flag 컬럼에 기록한다. Reader는 `WHERE processed_ind = FALSE`로 읽고 Writer는 같은 chunk 트랜잭션에서 `TRUE`로 갱신한다. 위치가 DB에 있으므로 `saveState(false)`로 ExecutionContext 저장을 끈다. 운영자가 SQL만으로 진행 상황을 확인하고 되돌릴 수 있다.

### 커스텀 Reader·Writer

위치를 보유하는 Reader는 `ItemStream`을 구현해 `open()`에서 복구하고 `update()`에서 저장한다. `ItemStreamSupport`를 상속하고 `setName()`을 주면 `getExecutionContextKey()`가 이름 접두어를 붙여 키 충돌을 막는다. 커스텀 Writer는 누적 count나 footer가 있을 때만 `ItemStream`을 구현한다.

## 코드

filter와 멱등 변환을 결합한 Processor, 그리고 검증·변환·보강 체인이다.

```java
@Configuration
public class ProcessorConfig {

    public record Order(Long id, BigDecimal amount, String status) {
        Order applyDiscount(BigDecimal rate) {
            return new Order(id, amount.multiply(BigDecimal.ONE.subtract(rate)), status);
        }
    }

    @Bean
    public ItemProcessor<Order, Order> activeDiscountProcessor() {
        return order -> {
            if (!"ACTIVE".equals(order.status())) {
                return null;                       // filter, skipCount 미증가
            }
            return order.applyDiscount(new BigDecimal("0.1"));   // 새 인스턴스, 멱등
        };
    }

    @Bean
    public BeanValidatingItemProcessor<Customer> customerValidator() throws Exception {
        BeanValidatingItemProcessor<Customer> processor = new BeanValidatingItemProcessor<>();
        processor.setFilter(false);                // 검증 실패 = 예외 = skip
        processor.afterPropertiesSet();
        return processor;
    }

    @Bean
    public CompositeItemProcessor<Customer, EnrichedCustomerDto> composite(
            BeanValidatingItemProcessor<Customer> validator,
            ItemProcessor<Customer, CustomerDto> mapper,
            ItemProcessor<CustomerDto, EnrichedCustomerDto> enricher) {
        CompositeItemProcessor<Customer, EnrichedCustomerDto> processor = new CompositeItemProcessor<>();
        processor.setDelegates(List.of(validator, mapper, enricher));
        return processor;
    }
}
```

기존 서비스를 Adapter로 감싸고, Process Indicator를 `saveState(false)`·`CompositeItemWriter`와 결합한 Step이다.

```java
@Configuration
public class ReuseConfig {

    @Bean
    public ItemReaderAdapter<Customer> customerReader(CustomerService service) {
        ItemReaderAdapter<Customer> reader = new ItemReaderAdapter<>();
        reader.setTargetObject(service);
        reader.setTargetMethod("findNextActive");   // 소진 시 null 반환 필수
        return reader;
    }

    @Bean
    public JdbcCursorItemReader<PlayerSummary> summaryReader(DataSource ds) {
        return new JdbcCursorItemReaderBuilder<PlayerSummary>()
            .name("summaryReader")
            .dataSource(ds)
            .saveState(false)                       // 위치는 processed_ind 컬럼이 보유
            .sql("""
                SELECT player_id, year_no, completes, attempts
                FROM player_summary
                WHERE processed_ind = FALSE
                ORDER BY player_id
                FOR UPDATE SKIP LOCKED
                """)
            .rowMapper(BeanPropertyRowMapper.newInstance(PlayerSummary.class))
            .build();
    }

    @Bean
    public JdbcBatchItemWriter<PlayerSummary> markProcessed(DataSource ds) {
        return new JdbcBatchItemWriterBuilder<PlayerSummary>()
            .dataSource(ds)
            .sql("UPDATE player_summary SET processed_ind = TRUE WHERE player_id = :playerId AND year_no = :yearNo")
            .beanMapped()
            .build();
    }

    @Bean
    public Step summaryStep(JobRepository repo, PlatformTransactionManager tx,
                            JdbcCursorItemReader<PlayerSummary> reader,
                            ItemWriter<PlayerSummary> aggregateWriter,
                            JdbcBatchItemWriter<PlayerSummary> markProcessed) {
        CompositeItemWriter<PlayerSummary> writer = new CompositeItemWriter<>();
        writer.setDelegates(List.of(aggregateWriter, markProcessed));   // 같은 chunk 트랜잭션
        return new StepBuilder("summaryStep", repo)
            .<PlayerSummary, PlayerSummary>chunk(500, tx)
            .reader(reader)
            .writer(writer)
            .build();
    }
}
```

외부 API를 페이지 단위로 읽는 stateful Reader와 count를 유지하는 stateful Writer다.

```java
public class ExternalApiReader extends ItemStreamSupport implements ItemReader<Customer> {

    private static final String PAGE_TOKEN_KEY = "pageToken";
    private final ApiClient client;
    private final Queue<Customer> buffer = new ArrayDeque<>();
    private String nextPageToken;
    private boolean exhausted;

    public ExternalApiReader(ApiClient client) {
        this.client = client;
        setName("externalApiReader");
    }

    @Override
    public Customer read() {
        if (buffer.isEmpty() && !exhausted) {
            PageResponse<Customer> page = client.fetchCustomers(nextPageToken);
            buffer.addAll(page.items());
            nextPageToken = page.nextPageToken();
            exhausted = nextPageToken == null;
        }
        return buffer.poll();                       // 비면 null = 종료
    }

    @Override
    public void open(ExecutionContext context) {
        super.open(context);
        String key = getExecutionContextKey(PAGE_TOKEN_KEY);
        if (context.containsKey(key)) {
            nextPageToken = context.getString(key);
        }
    }

    @Override
    public void update(ExecutionContext context) {
        super.update(context);
        if (nextPageToken != null) {
            context.putString(getExecutionContextKey(PAGE_TOKEN_KEY), nextPageToken);
        }
    }
}

public class CountingFooterWriter<T> extends ItemStreamSupport implements ItemWriter<T> {

    private static final String COUNT_KEY = "totalCount";
    private final ItemWriter<T> delegate;
    private long count;

    public CountingFooterWriter(ItemWriter<T> delegate) {
        this.delegate = delegate;
        setName("countingFooterWriter");
    }

    @Override
    public void write(Chunk<? extends T> items) throws Exception {
        if (items.isEmpty()) {
            return;
        }
        delegate.write(items);
        count += items.size();
    }

    @Override
    public void open(ExecutionContext context) {
        super.open(context);
        if (delegate instanceof ItemStream s) s.open(context);
        count = context.getLong(getExecutionContextKey(COUNT_KEY), 0L);
    }

    @Override
    public void update(ExecutionContext context) {
        super.update(context);
        if (delegate instanceof ItemStream s) s.update(context);
        context.putLong(getExecutionContextKey(COUNT_KEY), count);
    }

    @Override
    public void close() {
        if (delegate instanceof ItemStream s) s.close();
    }
}
```

## 실무에서 걸리는 지점

- **Processor 안의 건별 조회.** item마다 DB를 조회하면 N+1이다. Reader에서 join으로 읽거나 캐시로 줄이고, 무거운 외부 호출은 partitioning으로 분산한다.
- **ItemWriterAdapter의 대량 처리.** 건별 호출이라 chunk 크기만큼 DB 왕복이 생긴다. bulk 메서드를 커스텀 Writer로 감싸거나 `JdbcBatchItemWriter`를 쓴다.
- **Process Indicator의 동시 실행.** 두 스레드가 같은 row를 읽고 flag를 바꾸면 중복 처리된다. `FOR UPDATE SKIP LOCKED`나 partitioning으로 row 범위를 분리한다.
- **재시작 시 처음부터 읽는 커스텀 Reader.** `remove(0)`처럼 원본을 변경하는 읽기, `ItemStream` 미구현, Step에 `.stream()` 등록 누락, 같은 타입 Reader 두 개의 키 공유가 원인이다.
- **롤백되지 않는 리소스.** 이메일·외부 API에 쓰는 Writer는 chunk 실패 시 부분 반영이 남으므로 idempotency key가 필요하다. `TransactionAwareProxyFactory.createTransactionalList()`는 테스트용이며 운영 대체재가 아니다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Skip과 Retry](/notes/spring-batch/skip-retry/)
- [Database Reader·Writer — Cursor vs Paging](/notes/spring-batch/database-reader-writer/)
