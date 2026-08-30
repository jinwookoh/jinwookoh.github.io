---
title: "Producer API와 설정"
series: kafka
part: "클라이언트"
order: 11
summary: "send() 세 가지 패턴과 Serializer·Interceptor, acks·idempotence·batch·timeout 설정의 상호작용을 정리한다"
tags: [Kafka, KafkaProducer, Serializer, idempotence, KafkaTemplate]
sources: [data-infra/2026-05-17-kafka-producer-api.md, data-infra/2026-05-17-kafka-producer-config.md]
updated: 2026-08-29
---

`producer.send(record)` 한 줄 뒤에는 응답을 어떻게 받을지, 어떤 형식으로 직렬화할지, 실패 시 재시도할지, 몇 건을 모아 보낼지에 대한 결정이 숨어 있다. 이를 기본값에 맡기면 처리량이 나오지 않거나 중복·유실이 생기거나, 재시도가 끝나기 전에 timeout으로 실패한다. 설정끼리 조건부로 얽혀 있어 API와 설정을 함께 봐야 한다.

## 핵심 개념

### 생성과 send() 패턴

필수 설정은 `bootstrap.servers`, `key.serializer`, `value.serializer` 세 가지다. broker를 여러 개 적어야 하나가 내려가도 fallback된다. `KafkaProducer`는 thread-safe하므로 애플리케이션 전체에서 인스턴스 하나를 공유한다.

`send()`는 반환값을 무시하는 fire-and-forget, `get()`으로 블로킹하는 Future 동기 대기, 결과를 Callback으로 받는 비동기 방식 세 가지로 쓴다. 동기 대기는 batch가 한 건씩 나가 처리량이 떨어지므로 Callback을 쓴다. `ProducerRecord`는 topic과 value가 필수이고 partition·timestamp·key·headers는 선택이며, 같은 key는 같은 partition으로 간다.

### Serializer·Partitioner·Interceptor

String은 단순 문자열, ByteArray는 이미 직렬화된 바이트를 보낼 때 쓴다. 스키마 진화가 필요한 대규모 환경은 Avro와 Schema Registry 조합이 표준이고, 개발 편의가 우선이면 Spring Kafka의 `JsonSerializer`를 쓴다. Serializer를 바꾸면 기존 consumer의 읽기가 실패하므로 포맷 전환은 Schema Registry의 호환성 검사 아래에서 진행한다.

기본 partitioner는 key 없는 레코드를 batch 단위로 같은 partition에 붙이는 sticky 방식이며, 3.3부터 `partitioner.adaptive.partitioning.enable=true`가 기본이라 느린 partition을 피한다. `interceptor.classes`로 등록하는 `ProducerInterceptor`는 `onSend`와 `onAcknowledgement` 훅으로 trace header 주입과 메트릭 수집을 맡는다.

### 신뢰성 설정의 연쇄

`acks=all`은 ISR 전체의 확인을 기다리고, `enable.idempotence=true`는 broker가 sequence number로 중복을 걸러낸다. 3.0부터 idempotence가 기본 true인데 `acks=all`, `retries>0`, `max.in.flight.requests.per.connection<=5`가 모두 만족될 때만 유효하다. ==명시적으로 켠 채 조건을 깨면 `ConfigException`이 나고, 기본값 상태에서 깨면 조용히 꺼진다.== `retries`는 사실상 무한이며 실제 상한은 send부터 최종 ACK까지의 총 시간인 `delivery.timeout.ms`(120초)가 정한다. 개별 요청은 `request.timeout.ms`(30초)로 끊고, 재시도 간격은 `retry.backoff.ms`부터 지수적으로 늘어난다. `acks=all`은 broker의 `min.insync.replicas`가 2 이상일 때 의미가 있다.

### Batching과 메모리

