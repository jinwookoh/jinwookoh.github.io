---
title: "String·Hash — 값 캐싱과 객체 저장"
series: redis
part: "데이터 타입"
order: 3
summary: "String은 값 하나·카운터·비트맵·락에, Hash는 부분 갱신이 잦은 flat 객체에 쓴다"
tags: [Redis, String, Hash, Spring Data Redis, 캐싱]
sources: [data-infra/2026-05-17-redis-strings.md, data-infra/2026-05-17-redis-hashes.md]
updated: 2026-08-29
---

관계형 DB에서 조회수를 올리려면 읽고, 더하고, 쓰는 세 단계를 거치며 동시 요청이 겹치면 갱신이 유실된다. 세션이나 인증번호처럼 수명이 정해진 값은 만료 컬럼과 정리 배치가 따로 필요하다. 프로필을 캐시에 통째로 넣어 두면 이메일 하나를 바꿀 때도 전체를 읽어 파싱하고 다시 써야 한다. Redis의 String과 Hash는 이를 각각 원자적 증감, 키 단위 TTL, 필드 단위 갱신으로 해결한다.

## 핵심 개념

### String — 모든 값의 기본 형태

String은 바이트 시퀀스다. 문자열, 숫자, 직렬화된 객체, 바이너리가 모두 들어가며 최대 크기는 512MB다. `SET`과 `GET`은 O(1)이고, `SET`은 기존 키가 Hash나 List여도 확인 없이 String으로 덮어쓴다. 반대로 `GET`을 다른 타입 키에 실행하면 `WRONGTYPE` 오류가 난다.

| 옵션 | 동작 | 용도 |
|:---|:---|:---|
| `EX` / `PX` | 초·밀리초 TTL | 세션, OTP, 캐시 |
| `NX` | 키가 없을 때만 저장 | 락 획득, 중복 방지 |
| `XX` | 키가 있을 때만 저장 | 워밍된 캐시만 갱신 |
| `KEEPTTL` | 값만 바꾸고 남은 TTL 유지 | 만료를 건드리지 않는 갱신 |
| `GET` | 저장 전 기존 값 반환 | 원자적 교체 |

숫자로 해석되는 String에는 `INCR`, `INCRBY`, `DECR`, `INCRBYFLOAT`가 허용된다. 명령이 단일 스레드에서 순서대로 처리되므로 증감은 별도 락 없이 원자적이며, 키가 없으면 0에서 시작한다. `MSET`/`MGET`은 여러 키를 한 번의 왕복으로 처리하지만 명령 하나 안에서만 원자적이고, 앞뒤 명령과 묶으려면 `MULTI`/`EXEC`가 필요하다.

`APPEND`, `STRLEN`, `GETRANGE`는 바이트 단위라서 `STRLEN`은 글자 수가 아니라 바이트 수를 돌려준다. `SETBIT`, `GETBIT`, `BITCOUNT`, `BITOP`는 String을 비트 배열로 다룬다. 사용자 ID를 오프셋으로 쓰면 1억 명의 일별 출석이 약 12.5MB에 담긴다. Bitmap은 별도 타입이 아니라 String의 비트 뷰다.

### Hash — 한 키 안의 field-value 집합

Hash는 키 하나 아래에 field-value 쌍을 담는 `Map<String, String>` 모델이며 중첩은 불가능하다. `HSET`은 필드당 O(1)이고 반환값은 새로 생성된 필드 수라서 덮어쓰기는 0을 돌려준다. `HGET`은 필드나 키가 없어도 `nil`을 반환하고, `HMGET`은 지정한 필드만 읽으며, `HGETALL`은 O(N)이다. `HINCRBY`는 필드 단위 원자 카운터고, 큰 Hash 순회는 `HSCAN`으로 나눈다.

TTL은 키 단위로 걸린다. Redis 7.4부터 `HEXPIRE` 계열로 필드별 만료를 줄 수 있지만 클라이언트 지원이 아직 제한적이므로, 수명이 다른 필드는 키를 나누는 편이 안전하다.

내부 인코딩은 크기에 따라 전환된다. 필드 수가 `hash-max-listpack-entries`(기본 128) 이하이고 모든 값이 `hash-max-listpack-value`(기본 64바이트) 이하이면 연속 메모리에 압축한 listpack을 쓰고, 하나라도 넘으면 hashtable로 바뀐다. 필드 열 개 안팎의 객체가 Hash에서 메모리 효율이 좋은 이유다.

### String JSON과 Hash의 선택

| 기준 | String JSON | Hash |
|:---|:---|:---|
| 전체 읽기·쓰기가 대부분 | 유리 | 가능 |
| 특정 필드만 자주 갱신·읽기 | 전체 read-modify-write | `HSET`/`HMGET` |
| 중첩 구조·배열 | 자연스러움 | 불가 |
| 필드별 원자 카운터 | 불가 | `HINCRBY` |
| 작은 객체 메모리 | JSON 오버헤드 | listpack |

