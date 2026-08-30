---
title: "Lua Scripting과 Functions"
series: redis
part: "명령과 스크립트"
order: 9
summary: "조건부 로직을 서버 안에서 원자적으로 묶는 EVAL과, 그 휘발성·익명성을 없앤 Redis 7 Functions의 사용법과 함정"
tags: [Redis, Lua, EVAL, Redis Functions, FCALL]
sources: [data-infra/2026-05-17-redis-lua-scripting.md, data-infra/2026-05-17-redis-functions.md]
updated: 2026-08-29
---

MULTI/EXEC는 명령을 묶어 격리해 줄 뿐, "GET한 값이 이 UUID와 같을 때만 DEL한다" 같은 조건 분기를 담지 못한다. WATCH를 쓰면 재시도 루프가 애플리케이션에 남고, 분산 락 해제나 슬라이딩 윈도우 rate limiter처럼 읽고 판단하고 쓰는 작업은 클라이언트 왕복 사이에 다른 요청이 끼어든다. Redis는 이 문제를 서버 안에서 Lua 코드를 한 명령처럼 실행하는 EVAL로 풀고, Redis 7부터는 스크립트를 이름 있는 영속 라이브러리로 관리하는 Functions를 추가했다.

## 핵심 개념

EVAL의 시그니처는 `EVAL <script> <numkeys> <key...> <arg...>`다. 앞쪽 numkeys개는 Lua 안에서 `KEYS[]`, 나머지는 `ARGV[]`로 들어온다. 둘을 분리하는 이유는 Cluster 라우팅이다. ==서버는 `KEYS[]`만 보고 해시 슬롯을 계산하므로, 키 이름을 `ARGV[]`로 넘기면 단일 인스턴스에서는 동작해도 Cluster에서는 잘못된 노드로 가거나 CROSSSLOT 에러가 난다.==

스크립트 안에서 Redis 명령은 `redis.call`로 호출하며, 에러가 나면 스크립트 전체가 중단된다. `redis.pcall`은 에러를 `{err = "..."}` 테이블로 돌려주어 진행을 계속한다. 반환값은 Integer는 number, Bulk string은 string, Multi-bulk는 table, nil은 false로 변환된다.

스크립트는 통째로 하나의 명령으로 실행되어 다른 클라이언트의 명령이 끼어들지 못한다. `redis.call` 사이에 조건문을 넣어도 원자성이 유지된다는 점이 MULTI/EXEC와의 결정적 차이다.

`SCRIPT LOAD`로 등록하면 SHA1이 반환되고 이후 `EVALSHA <sha>`로 호출한다. 캐시는 메모리에만 있어 재시작이나 `SCRIPT FLUSH` 뒤에는 NOSCRIPT 에러가 나며, 클라이언트는 이때 EVAL로 다시 보낸다. Spring Data Redis와 Lettuce는 이 폴백을 내장하고 있다.

Functions는 이 모델의 운영상 약점을 겨냥한다. 라이브러리 단위로 등록하고, RDB·AOF에 함께 저장되어 재시작 후에도 남으며, replica에도 라이브러리 자체가 복제된다. 식별자는 SHA1이 아니라 함수 이름이고, 라이브러리는 통째로 원자적으로 교체된다.

| 항목 | EVAL/EVALSHA | Functions |
|:---|:---|:---|
| 식별 | SHA1 | 라이브러리·함수 이름 |
| 영속성 | 메모리 캐시, 재시작 시 소실 | RDB·AOF에 저장 |
| replica | 실행 결과만 복제 | 라이브러리 자체 복제 |
| 갱신 단위 | 스크립트 하나 | 라이브러리 전체 원자 교체 |
| 호출 | `EVAL`, `EVALSHA` | `FCALL`, `FCALL_RO` |
| 지원 버전 | 전 버전 | Redis 7.0 이상 |

라이브러리 소스는 첫 줄 `#!lua name=<lib>`로 이름을 선언하고 `redis.register_function`으로 함수를 등록한다. 함수 인자는 `keys`, `args` 두 테이블로 EVAL의 `KEYS[]`·`ARGV[]`와 역할이 같다. 쓰기를 하지 않는 함수에 `flags = {'no-writes'}`를 붙이면 `FCALL_RO`로 호출할 수 있고 replica로 라우팅된다. 관리 명령은 `FUNCTION LOAD [REPLACE]`, `LIST`, `DELETE`, `FLUSH`, `DUMP`/`RESTORE`, `STATS`다. 두 모델은 공존하므로 기존 EVAL 코드를 한꺼번에 옮길 필요는 없다.

## 코드

Spring Data Redis의 `RedisScript`로 분산 락 해제 스크립트를 실행한다. EVALSHA 실패 시 EVAL 폴백은 라이브러리가 담당한다.

