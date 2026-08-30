---
title: "Kafka란 — 이벤트 스트리밍과 활용 영역"
series: kafka
part: "기초"
order: 1
summary: "Kafka는 소비 후에도 보존되는 분산 커밋 로그이며, 시스템 간 데이터 통합과 이벤트 스트리밍의 허브 역할을 한다"
tags: [Kafka, Event Streaming, KRaft, RabbitMQ, Event-Driven Architecture]
sources: [data-infra/2026-05-17-kafka-intro.md, data-infra/2026-05-17-kafka-use-cases.md, 2026-05-02-kafka-basics.md, 2026-05-03-kafka-fundamentals.md]
updated: 2026-08-29
---

소스 시스템 4개가 타겟 시스템 6개에 데이터를 보내려면 24개의 통합 코드가 필요하고, 연결마다 프로토콜과 포맷이 다르며, 한쪽의 스키마 변경이 모든 곳을 깨뜨린다. 동기 REST 호출로 마이크로서비스를 엮으면 한 서비스의 장애가 전체를 멈춘다. 중앙 허브를 두어 N×M 연결을 N+M으로 줄이고, 호출 대신 이벤트를 발행해 관심 있는 쪽이 각자 반응하게 만드는 것이 해법이며, Kafka는 그 허브의 사실상 표준이다.

## 핵심 개념

Apache Kafka는 분산 이벤트 스트리밍 플랫폼이다. 이벤트 스트림을 발행·구독하고, 디스크에 내구성 있게 저장하며, 실시간 또는 사후에 처리한다. LinkedIn이 사용자 활동 로그를 초당 수십만 건 수집하기 위해 커밋 로그 개념을 분산 환경에 적용해 만들었고, 2011년 Apache License 2.0으로 공개됐다.

Kafka는 메시지 큐의 빠른 버전이 아니라 append-only 분산 로그다. 전통 브로커와의 차이가 여기서 갈린다.

| 구분 | RabbitMQ·ActiveMQ | Kafka |
|:---|:---|:---|
| 메시지 보존 | 소비 시 삭제 | retention 기간 동안 영속 |
| 다중 구독 | 큐당 1회 소비 | 여러 Consumer Group이 독립적으로 읽음 |
| 재처리 | 불가 | offset 되감기 |
| 전달 모델 | Push | Pull (consumer가 속도 조절) |
| 라우팅 | exchange·binding으로 정교함 | topic·partition으로 단순 |
| 처리량 | 수만 건/초 | 수백만 건/초, 수평 확장 |

둘은 대체 관계가 아니다. 복잡한 라우팅과 작업 분배는 RabbitMQ, 대량 이벤트 로그·재처리·다중 소비자는 Kafka다. Redis Stream은 메모리 기반이라 소규모 큐에 그친다.

- **Record(Event)**: key(선택)·value(필수)·headers·timestamp로 이루어진 불변 사실의 기록. Record·Event·Message는 관점만 다를 뿐 같은 것을 가리킨다.
- **Topic**: 이벤트의 논리적 분류 단위. 다수 producer가 쓰고 다수 consumer가 읽는다.
- **Partition**: topic을 나눈 물리 단위이며 서로 다른 broker에 분산된다. 순서는 partition 안에서만 보장되고 같은 key는 항상 같은 partition으로 가므로, 순서가 필요하면 order_id 같은 비즈니스 ID를 key로 쓴다.
- **Broker**: Kafka 서버 한 대. 각 partition은 replication factor(보통 3)만큼 복제되어 leader 하나가 읽기·쓰기를 받는다.
- **Producer / Consumer**: 서로를 모른다. **Consumer Group**은 consumer 인스턴스 여러 개가 partition을 분담하는 단위다.

메타데이터 관리는 Zookeeper에서 KRaft로 넘어갔다. Zookeeper는 별도 클러스터 운영, 이중 보안 모델, 10만 파티션 부근의 확장 한계가 문제였다. KRaft는 Raft 합의를 Kafka 내부에 넣어 broker 일부가 controller quorum을 구성한다. 2.8 미리보기, 3.3 프로덕션 정식, 4.0에서 Zookeeper 모드가 제거됐다. ==3.0부터 producer 기본값은 `acks=all`, `enable.idempotence=true`다.==

