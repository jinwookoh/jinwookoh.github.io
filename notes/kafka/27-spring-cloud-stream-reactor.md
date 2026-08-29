---
title: "Spring Cloud Stream·StreamBridge·Reactor Kafka"
series: kafka
part: "Spring과 패턴"
order: 27
summary: "함수형 빈 바인딩·StreamBridge 동적 발행·Reactor Kafka 백프레셔 파이프라인을 언제 어떻게 쓰는지 정리한다"
tags: [Spring Cloud Stream, StreamBridge, Reactor Kafka, Binder, Backpressure]
sources: [2026-05-03-kafka-scs-basics.md, 2026-05-03-kafka-scs-tips.md, 2026-05-03-kafka-streambridge.md, 2026-05-03-kafka-reactor.md]
updated: 2026-08-29
---

`@KafkaListener`와 `KafkaTemplate`으로 직접 붙이면 코드가 Kafka 설정과 토픽 이름에 고정된다. 브로커를 바꾸려면 리스너를 다시 짜야 하고, 목적지를 런타임에 정하는 라우팅은 토픽 수만큼 빈을 늘리는 방식으로밖에 표현하지 못한다. WebFlux 서비스에서는 `poll()` 루프의 블로킹 처리가 이벤트 루프 스레드를 점유하고, 소비가 처리보다 빠르면 백프레셔 없이 메모리가 늘어난다. Spring Cloud Stream은 메시징 추상화로, StreamBridge는 동적 목적지로, Reactor Kafka는 논블로킹과 백프레셔로 각각의 문제를 다룬다.

## 핵심 개념

Spring Cloud Stream(SCS)에서 **Binder**는 메시징 시스템과의 연결 구현체이고, **Binding**은 그 Binder가 만들어 주는 개별 입출력 채널이다. 코드는 Binding만 알고 Binder는 설정이 결정한다.

코드는 Spring Cloud Function 위에서 함수형 인터페이스 빈으로 작성한다. `Supplier<T>`는 출력 채널만, `Consumer<T>`는 입력 채널만, `Function<T, R>`은 둘 다 가진다. 바인딩 이름은 `<빈이름>-<in|out>-<인덱스>` 규칙으로 생성되며 인덱스는 0부터다. 빈 이름이 바인딩 이름의 접두사이므로 빈 이름을 바꾸면 YAML도 함께 바뀌어야 한다. 활성화할 함수는 `spring.cloud.function.definition`에 세미콜론으로 나열한다. `Function<Flux<T>, Flux<R>>` 형태로 등록하면 Binder가 Flux 전체를 한 번 넘기고 파이프라인 안에서 백프레셔가 동작한다.

**StreamBridge**는 함수형 빈이 고정 destination에 묶이는 한계를 푼다. `send(destination, payload)`로 목적지를 런타임에 결정하며, 컨테이너 빈이므로 주입해서 쓴다. 함수형 빈의 반환값은 정적 라우팅, StreamBridge 호출은 동적 라우팅이고 둘을 한 빈에서 섞어도 된다. `send()`는 동기 호출이라 리액티브 흐름에서는 `doOnNext` 같은 부수 효과 자리에 둔다.

**Reactor Kafka**는 Kafka 클라이언트를 `KafkaReceiver`와 `KafkaSender`로 감싼 라이브러리다. `receive()`가 `Flux<ReceiverRecord>`를 반환하고, `receiverOffset().acknowledge()`로 처리 완료를 표시하면 `commitInterval`·`commitBatchSize` 주기에 배치 커밋된다. `commit()`은 즉시 커밋한다. 다운스트림이 요청한 만큼만 레코드를 밀어내므로 `flatMap`의 동시성 값이 곧 소비 페이스가 된다. `KafkaSender.send()`는 `SenderResult`를 돌려주며 `exception()`이 null이면 성공이다.

## 코드

Function 빈과 바인딩 설정이다. 토픽과 group은 YAML이 정하고 코드는 변환만 담당한다.

```java
@Configuration
public class OrderFunctions {

    @Bean
    public Function<Flux<OrderEvent>, Flux<PaymentEvent>> orderToPayment() {
        return orders -> orders
            .flatMap(order -> Mono.fromCallable(() -> validate(order)), 8)
            .map(order -> new PaymentEvent(order.orderId(), order.amount()));
    }
}
```

```yaml
spring:
  cloud:
    function:
      definition: orderToPayment
    stream:
      bindings:
        orderToPayment-in-0:
          destination: order-events
          group: payment-service
        orderToPayment-out-0:
          destination: payment-events
      kafka:
        binder:
          brokers: localhost:9092
        bindings:
          orderToPayment-in-0:
            consumer:
              enable-dlq: true
              dlq-name: order-events.dlt
```

