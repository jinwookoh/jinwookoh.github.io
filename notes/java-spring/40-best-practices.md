---
title: "베스트 프랙티스 정리"
series: java-spring
part: "운영·통합"
order: 40
summary: "Spring Boot 3 실무 규칙을 DI·프록시·보안·성능·테스트 축으로 압축하고, 가장 자주 틀리는 패턴의 원인을 정리한다."
tags: [Spring Boot, Best Practices, Structured Logging, Spec-First, Test Pyramid]
sources: [2026-05-02-spring-certification-best-practices.md]
updated: 2026-08-29
---

Spring Boot 장애의 상당수는 프레임워크 버그가 아니라 규칙을 모르고 쓴 코드에서 나온다. 같은 클래스 안에서 `@Transactional` 메서드를 호출해 트랜잭션이 걸리지 않고, 싱글턴 빈에 요청 상태를 담아 데이터가 섞이고, Actuator 전체를 노출해 환경 변수가 새고, 에러 응답에 스택 트레이스가 실려 나간다. 반복해서 등장한 규칙을 한 곳에 모아 원리와 함께 정리한다.

## 핵심 개념

### DI와 Bean 등록

의존성 주입은 생성자 주입을 기본으로 한다. `final` 필드로 불변성을 확보하고, 테스트에서 리플렉션 없이 객체를 조립할 수 있으며, 순환 참조가 기동 시점에 드러난다. 필드 주입은 이 세 가지를 모두 잃는다. Setter 주입은 선택적 의존성에만 쓴다.

스테레오타입 중 `@Repository`만 추가 동작이 있다. 영속성 예외를 `DataAccessException` 계층으로 변환한다. 나머지는 의미 구분과 스캔 대상 표시 역할만 한다.

Bean Scope는 singleton·prototype·request·session·application 다섯 가지다. 기본값 singleton은 모든 요청이 인스턴스를 공유하므로 필드에 요청별 상태를 저장하면 안 된다.

### AOP 프록시가 지배하는 어노테이션

`@Transactional`·`@Cacheable`·`@Async`는 모두 프록시 기반 AOP로 동작한다. 컨테이너는 원본을 감싼 프록시를 주입하고, 프록시를 통해 들어온 호출에만 부가 동작을 붙인다. 따라서 `this.method()` 내부 호출, `private` 메서드, `final` 클래스에는 적용되지 않는다. 실수 대부분이 여기서 나온다.

전파 속성은 REQUIRED(기본)·REQUIRES_NEW(기존 것을 중단하고 새로 시작)·NESTED(Savepoint 기반)·SUPPORTS·MANDATORY·NOT_SUPPORTED·NEVER 일곱 가지다. 읽기 전용 메서드에는 `readOnly = true`를 붙여 더티 체킹을 끈다.

### 보안 기본 규칙

Spring Security 6은 `SecurityFilterChain` 빈과 람다 DSL로 구성한다. `WebSecurityConfigurerAdapter`는 제거됐다. 무상태 REST API는 CSRF를 끄고 세션 정책을 STATELESS로 두며, JWT 검증은 `oauth2ResourceServer`에 맡긴다. 민감 값은 환경 변수로 주입하고, Actuator는 필요한 엔드포인트만 노출하며, 쿼리는 파라미터 바인딩만 쓴다.

### 관측성과 설정

Spring Boot 3.4부터 구조화 로깅이 내장됐다. `logging.structured.format.console`에 ecs·logstash·gelf 중 하나를 지정하면 JSON 로그가 나온다. 필드를 바꾸려면 `StructuredLoggingJsonMembersCustomizer` 구현체를 같은 속성에 지정하고, 개발 프로파일에서는 값을 비운다.

### API 설계와 테스트

명세를 먼저 쓰고 코드가 따르는 Spec-First 방식이 병렬 개발과 호환성 유지에 유리하다. OpenAPI 문서는 CI에서 lint하고 계약 테스트로 응답을 검증한다. 테스트는 단위 다수·통합 중간·E2E 소수의 피라미드를 유지하고, 슬라이스 테스트를 우선하며 전체 컨텍스트가 필요할 때만 `@SpringBootTest`를 쓴다.

## 코드

트랜잭션 경계를 별도 빈으로 분리해 프록시 한계를 피하고, 읽기와 쓰기를 구분한 서비스 구성이다.

