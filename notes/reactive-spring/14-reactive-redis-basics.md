---
title: "리액티브 Redis — 연동·Template·자료구조"
series: reactive-spring
part: "리액티브 데이터"
order: 14
summary: "WebFlux에서 Lettuce 기반 ReactiveRedisTemplate으로 Redis를 연동하고 5대 자료구조를 논블로킹으로 다루는 방법을 정리한다."
tags: [Redis, ReactiveRedisTemplate, Lettuce, WebFlux, Spring Data Redis]
sources: [2026-05-03-reactive-redis-setup.md, 2026-05-03-reactive-redis-template.md, 2026-05-03-reactive-redis-data-structures.md]
updated: 2026-08-29
---

WebFlux는 적은 수의 이벤트 루프 스레드로 많은 요청을 처리한다. 여기서 블로킹 `RedisTemplate`을 호출하면 `get()` 한 줄이 이벤트 루프를 점유한 채 응답을 기다리고, 같은 스레드의 다른 요청이 전부 밀린다. 요청마다 Redis를 거치는 경로가 많을수록 처리량 손실은 커진다. Spring Data Redis는 Lettuce의 논블로킹 I/O 위에 `ReactiveRedisTemplate`을 얹어 모든 명령을 `Mono`/`Flux`로 반환하게 한다.

## 핵심 개념

### Redis는 인메모리 데이터 구조 서버다

Redis는 String·Hash·List·Set·ZSet에 Stream·GeoSpatial·HyperLogLog·Bitmap까지 제공한다. 디스크 저장소보다 수천 배 빠르지만 휘발성이므로 영속이 필요하면 RDB·AOF를 설정한다.

### Lettuce와 ReactiveRedisTemplate

Spring Boot의 기본 드라이버는 Lettuce다. Jedis는 동기 전용이라 리액티브 스택에 맞지 않고, Redisson은 분산 락 같은 고수준 API를 `RedissonReactiveClient`로 제공한다. 단순 명령과 캐시는 `ReactiveRedisTemplate`으로 충분하고, 분산 락이 필요한 지점에만 Redisson을 더하는 혼합 구성이 일반적이다.

`spring-boot-starter-data-redis-reactive`를 추가하면 `ReactiveRedisConnectionFactory`, `ReactiveRedisTemplate<Object, Object>`, `ReactiveStringRedisTemplate`이 자동 구성된다. 설정 키는 Spring Boot 3.x 기준 `spring.data.redis.*`다.

`ReactiveRedisTemplate`은 자료구조별 `opsFor*()` 다섯 개를 제공한다. 모든 메서드는 `Mono`/`Flux`를 반환하며 구독 전에는 명령이 전송되지 않는다. 컨트롤러가 반환한 `Mono`를 WebFlux가 구독하므로 서비스 계층은 체인을 끊지 않고 반환한다.

### 직렬화

Key는 `StringRedisSerializer`로 고정한다. Value는 `Jackson2JsonRedisSerializer`(단일 타입)나 `GenericJackson2JsonRedisSerializer`(`@class` 포함, 다형성 지원) 중에서 고른다. `JdkSerializationRedisSerializer`는 Java 전용 바이너리라 운영에서는 피한다. `GenericJackson2JsonRedisSerializer`는 `BasicPolymorphicTypeValidator`로 역직렬화 허용 패키지를 제한해야 임의 클래스 로딩을 막을 수 있다.

### 자료구조 선택 기준

| 자료구조 | 용도 | 복잡도 |
|:---|:---|:---|
| String | 캐시, 카운터(INCR), `SET NX EX` 락 | O(1) |
| Hash | 부분 갱신이 필요한 작은 객체 | O(1) |
| List | FIFO 큐, 최근 N개(LTRIM) | 양 끝 O(1) |
| Set | 태그, 관계, 집합 연산 | 집합 연산 O(N+M) |
| ZSet | 랭킹, 우선순위 큐, 슬라이딩 윈도우 | O(log N) |

## 코드

Key는 String, Value는 JSON으로 저장하는 템플릿 빈 구성이다.

```java
@Configuration
public class RedisConfig {

    @Bean
    public ReactiveRedisTemplate<String, Object> reactiveRedisTemplate(
            ReactiveRedisConnectionFactory factory) {

        ObjectMapper mapper = new ObjectMapper();
        mapper.activateDefaultTyping(
                BasicPolymorphicTypeValidator.builder()
                        .allowIfSubType("com.example.")
                        .build(),
                ObjectMapper.DefaultTyping.NON_FINAL);

        var valueSerializer = new GenericJackson2JsonRedisSerializer(mapper);
        var context = RedisSerializationContext
                .<String, Object>newSerializationContext(new StringRedisSerializer())
                .value(valueSerializer)
                .hashValue(valueSerializer)
                .build();

        return new ReactiveRedisTemplate<>(factory, context);
    }
}
```

