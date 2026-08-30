---
title: "Consumer 동작 원리 — Pull·Group·Offset·Rebalance"
series: kafka
part: "설계와 내부"
order: 6
summary: "Consumer가 Pull로 읽고 offset 하나로 위치를 기록하며, 그룹 단위로 파티션을 나눠 갖고 재분배하는 원리를 정리한다"
tags: [Kafka, Consumer Group, Offset, Rebalance, KIP-848]
sources: [data-infra/2026-05-17-kafka-design-consumer.md, 2026-05-02-kafka-consumers.md, 2026-05-03-kafka-consumer-group.md, data-infra/2026-05-17-kafka-consumer-rebalance-protocol.md]
updated: 2026-08-29
---

메시지마다 확인 상태를 추적하는 전통적인 큐는 브로커 부담이 크고, Push 방식은 느린 컨슈머를 넘어뜨리며, 소비 후 삭제하므로 재처리가 불가능하다. Kafka는 Pull 모델, 파티션당 정수 하나인 offset, Consumer Group으로 이를 푼다. 대신 멤버가 바뀔 때 파티션을 재분배하는 rebalance가 운영 부담으로 들어온다.

## 핵심 개념

### Pull과 Long Polling

Producer에서 브로커로는 push, 브로커에서 Consumer로는 pull이다. Consumer가 `poll()`로 offset을 지정해 fetch하므로 처리 속도를 스스로 조절한다. 데이터가 없을 때의 busy loop는 브로커 측 long polling이 막는다. `fetch.min.bytes`가 차거나 `fetch.max.wait.ms`가 지날 때까지 브로커가 응답을 보류한다.

### Offset — 파티션당 정수 하나

그룹 안에서 파티션 하나는 컨슈머 하나만 읽으므로 소비 위치는 `(group.id, topic, partition) → offset` 정수 하나이고, 내부 토픽 `__consumer_offsets`에 커밋된다. 브로커는 개별 메시지 상태를 관리하지 않고, retention 안에서 임의 offset으로 되감아 재처리할 수 있다.

커밋 시점이 전달 보증을 결정한다. 처리 전 커밋은 손실(at-most-once), 처리 후 커밋은 중복(at-least-once)을 낳는다. 자동 커밋(5초 주기)은 처리 완료 전에 커밋될 수 있으므로 운영에서는 수동으로 처리 후 커밋하고 중복은 멱등 처리로 흡수한다. `auto.offset.reset`은 커밋된 offset이 없을 때만 적용되므로, 처음부터 다시 읽으려면 그룹 offset을 리셋해야 한다.

### Consumer Group과 Coordinator

같은 `group.id`를 가진 컨슈머는 한 그룹으로 파티션을 나눠 받는다. 파티션 하나는 그룹 안에서 컨슈머 하나에만 할당되므로 병렬도의 상한은 파티션 수다. 다른 그룹은 각자의 offset으로 같은 토픽을 독립적으로 읽는다. 순서는 파티션 안에서만 보장된다.

`hash(group.id) % __consumer_offsets 파티션 수`로 정해진 파티션의 리더 브로커가 코디네이터가 되어 멤버십·heartbeat·offset 저장·rebalance를 맡는다. 그 브로커가 죽으면 새 리더가 이어받는다.

### Rebalance 세 세대

Rebalance는 컨슈머 join·leave, session timeout, `max.poll.interval.ms` 초과, 파티션 수·구독 변경 때 발생한다. Eager(classic) 방식은 전 멤버가 모든 파티션을 반납한 뒤 그룹 리더 컨슈머가 재할당하는 stop-the-world다. 2.4의 `CooperativeStickyAssignor`는 이동할 파티션만 반납한다. 4.0의 KIP-848(`group.protocol=consumer`)은 브로커가 `group.remote.assignor`로 직접 할당하며, 브로커와 클라이언트 모두 4.0 이상이어야 한다.

classic 전략 중 `RangeAssignor`는 다중 토픽 구독 시 부하가 쏠리고, `RoundRobinAssignor`·`StickyAssignor`는 고르지만 eager다. 3.0부터 기본값은 `[RangeAssignor, CooperativeStickyAssignor]`다.

### 생존 판정과 Static Membership

heartbeat(`heartbeat.interval.ms` 3초)가 `session.timeout.ms`(45초) 동안 끊기면 프로세스 사망으로, `poll()` 간격이 `max.poll.interval.ms`(5분)를 넘으면 처리 정체로 판정한다. ==heartbeat는 별도 스레드가 보내므로 두 시계는 독립적이다.==