`batch.size`(16KB)는 partition별 batch 버퍼이고 `linger.ms`(0)는 batch가 차지 않아도 기다릴 시간이다. 실시간은 0~5ms, 균형은 5~20ms, 처리량 우선은 50~100ms를 잡는다. `buffer.memory`(32MB)가 가득 차면 `send()`가 `max.block.ms`(60초)까지 블로킹된다. `compression.type`은 기본 none이지만 운영에서는 zstd가 균형이 좋고, 압축은 batch 단위라 `linger.ms`를 주면 압축률도 오른다. `client.id`는 broker 로그와 메트릭에 찍히므로 서비스 이름으로 둔다.

## 코드

KafkaProducer를 직접 생성해 Callback으로 전송하고 try-with-resources로 close를 보장한다.

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.RetriableException;
import org.apache.kafka.common.serialization.StringSerializer;

import java.util.Properties;

public class OrderProducer {

    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka1:9092,kafka2:9092,kafka3:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "zstd");
        props.put(ProducerConfig.LINGER_MS_CONFIG, 10);
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 32768);
        props.put(ProducerConfig.CLIENT_ID_CONFIG, "order-service");

        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            var record = new ProducerRecord<>("orders", "order-1001", "{\"amount\":12000}");
            record.headers().add("trace-id", "abc123".getBytes());

            producer.send(record, (metadata, exception) -> {
                if (exception == null) {
                    System.out.printf("sent %s p=%d offset=%d%n",
                            metadata.topic(), metadata.partition(), metadata.offset());
                } else if (exception instanceof RetriableException) {
                    System.err.println("retry exhausted: " + exception.getMessage());
                } else {
                    System.err.println("non-retriable, route to DLQ: " + exception.getMessage());
                }
            });
        }
    }
}
```

trace header를 붙이고 실패를 세는 ProducerInterceptor다.

```java
import org.apache.kafka.clients.producer.ProducerInterceptor;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.LongAdder;

public class TraceInterceptor implements ProducerInterceptor<String, String> {

    private final LongAdder failures = new LongAdder();

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        if (record.headers().lastHeader("trace-id") == null) {
            record.headers().add("trace-id", UUID.randomUUID().toString().getBytes());
        }
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        if (exception != null) {
            failures.increment();
        }
    }

    @Override
    public void close() {}

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

Spring Boot 3.x 설정과 `KafkaTemplate` 예제다. `send()`는 `CompletableFuture`를 반환한다.

```yaml
spring:
  kafka:
    bootstrap-servers: kafka1:9092,kafka2:9092,kafka3:9092
    producer:
      client-id: order-service
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      acks: all
      compression-type: zstd
      batch-size: 32KB
      buffer-memory: 64MB
      properties:
        enable.idempotence: true
        linger.ms: 10
        request.timeout.ms: 30000
        delivery.timeout.ms: 120000
```

```java
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
public class OrderEventPublisher {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public OrderEventPublisher(KafkaTemplate<String, OrderEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(OrderEvent event) {
        kafkaTemplate.send("orders", event.orderId(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        // 재시도가 끝난 뒤의 최종 실패. DLQ 전송이나 알림으로 연결한다.
                        return;
                    }
                    var meta = result.getRecordMetadata();
                    // meta.partition(), meta.offset() 으로 전송 위치를 기록한다.
                });
    }
}
```

## 실무에서 걸리는 지점

- `close()`나 `flush()` 없이 프로세스가 끝나면 마지막 batch가 버퍼에서 사라진다. try-with-resources로 묶거나 Spring 컨테이너 종료 훅에 맡긴다.
- ==`delivery.timeout.ms`가 재시도 횟수와 backoff의 곱보다 작으면 재시도가 남아 있어도 timeout으로 먼저 실패한다.== timeout 값들을 함께 설계한다.
- `max.request.size`(1MB)를 넘는 메시지는 `RecordTooLargeException`으로 즉시 실패하며 재시도되지 않는다. 대용량은 외부 저장소에 두고 키만 보낸다.
- `buffer.memory`가 작으면 `send()`가 블로킹되어 애플리케이션 스레드가 묶인다. `buffer-available-bytes` 메트릭을 JMX로 확인한다.

## 관련 글

- [Producer 동작 원리 — 파티션 선택·ACK·멱등성](/notes/kafka/producer-internals/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Consumer API와 설정](/notes/kafka/consumer-api-config/)
