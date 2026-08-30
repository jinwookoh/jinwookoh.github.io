---
title: "WebFlux 기본 — 애노테이션 컨트롤러와 Functional Endpoints"
series: reactive-spring
part: "WebFlux"
order: 8
summary: "같은 WebFlux 위에서 @RestController와 RouterFunction이 어떻게 다르고 언제 무엇을 고르는지 정리한다"
tags: [Spring WebFlux, RestController, RouterFunction, HandlerFunction, ServerResponse]
sources: [2026-05-03-webflux-reactive-crud.md, 2026-05-03-webflux-functional-endpoints.md]
updated: 2026-08-29
---

Spring MVC처럼 `User getUser()`를 반환하는 컨트롤러는 DB 응답을 기다리는 동안 스레드를 점유한다. 이벤트 루프 몇 개로 수천 커넥션을 받는 WebFlux에서 이런 블로킹 반환은 루프 자체를 멈추므로, ==컨트롤러는 값이 아니라 값을 만들어 낼 파이프라인(`Mono`, `Flux`)을 반환해야 한다.== 여기에 라우팅을 코드로 선언하는 Functional Endpoints까지 있어, 두 방식의 차이를 모르면 단순 CRUD에 장황한 RouterFunction을 쓰거나 라우트 그룹별 필터가 필요한 곳에 AOP를 억지로 끼워 넣게 된다.

## 핵심 개념

### 애노테이션 컨트롤러

MVC와 같은 `@RestController`, `@GetMapping`을 쓰되 반환 타입만 `Mono<T>`·`Flux<T>`로 바뀐다. 요청 바디를 `@RequestBody Mono<Dto>`로 받으면 역직렬화까지 파이프라인 안에 들어가 서비스로 그대로 전달된다.

상태 코드를 지정하려면 `Mono<ResponseEntity<T>>`를 반환한다. 빈 `Mono`를 처리하지 않으면 완료 신호만 전달되어 클라이언트는 200 빈 바디 또는 204를 받는다. `defaultIfEmpty`는 빈 결과를 기본값 하나로 대체하고, `switchIfEmpty`는 다른 Publisher로 교체한다.

계층은 컨트롤러(HTTP)·서비스(파이프라인)·리포지토리(데이터 접근)로 나눈다. Entity→DTO 같은 동기 변환은 `map`, `save()`처럼 Publisher를 반환하는 호출은 `flatMap`을 쓴다. ==`map` 안에서 `save()`를 호출하면 `Mono<Mono<T>>`가 된다.==

### Functional Endpoints

`RouterFunction<ServerResponse>`가 URL·HTTP 메서드를 `HandlerFunction<ServerResponse>`에 매핑하고, 핸들러는 `ServerRequest`를 받아 `Mono<ServerResponse>`를 돌려준다. 라우팅 선언은 `@Configuration`의 Bean 한 곳에 모이고, 처리 로직은 별도 `@Component`에 둔다.

| 구성 요소 | 역할 | 애노테이션 방식 대응 |
|:---|:---|:---|
| `RouterFunction` | 경로·메서드·조건을 핸들러에 매핑 | `@GetMapping` 등 |
| `HandlerFunction` | 요청 처리 함수 | 컨트롤러 메서드 본문 |
| `ServerRequest` | 경로 변수·쿼리·헤더·바디를 담은 불변 요청 | `@PathVariable`, `@RequestBody` |
| `ServerResponse` | 상태·헤더·바디를 조립하는 빌더 | `ResponseEntity` |

`ServerResponse` 빌더에서 `bodyValue(T)`는 단일 객체, `body(Publisher, Class)`는 `Mono`·`Flux`, `build()`는 바디 없는 응답에 쓴다. `Flux`를 `bodyValue()`에 넘기면 Publisher 객체 자체를 직렬화하려 들어 실패한다. `pathVariable(name)`은 항상 `String`을 반환한다.