==`group.instance.id`를 고정하면 session timeout 안에 재참가할 때 기존 파티션을 돌려받아 rebalance가 생략된다.== ID가 중복되면 `FencedInstanceIdException`이 난다.

## 코드

처리 완료 후 수동 커밋하는 폴링 루프. `wakeup()`으로 종료 신호를 받고 `close()`로 그룹을 떠난다.

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.errors.WakeupException;
import org.apache.kafka.common.serialization.StringDeserializer;
import java.time.Duration;
import java.util.List;
import java.util.Properties;

public class OrderConsumer {

    public static void main(String[] args) {
        var props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-processor");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "200");
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                CooperativeStickyAssignor.class.getName());

        var consumer = new KafkaConsumer<String, String>(props);
        Runtime.getRuntime().addShutdownHook(new Thread(consumer::wakeup));

        try {
            consumer.subscribe(List.of("orders"));
            while (true) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
                for (ConsumerRecord<String, String> record : records) {
                    process(record);
                }
                if (!records.isEmpty()) {
                    consumer.commitAsync();
                }
            }
        } catch (WakeupException e) {
            // 정상 종료 신호
        } finally {
            consumer.commitSync();
            consumer.close();
        }
    }

    private static void process(ConsumerRecord<String, String> record) {
        // 멱등 처리: record.key() 기준으로 중복 여부 판단
    }
}
```

파티션 반납 직전에 커밋하는 `ConsumerRebalanceListener`. 이 커밋이 없으면 새 담당 컨슈머가 처리 구간을 다시 읽는다.

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.TopicPartition;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class CommitOnRevokeListener implements ConsumerRebalanceListener {

    private final KafkaConsumer<String, String> consumer;
    private final Map<TopicPartition, OffsetAndMetadata> current = new ConcurrentHashMap<>();

    public CommitOnRevokeListener(KafkaConsumer<String, String> consumer) {
        this.consumer = consumer;
    }

    public void track(ConsumerRecord<String, String> record) {
        current.put(new TopicPartition(record.topic(), record.partition()),
                new OffsetAndMetadata(record.offset() + 1));
    }

    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        var toCommit = new HashMap<TopicPartition, OffsetAndMetadata>();
        for (TopicPartition tp : partitions) {
            var offset = current.remove(tp);
            if (offset != null) toCommit.put(tp, offset);
        }
        if (!toCommit.isEmpty()) consumer.commitSync(toCommit);
    }

    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        // 새 파티션 초기화
    }

    @Override
    public void onPartitionsLost(Collection<TopicPartition> partitions) {
        // 정상 반납 없이 잃은 경우 — 커밋하지 않고 로컬 상태만 정리
        partitions.forEach(current::remove);
    }
}
```

Spring Boot 3.x의 Static Membership·생존 판정 설정.

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: order-processor
      enable-auto-commit: false
      auto-offset-reset: earliest
      max-poll-records: 200
      properties:
        group.instance.id: ${HOSTNAME}
        session.timeout.ms: 60000
        heartbeat.interval.ms: 20000
        max.poll.interval.ms: 300000
        partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

## 실무에서 걸리는 지점

- **파티션 수가 병렬도 상한이다.** 컨슈머를 파티션 수 이상으로 늘려도 처리량은 늘지 않는다.
- **Rebalance storm.** 한 컨슈머의 이탈이 rebalance를 부르고 그 사이 다른 컨슈머가 timeout을 넘겨 연쇄된다. `rebalance-rate-per-hour`가 10을 넘으면 session timeout 상향·Static Membership·cooperative 전략으로 대응한다.
- **처리 시간 대비 poll 간격.** ==한 배치가 5분을 넘기면 heartbeat가 정상이어도 그룹에서 제외된다.== `max.poll.records`를 줄이거나 interval을 늘린다.
- **assign()과 subscribe()는 함께 쓸 수 없다.** `assign()`은 그룹과 무관하게 파티션을 직접 잡는 재처리·디버깅용이다.
- **Graceful shutdown 누락.** `close()` 없이 죽으면 session timeout까지 파티션 재배정이 미뤄진다.

## 관련 글

- [Producer 동작 원리 — 파티션 선택·ACK·멱등성](/notes/kafka/producer-internals/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Consumer API와 설정](/notes/kafka/consumer-api-config/)
