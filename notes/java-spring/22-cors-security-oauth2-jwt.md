---
title: "CORS와 Spring Security — OAuth2·JWT"
series: java-spring
part: "Web MVC"
order: 22
summary: "CORS 허용 헤더, SecurityFilterChain 인증·인가, 그리고 JWT를 공개 키로 검증하는 OAuth2 Resource Server 구성을 정리한다."
tags: [CORS, Spring Security, OAuth2, JWT, SecurityFilterChain]
sources: [spring/2026-05-17-cors-configuration.md, spring/2026-05-17-spring-security-basics.md, 2026-05-02-spring-security.md]
updated: 2026-08-29
---

프론트엔드와 백엔드가 다른 Origin에서 서비스되면 서버가 허용 헤더를 명시하지 않는 한 브라우저가 응답을 자바스크립트에 전달하지 않는다. 반대로 서버 쪽 보호가 없으면 URL을 아는 누구나 엔드포인트를 호출할 수 있다. 두 문제는 같은 필터 체인 위에서 해결되며, 따로 설정하면 OPTIONS 요청이 인증에 막히는 식으로 충돌한다.

## 핵심 개념

**Origin**은 프로토콜·호스트·포트의 조합이다. 하나라도 다르면 다른 Origin이며, `localhost:3000`과 `localhost:8080`도 교차 출처다. CORS는 브라우저 정책이므로 서버 간 호출이나 모바일 앱에는 적용되지 않는다.

POST + JSON, PUT, DELETE, 커스텀 헤더처럼 단순 요청이 아니면 브라우저는 본 요청 전에 `OPTIONS` **preflight**를 보낸다. 서버는 `Access-Control-Allow-Origin`, `-Methods`, `-Headers`, `-Credentials` 헤더로 응답하고, 브라우저는 `Access-Control-Max-Age` 동안 결과를 캐시한다.

Spring Security는 **SecurityFilterChain** Bean으로 구성한 서블릿 필터 묶음이다. 요청은 CorsFilter, CsrfFilter, 인증 필터, AuthorizationFilter 순으로 통과한 뒤 DispatcherServlet에 도달한다. **인증(Authentication)**은 누구인지 확인하는 단계, **인가(Authorization)**는 그 주체가 자원에 접근할 수 있는지 판단하는 단계다. 인증 결과는 `SecurityContextHolder`에 저장되고 컨트롤러에서는 `@AuthenticationPrincipal`로 꺼낸다. Spring Security 6부터 `WebSecurityConfigurerAdapter`는 제거되었고 람다 DSL로만 설정한다.

**OAuth2**는 비밀번호 대신 발급된 토큰으로 자원에 접근하는 프로토콜이며 네 역할로 구성된다.

| 역할 | 책임 |
|---|---|
| Resource Owner | 자원의 소유자, 보통 사용자 |
| Client | 자원에 접근하려는 애플리케이션 |
| Authorization Server | 토큰 발급, 공개 키 제공 (`/oauth2/jwks`) |
| Resource Server | 토큰을 검증하고 보호된 API를 제공 |

서버 간 통신은 Client Credentials, 사용자 로그인은 Authorization Code(+ PKCE) 흐름을 쓴다. Implicit과 Password 흐름은 폐기되었다.

**JWT**는 `header.payload.signature` 세 부분을 Base64Url로 인코딩한 토큰이다. payload는 누구나 디코딩할 수 있으므로 비밀 정보를 넣지 않는다. Authorization Server가 개인 키로 서명하고 Resource Server는 JWKS에서 받아 캐시한 공개 키로 검증하므로 요청마다 인증 서버에 질의하지 않는다. 이것이 stateless 검증의 근거다.

## 코드

Spring Security가 있으면 `WebMvcConfigurer`의 CORS 매핑은 Security 필터보다 뒤에 적용되므로, `CorsConfigurationSource` Bean을 등록해 필터 체인의 `cors()`에 연결한다.

```java
@Configuration
public class CorsConfig {

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOriginPatterns(List.of("http://localhost:[*]", "https://*.myshop.com"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setAllowCredentials(true);
        config.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

REST API용 필터 체인이다. 세션과 CSRF를 끄고, preflight는 인증 없이 통과시키며, JWT 검증은 `oauth2ResourceServer`에 맡긴다. `issuer-uri` 한 줄이면 기동 시 `/.well-known/openid-configuration`을 조회해 공개 키 위치를 찾는다.

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
                                           CorsConfigurationSource corsConfigurationSource) throws Exception {
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource))
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                .requestMatchers("/api/public/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }
}
```

```properties
spring.security.oauth2.resourceserver.jwt.issuer-uri=http://localhost:9000
```

메서드 단위 인가와 테스트다. `@PreAuthorize`는 AOP 프록시로 동작하며 SpEL로 principal과 인자를 함께 검사한다. 테스트는 `spring-security-test`의 `jwt()`로 인증 서버 없이 토큰을 대신한다.

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public void delete(@PathVariable Long id) { ... }

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_order.read') and #id == authentication.name")
    public Order get(@PathVariable Long id, @AuthenticationPrincipal Jwt jwt) { ... }
}

@Test
void listOrdersWithJwt() throws Exception {
    mockMvc.perform(get("/api/orders")
                .with(jwt().jwt(t -> t.subject("client1").claim("scope", "order.read"))))
           .andExpect(status().isOk());
}

@Test
void tamperedTokenIsRejected() throws Exception {
    mockMvc.perform(get("/api/orders")
                .header(HttpHeaders.AUTHORIZATION, "Bearer invalid.jwt.token"))
           .andExpect(status().isUnauthorized());
}
```

## 실무에서 걸리는 지점

- **`allowedOrigins("*")`와 `allowCredentials(true)`는 함께 쓸 수 없다.** 자격 증명 요청에는 와일드카드 응답이 무효다. 환경별 도메인이 많으면 `allowedOriginPatterns`를 쓰되 운영에서는 정확한 도메인만 남긴다.
- **preflight가 인증 필터에 막히면 모든 변경 요청이 실패한다.** OPTIONS 요청에는 Authorization 헤더가 없으므로 `permitAll()`로 명시하고 `http.cors()`로 CorsFilter를 인증 필터 앞에 둔다.
- **프록시·CDN 뒤에서 CORS 헤더가 이중으로 붙는다.** nginx나 CloudFront가 이미 헤더를 추가하면 브라우저는 중복 값을 거부한다. 헤더를 붙이는 계층은 하나만 둔다.
- **폼 기반 세션 앱에서 CSRF를 끄면 안 된다.** CSRF 비활성화는 토큰을 헤더로 보내는 stateless API에만 유효하며, 쿠키에 JWT를 담아 자동 전송하면 다시 CSRF 대상이 된다.
- **Resource Server는 기동 시 인증 서버에 접속한다.** 인증 서버가 내려가 있으면 `Unable to resolve the Configuration with the provided Issuer`로 부팅이 실패하고, `issuer-uri` 오타는 모든 요청을 401로 만든다. 기동 순서를 맞추고, 서명 키 교체 시에는 `kid`가 다른 새 키를 먼저 JWKS에 추가한 뒤 구 키를 제거한다.

## 관련 글

- [요청 처리 흐름 — Filter·Interceptor](/notes/java-spring/dispatcher-servlet-filter-interceptor/)
- [AOP와 SpEL](/notes/java-spring/aop-spel/)
- [테스트 — MockMvc·Testcontainers](/notes/java-spring/testing-mockmvc-testcontainers/)
