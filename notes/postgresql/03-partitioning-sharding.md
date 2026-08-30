---
title: "파티셔닝과 샤딩"
series: postgresql
part: "DB 원리"
order: 3
summary: "파티셔닝은 단일 DB 안에서 테이블을 쪼개고, 샤딩은 여러 서버로 데이터를 나눈다. 둘의 경계와 비용을 정리한다."
tags: [PostgreSQL, Partitioning, Sharding, Consistent Hashing, Partition Pruning]
sources: [2026-05-03-db-eng-partitioning.md, 2026-05-03-db-eng-sharding.md]
updated: 2026-08-29
---

수억 행이 넘는 테이블은 인덱스만으로 감당하기 어렵다. B-Tree 깊이가 늘어 캐시 적중률이 떨어지고, 오래된 데이터를 지우는 DELETE 한 번이 몇 시간짜리 작업이 되며, VACUUM과 백업 시간이 테이블 크기에 비례해 늘어난다. 테이블을 물리적으로 쪼개면 이 비용이 조각 단위로 줄어드는데, 이것이 파티셔닝이다. 그래도 단일 서버의 CPU·메모리·디스크·연결 수 한계에 닿으면 데이터를 여러 서버로 나눠야 하고, 이것이 샤딩이다. 두 기법은 이름이 비슷하지만 적용 범위와 책임 주체가 다르다.

## 핵심 개념

파티셔닝은 큰 테이블을 여러 파티션으로 분할하되 논리적으로는 한 테이블로 다루는 기법이다. 쿼리는 부모 테이블에 대해 작성하고, DBMS가 조건에 맞는 파티션만 읽는다. 행 단위로 나누는 수평 파티셔닝이 일반적인 의미의 파티셔닝이고, 컬럼 단위의 수직 파티셔닝은 정규화에 가깝다.

PostgreSQL의 선언적 파티셔닝은 세 가지 전략을 제공한다.

| 전략 | 분할 기준 | 적합한 데이터 | 제약 |
|:---|:---|:---|:---|
| Range | 값 범위 | 시간 기반(로그·주문·거래) | 최근 파티션에 쓰기 집중 |
| List | 명시적 값 목록 | 국가·상태 같은 카테고리 | 값 편중(skew) 가능 |
| Hash | 해시 나머지 | 균등 분산이 목적일 때 | 범위 쿼리 시 전 파티션 스캔 |

파티셔닝의 효과는 Partition Pruning에서 나온다. WHERE 절에 파티션 키 조건이 있으면 플래너가 무관한 파티션을 계획 단계 또는 실행 단계에서 제외한다. ==파티션 키가 조건에 없으면 모든 파티션을 스캔하므로 단일 테이블보다 느려질 수 있다.== 따라서 파티션 키는 WHERE에 자주 등장하고, 값이 변하지 않으며, 데이터가 고르게 퍼지는 컬럼이어야 한다.

샤딩은 데이터를 여러 DB 인스턴스(샤드)에 분산하는 기법이다. 각 샤드는 독립된 PostgreSQL 서버이고, 어느 샤드로 갈지는 애플리케이션 또는 Citus 같은 중간 계층이 결정한다. 파티셔닝과의 차이는 다음과 같다.

| 구분 | Partitioning | Sharding |
|:---|:---|:---|
| 범위 | 단일 DB 안 | 여러 DB 서버 |
| 라우팅 | DBMS가 자동 처리 | 애플리케이션·라우터 |
| JOIN | 파티션 간 자유롭게 가능 | Cross-Shard JOIN 어려움 |
| 트랜잭션 | 일반 ACID | 분산 트랜잭션(2PC) 필요 |
| 적합 | 단일 노드 한계 안 | 단일 노드 한계 초과 |

샤딩 전략은 파티셔닝과 유사하게 Range·Hash·Geographic/Directory 세 가지로 나뉜다. Range 샤딩은 범위 쿼리가 한 샤드에서 끝나지만 신규 데이터가 마지막 샤드에 몰리는 Hot Spot이 생긴다. Hash 샤딩은 분산이 고르지만 `hash(key) % N` 방식은 샤드 수가 바뀌면 거의 모든 키의 위치가 바뀌어 대규모 재배치가 필요하다. Directory 샤딩은 매핑 테이블로 유연성을 얻는 대신 그 테이블이 단일 장애점이 된다.

Consistent Hashing은 modulo 해시의 재배치 문제를 푼다. 해시 공간을 링으로 배치하고 각 샤드를 링 위의 점으로 둔 뒤, 키는 해시값에서 시계 방향으로 가장 가까운 샤드에 배정한다. 샤드를 추가하거나 제거하면 인접 구간의 키만 이동하므로 평균 1/N 데이터만 움직인다. 물리 샤드 하나에 가상 노드를 여러 개 배치하면 링 위 분포가 더 고르게 된다. Cassandra·DynamoDB·Redis Cluster가 이 방식을 쓴다.

## 코드

Range 파티션 테이블을 만들고, 분기별 파티션과 기본 파티션을 붙인 뒤 Pruning을 확인하는 SQL이다.

