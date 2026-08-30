---
title: "Controller와 요청 바인딩"
series: java-spring
part: "Web MVC"
order: 19
summary: "HTTP 요청의 경로·쿼리·본문을 메서드 인자로 받고, 반환 객체를 JSON 응답으로 내보내는 Spring MVC의 바인딩 규칙"
tags: [Spring MVC, RequestMapping, RequestBody, Jackson, ResponseEntity]
sources: [spring/2026-05-16-controller-requestmapping.md, spring/2026-05-16-restcontroller-json-response.md, spring/2026-05-16-request-parameters.md]
updated: 2026-08-29
---

서블릿 API만으로 요청을 처리하면 `HttpServletRequest`에서 문자열을 꺼내 직접 파싱·변환하고 응답 스트림에 JSON을 손으로 써야 하며, 엔드포인트가 늘수록 같은 코드가 반복된다. Spring MVC는 URL 매핑·요청 데이터 추출·응답 직렬화를 어노테이션과 `HttpMessageConverter`로 분리해 메서드 본문에 도메인 로직만 남긴다.

## 핵심 개념

### 매핑의 합성과 우선순위

`@RequestMapping`은 경로·HTTP 메서드·헤더·Content-Type 조건을 모두 받는 원형이고, `@GetMapping`·`@PostMapping`·`@PutMapping`·`@PatchMapping`·`@DeleteMapping`은 메서드가 고정된 단축형이다. 클래스 레벨 `@RequestMapping("/orders")`는 안쪽 모든 메서드 매핑의 접두사가 되어 `@GetMapping("/{id}")`와 합쳐 `/orders/{id}`를 만든다. 한 컨트롤러가 한 리소스를 담당하도록 두면 반복이 사라진다.

경로 외 매핑 조건으로 `params`(쿼리 스트링), `headers`(요청 헤더), `consumes`(요청 Content-Type), `produces`(응답 Content-Type, Accept 기반 콘텐츠 협상)가 있다. 여러 매핑이 일치하면 정확한 경로가 와일드카드보다, 조건이 많은 쪽이 우선한다. 완전히 같은 매핑이 두 곳에 있으면 시작 시점에 `IllegalStateException`으로 실패한다.

### 요청 데이터 바인딩

| 어노테이션 | 추출 위치 | 용도 |
|---|---|---|
| `@PathVariable` | 경로의 `{...}` | 리소스 식별자 |
| `@RequestParam` | 쿼리 스트링, form 파라미터 | 검색·필터·페이징 |
| `@RequestBody` | 요청 본문 | POST·PUT·PATCH 페이로드 |
| `@RequestHeader` / `@CookieValue` | 헤더 / 쿠키 | 테넌트·세션 |
| `@ModelAttribute` | form-urlencoded 필드 묶음 | HTML 폼 |

`@PathVariable`과 `@RequestParam`은 문자열을 인자 타입으로 자동 변환하며 실패 시 `MethodArgumentTypeMismatchException`으로 400이 된다. `@RequestParam`은 기본이 필수이므로 선택 값은 `required = false`나 `defaultValue`로 선언한다.

`@RequestBody`는 본문 전체를 Jackson으로 한 객체에 역직렬화한다. 가변 클래스 DTO는 기본 생성자가 필요하지만 record는 canonical 생성자로 바로 역직렬화된다. `@Valid`를 붙이면 역직렬화 직후 Bean Validation이 실행되고 실패 시 `MethodArgumentNotValidException`이 발생한다.

### 응답 직렬화

`@Controller`가 반환한 문자열은 `ViewResolver`가 템플릿 이름으로 해석한다. `@RestController`는 `@Controller`와 `@ResponseBody`의 합성으로, 반환값을 응답 본문으로 취급해 Accept 헤더에 맞는 `HttpMessageConverter`가 직렬화한다. Jackson은 public getter(record는 컴포넌트 접근자)를 필드로 내보내며, 세부 제어는 `@JsonProperty`·`@JsonIgnore`·`@JsonFormat`·`@JsonInclude`, 공통 규칙은 `spring.jackson.*` 프로퍼티로 둔다. 상태 코드와 헤더까지 제어하려면 `ResponseEntity<T>`, 상태 코드만 고정하면 `@ResponseStatus`를 쓴다.

