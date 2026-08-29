---
title: "WebFilter·예외 처리·검증"
series: reactive-spring
part: "WebFlux"
order: 10
summary: "WebFilter로 공통 처리를 모으고, Bean Validation과 ProblemDetail로 실패 응답을 일관되게 만드는 방법"
tags: [WebFilter, ServerWebExchange, Bean Validation, ProblemDetail, ControllerAdvice]
sources: [2026-05-03-webflux-webfilter.md, 2026-05-03-webflux-validation-error-handling.md]
updated: 2026-08-29
---

인증, 로깅, 보안 헤더 추가는 모든 요청에 공통으로 필요하다. 컨트롤러마다 반복하면 누락이 생기고, 검증과 예외 응답도 핸들러마다 달라져 클라이언트는 실패 원인을 상태 코드로 판단할 수 없게 된다. WebFlux는 이를 WebFilter와 `@ControllerAdvice` + `ProblemDetail`로 처리한다. Servlet의 `Filter`, `HandlerInterceptor`, `MethodArgumentNotValidException`, ThreadLocal MDC는 WebFlux에서 동작하지 않는다.

## 핵심 개념

WebFilter는 서버와 핸들러 사이에서 모든 요청·응답을 가로채는 컴포넌트다. 인터페이스는 `Mono<Void> filter(ServerWebExchange, WebFilterChain)` 하나이며 `@Component`로 등록하면 체인에 포함된다. `ServerWebExchange`는 요청, 응답, 필터 간 공유 맵(`getAttributes()`)을 묶은 객체다.

`chain.filter(exchange)`가 다음 필터와 핸들러로 이어지는 지점이다. 이 호출 앞이 전처리, 뒤에 붙는 `doFinally` 등이 후처리다. 반환된 `Mono<Void>`를 return하지 않으면 구독이 일어나지 않아 요청이 사라진다. 차단하려면 상태 코드를 설정하고 `exchange.getResponse().setComplete()`를 반환한다. `Mono.empty()`를 반환하면 응답이 완료되지 않는다.

실행 순서는 `@Order` 값이 낮을수록 앞선다. 애노테이션이 없으면 순서가 보장되지 않아 인증보다 권한 필터가 먼저 실행될 수 있다. CORS·보안은 `Ordered.HIGHEST_PRECEDENCE`, 인증 → 권한 순으로 낮은 값을 주고, 응답 헤더 필터는 `Ordered.LOWEST_PRECEDENCE`로 둔다.

이벤트 루프는 소수 스레드가 다수 요청을 번갈아 처리하므로 ThreadLocal 값은 스레드가 바뀌면 사라지거나 다른 요청의 값으로 오염된다. 요청 단위 값은 `getAttributes()`에 두거나, 다운스트림까지 전파해야 하면 `contextWrite`로 Reactor Context에 넣는다.

검증은 `spring-boot-starter-validation`을 추가하고 DTO에 Jakarta Bean Validation 제약을 붙인 뒤 `@Valid`를 붙이면 역직렬화 시점에 수행되며, `@RequestBody Mono<Dto>`에도 적용된다. 실패 예외는 `WebExchangeBindException`이다. `@PathVariable`·`@RequestParam`은 클래스에 `@Validated`를 붙이고 파라미터에 제약을 직접 선언해야 한다. 문자열에는 공백만 있는 값까지 거부하는 `@NotBlank`가 대개 맞다.

예외 처리는 두 층이다. 파이프라인 안에서는 `switchIfEmpty(Mono.error(...))`로 빈 결과를 404 예외로 바꾸고, `onErrorResume`·`onErrorReturn`·`onErrorComplete`로 대체 흐름을 만든다. 핸들러 밖으로 나온 에러 신호는 `@RestControllerAdvice`의 `@ExceptionHandler`가 받으며, `ServerWebExchange`를 파라미터로, `ProblemDetail`(Spring 6 내장, RFC 9457)이나 `Mono`를 반환으로 쓸 수 있다. 빈 `Mono`를 그대로 반환하면 404가 아니라 본문 없는 200이 나간다.

## 코드

인증 필터. 토큰이 없으면 401로 종료하고, 성공하면 사용자 ID를 attributes와 Reactor Context에 넣는다.

```java
@Component
@Order(1)
public class AuthenticationFilter implements WebFilter {

    public static final String USER_ID = "userId";
    private static final List<String> WHITELIST = List.of("/public", "/actuator/health");

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String path = exchange.getRequest().getPath().value();
        if (WHITELIST.stream().anyMatch(path::startsWith)) {
            return chain.filter(exchange);
        }

        String token = exchange.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (token == null || token.isBlank()) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }

        String userId = resolveUserId(token);
        exchange.getAttributes().put(USER_ID, userId);
        return chain.filter(exchange)
                .contextWrite(ctx -> ctx.put(USER_ID, userId));
    }

    private String resolveUserId(String token) {
        return "user-001"; // 실제로는 JWT 파싱 또는 토큰 저장소 조회
    }
}
```

