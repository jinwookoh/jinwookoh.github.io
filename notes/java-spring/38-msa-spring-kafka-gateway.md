---
title: "MSA 입문 — Spring Kafka·Cloud Gateway"
series: java-spring
part: "운영·통합"
order: 38
summary: "서비스를 쪼갠 뒤 안쪽은 Kafka 이벤트로, 바깥쪽은 Gateway 단일 진입점으로 잇는 최소 구성을 정리한다"
tags: [MSA, Spring Kafka, Spring Cloud Gateway, Saga, 12-Factor]
sources: [2026-05-02-spring-microservices-kafka.md, 2026-05-02-spring-cloud-gateway-build.md, data-infra/2026-05-17-kafka-spring-kafka.md]
updated: 2026-08-29
---

모놀리식은 기능 하나를 고쳐도 전체를 재배포해야 하고, 한 기능에만 부하가 몰려도 전체를 확장해야 한다. 서비스를 도메인 단위로 쪼개면 새 문제가 둘 생긴다. 서비스끼리 REST로 직접 호출하면 수신 서비스가 내려간 순간 호출한 쪽도 실패하고, 클라이언트는 늘어난 서비스 주소를 전부 알아야 하며 인증·rate limit 같은 공통 처리가 서비스마다 중복된다. 앞은 Kafka 비동기 메시징으로, 뒤는 Spring Cloud Gateway 단일 진입점으로 푼다.

## 핵심 개념

마이크로서비스는 각 서비스가 자기 데이터베이스와 배포 주기를 독점하는 구조다. DB를 공유하면 한 스키마에 묶여 모놀리식의 단점이 돌아오므로 데이터 공유는 API나 이벤트로만 한다. 운영 원칙은 12-Factor App으로 정리되며, 그중 설정 외부화와 무상태 프로세스가 지켜져야 같은 이미지를 환경마다 설정만 바꿔 띄우고 스케일아웃할 수 있다.

Kafka는 메시지를 디스크에 보존하는 분산 이벤트 스트리밍 플랫폼이다. Topic은 메시지 분류 단위, Partition은 토픽의 물리적 분할이자 병렬 처리 단위, Offset은 파티션 안의 읽기 위치다. Consumer Group 안에서 한 파티션은 정확히 한 소비자만 담당하므로, ==소비자 수가 파티션 수를 넘으면 초과분은 놀게 되고 처리량을 올리려면 파티션 수부터 늘려야 한다==. 같은 키는 항상 같은 파티션으로 가므로 주문 ID를 키로 쓰면 그 주문의 메시지 순서가 보장된다. 클러스터 메타데이터는 KRaft가 관리한다.

Spring Kafka에서는 `KafkaTemplate`이 Producer, `@KafkaListener`가 Consumer, `NewTopic` 빈이 토픽 프로비저닝, `@RetryableTopic`이 재시도·DLT를 담당하며 `spring.kafka.*` 설정만으로 자동 구성된다.

| 항목 | REST (동기) | Kafka (비동기) |
|:---|:---|:---|
| 결합도 | 수신자 URL을 알아야 함 | 토픽 이름만 공유 |
| 수신자 장애 시 | 발신자도 실패 | 브로커에 남아 복구 후 처리 |
| 응답 | 즉시 | 별도 응답 토픽 필요 |
| 적합한 경우 | 즉각 응답이 필요한 조회 | 높은 처리량, 느슨한 결합 |

여러 서비스에 걸친 트랜잭션은 2PC 대신 Saga 패턴으로 처리한다. 각 서비스가 로컬 트랜잭션을 커밋하고 이벤트를 발행하며, 뒤 단계가 실패하면 앞 단계를 되돌리는 보상 트랜잭션을 발행한다. 이벤트로 협업하는 Choreography와 중앙 코디네이터가 지휘하는 Orchestration으로 나뉜다.

Spring Cloud Gateway는 Route·Predicate·Filter로 구성된다. Route는 요청 패턴과 대상 URI의 매핑 단위, Predicate는 경로·메서드·헤더로 매칭 여부를 판단하는 조건, Filter는 매칭된 요청과 응답을 가공하는 단계다. 한 Route의 Predicate 여러 개는 AND로 결합되고, `default-filters`는 모든 Route에 적용된다. ==기본 스타터 `spring-cloud-starter-gateway`는 WebFlux 기반이라 `spring-boot-starter-web`과 한 컨텍스트에 두면 기동하지 않는다.== MVC 스택이 필요하면 `spring-cloud-starter-gateway-server-webmvc`를 대신 쓴다.

## 코드

Kafka 설정은 환경 변수로 주입한다. `acks=all`과 멱등 프로듀서로 중복 발행을 막고 오프셋은 수동 커밋한다.

```yaml
spring:
  kafka:
    bootstrap-servers: ${KAFKA_BROKERS:localhost:9092}
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      acks: all
      properties:
        enable.idempotence: true
        compression.type: zstd
    consumer:
      group-id: ${spring.application.name}
      auto-offset-reset: earliest
      enable-auto-commit: false
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      properties:
        spring.json.trusted.packages: com.example.order.event
    listener:
      ack-mode: MANUAL
      concurrency: 3
```

토픽 이름은 상수로 관리하고 `NewTopic` 빈으로 프로비저닝한다. 소비 측은 `@RetryableTopic`으로 재시도 토픽과 DLT를 자동 생성해 실패를 격리한다.

