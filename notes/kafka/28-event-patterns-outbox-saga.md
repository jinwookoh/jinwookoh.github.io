---
title: "이벤트 패턴 — Outbox·Saga·Fan-out"
series: kafka
part: "Spring과 패턴"
order: 28
summary: "DB와 Kafka를 한 트랜잭션에 묶을 수 없을 때 Outbox·Saga·Fan-out이 원자성과 일관성을 어떻게 대신 보장하는가"
tags: [Outbox, Saga, Fan-out, CDC, Debezium]
sources: [2026-05-03-kafka-outbox.md, 2026-05-03-kafka-saga-choreography.md, 2026-05-03-kafka-saga-orchestrator.md, 2026-05-03-kafka-fan-out-in.md, 2026-05-04-javaex-sns-kafka-outbox.md]
updated: 2026-08-29
---

서비스마다 DB를 따로 두면 두 가지 원자성이 깨진다. 첫째, 한 서비스 안에서 DB 커밋과 Kafka 발행은 같은 트랜잭션이 아니다. DB는 저장됐는데 발행이 실패하면 이벤트가 유실되고, 발행 뒤 롤백되면 존재하지 않는 데이터에 대한 이벤트가 남는다. Kafka는 XA 2PC에 참여하지 않으므로 코디네이터로 묶을 수도 없다. 둘째, 주문·결제·재고처럼 여러 서비스에 걸친 트랜잭션은 분산 ACID로 처리할 수 없고, 한 단계가 실패하면 이미 커밋된 앞 단계를 되돌려야 한다. ==전자를 Outbox가, 후자를 Saga가 해결하며, 메시지를 나누고 모으는 배관이 Fan-out과 Fan-in이다.==

## 핵심 개념

**Fan-out / Fan-in.** Fan-out은 이벤트 하나를 여러 컨슈머가 받는 구조다. 단일 토픽에 서비스별 Consumer Group을 붙이는 방식이 가장 단순하지만, 보존 기간·ACL·스키마 진화가 토픽 단위로 묶이므로 도메인별 토픽으로 분리하는 편이 경계가 명확하다. Fan-in은 여러 토픽의 결과를 모아 최종 상태를 결정하는 구조다. 응답은 시점이 제각각이므로 `Flux.zip`처럼 인덱스로 묶는 연산자는 맞지 않고, 주문 ID를 키로 DB에 상태를 누적해야 한다.

**Saga.** 각 서비스가 자기 DB에서 로컬 트랜잭션을 커밋하고, 실패 시 앞 단계에 보상 트랜잭션을 실행해 되돌린다. ACID가 아니라 최종 일관성이며, 보상이 가능한 도메인에만 적용한다. 구현은 두 가지다.

| 항목 | Choreography | Orchestration |
|:---|:---|:---|
| 메시지 성격 | 도메인 이벤트(사실 통보) | 명령 + 응답(지시) |
| 흐름 위치 | 각 서비스에 분산 | 오케스트레이터 한 곳 |
| 보상 방식 | `OrderCanceled`를 보고 각자 판단 | `RefundPayment` 명령을 명시 발행 |
| 결합도 / SPOF | 낮음 / 없음 | 중앙 집중 / 오케스트레이터 |
| 적합 규모 | 서비스 소수·단순 흐름 | 서비스 5개 이상·분기 많음 |

Choreography에서는 Order 서비스가 `OrderCreated`를 발행하고, Payment·Inventory가 결과를 각자 토픽에 올리면 Order 서비스가 Fan-in으로 모아 `OrderCompleted` 또는 `OrderCanceled`를 낸다. Orchestration에서는 오케스트레이터가 서비스별 `*-request` 토픽에 명령을 보내고 `*-response` 응답마다 다음 단계를 결정하며, 현재 단계를 워크플로 테이블에 저장해 재시작 후 이어간다. 사실상 상태 머신이다.

**Transactional Outbox.** 비즈니스 데이터와 발행할 이벤트를 같은 DB 트랜잭션에서 본 테이블과 outbox 테이블에 저장한다. DB 커밋이 곧 발행 확정이며, 실제 전송은 별도 릴레이가 맡는다. Polling Publisher는 스케줄러가 outbox를 읽어 발행하고 삭제하는 단순한 방식이다. CDC는 Debezium이 PostgreSQL WAL(`wal_level=logical`)에서 outbox INSERT를 감지하고 `EventRouter` SMT로 `aggregate_type`을 토픽명에 매핑해 발행한다. 폴링 지연과 조회 부하가 없지만 Kafka Connect 운영 부담이 따른다. 어느 쪽이든 at-least-once이므로 컨슈머의 멱등 처리가 전제다.

## 코드

주문 저장과 outbox 저장을 한 트랜잭션에 묶는다. 이벤트를 `sealed interface` + `record`로 정의하면 switch 패턴 매칭으로 누락 없이 분기할 수 있다.

```java
public sealed interface OrderEvent permits OrderCreated, OrderCompleted, OrderCanceled {}
public record OrderCreated(String orderId, BigDecimal amount, String userId) implements OrderEvent {}
public record OrderCompleted(String orderId) implements OrderEvent {}
public record OrderCanceled(String orderId, String reason) implements OrderEvent {}

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final OutboxRepository outboxRepository;
    private final ObjectMapper objectMapper;

    public OrderService(OrderRepository orderRepository, OutboxRepository outboxRepository,
                        ObjectMapper objectMapper) {
        this.orderRepository = orderRepository;
        this.outboxRepository = outboxRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public void createOrder(CreateOrderRequest req) throws JsonProcessingException {
        Order order = orderRepository.save(Order.from(req));
        OrderEvent event = new OrderCreated(order.getId(), order.getAmount(), order.getUserId());
        outboxRepository.save(new OutboxEvent(
                "Order", order.getId(), "OrderCreated",
                objectMapper.writeValueAsString(event)));
    }
}
```