StreamBridge로 콘텐츠 기반 라우팅을 구현한 Consumer다. 헤더는 `Message<T>`로 넘긴다.

```java
@Configuration
public class OrderRouter {

    @Bean
    public Consumer<Message<OrderEvent>> routeOrder(StreamBridge bridge) {
        return message -> {
            OrderEvent order = message.getPayload();
            String destination = switch (order.type()) {
                case PRIORITY -> "priority-orders";
                case BULK -> "bulk-orders";
                case STANDARD -> "standard-orders";
            };
            bridge.send(destination, MessageBuilder.withPayload(order)
                .copyHeaders(message.getHeaders())
                .setHeader("routed-at", Instant.now().toString())
                .build());
        };
    }
}
```

Reactor Kafka로 읽기·처리·발행·ack를 한 파이프라인에 묶은 예다. `ReceiverOffset`을 `SenderRecord`의 correlation metadata로 실어 보내고 발행 결과를 받은 뒤 ack한다.

```java
@Component
public class OrderPipeline {

    private final KafkaReceiver<String, OrderEvent> receiver;
    private final KafkaSender<String, PaymentEvent> sender;
    private Disposable subscription;

    public OrderPipeline(ReceiverOptions<String, OrderEvent> ro,
                         SenderOptions<String, PaymentEvent> so) {
        this.receiver = KafkaReceiver.create(
            ro.subscription(List.of("order-events"))
              .commitInterval(Duration.ofSeconds(5))
              .commitBatchSize(100));
        this.sender = KafkaSender.create(so);
    }

    @PostConstruct
    void start() {
        subscription = receiver.receive()
            .groupBy(record -> record.partition())
            .flatMap(group -> group.concatMap(record ->
                process(record.value()).map(payment -> SenderRecord.create(
                    new ProducerRecord<>("payment-events", record.key(), payment),
                    record.receiverOffset()))))
            .as(sender::send)
            .doOnNext(result -> {
                if (result.exception() == null) {
                    result.correlationMetadata().acknowledge();
                }
            })
            .subscribe();
    }

    @PreDestroy
    void stop() {
        subscription.dispose();
        sender.close();
    }
}
```

## 실무에서 걸리는 지점

- **group 누락은 anonymous consumer가 된다.** `group`이 없으면 기동마다 새 그룹 ID를 받아 오프셋이 이어지지 않는다. 운영 바인딩은 group을 명시하고 `auto.offset.reset`도 의도에 맞게 고정한다.
- **Reactive Kafka Binder와 Reactor Kafka는 Kafka 트랜잭션을 지원하지 않는다.** `transaction-id-prefix`는 일반 Kafka Binder에서만 동작한다. 리액티브 스택에서 DB 반영과 발행을 원자적으로 묶어야 하면 Outbox 패턴을 쓴다.
- **`flatMap` 동시성은 반드시 명시한다.** 기본값이 사실상 무제한이라 백프레셔가 무력화된다. 순서가 필요하면 `concatMap`, 파티션 내 순서만 필요하면 `groupBy(partition)` 뒤 `concatMap`을 쓰고, 병렬 처리 시 재전달 중복에 대비해 처리를 멱등하게 만든다.
- **ack는 발행 성공 이후에 한다.** 처리 직후 ack하고 발행이 실패하면 메시지가 유실된다. 발행 실패 시 ack를 건너뛰어야 재처리로 이어져 at-least-once가 유지된다. SCS 수동 ack 모드에서도 `KafkaHeaders.ACKNOWLEDGMENT`를 꺼내 같은 순서를 지킨다.
- **이기종 소비자와 `__TypeId__` 헤더.** SCS의 JSON 변환기는 Java 클래스명을 헤더에 싣는다. Go·Python 소비자와 연동할 때는 `use-native-encoding: true`와 표준 serializer로 우회하고, Java 소비자는 `spring.json.trusted.packages`를 제한해 임의 클래스 역직렬화를 막는다. `enable-dlq`를 켜지 않으면 `max-attempts` 재시도 후에도 실패 메시지가 파티션을 막고, StreamBridge로 사용자별 토픽을 만들면 메타데이터 부담이 커지므로 사용자 단위 분리는 `partition-key-expression`으로 파티션에 맡긴다.

## 관련 글

- [Spring Kafka — 배치·에러·트랜잭션·테스트](/notes/kafka/spring-kafka/)
- [이벤트 패턴 — Outbox·Saga·Fan-out](/notes/kafka/event-patterns-outbox-saga/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
