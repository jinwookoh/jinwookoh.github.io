---
title: "Database Reader·Writer — Cursor vs Paging"
series: spring-batch
part: "Reader·Processor·Writer"
order: 15
summary: "DB 읽기는 Cursor와 Paging 중 무엇을 고르고, 쓰기는 왜 JdbcBatchItemWriter와 UPSERT가 기본인지 정리한다"
tags: [Spring Batch, JdbcCursorItemReader, JdbcPagingItemReader, JdbcBatchItemWriter, JpaItemWriter]
sources: [batch/2026-05-17-batch-database-reader-writer.md, 2026-05-03-spring-batch-writers.md]
updated: 2026-08-29
---

SQL 한 줄로 100만 row를 조회하면 드라이버에 따라 ResultSet 전체가 메모리에 올라와 OOM이 나고, 한 건씩 INSERT하면 chunk마다 수백 번의 round-trip이 생겨 처리량이 무너진다. Spring Batch는 읽기를 Cursor와 Paging 두 전략으로, 쓰기를 chunk 트랜잭션 안의 batch update로 해결한다.

## 핵심 개념

### Cursor — JdbcCursorItemReader

DB cursor를 한 번 열고 `read()`마다 `rs.next()`와 `RowMapper.mapRow()`를 실행해 row를 하나씩 흘려보낸다. connection 1개를 Step 끝까지 점유하고 메모리는 `fetchSize`만큼 쓴다. `fetchSize`는 100~1000이 무난하며 ==MySQL은 `Integer.MIN_VALUE`를 주어야 streaming이 된다==. thread-safe가 아니다.

### Paging — JdbcPagingItemReader

`pageSize` 단위로 독립된 query를 반복한다. 페이지마다 connection을 반납하므로 idle timeout에 안전하고 thread-safe이며, 재시작 위치는 읽은 item 수로 복원한다. DB별 LIMIT/OFFSET 문법은 `PagingQueryProvider`가 흡수하고 `SqlPagingQueryProviderFactoryBean`이 DataSource의 dialect를 감지해 구현체를 고른다. ==`sortKey`는 unique해야 하며, 아니면 페이지 경계에서 row가 중복되거나 빠진다.==

| 항목 | Cursor | Paging |
|:---|:---|:---|
| connection | 1개 long-running | 페이지마다 open/close |
| 장시간 실행 | idle timeout 위험 | 안전 |
| DB 부하 | 단일 query | deep OFFSET 시 급증 |
| thread-safety | 없음 | 있음 |

운영 기본값은 Paging이다. JPA에서는 `JpaPagingItemReader`가 페이지마다 persistence context를 clear해 1차 캐시 누적을 막고, `JpaCursorItemReader`는 자동 clear가 없어 직접 걸어야 한다.

### Writer — 트랜잭션이 곧 보장

DB writer는 chunk 트랜잭션 안에서 동작하므로 별도 장치가 필요 없다. `JdbcBatchItemWriter`는 chunk 전체를 한 번의 `executeBatch()`로 보낸다. 바인딩은 `?` 위치 기반과 `:name` 기반(`beanMapped()`) 두 가지인데, 위치 기반은 순서가 어긋나면 모든 컬럼이 틀어지므로 이름 기반이 안전하다. `JpaItemWriter`는 `merge()` 후 flush하며 batch INSERT는 `SEQUENCE` 전략과 `hibernate.jdbc.batch_size`가 갖춰져야 발생한다. 여러 대상에 쓰려면 `CompositeItemWriter`로 묶는다.

## 코드

Job parameter를 late binding으로 받는 표준 Paging reader. `SqlPagingQueryProviderFactoryBean`에 DataSource를 넘겨야 dialect가 감지된다.

```java
@Bean
@StepScope
public JdbcPagingItemReader<Customer> customerReader(
        DataSource ds,
        @Value("#{jobParameters['status']}") String status) throws Exception {

    SqlPagingQueryProviderFactoryBean qp = new SqlPagingQueryProviderFactoryBean();
    qp.setDataSource(ds);
    qp.setSelectClause("select id, name, email");
    qp.setFromClause("from customer");
    qp.setWhereClause("where status = :status");
    qp.setSortKey("id");

    return new JdbcPagingItemReaderBuilder<Customer>()
            .name("customerReader")
            .dataSource(ds)
            .queryProvider(qp.getObject())
            .parameterValues(Map.of("status", status))
            .pageSize(1000)
            .rowMapper(BeanPropertyRowMapper.newInstance(Customer.class))
            .build();
}
```

