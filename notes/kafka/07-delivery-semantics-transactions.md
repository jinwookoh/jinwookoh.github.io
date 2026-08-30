---
title: "전달 보증 — at-most·at-least·exactly-once와 트랜잭션"
series: kafka
part: "설계와 내부"
order: 7
summary: "세 가지 전달 보증의 차이와 멱등 프로듀서·트랜잭션·read_committed로 Kafka 내부 exactly-once가 성립하는 원리를 정리한다"
tags: [Kafka, Exactly-Once, Transactions, Idempotent Producer, read_committed]
sources: [data-infra/2026-05-17-kafka-message-delivery-semantics.md, data-infra/2026-05-17-kafka-transaction-protocol.md]
updated: 2026-08-29
---

Producer가 ACK를 받지 못하면 재전송할지 포기할지, Consumer는 처리와 offset commit 중 무엇을 먼저 할지 정해야 한다. 어느 쪽이든 손실 또는 중복 중 하나를 감수하게 된다. 결제·정산처럼 둘 다 허용되지 않는 데이터에서는 이 선택이 곧 장애 원인이다. ==Kafka는 멱등 Producer와 트랜잭션으로 클러스터 내부에 한해 손실과 중복을 모두 제거하며, 그 범위와 비용을 알아야 올바르게 쓸 수 있다.==

## 핵심 개념

### 세 가지 보증

| 보증 | 손실 | 중복 | Producer | Consumer 순서 |
|:---|:---:|:---:|:---|:---|
| at-most-once | 가능 | 없음 | `acks=0`, `retries=0` | poll → commit → process |
| at-least-once | 없음 | 가능 | `acks=all`, retries > 0 | poll → process → commit |
| exactly-once | 없음 | 없음 | 멱등 + 트랜잭션 | `isolation.level=read_committed` |

발행 측과 소비 측 보증은 별개다. Producer가 정확히 한 번 저장했어도 Consumer가 commit 전에 죽으면 재처리되므로 양쪽을 한 트랜잭션으로 묶어야 한다.

### 발행 측 — 멱등 Producer

Producer는 브로커에서 Producer ID(PID)를 받고 파티션별 sequence number를 붙여 전송한다. 브로커는 (PID, sequence)를 추적해 이미 저장한 배치가 다시 오면 저장하지 않고 성공으로 응답한다. Kafka 3.0부터 `enable.idempotence=true`가 기본이며 `acks=all`, 무제한 retries가 함께 적용된다. 멱등성은 단일 파티션·단일 세션 안에서만 유효하고, 그 밖은 트랜잭션이 담당한다.

### 트랜잭션 프로토콜

세 부품으로 동작한다.

1. **Transaction Coordinator** — 브로커 내부 컴포넌트. `transactional.id` 해시로 담당이 정해지며 상태 추적, 2단계 커밋 조율, fencing, timeout 감지를 맡는다.
2. **`__transaction_state`** — 내부 토픽(기본 50 파티션). Empty → Ongoing → PrepareCommit/PrepareAbort → CompleteCommit/CompleteAbort 전이가 append되어 코디네이터 장애 후에도 복구된다.
3. **Control Batch** — 파티션 로그에 기록되는 COMMIT/ABORT 마커.

```
initTransactions         → InitProducerId (PID + epoch 발급)
send(record)             → 새 파티션이면 AddPartitionsToTxn 후 전송
sendOffsetsToTransaction → __consumer_offsets에 트랜잭션 offset 기록
commitTransaction        → Phase 1: PrepareCommit 기록
                         → Phase 2: 각 파티션 리더에 COMMIT 마커 append
                         → CompleteCommit 기록, Producer에 응답
```

출력 레코드와 입력 offset이 한 트랜잭션에 묶이므로 consume-transform-produce가 원자적으로 처리된다.

### 소비 측 — read_committed와 LSO

`read_committed` Consumer에게 브로커는 Last Stable Offset(LSO)까지만 반환한다. LSO는 그 이전의 모든 트랜잭션이 commit 또는 abort로 끝난 지점이다. 진행 중인 레코드는 보이지 않고 ABORT 마커가 붙은 배치는 건너뛴다. abort된 레코드는 디스크에 남았다가 retention으로 제거된다.

### Producer Fencing

