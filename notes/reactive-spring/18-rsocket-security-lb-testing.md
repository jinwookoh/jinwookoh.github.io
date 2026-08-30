---
title: "RSocket — 보안·로드 밸런싱·테스트"
series: reactive-spring
part: "RSocket"
order: 18
summary: "영구 연결 프로토콜인 RSocket을 SETUP 인증·TLS·클라이언트 사이드 LB·StepVerifier로 운영 수준까지 끌어올리는 방법"
tags: [RSocket, Spring Security, Load Balancing, StepVerifier, TLS]
sources: [2026-05-03-rsocket-security.md, 2026-05-03-rsocket-load-balancing.md, 2026-05-03-rsocket-testing.md]
updated: 2026-08-29
---

RSocket 서버와 클라이언트를 라우팅까지 붙이고 나면 세 가지 문제가 남는다. 인증 없이 열린 포트는 누구나 아무 라우트를 호출할 수 있고, TLS가 없으면 메타데이터의 토큰과 페이로드가 평문으로 흐른다. 서버를 늘려도 RSocket은 단일 영구 연결을 유지하므로 L4 로드 밸런서 뒤에 두면 처음 붙은 서버에 트래픽이 고정된다. 그리고 `subscribe()`만 호출한 테스트는 비동기 실행이 끝나기 전에 종료되어 아무것도 검증하지 못한다. 이 셋을 Spring Security RSocket, `LoadbalanceRSocketClient`, StepVerifier로 각각 해결한다.

## 핵심 개념

### 인증 시점 — SETUP과 Per-request

HTTP와 다른 점은 인증 시점이 둘이라는 것이다. SETUP 인증은 연결을 맺는 SETUP 프레임의 메타데이터에 자격 증명을 한 번 실어 보내고, 이후 그 연결의 모든 요청이 같은 주체로 취급된다. Per-request 인증은 요청 프레임마다 토큰을 실어 매번 검증한다. 전자가 기본이고, 후자는 민감한 라우트에 추가 검증이 필요할 때 결합해 쓴다.

자격 증명은 Basic(`UsernamePasswordMetadata`)과 Bearer(`BearerTokenMetadata`) 두 형식을 지원하며 각각 전용 MIME 타입으로 보낸다. JWT는 서버가 토큰 자체를 검증하므로 세션 저장소 없이 stateless로 동작하고, `ReactiveJwtDecoders.fromIssuerLocation`으로 OAuth2/OIDC 발급자와 연결하면 Resource Server와 같은 방식이 된다. 암호화는 `spring.rsocket.server.ssl` 속성으로 TLS를 켜고, 서비스 간 통신은 truststore와 `client-auth: need`를 추가해 mTLS로 양쪽 인증서를 검증한다. CORS는 WebSocket 전송에만 해당한다.

### 클라이언트 사이드 로드 밸런싱

HTTP는 요청마다 다른 서버로 보낼 수 있지만 RSocket은 연결이 곧 세션이라 L4 LB가 개입할 지점이 연결 시점 한 번뿐이다. 그래서 클라이언트가 서버 목록을 직접 들고 서버마다 연결 하나씩을 유지하며 요청마다 대상을 고르는 클라이언트 사이드 LB가 표준이다. rsocket-java의 `LoadbalanceRSocketClient`가 이를 구현하며, 서버 목록을 `Flux<List<LoadbalanceTarget>>`로 받으므로 Consul·Eureka·Kubernetes에서 갱신한 목록을 그대로 흘려 넣는다. 끊어진 서버는 후보에서 자동으로 빠진다.

| 전략 | 동작 | 적합한 상황 |
|:---|:---|:---|
| RoundRobin | 순차 분배 | 서버 성능이 균일할 때 |
| WeightedLoadbalanceStrategy | 응답 시간·성공률 기반 동적 가중치 | 성능 편차가 있는 서버군 |
| 커스텀 | `LoadbalanceStrategy` 구현 | 지역·테넌트 기반 선택 |

### 테스트 계층

단위 테스트는 의존성을 Mockito로 대체하고 핸들러가 반환한 Mono/Flux를 StepVerifier로 검증한다. 빠르지만 라우팅·메타데이터·인증은 범위 밖이다. 통합 테스트는 `@SpringBootTest`로 실제 서버를 임의 포트에 띄우고 `@LocalRSocketServerPort`로 포트를 받아 `RSocketRequester`로 종단 간 호출한다. `@WebFluxTest`는 HTTP 슬라이스만 구성하므로 RSocket에 쓸 수 없다. StepVerifier는 구독부터 완료까지를 동기적으로 검증하고, `withVirtualTime`으로 지연 연산자를 대기 없이, 초기 request 수와 `thenRequest`로 backpressure까지 확인한다.

## 코드

라우트별 인가 규칙과 JWT 검증을 묶은 서버 설정이다. `@EnableReactiveMethodSecurity`를 켜면 핸들러에 `@PreAuthorize`를 붙일 수 있다.

