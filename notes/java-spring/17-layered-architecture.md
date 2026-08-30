---
title: "계층 설계 — 서비스 레이어 분리"
series: java-spring
part: "Spring 코어"
order: 17
summary: "Controller·Service·Repository 3계층의 책임과 의존 방향, 비즈니스 로직과 트랜잭션 경계를 서비스에 두는 이유"
tags: [Spring, Layered Architecture, Service Layer, "@Service", "@Transactional"]
sources: [spring/2026-05-26-layered-architecture-service-layer.md]
updated: 2026-08-29
---

요청을 받고, 값을 검증하고, DB에서 조회하고, 계산하고, 저장하고, 응답을 만드는 일을 컨트롤러 메서드 하나에 전부 넣어도 코드는 동작한다. 문제는 동작 이후에 드러난다. 같은 로직을 배치 작업이나 메시지 컨슈머에서 재사용하려면 HTTP 없이 호출할 방법이 없고, 비즈니스 규칙만 단위 테스트하려 해도 매번 HTTP 요청을 흉내 내야 하며, 어디까지가 하나의 트랜잭션인지 경계가 흐려진다. 레이어드 아키텍처는 이런 비대한 컨트롤러(fat controller)를 막기 위해 책임을 세 겹으로 나누는 구조다.

## 핵심 개념

### 세 계층의 책임

| 계층 | 책임 | 어노테이션 |
|:---|:---|:---|
| Controller | HTTP 요청 수신, 파라미터 바인딩, 서비스 호출, 응답 변환 | `@RestController` |
| Service | 비즈니스 규칙, 여러 Repository 조합, 트랜잭션 경계 | `@Service` |
| Repository | 영속화와 조회 | `@Repository` |

원칙은 각 계층이 자기 일만 한다는 것이다. 컨트롤러는 판단하지 않고, 서비스는 HTTP를 모르며, 리포지토리는 비즈니스 규칙을 모른다. 로직을 어디에 둘지 판단하는 기준은 하나다. HTTP 없이도 호출되어야 하는 코드라면 서비스 계층이다.

### 서비스 계층이 맡는 세 가지

서비스는 비즈니스 규칙(잔액이 부족하면 거부한다), 여러 리포지토리의 조합(포인트와 주문을 함께 다룬다), 트랜잭션 경계(이 묶음은 한 단위로 성공하거나 실패한다)를 담당한다. `@Transactional`을 서비스 메서드에 붙이는 것이 표준인 이유가 여기에 있다. 트랜잭션은 비즈니스 한 단위를 묶는 것이고, 그 단위가 정의되는 곳이 서비스이기 때문이다. 컨트롤러에 `@Transactional`을 붙이면 응답 직렬화나 예외 변환까지 트랜잭션 안에 끌려 들어가 경계가 불명확해진다.

### 스테레오타입 어노테이션

`@Service`는 내부적으로 `@Component`를 메타 어노테이션으로 가진다. 컴포넌트 스캔 대상이 된다는 점에서 기능은 같고, 차이는 역할을 이름으로 드러낸다는 점이다. `@Controller`·`@Service`·`@Repository`를 묶어 스테레오타입 어노테이션이라 부른다. `@Repository`만은 부가 기능이 하나 있다. `PersistenceExceptionTranslationPostProcessor`가 이 어노테이션이 붙은 Bean을 대상으로 JPA·JDBC 등 기술별 예외를 Spring의 `DataAccessException` 계층으로 변환한다.

### 인터페이스 도입 기준

과거에는 `OrderService` 인터페이스와 `OrderServiceImpl` 구현체를 항상 쌍으로 만들었다. 현재는 구현이 여러 개로 갈릴 가능성이 있을 때만 인터페이스를 두는 것이 일반적이다. 결제를 카드·계좌이체로 교체해야 한다면 인터페이스가 의미를 갖지만, 구현체가 하나뿐인 서비스에 인터페이스를 강제하면 파일만 늘어난다. Spring은 인터페이스가 없어도 CGLIB 프록시로 `@Transactional`을 적용하므로, 인터페이스가 AOP의 전제 조건도 아니다.

### 의존 방향

