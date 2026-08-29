---
title: "API 문서화 — Springdoc OpenAPI"
series: java-spring
part: "Web MVC"
order: 23
summary: "Springdoc이 컨트롤러 코드에서 OpenAPI 명세를 생성하는 원리와 어노테이션 보강·보안 스키마·운영 노출 통제 방법"
tags: [Springdoc, OpenAPI, Swagger UI, API 문서화, Spring Boot]
sources: [spring/2026-05-17-springdoc-openapi-swagger.md, 2026-05-02-spring-openapi-ai.md]
updated: 2026-08-29
---

API 문서를 손으로 작성하면 코드와 문서가 어긋나는 순간이 반드시 온다. 필드가 추가되거나 응답 코드가 바뀌어도 문서는 그대로 남고, 프론트엔드는 문서대로 구현했다가 실제 응답과 다르다는 사실을 런타임에 발견한다. 해결책은 문서를 코드에서 생성하는 것이다. Spring Boot 3에서는 Springdoc OpenAPI가 컨트롤러와 DTO를 분석해 OpenAPI 3 명세를 만들고 Swagger UI로 렌더링한다.

## 핵심 개념

OpenAPI는 REST API의 엔드포인트·파라미터·요청/응답 구조를 기계가 읽을 수 있는 형식으로 기술하는 표준이다. Swagger 프로젝트에서 출발해 OpenAPI Initiative로 이관되면서 명세 이름은 OpenAPI가 되었고, Swagger는 도구군의 이름으로 남았다.

Springdoc은 핸들러 매핑과 DTO 클래스를 분석해 OpenAPI 명세를 생성하는 라이브러리다. Spring Boot 3(Jakarta 네임스페이스)에서는 Springdoc 2.x를 써야 한다. SpringFox는 2020년 이후 유지보수가 멈춰 Boot 3와 호환되지 않는다.

`springdoc-openapi-starter-webmvc-ui` 의존성을 추가하면 다음 엔드포인트가 활성화된다.

| 엔드포인트 | 역할 |
|:---|:---|
| `/v3/api-docs` | OpenAPI 명세 JSON |
| `/v3/api-docs.yaml` | OpenAPI 명세 YAML |
| `/swagger-ui.html` | Swagger UI (실제 리소스는 `/swagger-ui/**`) |

WebFlux 프로젝트는 `springdoc-openapi-starter-webflux-ui`를 쓴다.

별도 어노테이션 없이도 URL 경로, HTTP 메서드, `@PathVariable`·`@RequestParam`·`@RequestBody` 매개변수, 반환 타입에서 유도한 응답 스키마, `@ResponseStatus`, DTO의 Bean Validation 제약(`@NotNull`·`@Min`·`@Max`)이 자동 추출된다. 부족한 정보는 `io.swagger.v3.oas.annotations` 패키지의 어노테이션으로 보강한다.

- `@Tag` — 컨트롤러 단위 그룹 이름
- `@Operation` — 메서드 단위 요약·설명
- `@Parameter` — 매개변수 설명·예시
- `@ApiResponse` — 응답 코드별 설명·스키마, `@ExampleObject`로 JSON 예시
- `@Schema` — DTO 필드의 설명·예시·제약
- `@SecurityScheme` — JWT·OAuth2 같은 인증 방식

코드 우선(Code-First)은 구현과 문서가 항상 일치하지만 명세가 최소 정보에 머물고 Breaking Change 사전 감지가 어렵다. 명세 우선(Spec-First)은 명세 파일을 계약으로 삼아 제공자·소비자가 병렬 개발한다. Springdoc은 코드 우선 도구지만 생성된 명세를 저장소에 커밋해 diff로 검토하면 명세 우선의 장점을 일부 가져올 수 있다.

## 코드

컨트롤러와 DTO에 어노테이션을 보강한 예제다. `@Schema`의 `required` 속성은 2.x에서 deprecated이므로 `requiredMode`를 쓴다.

