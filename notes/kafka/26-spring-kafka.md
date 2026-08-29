---
title: "Spring Kafka — 배치·에러·트랜잭션·테스트"
series: kafka
part: "Spring과 패턴"
order: 26
summary: "KafkaTemplate과 @KafkaListener 위에 배치 리스너·DefaultErrorHandler·@RetryableTopic·KafkaTransactionManager·Testcontainers를 얹는 방법"
tags: [Spring Kafka, KafkaListener, RetryableTopic, KafkaTransactionManager, Testcontainers]
sources: [data-infra/2026-05-17-kafka-spring-kafka.md, 2026-05-03-kafka-spring.md, 2026-05-03-kafka-batch-error-tx.md]
updated: 2026-08-29
---

순정 Java 클라이언트만으로 Consumer를 운영하면 poll 루프·오프셋 커밋·역직렬화 실패·재시도·종료 처리를 애플리케이션 코드가 전부 떠안는다. 하나라도 빠지면 처리 불가 메시지 한 건이 파티션을 막거나, 커밋 전에 죽은 인스턴스가 같은 메시지를 다시 보내 중복 이벤트를 만든다. Spring Kafka는 이 반복 코드를 컨테이너와 어노테이션으로 흡수하지만, 감춰진 기본값(ack 모드, 격리 수준, 재시도 횟수)을 모르면 예측하기 어려운 동작이 나온다.

## 핵심 개념

Producer는 `KafkaTemplate`, Consumer는 `@KafkaListener`와 `MessageListenerContainer`, Admin은 `KafkaAdmin`, Streams는 `@EnableKafkaStreams`가 담당하며 Spring Boot 자동 구성이 `spring.kafka.*` 프로퍼티로 빈을 만든다.

**ack 모드.** 리스너는 `concurrency`만큼의 스레드로 실행되고 커밋 시점은 `ack-mode`가 정한다. 기본 `BATCH`는 poll 결과를 모두 처리한 뒤, `RECORD`는 레코드마다, `MANUAL`은 `Acknowledgment.acknowledge()` 시점에 커밋한다. `enable-auto-commit=false`가 전제다.

**배치 리스너.** `listener.type=batch`로 바꾸면 인자가 `List<T>`가 된다. ack가 배치 단위라 한 건의 실패가 배치 전체 재처리로 번지며, 부분 실패는 `BatchListenerFailedException`으로 실패 인덱스를 알려 그 지점부터만 재처리한다.

**에러 처리.** 기본 핸들러 `DefaultErrorHandler`는 즉시 재시도 9회 후 recoverer를 호출하며, 재시도 동안 파티션 소비가 멈춘다. `DeadLetterPublishingRecoverer`를 붙이면 `<topic>.DLT`로 원본과 예외 헤더가 발행된다. 역직렬화 실패는 `ErrorHandlingDeserializer`로 감싸야 레코드 단위 예외가 되어 DLT로 보낼 수 있다. `@RetryableTopic`은 실패 레코드를 `orders-retry-0`, `orders-retry-1` 같은 토픽으로 보내 지연 후 재소비하므로 원본 파티션이 계속 흐르고, 최종 실패는 `-dlt` 토픽과 `@DltHandler`로 간다. 대신 같은 키의 순서는 깨진다.

**트랜잭션.** `producer.transaction-id-prefix`를 지정하면 `KafkaTransactionManager`가 등록되고 컨테이너가 poll마다 트랜잭션을 연다. 리스너가 보낸 메시지와 소비 오프셋이 `sendOffsetsToTransaction`으로 한 트랜잭션에 묶이고, 예외가 나면 abort되어 재처리된다. 다운스트림 Consumer는 `isolation.level=read_committed`(기본 `read_uncommitted`)여야 abort된 레코드를 읽지 않는다. DB와 Kafka를 묶던 `ChainedKafkaTransactionManager`는 제거되었으므로 그 경우는 Outbox 패턴을 쓴다.

**테스트.** `@EmbeddedKafka`는 JVM 내 브로커라 빠르지만 실제 브로커와 차이가 있다. Testcontainers `KafkaContainer`는 실제 이미지를 쓰고 Spring Boot 3.1부터 `@ServiceConnection`이 주소를 자동 주입한다. 어느 쪽이든 `auto-offset-reset=earliest`가 아니면 구독 완료 전에 발행된 메시지를 놓친다.

