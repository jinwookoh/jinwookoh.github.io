---
title: "캐싱 패턴 — Cache-Aside·스탬피드·Hot Key"
series: redis
part: "패턴"
order: 10
summary: "캐시 읽기·쓰기 패턴 4종을 비교하고, 동시 만료 폭주와 단일 키 쏠림을 락·조기 갱신·지터·키 분산으로 막는 방법을 정리한다."
tags: [Redis, Cache-Aside, Write-Through, Cache Stampede, Hot Key]
sources: [2026-05-02-redis-caching-patterns.md, data-infra/2026-05-26-cache-stampede-hotkey.md, data-infra/2026-05-17-redis-patterns-overview.md]
updated: 2026-08-29
---

같은 행을 초당 수천 번 읽는 서비스에서 매 요청이 DB까지 내려가면 커넥션 풀과 디스크 I/O가 먼저 바닥난다. 그래서 Redis를 앞에 두고 결과를 재사용하는데, 캐시를 어떻게 채우고 언제 비울지 정하지 않으면 두 가지 새로운 장애가 생긴다. 하나는 DB를 갱신했는데 캐시가 옛 값을 계속 내보내는 불일치이고, 다른 하나는 캐시가 있음에도 DB가 무너지는 스탬피드와 Hot Key다. 캐시는 항상 최신이 아닐 수 있다는 전제를 받아들이고, 그 위에서 일관성과 부하를 어디서 타협할지 결정해야 한다.

## 핵심 개념

캐시 계층의 동작은 읽기와 쓰기에서 누가 DB를 상대하는가로 나뉜다.

| 패턴 | 흐름 | 장점 | 단점 |
|---|---|---|---|
| Cache-Aside | 캐시 조회 → miss면 앱이 DB 조회 후 캐시 저장 | 필요한 데이터만 캐시, 캐시 장애 시 DB로 우회 | 첫 요청 지연, 만료 시 스탬피드 |
| Read-Through | 캐시 계층이 miss 시 로더를 호출해 채움 | 앱 코드 단순 | 동작은 Cache-Aside와 동일 |
| Write-Through | DB 갱신 후 캐시도 즉시 갱신 | 캐시가 항상 최신 | 쓰기 지연 증가, 안 읽는 데이터도 캐시 |
| Write-Behind | 캐시만 갱신하고 DB는 큐로 비동기 반영 | 쓰기 응답 최소 | 큐 유실 시 데이터 손실, 일시 불일치 |

Cache-Aside와 Read-Through는 결과가 같고 DB 호출 책임이 애플리케이션에 있는지 캐시 추상화에 있는지만 다르다. Write-Behind는 조회수·집계 카운터처럼 몇 건 잃어도 되는 데이터에만 쓰고 잔액·주문 상태에는 쓰지 않는다.

무효화는 TTL과 이벤트 기반 삭제를 함께 쓴다. TTL은 데이터 변경 빈도에 맞춰 잡는다. 재고처럼 자주 바뀌는 값은 수 초, 프로필은 30분~1시간, 설정값은 수 시간 단위가 일반적이다. DB를 갱신하는 코드 경로에서는 TTL에 기대지 않고 관련 키를 즉시 `DEL`한다. 세션처럼 활동 중에는 만료되면 안 되는 키는 접근할 때마다 `EXPIRE`를 다시 걸어 슬라이딩 만료로 처리한다. 히트율은 `INFO stats`의 `keyspace_hits`·`keyspace_misses`로 계산하며 80% 이상을 목표로 둔다.

캐시 스탬피드(Thundering Herd)는 시간의 문제다. 인기 키의 TTL이 끝나는 순간 그 키를 읽던 수천 요청이 동시에 miss를 보고 같은 쿼리를 DB에 던진다. 완화책은 세 가지이고 서로 배타적이지 않다.

- 뮤텍스 잠금: `SET lock NX EX`로 한 요청만 DB를 조회해 캐시를 채우고 나머지는 짧게 대기 후 캐시를 다시 읽는다.
- 확률적 조기 갱신: 남은 TTL이 짧아질수록 높은 확률로 일부 요청이 만료 전에 미리 갱신한다. 트래픽이 끊기지 않는 인기 키에 맞는다.
- TTL 지터: 300초 ± 30초처럼 만료 시각에 무작위를 섞어 여러 키가 동시에 만료되는 일을 흩는다. 비용이 가장 낮다.

Hot Key는 공간의 문제다. 클러스터로 샤딩해도 한 키는 한 노드에만 있으므로, 그 키에 트래픽이 쏠리면 해당 노드만 과부하가 된다. 애플리케이션 프로세스 메모리에 수 초짜리 로컬 캐시를 두어 Redis 앞에서 흡수하거나, 같은 값을 `key:0`·`key:1`·`key:2`처럼 여러 키로 복제해 서로 다른 슬롯에 두고 읽을 때 무작위로 고른다. 쓰기는 늘지만 읽기 쏠림은 확실히 분산된다.

## 코드

Cache-Aside를 뮤텍스 잠금과 TTL 지터로 보강한 조회 서비스. 락을 못 얻은 요청은 짧게 대기한 뒤 캐시를 다시 읽고, 끝까지 못 얻으면 DB로 우회한다.

