---
title: "Pipelining·Transaction·WATCH"
series: redis
part: "명령과 스크립트"
order: 8
summary: "Pipelining은 왕복을 줄이고 MULTI/EXEC는 격리만 보장한다. 롤백은 없고 조건부 갱신은 WATCH 재시도로 푼다."
tags: [Redis, Pipelining, MULTI/EXEC, WATCH, Optimistic Locking]
sources: [data-infra/2026-05-17-redis-pipelining.md, data-infra/2026-05-17-redis-transactions.md, 2026-05-02-redis-performance.md]
updated: 2026-08-29
---

Redis 서버가 명령 하나를 처리하는 시간은 μs 단위지만, 클라이언트와 서버 사이의 네트워크 왕복(RTT)은 같은 리전에서도 수백 μs, 다른 AZ면 1ms 안팎이다. 명령 100개를 순서대로 보내면 응답 시간의 99%가 네트워크 대기로 채워진다. 여기에 "잔액을 읽고, 충분하면 차감한다" 같은 read-modify-write가 겹치면 두 클라이언트가 같은 값을 읽고 같은 결과를 쓰는 lost update가 생긴다. 앞의 문제는 Pipelining이, 뒤의 문제는 MULTI/EXEC와 WATCH가 담당한다. 둘 다 여러 명령을 묶지만 해결하는 문제가 다르다.

## 핵심 개념

### Pipelining — 왕복 횟수 압축

Pipelining은 명령 N개를 응답을 기다리지 않고 연달아 전송하고, 응답 N개를 한 번에 받는 방식이다. 서버 처리 시간은 그대로이고 네트워크 왕복만 N회에서 1회로 줄어든다. 효과는 RTT에 비례하므로 로컬에서는 수 배, 다른 리전에서는 수십 배 차이가 난다. 응답은 보낸 순서대로 돌아오지만 원자성은 없다. 다른 클라이언트의 명령이 묶음 사이에 끼어들 수 있고, 한 명령이 실패해도 나머지는 실행되며 응답 리스트에 에러 객체가 섞인다.

### MULTI/EXEC — 격리된 일괄 실행

`MULTI` 이후의 명령은 실행되지 않고 큐에 쌓이며 `QUEUED` 응답만 받는다. `EXEC`가 호출되면 큐의 명령이 다른 클라이언트의 명령이 끼어들지 못하는 상태로 순차 실행되고 결과가 배열로 반환된다. `DISCARD`는 큐를 비운다.

보장 범위를 정확히 잡아야 한다. Redis 트랜잭션이 제공하는 것은 격리와 묶음 응답뿐이고, RDBMS 의미의 all-or-nothing과 롤백은 없다. 에러 시점에 따라 동작이 갈린다.

| 에러 종류 | 발생 시점 | 결과 |
|:---|:---|:---|
| 문법 에러 (없는 명령, 인자 수 오류) | 큐잉 단계 | `EXEC`가 `EXECABORT`를 반환하고 아무것도 실행되지 않음 |
| 런타임 에러 (문자열 키에 `INCR` 등) | 실행 단계 | 해당 명령만 실패, 앞뒤 명령은 그대로 반영됨 |

"잔액 차감 + 주문 기록"을 MULTI/EXEC로 묶었을 때 차감이 런타임 에러로 실패하면 주문만 남는다. 둘 다 성공해야 하는 작업은 Lua 스크립트로 옮겨야 한다.

### WATCH — Optimistic Locking

`WATCH key`는 그 키를 감시 대상으로 등록한다. 이후 값을 읽고 판단한 뒤 `MULTI`로 명령을 큐잉하고 `EXEC`를 호출하면, 감시 중인 키가 그 사이에 다른 클라이언트에 의해 변경됐을 경우 트랜잭션 전체가 취소되고 `EXEC`는 nil(null)을 반환한다. 락 없이 진행하다 충돌을 감지하면 재시도하는 낙관적 잠금이며, 충돌이 드문 환경에서 `SELECT ... FOR UPDATE` 같은 비관적 잠금보다 오버헤드가 작다. 재시도 루프 없이 한 번만 시도하면 동시성 환경에서 조용히 실패한다. `UNWATCH`는 감시를 해제하며, `EXEC`·`DISCARD` 후에는 자동으로 풀린다.

### 셋의 관계

| 항목 | Pipelining | MULTI/EXEC |
|:---|:---:|:---:|
| 목적 | RTT 절약 | 격리 |
| 다른 클라이언트 끼어들기 | 가능 | 불가 |
| 실패한 명령 이후 | 실행됨 | 실행됨 (런타임 에러) |

`MULTI`부터 `EXEC`까지를 한 번에 흘려보내면 왕복 1회로 격리까지 얻으며, 대부분의 클라이언트가 트랜잭션을 이 방식으로 전송한다. WATCH 패턴은 읽은 값을 보고 분기해야 하므로 최소 2회 왕복이 든다.

## 코드