캐시 미스 시 R2DBC 리포지토리를 읽고 TTL과 함께 저장한다. 빈 `Mono`는 `switchIfEmpty`, 에러는 `onErrorResume`으로 구분한다.

```java
@Service
public class UserCacheService {

    private final ReactiveRedisTemplate<String, Object> redis;
    private final UserRepository userRepository;

    public UserCacheService(ReactiveRedisTemplate<String, Object> redis,
                            UserRepository userRepository) {
        this.redis = redis;
        this.userRepository = userRepository;
    }

    public Mono<User> findById(String id) {
        String key = "user:" + id;
        return redis.opsForValue().get(key)
                .cast(User.class)
                .switchIfEmpty(userRepository.findById(id)
                        .flatMap(user -> redis.opsForValue()
                                .set(key, user, Duration.ofMinutes(5))
                                .thenReturn(user)));
    }

    public Mono<Boolean> evict(String id) {
        return redis.delete("user:" + id).map(count -> count > 0);
    }
}
```

ZSet으로 실시간 랭킹과 슬라이딩 윈도우 rate limit을 구현한다.

```java
@Service
public class RankingService {

    private final ReactiveStringRedisTemplate redis;

    public RankingService(ReactiveStringRedisTemplate redis) {
        this.redis = redis;
    }

    public Mono<Double> like(String postId) {
        return redis.opsForZSet().incrementScore("rank:posts", postId, 1);
    }

    public Flux<ZSetOperations.TypedTuple<String>> top(int n) {
        return redis.opsForZSet()
                .reverseRangeWithScores("rank:posts", Range.closed(0L, (long) n - 1));
    }

    public Mono<Boolean> allowRequest(String userId, int limit, Duration window) {
        long now = System.currentTimeMillis();
        double windowStart = now - window.toMillis();
        String key = "rate:" + userId;
        var zset = redis.opsForZSet();

        return zset.removeRangeByScore(key,
                        Range.leftUnbounded(Range.Bound.exclusive(windowStart)))
                .then(zset.add(key, UUID.randomUUID().toString(), now))
                .then(zset.count(key, Range.closed(windowStart, (double) now)))
                .flatMap(count -> redis.expire(key, window).thenReturn(count <= limit));
    }
}
```

## 실무에서 걸리는 지점

- **구독되지 않은 체인.** `ops.set(...)`의 반환값을 버리면 명령이 전송되지 않는다. `doOnNext` 안에서 `.subscribe()`를 따로 호출하면 순서와 에러 전파가 보장되지 않으므로 `then`·`flatMap`으로 메인 체인에 합성한다.
- **`KEYS *`와 대형 컬렉션 전체 조회.** O(N) 명령 하나가 단일 스레드인 Redis 전체를 멈춘다. 키 순회는 `SCAN`, 큰 Hash·Set은 `HSCAN`·`SSCAN`으로 나눈다.
- **TTL 없는 캐시 키.** 캐시 키에는 `set(key, value, Duration)`으로 TTL을 항상 지정하고, `INCR` 카운터는 첫 증가 시 `expire`를 건다. List는 `LTRIM`, ZSet은 `removeRangeByScore`로 길이를 제한한다.
- **Lettuce 풀 설정.** Lettuce는 단일 연결을 멀티플렉싱하므로 일반 명령에는 풀이 필요 없다. `spring.data.redis.lettuce.pool`은 트랜잭션이나 `BLPOP` 같은 전용 연결이 필요한 경우에만 의미가 있고, 켜려면 `commons-pool2` 의존성이 필요하다.
- **`@class` 결합.** `GenericJackson2JsonRedisSerializer`는 클래스명을 저장하므로 클래스를 옮기면 기존 데이터 역직렬화가 실패한다. 배포 전 키를 비우는 절차를 정하고, 다른 언어와 공유하는 키는 타입 정보 없는 `Jackson2JsonRedisSerializer`를 쓴다.
- **Cluster의 논리 DB.** Cluster는 0번 DB만 지원하므로 처음부터 키 접두어로 네임스페이스를 분리한다.

## 관련 글

- [리액티브 Redis — 캐싱·Pub/Sub·트랜잭션·성능](/notes/reactive-spring/reactive-redis-advanced/)
- [R2DBC — 리액티브 DB 연동과 JPA 비교](/notes/reactive-spring/r2dbc/)
- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