```java
@Service
public class ProductCacheService {

    private static final Duration BASE_TTL = Duration.ofSeconds(300);
    private static final Duration LOCK_TTL = Duration.ofSeconds(10);

    private final StringRedisTemplate redis;
    private final ProductRepository repository;
    private final ObjectMapper mapper;

    public ProductCacheService(StringRedisTemplate redis,
                               ProductRepository repository,
                               ObjectMapper mapper) {
        this.redis = redis;
        this.repository = repository;
        this.mapper = mapper;
    }

    public Product get(long id) throws IOException, InterruptedException {
        String key = "product:" + id;
        String lockKey = "lock:" + key;

        for (int attempt = 0; attempt < 20; attempt++) {
            String cached = redis.opsForValue().get(key);
            if (cached != null) {
                return mapper.readValue(cached, Product.class);
            }
            Boolean locked = redis.opsForValue()
                    .setIfAbsent(lockKey, "1", LOCK_TTL);
            if (Boolean.TRUE.equals(locked)) {
                try {
                    Product product = repository.findById(id).orElseThrow();
                    redis.opsForValue().set(key,
                            mapper.writeValueAsString(product), jitteredTtl());
                    return product;
                } finally {
                    redis.delete(lockKey);
                }
            }
            Thread.sleep(50);
        }
        return repository.findById(id).orElseThrow();
    }

    private Duration jitteredTtl() {
        long jitter = ThreadLocalRandom.current().nextLong(-30, 31);
        return BASE_TTL.plusSeconds(jitter);
    }
}
```

확률적 조기 갱신. 남은 TTL이 기준 TTL의 10% 아래로 내려가면 그 구간에서 요청 하나가 잠금을 얻어 미리 갱신하고, 나머지는 아직 유효한 기존 값을 그대로 반환한다.

```java
public Product getWithEarlyRefresh(long id) throws IOException {
    String key = "product:" + id;
    String cached = redis.opsForValue().get(key);
    Long remaining = redis.getExpire(key, TimeUnit.SECONDS);

    boolean nearExpiry = remaining != null
            && remaining > 0
            && remaining < BASE_TTL.toSeconds() * 0.1
            && ThreadLocalRandom.current().nextDouble() < 0.2;

    if (cached != null && !nearExpiry) {
        return mapper.readValue(cached, Product.class);
    }
    Boolean locked = redis.opsForValue()
            .setIfAbsent("refresh:" + key, "1", Duration.ofSeconds(5));
    if (Boolean.TRUE.equals(locked)) {
        Product fresh = repository.findById(id).orElseThrow();
        redis.opsForValue().set(key,
                mapper.writeValueAsString(fresh), jitteredTtl());
        return fresh;
    }
    if (cached != null) {
        return mapper.readValue(cached, Product.class);
    }
    return repository.findById(id).orElseThrow();
}
```

Write-Through와 이벤트 기반 무효화. DB 트랜잭션이 커밋된 뒤에 캐시를 건드려야 롤백된 값이 캐시에 남지 않으므로 `TransactionSynchronization`을 쓴다.

```java
@Service
public class ProductWriteService {

    private final StringRedisTemplate redis;
    private final ProductRepository repository;

    public ProductWriteService(StringRedisTemplate redis,
                               ProductRepository repository) {
        this.redis = redis;
        this.repository = repository;
    }

    @Transactional
    public void update(Product product) {
        repository.save(product);
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        redis.delete(List.of(
                                "product:" + product.id(),
                                "product:list",
                                "category:" + product.categoryId()));
                    }
                });
    }
}
```

## 실무에서 걸리는 지점

- 잠금 대기 중인 요청이 재귀나 무한 루프로 쌓이면 락 소유자가 죽었을 때 전체가 멈춘다. 락에는 반드시 TTL을 두고, 대기 횟수 상한을 넘기면 DB로 우회하거나 실패를 반환한다.
- DB 갱신 후 캐시 무효화 누락이 가장 흔한 불일치 버그다. 갱신과 삭제 순서도 중요하며, 삭제를 커밋 전에 하면 다른 요청이 롤백 전 값을 다시 캐시에 채울 수 있다.
- 패턴으로 여러 키를 지울 때 `KEYS`는 단일 스레드를 블로킹하므로 `SCAN`으로 순회한다. 무효화 키 목록을 코드에서 명시적으로 관리하면 패턴 삭제 자체를 줄일 수 있다.
- 호출자 타임아웃이 피호출자보다 짧으면 포기된 요청이 자원을 계속 점유한 채 재시도가 새 부하를 얹는다. 바깥 타임아웃을 안쪽보다 넉넉히 두고, 스탬피드 대응에 재시도를 결합할 때 이 정렬을 함께 확인한다.
- `maxmemory-policy` 기본값 `noeviction`은 메모리가 차면 쓰기 오류를 낸다. 캐시 용도라면 `allkeys-lru`로 바꾸고, 임시 키에는 예외 없이 TTL을 건다.

## 관련 글

- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
- [분산 락 — SET NX와 Redlock](/notes/redis/distributed-lock-redlock/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