의존은 `Controller → Service → Repository` 한 방향으로만 흐른다. 컨트롤러는 서비스를 알지만 서비스는 컨트롤러를 모르고, 서비스는 리포지토리를 알지만 리포지토리는 서비스를 모른다. 이 방향이 역전되거나 계층 안에서 서로를 호출하면 순환 의존이 생기고, Spring Boot는 기본 설정에서 순환 참조를 기동 실패로 처리한다. 화살표가 한 방향인지 확인하는 것이 구조 건전성을 보는 가장 빠른 점검이다.

## 코드

모든 책임을 한 곳에 몰아넣은 컨트롤러다. 검증·포인트 차감·저장·응답 변환이 HTTP 진입점에 묶여 있어 재사용과 테스트가 불가능하다.

```java
@RestController
@RequiredArgsConstructor
public class OrderController {

    private final OrderRepository orderRepository;
    private final PointRepository pointRepository;

    @PostMapping("/orders")
    @Transactional
    public OrderResponse create(@RequestBody OrderRequest req) {
        if (req.amount() <= 0) throw new IllegalArgumentException("금액 오류");

        Point point = pointRepository.findByUserId(req.userId())
                .orElseThrow(() -> new NoSuchElementException("포인트 없음"));
        if (point.getBalance() < req.amount()) throw new IllegalStateException("잔액 부족");
        point.setBalance(point.getBalance() - req.amount());

        Order order = orderRepository.save(new Order(req.userId(), req.amount()));
        return new OrderResponse(order.getId(), point.getBalance());
    }
}
```

비즈니스 규칙과 트랜잭션 경계를 서비스로 옮긴 형태다. 잔액 검사는 도메인 객체 `Point.use()`로 내려가고, 서비스는 리포지토리 두 개를 조합해 한 트랜잭션으로 묶는다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;
    private final PointRepository pointRepository;

    @Transactional
    public Order placeOrder(Long userId, int amount) {
        if (amount <= 0) throw new IllegalArgumentException("금액 오류");

        Point point = pointRepository.findByUserId(userId)
                .orElseThrow(() -> new NoSuchElementException("포인트 없음"));
        point.use(amount);   // 잔액 부족 시 도메인 객체가 예외를 던진다

        return orderRepository.save(new Order(userId, amount));
    }
}
```

컨트롤러는 요청 DTO를 풀어 서비스에 넘기고 결과를 응답 DTO로 바꾸는 일만 남는다. 서비스 시그니처에 HTTP 타입이 없으므로 배치나 테스트에서 그대로 호출할 수 있다.

```java
@RestController
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    @PostMapping("/orders")
    @ResponseStatus(HttpStatus.CREATED)
    public OrderResponse create(@RequestBody @Valid OrderRequest req) {
        Order order = orderService.placeOrder(req.userId(), req.amount());
        return new OrderResponse(order.getId());
    }
}
```

## 실무에서 걸리는 지점

- **서비스 시그니처에 HTTP 타입이 들어온다.** `HttpServletRequest`나 `ResponseEntity`가 서비스 메서드에 등장하면 계층 경계가 무너진 신호다. 헤더·쿠키·세션 처리는 컨트롤러에서 끝내고 서비스에는 순수한 값과 도메인 타입만 넘긴다.
- **컨트롤러가 다른 컨트롤러를 호출한다.** 공통 로직이 필요하면 컨트롤러 간 호출이 아니라 서비스로 내려서 두 컨트롤러가 같은 서비스를 쓰도록 한다. 컨트롤러 간 호출은 HTTP 컨텍스트 의존과 순환 참조를 동시에 만든다.
- **리포지토리에 판단이 들어간다.** 잔액 부족 여부 같은 규칙은 리포지토리가 아니라 서비스나 도메인 객체의 몫이다. 리포지토리는 저장·조회 메서드만 노출한다.
- **서비스가 서비스를 호출하다 순환한다.** 서비스 간 호출 자체는 허용되지만 `A → B → A` 형태가 생기면 기동이 실패한다. 공통 부분을 제3의 서비스로 추출하거나, 이벤트로 결합을 끊는다.
- **`@Transactional` 내부 호출은 프록시를 타지 않는다.** 같은 클래스 안에서 `this.method()`로 부르면 트랜잭션 어드바이스가 적용되지 않는다. 트랜잭션 경계가 필요한 메서드는 외부 Bean에서 호출되도록 분리한다.

## 관련 글

- [Bean 등록과 주입 — 어노테이션·@Component·@Configuration](/notes/java-spring/bean-registration-injection/)
- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
- [Controller와 요청 바인딩](/notes/java-spring/controller-request-binding/)
