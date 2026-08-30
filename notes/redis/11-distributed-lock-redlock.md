---
title: "분산 락 — SET NX와 Redlock"
series: redis
part: "패턴"
order: 11
summary: "단일 인스턴스 SET NX 락이 보장하는 것과 못 하는 것, Redlock의 quorum 모델과 fencing token이 필요한 경계를 정리한다."
tags: [Redis, Distributed Lock, Redlock, Redisson, Fencing Token]
sources: [data-infra/2026-05-17-redis-distributed-lock.md]
updated: 2026-08-29
---

애플리케이션 서버가 여러 대로 늘어나면 JVM 안의 `synchronized`나 `ReentrantLock`은 아무것도 막지 못한다. 결제 버튼이 두 번 눌리면 같은 주문에 결제가 두 번 호출되고, 재고 차감 요청이 동시에 들어오면 재고가 음수로 내려가며, 스케줄러가 클러스터링되어 있지 않으면 같은 배치가 인스턴스 수만큼 실행된다. 유니크 제약이나 `SELECT FOR UPDATE`로 DB 레벨에서 막을 수 있는 자리라면 그쪽이 먼저다. 그러나 외부 API 호출이 포함된 작업, DB 커넥션을 오래 잡을 수 없는 짧고 빈번한 임계 구역, 캐시 워밍처럼 DB가 개입하지 않는 작업에는 프로세스 밖의 공유 잠금이 필요하다. Redis가 그 자리를 자주 맡는다.

## 핵심 개념

### 단일 인스턴스 락 — SET NX EX

가장 단순한 형태는 `SET key value NX EX seconds` 한 줄이다. NX로 키가 없을 때만 쓰고, EX로 만료를 걸어 락 소유자가 죽어도 자동으로 풀린다. value에는 소유자 식별용 랜덤 토큰을 넣고, 해제는 "값이 내 토큰일 때만 DEL"을 Lua로 원자적으로 수행한다. GET 후 DEL을 두 명령으로 나누면 그 사이에 만료·재획득이 끼어들어 남의 락을 지울 수 있다.

이 구성이 보장하는 것은 한 시점에 한 클라이언트만 락을 갖는 상호 배제와 TTL로 인한 교착 방지다. 보장하지 않는 것은 마스터 장애 시의 안전성이다. 복제는 비동기이므로 락 키가 replica에 전달되기 전에 마스터가 죽고 replica가 승격되면, 승격된 노드에는 락이 없고 두 번째 클라이언트가 같은 락을 얻는다.

### Redlock

Redlock은 복제 관계가 없는 독립 Redis 인스턴스 N개(보통 5)에 동시에 락을 시도해 과반수 합의로 소유를 결정하는 알고리즘이다.

1. 현재 시각 t1을 기록한다.
2. 모든 인스턴스에 짧은 타임아웃(수 ms)으로 `SET NX PX`를 순차 시도한다.
3. 성공한 인스턴스 수를 센다.
4. 유효 시간을 계산한다. `validity = TTL - (now - t1) - clock drift`.
5. 성공 수가 N/2+1 이상이고 validity가 양수면 획득이다. 아니면 모든 인스턴스에 해제를 보내고 실패 처리한다.

인스턴스 두 대가 죽어도 세 대가 quorum을 이루므로 단일 장애점이 사라지고, 마스터 승격 문제도 없다. 해제는 quorum 여부와 무관하게 N개 전부에 보낸다. 실패한 시도에서도 일부 인스턴스에 락이 남아 있을 수 있기 때문이다.

### 두 방식의 한계 비교

| 항목 | 단일 인스턴스 | Redlock |
|---|---|---|
| 마스터 장애 | 이중 획득 가능 | quorum으로 방어 |
| 클라이언트 정지(GC, 스왑) | 취약 | 취약 |
| 시계 점프 | TTL 오차 | validity 계산 오차 |
| 운영 부담 | 낮음 | 독립 인스턴스 5대 |

Redlock이 해결하는 것은 Redis 쪽 장애이고, 클라이언트 쪽 정지는 어느 쪽도 막지 못한다. 락을 쥔 프로세스가 TTL보다 긴 GC pause에서 깨어나면 그 사이 락을 얻은 다른 프로세스와 동시에 자원을 건드린다. Martin Kleppmann은 락마다 단조 증가하는 fencing token을 발급하고 저장소가 오래된 토큰의 쓰기를 거부해야만 안전하다고 지적했고, 이는 ZooKeeper·etcd 같은 합의 시스템이 제공하는 보장이다. 한 번의 이중 실행도 허용되지 않는 자리는 그쪽으로 가고, 작업을 멱등하게 만들 수 있는 일반 비즈니스 로직은 단일 인스턴스 락이나 Redlock으로 충분하다.