```sql
CREATE TABLE orders (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    customer_id BIGINT NOT NULL,
    order_date  DATE   NOT NULL,
    amount      NUMERIC(12, 2) NOT NULL,
    PRIMARY KEY (id, order_date)
) PARTITION BY RANGE (order_date);

CREATE TABLE orders_2026_q3 PARTITION OF orders
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE orders_2026_q4 PARTITION OF orders
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
CREATE TABLE orders_default PARTITION OF orders DEFAULT;

CREATE INDEX ON orders (customer_id, order_date);

EXPLAIN SELECT * FROM orders WHERE order_date = DATE '2026-08-15';
-- Seq Scan 또는 Index Scan on orders_2026_q3 만 나타난다

ALTER TABLE orders DETACH PARTITION orders_2026_q3 CONCURRENTLY;
DROP TABLE orders_2026_q3;
```

Spring Boot 3.x에서 파티션 테이블을 JPA로 다룰 때는 복합 기본 키를 엔티티에 반영해야 한다. 파티션 키를 포함한 `@IdClass`를 쓴 예다.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.math.BigDecimal;
import java.time.LocalDate;

@Entity
@Table(name = "orders")
@IdClass(Order.OrderId.class)
public class Order {

    @Id
    private Long id;

    @Id
    private LocalDate orderDate;

    private Long customerId;
    private BigDecimal amount;

    public record OrderId(Long id, LocalDate orderDate) implements Serializable {}
}
```

애플리케이션 레벨 샤딩은 Spring의 `AbstractRoutingDataSource`로 구현한다. 샤드 키를 `ThreadLocal`에 두고 Consistent Hashing 링에서 샤드를 고른다.

```java
import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.SortedMap;
import java.util.TreeMap;

public class ShardRoutingDataSource extends AbstractRoutingDataSource {

    private static final ThreadLocal<Long> SHARD_KEY = new ThreadLocal<>();
    private final TreeMap<Long, String> ring = new TreeMap<>();

    public ShardRoutingDataSource(java.util.List<String> shardNames, int virtualNodes) {
        for (String shard : shardNames) {
            for (int i = 0; i < virtualNodes; i++) {
                ring.put(hash(shard + "#" + i), shard);
            }
        }
    }

    public static void bind(long key) { SHARD_KEY.set(key); }
    public static void clear() { SHARD_KEY.remove(); }

    @Override
    protected Object determineCurrentLookupKey() {
        Long key = SHARD_KEY.get();
        if (key == null) throw new IllegalStateException("shard key not bound");
        SortedMap<Long, String> tail = ring.tailMap(hash(Long.toString(key)));
        return tail.isEmpty() ? ring.firstEntry().getValue() : tail.get(tail.firstKey());
    }

    private static long hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            return ((long) (d[0] & 0xff) << 24 | (d[1] & 0xff) << 16 | (d[2] & 0xff) << 8 | (d[3] & 0xff)) & 0xffffffffL;
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

`bind`는 트랜잭션 시작 전에 호출해야 한다. 커넥션이 이미 획득된 뒤에 키를 바꾸면 라우팅이 적용되지 않는다.

## 실무에서 걸리는 지점

- **글로벌 UNIQUE 제약이 없다.** ==파티션 테이블의 PRIMARY KEY·UNIQUE는 파티션 키를 반드시 포함해야 한다.== `id` 하나로 유일성을 보장하려면 애플리케이션 시퀀스나 별도 검증에 의존해야 하며, 파티션 테이블을 참조하는 외래 키도 PostgreSQL 12 이후에야 허용된다.
- **파티션 키 UPDATE는 행 이동이다.** ==PostgreSQL은 키 변경 시 다른 파티션으로 행을 옮겨 주지만 내부적으로 DELETE + INSERT이며, 동시 UPDATE와 충돌하면 직렬화 오류가 난다.== 파티션 키는 생성 후 바뀌지 않는 컬럼으로 잡는다.
- **파티션 수가 많으면 계획 시간이 늘어난다.** 수천 개 파티션은 플래너 메모리와 락 획득 비용을 키운다. 일 단위 파티션을 무기한 쌓지 말고 pg_partman 등으로 생성·보관 주기를 자동화하고, 오래된 파티션은 DETACH 후 DROP한다.
- **샤딩은 마지막 수단이다.** 인덱스 튜닝, Read Replica, 캐시, 파티셔닝, 수직 확장을 모두 시도한 뒤에 검토한다. ==잘못 고른 샤드 키는 되돌리기 어렵고 Resharding은 수일에서 수주가 걸린다.== 멀티 테넌트 SaaS는 `tenant_id`, 소셜 서비스는 `user_id`처럼 관련 데이터가 한 샤드에 모이는 키를 데이터 모델링 단계에서 정한다.
- **Cross-Shard JOIN과 분산 트랜잭션은 비용이 크다.** 두 샤드에 걸친 JOIN은 애플리케이션에서 결합하거나 비정규화로 회피하고, 원자성이 필요한 쓰기는 2PC 대신 Saga 패턴으로 설계한다. 샤딩은 쓰기 확장, 복제는 읽기 확장을 담당하므로 샤드마다 Primary + Replica를 함께 둔다.

## 관련 글

- [DDL 깊이 — CREATE TABLE·파티션·제약·외래 키](/notes/postgresql/ddl-tables-constraints/)
- [복제·CAP·분산 트랜잭션](/notes/postgresql/replication-cap-saga/)
- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