활용 영역은 일곱 가지다. 마이크로서비스 간 비동기 메시징, 사용자 활동 추적(원래의 use case), 메트릭 전송(Prometheus가 저장·쿼리라면 Kafka는 transport), 로그 집계(Filebeat → Kafka → Elasticsearch), 스트림 처리(Kafka Streams·Flink), 이벤트 소싱(상태 변화를 저장해 재계산·감사), 분산 시스템의 commit log(log compaction으로 키별 최신 값 보존). API는 Producer·Consumer·Streams·Connect 네 가지이고, Schema Registry가 포맷 표준화를 맡는다.

## 코드

`spring-kafka`를 추가하고 브로커 주소를 지정하면 `KafkaTemplate`과 리스너 컨테이너가 자동 구성된다.

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: payment-service
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      properties:
        spring.json.trusted.packages: "com.example.order"
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
```

주문 생성 이벤트를 발행한다. orderId를 key로 주어 같은 주문의 이벤트가 같은 partition에 쌓이게 한다.

```java
package com.example.order;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;

@Service
public class OrderEventPublisher {

    public record OrderCreated(String orderId, String userId, long amount, Instant occurredAt) {}

    private final KafkaTemplate<String, OrderCreated> kafkaTemplate;

    public OrderEventPublisher(KafkaTemplate<String, OrderCreated> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(String orderId, String userId, long amount) {
        var event = new OrderCreated(orderId, userId, amount, Instant.now());
        kafkaTemplate.send("order-events", orderId, event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        throw new IllegalStateException("publish failed: " + orderId, ex);
                    }
                });
    }
}
```

결제 서비스가 구독한다. 재고·알림 서비스는 다른 group-id로 같은 이벤트를 독립적으로 받는다.

```java
package com.example.payment;

import com.example.order.OrderEventPublisher.OrderCreated;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.stereotype.Component;

@Component
public class PaymentListener {

    @KafkaListener(topics = "order-events", groupId = "payment-service")
    public void onOrderCreated(@Payload OrderCreated event,
                               @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                               @Header(KafkaHeaders.OFFSET) long offset) {
        // partition·offset은 로깅·추적용, 결제 처리는 event 기준
        process(event);
    }

    private void process(OrderCreated event) {
        // 결제 승인 로직
    }
}
```

## 실무에서 걸리는 지점

- **순서 보장 범위**: partition 안에서만 유지된다. key 없이 보내면 흩어지고, partition 수를 나중에 늘리면 같은 key의 해시 결과가 바뀌어 다른 partition으로 간다.
- **운반 계층이지 처리 계층이 아니다**: Kafka는 바이트 스트림을 저장·전달할 뿐 해석하거나 조회하지 않는다. 필터·집계는 Kafka Streams나 consumer 코드가, 쿼리는 데이터베이스나 ksqlDB가 맡는다.
- **도입 기준**: 초당 100건 미만의 단순 작업 큐라면 Redis Stream이나 SQS가 충분하다. 초당 1만 건 이상, 재처리, 다중 소비자, 영구 보존 중 둘 이상이 해당할 때 가치가 있다. 운영 인력이 부족하면 AWS MSK·Confluent Cloud로 시작한다.
- **스키마 없는 JSON**: Schema Registry 없이도 동작하지만 필드가 바뀌면 consumer가 깨진다. 여러 팀이 topic을 공유하면 Registry로 호환성을 강제한다.
- **구버전 자료의 Zookeeper 설정**: 4.0 이후 `zookeeper.connect`는 의미 없다. 기존 클러스터는 3.x에서 KRaft 마이그레이션을 마친 뒤 올린다.

## 관련 글

- [Quickstart — 설치·CLI·첫 메시지](/notes/kafka/quickstart-cli/)
- [Topic·Partition·Offset·Segment](/notes/kafka/topic-partition-offset-segment/)
- [설계 철학 — 왜 디스크·배치·Zero-Copy인가](/notes/kafka/design-philosophy/)
