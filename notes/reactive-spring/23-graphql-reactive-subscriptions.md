---
title: "GraphQL — 리액티브 통합과 Subscription"
series: reactive-spring
part: "GraphQL"
order: 23
summary: "Spring for GraphQL은 Mono/Flux 반환을 그대로 처리하며, Subscription은 Flux 하나와 Sinks·Pub/Sub 조합으로 실시간 스트림이 된다"
tags: [GraphQL, Subscription, WebFlux, Sinks, graphql-ws]
sources: [2026-05-03-graphql-reactive.md, 2026-05-03-graphql-subscriptions.md]
updated: 2026-08-29
---

GraphQL 리졸버가 동기 값만 반환하면 R2DBC·Reactive Redis·WebClient로 얻은 `Mono`를 매번 `block()`으로 풀어야 하고, 이벤트 루프가 막혀 WebFlux의 처리량 이점이 사라진다. 알림·채팅·시세처럼 서버가 먼저 데이터를 밀어야 하는 요구는 Query·Mutation만으로는 폴링밖에 답이 없다. Spring for GraphQL은 리졸버가 `Mono`·`Flux`를 반환하면 구독과 응답 조립을 대신 처리하고, `Subscription` 타입을 `Flux` 하나로 WebSocket·SSE 스트림에 연결한다.

## 핵심 개념

### Mono/Flux 반환

`@QueryMapping`·`@SchemaMapping`·`@MutationMapping` 메서드는 `Mono<T>`, `Flux<T>`, `Mono<List<T>>` 중 무엇을 반환해도 된다. 리스트 필드에 `Flux<T>`를 반환하면 엔진이 완료까지 모아 배열로 직렬화한다. 의존 관계가 있는 호출은 `flatMap`으로 잇고, 독립인 호출은 `Mono.zip`으로 동시에 실행한다. `@BatchMapping`도 `Mono<Map<K, V>>`를 반환할 수 있어 N+1 해소가 논블로킹으로 이루어진다.

에러는 Reactor 연산자와 `@GraphQlExceptionHandler`가 함께 다룬다. `switchIfEmpty`로 빈 결과를 오류로 바꾸고, `onErrorResume`으로 특정 필드만 null 처리하면 부분 응답(data + errors)이 된다. 요청 범위 정보는 `ThreadLocal` 대신 Reactor `Context`로 전파한다.

### Subscription

스키마에 `type Subscription`을 선언하고 `@SubscriptionMapping` 메서드가 `Flux<T>`를 반환하면 된다. 발행 채널은 `Sinks.Many`다.

| Sink | 동작 | 용도 |
|---|---|---|
| `multicast().onBackpressureBuffer()` | 구독 시점 이후 이벤트를 모든 구독자에게 | 알림·채팅 기본 |
| `replay().limit(n)` | 새 구독자에게 최근 n개도 재전송 | 접속 직후 최근 이력 |
| `unicast().onBackpressureBuffer()` | 구독자 한 명만 허용 | 1:1 스트림 |
| `multicast().directBestEffort()` | 느린 구독자 이벤트 드롭 | 손실 허용 시세 |

전송은 두 가지다. WebSocket은 `spring.graphql.websocket.path`를 지정하면 활성화되고 `graphql-ws` 프로토콜(ConnectionInit → ConnectionAck → Subscribe → Next → Complete)을 따른다. 구버전 `subscriptions-transport-ws`는 deprecated다. SSE는 `spring.graphql.sse.path`로 켜며 HTTP 단방향이라 프록시 통과가 쉽지만 클라이언트가 서버로 보낼 수 없다.

인스턴스가 두 대 이상이면 메모리 Sink만으로는 다른 서버의 구독자에게 이벤트가 닿지 않는다. Mutation이 Redis Pub/Sub 또는 Kafka에 발행하고 각 인스턴스가 이를 구독해 로컬 Flux로 흘린다. Redis는 휘발성, Kafka는 영속·재처리 가능이다.

## 코드

R2DBC 리포지토리를 그대로 연결하고 독립 호출은 `Mono.zip`으로 병렬화한 Query 리졸버.

```java
@Controller
public class UserController {

    private final UserRepository userRepo;
    private final StatsService statsService;
    private final NotificationRepository notificationRepo;

    public UserController(UserRepository userRepo, StatsService statsService,
                          NotificationRepository notificationRepo) {
        this.userRepo = userRepo;
        this.statsService = statsService;
        this.notificationRepo = notificationRepo;
    }

    @QueryMapping
    public Mono<User> user(@Argument String id) {
        return userRepo.findById(id)
            .switchIfEmpty(Mono.error(new UserNotFoundException(id)))
            .onErrorMap(DataAccessException.class, e -> new ServiceException("db error", e));
    }

    @QueryMapping
    public Mono<Dashboard> dashboard(@AuthenticationPrincipal UserDetails principal) {
        String userId = principal.getUsername();
        return Mono.zip(
                userRepo.findById(userId),
                statsService.stats(userId),
                notificationRepo.findByUserIdAndReadFalse(userId).collectList())
            .map(t -> new Dashboard(t.getT1(), t.getT2(), t.getT3()));
    }

    @BatchMapping(typeName = "User", field = "posts")
    public Mono<Map<User, List<Post>>> posts(List<User> users) {
        List<String> ids = users.stream().map(User::id).toList();
        return postRepo.findByAuthorIdIn(ids)
            .collectList()
            .map(posts -> {
                Map<String, List<Post>> byAuthor = posts.stream()
                    .collect(Collectors.groupingBy(Post::authorId));
                return users.stream().collect(Collectors.toMap(
                    u -> u, u -> byAuthor.getOrDefault(u.id(), List.of())));
            });
    }
}
```