```java
@Component
public class LockReleaser {

    private static final RedisScript<Long> UNLOCK = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public LockReleaser(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public boolean release(String lockKey, String token) {
        Long deleted = redis.execute(UNLOCK, List.of(lockKey), token);
        return deleted != null && deleted == 1L;
    }
}
```

Sorted Set 기반 슬라이딩 윈도우 rate limiter다. 현재 시각은 클라이언트가 `ARGV`로 넘긴다.

```java
@Component
public class SlidingWindowLimiter {

    private static final RedisScript<Long> ALLOW = RedisScript.of("""
            local now = tonumber(ARGV[1])
            local window = tonumber(ARGV[2])
            local limit = tonumber(ARGV[3])
            redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
            if redis.call('ZCARD', KEYS[1]) >= limit then
                return 0
            end
            redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[4])
            redis.call('PEXPIRE', KEYS[1], window)
            return 1
            """, Long.class);

    private final StringRedisTemplate redis;

    public SlidingWindowLimiter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public boolean allow(String userId, long windowMs, int limit) {
        Long ok = redis.execute(ALLOW, List.of("rate:{" + userId + "}"),
                String.valueOf(System.currentTimeMillis()),
                String.valueOf(windowMs),
                String.valueOf(limit),
                UUID.randomUUID().toString());
        return ok != null && ok == 1L;
    }
}
```

같은 로직을 Functions 라이브러리로 옮기고 Lettuce의 `functionLoad`·`fcall`로 등록·호출한다. 등록은 기동 시 한 번, `REPLACE`로 멱등하게 수행한다.

```java
@Component
public class LockFunctions {

    private static final String LIBRARY = """
            #!lua name=locklib
            redis.register_function('unlock', function(keys, args)
                if redis.call('GET', keys[1]) == args[1] then
                    return redis.call('DEL', keys[1])
                end
                return 0
            end)
            redis.register_function{
                function_name = 'lock_owner',
                callback = function(keys, args)
                    return redis.call('GET', keys[1])
                end,
                flags = {'no-writes'}
            }
            """;

    private final RedisCommands<String, String> cmd;

    public LockFunctions(StatefulRedisConnection<String, String> connection) {
        this.cmd = connection.sync();
    }

    @PostConstruct
    void load() {
        cmd.functionLoad(LIBRARY, true);
    }

    public boolean release(String lockKey, String token) {
        Long deleted = cmd.fcall("unlock", ScriptOutputType.INTEGER,
                new String[]{lockKey}, token);
        return deleted != null && deleted == 1L;
    }

    public String owner(String lockKey) {
        return cmd.fcallReadOnly("lock_owner", ScriptOutputType.VALUE,
                new String[]{lockKey});
    }
}
```

## 실무에서 걸리는 지점

- 스크립트는 메인 스레드를 점유한다. 실행이 `busy-reply-threshold`(기본 5,000ms, Redis 7 이전 이름은 `lua-time-limit`)를 넘으면 다른 클라이언트는 BUSY 응답을 받는다. ==`SCRIPT KILL`·`FUNCTION KILL`은 쓰기를 시작하지 않은 스크립트에만 통하고, 그 뒤에는 `SHUTDOWN NOSAVE`밖에 없다.==
- Cluster에서는 한 스크립트가 만지는 모든 키가 같은 슬롯에 있어야 한다. `rate:{user42}`처럼 hash tag로 슬롯을 고정하고, 키 이름을 `ARGV`에 숨겨 검사를 우회하지 않는다.
- ==`TIME`, `SRANDMEMBER`, `SPOP` 같은 비결정적 명령을 스크립트 안에서 호출하면 replica와 AOF 재생 결과가 달라질 수 있다.== 시각이나 난수는 클라이언트가 `ARGV`로 넘긴다.
- EVALSHA만 쓰는 코드는 `SCRIPT FLUSH`, 재시작, replica 승격 뒤 NOSCRIPT로 실패한다. 폴백이 내장된 클라이언트를 쓰거나 Functions로 옮긴다. Functions는 Redis 7.0 이상, Lettuce 6.2 이상·Jedis 5 이상이 필요하다.
- Lua 엔진은 5.1이라 `goto`와 `bit32`가 없고 I/O·OS 모듈은 차단된다. 디버거가 없어 `redis.log`가 유일한 출력 수단이므로, 조건 분기가 있는 스크립트는 Testcontainers로 Redis를 띄워 테스트로 검증한다.

## 관련 글

- [Pipelining·Transaction·WATCH](/notes/redis/pipelining-transactions/)
- [Sorted Set — 랭킹과 Rate Limiter](/notes/redis/sorted-set/)
- [분산 락 — SET NX와 Redlock](/notes/redis/distributed-lock-redlock/)