```java
@RestController
@RequestMapping("/api/v1/orders")
@Tag(name = "Order", description = "주문 관리 API")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @Operation(summary = "주문 단건 조회", description = "본인 주문만 조회할 수 있다.")
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "성공",
            content = @Content(
                schema = @Schema(implementation = OrderResponse.class),
                examples = @ExampleObject(value = """
                    {"id": 123, "amount": 10000, "status": "PENDING"}
                    """))),
        @ApiResponse(responseCode = "403", description = "권한 없음", content = @Content),
        @ApiResponse(responseCode = "404", description = "주문 없음", content = @Content)
    })
    @GetMapping("/{id}")
    public OrderResponse get(
            @Parameter(description = "주문 ID", example = "123") @PathVariable Long id) {
        return orderService.findById(id);
    }

    @Operation(summary = "주문 생성")
    @ApiResponse(responseCode = "201", description = "생성됨")
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderResponse create(@Valid @RequestBody OrderRequest request) {
        return orderService.create(request);
    }
}

@Schema(description = "주문 생성 요청")
public record OrderRequest(
        @Schema(description = "상품 ID", example = "1", requiredMode = Schema.RequiredMode.REQUIRED)
        @NotNull Long productId,

        @Schema(description = "수량", example = "2", minimum = "1", maximum = "100")
        @Min(1) @Max(100) int quantity
) {}
```

API 메타 정보와 JWT 보안 스키마를 정의하고 외부용·관리자용 문서를 그룹으로 분리하는 설정이다. `@OpenAPIDefinition`의 `@SecurityRequirement`는 전역 적용되며, Swagger UI에 Authorize 버튼이 생겨 입력한 토큰이 이후 요청 헤더에 자동으로 붙는다.

```java
@Configuration
@OpenAPIDefinition(
    info = @Info(title = "Shop API", version = "1.0.0", description = "쇼핑몰 백엔드 API"),
    security = @SecurityRequirement(name = "bearerAuth")
)
@SecurityScheme(
    name = "bearerAuth",
    type = SecuritySchemeType.HTTP,
    scheme = "bearer",
    bearerFormat = "JWT"
)
public class OpenApiConfig {

    @Bean
    public GroupedOpenApi publicApi() {
        return GroupedOpenApi.builder()
                .group("public")
                .pathsToMatch("/api/v1/**")
                .build();
    }

    @Bean
    public GroupedOpenApi adminApi() {
        return GroupedOpenApi.builder()
                .group("admin")
                .pathsToMatch("/api/admin/**")
                .build();
    }
}
```

Spring Security 적용 시 문서 엔드포인트를 허용하는 설정이다. `/swagger-ui.html`은 `/swagger-ui/index.html`로 리다이렉트되고 CSS·JS를 `/swagger-ui/**`에서 받으므로 와일드카드까지 열어야 한다.

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html")
                    .hasRole("ADMIN")
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
        return http.build();
    }
}
```

## 실무에서 걸리는 지점

**Swagger UI가 빈 화면이거나 깨져서 뜬다.** Security에서 `/swagger-ui.html`만 허용하고 `/swagger-ui/**`와 `/v3/api-docs/**`를 막은 경우다. 메인 HTML은 열리지만 정적 리소스와 명세 JSON 요청이 401·403으로 떨어진다.

**운영 환경에 문서가 그대로 노출된다.** `application-prod.yml`에서 `springdoc.api-docs.enabled=false`, `springdoc.swagger-ui.enabled=false`로 끄거나 관리자 권한으로 제한한다.

**응답 타입이 `ResponseEntity<?>`나 `Object`면 스키마가 비어 있다.** 반환 타입을 구체적으로 선언하거나 `@ApiResponse`의 `@Content`로 명시한다. `@ControllerAdvice`의 공통 에러 응답도 같은 방식으로 등록해야 문서에 나타난다.

**문서와 실제 응답이 다시 어긋난다.** `@ApiResponse`의 상태 코드나 `@ExampleObject`의 JSON은 사람이 쓴 것이라 실제 동작과 달라질 수 있다. 통합 테스트에 `OpenApiValidationFilter`(swagger-request-validator)를 끼워 응답이 `/v3/api-docs` 명세를 준수하는지 검증하면 빌드 단계에서 잡힌다. 이 라이브러리는 Boot 의존성 관리 대상이 아니므로 버전을 명시한다.
## 관련 글

- [Controller와 요청 바인딩](/notes/java-spring/controller-request-binding/)
- [예외 처리와 검증 — @ControllerAdvice·Bean Validation](/notes/java-spring/exception-handling-validation/)
- [CORS와 Spring Security — OAuth2·JWT](/notes/java-spring/cors-security-oauth2-jwt/)