```java
public record OrderCreatedEvent(UUID orderId, String customerRef, BigDecimal amount) {}

@Configuration
public class KafkaTopicConfig {

    public static final String ORDER_CREATED = "order-created";

    @Bean
    NewTopic orderCreatedTopic() {
        return TopicBuilder.name(ORDER_CREATED)
                .partitions(3)
                .replicas(3)
                .config(TopicConfig.RETENTION_MS_CONFIG, "604800000")
                .build();
    }
}

@Component
public class OrderEventPublisher {

    private static final Logger log = LoggerFactory.getLogger(OrderEventPublisher.class);
    private final KafkaTemplate<String, OrderCreatedEvent> kafkaTemplate;

    OrderEventPublisher(KafkaTemplate<String, OrderCreatedEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(OrderCreatedEvent event) {
        kafkaTemplate.send(KafkaTopicConfig.ORDER_CREATED, event.orderId().toString(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("send failed: orderId={}", event.orderId(), ex);
                        return;
                    }
                    RecordMetadata meta = result.getRecordMetadata();
                    log.debug("sent: partition={}, offset={}", meta.partition(), meta.offset());
                });
    }
}

@Component
public class InventoryListener {

    private final InventoryService inventoryService;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    InventoryListener(InventoryService inventoryService, KafkaTemplate<String, Object> kafkaTemplate) {
        this.inventoryService = inventoryService;
        this.kafkaTemplate = kafkaTemplate;
    }

    @RetryableTopic(
            attempts = "3",
            backoff = @Backoff(delay = 1000, multiplier = 2.0),
            dltTopicSuffix = "-dlt")
    @KafkaListener(topics = KafkaTopicConfig.ORDER_CREATED)
    public void onOrderCreated(OrderCreatedEvent event, Acknowledgment ack) {
        try {
            inventoryService.reserve(event.orderId(), event.amount());
            kafkaTemplate.send("inventory-reserved", event.orderId().toString(), event);
        } catch (InsufficientInventoryException e) {
            // 보상 트랜잭션: 재시도 대상이 아니므로 취소 이벤트를 발행하고 정상 종료한다
            kafkaTemplate.send("order-cancelled", event.orderId().toString(),
                    new OrderCancelledEvent(event.orderId(), "insufficient inventory"));
        }
        ack.acknowledge();
    }

    @DltHandler
    public void onDlt(OrderCreatedEvent event,
                      @Header(KafkaHeaders.EXCEPTION_MESSAGE) String reason) {
        // 영구 실패: 알림·수동 조치 대상으로 기록한다
    }
}
```

라우팅은 YAML로 선언하고, 서킷 브레이커·재시도·rate limit 같은 횡단 관심사를 한 곳에 모은다.

```yaml
spring:
  cloud:
    gateway:
      default-filters:
        - AddRequestHeader=X-Gateway-Trace, ${random.uuid}
      routes:
        - id: product-service
          uri: http://product-service:8080
          predicates:
            - Path=/api/v3/product/**
          filters:
            - StripPrefix=2
        - id: order-service
          uri: http://order-service:8080
          predicates:
            - Path=/api/v3/order/**
            - Method=GET,POST
          filters:
            - StripPrefix=2
            - name: CircuitBreaker
              args:
                name: orderBreaker
                fallbackUri: forward:/fallback/order
            - name: Retry
              args:
                retries: 3
                statuses: BAD_GATEWAY,SERVICE_UNAVAILABLE
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 10
                redis-rate-limiter.burstCapacity: 20
```

## 실무에서 걸리는 지점

- **`group-id`와 `auto-offset-reset`.** 그룹 ID가 없으면 오프셋이 추적되지 않아 재시작 시 읽기 시작점이 보장되지 않는다. ==`auto-offset-reset`은 커밋된 오프셋이 없을 때만 적용되며, 기본값 `latest`는 그 사이 발행된 메시지를 건너뛴다.==
- **JSON 역직렬화 실패.** `JsonDeserializer`는 `spring.json.trusted.packages`에 없는 타입을 거부하므로 `*` 대신 이벤트 패키지를 명시한다. 이벤트 클래스는 record를 쓰거나 기본 생성자를 둔다. ==역직렬화 오류는 `ErrorHandlingDeserializer`로 감싸지 않으면 같은 레코드에서 무한 반복된다.==
- **보상 트랜잭션과 재시도의 구분.** 재고 부족처럼 확정된 실패를 예외로 던지면 재시도 끝에 DLT로 가고 취소 이벤트는 발행되지 않는다. 일시적 장애만 예외로 전파하고 확정 실패는 보상 이벤트 발행 후 정상 커밋한다.
- **Aggregator 상태를 로컬 메모리에 두는 문제.** 분할 결과를 주문 단위로 모을 때 인스턴스별 `ConcurrentHashMap`에 버퍼를 두면 각자 부분 결과만 보게 되어 집계가 끝나지 않는다. 집계 상태는 DB·Redis나 Kafka Streams 상태 저장소에 둔다.
- **`StripPrefix` 세그먼트 수.** `/api/v3/order/123`을 백엔드에 `/order/123`으로 보내려면 `StripPrefix=2`다. 값이 틀리면 백엔드가 404를 돌려주며 라우팅 장애의 가장 흔한 원인이다. OR 조건이 필요하면 Route를 나눈다.
- **게이트웨이의 단일 장애점.** 게이트웨이는 무상태이므로 인스턴스를 여러 개 띄우고 앞에 로드밸런서나 Kubernetes Service를 둔다. `RequestRateLimiter`는 Redis가 없으면 동작하지 않는다.

## 관련 글

- [이벤트·비동기·스케줄링](/notes/java-spring/events-async-scheduling/)
- [배포 — Docker·Buildpack](/notes/java-spring/deploy-docker-buildpack/)
- [Actuator와 Micrometer](/notes/java-spring/actuator-micrometer/)
