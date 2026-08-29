---
title: "리액티브 Redis — 캐싱·Pub/Sub·트랜잭션·성능"
series: reactive-spring
part: "리액티브 데이터"
order: 15
summary: "WebFlux에서 Redis를 캐시·메시지 버스·원자 연산 수단으로 쓸 때 맞는 패턴과 성능이 새는 지점"
tags: [Redis, Spring Data Redis, Lettuce, Cache-Aside, Pub/Sub, Lua Script]
sources: [2026-05-03-reactive-redis-caching.md, 2026-05-03-reactive-redis-pubsub.md, 2026-05-03-reactive-redis-advanced.md, 2026-05-03-reactive-redis-performance.md]
updated: 2026-08-29
---

개별 명령을 호출할 수 있게 된 다음 단계는 Redis를 구조 안에 어떻게 배치하느냐다. 캐시로 쓰려면 미스·갱신·무효화 규칙이 필요하고, 서버 여러 대가 WebSocket 세션을 나눠 들고 있으면 서버 사이 전달 경로가 필요하며, 잔액 차감처럼 끼어들기가 없어야 하는 연산도 있다. 동기 시절 습관대로 짜면 Mono 반환 메서드에 `@Cacheable`을 붙여 두 번째 호출부터 빈 값을 받거나, 갱신을 set으로 처리해 옛 값이 새 값을 덮어쓰거나, MULTI/EXEC에 롤백을 기대하게 된다. 성능도 직렬화·왕복·O(N) 명령 중 하나만 어긋나면 병목이 된다.

## 핵심 개념

### 캐싱 — Cache-Aside가 기본

Spring Cache 추상화는 메서드 반환값을 그대로 저장한다. 반환 타입이 `Mono<User>`면 값이 아니라 Publisher가 저장되고, cold publisher는 구독 시점에 실행되므로 캐시에서 꺼낸 Mono는 기대한 값을 주지 않는다. Spring Framework 6.1부터 `@Cacheable`이 Mono·Flux 반환을 인식해 `Cache.retrieve()`로 비동기 조회하며 Spring Data Redis 3.2 이상의 RedisCache가 이를 지원하지만, TTL·미스 처리를 코드로 제어하려면 ReactiveRedisTemplate으로 직접 짜는 Cache-Aside가 가장 명확하다. reactor-extra의 `CacheMono`는 deprecated 상태다.

갱신 시점에는 set이 아니라 delete를 쓴다. 두 요청의 DB 저장 순서와 캐시 set 순서가 엇갈리면 옛 값이 남지만, delete는 다음 조회가 DB를 다시 읽으므로 경합이 없다. TTL은 변경 빈도에 따라 가격은 수 분, 프로필은 30분 안팎, 카탈로그는 하루 정도로 차등한다.

### Pub/Sub과 Streams

Pub/Sub은 PUBLISH 시점에 구독 중인 클라이언트에게만 전달하고 저장하지 않는다. at-most-once이며 구독이 끊긴 사이 메시지는 사라진다. 인스턴스 사이의 WebSocket 메시지 전파처럼 잃어도 되는 알림에 맞는다. 채팅 이력·이벤트 로그처럼 잃으면 안 되는 것은 Streams로 XADD 후 컨슈머 그룹(XREADGROUP·XACK)에서 at-least-once 처리를 한다.

### 트랜잭션 — MULTI/EXEC의 범위

MULTI와 EXEC 사이 명령은 큐에 쌓였다가 한 번에 실행되어 다른 클라이언트가 끼어들지 못한다. 보장은 격리뿐이다. 중간 명령이 런타임 오류를 내도 나머지는 반영되고 롤백은 없다. WATCH는 감시 키가 바뀌면 EXEC가 nil을 돌려주는 낙관적 락이다. 리액티브 환경의 MULTI/EXEC는 연결 단위 상태를 요구해 Lettuce의 연결 공유 모델과 맞지 않으므로, 읽은 값을 조건으로 쓰기를 결정하는 로직은 Lua 스크립트로 서버에서 한 번에 실행한다.

영속화는 RDB 스냅샷과 AOF(`appendfsync everysec`)를 함께 켜는 것이 표준이다. 접근 제어는 Redis 6 이상의 ACL로 키 패턴(`~app:*`)·명령 카테고리(`+@read`)를 사용자별로 분리하고 `spring.data.redis.username`/`password`로 연결한다.

### 성능 — 세 층에서 따로 잰다

클라이언트 처리, 네트워크 왕복, Redis 명령 시간을 나눠 측정한다. 클라이언트 층에서는 ReactiveRedisTemplate에 직렬화 비용이, Redisson에 분산 도구 비용이 더해지며, JdkSerialization은 느리고 크므로 JSON이나 Protobuf를 쓴다. 네트워크 층에서는 Lettuce가 단일 Netty 연결 위에서 요청을 멀티플렉싱하므로 `flatMap`으로 동시에 흘려보내면 별도 파이프라인 API 없이 왕복이 겹쳐지고, 키 여러 개는 MGET 한 번이 가장 싸다. Redis 층에서는 SLOWLOG로 10ms 이상 명령을 잡고 `INFO`의 `used_memory`·`mem_fragmentation_ratio`를 본다. 캐시 용도라면 `maxmemory`와 `allkeys-lru`를 함께 둔다.

