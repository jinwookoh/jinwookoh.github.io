---
title: "Consumer API와 설정"
series: kafka
part: "클라이언트"
order: 12
summary: "poll 루프·commit 방식·Rebalance 대응·seek과 그 동작을 좌우하는 설정을 한 번에 정리한다"
tags: [Kafka, Consumer API, Commit, Rebalance, Consumer Config]
sources: [data-infra/2026-05-17-kafka-consumer-api.md, data-infra/2026-05-17-kafka-consumer-config.md]
updated: 2026-08-29
---

Consumer는 offset, 파티션 할당, 그룹 멤버십을 클라이언트가 스스로 관리하며 이 셋이 서로 맞물린다. commit 타이밍을 잘못 잡으면 메시지가 손실되거나 중복 처리되고, 처리 시간이 길어지면 브로커가 Consumer를 죽은 것으로 판정해 Rebalance를 일으킨다. API 호출 패턴과 설정값을 같이 봐야 한다.

## 핵심 개념

### 구독과 Poll 루프

필수 설정은 `bootstrap.servers`, `group.id`, `key.deserializer`, `value.deserializer`다. `subscribe`는 Consumer Group에 참여해 파티션을 자동 할당받고, `assign`은 그룹 없이 `TopicPartition`을 직접 지정한다.

`poll(Duration)`은 지정 시간까지 기다리며 레코드 배치를 반환한다. 이를 순회해 처리하고 offset을 commit하는 것이 기본 루프다. `poll`은 그룹 참여까지 담당하므로 주기적으로 호출되지 않으면 그룹에서 제외된다.

### Commit 방식

Auto commit은 `auto.commit.interval.ms`마다 poll 시점에 commit하므로 처리 전에 commit될 수 있다. `commitSync()`는 blocking이고 실패 시 재시도하며, `commitAsync()`는 non-blocking이지만 재시도하지 않는다. 평상시 async, 종료·revoke 시점 sync로 조합하는 것이 운영 표준이다. commit 대상은 "다음에 읽을 위치"이므로 `record.offset() + 1`을 넘기고, `Map<TopicPartition, OffsetAndMetadata>`로 파티션별 처리 지점을 기록한다.

### Rebalance 대응

파티션이 넘어가기 전 `onPartitionsRevoked`가 호출된다. 여기서 commit하지 않으면 새 담당자가 마지막 commit 지점부터 다시 읽어 중복이 생긴다. `onPartitionsAssigned`에서는 초기화나 `seek`을 수행한다. `partition.assignment.strategy`는 `CooperativeStickyAssignor`가 기존 할당을 유지하며 필요한 파티션만 점진적으로 옮겨 정지 시간이 가장 짧다. 기본값 `RangeAssignor`는 분배가 불균등하다. `group.instance.id`를 지정하면 Static Membership이 되어 롤링 배포 중 불필요한 Rebalance를 피한다.

### Seek·Pause

`seekToBeginning`, `seekToEnd`, `seek(tp, offset)`으로 읽기 위치를 옮기고, `offsetsForTimes`는 타임스탬프 이후 첫 offset을 돌려준다. ==`pause`는 레코드 반환만 멈추고 `poll` 호출 의무는 남는다.==

### 그룹 멤버십과 Fetch 설정

- `session.timeout.ms`(기본 45초): heartbeat 단절 후 죽음 판정까지의 시간
- `heartbeat.interval.ms`(기본 3초): session의 1/3 이하로 잡는다
- `max.poll.interval.ms`(기본 5분): 두 poll 사이 허용 최대 간격
- `max.poll.records`(기본 500): 한 poll이 반환하는 최대 레코드 수
- `fetch.min.bytes`·`fetch.max.wait.ms`: 브로커가 응답을 미루는 조건. 최소 바이트를 올리면 처리량은 늘고 지연은 커진다
- `max.partition.fetch.bytes`(기본 1MB): 파티션 하나에서 가져오는 최대 크기
- `isolation.level`: `read_committed`면 트랜잭션이 commit된 레코드만 반환