두 방식은 같은 스타터 위에서 동작하고 경로만 겹치지 않으면 한 프로젝트에 공존한다. 라우팅 조건이 복잡하거나(헤더·버전·미디어 타입), 특정 라우트 그룹에만 필터를 걸어야 할 때 Functional을 택한다. 단순 CRUD, `@Valid` 자동 검증, OpenAPI 자동 문서화가 필요하면 애노테이션 방식이 짧다.

## 코드

애노테이션 컨트롤러. 생성은 201, 단건 조회는 없을 때 404, 삭제는 204를 명시한다.

```java
@RestController
@RequestMapping("/customers")
@RequiredArgsConstructor
public class CustomerController {

    private final CustomerService customerService;

    @GetMapping
    public Flux<CustomerDto> allCustomers() {
        return customerService.allCustomers();
    }

    @GetMapping("/{id}")
    public Mono<ResponseEntity<CustomerDto>> getCustomerById(@PathVariable Integer id) {
        return customerService.getCustomerById(id)
                .map(ResponseEntity::ok)
                .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    @PostMapping
    public Mono<ResponseEntity<CustomerDto>> saveCustomer(
            @RequestBody Mono<CustomerDto> dtoMono) {
        return customerService.saveCustomer(dtoMono)
                .map(dto -> ResponseEntity.status(HttpStatus.CREATED).body(dto));
    }

    @PutMapping("/{id}")
    public Mono<ResponseEntity<CustomerDto>> updateCustomer(
            @PathVariable Integer id, @RequestBody Mono<CustomerDto> dtoMono) {
        return customerService.updateCustomer(id, dtoMono)
                .map(ResponseEntity::ok)
                .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public Mono<ResponseEntity<Void>> deleteCustomer(@PathVariable Integer id) {
        return customerService.deleteCustomer(id)
                .then(Mono.just(ResponseEntity.noContent().build()));
    }
}
```

서비스 계층. UPDATE에서 URL의 id를 Entity에 심지 않으면 `save()`가 INSERT로 동작한다.

```java
@Service
@RequiredArgsConstructor
public class CustomerService {

    private final CustomerRepository customerRepository;

    public Flux<CustomerDto> allCustomers() {
        return customerRepository.findAll().map(EntityDtoMapper::toDto);
    }

    public Mono<CustomerDto> getCustomerById(Integer id) {
        return customerRepository.findById(id).map(EntityDtoMapper::toDto);
    }

    public Mono<CustomerDto> saveCustomer(Mono<CustomerDto> dtoMono) {
        return dtoMono.map(EntityDtoMapper::toEntity)
                .flatMap(customerRepository::save)
                .map(EntityDtoMapper::toDto);
    }

    public Mono<CustomerDto> updateCustomer(Integer id, Mono<CustomerDto> dtoMono) {
        return customerRepository.findById(id)
                .flatMap(existing -> dtoMono)
                .map(EntityDtoMapper::toEntity)
                .doOnNext(entity -> entity.setId(id))
                .flatMap(customerRepository::save)
                .map(EntityDtoMapper::toDto);
    }

    public Mono<Void> deleteCustomer(Integer id) {
        return customerRepository.deleteById(id);
    }
}
```

같은 서비스를 Functional Endpoints로 노출한 라우터와 핸들러. 구체 경로를 변수 경로보다 먼저 두고, `/admin` 그룹에만 필터를 건다.