## 코드

리소스 단위 컨트롤러. 클래스 레벨 접두사와 인자 어노테이션, `ResponseEntity`를 함께 쓴다.

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping
    public List<OrderResponse> search(
            @RequestParam(required = false) OrderStatus status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return orderService.search(status, page, size);
    }

    @GetMapping("/{id}")
    public ResponseEntity<OrderResponse> detail(@PathVariable Long id) {
        return orderService.findById(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<OrderResponse> create(
            @RequestBody @Valid OrderCreateRequest request,
            @RequestHeader("X-Tenant-Id") String tenantId) {
        OrderResponse saved = orderService.create(tenantId, request);
        return ResponseEntity
                .created(URI.create("/api/orders/" + saved.id()))
                .body(saved);
    }

    @PatchMapping("/{id}")
    public OrderResponse update(
            @PathVariable Long id,
            @RequestBody @Valid OrderUpdateRequest request) {
        return orderService.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        orderService.delete(id);
    }
}
```

요청·응답 DTO를 record로 정의한다. 검증 어노테이션은 컴포넌트에 그대로 붙는다.

```java
public record OrderCreateRequest(
        @NotNull Long productId,
        @Min(1) @Max(100) int quantity,
        @Email String customerEmail) {
}

public record OrderResponse(
        Long id,
        int amount,
        OrderStatus status,
        @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss") LocalDateTime createdAt) {

    public static OrderResponse from(Order entity) {
        return new OrderResponse(
                entity.getId(), entity.getAmount(), entity.getStatus(), entity.getCreatedAt());
    }
}
```

같은 경로를 `params`와 `produces`로 분기한다. `?preview=true`는 두 번째, `Accept: application/xml`은 세 번째 메서드로 간다.

```java
@GetMapping("/{id}")
public OrderResponse json(@PathVariable Long id) { ... }

@GetMapping(value = "/{id}", params = "preview=true")
public OrderPreview preview(@PathVariable Long id) { ... }

@GetMapping(value = "/{id}", produces = MediaType.APPLICATION_XML_VALUE)
public OrderResponse xml(@PathVariable Long id) { ... }
```

## 실무에서 걸리는 지점

- **JPA 엔티티 직접 반환.** 트랜잭션 종료 후 Jackson이 지연 로딩 필드의 getter를 호출하면 `LazyInitializationException`, 양방향 연관관계면 무한 재귀가 발생한다. 응답 전용 DTO로 변환해 API 계약과 DB 스키마를 분리한다.

- **원시 타입 선택 파라미터.** `int`에 `required = false`만 붙이면 값이 없을 때 null을 담을 수 없어 500이 난다. `defaultValue`를 주거나 래퍼 타입을 쓴다.

- **역직렬화 예외의 종류.** 잘못된 JSON은 `HttpMessageNotReadableException`, 타입 불일치와 검증 실패는 각각 다른 예외로 온다. `@ControllerAdvice`에서 잡아 오류 응답 형식을 통일하지 않으면 클라이언트가 원인을 구분하지 못한다.

- **경로 매칭 전략.** Spring Boot 3.x 기본 `PathPatternParser`는 `**`를 패턴 끝에서만 허용하고 접미사 매칭을 지원하지 않는다.

## 관련 글

- [요청 처리 흐름 — DispatcherServlet·Filter·Interceptor](/notes/java-spring/dispatcher-servlet-filter-interceptor/)
- [ArgumentResolver·파일 업로드·페이징](/notes/java-spring/argument-resolver-upload-paging/)
- [예외 처리와 검증 — @ControllerAdvice·Bean Validation](/notes/java-spring/exception-handling-validation/)
