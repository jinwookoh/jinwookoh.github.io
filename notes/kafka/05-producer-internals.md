---
title: "Producer 동작 원리 — 파티션 선택·ACK·멱등성"
series: kafka
part: "설계와 내부"
order: 5
summary: "Producer가 파티션을 고르고 ACK를 기다리고 중복을 걸러내는 과정을 설정 단위로 따라가며, 안전한 기본 조합을 정한다."
tags: [Kafka, Producer, acks, Idempotent Producer, Partitioner]
sources: [data-infra/2026-05-17-kafka-design-producer.md, 2026-05-02-kafka-producers.md, 2026-05-03-kafka-producer-consumer.md]
updated: 2026-08-29
---

`producer.send()`는 호출 즉시 반환된다. 레코드는 내부 버퍼에 쌓이고 별도 스레드가 배치 단위로 전송한다. 이 비동기 경로를 통제하지 못하면 같은 주문의 이벤트 순서가 뒤섞이고, 낮은 ACK 수준에서 리더가 죽어 메시지가 조용히 사라지며, 재시도 중 ACK 유실로 같은 레코드가 두 번 저장된다. 파티션 선택·ACK·멱등성은 이 세 사고를 각각 막는 장치다.

## 핵심 개념

### 전송 경로

`ProducerRecord`는 Serializer에서 바이트 배열로 바뀌고, Partitioner가 파티션을 정한 뒤 Record Accumulator에 파티션별 배치로 누적된다. Sender 스레드가 배치를 리더 브로커에 보내고, 응답에 따라 콜백 또는 재시도가 이어진다. 배치는 `batch.size`(기본 16KB)가 차거나 `linger.ms`(기본 0)가 지나면 전송되고, `buffer.memory`(기본 32MB)가 가득 차면 `send()`가 블로킹된다. ==종료 전 `flush()`와 `close()`를 호출하지 않으면 버퍼에 남은 레코드는 버려진다.==

### 파티션 선택

키가 있으면 `murmur2(key) % 파티션 수`로 결정된다. 같은 키는 항상 같은 파티션으로 가고 순서 보장은 파티션 단위이므로, 순서가 필요한 단위(사용자·주문 ID)를 키로 쓴다. 파티션 수를 늘리면 나머지 연산의 분모가 바뀌어 기존 키의 매핑이 깨진다.

키가 없으면 2.4 이전에는 라운드 로빈으로 흩어 보내 파티션마다 한 건짜리 배치가 생겼다. 2.4부터는 Sticky 방식으로 한 파티션에 배치가 찰 때까지 몰아 넣고 다음 파티션으로 옮긴다. 분포는 시간이 지나면 균등해지고 배치는 두꺼워진다. 3.3부터 이 동작이 Producer에 내장됐고 `DefaultPartitioner`는 deprecated됐다.

### ACK 수준

| acks | 응답 시점 | 손실 위험 | 비고 |
|:---|:---|:---|:---|
| `0` | 응답을 기다리지 않음 | 높음 | 재시도 없음, 로그·메트릭 용도 |
| `1` | 리더가 로컬 로그에 쓴 뒤 | 중간 | 복제 전 리더 장애 시 손실 |
| `all` (`-1`) | ISR 전체가 쓴 뒤 | 낮음 | 3.0부터 기본값 |

`acks=all`은 단독으로 완결되지 않는다. ISR이 리더 하나로 줄어든 상태에서도 그 하나만 쓰면 응답이 나간다. `min.insync.replicas`가 응답에 필요한 최소 ISR 수를 정하고, 이보다 적으면 브로커는 `NotEnoughReplicasException`으로 쓰기를 거부한다. `replication.factor=3`, `min.insync.replicas=2`, `acks=all`이 한 대 장애를 견디면서 손실을 막는 표준 조합이다.

### 재시도와 순서

`retries`는 2.1부터 기본 `Integer.MAX_VALUE`이고 실제 상한은 `delivery.timeout.ms`(기본 120초)가 정한다. 재시도는 순서 역전을 만든다. ==`max.in.flight.requests.per.connection`(기본 5)만큼 응답 없이 요청이 떠 있는데, 앞 배치가 실패해 재시도되는 사이 뒤 배치가 먼저 커밋되면 같은 파티션 안에서 순서가 바뀐다.== 1로 낮추면 순서는 지켜지지만 처리량이 크게 떨어진다.