같은 `transactional.id`로 새 Producer가 `initTransactions`를 호출하면 코디네이터는 epoch를 올리고 이전 epoch의 진행 중 트랜잭션을 abort한다. 긴 GC 후 깨어난 옛 인스턴스는 `ProducerFencedException`을 받아 커밋을 끼워 넣지 못한다.

### Kafka Streams의 EOS

`processing.guarantee=exactly_once_v2` 한 줄로 위 구성이 모두 적용된다. v2는 task별이 아닌 스레드 단위로 Producer를 공유해 메모리와 연결 수를 줄인다.

## 코드

consume-transform-produce를 한 트랜잭션으로 묶는 클라이언트 예제다.

```java
Properties pp = new Properties();
pp.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
pp.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "order-enricher-" + instanceId);
pp.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
pp.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);

Properties cp = new Properties();
cp.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
cp.put(ConsumerConfig.GROUP_ID_CONFIG, "order-enricher");
cp.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
cp.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");
cp.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
cp.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);

try (var producer = new KafkaProducer<String, String>(pp);
     var consumer = new KafkaConsumer<String, String>(cp)) {
    producer.initTransactions();
    consumer.subscribe(List.of("orders"));

    while (running) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
        if (records.isEmpty()) continue;

        producer.beginTransaction();
        try {
            for (ConsumerRecord<String, String> r : records) {
                producer.send(new ProducerRecord<>("orders-enriched", r.key(), enrich(r.value())));
            }
            Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
            for (TopicPartition tp : records.partitions()) {
                var last = records.records(tp).getLast();
                offsets.put(tp, new OffsetAndMetadata(last.offset() + 1));
            }
            producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());
            producer.commitTransaction();
        } catch (ProducerFencedException | OutOfOrderSequenceException e) {
            throw e;   // 복구 불가, 인스턴스 종료
        } catch (KafkaException e) {
            producer.abortTransaction();   // 다음 poll에서 같은 offset부터 재처리
        }
    }
}
```

Spring Kafka에서는 `transaction-id-prefix`만 지정하면 리스너 컨테이너가 트랜잭션과 offset 전송을 처리한다.

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: order-enricher-tx-
    consumer:
      group-id: order-enricher
      isolation-level: read_committed
      enable-auto-commit: false
```

```java
@Component
public class OrderEnricher {

    private final KafkaTemplate<String, String> template;

    public OrderEnricher(KafkaTemplate<String, String> template) {
        this.template = template;
    }

    @KafkaListener(topics = "orders")
    public void on(ConsumerRecord<String, String> record) {
        // 컨테이너가 연 트랜잭션 안에서 실행된다. 예외가 나가면 abort 후 재시도.
        template.send("orders-enriched", record.key(), enrich(record.value()));
    }
}
```

## 실무에서 걸리는 지점

- ==**EOS 범위는 Kafka 클러스터 내부다.**== DB·HTTP·파일로 sink하면 트랜잭션 밖이므로 키 기반 upsert 같은 멱등 쓰기, 또는 DB 트랜잭션 안에 outbox 테이블을 쓰고 CDC로 발행하는 Transactional Outbox가 필요하다. 다른 클러스터로 복제한 뒤에도 EOS는 보장되지 않는다.
- **`transaction.timeout.ms`(기본 60초)를 넘기면 자동 abort된다.** 배치가 크거나 외부 호출이 느리면 값을 올리되, 브로커 `transaction.max.timeout.ms`(기본 15분)를 넘길 수 없다.
- **`transactional.id` 중복은 서로를 fencing한다.** 두 인스턴스가 같은 ID를 쓰면 번갈아 `ProducerFencedException`으로 죽는다. 이 예외는 재시도하지 말고 종료해야 한다.
- **read_committed는 지연을 더한다.** 커밋 주기만큼 Consumer가 늦게 본다. EOS는 at-least-once 대비 10~20% 정도 처리량 손실이 있다.
- **기본 선택은 at-least-once + 멱등 처리다.** 로그·메트릭만 at-most-once가 허용되고, Kafka 내부 스트림 처리는 exactly_once_v2, 외부 DB가 최종 목적지면 Outbox 패턴을 쓴다.

## 관련 글

- [Producer 동작 원리 — 파티션 선택·ACK·멱등성](/notes/kafka/producer-internals/)
- [Consumer 동작 원리 — Pull·Group·Offset·Rebalance](/notes/kafka/consumer-internals-rebalance/)
- [이벤트 패턴 — Outbox·Saga·Fan-out](/notes/kafka/event-patterns-outbox-saga/)
