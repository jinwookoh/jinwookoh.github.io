---
title: "API Gateway·JWT·OAuth2 인증"
series: sns-project
part: "인증"
order: 2
summary: "게이트웨이 한 곳에서 JWT를 검증하고 User Service가 토큰 발급·OAuth2 매핑을 맡는 stateless 인증 구조를 정리한다."
tags: [Spring Cloud Gateway, JWT, OAuth2, Spring Security, Redis]
sources: [2026-05-04-javaex-sns-api-gateway-jwt.md, 2026-05-04-javaex-sns-user-oauth2.md]
updated: 2026-08-29
---

서비스가 User·Post·Notification 세 개로 나뉘면 인증 위치가 먼저 결정돼야 한다. 각 서비스가 따로 토큰을 검증하면 검증 로직과 비밀키가 세 곳에 복제되고 공개 경로 정책이 어긋난다. 세션 기반으로 가면 세션 저장소를 공유해야 하므로 수평 확장이 어렵다. ==이 프로젝트는 API Gateway 한 곳에서 JWT를 검증하고, 검증된 사용자 ID를 내부 헤더로 넘기며, 토큰 발급과 OAuth2 연동은 User Service가 전담하는 구조를 택한다.==

## 핵심 개념

게이트웨이는 Spring Cloud Gateway 위에서 동작하며 내부적으로 WebFlux와 Netty 이벤트 루프를 쓴다. 요청 한 건당 스레드 하나를 배정하는 Spring MVC와 달리 소수의 이벤트 루프 스레드가 많은 동시 요청을 처리하므로, ==필터 안의 모든 외부 호출은 리액티브여야 한다.== Redis 조회에 `StringRedisTemplate`을 쓰거나 `.block()`을 걸면 그 스레드에 배정된 다른 요청까지 함께 멈춘다.

게이트웨이의 `GlobalFilter`는 요청마다 다음 순서로 동작한다. 공개 경로인지 확인하고, `Authorization: Bearer <token>` 헤더에서 토큰을 꺼내고, HMAC 서명과 만료를 검증하고, 클레임의 `jti`가 Redis 블랙리스트에 있는지 조회한 뒤, `X-User-Id`·`X-User-Email` 헤더를 주입해 경로 조건에 따라 하위 서비스로 라우팅한다. 서명 검증과 블랙리스트 조회는 서로 다른 문제를 막는다. 서명 검증은 위조·만료를 걸러내지만, 한 번 발급된 JWT는 만료 전까지 서버가 무효화할 수 없다. 로그아웃 시 `jti`를 Redis에 등재하고 TTL을 토큰의 남은 만료 시간으로 잡으면, 만료 이후에는 서명 검증에서 걸러지므로 키가 자동 삭제돼도 문제가 없다.

토큰은 두 종류로 나눈다.

| 토큰 | 만료 | 클레임 | 검증 위치 |
|---|---|---|---|
| Access Token | 15분 | jti, sub(userId), email, iat, exp | 게이트웨이, 매 요청 |
| Refresh Token | 7일 | sub(userId) | User Service `/v1/users/refresh` |

권한이 큰 Access Token은 짧게, 재발급 전용인 Refresh Token은 길게 두어 한쪽이 유출돼도 피해 범위를 줄인다. Refresh Token은 SHA-256 해시로 DB에 저장하고 갱신 요청 시 받은 토큰을 다시 해싱해 비교한다. 비밀번호에는 BCrypt를 쓰지만, Refresh Token은 이미 긴 랜덤 값이라 솔트와 느린 연산이 불필요하므로 SHA-256으로 충분하다.

OAuth2 로그인은 Spring Security의 `oauth2Login()`이 인가 코드 교환, redirect_uri 검증, 콜백 처리를 맡는다. 직접 작성하는 부분은 두 클래스다. `CustomOAuth2UserService`는 제공자에게서 받은 프로필로 `users` 테이블에서 사용자를 찾거나 `provider=GOOGLE`로 새로 만들고, `OAuth2SuccessHandler`는 그 사용자에게 로컬 로그인과 같은 방식으로 JWT를 발급해 프론트엔드로 리다이렉트한다. OAuth2 사용자도 같은 테이블에 저장하므로 `password_hash`는 NULL 허용이다.

## 코드

게이트웨이의 인증 필터. 서명 검증은 동기 연산이지만 Redis 조회는 `ReactiveStringRedisTemplate`로 처리하고, 인증에 성공하면 헤더를 주입한 exchange로 체인을 이어간다.