### 멱등성 Producer

브로커가 저장한 뒤 보낸 ACK가 유실되면 Producer는 재시도하고 같은 레코드가 두 번 저장된다. `enable.idempotence=true`를 켜면 브로커가 PID를 발급하고 Producer는 파티션별 시퀀스 번호를 붙여 보낸다. 브로커는 (PID, 파티션, 시퀀스)를 추적해 이미 본 시퀀스는 버리고 건너뛴 시퀀스는 거부하므로, `max.in.flight`를 5까지 두어도 순서가 보장된다. 전제는 `acks=all`, `retries > 0`, `max.in.flight ≤ 5`이며 3.0부터 기본값이다.

멱등성은 하나의 Producer 세션, 하나의 파티션 안에서만 중복을 막는다. 여러 파티션에 걸친 원자적 쓰기는 트랜잭션 API가 필요하다.

## 코드

Spring Boot 3.x의 `application.yml`에 안전한 Producer 설정을 명시한다.

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      acks: all
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
        delivery.timeout.ms: 120000
        linger.ms: 20
        batch.size: 32768
        compression.type: zstd
```

`KafkaTemplate.send()`는 `CompletableFuture`를 반환하므로 콜백에서 결과를 처리하고 호출 스레드는 블로킹되지 않는다.

```java
import java.util.concurrent.CompletableFuture;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.stereotype.Service;

@Service
public class OrderEventPublisher {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderEventPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(String orderId, String payload) {
        CompletableFuture<SendResult<String, String>> future =
                kafkaTemplate.send("order-events", orderId, payload);

        future.whenComplete((result, ex) -> {
            if (ex != null) {
                // 재시도 소진 후 최종 실패. DLQ 적재 또는 알림.
                return;
            }
            var meta = result.getRecordMetadata();
            // meta.partition(), meta.offset() 으로 적재 위치 확인
        });
    }
}
```

VIP 키를 마지막 파티션으로 고정하는 커스텀 Partitioner다. `partitioner.class` 프로퍼티에 등록한다.

```java
import java.util.Map;
import org.apache.kafka.clients.producer.Partitioner;
import org.apache.kafka.common.Cluster;
import org.apache.kafka.common.utils.Utils;

public class VipAwarePartitioner implements Partitioner {

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        int numPartitions = cluster.partitionsForTopic(topic).size();
        if (key instanceof String s && s.startsWith("VIP_")) {
            return numPartitions - 1;
        }
        if (keyBytes == null) {
            return 0;
        }
        return Utils.toPositive(Utils.murmur2(keyBytes)) % (numPartitions - 1);
    }

    @Override
    public void close() {}

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

## 실무에서 걸리는 지점

- **`acks=all`만 켜고 `min.insync.replicas`를 두지 않는다.** 브로커 기본값 1이면 리더가 쓰는 즉시 응답이 나가 `acks=1`과 손실 위험이 같다. 토픽 생성 시점에 두 값을 함께 확인한다.
- **커스텀 Partitioner가 키 없는 레코드까지 처리하면 Sticky 이점이 사라진다.** 키 없는 경로는 내장 동작에 맡기고 키 있는 경로만 커스텀하는 편이 안전하다.
- **`linger.ms`가 크면 지연이 그만큼 늘어난다.** 알림처럼 도착 시간이 중요한 경로는 0~5ms로 둔다. `batch-size-avg`가 `batch.size`에 한참 못 미치면 `linger.ms`가 매번 만료되어 전송되는 상태다.
- ==**`max.request.size`(기본 1MB)를 넘는 레코드는 `RecordTooLargeException`으로 즉시 실패한다.**== 재시도 대상이 아니며, 브로커 `message.max.bytes`도 함께 올려야 통과한다.
- **`send().get()`으로 동기화하면 배치가 한 건짜리로 줄어든다.** 한 건의 성공 확인이 꼭 필요한 곳에만 쓴다.

## 관련 글

- [설계 철학 — 왜 디스크·배치·Zero-Copy인가](/notes/kafka/design-philosophy/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Producer API와 설정](/notes/kafka/producer-api-config/)