## 코드

DefaultErrorHandler에 지수 BackOff와 DLT recoverer를 붙이고, 역직렬화 실패는 재시도하지 않게 한다.

```java
@Configuration
public class KafkaErrorConfig {

    @Bean
    public DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
        var recoverer = new DeadLetterPublishingRecoverer(template);
        var backOff = new ExponentialBackOffWithMaxRetries(3);
        backOff.setInitialInterval(1_000L);
        backOff.setMultiplier(2.0);
        var handler = new DefaultErrorHandler(recoverer, backOff);
        handler.addNotRetryableExceptions(DeserializationException.class);
        return handler;
    }
}
```

트랜잭션 리스너다. `transaction-id-prefix`가 설정된 상태에서 소비·저장·발행이 하나의 Kafka 트랜잭션으로 묶인다.

```java
@Component
public class OrderListener {

    private final KafkaTemplate<String, PaymentEvent> template;
    private final OrderRepository repository;

    public OrderListener(KafkaTemplate<String, PaymentEvent> template,
                         OrderRepository repository) {
        this.template = template;
        this.repository = repository;
    }

    @KafkaListener(topics = "orders", groupId = "order-workers")
    public void handle(@Payload OrderEvent event,
                       @Header(KafkaHeaders.RECEIVED_PARTITION) int partition) {
        repository.upsert(event);                       // 멱등 저장
        template.send("payments", event.orderId(), PaymentEvent.from(event));
        // 오프셋은 컨테이너가 같은 트랜잭션에 포함해 커밋
    }
}
```

Testcontainers 통합 테스트다. `@ServiceConnection`이 컨테이너 주소를 `spring.kafka.bootstrap-servers`에 연결한다.

```java
@SpringBootTest(properties = {
        "spring.kafka.consumer.auto-offset-reset=earliest",
        "spring.kafka.consumer.properties.isolation.level=read_committed"
})
@Testcontainers
class OrderListenerIT {

    @Container
    @ServiceConnection
    static KafkaContainer kafka = new KafkaContainer("apache/kafka-native:3.8.0");

    @Autowired KafkaTemplate<String, OrderEvent> template;
    @Autowired OrderRepository repository;

    @Test
    void consumesAndStoresOrder() {
        template.executeInTransaction(t ->
                t.send("orders", "o-1", new OrderEvent("o-1", 1_200)));

        Awaitility.await().atMost(Duration.ofSeconds(10))
                .untilAsserted(() -> assertThat(repository.findById("o-1")).isPresent());
    }
}
```

## 실무에서 걸리는 지점

- **기본 재시도가 파티션을 막는다.** 즉시 재시도 10회는 일시 장애에는 짧고 영구 실패에는 지연만 만든다. BackOff를 명시하고 재시도 무의미한 예외는 `addNotRetryableExceptions`로 바로 DLT로 보낸다.
- **`max.poll.interval.ms` 초과.** 블로킹 재시도나 배치 처리가 기본 5분을 넘으면 Consumer가 그룹에서 쫓겨나 리밸런스와 재처리가 반복된다. 재시도 총합을 이 값 아래로 둔다.
- **`@RetryableTopic`의 순서와 토픽 수.** 순서가 중요한 토픽에는 쓰지 않고 `SINGLE_TOPIC` 전략으로 토픽 수를 줄인다.
- **트랜잭션 비용.** poll마다 begin/commit이 오가 처리량이 떨어진다. 대부분은 at-least-once에 멱등 저장으로 충분하며, 트랜잭션은 Kafka에서 Kafka로 이어지는 read-process-write에만 쓴다.
- **`JsonDeserializer` 신뢰 패키지.** `spring.json.trusted.packages=*`는 헤더의 타입 정보로 임의 클래스를 역직렬화한다. 도메인 패키지로 제한한다.

## 관련 글

- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Spring Cloud Stream·StreamBridge·Reactor Kafka](/notes/kafka/spring-cloud-stream-reactor/)
- [이벤트 패턴 — Outbox·Saga·Fan-out](/notes/kafka/event-patterns-outbox-saga/)
