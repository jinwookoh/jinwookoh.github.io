---
title: "퍼사드 — 복잡한 서브시스템에 단일 진입점"
series: design-patterns
part: "구조"
order: 9
summary: "여러 서비스를 조율하는 흐름을 퍼사드 빈 하나로 묶고, 정적 헬퍼와 트랜잭션 경계에서 갈리는 지점을 정리한다."
tags: [Facade, Spring, Transaction, SLF4J, 구조 패턴]
sources: [https://jinwookoh.tistory.com/220]
updated: 2026-09-06
---

주문 하나를 처리하려면 재고 차감, 결제 요청, 포인트 차감, 알림 발송, 배송 요청이 순서대로 일어나야 한다. 컨트롤러가 이 서비스들을 전부 주입받아 직접 호출하면 호출 순서와 실패 처리 규칙이 컨트롤러에 박힌다. 같은 주문 흐름이 REST API, 관리자 화면, 배치 작업에서 각각 필요해지면 그 순서가 세 곳에 복사되고, 한 곳에서만 수정되는 일이 생긴다. 트랜잭션 경계도 호출하는 쪽마다 달라진다. 퍼사드는 이 조율 로직을 한 클래스로 옮기고 클라이언트에게는 메서드 하나만 노출한다.

## 핵심 개념

퍼사드는 여러 서브시스템 클래스에 대한 상위 수준의 단일 인터페이스다. 클라이언트는 퍼사드에만 의존하고, 서브시스템의 존재와 호출 순서는 퍼사드 안에 감춰진다. 퍼사드는 새 기능을 추가하지 않는다. 이미 있는 기능을 정해진 순서로 호출하는 조율만 담당한다. 서브시스템을 직접 쓰는 것을 막지도 않는다. 세밀한 제어가 필요한 클라이언트는 퍼사드를 우회해 개별 서비스를 호출해도 된다는 점이 접근을 통제하는 프록시와 다르다.

어댑터는 맞지 않는 인터페이스 하나를 다른 형태로 변환하고, 중재자는 동료 객체들이 서로를 모른 채 중재자를 통해 양방향으로 통신한다. 퍼사드는 단방향이다. 클라이언트가 퍼사드를 부르고 퍼사드가 서브시스템을 부를 뿐, 서브시스템은 퍼사드를 모른다.

Java에서 퍼사드는 두 가지 형태로 구현된다.

| 구분 | 정적 헬퍼 | 서비스 퍼사드 빈 |
|---|---|---|
| 호출 | `ClassName.method()` | 주입받은 인스턴스의 메서드 |
| 상태·의존성 | 없음, 내부에서 직접 생성 | 생성자 주입으로 서브시스템 수신 |
| 테스트 | 정적 호출을 대체하기 어려움 | 서브시스템을 목으로 교체 |
| 트랜잭션 | AOP 프록시가 적용되지 않음 | `@Transactional` 적용 가능 |
| 적합한 용도 | 상태 없는 변환·포맷 | 여러 서비스에 걸친 업무 흐름 |

라이브러리 수준의 퍼사드로는 SLF4J가 있다. 애플리케이션은 `org.slf4j.Logger` API만 호출하고, 실제 기록은 클래스패스에 있는 Logback이나 Log4j2 프로바이더가 맡는다. SLF4J 2.x는 `ServiceLoader`로 `SLF4JServiceProvider` 구현을 찾아 바인딩하므로 로깅 구현을 바꿔도 애플리케이션 코드는 그대로다.

## 코드

주문 흐름을 조율하는 서비스 퍼사드다. 서브시스템은 생성자 주입으로 받고, DB 작업만 트랜잭션 안에 둔다.

```java
@Service
public class OrderFacade {

    private final InventoryService inventoryService;
    private final OrderService orderService;
    private final PaymentGateway paymentGateway;
    private final ApplicationEventPublisher events;

    public OrderFacade(InventoryService inventoryService,
                       OrderService orderService,
                       PaymentGateway paymentGateway,
                       ApplicationEventPublisher events) {
        this.inventoryService = inventoryService;
        this.orderService = orderService;
        this.paymentGateway = paymentGateway;
        this.events = events;
    }

    public OrderResult placeOrder(OrderRequest request) {
        PaymentReceipt receipt = paymentGateway.charge(request.cardToken(), request.amount());
        try {
            Long orderId = confirm(request, receipt);
            return new OrderResult(orderId, receipt.transactionId());
        } catch (RuntimeException e) {
            paymentGateway.refund(receipt.transactionId());
            throw e;
        }
    }

    @Transactional
    protected Long confirm(OrderRequest request, PaymentReceipt receipt) {
        inventoryService.decreaseStock(request.productId(), request.quantity());
        Long orderId = orderService.create(request, receipt);
        events.publishEvent(new OrderPlaced(orderId, request.userPhone()));
        return orderId;
    }
}

public record OrderRequest(Long productId, int quantity, String cardToken,
                           long amount, String userPhone) {}
```

위 코드에서 `confirm`은 같은 클래스 내부 호출이라 프록시를 거치지 않는다. 실제로는 `confirm`을 별도 빈으로 분리하거나 `TransactionTemplate`을 사용한다.

```java
public OrderResult placeOrder(OrderRequest request) {
    PaymentReceipt receipt = paymentGateway.charge(request.cardToken(), request.amount());
    try {
        Long orderId = transactionTemplate.execute(status -> {
            inventoryService.decreaseStock(request.productId(), request.quantity());
            Long id = orderService.create(request, receipt);
            events.publishEvent(new OrderPlaced(id, request.userPhone()));
            return id;
        });
        return new OrderResult(orderId, receipt.transactionId());
    } catch (RuntimeException e) {
        paymentGateway.refund(receipt.transactionId());
        throw e;
    }
}
```

알림은 커밋이 끝난 뒤 이벤트 리스너에서 보낸다. 실패해도 주문 트랜잭션에는 영향이 없다.

```java
@Component
public class OrderNotificationListener {

    private final NotificationService notificationService;

    public OrderNotificationListener(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderPlaced event) {
        notificationService.sendSms(event.userPhone(), "주문 " + event.orderId() + " 접수");
    }
}
```

컨트롤러는 퍼사드 하나만 의존한다.

```java
@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderFacade orderFacade;

    public OrderController(OrderFacade orderFacade) {
        this.orderFacade = orderFacade;
    }

    @PostMapping
    public ResponseEntity<OrderResult> order(@RequestBody @Valid OrderRequest request) {
        return ResponseEntity.ok(orderFacade.placeOrder(request));
    }
}
```

## 실무에서 걸리는 지점

**외부 호출을 트랜잭션 안에 넣는다.** 퍼사드 메서드 전체에 `@Transactional`을 붙이면 결제 HTTP 호출이 DB 트랜잭션 안에서 실행된다. ==외부 API 응답을 기다리는 동안 커넥션이 점유되므로 결제사 지연이 그대로 커넥션 풀 고갈로 이어진다.== 결제가 성공한 뒤 DB 커밋이 실패하면 돈은 빠졌는데 주문이 없는 상태가 되므로 보상 트랜잭션도 필요하다.

**try-catch로 감싼 서브시스템 예외.** 알림 실패를 퍼사드에서 잡아 무시하는 코드는 서브시스템 메서드에도 `@Transactional`이 붙어 있으면 의도대로 동작하지 않는다. ==내부 트랜잭션에서 RuntimeException이 빠져나가는 순간 공유 트랜잭션은 rollback-only로 표시되고, 퍼사드가 예외를 잡아도 커밋 시점에 `UnexpectedRollbackException`이 발생한다.== `REQUIRES_NEW`로 분리하거나 커밋 후 이벤트로 옮긴다.

**퍼사드에 업무 규칙이 흘러든다.** 퍼사드는 호출 순서만 알아야 한다. 재고 부족 판정이나 할인 계산이 퍼사드에 들어가면 서브시스템을 단독으로 재사용할 수 없고, 퍼사드가 퍼사드를 부르는 순환 의존이 생긴다. 규칙은 각 서비스에 두고 퍼사드는 결과를 연결만 한다.

**정적 헬퍼로 만든 퍼사드.** 상태 없는 변환에는 문제가 없지만 서브시스템을 내부에서 `new`로 만들면 테스트에서 교체할 수 없다. Mockito의 `mockStatic`으로 우회할 수는 있어도 스레드 단위로 동작해 병렬 테스트에서 충돌하고, 정적 필드에 캐시를 두면 테스트 간 상태가 새어 나간다.

**SLF4J 프로바이더 불일치.** ==SLF4J 2.x API에 1.7 시절 바인딩만 있으면 `StaticLoggerBinder`를 찾지 못해 NOP 로거로 떨어지고 로그가 조용히 사라진다.== 프로바이더가 둘 이상이면 경고만 남기고 임의로 하나를 고르므로, 의존성 트리에서 `logback-classic`과 `log4j-slf4j2-impl`이 함께 들어오지 않는지 확인한다.

## 관련 글

- [어댑터 — 맞지 않는 인터페이스를 감싸서 연결](/notes/design-patterns/adapter/)
- [중재자 — 객체 간 통신을 한곳으로 모으기](/notes/design-patterns/mediator/)
- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