Polling Publisher는 `FOR UPDATE SKIP LOCKED`로 잠근 행만 가져가므로 여러 인스턴스가 같은 행을 중복 발행하지 않는다. 브로커 ack를 `get()`으로 기다린 뒤 삭제한다.

```java
public interface OutboxRepository extends JpaRepository<OutboxEvent, UUID> {
    @Query(value = """
            SELECT * FROM outbox_events
            ORDER BY created_at
            LIMIT :limit
            FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<OutboxEvent> lockBatch(@Param("limit") int limit);
}

@Component
public class OutboxRelay {
    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OutboxRelay(OutboxRepository outboxRepository, KafkaTemplate<String, String> kafkaTemplate) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
    }

    @Scheduled(fixedDelay = 1000)
    @Transactional
    public void relay() {
        for (OutboxEvent e : outboxRepository.lockBatch(100)) {
            try {
                kafkaTemplate.send(e.getAggregateType().toLowerCase() + "-events",
                        e.getAggregateId(), e.getPayload()).get(5, TimeUnit.SECONDS);
                outboxRepository.delete(e);
            } catch (Exception ex) {
                throw new IllegalStateException("outbox relay failed: " + e.getId(), ex);
            }
        }
    }
}
```

Orchestration Saga의 응답 처리다. 재고 실패면 결제에 보상 명령을 보내며, 명령도 outbox를 거쳐야 워크플로 상태 갱신과 원자성이 맞는다.

```java
@Component
public class InventoryResponseHandler {
    private final WorkflowRepository workflowRepository;
    private final OutboxRepository outboxRepository;
    private final ObjectMapper objectMapper;

    public InventoryResponseHandler(WorkflowRepository workflowRepository,
                                    OutboxRepository outboxRepository, ObjectMapper objectMapper) {
        this.workflowRepository = workflowRepository;
        this.outboxRepository = outboxRepository;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(topics = "inventory-response", groupId = "order-orchestrator")
    @Transactional
    public void handle(InventoryResponse response) throws JsonProcessingException {
        OrderWorkflow wf = workflowRepository.findById(response.orderId()).orElseThrow();
        if (wf.state() != WorkflowState.INVENTORY_PENDING) {
            return; // 중복 수신 또는 순서 역전 — 상태 머신이 거부한다
        }
        switch (response) {
            case InventoryDeducted ok -> {
                wf.transition(WorkflowState.SHIPPING_PENDING);
                enqueue("Shipping", ok.orderId(), new ScheduleShipping(ok.orderId()));
            }
            case InventoryDeclined fail -> {
                wf.transition(WorkflowState.COMPENSATING);
                enqueue("Payment", fail.orderId(), new RefundPayment(fail.orderId()));
            }
        }
    }

    private void enqueue(String aggregate, String id, Object command) throws JsonProcessingException {
        outboxRepository.save(new OutboxEvent(aggregate, id,
                command.getClass().getSimpleName(), objectMapper.writeValueAsString(command)));
    }
}
```

## 실무에서 걸리는 지점

- **outbox 테이블 비대화.** 폴링 방식은 발행 후 삭제하면 되지만 CDC 방식은 Debezium이 읽은 뒤에도 행이 남는다. `created_at` 기준 RANGE 파티션과 pg_partman으로 월별 파티션을 DETACH/DROP하는 편이 DELETE보다 부하가 적다.
- **직렬화 타입 헤더.** Spring Kafka `JsonSerializer`는 기본으로 Java 클래스명을 헤더에 넣으므로 패키지가 다른 컨슈머는 역직렬화에 실패한다. 프로듀서에 `spring.json.add.type.headers=false`, 컨슈머에 `spring.json.trusted.packages`를 설정하고 리스너 파라미터 타입으로 역직렬화한다.
- **`max.block.ms`.** 브로커에 연결되지 않으면 `KafkaTemplate.send()`가 메타데이터 조회에서 기본 60초 블로킹한다. Outbox를 쓰면 이 지연이 릴레이로 격리되지만, 직접 발행 경로가 남아 있다면 값을 수 초로 줄여야 한다.
- ==**멱등성과 순서.** 재전달과 리밸런스로 같은 이벤트가 두 번 올 수 있다.== 처리 여부를 `orderId` 기준으로 DB에 남기고, 오케스트레이터는 현재 상태에서 허용되지 않는 응답을 무시한다. 같은 주문의 이벤트는 파티션 키를 `orderId`로 고정해 순서를 보장한다.
- **Choreography의 추적 난이도.** 흐름이 서비스마다 흩어져 멈춘 단계를 찾기 어렵고 순환 구독이 생기기 쉽다. 헤더에 correlation id를 실어 분산 추적과 연결하고, 분기가 늘면 Orchestration으로 전환한다.

## 관련 글

- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Spring Kafka — 배치·에러·트랜잭션·테스트](/notes/kafka/spring-kafka/)
- [Connect — Connector·SMT·커스텀 개발](/notes/kafka/connect-connectors-smt-custom/)
