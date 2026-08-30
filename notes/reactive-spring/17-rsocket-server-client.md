---
title: "RSocket — 서버·클라이언트·메타데이터 라우팅"
series: reactive-spring
part: "RSocket"
order: 17
summary: "Spring에서 @MessageMapping 서버와 RSocketRequester 클라이언트를 만들고 라우트·인증·trace를 Composite Metadata로 싣는 방법"
tags: [RSocket, MessageMapping, RSocketRequester, Composite Metadata, Spring Boot]
sources: [2026-05-03-rsocket-server.md, 2026-05-03-rsocket-client.md, 2026-05-03-rsocket-metadata.md]
updated: 2026-08-29
---

RSocket 프로토콜은 프레임과 네 가지 Interaction Model만 정의한다. 요청이 어느 핸들러로 가는지, 인증 토큰을 어디에 실을지는 프로토콜 밖의 일이다. 직접 구현하면 라우트 파싱·인코더·연결 관리 코드가 서비스마다 중복되고, 양쪽 규약이 어긋나는 순간 통신이 깨진다. ==Spring의 `@MessageMapping`과 `RSocketRequester`는 이 규약을 메타데이터 MIME Type 기준으로 표준화한다.==

## 핵심 개념

### 서버 — 반환 타입이 Interaction Model을 정한다

`spring-boot-starter-rsocket`과 `spring.rsocket.server.port`만으로 서버가 뜬다. 핸들러는 `@Controller` 클래스의 `@MessageMapping` 메서드이며, 모델은 입력·반환 타입에서 추론된다.

| 시그니처 | Interaction Model |
|:---|:---|
| `Mono<T>` 반환 | Request-Response |
| `Mono<Void>` 반환 | Fire-and-Forget |
| 단일 입력, `Flux<T>` 반환 | Request-Stream |
| `Flux<In>` 입력, `Flux<Out>` 반환 | Channel |

==라우트 구분자는 `/`가 아니라 `.`이다.== `user.{id}` 패턴 변수는 `@DestinationVariable`로 받고, `admin.**` 와일드카드와 클래스 레벨 prefix도 지원한다. 애노테이션 없는 인자가 페이로드, `@Header`가 메타데이터 단일 항목, `@Headers`가 전체 Map, `RSocketRequester` 인자가 현재 연결의 상대방을 호출하는 핸들이다.

예외는 `@MessageExceptionHandler`(컨트롤러)와 `@ControllerAdvice`(전역)로 잡는다. 핸들러의 반환값은 정상 응답이 되고, 핸들러가 없으면 ERROR 프레임으로 내려간다. SETUP 프레임은 `@ConnectMapping`이 받으며, 인증은 여기서 한 번만 검증한다.

### 클라이언트 — RSocketRequester는 싱글턴

Spring Boot는 `RSocketStrategies`가 반영된 `RSocketRequester.Builder`를 자동 구성한다. `tcp(host, port)` 또는 `websocket(URI)`로 만든 requester는 첫 요청 시점에 연결을 연다. `retrieveMono`가 Request-Response, `retrieveFlux`가 Request-Stream과 Channel(입력이 `Flux`일 때), `send`가 Fire-and-Forget에 대응한다.

requester는 연결 하나와 그 위의 다중화 스트림을 감싸므로 Bean으로 재사용하고, `rsocketConnector(c -> c.reconnect(Retry...))`로 끊긴 연결을 같은 인스턴스가 다시 열게 한다. 클라이언트가 자신의 `@MessageMapping` 컨트롤러를 `RSocketMessageHandler.responder()`로 acceptor에 등록하면 서버가 클라이언트 라우트를 호출하는 양방향 RPC가 된다.

### 메타데이터 — MIME Type 기반 Composite

HTTP 헤더가 키-값 목록인 것과 달리 RSocket 메타데이터는 MIME Type이 종류를 식별한다. 라우트는 `message/x.rsocket.routing.v0`, 인증은 `message/x.rsocket.authentication.v0`, Zipkin trace는 `message/x.rsocket.tracing-zipkin.v0`이며, 한 프레임에 여러 항목을 실으려면 `message/x.rsocket.composite-metadata.v0`로 묶는다. Spring Boot의 기본값이 이 Composite이다.

`route()`는 routing 항목을 자동으로 추가하고, `.metadata(value, mimeType)` 호출마다 항목이 더해진다. 커스텀 항목을 서버 `@Header`로 꺼내려면 `RSocketStrategies`의 `metadataExtractorRegistry`에 MIME Type과 추출 이름을 등록해야 한다.

## 코드

라우트 패턴·예외 처리·SETUP 인증을 포함한 서버 컨트롤러.

