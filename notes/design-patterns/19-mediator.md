---
title: "중재자 — 객체 간 통신을 한곳으로 모으기"
series: design-patterns
part: "행위"
order: 19
summary: "참조가 직접 얽힌 객체들의 통신을 중재자 하나로 모으는 고전 구현과 Spring 이벤트로 느슨하게 묶는 구현의 차이"
tags: [Mediator, ApplicationEventPublisher, EventListener, Spring, Java]
sources: [https://jinwookoh.tistory.com/221]
updated: 2026-09-06
---

객체 N개가 서로를 직접 참조하면 관계 수는 최대 N(N-1)까지 늘어난다. 주문 서비스가 포인트 서비스를 호출하고 포인트 서비스가 메일 서비스를 호출하는 구조에서는 메일 발송 시그니처 하나를 바꿔도 호출 경로에 있는 클래스를 전부 수정해야 하고, 주문 서비스를 단위 테스트하려면 그 뒤에 매달린 모든 협력 객체를 모킹해야 한다. 참여자 하나를 다른 문맥에서 재사용하는 것도 불가능에 가깝다. 상호작용 규칙이 참여자 각각에 흩어져 있기 때문이다. 중재자 패턴은 이 규칙을 참여자 밖의 한 객체로 옮겨서, 참여자들이 서로가 아니라 중재자 하나만 알도록 관계를 별 모양으로 재편한다.

## 핵심 개념

GoF 정의에서 등장인물은 둘이다. 상호작용 규칙을 소유한 Mediator와, 서로를 모르고 중재자에게 상태 변화를 알리기만 하는 Colleague다. Colleague는 중재자 참조를 필드로 갖고, 중재자는 Colleague 목록을 갖는다. 양방향 의존이지만 Colleague끼리의 의존은 사라진다. 참여자는 "내가 바뀌었다"고 통보하고, 그 결과 누구를 어떻게 바꿀지는 중재자가 결정한다.

구현은 크게 두 갈래로 나뉜다.

고전 중재자는 중재자가 참여자 참조를 직접 보유하고 참여자가 중재자 메서드를 명시적으로 호출한다. 흐름이 클래스 하나에 모여 있어 추적이 쉽고, 순서·조건 같은 조정 로직을 한곳에서 통제할 수 있다. 대신 참여자가 특정 중재자 인터페이스에 묶이고, 규칙이 늘수록 중재자가 비대해진다.

이벤트 기반 중재자는 참여자가 중재자를 모른다. 참여자는 이벤트 객체를 발행할 뿐이고, 이벤트 버스가 등록된 리스너에게 전달한다. Spring의 `ApplicationEventPublisher`와 `@EventListener`가 이 역할을 한다. 발행자는 수신자를 import조차 하지 않으므로 결합이 가장 느슨하지만, 처리 흐름이 리스너 여러 개로 분산되어 한 이벤트의 결과를 한눈에 보기 어렵다.

| 구분 | 고전 중재자 | 이벤트 기반 중재자 |
|---|---|---|
| 연결 | 참여자와 중재자의 직접 참조 | 이벤트 발행과 리스너 등록 |
| 참여자의 인식 | 중재자를 안다 | 아무도 모른다 |
| 로직 위치 | 중재자 클래스 한곳 | 분산된 리스너 메서드 |
| 약점 | 중재자 비대화 | 전체 흐름 파악 난이도 |
| 적합한 곳 | 한 화면 안의 위젯 조정, 채팅방 | 도메인 간 결합 분리, 부수 효과 처리 |

옵저버와의 경계는 다음과 같다. 옵저버는 주체 하나가 관찰자 여럿에게 일방향으로 통지하는 구조이고, 중재자는 참여자 여럿 사이의 다대다 조정 규칙을 소유한다. 이벤트 기반 중재자는 옵저버를 전달 수단으로 쓰되 조정 로직을 리스너에 두는 조합이다.

## 코드

고전 형태의 채팅방이다. `User`는 `ChatRoom`만 알고, 누구에게 전달할지는 `ChatRoom`이 결정한다.

```java
public interface ChatMediator {
    void send(String message, User from);
    void join(User user);
}

public final class User {
    private final String name;
    private final ChatMediator mediator;

    public User(String name, ChatMediator mediator) {
        this.name = name;
        this.mediator = mediator;
        mediator.join(this);
    }

    public void send(String message) {
        mediator.send(message, this);
    }

    public void receive(String message, String from) {
        System.out.printf("[%s] %s: %s%n", name, from, message);
    }

    public String name() { return name; }
}

public final class ChatRoom implements ChatMediator {
    private final List<User> users = new ArrayList<>();

    @Override
    public void join(User user) { users.add(user); }

    @Override
    public void send(String message, User from) {
        users.stream()
             .filter(u -> u != from)
             .forEach(u -> u.receive(message, from.name()));
    }
}
```

Spring 이벤트로 구성한 이벤트 기반 중재자다. `OrderService`는 메일이나 재고 컴포넌트를 참조하지 않고 이벤트만 발행한다. 후속 처리는 트랜잭션 커밋 이후에만 실행되도록 `@TransactionalEventListener`를 쓴다.

```java
public record OrderCompletedEvent(Long orderId, Long memberId) {}

@Service
public class OrderService {
    private final OrderRepository orders;
    private final ApplicationEventPublisher publisher;

    public OrderService(OrderRepository orders, ApplicationEventPublisher publisher) {
        this.orders = orders;
        this.publisher = publisher;
    }

    @Transactional
    public Long place(Long memberId, List<Long> itemIds) {
        Order order = orders.save(Order.of(memberId, itemIds));
        publisher.publishEvent(new OrderCompletedEvent(order.getId(), memberId));
        return order.getId();
    }
}

@Component
public class OrderCompletedHandlers {
    private final MailSender mail;
    private final PointService points;

    public OrderCompletedHandlers(MailSender mail, PointService points) {
        this.mail = mail;
        this.points = points;
    }

    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void sendReceipt(OrderCompletedEvent e) {
        mail.sendReceipt(e.memberId(), e.orderId());
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void accumulate(OrderCompletedEvent e) {
        points.accumulateFor(e.orderId());
    }
}
```

## 실무에서 걸리는 지점

- 리스너는 기본이 동기 실행이다. ==`@EventListener`는 발행자와 같은 스레드에서 순차 실행되며 리스너 예외가 `publishEvent` 호출부로 그대로 전파된다.== 메일 발송 실패가 주문 저장까지 롤백시키는 구조를 원하지 않는다면 `@Async`로 분리하거나 리스너 안에서 예외를 삼켜야 한다. `@Async`는 `@EnableAsync`가 없으면 조용히 동기로 동작한다.
- `AFTER_COMMIT` 리스너는 커밋이 끝난 트랜잭션 자원 위에서 실행된다. ==이 단계에서 별도 트랜잭션 없이 JPA 쓰기를 하면 예외 없이 flush만 건너뛰어 데이터가 남지 않는다.== 리스너에서 DB를 갱신해야 하면 `REQUIRES_NEW`를 명시한다.
- 발행 시점에 트랜잭션이 없으면 `@TransactionalEventListener`는 실행되지 않는다. 테스트에서 `@Transactional`을 붙인 채 검증하면 커밋이 일어나지 않아 리스너가 호출되지 않는 것도 같은 이유다.
- Spring 이벤트는 프로세스 메모리 안에서만 산다. ==`@Async` 리스너가 큐에 올라간 상태에서 프로세스가 내려가면 이벤트는 유실되고 재시도 기록도 남지 않는다.== 반드시 처리되어야 하는 후속 작업은 이벤트 대신 아웃박스 테이블에 기록하고 별도 워커가 소비하도록 한다.
- 고전 중재자는 규칙이 늘수록 조건 분기가 한 클래스에 쌓인다. 화면 하나에 위젯 열댓 개를 조정하는 수준이 넘어가면 상태 패턴으로 분기를 옮기거나 중재자를 기능 단위로 쪼개야 한다. 리스너 여러 개의 실행 순서가 의미를 갖는다면 `@Order`로 고정하되, 순서 의존 자체가 이벤트 분리가 잘못됐다는 신호일 때가 많다.

## 관련 글

- [옵저버와 Pub/Sub — 직접 구독과 브로커 경유의 차이](/notes/design-patterns/observer-pubsub/)
- [퍼사드 — 복잡한 서브시스템에 단일 진입점](/notes/design-patterns/facade/)
- [상태 — 상태별 분기를 객체로 옮기기](/notes/design-patterns/state/)