방별 Sink를 유지하는 채팅 Subscription. 인자로 필터링하고 취소·종료 시 활성 구독 수를 계측한다.

```java
@Controller
public class ChatController {

    private final Map<String, Sinks.Many<Message>> rooms = new ConcurrentHashMap<>();
    private final AtomicInteger active = new AtomicInteger();

    @SubscriptionMapping
    @PreAuthorize("isAuthenticated()")
    public Flux<Message> messageReceived(@Argument String roomId) {
        return sink(roomId).asFlux()
            .doOnSubscribe(s -> active.incrementAndGet())
            .doFinally(sig -> active.decrementAndGet())
            .take(Duration.ofMinutes(30));
    }

    @MutationMapping
    public Mono<Message> sendMessage(@Argument String roomId, @Argument String text,
                                     @AuthenticationPrincipal UserDetails user) {
        Message msg = new Message(user.getUsername(), text, Instant.now());
        Sinks.EmitResult result = sink(roomId).tryEmitNext(msg);
        if (result.isFailure()) {
            return Mono.error(new IllegalStateException("emit failed: " + result));
        }
        return Mono.just(msg);
    }

    private Sinks.Many<Message> sink(String roomId) {
        return rooms.computeIfAbsent(roomId,
            k -> Sinks.many().multicast().onBackpressureBuffer(1_000));
    }

    @Bean
    MeterBinder activeSubscriptions() {
        return registry -> Gauge.builder("graphql.subscriptions.active", active::get)
            .register(registry);
    }
}
```

다중 인스턴스 환경에서 Redis Pub/Sub을 브로커로 두는 구성.

```java
@Service
public class PostEvents {

    private final ReactiveRedisTemplate<String, Post> redis;

    public PostEvents(ReactiveRedisTemplate<String, Post> redis) {
        this.redis = redis;
    }

    public Mono<Long> publish(Post post) {
        return redis.convertAndSend("posts", post);
    }

    public Flux<Post> stream() {
        return redis.listenToChannel("posts")
            .map(ReactiveSubscription.Message::getMessage);
    }
}

@Controller
public class PostController {

    private final PostRepository postRepo;
    private final PostEvents events;

    public PostController(PostRepository postRepo, PostEvents events) {
        this.postRepo = postRepo;
        this.events = events;
    }

    @SubscriptionMapping
    public Flux<Post> postCreated(@Argument String category) {
        return events.stream()
            .filter(p -> category == null || category.equals(p.category()));
    }

    @MutationMapping
    public Mono<Post> createPost(@Argument CreatePostInput input) {
        return postRepo.save(Post.from(input))
            .flatMap(saved -> events.publish(saved).thenReturn(saved));
    }
}
```

## 실무에서 걸리는 지점

- **`block()` 혼입.** 한 곳만 `block()`을 호출해도 Netty 이벤트 루프가 멈춘다. 블로킹 라이브러리를 피할 수 없다면 `Schedulers.boundedElastic()`으로 격리하거나 Spring MVC + Virtual Thread를 택한다.
- **트랜잭션 경계.** R2DBC의 `@Transactional`은 `TransactionalOperator`로 동작하지만 MongoDB·Redis·Kafka와 묶이지 않는다. DB 저장과 이벤트 발행을 한 Mutation에서 하면 롤백 후에도 이벤트가 나갈 수 있으므로 Outbox 패턴으로 분리한다.
- **`tryEmitNext` 실패 무시.** 버퍼가 차거나 동시 emit이 겹치면 `EmitResult`가 실패로 돌아오는데, 반환값을 버리면 이벤트가 조용히 사라진다. 결과를 검사하거나 `emitNext`에 `EmitFailureHandler`를 지정한다.
- **구독 인증.** WebSocket은 HTTP 헤더를 연결 시 한 번만 전달하므로 `ConnectionInit` 페이로드의 토큰을 `WebSocketGraphQlInterceptor`에서 검증한다. 다른 사용자의 방을 인자로 넘기는 경우는 리졸버의 `filter`나 `@PreAuthorize`로 메시지 단위 권한을 다시 확인해야 막힌다.
- **연결 수와 메모리.** 구독당 수 KB라 WebSocket 수만 개는 가능하지만 `replay` Sink와 큰 버퍼는 구독자 수만큼 곱해져 힙을 누른다. `take(Duration)`으로 유휴 구독을 정리하고, 방 Sink 맵은 마지막 구독자가 떠날 때 제거하지 않으면 누수가 된다.

## 관련 글

- [GraphQL — Schema·Query·Mutation·Spring for GraphQL](/notes/reactive-spring/graphql-schema-queries/)
- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [GraphQL — DataLoader·Federation·보안·테스트](/notes/reactive-spring/graphql-dataloader-security/)