Spring Data Redis의 `executePipelined`로 대량 SET을 왕복 1회에 처리한다. 콜백의 반환값은 null이어야 하며 각 명령의 응답이 리스트로 돌아온다.

```java
@Service
public class CacheWarmer {

    private final StringRedisTemplate redisTemplate;

    public CacheWarmer(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public List<Object> warm(Map<String, String> entries) {
        return redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
            StringRedisConnection conn = (StringRedisConnection) connection;
            entries.forEach((key, value) -> conn.set(key, value, Expiration.seconds(3600), SetOption.UPSERT));
            return null;
        });
    }
}
```

WATCH + MULTI/EXEC로 잔액을 조건부 차감한다. WATCH는 연결 단위로 동작하므로 `SessionCallback`으로 같은 연결을 유지해야 하고, `exec()`가 null을 돌려주면 충돌이므로 재시도한다.

```java
@Service
public class BalanceService {

    private static final int MAX_RETRY = 5;
    private final StringRedisTemplate redisTemplate;

    public BalanceService(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public boolean withdraw(String userId, long amount) {
        String key = "balance:" + userId;
        for (int attempt = 0; attempt < MAX_RETRY; attempt++) {
            List<Object> result = redisTemplate.execute(new SessionCallback<>() {
                @Override
                @SuppressWarnings("unchecked")
                public List<Object> execute(RedisOperations operations) {
                    operations.watch(key);
                    String current = (String) operations.opsForValue().get(key);
                    long balance = current == null ? 0 : Long.parseLong(current);
                    if (balance < amount) {
                        operations.unwatch();
                        return List.of();          // 잔액 부족: 빈 리스트로 구분
                    }
                    operations.multi();
                    operations.opsForValue().set(key, String.valueOf(balance - amount));
                    return operations.exec();      // 충돌 시 null
                }
            });
            if (result == null) continue;          // WATCH 키가 바뀜 → 재시도
            return !result.isEmpty();
        }
        throw new IllegalStateException("balance update contention: " + key);
    }
}
```

Lettuce를 직접 쓸 때는 자동 flush를 끄고 명령을 쌓은 뒤 한 번에 내보낸다. 같은 연결을 공유하는 다른 스레드의 명령까지 멈추므로 전용 연결에서만 사용한다.

```java
public List<String> bulkGet(StatefulRedisConnection<String, String> connection, List<String> keys) {
    RedisAsyncCommands<String, String> async = connection.async();
    connection.setAutoFlushCommands(false);
    try {
        List<RedisFuture<String>> futures = keys.stream().map(async::get).toList();
        connection.flushCommands();
        LettuceFutures.awaitAll(Duration.ofSeconds(5), futures.toArray(RedisFuture[]::new));
        return futures.stream().map(f -> f.toCompletableFuture().join()).toList();
    } finally {
        connection.setAutoFlushCommands(true);
    }
}
```

## 실무에서 걸리는 지점

- **묶음 크기.** 파이프라인에 수십만 명령을 넣으면 양쪽에서 응답 버퍼가 메모리에 쌓인다. 한 묶음은 수백~수천 명령으로 자르고 chunk 단위로 반복한다. MULTI/EXEC는 반대로 더 작아야 한다. `EXEC` 실행 중에는 단일 스레드가 다른 요청을 처리하지 못하므로 트랜잭션 안의 명령은 수십 개 이내로 두고, 큰 묶음은 트랜잭션 없는 파이프라인으로 보낸다.
- **WATCH와 커넥션 풀.** WATCH 상태는 연결에 붙는다. `RedisTemplate`을 그냥 호출하면 명령마다 풀에서 다른 연결을 꺼낼 수 있어 WATCH가 무력화되므로, `SessionCallback` 안에서 WATCH·MULTI·EXEC를 끝내야 한다.
- **Cluster의 CROSSSLOT.** MULTI/EXEC 안의 모든 키는 같은 해시 슬롯에 있어야 하며 아니면 `CROSSSLOT` 에러가 난다. `{user42}:balance`, `{user42}:orders`처럼 hash tag로 슬롯을 고정한다.
- **중간 결과로 분기할 수 없다.** MULTI 안에서 `GET`은 큐잉만 되므로 그 값을 보고 다음 명령을 정할 수 없다. 조건부 로직은 WATCH 재시도 루프이거나, 왕복 1회에 원자성까지 얻는 Lua 스크립트여야 한다.
- **비동기 병렬 호출과 파이프라인은 다르다.** `CompletableFuture`로 명령 100개를 동시에 던져도 서버는 여전히 요청 100개를 받는다. 왕복을 1회로 만드는 것은 파이프라인뿐이며, `MGET`처럼 한 명령으로 묶이는 read는 그 명령이 더 단순하다.

## 관련 글

- [Lua Scripting과 Functions](/notes/redis/lua-scripting-functions/)
- [분산 락 — SET NX와 Redlock](/notes/redis/distributed-lock-redlock/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