```java
@Component
@RequiredArgsConstructor
public class JwtAuthenticationFilter implements GlobalFilter, Ordered {

    private final ReactiveStringRedisTemplate redisTemplate;
    private final SecretKey secretKey;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        var request = exchange.getRequest();
        if (isPublic(request.getMethod(), request.getPath().value())) {
            return chain.filter(exchange);
        }

        String authHeader = request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            return unauthorized(exchange);
        }

        Claims claims;
        try {
            claims = Jwts.parser()
                    .verifyWith(secretKey)
                    .build()
                    .parseSignedClaims(authHeader.substring(7))
                    .getPayload();
        } catch (JwtException e) {
            return unauthorized(exchange);
        }

        String jti = claims.getId();
        String userId = claims.getSubject();
        String email = claims.get("email", String.class);

        return redisTemplate.hasKey("session:blacklist:" + jti)
                .flatMap(blacklisted -> {
                    if (Boolean.TRUE.equals(blacklisted)) {
                        return unauthorized(exchange);
                    }
                    ServerWebExchange mutated = exchange.mutate()
                            .request(r -> r.header("X-User-Id", userId)
                                           .header("X-User-Email", email))
                            .build();
                    return chain.filter(mutated);
                });
    }

    private Mono<Void> unauthorized(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        return exchange.getResponse().setComplete();
    }

    @Override
    public int getOrder() {
        return -1;
    }
}
```

User Service의 토큰 발급. 로그인·회원가입·갱신이 모두 이 메서드를 거치며, 기존 Refresh Token을 지워 사용자당 하나만 유지한다.

```java
private TokenResponse issueTokens(User user) {
    refreshTokenRepository.deleteByUserId(user.getId());

    long now = System.currentTimeMillis();
    String accessToken = Jwts.builder()
            .id(UUID.randomUUID().toString())
            .subject(String.valueOf(user.getId()))
            .claim("email", user.getEmail())
            .issuedAt(new Date(now))
            .expiration(new Date(now + accessTokenExpiryMs))
            .signWith(secretKey)
            .compact();
    String refreshToken = jwtProvider.generateRefreshToken(user.getId());

    refreshTokenRepository.save(RefreshToken.builder()
            .userId(user.getId())
            .tokenHash(sha256(refreshToken))
            .expiresAt(LocalDateTime.now().plusDays(7))
            .build());

    return new TokenResponse(accessToken, refreshToken, user.getId(), user.getNickname());
}
```

User Service의 Spring Security 설정. 세션을 만들지 않고, OAuth2 진입·콜백 경로와 서비스 간 내부 경로를 열어 둔다.

```java
@Bean
SecurityFilterChain securityFilterChain(HttpSecurity http,
                                        CustomOAuth2UserService oAuth2UserService,
                                        OAuth2SuccessHandler successHandler) throws Exception {
    return http
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                    .requestMatchers("/v1/users/register", "/v1/users/login", "/v1/users/refresh",
                                     "/v1/users/oauth2/**", "/login/oauth2/**",
                                     "/internal/**").permitAll()
                    .anyRequest().authenticated())
            .oauth2Login(oauth2 -> oauth2
                    .userInfoEndpoint(u -> u.userService(oAuth2UserService))
                    .successHandler(successHandler))
            .build();
}
```

## 실무에서 걸리는 지점

- **서명 키 디코딩 불일치.** `jwt.secret`은 Base64로 인코딩된 값이므로 게이트웨이와 User Service 모두 `Keys.hmacShaKeyFor(Decoders.BASE64.decode(secret))`로 키를 만들어야 한다. ==한쪽이 `getBytes()`를 쓰면 로그인은 성공하고 이후 모든 요청이 401로 떨어진다.==
- **필터 체인 누락.** `GlobalFilter`는 성공 경로에서 반드시 `chain.filter(...)`를 반환해야 한다. 빠뜨리면 클라이언트가 무한 대기한다.
- **공개 경로 목록 관리.** 회원가입·로그인·토큰 갱신·게시물 조회·OAuth2 경로가 목록에서 빠지면 토큰 없이는 토큰을 받을 수 없는 순환이 생긴다. 특히 `/v1/users/oauth2/**`와 `/login/oauth2/**`는 둘 다 열려야 콜백에서 401이 나지 않는다.
- **내부 헤더 위조.** 하위 서비스는 `X-User-Id`를 신뢰하므로 서비스 포트를 외부에 노출하면 헤더만 붙여 인증을 우회할 수 있다. 게이트웨이만 외부에 열고 나머지는 보안 그룹이나 NetworkPolicy로 사설망에 묶는다. `/internal/**`이 `permitAll()`인 것도 같은 전제 위에서만 안전하다.
- **로그인 실패 메시지 분리.** 이메일 없음과 비밀번호 불일치를 다른 문구로 돌려주면 가입 여부를 하나씩 확인하는 User Enumeration이 가능해진다. 두 경우 모두 같은 문구와 같은 상태 코드로 응답한다.
- **Redis 가용성.** 블랙리스트를 도입하면 매 요청이 Redis에 의존하므로 단일 인스턴스 장애가 게이트웨이 전체 장애로 번진다. Sentinel이나 Cluster 구성이 전제다.

## 관련 글

- [서비스 분해와 아키텍처](/notes/sns-project/microservices-architecture/)
- [게시물 서비스 — Redisson 분산 락과 동시성](/notes/sns-project/post-service-distributed-lock/)
- [Kafka 이벤트 흐름·Outbox·Redis 활용 패턴](/notes/sns-project/kafka-outbox-redis-patterns/)
