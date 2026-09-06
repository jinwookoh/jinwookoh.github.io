---
title: "인증 상태 관리 — 세션과 JWT"
series: architecture-patterns
part: "API·운영"
order: 22
summary: "세션은 서버가 상태를 쥐어 즉시 회수하고, JWT는 서명 검증만으로 확장하되 회수 불가를 리프레시 토큰으로 보완한다"
tags: [Session, JWT, Spring Security, Refresh Token, Stateless]
sources: [https://jinwookoh.tistory.com/248]
updated: 2026-09-06
---

HTTP는 요청 사이에 아무것도 기억하지 않는다. 로그인에 성공했더라도 다음 요청은 이전 요청과 무관한 새 연결이므로, 서버는 "이 요청을 보낸 주체가 방금 인증된 그 사용자"라는 사실을 별도 장치로 이어 붙여야 한다. 이 장치가 없으면 매 요청마다 자격 증명을 다시 보내야 한다. 상태를 서버가 보관하느냐(세션), 클라이언트가 들고 다니느냐(토큰)에 따라 확장 방식, 강제 로그아웃 가능 여부, 저장소 구성이 달라진다.

## 핵심 개념

세션 기반 인증은 서버가 인증 결과를 저장소에 보관하고 클라이언트에는 그 항목을 가리키는 식별자만 준다. 로그인이 성공하면 서버가 무작위 세션 ID를 만들어 `Set-Cookie: JSESSIONID=...`로 내려주고, 이후 요청은 쿠키의 ID로 저장소를 조회해 주체를 복원한다. Spring Security는 별도 설정이 없으면 이 방식으로 동작하며 `SecurityContext`를 `HttpSession`에 저장한다. 클라이언트가 가진 값은 의미 없는 난수이고, 서버가 저장소에서 항목을 지우는 순간 해당 사용자는 즉시 로그아웃된다. ==로드 밸런서 뒤에 인스턴스가 두 대 이상이면 세션 저장소를 Redis 같은 외부 저장소로 옮기거나 스티키 세션을 걸지 않는 한 요청이 다른 인스턴스로 갈 때마다 로그인이 풀린다.==

JWT는 `header.payload.signature` 세 부분을 base64url로 인코딩해 점으로 이은 문자열이다. 서버는 주체와 권한, 만료 시각(`exp`)을 payload에 넣고 비밀키(HS256) 또는 개인키(RS256·ES256)로 서명한다. 검증 측은 서명과 만료만 확인하므로 저장소 조회 없이 요청을 처리할 수 있고, 인스턴스를 늘려도 공유할 상태가 없다. ==payload는 암호화가 아니라 인코딩이므로 토큰을 가진 누구나 디코딩해 읽을 수 있고, 개인정보를 넣으면 그대로 노출된다.== 반대로 발급된 토큰은 `exp`가 지나기 전에는 무효화할 방법이 없다.

회수 불가는 액세스 토큰과 리프레시 토큰의 분리로 보완한다. 액세스 토큰은 JWT로 짧게(수 분에서 수십 분) 발급하고 상태 없이 검증한다. 리프레시 토큰은 불투명한 난수로 길게(수 일에서 수 주) 발급하되 서버 저장소에 기록한다. 액세스 토큰이 만료되면 클라이언트가 리프레시 토큰으로 재발급을 요청하고, 서버는 이때만 저장소를 조회해 차단 여부를 판단한다. 강제 로그아웃은 저장소의 리프레시 토큰을 지우는 것으로 구현되며, 반영 지연은 액세스 토큰의 남은 수명만큼이다.

| 구분 | 세션 | JWT |
|---|---|---|
| 상태 위치 | 서버 저장소 | 클라이언트 |
| 요청당 비용 | 저장소 조회 1회 | 서명 검증(CPU) |
| 수평 확장 | 공유 저장소 필요 | 추가 구성 없음 |
| 즉시 회수 | 가능 | 불가(만료 대기) |
| 전송 크기 | 수십 바이트 | 수백 바이트 이상 |
| 적합한 환경 | 단일 도메인 웹, 관리자 콘솔 | 모바일 앱, 다중 서비스, 게이트웨이 뒤 |

## 코드

세션 방식에서 인스턴스 간 세션을 공유하려면 Spring Session을 붙인다. 의존성 `spring-session-data-redis`를 추가하고 저장소 종류만 지정하면 `HttpSession` 구현이 Redis로 바뀐다.

```yaml
spring:
  session:
    store-type: redis
    timeout: 30m
  data:
    redis:
      host: redis.internal
server:
  servlet:
    session:
      cookie:
        http-only: true
        secure: true
        same-site: lax
```

세션 방식의 `SecurityFilterChain`이다. 로그인 시 세션 ID를 교체해 세션 고정 공격을 막고, 계정당 동시 세션 수를 제한한다.

```java
@Configuration
@EnableWebSecurity
public class SessionSecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/login", "/css/**").permitAll()
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .sessionManagement(session -> session
                .sessionFixation(SessionManagementConfigurer.SessionFixationConfigurer::changeSessionId)
                .maximumSessions(1)
                .maxSessionsPreventsLogin(false));
        return http.build();
    }
}
```

JWT 방식은 Spring Boot 3의 리소스 서버 지원을 사용한다. `spring-boot-starter-oauth2-resource-server`를 추가하고 `NimbusJwtDecoder`를 등록하면 `Authorization: Bearer` 헤더를 자동으로 검증한다. 세션 생성 정책은 `STATELESS`로 두어 서버가 상태를 만들지 않게 한다.

```java
@Configuration
@EnableWebSecurity
public class JwtSecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/auth/**").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder(RSAPublicKey publicKey) {
        return NimbusJwtDecoder.withPublicKey(publicKey)
            .signatureAlgorithm(SignatureAlgorithm.RS256)
            .build();
    }
}
```

액세스 토큰 발급과 리프레시 토큰 회전이다. 리프레시 토큰은 해시로 저장하고, 한 번 사용된 토큰이 다시 제출되면 탈취로 간주해 해당 사용자의 리프레시 토큰을 모두 폐기한다.

```java
@Service
public class TokenService {

    private static final Duration ACCESS_TTL = Duration.ofMinutes(15);
    private static final Duration REFRESH_TTL = Duration.ofDays(14);

    private final JwtEncoder jwtEncoder;
    private final RefreshTokenRepository refreshTokens;
    private final RoleService roleService;

    public TokenService(JwtEncoder jwtEncoder, RefreshTokenRepository refreshTokens, RoleService roleService) {
        this.jwtEncoder = jwtEncoder;
        this.refreshTokens = refreshTokens;
        this.roleService = roleService;
    }

    public TokenPair issue(String userId, List<String> roles) {
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
            .issuer("https://auth.example.com")
            .subject(userId)
            .issuedAt(now)
            .expiresAt(now.plus(ACCESS_TTL))
            .claim("roles", roles)
            .build();
        String access = jwtEncoder.encode(JwtEncoderParameters.from(claims)).getTokenValue();

        String refresh = UUID.randomUUID().toString();
        refreshTokens.save(new RefreshToken(sha256(refresh), userId, now.plus(REFRESH_TTL)));
        return new TokenPair(access, refresh);
    }

    @Transactional
    public TokenPair rotate(String presentedRefresh) {
        RefreshToken stored = refreshTokens.findByHash(sha256(presentedRefresh))
            .orElseThrow(() -> new InvalidTokenException("unknown refresh token"));

        if (stored.isUsed()) {
            refreshTokens.deleteAllByUserId(stored.userId());
            throw new InvalidTokenException("refresh token reuse detected");
        }
        if (stored.expiresAt().isBefore(Instant.now())) {
            throw new InvalidTokenException("refresh token expired");
        }
        stored.markUsed();
        return issue(stored.userId(), roleService.rolesOf(stored.userId()));
    }
}
```

## 실무에서 걸리는 지점

- 토큰 보관 위치는 XSS와 CSRF 중 어느 쪽을 감수할지의 선택이다. `localStorage`에 두면 스크립트로 읽히므로 XSS 한 번에 토큰이 유출되고, `HttpOnly` 쿠키에 두면 XSS로부터는 안전하지만 CSRF 방어(`SameSite`, CSRF 토큰)가 다시 필요하다. 브라우저 클라이언트라면 후자가 통제하기 쉽다.
- 블랙리스트로 JWT를 즉시 무효화하려는 시도는 결국 매 요청마다 저장소를 조회하게 만들어 세션 방식과 같은 비용으로 되돌아간다. 즉시 회수가 요구사항이면 처음부터 세션을 쓰거나 액세스 토큰 수명을 5분 이내로 줄이는 쪽이 낫다.
- 서명 알고리즘은 검증 측이 고정해야 한다. ==헤더의 `alg` 값을 믿고 검증 방식을 결정하면 `none`이나 키 혼동(RS256 공개키를 HS256 비밀키로 사용) 공격에 뚫린다.== `NimbusJwtDecoder`처럼 알고리즘을 명시하는 디코더를 쓰고, 오래된 라이브러리의 `parseClaimsJws` 계열 API는 최신 버전의 `verifyWith`로 교체한다.
- 인스턴스 간 시계 차이로 방금 발급한 토큰이 "아직 유효하지 않음"으로 거부될 수 있다. `NimbusJwtDecoder`는 기본 60초의 허용 오차를 두며, 이 값을 0으로 줄이면 NTP 동기화가 조금만 흔들려도 간헐적 401이 발생한다.
- 세션 저장소를 Redis로 옮기면 Redis 장애가 곧 전체 로그아웃이다. `SecurityContext` 직렬화 형식이 Spring Security 버전 사이에 바뀔 수 있으므로 롤링 업그레이드 전에 역직렬화 호환을 확인한다.

## 관련 글

- [API 게이트웨이 — 단일 진입점과 BFF](/notes/architecture-patterns/api-gateway/)
- [캐싱 — Look-aside·Write-through·Write-behind](/notes/architecture-patterns/caching/)
- [멀티테넌시 — 테넌트별 데이터 격리 전략](/notes/architecture-patterns/multi-tenancy/)