Kafka 4.0부터 `group.protocol=consumer`로 KIP-848 프로토콜을 켤 수 있다.

## 코드

Hybrid commit과 Rebalance Listener를 합친 poll 루프. revoke와 종료 시점에는 동기 commit으로 마무리한다.

```java
Properties props = new Properties();
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka1:9092,kafka2:9092");
props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-workers");
props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
        CooperativeStickyAssignor.class.getName());

Map<TopicPartition, OffsetAndMetadata> current = new HashMap<>();

try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
    consumer.subscribe(List.of("orders"), new ConsumerRebalanceListener() {
        @Override
        public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
            consumer.commitSync(current);
            partitions.forEach(current::remove);
        }
        @Override
        public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
            // 필요 시 seek
        }
    });

    while (running.get()) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));
        for (ConsumerRecord<String, String> record : records) {
            process(record);
            current.put(new TopicPartition(record.topic(), record.partition()),
                    new OffsetAndMetadata(record.offset() + 1));
        }
        consumer.commitAsync(current, (offsets, ex) -> {
            if (ex != null) log.warn("async commit failed", ex);
        });
    }
    consumer.commitSync(current);
} catch (WakeupException ignored) {
    // 다른 스레드에서 wakeup() 호출로 종료
}
```

시간 기반 재처리. 1시간 전 시각에 해당하는 offset을 조회해 각 파티션을 옮긴다.

```java
Map<TopicPartition, Long> query = new HashMap<>();
long oneHourAgo = Instant.now().minus(Duration.ofHours(1)).toEpochMilli();
consumer.assignment().forEach(tp -> query.put(tp, oneHourAgo));

consumer.offsetsForTimes(query).forEach((tp, ot) -> {
    if (ot != null) consumer.seek(tp, ot.offset());
});
```

Spring Boot 3.x 설정과 수동 ack 리스너. `properties`에는 원시 설정 키를 그대로 넣는다.

```yaml
spring:
  kafka:
    bootstrap-servers: kafka1:9092,kafka2:9092
    consumer:
      group-id: order-workers
      auto-offset-reset: earliest
      enable-auto-commit: false
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      max-poll-records: 500
      properties:
        session.timeout.ms: 60000
        heartbeat.interval.ms: 20000
        max.poll.interval.ms: 300000
        partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
        group.instance.id: ${HOSTNAME}
        spring.json.trusted.packages: com.example.order
    listener:
      ack-mode: MANUAL
      concurrency: 3
```

```java
@Component
public class OrderListener {

    @KafkaListener(topics = "orders")
    public void handle(OrderEvent event, Acknowledgment ack) {
        process(event);
        ack.acknowledge();
    }
}
```

## 실무에서 걸리는 지점

- **처리 시간이 `max.poll.interval.ms`를 넘는 경우.** 그룹에서 제외되고 다른 인스턴스가 같은 레코드를 다시 받아 중복 처리된다. 간격을 늘리거나 `max.poll.records`를 줄인다.
- **Auto commit과 처리 실패.** commit 후 처리 중 장애가 나면 그 레코드는 다시 읽히지 않는다. 손실이 허용되지 않으면 `enable.auto.commit=false`로 둔다.
- **큰 메시지와 `max.partition.fetch.bytes`.** ==브로커·토픽의 `max.message.bytes`보다 작으면 그 파티션은 해당 레코드에서 멈춘다.==
- **heartbeat와 session 비율.** 두 값이 비슷하면 heartbeat 한 번만 놓쳐도 죽은 것으로 판정된다.
- **`KafkaConsumer`는 thread-safe가 아니다.** ==다른 스레드에서 호출해도 되는 것은 `wakeup()`뿐이다.== 병렬화는 인스턴스를 늘려서 한다. `group.instance.id`가 중복되면 `FencedInstanceIdException`으로 종료된다.

## 관련 글

- [Consumer 동작 원리 — Pull·Group·Offset·Rebalance](/notes/kafka/consumer-internals-rebalance/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Spring Kafka — 배치·에러·트랜잭션·테스트](/notes/kafka/spring-kafka/)