PostgreSQL UPSERT를 쓰는 `JdbcBatchItemWriter`와 chunk Step. 재실행해도 결과가 같도록 멱등하게 만든다.

```java
@Bean
public JdbcBatchItemWriter<Customer> customerWriter(DataSource ds) {
    return new JdbcBatchItemWriterBuilder<Customer>()
            .dataSource(ds)
            .sql("""
                INSERT INTO customer_target (id, name, email)
                VALUES (:id, :name, :email)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    email = EXCLUDED.email
                """)
            .beanMapped()
            .build();
}

@Bean
public Step etlStep(JobRepository repo, PlatformTransactionManager tx,
                    JdbcPagingItemReader<Customer> reader,
                    JdbcBatchItemWriter<Customer> writer) {
    return new StepBuilder("etlStep", repo)
            .<Customer, Customer>chunk(500, tx)
            .reader(reader)
            .writer(writer)
            .build();
}
```

OFFSET 대신 마지막 키 이후만 조회하는 keyset reader. deep pagination 성능 저하를 피한다.

```java
public class KeysetCustomerReader extends AbstractItemCountingItemStreamItemReader<Customer> {

    private final JdbcTemplate jdbc;
    private final Deque<Customer> buffer = new ArrayDeque<>();
    private long lastId = 0;

    public KeysetCustomerReader(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        setName("keysetCustomerReader");
    }

    @Override
    protected Customer doRead() {
        if (buffer.isEmpty()) {
            buffer.addAll(jdbc.query(
                    "SELECT id, name, email FROM customer WHERE id > ? ORDER BY id LIMIT 1000",
                    BeanPropertyRowMapper.newInstance(Customer.class), lastId));
            if (buffer.isEmpty()) {
                return null;
            }
        }
        Customer c = buffer.poll();
        lastId = c.getId();
        return c;
    }

    @Override
    protected void doOpen() { }

    @Override
    protected void doClose() { }
}
```

## 실무에서 걸리는 지점

- **connection idle timeout.** Cursor reader는 Step 내내 connection을 잡아 pool이나 DB의 idle timeout을 넘기면 끊긴다. Paging 전환이 정석이고 timeout 연장은 임시 조치다.
- **non-unique sortKey와 deep pagination.** `createdAt`으로 정렬하면 row가 중복·누락되므로 PK나 `Map<String, Order>` 다중 정렬을 쓴다. OFFSET이 수백만을 넘으면 후반 페이지가 급격히 느려지니 keyset 방식이나 partitioning으로 쪼갠다.
- **JPA N+1.** lazy 연관을 `JpaPagingItemReader`로 읽으면 row마다 query가 나간다. ==collection fetch join에 paging을 결합하면 Hibernate가 메모리 페이징으로 처리하므로, 대량이면 JDBC reader로 명시 join SQL을 쓴다.==
- **flush 시점과 skip.** ==custom writer가 flush를 미루면 어떤 item이 원인인지 알 수 없어 chunk 전체가 롤백되고 skip이 동작하지 않는다.== `write(Chunk)` 안에서 flush해야 하며 `JdbcBatchItemWriter`·`JpaItemWriter`는 내부에서 처리한다. `IDENTITY` 전략이면 INSERT batching이 불가능하므로 `SEQUENCE`로 바꾼다.
- **다중 thread와 다중 DataSource.** multi-threaded Step에서 Cursor reader는 `SynchronizedItemStreamReader`로 감싸거나 Paging으로 바꾼다. source와 target DB가 다르면 트랜잭션도 분리되므로 UPSERT 멱등성으로 재실행을 허용한다.

## 관련 글

- [ItemReader·ItemWriter 인터페이스와 구현체 카탈로그](/notes/spring-batch/reader-writer-interfaces/)
- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
