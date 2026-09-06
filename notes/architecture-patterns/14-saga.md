---
title: "사가 — 코레오그래피와 오케스트레이션"
series: architecture-patterns
part: "서비스 통신"
order: 14
summary: "여러 서비스에 걸친 트랜잭션을 로컬 트랜잭션과 보상 트랜잭션의 연쇄로 나누고, 그 흐름을 이벤트로 이을지 중앙 관리자가 지휘할지 정한다."
tags: [Saga, Choreography, Orchestration, Compensating Transaction, Kafka]
sources: [https://jinwookoh.tistory.com/232]
updated: 2026-09-06
---

주문·결제·배송 서비스가 각자 다른 데이터베이스를 쓰면 하나의 트랜잭션으로 세 저장소를 묶을 수 없다. 결제가 승인된 뒤 배송 정보 저장이 실패하면 결제만 완료된 상태로 남는다. 단일 데이터베이스에서는 롤백 한 번으로 정리되던 문제가, 서비스마다 저장소가 분리된 구조에서는 이미 커밋된 결과를 되돌릴 방법이 없는 문제로 바뀐다. 2PC 같은 분산 트랜잭션은 참여자 전체를 잠그고 코디네이터 장애에 취약해서 서비스 간 통신에는 거의 쓰이지 않는다. 사가는 이 상황에서 원자성을 포기하는 대신, 각 서비스의 로컬 트랜잭션을 순서대로 실행하고 중간에 실패하면 이미 완료된 단계를 되돌리는 보상 트랜잭션을 역순으로 실행해 최종 일관성을 맞춘다.

## 핵심 개념

사가는 로컬 트랜잭션 T1, T2, …, Tn의 순열이다. 각 Ti는 자기 서비스의 데이터베이스에서 정상적으로 커밋된다. Tk가 실패하면 T(k-1)부터 T1까지 각각에 대응하는 보상 트랜잭션 C(k-1), …, C1을 실행한다. 보상은 롤백이 아니라 별도의 비즈니스 연산이다. 결제 승인의 보상은 환불이고, 재고 차감의 보상은 재고 복원이다. 이미 커밋된 결과를 취소하는 새 커밋이므로, ==보상 트랜잭션은 실패해서는 안 되며 실패하면 성공할 때까지 재시도할 수 있도록 멱등하게 설계해야 한다==.

사가의 각 단계는 성격에 따라 세 종류로 나뉜다. 보상 가능 트랜잭션은 뒤따르는 단계가 실패하면 되돌릴 수 있는 단계다. 피벗 트랜잭션은 성공하면 사가가 끝까지 완료되는 것이 보장되는 분기점이며, 보통 결제 승인처럼 되돌리기 어렵거나 비용이 큰 단계를 여기에 둔다. 재시도 가능 트랜잭션은 피벗 이후에 오는 단계로, 실패해도 보상하지 않고 성공할 때까지 재시도한다. 이 구분을 정하면 어떤 단계에 보상 로직을 써야 하는지가 결정된다.

흐름을 누가 관리하느냐에 따라 두 방식으로 갈린다.

코레오그래피는 중앙 관리자 없이 각 서비스가 이벤트를 발행하고 구독하며 다음 단계를 스스로 수행한다. 주문 서비스가 OrderCreated를 발행하면 결제 서비스가 이를 받아 결제하고 PaymentCompleted를 발행하며, 배송 서비스가 다시 이를 받아 배송을 등록한다. 실패도 이벤트로 전파된다. PaymentFailed를 주문 서비스가 받아 주문을 취소하는 식이다. 사가 전체의 정의가 어디에도 존재하지 않고 각 서비스의 리스너에 흩어져 있다.

오케스트레이션은 사가 오케스트레이터가 상태를 갖고 각 참여자에게 명령을 보낸다. 오케스트레이터는 결제 서비스에 결제 명령을 보내고 응답을 받은 뒤 배송 서비스에 배송 명령을 보낸다. 어느 단계가 실패하면 오케스트레이터가 어떤 보상을 어떤 순서로 보낼지 결정한다. 참여자는 명령을 처리하고 결과를 회신할 뿐 다른 참여자를 모른다.

| 구분 | 코레오그래피 | 오케스트레이션 |
|---|---|---|
| 흐름 정의 위치 | 각 서비스의 이벤트 핸들러에 분산 | 오케스트레이터 한 곳 |
| 통신 | 이벤트 발행·구독 | 명령 전송과 응답 |
| 참여자 간 결합 | 이벤트 스키마를 통해 간접 결합 | 참여자는 오케스트레이터만 안다 |
| 현재 상태 파악 | 각 서비스 로그를 모아야 한다 | 오케스트레이터 상태 테이블 조회 |
| 순환 의존 위험 | 있음 | 낮음 |
| 적합한 규모 | 단계 2~4개의 단순한 흐름 | 단계가 많고 분기가 복잡한 흐름 |

## 코드

코레오그래피 방식의 결제 서비스 리스너다. 주문 생성 이벤트를 받아 결제하고, 결과에 따라 완료 또는 실패 이벤트를 발행한다. 이벤트 발행은 트랜잭셔널 아웃박스를 통한다고 가정한다.

```java
@Component
public class PaymentSagaListener {

    private final PaymentService paymentService;
    private final OutboxPublisher outbox;

    public PaymentSagaListener(PaymentService paymentService, OutboxPublisher outbox) {
        this.paymentService = paymentService;
        this.outbox = outbox;
    }

    @KafkaListener(topics = "order.created", groupId = "payment")
    @Transactional
    public void on(OrderCreated event) {
        if (paymentService.alreadyProcessed(event.orderId())) {
            return;
        }
        try {
            paymentService.approve(event.orderId(), event.amount());
            outbox.publish("payment.completed", new PaymentCompleted(event.orderId()));
        } catch (PaymentDeclinedException e) {
            outbox.publish("payment.failed", new PaymentFailed(event.orderId(), e.reason()));
        }
    }

    @KafkaListener(topics = "shipping.failed", groupId = "payment")
    @Transactional
    public void compensate(ShippingFailed event) {
        paymentService.refund(event.orderId());
        outbox.publish("payment.refunded", new PaymentRefunded(event.orderId()));
    }
}
```

오케스트레이션 방식의 오케스트레이터다. 사가 상태를 엔티티로 영속화하고, 각 단계의 응답 메시지를 받을 때마다 다음 단계로 진행하거나 보상을 시작한다. 단계 전이는 상태 테이블에 기록하므로 인스턴스가 재기동해도 이어서 진행할 수 있다.

```java
@Entity
public class OrderSaga {
    @Id
    private UUID sagaId;
    private Long orderId;
    @Enumerated(EnumType.STRING)
    private SagaStep step;          // PAYMENT, SHIPPING, COMPLETED, COMPENSATING, FAILED
    @Version
    private long version;
    // getters, transition methods 생략
}

@Service
public class OrderSagaOrchestrator {

    private final OrderSagaRepository sagas;
    private final KafkaTemplate<String, Object> kafka;

    public OrderSagaOrchestrator(OrderSagaRepository sagas, KafkaTemplate<String, Object> kafka) {
        this.sagas = sagas;
        this.kafka = kafka;
    }

    @Transactional
    public UUID start(Long orderId, long amount) {
        OrderSaga saga = OrderSaga.begin(orderId);
        sagas.save(saga);
        kafka.send("payment.command", saga.getSagaId().toString(),
                new ApprovePayment(saga.getSagaId(), orderId, amount));
        return saga.getSagaId();
    }

    @KafkaListener(topics = "payment.reply", groupId = "order-saga")
    @Transactional
    public void onPaymentReply(PaymentReply reply) {
        OrderSaga saga = sagas.findById(reply.sagaId()).orElseThrow();
        if (saga.getStep() != SagaStep.PAYMENT) {
            return; // 중복 또는 지연 도착한 응답
        }
        if (reply.success()) {
            saga.moveTo(SagaStep.SHIPPING);
            kafka.send("shipping.command", saga.getSagaId().toString(),
                    new CreateShipment(saga.getSagaId(), saga.getOrderId()));
        } else {
            saga.moveTo(SagaStep.FAILED);
            kafka.send("order.command", saga.getSagaId().toString(),
                    new RejectOrder(saga.getOrderId(), reply.reason()));
        }
    }

    @KafkaListener(topics = "shipping.reply", groupId = "order-saga")
    @Transactional
    public void onShippingReply(ShippingReply reply) {
        OrderSaga saga = sagas.findById(reply.sagaId()).orElseThrow();
        if (saga.getStep() != SagaStep.SHIPPING) {
            return;
        }
        if (reply.success()) {
            saga.moveTo(SagaStep.COMPLETED);
            kafka.send("order.command", saga.getSagaId().toString(),
                    new ConfirmOrder(saga.getOrderId()));
        } else {
            saga.moveTo(SagaStep.COMPENSATING);
            kafka.send("payment.command", saga.getSagaId().toString(),
                    new RefundPayment(saga.getSagaId(), saga.getOrderId()));
        }
    }
}
```

## 실무에서 걸리는 지점

- 격리성 부재. 사가는 ACID 중 I를 제공하지 않는다. 결제가 끝나고 배송 등록을 기다리는 사이에 다른 요청이 그 주문을 읽으면 아직 확정되지 않은 중간 상태를 본다. ==사가가 진행 중인 데이터에는 PENDING 같은 시맨틱 락 상태를 두고, 그 상태에서는 갱신·취소 요청을 거부하거나 지연시켜야 한다==. 그렇지 않으면 보상 중인 주문을 사용자가 동시에 변경하는 이상 갱신이 발생한다.
- 중복 전달. 브로커는 최소 한 번 전달을 보장하므로 같은 이벤트나 명령이 두 번 도착한다. 참여자와 오케스트레이터 모두 사가 ID 또는 주문 ID로 처리 여부를 확인하는 멱등 처리가 필요하다. 오케스트레이터가 현재 단계와 맞지 않는 응답을 무시하는 것도 같은 이유다.
- 보상 불가능한 단계. 이메일 발송이나 외부 결제망 정산처럼 되돌릴 수 없는 작업은 피벗 이후로 미루거나 사가의 마지막에 둔다. 앞쪽에 두면 이후 단계가 실패했을 때 되돌릴 수 없는 부수 효과가 남는다.
- 코레오그래피의 순환 의존. 서비스가 늘어나면 A가 발행한 이벤트를 C가 받고 C의 이벤트를 다시 A가 받는 경로가 생긴다. 흐름이 어디에도 문서화돼 있지 않아 새 참여자가 이벤트를 구독하는 것만으로 사가의 의미가 바뀔 수 있다. 단계가 다섯을 넘거나 분기 조건이 생기면 오케스트레이션으로 옮기는 편이 유지보수 비용이 낮다.
- 오케스트레이터의 가용성과 타임아웃. 오케스트레이터는 단일 장애점이 되기 쉬우므로 상태를 데이터베이스에 두고 여러 인스턴스로 실행한다. 참여자의 응답이 오지 않는 경우를 위해 단계별 타임아웃과 이를 감시하는 스케줄러가 없으면 사가가 영원히 진행 중 상태로 남는다. 단계가 많고 재시도·타임아웃 정책이 복잡하면 Temporal이나 Camunda 같은 워크플로 엔진이 직접 구현보다 안정적이다.

## 관련 글

- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
- [메시징 — Point-to-Point와 Pub/Sub, 소비 모델](/notes/architecture-patterns/messaging/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
