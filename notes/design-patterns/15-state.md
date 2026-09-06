---
title: "상태 — 상태별 분기를 객체로 옮기기"
series: design-patterns
part: "행위"
order: 15
summary: "상태별 if-else를 상태 객체로 옮기고, enum 기반과 클래스 기반 구현을 언제 택하는지 정리한다"
tags: [State, enum, Spring, JPA, 상태 전이]
sources: [https://jinwookoh.tistory.com/214]
updated: 2026-09-06
---

주문은 결제 전에는 취소할 수 있지만 배송이 시작되면 취소할 수 없고, 배송 완료 후에는 반품만 가능하다. 이런 규칙을 각 메서드 안의 `if (status == PAID)` 분기로 구현하면 상태가 하나 늘 때마다 `cancel()`, `ship()`, `refund()` 등 모든 메서드를 찾아다니며 분기를 추가해야 한다. 어느 한 곳을 빠뜨려도 컴파일 오류가 나지 않으므로 허용되지 않은 전이가 조용히 통과한다. 상태 패턴은 "현재 상태에서 이 행동이 어떻게 동작하는가"를 상태 객체 하나에 모아, 상태 추가가 새 객체 추가로 끝나게 만든다.

## 핵심 개념

구조는 세 가지 역할로 이루어진다. `State` 인터페이스는 상태에 따라 달라지는 행동을 선언하고, `ConcreteState`는 상태별로 그 행동을 구현하며, `Context`는 현재 상태 객체를 참조하고 호출을 위임한다. 클라이언트는 컨텍스트만 호출하고 상태가 무엇인지 알 필요가 없다.

상태 전이를 누가 결정하는지가 설계의 핵심이다. 상태 객체가 다음 상태를 반환하거나 컨텍스트의 상태를 직접 바꾸는 방식은 전이 규칙이 상태 옆에 놓여 읽기 쉽다. 반대로 컨텍스트가 전이를 결정하면 상태 객체는 행동만 담당하고 전이표는 한곳에 모인다. 어느 쪽이든 한 가지로 통일해야 한다. 두 방식이 섞이면 전이 규칙을 찾기 위해 코드 전체를 뒤져야 한다.

전략 패턴과 구조가 같아 자주 혼동된다. 차이는 교체 주체에 있다. 전략은 클라이언트가 알고리즘을 골라 주입하고 실행 중 바뀌지 않는 편이지만, 상태는 객체 자신의 행동 결과로 실행 중에 계속 바뀐다. 상태 객체들은 서로의 존재를 알고 전이하지만 전략 객체들은 서로를 모른다.

Java에서는 구현이 두 갈래로 나뉜다.

| 구분 | 클래스 기반 | enum 기반 |
|---|---|---|
| 정의 위치 | 상태마다 클래스 하나 | enum 하나에 상수별 본문 |
| 의존성 주입 | 스프링 빈으로 등록해 주입 가능 | 빈이 아니므로 주입 불가 |
| 영속화 | 상태 코드를 따로 두고 매핑 필요 | 상수 자체가 DB 값 |
| 적합한 경우 | 외부 호출·DB 접근이 상태별로 다를 때 | 전이 규칙 위주로 로직이 짧을 때 |

enum 상수는 상수별 본문(constant-specific body)으로 추상 메서드를 구현할 수 있어 파일 하나로 상태 패턴이 완성된다. 다만 enum은 JVM이 클래스 로딩 시점에 생성하므로 스프링 컨테이너가 관리하지 않고, 생성자 주입이 불가능하다. 상태별 로직이 결제 환불이나 배송 API 호출처럼 외부 의존성을 필요로 하면 클래스 기반으로 가고, enum은 상태 코드와 전이표 역할로 남기는 조합이 가장 흔하다.

## 코드

enum 기반 구현이다. 전이가 허용되지 않은 행동은 기본 구현이 예외를 던지고, 허용되는 상태만 메서드를 재정의한다.

```java
public enum OrderStatus {
    PENDING {
        @Override OrderStatus pay()    { return PAID; }
        @Override OrderStatus cancel() { return CANCELLED; }
    },
    PAID {
        @Override OrderStatus ship()   { return SHIPPED; }
        @Override OrderStatus cancel() { return CANCELLED; }
    },
    SHIPPED {
        @Override OrderStatus deliver() { return DELIVERED; }
    },
    DELIVERED,
    CANCELLED;

    OrderStatus pay()     { throw reject("pay"); }
    OrderStatus ship()    { throw reject("ship"); }
    OrderStatus deliver() { throw reject("deliver"); }
    OrderStatus cancel()  { throw reject("cancel"); }

    private IllegalStateException reject(String action) {
        return new IllegalStateException(name() + " 상태에서는 " + action + " 불가");
    }
}
```

컨텍스트인 엔티티는 전이 결과를 저장만 한다. `@Version`은 동시 전이를 막기 위한 낙관적 잠금이다.

```java
@Entity
@Table(name = "orders")
public class Order {

    @Id @GeneratedValue
    private Long id;

    @Enumerated(EnumType.STRING)
    private OrderStatus status = OrderStatus.PENDING;

    @Version
    private long version;

    public void pay()    { status = status.pay(); }
    public void ship()   { status = status.ship(); }
    public void cancel() { status = status.cancel(); }

    public OrderStatus getStatus() { return status; }
}
```

외부 의존성이 필요한 상태는 스프링 빈으로 만든다. 상태 빈을 `OrderStatus` 키로 모아 두는 레지스트리가 컨텍스트와 상태를 연결한다.

```java
public interface OrderState {
    OrderStatus status();

    default void cancel(Order order) { throw reject("cancel"); }
    default void ship(Order order)   { throw reject("ship"); }

    private IllegalStateException reject(String action) {
        return new IllegalStateException(status() + " 상태에서는 " + action + " 불가");
    }
}

@Component
class PaidState implements OrderState {
    private final PaymentGateway paymentGateway;
    private final ShippingClient shippingClient;

    PaidState(PaymentGateway paymentGateway, ShippingClient shippingClient) {
        this.paymentGateway = paymentGateway;
        this.shippingClient = shippingClient;
    }

    @Override public OrderStatus status() { return OrderStatus.PAID; }

    @Override public void cancel(Order order) {
        paymentGateway.refund(order.getPaymentId());
        order.cancel();
    }

    @Override public void ship(Order order) {
        shippingClient.request(order.getId());
        order.ship();
    }
}

@Component
public class OrderStateRegistry {
    private final Map<OrderStatus, OrderState> states;

    OrderStateRegistry(List<OrderState> beans) {
        this.states = beans.stream()
            .collect(Collectors.toUnmodifiableMap(OrderState::status, Function.identity()));
    }

    public OrderState of(OrderStatus status) {
        return Objects.requireNonNull(states.get(status), () -> "미등록 상태: " + status);
    }
}

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final OrderStateRegistry registry;

    public OrderService(OrderRepository orderRepository, OrderStateRegistry registry) {
        this.orderRepository = orderRepository;
        this.registry = registry;
    }

    @Transactional
    public void cancel(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        registry.of(order.getStatus()).cancel(order);
    }
}
```

`toUnmodifiableMap`은 같은 키가 두 번 나오면 예외를 던지므로 두 빈이 같은 상태를 선언하는 실수를 기동 시점에 잡는다.

## 실무에서 걸리는 지점

- 클래스 기반 상태 빈은 싱글톤이다. ==주문 ID나 진행 중인 값처럼 컨텍스트별 데이터를 상태 빈의 필드에 담으면 동시 요청끼리 값이 섞인다.== 상태 빈은 무상태로 두고 필요한 데이터는 메서드 인자로 받는 컨텍스트에서 읽는다.
- 허용되지 않은 전이를 예외 대신 무시하거나 로그만 남기면 잘못된 호출이 성공 응답을 받는다. 기본 구현은 반드시 예외를 던지고, 허용 상태에서만 재정의한다.
- 애플리케이션에서 상태를 검사해도 두 트랜잭션이 같은 행을 동시에 읽으면 둘 다 전이에 성공한다. ==`@Version` 낙관적 잠금이나 현재 상태를 WHERE 절에 넣는 조건부 UPDATE 없이는 상태 검사가 동시 요청 앞에서 무력하다.==
- `@Enumerated(EnumType.ORDINAL)`은 상수 순서를 정수로 저장하므로 ==enum 중간에 상태를 추가하면 기존 행의 상태가 전부 다른 값으로 해석된다.== `EnumType.STRING`을 쓰고 상수 이름 변경도 마이그레이션으로 다룬다.
- 상태 수와 이벤트 수가 곱으로 늘면 상태 객체 안의 전이 로직이 다시 분기로 돌아간다. 전이표를 데이터로 분리하거나 Spring Statemachine 같은 엔진으로 옮길 시점이다. 다만 엔진 도입은 상태 정의를 코드 밖으로 빼는 결정이라 되돌리기 어렵다.

## 관련 글

- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
- [메멘토 — 캡슐화를 지키며 상태 저장·복원](/notes/design-patterns/memento/)
- [널 객체 — null 검사 대신 아무것도 안 하는 객체](/notes/design-patterns/null-object/)