응답 헤더와 처리 시간 필터. 헤더는 커밋 전에 넣어야 하므로 `beforeCommit`, 처리 시간은 성공·에러·취소 모두 실행되는 `doFinally`에서 기록한다.

```java
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
public class ResponseDecoratingFilter implements WebFilter {

    private static final Logger log = LoggerFactory.getLogger(ResponseDecoratingFilter.class);

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        long start = System.nanoTime();
        String path = exchange.getRequest().getPath().value();

        exchange.getResponse().beforeCommit(() -> {
            HttpHeaders headers = exchange.getResponse().getHeaders();
            headers.set("X-Content-Type-Options", "nosniff");
            headers.set("X-Frame-Options", "DENY");
            return Mono.empty();
        });

        return chain.filter(exchange)
                .doFinally(signal -> log.info("{} {} {}ms ({})", path,
                        exchange.getResponse().getStatusCode(),
                        (System.nanoTime() - start) / 1_000_000, signal));
    }
}
```

검증 DTO, `switchIfEmpty` 패턴, 전역 예외 핸들러. 예상 밖 예외는 내부 메시지를 노출하지 않는다.

```java
public record CustomerDto(
        Integer id,
        @NotBlank(message = "이름은 필수다") @Size(min = 2, max = 50) String name,
        @NotBlank @Email(message = "이메일 형식이 아니다") String email) {}

public class CustomerNotFoundException extends RuntimeException {
    public CustomerNotFoundException(Integer id) {
        super("Customer [" + id + "] not found");
    }
}

@Service
public class CustomerService {
    private final CustomerRepository repository;

    public CustomerService(CustomerRepository repository) { this.repository = repository; }

    public Mono<CustomerDto> findById(Integer id) {
        return repository.findById(id)
                .map(CustomerMapper::toDto)
                .switchIfEmpty(Mono.error(new CustomerNotFoundException(id)));
    }
}

@RestController
@RequestMapping("/customers")
@Validated
public class CustomerController {
    private final CustomerService service;

    public CustomerController(CustomerService service) { this.service = service; }

    @GetMapping("/{id}")
    public Mono<CustomerDto> get(@PathVariable @Positive Integer id) {
        return service.findById(id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<CustomerDto> create(@RequestBody @Valid Mono<CustomerDto> dto) {
        return dto.flatMap(service::save);
    }
}

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(CustomerNotFoundException.class)
    public ProblemDetail notFound(CustomerNotFoundException ex, ServerWebExchange exchange) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Customer Not Found");
        pd.setInstance(exchange.getRequest().getURI());
        return pd;
    }

    @ExceptionHandler(WebExchangeBindException.class)
    public ProblemDetail invalid(WebExchangeBindException ex) {
        List<String> errors = ex.getFieldErrors().stream()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .toList();
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Validation failed");
        pd.setTitle("Validation Failed");
        pd.setProperty("errors", errors);
        return pd;
    }

    @ExceptionHandler(Exception.class)
    public ProblemDetail unexpected(Exception ex) {
        log.error("Unhandled exception", ex);
        return ProblemDetail.forStatusAndDetail(
                HttpStatus.INTERNAL_SERVER_ERROR, "Unexpected error");
    }
}
```

## 실무에서 걸리는 지점

- `@ControllerAdvice`는 핸들러 단계의 예외만 처리한다. WebFilter에서 난 예외는 기본 `ErrorWebExceptionHandler`로 가므로, 필터 단계 에러 응답까지 통일하려면 `WebExceptionHandler`를 직접 등록하거나 필터 안에서 응답을 완성한다.
- 응답 헤더를 `doOnSuccess`에서 추가하면 이미 커밋된 응답에 쓰려다 예외가 나거나 무시된다. `beforeCommit` 또는 `chain.filter` 호출 전에 넣는다.
- Reactor Context는 MDC에 자동 반영되지 않는다. 로그에 trace ID를 남기려면 Micrometer Context Propagation을 함께 구성한다.
- `Exception` 핸들러가 `ResponseStatusException`까지 삼키면 상태 코드가 500으로 바뀐다. `ResponseEntityExceptionHandler`를 상속하고 `spring.webflux.problemdetails.enabled=true`를 켠다.
- 컨트롤러나 필터에서 `subscribe()`를 직접 호출하면 이중 구독이 되어 예외가 `@ControllerAdvice`로 전달되지 않는다.

## 관련 글

- [WebFlux 기본 — 애노테이션 컨트롤러와 Functional Endpoints](/notes/reactive-spring/webflux-basics-functional/)
- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
- [Repeat·Retry와 StepVerifier](/notes/reactive-spring/retry-stepverifier/)