```java
@Configuration
@EnableRSocketSecurity
@EnableReactiveMethodSecurity
public class RSocketSecurityConfig {

    @Bean
    PayloadSocketAcceptorInterceptor rsocketSecurity(RSocketSecurity security,
                                                     ReactiveJwtDecoder jwtDecoder) {
        return security
            .authorizePayload(authorize -> authorize
                .setup().authenticated()
                .route("user.public.*").permitAll()
                .route("admin.*").hasRole("ADMIN")
                .anyRequest().authenticated())
            .jwt(jwt -> jwt.authenticationManager(
                new JwtReactiveAuthenticationManager(jwtDecoder)))
            .build();
    }

    @Bean
    ReactiveJwtDecoder jwtDecoder() {
        return ReactiveJwtDecoders.fromIssuerLocation("https://auth.example.com");
    }
}

@Controller
class ProfileController {

    @MessageMapping("user.profile")
    @PreAuthorize("hasRole('USER')")
    Mono<Profile> profile(@AuthenticationPrincipal Jwt jwt) {
        return profileService.findByUsername(jwt.getSubject());
    }
}
```

Service Discovery에서 10초마다 서버 목록을 갱신하고 가중치 전략으로 분배하는 클라이언트다. SETUP 메타데이터에 토큰을 실어 연결마다 한 번 인증한다.

```java
@Configuration
public class UserClientConfig {

    @Bean
    RSocketRequester userRequester(ReactiveDiscoveryClient discovery,
                                   RSocketStrategies strategies,
                                   TokenProvider tokens) {
        Flux<List<LoadbalanceTarget>> targets = Flux.interval(Duration.ZERO, Duration.ofSeconds(10))
            .flatMap(tick -> discovery.getInstances("user-service")
                .map(inst -> LoadbalanceTarget.from(
                    inst.getInstanceId(),
                    TcpClientTransport.create(inst.getHost(), inst.getPort())))
                .collectList());

        LoadbalanceRSocketClient client = LoadbalanceRSocketClient
            .builder(targets)
            .loadbalanceStrategy(WeightedLoadbalanceStrategy.create())
            .build();

        return RSocketRequester.builder()
            .rsocketStrategies(strategies)
            .setupMetadata(new BearerTokenMetadata(tokens.current()),
                           BearerTokenMetadata.BEARER_AUTHENTICATION_MIME_TYPE)
            .rsocketClient(client);
    }
}
```

임베디드 서버에 대해 인증 실패와 backpressure를 검증하는 통합 테스트다. 인증 없는 SETUP은 `RejectedSetupException`으로 거절된다.

```java
@SpringBootTest(properties = "spring.rsocket.server.port=0")
class UserRSocketIntegrationTest {

    @LocalRSocketServerPort int port;
    @Autowired RSocketRequester.Builder builder;

    @Test
    void setupWithoutCredentialsIsRejected() {
        RSocketRequester anonymous = builder.tcp("localhost", port);

        StepVerifier.create(anonymous.route("user.list").retrieveFlux(User.class))
            .expectError(RejectedSetupException.class)
            .verify(Duration.ofSeconds(5));
    }

    @Test
    void streamHonorsBackpressure() {
        RSocketRequester requester = builder
            .setupMetadata(new UsernamePasswordMetadata("alice", "pass"),
                           UsernamePasswordMetadata.BASIC_AUTHENTICATION_MIME_TYPE)
            .tcp("localhost", port);

        StepVerifier.create(
                requester.route("stream.numbers").data(100).retrieveFlux(Integer.class).take(10), 1)
            .expectNext(0)
            .thenRequest(9)
            .expectNextCount(9)
            .verifyComplete();

        requester.dispose();
    }
}
```

## 실무에서 걸리는 지점

- **SETUP 인증과 토큰 만료.** SETUP에서 검증한 JWT는 연결이 살아 있는 동안 다시 검사되지 않는다. 장시간 유지되는 연결에서는 만료된 토큰으로도 요청이 통과하므로, 민감 라우트에 Per-request 검증을 두거나 서버가 주기적으로 연결을 끊어 재인증을 강제한다.
- **Resume과 LB는 양립하지 않는다.** Resume 토큰은 원래 연결을 받았던 서버에서만 유효하다. 페일오버로 다른 서버에 붙으면 새 연결이 되므로 둘 중 하나를 고른다.
- **목록 갱신 지연.** Service Discovery 폴링 간격이 길면 내려간 서버가 목록에 남아 재시도 비용이 든다. 5~30초가 일반적이며, 재시도와 타임아웃을 반드시 같이 건다.
- **Sticky 라우팅의 비용.** 세션 상태를 서버 메모리에 두면 사용자별로 같은 서버에 붙여야 하고 그 서버 장애가 해당 사용자에게 전가된다. 상태를 외부 저장소로 빼고 stateless로 간다.
- **테스트의 연결 정리.** `RSocketRequester`를 테스트마다 `dispose()`로 닫지 않으면 임베디드 서버에 연결이 누적된다. 성능 테스트는 별도 태그로 분리해 CI에서 제외한다.

## 관련 글

- [RSocket — 개념·프레임·Interaction Model](/notes/reactive-spring/rsocket-concepts/)
- [RSocket — 서버·클라이언트·메타데이터 라우팅](/notes/reactive-spring/rsocket-server-client/)
- [Repeat·Retry와 StepVerifier](/notes/reactive-spring/retry-stepverifier/)