```java
@Controller
@MessageMapping("user")
public class UserController {

    private final UserRepository userRepository;
    private final TokenService tokenService;

    public UserController(UserRepository userRepository, TokenService tokenService) {
        this.userRepository = userRepository;
        this.tokenService = tokenService;
    }

    @ConnectMapping
    public Mono<Void> onConnect(RSocketRequester requester, @Payload String token) {
        return tokenService.verify(token)
            .switchIfEmpty(Mono.error(new AuthenticationException("invalid setup token")))
            .then();
    }

    @MessageMapping("{id}")                                   // user.{id}
    public Mono<User> get(@DestinationVariable String id,
                          @Header("tenant") String tenant) {
        return userRepository.findByIdAndTenant(id, tenant)
            .switchIfEmpty(Mono.error(new UserNotFoundException(id)));
    }

    @MessageMapping("watch")                                  // user.watch
    public Flux<UserEvent> watch(UserFilter filter) {
        return userRepository.streamEvents(filter);
    }

    @MessageMapping("sync")                                   // user.sync — Channel
    public Flux<SyncAck> sync(Flux<SyncCommand> commands) {
        return commands.flatMap(userRepository::apply);
    }

    @MessageExceptionHandler(UserNotFoundException.class)
    public Mono<ErrorResponse> handleNotFound(UserNotFoundException e) {
        return Mono.just(new ErrorResponse("NOT_FOUND", e.getMessage()));
    }
}
```

커스텀 메타데이터 추출과 인증 인코더 등록. 서버와 클라이언트 양쪽에 같은 설정이 필요하다.

```java
@Configuration
public class RSocketStrategiesConfig {

    @Bean
    public RSocketStrategiesCustomizer rsocketStrategiesCustomizer() {
        return strategies -> strategies
            .encoder(new SimpleAuthenticationEncoder())
            .metadataExtractorRegistry(registry ->
                registry.metadataToExtract(MimeTypeUtils.TEXT_PLAIN, String.class, "tenant"));
    }
}
```

재연결·keepalive·SETUP 페이로드를 설정한 싱글턴 requester로 네 가지 모델을 호출하는 클라이언트.

```java
@Service
public class UserClient {

    private final RSocketRequester requester;

    public UserClient(RSocketRequester.Builder builder,
                      @Value("${user-service.setup-token}") String setupToken) {
        this.requester = builder
            .setupData(setupToken)
            .rsocketConnector(connector -> connector
                .keepAlive(Duration.ofSeconds(20), Duration.ofSeconds(90))
                .reconnect(Retry.backoff(Long.MAX_VALUE, Duration.ofSeconds(1))
                    .maxBackoff(Duration.ofSeconds(30))))
            .tcp("user-service", 7000);
    }

    public Mono<User> get(String id, String tenant) {
        return requester.route("user.{id}", id)
            .metadata(tenant, MimeTypeUtils.TEXT_PLAIN)
            .retrieveMono(User.class)
            .timeout(Duration.ofSeconds(5));
    }

    public Flux<UserEvent> watch(UserFilter filter) {
        return requester.route("user.watch")
            .data(filter)
            .retrieveFlux(UserEvent.class);
    }

    public Flux<SyncAck> sync(Flux<SyncCommand> commands) {
        return requester.route("user.sync")
            .data(commands)
            .retrieveFlux(SyncAck.class);
    }

    public Mono<Void> audit(AuditEvent event) {
        return requester.route("audit.log")
            .data(event)
            .send();
    }
}
```

## 실무에서 걸리는 지점

- ==**시그니처 불일치는 컴파일 타임에 잡히지 않는다.**== 서버가 `Flux`인데 클라이언트가 `retrieveMono`를 쓰면 첫 요소 이후 취소된다. 라우트별 모델을 문서화해야 한다.
- **requester를 요청마다 생성하면 연결 비용이 폭발한다.** 매번 TCP 연결과 SETUP 핸드셰이크가 발생한다. Bean 하나로 두고 `dispose()`는 종료 시에만 부른다.
- **RSocket에는 요청 타임아웃이 없다.** keepalive는 연결 생존만 확인하므로 요청마다 Reactor `timeout()`을 붙인다.
- **메타데이터는 평문이다.** 인증 토큰이 프레임에 그대로 실리므로 `spring.rsocket.server.ssl` 또는 mTLS 없이는 노출된다.
- **커스텀 메타데이터는 extractor 등록이 없으면 조용히 사라진다.** 서버 `@Header`가 null이 되며 에러는 나지 않는다. `RSocketStrategies` 설정은 공유 모듈로 관리한다.

## 관련 글

- [RSocket — 개념·프레임·Interaction Model](/notes/reactive-spring/rsocket-concepts/)
- [RSocket — 보안·로드 밸런싱·테스트](/notes/reactive-spring/rsocket-security-lb-testing/)