통째로 넣고 빼는 비중이 압도적이거나 중첩이 있으면 String JSON, 필드 단위 접근과 카운터가 잦고 구조가 평면이면 Hash다.

## 코드

`StringRedisTemplate`으로 원자 카운터, TTL이 있는 세션 값, `SET NX EX` 락 획득을 처리하는 예제다.

```java
package com.example.redis;

import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class CounterService {

    private final StringRedisTemplate redis;

    public CounterService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public long increasePageView(String date) {
        Long value = redis.opsForValue().increment("pv:" + date);
        return value == null ? 0L : value;
    }

    public void saveSession(String sessionId, String payload) {
        redis.opsForValue().set("session:" + sessionId, payload, Duration.ofHours(1));
    }

    public boolean tryAcquire(String resource, String owner) {
        Boolean ok = redis.opsForValue()
                .setIfAbsent("lock:" + resource, owner, Duration.ofSeconds(30));
        return Boolean.TRUE.equals(ok);
    }
}
```

사용자 프로필을 Hash로 캐싱하고 이메일만 부분 갱신하는 예제다. `putAll`은 `HSET`에 필드를 한꺼번에 전달하고 `expire`로 키 단위 TTL을 건다.

```java
package com.example.redis;

import java.time.Duration;
import java.util.Map;
import org.springframework.data.redis.core.HashOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class UserCacheService {

    private static final Duration TTL = Duration.ofHours(1);

    private final StringRedisTemplate redis;
    private final UserRepository userRepository;

    public UserCacheService(StringRedisTemplate redis, UserRepository userRepository) {
        this.redis = redis;
        this.userRepository = userRepository;
    }

    public Map<String, String> getUser(long id) {
        String key = "user:" + id;
        HashOperations<String, String, String> hash = redis.opsForHash();
        Map<String, String> cached = hash.entries(key);
        if (!cached.isEmpty()) {
            return cached;
        }
        User user = userRepository.findById(id).orElseThrow();
        Map<String, String> fields = Map.of(
                "name", user.name(),
                "email", user.email(),
                "age", String.valueOf(user.age()));
        hash.putAll(key, fields);
        redis.expire(key, TTL);
        return fields;
    }

    public void updateEmail(long id, String email) {
        redis.<String, String>opsForHash().put("user:" + id, "email", email);
    }

    public long increaseLoginCount(long id) {
        return redis.opsForHash().increment("user:" + id + ":stats", "logins", 1L);
    }
}
```

객체를 통째로 캐싱한다면 Spring Cache 추상화가 더 짧다. `@Cacheable`은 반환 객체를 JSON String 하나로 `SET`한다.

```java
@Configuration
class CacheConfig {

    @Bean
    RedisCacheConfiguration cacheConfiguration() {
        return RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(10))
                .serializeValuesWith(RedisSerializationContext.SerializationPair
                        .fromSerializer(new GenericJackson2JsonRedisSerializer()));
    }
}

@Service
class ProductService {

    private final ProductRepository productRepository;

    ProductService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Cacheable(cacheNames = "products", key = "#id")
    public Product getProduct(long id) {
        return productRepository.findById(id).orElseThrow();
    }
}
```

## 실무에서 걸리는 지점

- **`SET`의 타입 덮어쓰기.** 다른 타입 명령은 키 타입을 검사하지만 `SET`은 Hash든 List든 지우고 String으로 바꾼다. 키 접두사를 타입·서비스별로 분리한다.
- **큰 Hash에 `HGETALL`.** 필드가 수천 개를 넘으면 O(N) 응답이 단일 스레드를 점유해 다른 명령까지 지연된다. `HMGET`으로 필요한 필드만 읽고, 수만 필드로 자라면 키를 분할한다.
- **listpack 경계를 넘는 값.** 필드 하나라도 64바이트를 넘으면 Hash 전체가 hashtable로 바뀌어 메모리가 수 배 늘어난다. 긴 문자열이나 직렬화된 JSON을 Hash 필드에 넣는 순간 작은 객체의 이점이 사라진다.
- **TTL 없는 갱신.** 옵션 없는 `SET`은 기존 TTL을 지워 영구 키를 만든다. `KEEPTTL`을 쓰거나 TTL을 다시 지정하고, Hash는 `HSET` 후 `EXPIRE`를 잊지 않는다. `@Cacheable`도 `entryTtl`이 없으면 만료 없이 쌓인다.
- **직렬화 불일치.** `RedisTemplate` 기본값은 JDK 직렬화라서 CLI에서 읽을 수 없다. `StringRedisTemplate`이나 JSON 직렬화기로 통일한다.

## 관련 글

- [데이터 타입 개관](/notes/redis/data-types-overview/)
- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
- [분산 락 — SET NX와 Redlock](/notes/redis/distributed-lock-redlock/)