```java
@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final OrderPersister orderPersister;

    public OrderService(OrderRepository orderRepository, OrderPersister orderPersister) {
        this.orderRepository = orderRepository;
        this.orderPersister = orderPersister;
    }

    @Transactional(readOnly = true)
    public OrderResponse getOrder(UUID orderId) {
        return orderRepository.findById(orderId)
                .map(OrderResponse::from)
                .orElseThrow(() -> new NotFoundException("order " + orderId));
    }

    public void processOrder(OrderRequest request) {
        orderPersister.save(request);   // 다른 빈을 거치므로 프록시가 적용된다
    }
}

@Component
public class OrderPersister {

    private final OrderRepository orderRepository;

    public OrderPersister(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(rollbackFor = Exception.class, timeout = 30)
    public void save(OrderRequest request) {
        orderRepository.save(request.toEntity());
    }
}
```

Actuator를 별도 필터 체인으로 보호하고 API는 JWT 리소스 서버로 처리하는 구성이다.

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    @Order(1)
    SecurityFilterChain actuatorChain(HttpSecurity http) throws Exception {
        http.securityMatcher("/actuator/**")
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .anyRequest().hasRole("ADMIN"))
            .httpBasic(Customizer.withDefaults());
        return http.build();
    }

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/v1/public/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/products/**").hasRole("USER")
                .anyRequest().authenticated())
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
        return http.build();
    }
}
```

```properties
management.endpoints.web.exposure.include=health,info,metrics
management.endpoint.health.show-details=when-authorized
spring.datasource.password=${DB_PASSWORD}
logging.structured.format.console=ecs
server.shutdown=graceful
spring.lifecycle.timeout-per-shutdown-phase=30s
```

검증 실패와 도메인 예외를 `ProblemDetail`로 통일하고, 예상 못 한 예외는 서버 로그에만 남기는 전역 핸들러다.

```java
public record ProductRequest(
        @NotBlank @Size(min = 2, max = 50) String productName,
        @NotNull ProductCategory category,
        @NotNull @DecimalMin("0.01") BigDecimal price,
        @Min(0) Integer quantityOnHand) {}

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(NotFoundException.class)
    ProblemDetail handleNotFound(NotFoundException ex) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ProblemDetail handleValidation(MethodArgumentNotValidException ex) {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        Map<String, String> errors = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors()
                .forEach(e -> errors.put(e.getField(), e.getDefaultMessage()));
        problem.setProperty("errors", errors);
        return problem;
    }

    @ExceptionHandler(Exception.class)
    ProblemDetail handleUnexpected(Exception ex) {
        log.error("unexpected error", ex);
        return ProblemDetail.forStatusAndDetail(
                HttpStatus.INTERNAL_SERVER_ERROR, "An internal error occurred");
    }
}
```

## 실무에서 걸리는 지점

- **`@Async`와 `@Transactional`의 조합.** 비동기 메서드는 다른 스레드에서 새 트랜잭션을 연다. ==호출자가 롤백돼도 비동기 쪽은 커밋됐을 수 있다.== 커밋 이후에만 실행해야 하면 `@TransactionalEventListener(phase = AFTER_COMMIT)`을 쓴다.
- **동기 리스너의 느린 작업.** `@EventListener`는 발행자 스레드에서 동기 실행되므로 메일 발송이나 외부 호출을 넣으면 그만큼 응답이 지연된다. `@Async`를 붙이거나 브로커로 넘긴다.
- **N+1과 전체 로딩.** 지연 로딩 컬렉션을 반복문에서 접근하면 건수만큼 쿼리가 나간다. Fetch Join·`@EntityGraph`·`default_batch_fetch_size` 중 하나로 해결한다. 일부 필드만 필요한 `findAll()`은 프로젝션 쿼리로 대체한다.
- **JPA 엔티티에 Lombok `@Data`.** 생성된 `hashCode`·`toString`이 양방향 연관 필드를 타고 들어가 `StackOverflowError`를 낸다. `@Getter`·`@Setter`·`@NoArgsConstructor`만 쓰고 연관 필드는 `@ToString.Exclude`로 뺀다.
- **Spring Boot 2.x 잔재.** `javax.*`는 `jakarta.*`로 바꿔야 컴파일된다. 동기 HTTP 클라이언트는 `RestTemplate` 대신 `RestClient`를 쓰고, record·sealed·pattern matching을 DTO와 이벤트 모델링에 활용한다.

## 관련 글

- [/notes/java-spring/transactional-locking/](/notes/java-spring/transactional-locking/)
- [/notes/java-spring/cors-security-oauth2-jwt/](/notes/java-spring/cors-security-oauth2-jwt/)
- [/notes/java-spring/testing-mockmvc-testcontainers/](/notes/java-spring/testing-mockmvc-testcontainers/)