## 코드

Lettuce 기반 `StringRedisTemplate`로 단일 인스턴스 락을 구현한다. 획득은 `setIfAbsent`, 해제는 소유자 검증을 포함한 Lua 스크립트다.

```java
@Component
public class SimpleRedisLock {

    private static final RedisScript<Long> UNLOCK = RedisScript.of("""
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
        """, Long.class);

    private final StringRedisTemplate redis;

    public SimpleRedisLock(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public Optional<String> tryAcquire(String key, Duration ttl) {
        String token = UUID.randomUUID().toString();
        Boolean ok = redis.opsForValue().setIfAbsent(key, token, ttl);
        return Boolean.TRUE.equals(ok) ? Optional.of(token) : Optional.empty();
    }

    public boolean release(String key, String token) {
        Long deleted = redis.execute(UNLOCK, List.of(key), token);
        return deleted != null && deleted == 1L;
    }
}
```

Java에서는 Redlock을 직접 구현하지 않고 Redisson을 쓴다. `redisson-spring-boot-starter`를 추가하면 `RedissonClient` 빈이 자동 구성되며, `tryLock(waitTime, leaseTime, unit)`은 대기 시간과 임대 시간을 분리해 받는다.

```java
@Service
public class OrderService {

    private final RedissonClient redisson;

    public OrderService(RedissonClient redisson) {
        this.redisson = redisson;
    }

    public void process(Long orderId) throws InterruptedException {
        RLock lock = redisson.getLock("lock:order:" + orderId);
        if (!lock.tryLock(5, 30, TimeUnit.SECONDS)) {
            throw new IllegalStateException("order is being processed: " + orderId);
        }
        try {
            // 비즈니스 로직
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}
```

독립 인스턴스 여러 대에 걸친 quorum 락은 `RedissonMultiLock`으로 잡는다. Redisson 3.x 후반부터 `RedissonRedLock`은 deprecated이며, `MultiLock`이 과반수가 아닌 전체 성공을 요구하는 점만 다르다.

```java
RLock l1 = client1.getLock("lock:batch:settlement");
RLock l2 = client2.getLock("lock:batch:settlement");
RLock l3 = client3.getLock("lock:batch:settlement");

RLock multi = new RedissonMultiLock(l1, l2, l3);
if (multi.tryLock(5, 30, TimeUnit.SECONDS)) {
    try {
        // 클러스터에서 한 번만 실행되어야 하는 작업
    } finally {
        multi.unlock();
    }
}
```

## 실무에서 걸리는 지점

- **TTL과 작업 길이의 불일치.** TTL 30초에 작업이 60초 걸리면 후반 30초 동안 다른 워커가 같은 자원을 만진다. Redisson의 `leaseTime`을 지정하지 않으면 watchdog이 기본 30초 임대를 주기적으로 연장해 주지만, 지정하는 순간 watchdog은 꺼진다. 어느 쪽인지 알고 써야 한다.
- **watchdog은 정지된 프로세스를 구하지 못한다.** 연장 스레드도 같은 JVM에 있으므로 GC pause나 스왑으로 전체가 멈추면 연장도 멈춘다. 긴 작업은 쪼개고, 쓰기 경로에는 버전 컬럼이나 조건부 갱신으로 멱등성을 넣는 편이 락을 길게 잡는 것보다 안전하다.
- **강제 종료 후 잔존 락.** `kill -9`나 `finally` 누락으로 해제가 빠지면 TTL이 끝날 때까지 다른 워커가 대기한다. TTL은 평균 작업 시간의 2~3배를 기준으로 잡고 나머지는 연장에 맡긴다.
- **Redlock 대상은 Cluster나 Sentinel이 아니다.** 알고리즘은 서로 복제하지 않는 독립 마스터 N대를 전제한다. 하나의 Cluster에 락 키를 걸면 결국 슬롯을 소유한 마스터 한 대에 의존하므로 단일 인스턴스 락과 같다.
- **락의 정확도를 과신하지 않는다.** 네트워크 파티션으로 락 노드와 워커가 분리되면 갱신은 실패하고 TTL 만료 후 다른 워커가 락을 가져간다. Redis 락은 중복 실행 확률을 낮추는 장치이지 완전한 상호 배제의 증명이 아니다.

## 관련 글

- [Lua Scripting과 Functions](/notes/redis/lua-scripting-functions/)
- [Pipelining·Transaction·WATCH](/notes/redis/pipelining-transactions/)
- [Replication과 Sentinel](/notes/redis/replication-sentinel/)