## 코드

Cache-Aside를 ReactiveRedisTemplate으로 직접 구현하고, 갱신은 delete로 무효화한다.

```java
@Service
public class UserCacheService {

    private static final Duration TTL = Duration.ofMinutes(30);

    private final ReactiveRedisTemplate<String, User> redis;
    private final UserRepository repository;

    public UserCacheService(ReactiveRedisTemplate<String, User> redis,
                            UserRepository repository) {
        this.redis = redis;
        this.repository = repository;
    }

    public Mono<User> findById(String id) {
        String key = "user:" + id;
        return redis.opsForValue().get(key)
            .switchIfEmpty(Mono.defer(() ->
                repository.findById(id)
                    .flatMap(user -> redis.opsForValue()
                        .set(key, user, TTL)
                        .thenReturn(user))));
    }

    public Mono<User> update(User user) {
        return repository.save(user)
            .flatMap(saved -> redis.delete("user:" + saved.id())
                .thenReturn(saved));
    }
}
```

WebSocket 핸들러가 수신 메시지를 채널에 발행하고 같은 채널 구독 스트림을 세션으로 내보내, 서버 여러 대에 걸친 채팅 방을 만든다.

```java
@Component
public class ChatHandler implements WebSocketHandler {

    private final ReactiveRedisTemplate<String, String> redis;

    public ChatHandler(ReactiveRedisTemplate<String, String> redis) {
        this.redis = redis;
    }

    @Override
    public Mono<Void> handle(WebSocketSession session) {
        String channel = "chat:" + roomId(session);

        Mono<Void> inbound = session.receive()
            .map(WebSocketMessage::getPayloadAsText)
            .flatMap(text -> redis.convertAndSend(channel, text))
            .then();

        Mono<Void> outbound = session.send(
            redis.listenToChannel(channel)
                .map(ReactiveSubscription.Message::getMessage)
                .map(session::textMessage));

        return Mono.zip(inbound, outbound).then();
    }

    private String roomId(WebSocketSession session) {
        return session.getHandshakeInfo().getUri().getQuery().replace("room=", "");
    }
}
```

잔액이 충분할 때만 차감하는 조건부 갱신을 Lua 스크립트로 원자적으로 실행한다.

```java
@Component
public class BalanceService {

    private static final RedisScript<Long> WITHDRAW = RedisScript.of("""
        local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
        local amount = tonumber(ARGV[1])
        if balance >= amount then
            return redis.call('DECRBY', KEYS[1], amount)
        end
        return -1
        """, Long.class);

    private final ReactiveRedisTemplate<String, String> redis;

    public BalanceService(ReactiveRedisTemplate<String, String> redis) {
        this.redis = redis;
    }

    public Mono<Long> withdraw(String accountId, long amount) {
        return redis.execute(WITHDRAW,
                List.of("balance:" + accountId),
                List.of(String.valueOf(amount)))
            .next()
            .filter(result -> result >= 0)
            .switchIfEmpty(Mono.error(new IllegalStateException("insufficient balance")));
    }
}
```

## 실무에서 걸리는 지점

- **캐시 스탬피드.** 인기 키가 만료되는 순간 미스가 동시에 터지면 요청 수만큼 DB 조회가 나간다. `setIfAbsent`로 짧은 락을 잡아 한 요청만 DB를 읽게 하거나, soft TTL과 hard TTL을 나눠 만료 직전에 갱신한다.
- **패턴 구독과 Cluster.** `listenToPattern`은 모든 PUBLISH마다 패턴 매칭이 돌고, Cluster 모드에서는 메시지가 전 노드로 브로드캐스트된다. 규모가 커지면 Streams로 옮긴다.
- **블로킹 명령.** Lettuce는 연결 하나를 공유하므로 BLPOP이 점유하면 뒤에 쌓인 명령이 모두 기다린다. 전용 연결로 분리한다.
- **O(N) 명령.** `KEYS *`, 큰 Set의 SMEMBERS, 큰 Hash의 HGETALL은 단일 스레드인 Redis 전체를 멈춘다. SCAN 계열로 바꾸고, FLUSHALL·CONFIG·DEBUG는 `rename-command`로 막는다.
- **메모리 정책.** `noeviction`은 메모리가 차면 모든 쓰기가 실패한다. 캐시라면 `allkeys-lru`와 모든 키의 TTL이 기본이다.

## 관련 글

- [리액티브 Redis — 연동·Template·자료구조](/notes/reactive-spring/reactive-redis-basics/)
- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [스트리밍 응답 — SSE·NDJSON](/notes/reactive-spring/streaming-sse-ndjson/)
