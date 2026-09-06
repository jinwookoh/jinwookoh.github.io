---
title: "샤딩 — 수평 분할과 샤드 키 선택"
series: architecture-patterns
part: "데이터"
order: 5
summary: "샤드 키는 조회 패턴과 값 분포로 고르고, 해시 샤딩은 가상 버킷을 두어 노드 추가 시 재배치 범위를 줄인다."
tags: [Sharding, Shard Key, Consistent Hashing, AbstractRoutingDataSource, Resharding]
sources: [https://jinwookoh.tistory.com/247]
updated: 2026-09-06
---

단일 DB 인스턴스는 디스크 용량, 쓰기 처리량, 커넥션 수에 상한이 있다. 읽기 부하는 복제본을 늘려 나눌 수 있지만 쓰기는 전부 프라이머리 한 대로 몰리고, 테이블 하나가 수십억 행에 이르면 인덱스가 메모리에 들어가지 않아 조회도 함께 느려진다. 샤딩은 같은 스키마의 테이블을 행 단위로 잘라 여러 DB 인스턴스(샤드)에 나누어 두는 수평 분할이다. 각 샤드가 독립적으로 쓰기를 처리하므로 처리량이 샤드 수에 비례해 늘어나지만, 어떤 행이 어느 샤드에 있는지를 결정하는 샤드 키를 잘못 고르면 부하가 한 샤드에 쏠리거나 모든 조회가 전 샤드를 훑게 된다.

## 핵심 개념

샤드 키는 행을 샤드에 배정하는 기준 컬럼이다. 좋은 샤드 키의 조건은 두 가지다. 값의 분포가 고르고 카디널리티가 높아야 하며, 자주 실행하는 조회의 WHERE 조건에 포함되어야 한다. 전자가 깨지면 핫스팟이 생기고, 후자가 깨지면 라우터가 대상 샤드를 특정하지 못해 모든 샤드에 질의를 보내야 한다. 사용자 중심 서비스가 user_id를 샤드 키로 두는 이유는 대부분의 조회가 한 사용자 범위 안에서 끝나기 때문이다.

레인지 샤딩은 키의 구간으로 나눈다. id 1~100만은 샤드 A, 100만~200만은 샤드 B에 두는 식이다. 구간 경계만 추가하면 샤드를 늘릴 수 있고 BETWEEN 조회가 특정 샤드로 좁혀진다. 대신 키가 단조 증가하면 새로 들어오는 쓰기가 항상 마지막 샤드에 집중된다. 시간 기반 키를 쓰는 로그성 데이터처럼 최신 구간만 활발한 경우 나머지 샤드는 용량만 차지한다.

해시 샤딩은 hash(key)를 샤드 수로 나눈 나머지로 위치를 정한다. 키의 순서와 무관하게 고르게 퍼지므로 쓰기 분산에 유리하지만, 범위 조회는 전 샤드를 대상으로 해야 한다. ==hash(key) % N으로 물리 노드에 직접 매핑하면 노드를 하나 추가할 때 대부분의 키가 다른 노드로 옮겨져야 하므로, 처음부터 물리 노드 수보다 훨씬 큰 고정 개수의 가상 버킷에 매핑하고 버킷을 노드에 배정하는 두 단계로 나눈다.== 노드를 추가할 때는 버킷 일부만 옮기면 되고, 일관성 해싱은 같은 목표를 해시 링 위의 가상 노드로 푼다.

디렉터리 샤딩은 키와 샤드의 매핑을 별도 테이블에 저장한다. 어떤 키든 원하는 샤드로 보낼 수 있고 이동도 매핑 수정으로 끝나지만, 모든 요청이 매핑 조회를 거치므로 그 테이블이 단일 장애점이자 병목이 된다. 보통 매핑을 캐시에 올려 두고 쓴다.

| 구분 | 레인지 샤딩 | 해시 샤딩 |
|---|---|---|
| 분할 기준 | 키 구간, 날짜, 지역 | hash(key)를 버킷 수로 나눈 나머지 |
| 데이터 분포 | 최신 구간에 쏠리기 쉬움 | 균등 |
| 유리한 조회 | 범위 조회 | 단건·동등 조회 |
| 샤드 추가 | 구간 경계 추가 | 버킷 재배정 필요 |
| 적합한 데이터 | 시계열 로그, 지역별 데이터 | 사용자 데이터, 세션, 피드 |

샤드를 나누는 순간 잃는 것이 있다. 샤드 간 JOIN이 불가능하므로 함께 조회하는 데이터는 같은 샤드에 두거나 애플리케이션에서 합쳐야 한다. 여러 샤드에 걸친 쓰기는 하나의 트랜잭션으로 묶이지 않는다. 샤드별 auto increment는 서로 겹치므로 전역 유일 ID 생성기가 따로 필요하다. MongoDB, Cassandra 같은 분산 저장소는 라우팅과 재분배를 내장하지만, 관계형 DB를 샤딩하면 애플리케이션이나 프록시 계층에서 직접 구현한다.

## 코드

가상 버킷 기반 해시 라우터다. 버킷 수는 고정하고 버킷과 물리 샤드의 매핑만 바꾸므로, 샤드를 추가할 때 이동하는 데이터가 일부 버킷으로 한정된다.

```java
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public final class ShardRouter {
    private static final int BUCKETS = 1024;
    private final Map<Integer, String> bucketToShard;

    public ShardRouter(List<String> shardNames) {
        this.bucketToShard = IntStream.range(0, BUCKETS).boxed()
                .collect(Collectors.toUnmodifiableMap(
                        b -> b,
                        b -> shardNames.get(b % shardNames.size())));
    }

    public String shardFor(long userId) {
        int bucket = Math.floorMod(Long.hashCode(userId), BUCKETS);
        return bucketToShard.get(bucket);
    }
}
```

Spring의 AbstractRoutingDataSource로 요청마다 대상 샤드의 DataSource를 고른다. 라우팅 키는 ThreadLocal에 담아 두고, 커넥션을 얻는 시점에 determineCurrentLookupKey()가 읽는다.

```java
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource;

public final class ShardContext {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private ShardContext() {}

    public static void set(String shard) { CURRENT.set(shard); }
    public static String current() { return CURRENT.get(); }
    public static void clear() { CURRENT.remove(); }
}

class ShardRoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return ShardContext.current();
    }
}

@Configuration
class ShardDataSourceConfig {
    @Bean
    @Primary
    DataSource dataSource(@Qualifier("shard0") DataSource shard0,
                          @Qualifier("shard1") DataSource shard1) {
        var routing = new ShardRoutingDataSource();
        routing.setTargetDataSources(Map.of("shard-0", shard0, "shard-1", shard1));
        routing.setDefaultTargetDataSource(shard0);
        return routing;
    }
}
```

서비스에서는 트랜잭션에 들어가기 전에 라우팅 키를 정하고, 끝나면 반드시 지운다. 스레드 풀에서 스레드가 재사용되므로 clear()를 빠뜨리면 다음 요청이 이전 샤드로 간다.

```java
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OrderQueryService {
    private final ShardRouter router;
    private final OrderRepository repository;
    private final TransactionTemplate tx;

    public OrderQueryService(ShardRouter router, OrderRepository repository,
                             TransactionTemplate tx) {
        this.router = router;
        this.repository = repository;
        this.tx = tx;
    }

    public List<Order> ordersOf(long userId) {
        ShardContext.set(router.shardFor(userId));
        try {
            return tx.execute(status -> repository.findByUserId(userId));
        } finally {
            ShardContext.clear();
        }
    }
}
```

## 실무에서 걸리는 지점

- 샤드 키 변경은 전체 데이터 재배치와 같다. ==샤드 키는 데이터가 쌓인 뒤에는 사실상 바꿀 수 없는 결정이므로, 현재 조회 패턴뿐 아니라 앞으로 추가될 조회가 그 키를 조건에 포함할 수 있는지까지 보고 정한다.==
- 샤드 키가 조건에 없는 조회는 모든 샤드에 질의를 보내 결과를 합치는 scatter-gather가 된다. 정렬과 페이지네이션은 각 샤드의 결과를 다시 합쳐 정렬해야 하므로 오프셋 방식은 샤드 수만큼 비용이 배가된다. 이런 조회가 많으면 검색 인덱스나 조회 전용 모델을 따로 둔다.
- ==샤드마다 auto increment를 그대로 쓰면 다른 샤드의 행과 같은 ID가 생겨, 나중에 샤드를 합치거나 ID만으로 행을 찾는 API에서 충돌한다.== Snowflake 방식이나 UUID v7처럼 시간순 정렬이 가능한 전역 ID를 쓴다.
- ==AbstractRoutingDataSource의 determineCurrentLookupKey()는 커넥션을 얻는 시점, 즉 트랜잭션 시작 시 한 번 호출되므로 @Transactional 메서드 안에서 ShardContext를 바꿔도 이미 잡은 커넥션은 바뀌지 않는다.== 라우팅 키는 트랜잭션 경계 바깥에서 정하고, 여러 샤드를 순회해야 하면 샤드마다 트랜잭션을 따로 연다.
- 해시 샤딩이라도 대형 계정이나 인기 게시물처럼 키 하나에 트래픽이 몰리면 분산되지 않는다. 샤드별 QPS와 용량을 상시 관측하고, 특정 키가 커지면 하위 키를 붙인 복합 키로 다시 나눈다.

## 관련 글

- [캐싱 — Look-aside·Write-through·Write-behind](/notes/architecture-patterns/caching/)
- [페이지네이션 — 오프셋과 커서](/notes/architecture-patterns/pagination/)
- [멀티테넌시 — 테넌트별 데이터 격리 전략](/notes/architecture-patterns/multi-tenancy/)
