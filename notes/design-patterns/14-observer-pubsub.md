---
title: "옵저버와 Pub/Sub — 직접 구독과 브로커 경유의 차이"
series: design-patterns
part: "행위"
order: 14
summary: "옵저버는 주체가 관찰자를 직접 호출하고, Pub/Sub은 채널을 사이에 둬 발행자와 구독자가 서로를 모른다."
tags: [Observer, Pub/Sub, ApplicationEvent, EventListener, Spring]
sources: [https://jinwookoh.tistory.com/208]
updated: 2026-09-06
---

한 객체의 상태가 바뀔 때 다른 여러 객체가 그 사실을 알아야 하는 경우가 있다. 주문이 확정되면 재고를 차감하고, 알림을 보내고, 통계를 갱신해야 한다. 이를 주문 서비스가 재고·알림·통계 서비스를 차례로 호출하는 방식으로 구현하면, 후속 처리가 하나 늘 때마다 주문 서비스를 고쳐야 하고, 주문 서비스는 자신과 무관한 모듈 전부에 의존하게 된다. 후속 처리 중 하나가 실패하면 주문 확정 자체가 실패하는 문제도 따라온다. 옵저버 패턴과 Pub/Sub 패턴은 이 의존 방향을 뒤집어, 변화를 일으키는 쪽이 아니라 변화에 관심 있는 쪽이 등록하도록 만든다.

## 핵심 개념

옵저버 패턴은 GoF가 정의한 원형이다. 주체(Subject)가 관찰자(Observer) 목록을 직접 보유하고, 상태가 바뀌면 목록을 순회하며 각 관찰자의 메서드를 호출한다. 관찰자는 주체에 스스로를 등록하고 해제한다. 주체는 관찰자의 구체 클래스는 모르지만 관찰자 인터페이스와 등록된 인스턴스 목록은 알고 있다. 호출은 같은 스레드에서 동기로 일어나며, 관찰자 하나가 오래 걸리면 주체의 메서드도 그만큼 오래 걸린다.

Pub/Sub 패턴은 발행자(Publisher)와 구독자(Subscriber) 사이에 채널 또는 브로커를 둔다. 발행자는 토픽에 메시지를 던질 뿐 누가 받는지 모르고, 구독자는 토픽을 구독할 뿐 누가 보내는지 모른다. 양쪽이 아는 것은 브로커와 토픽 이름뿐이다. 브로커가 같은 프로세스 안의 이벤트 버스일 수도 있고, Kafka나 RabbitMQ 같은 외부 메시지 시스템일 수도 있다. 외부 브로커를 쓰면 발행과 소비가 다른 프로세스, 다른 시점에 일어나므로 자연스럽게 비동기가 되고, 브로커가 메시지를 보관하는 만큼 구독자가 잠시 죽어 있어도 메시지가 유실되지 않는다.

| 구분 | 옵저버 | Pub/Sub |
|---|---|---|
| 중간 매개 | 없음, 주체가 관찰자 목록 보유 | 채널·브로커 |
| 서로에 대한 인지 | 주체가 관찰자 인터페이스와 인스턴스를 앎 | 서로 모름, 토픽 이름만 공유 |
| 실행 방식 | 기본 동기, 같은 스레드 | 브로커에 따라 동기 또는 비동기 |
| 범위 | 단일 프로세스 | 프로세스·서비스 경계를 넘을 수 있음 |
| 전달 보장 | 호출 실패 시 예외로 즉시 인지 | 브로커의 보관·재전송 정책에 의존 |

Spring의 `ApplicationEventPublisher`와 `@EventListener`는 이 둘의 중간에 있다. `ApplicationContext`가 브로커 역할을 하므로 발행자와 리스너는 서로를 모르지만, 기본 동작은 옵저버와 같은 동기 호출이다. `@Async`나 `@TransactionalEventListener`를 붙여야 실행 시점과 스레드가 분리된다.

## 코드

고전적 옵저버. 주체가 관찰자 목록을 들고 직접 순회한다.

```java
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

@FunctionalInterface
interface PriceObserver {
    void onPriceChanged(String symbol, long price);
}

class StockTicker {
    private final List<PriceObserver> observers = new CopyOnWriteArrayList<>();

    public void subscribe(PriceObserver o) { observers.add(o); }
    public void unsubscribe(PriceObserver o) { observers.remove(o); }

    public void updatePrice(String symbol, long price) {
        for (PriceObserver o : observers) {
            o.onPriceChanged(symbol, price);
        }
    }
}

// 사용
var ticker = new StockTicker();
ticker.subscribe((s, p) -> System.out.println(s + " -> " + p));
ticker.updatePrice("005930", 71_000);
```

Spring 이벤트. 발행자는 `ApplicationEventPublisher`만 의존하고 리스너의 존재를 모른다. 이벤트 클래스는 `ApplicationEvent`를 상속할 필요 없이 record로 정의한다.

```java
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

public record OrderPlacedEvent(long orderId, long memberId) {}

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final ApplicationEventPublisher publisher;

    public OrderService(OrderRepository orderRepository, ApplicationEventPublisher publisher) {
        this.orderRepository = orderRepository;
        this.publisher = publisher;
    }

    @Transactional
    public long place(long memberId) {
        Order order = orderRepository.save(new Order(memberId));
        publisher.publishEvent(new OrderPlacedEvent(order.getId(), memberId));
        return order.getId();
    }
}
```

리스너. 커밋 이후에만, 별도 스레드에서 실행하도록 `@TransactionalEventListener`와 `@Async`를 함께 쓴다. `@Async`는 설정 클래스에 `@EnableAsync`가 있어야 동작한다.

```java
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class OrderNotificationListener {
    private final PushClient pushClient;

    public OrderNotificationListener(PushClient pushClient) {
        this.pushClient = pushClient;
    }

    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderPlacedEvent event) {
        pushClient.send(event.memberId(), "주문 " + event.orderId() + " 접수");
    }
}
```

## 실무에서 걸리는 지점

- 동기 리스너의 예외는 발행자에게 전파된다. ==`@EventListener`만 붙인 리스너가 예외를 던지면 `publishEvent`를 호출한 트랜잭션까지 롤백된다.== 알림 실패로 주문이 취소되는 구조를 피하려면 리스너를 비동기로 분리하거나 리스너 안에서 예외를 처리해야 한다.
- 트랜잭션 안에서 발행한 이벤트를 `@EventListener`로 받으면 아직 커밋되지 않은 상태에서 실행된다. ==리스너가 다른 스레드나 다른 시스템에서 해당 데이터를 조회하면 존재하지 않는 행을 찾게 되고, 이후 롤백되면 이미 나간 알림을 되돌릴 수 없다.== 커밋 이후 처리가 필요하면 `AFTER_COMMIT` 단계를 지정한다.
- `AFTER_COMMIT` 리스너 안에서 DB 쓰기를 하려면 `@Transactional(propagation = REQUIRES_NEW)`가 필요하다. 원래 트랜잭션은 이미 커밋되어 새 쓰기가 참여할 트랜잭션이 없고, ==기본 설정에서는 리스너의 쓰기가 예외 없이 조용히 반영되지 않는다.==
- `@Async` 리스너는 기본 실행기를 그대로 쓰면 스레드 수 제한이 없거나 큐가 무한이라 부하 시 스레드나 메모리가 고갈된다. 전용 `TaskExecutor`를 빈으로 등록하고 큐 크기와 거부 정책을 명시한다. 비동기 리스너의 예외는 발행자에게 오지 않으므로 `AsyncUncaughtExceptionHandler`로 로깅하지 않으면 실패를 알 수 없다.
- 프로세스 내 이벤트는 재시작이나 배포 중에 유실된다. 재시도와 보관이 필요하면 이벤트를 같은 트랜잭션으로 아웃박스 테이블에 기록한 뒤 별도 프로세스가 브로커로 넘기는 방식을 쓴다. 옵저버 목록을 직접 구현할 때는 관찰자를 해제하지 않으면 주체가 관찰자를 계속 참조해 메모리 누수가 생기고, 순회 중 등록·해제가 일어나면 `ConcurrentModificationException`이 발생하므로 `CopyOnWriteArrayList`처럼 순회 안전한 컬렉션을 쓴다.

## 관련 글

- [중재자 — 객체 간 통신을 한곳으로 모으기](/notes/design-patterns/mediator/)
- [커맨드 — 요청을 객체로 캡슐화하고 Undo 구현](/notes/design-patterns/command/)
- [콜백 — 동기·비동기 콜백과 제어 흐름](/notes/design-patterns/callback/)