```java
@Configuration
public class RouterConfig {

    @Bean
    public RouterFunction<ServerResponse> customerRoutes(CustomerHandler handler) {
        return RouterFunctions.route()
                .GET("/customers/search", handler::search)
                .GET("/customers/{id}", handler::getCustomerById)
                .GET("/customers", handler::allCustomers)
                .POST("/customers", handler::saveCustomer)
                .DELETE("/customers/{id}", handler::deleteCustomer)
                .build();
    }

    @Bean
    public RouterFunction<ServerResponse> adminRoutes(CustomerHandler handler) {
        return RouterFunctions.route()
                .nest(RequestPredicates.path("/admin"), () -> RouterFunctions.route()
                        .GET("/customers", handler::allCustomers)
                        .build())
                .filter((request, next) -> {
                    String token = request.headers().firstHeader("auth-token");
                    if (token == null || token.isBlank()) {
                        return ServerResponse.status(HttpStatus.UNAUTHORIZED).build();
                    }
                    return next.handle(request);
                })
                .build();
    }
}

@Component
@RequiredArgsConstructor
public class CustomerHandler {

    private final CustomerService customerService;
    private final Validator validator;

    public Mono<ServerResponse> allCustomers(ServerRequest request) {
        return ServerResponse.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(customerService.allCustomers(), CustomerDto.class);
    }

    public Mono<ServerResponse> search(ServerRequest request) {
        String name = request.queryParam("name").orElse("");
        return ServerResponse.ok()
                .body(customerService.searchByName(name), CustomerDto.class);
    }

    public Mono<ServerResponse> getCustomerById(ServerRequest request) {
        Integer id = Integer.parseInt(request.pathVariable("id"));
        return customerService.getCustomerById(id)
                .flatMap(dto -> ServerResponse.ok().bodyValue(dto))
                .switchIfEmpty(ServerResponse.notFound().build());
    }

    public Mono<ServerResponse> saveCustomer(ServerRequest request) {
        return request.bodyToMono(CustomerDto.class)
                .flatMap(dto -> {
                    Set<ConstraintViolation<CustomerDto>> violations = validator.validate(dto);
                    if (!violations.isEmpty()) {
                        List<String> errors = violations.stream()
                                .map(v -> v.getPropertyPath() + ": " + v.getMessage())
                                .toList();
                        return ServerResponse.badRequest().bodyValue(errors);
                    }
                    return customerService.saveCustomer(Mono.just(dto))
                            .flatMap(saved -> ServerResponse.status(HttpStatus.CREATED)
                                    .bodyValue(saved));
                });
    }

    public Mono<ServerResponse> deleteCustomer(ServerRequest request) {
        Integer id = Integer.parseInt(request.pathVariable("id"));
        return customerService.deleteCustomer(id)
                .then(ServerResponse.noContent().build());
    }
}
```

## 실무에서 걸리는 지점

- **빈 Mono가 204로 새어 나간다.** ==`Mono<Dto>`를 그대로 반환하면 없는 리소스도 성공 응답이 된다.== 단건 조회는 404를 명시하고, "없는 id → 404" 테스트를 넣어 회귀를 막는다.
- **UPDATE가 INSERT로 바뀐다.** DTO에서 새로 만든 Entity는 id가 null이므로 `save()`는 새 행을 만든다. 경로 변수의 id를 `doOnNext`로 주입하거나 조회한 Entity의 필드만 갱신해서 저장한다.
- **라우트 등록 순서와 Bean 우선순위.** `/customers/{id}`가 `/customers/search`보다 먼저 등록되면 `search`는 도달하지 못한다. `RouterFunction` Bean이 여럿이면 `@Order`로 순서를 고정한다.
- **Functional에서는 `@Valid`와 타입 변환이 없다.** `Integer.parseInt` 실패 시 `NumberFormatException`이 500으로 나가고 검증도 `Validator`를 직접 호출해야 한다. 변환·검증 실패를 400으로 바꾸는 공통 처리를 핸들러 바깥에 두지 않으면 같은 코드가 반복된다.
- **컨트롤러가 리포지토리를 직접 호출하는 구조.** 규칙을 재사용할 수 없고, 컨트롤러 테스트에 DB가 필요해지며, `@Transactional` 경계가 흐려진다. 리액티브에서도 트랜잭션 경계는 서비스 계층에 둔다.

## 관련 글

- [Mono와 Flux](/notes/reactive-spring/mono-flux/)
- [WebFilter·예외 처리·검증](/notes/reactive-spring/webfilter-error-handling/)
- [R2DBC — 리액티브 DB 연동과 JPA 비교](/notes/reactive-spring/r2dbc/)
