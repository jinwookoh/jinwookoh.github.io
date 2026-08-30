---
title: "Topic·Partition·Offset·Segment"
series: kafka
part: "기초"
order: 3
summary: "Kafka 데이터 구조 4계층이 어떻게 순서 보장·병렬 처리·보존 정책을 결정하는지 정리한다"
tags: [Kafka, Topic, Partition, Offset, Segment]
sources: [2026-05-02-kafka-architecture.md, 2026-05-03-kafka-topic-partition.md, data-infra/2026-05-17-kafka-implementation-log.md]
updated: 2026-08-29
---

메시지를 하나의 큐에 쌓는 구조는 처리량이 큐 하나의 쓰기 속도에 묶이고, 큐를 여러 개로 쪼개면 같은 사용자의 이벤트가 흩어져 순서가 깨진다. 메시지를 하나씩 삭제하면 랜덤 I/O가 발생하고, 서버가 소비자별 읽기 위치를 메시지마다 추적하면 상태가 소비자 수에 비례해 늘어난다. Kafka는 이 문제를 Topic·Partition·Offset·Segment 4계층으로 푼다. 순서는 파티션 단위로만 보장하고, 읽기 위치는 오프셋 하나로 관리하며, 삭제는 세그먼트 파일 단위로 수행한다.

## 핵심 개념

**Topic**은 이벤트 스트림에 붙인 이름이자 분산 영속 로그다. 테이블과 달리 쿼리를 던질 수 없고, 한 번 기록된 메시지는 수정·삭제되지 않는다(append-only). 토픽명은 영문·숫자·`.`·`_`·`-`를 쓰며 249자 이하다. `.`과 `_`는 내부 메트릭 이름에서 충돌하므로 한 토픽명 안에서 섞지 않는다.

**Partition**은 토픽의 실제 저장 단위다. 하나의 토픽은 1개 이상의 파티션으로 나뉘어 서로 다른 브로커에 분산 배치된다. 파티션 하나는 순서가 있는 불변 로그이며, 순서 보장은 파티션 내부에서만 성립한다. 파티션 0의 첫 메시지와 파티션 1의 첫 메시지 중 어느 쪽이 먼저인지는 정의되지 않는다. 파티션 수는 컨슈머 그룹 병렬도의 상한이다. 파티션 3개에 컨슈머 4개를 붙이면 1개는 유휴 상태가 된다.

프로듀서가 메시지를 어느 파티션으로 보낼지는 키가 결정한다.

| 조건 | 파티션 결정 | 순서 |
|:---|:---|:---|
| 키 있음 | `murmur2(key) % 파티션 수` | 같은 키는 항상 같은 파티션 |
| 키 없음 | Sticky 파티셔너(Kafka 2.4+, 배치 단위 순환) | 보장 안 됨 |
| 커스텀 | `Partitioner` 인터페이스 구현 | 구현에 따름 |

같은 사용자의 이벤트 순서를 지키려면 사용자 ID를 키로 쓴다. 파티션 수가 바뀌면 `hash % N`의 결과가 달라져 기존 키 매핑이 깨진다.

**Offset**은 파티션 안에서 메시지에 부여되는 64비트 정수 순번이다. 0부터 단조 증가하고, 바이트 위치가 아니라 논리적 순번이다. 파티션 안에서만 고유하므로 파티션 0의 오프셋 3과 파티션 1의 오프셋 3은 다른 메시지다. 앞쪽 메시지가 보존 만료로 삭제되어도 번호는 재사용되지 않는다. 컨슈머의 읽기 위치는 별도의 커밋 오프셋으로 추적하며 내부 토픽 `__consumer_offsets`에 저장된다. 파티션 최신 오프셋(log-end offset)과 커밋 오프셋의 차이가 Lag이다.

**Segment**는 파티션 로그를 디스크에 나눠 저장하는 파일 단위다. 파티션은 `<topic>-<partition>` 디렉토리에 대응하고, 그 안에 첫 오프셋을 20자리 0-padded로 이름 붙인 `.log` 파일이 여러 개 놓인다. 각 `.log`에는 `.index`(오프셋 → 바이트 위치)와 `.timeindex`(타임스탬프 → 오프셋)가 짝으로 붙는다. 두 인덱스는 `index.interval.bytes`(기본 4KB)마다 항목 하나를 두는 sparse 방식이라, 조회는 인덱스 이진 탐색으로 근접 위치를 찾은 뒤 `.log`를 순차 스캔해 목표 오프셋까지 이동한다. 쓰기는 마지막 active 세그먼트에만 이뤄지고, `segment.bytes`(기본 1GB) 또는 `segment.ms`(기본 7일)에 도달하면 새 파일을 연다(roll). 삭제도 세그먼트 단위다. `retention.ms`(기본 7일) 또는 `retention.bytes`를 초과하면 active가 아닌 세그먼트를 파일째 지운다. `cleanup.policy=compact`는 삭제 대신 키별 최신 값만 남기며, `compact,delete`로 두 정책을 결합할 수 있다.

## 코드

`NewTopic` 빈을 등록하면 기동 시 `KafkaAdmin`이 토픽을 생성한다. 파티션 6개·복제 팩터 3·보존 3일 설정이다.

```java
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.config.TopicConfig;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class TopicConfiguration {

    @Bean
    public NewTopic orderEvents() {
        return TopicBuilder.name("order-events")
                .partitions(6)
                .replicas(3)
                .config(TopicConfig.RETENTION_MS_CONFIG, String.valueOf(3L * 24 * 60 * 60 * 1000))
                .config(TopicConfig.SEGMENT_BYTES_CONFIG, String.valueOf(512L * 1024 * 1024))
                .build();
    }
}
```

주문 ID를 키로 보내면 같은 주문의 이벤트가 항상 같은 파티션에 기록된다. `RecordMetadata`에서 배정된 파티션과 오프셋을 확인한다.

```java
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.stereotype.Service;

@Service
public class OrderEventProducer {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderEventProducer(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(String orderId, String payload) {
        kafkaTemplate.send("order-events", orderId, payload)
                .thenAccept((SendResult<String, String> result) -> {
                    var meta = result.getRecordMetadata();
                    System.out.printf("partition=%d offset=%d%n",
                            meta.partition(), meta.offset());
                });
    }
}
```

`.timeindex`를 이용하면 특정 시각 이후의 오프셋을 조회해 그 지점부터 재처리할 수 있다. 결과는 요청한 타임스탬프 이상인 첫 오프셋이다.

```java
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.stream.Collectors;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.OffsetAndTimestamp;
import org.apache.kafka.common.TopicPartition;

public final class OffsetSeeker {

    public static void seekToTime(Consumer<String, String> consumer, String topic, Instant at) {
        Map<TopicPartition, Long> query = consumer.partitionsFor(topic).stream()
                .map(p -> new TopicPartition(topic, p.partition()))
                .collect(Collectors.toMap(tp -> tp, tp -> at.toEpochMilli()));
        consumer.assign(query.keySet());

        Map<TopicPartition, OffsetAndTimestamp> found =
                consumer.offsetsForTimes(query, Duration.ofSeconds(10));
        found.forEach((tp, ot) -> {
            if (ot == null) {
                consumer.seekToEnd(java.util.List.of(tp));
            } else {
                consumer.seek(tp, ot.offset());
            }
        });
    }
}
```

## 실무에서 걸리는 지점

- **파티션 수는 늘릴 수만 있고 줄일 수 없다.** 늘리는 순간 키 해시 매핑이 바뀌어 같은 키의 메시지가 다른 파티션으로 가기 시작하므로, 순서에 의존하는 컨슈머는 경계 시점에 순서 역전을 겪는다. 처리량 목표를 파티션 수 × 단일 파티션 처리량으로 계산해 초기에 여유 있게 잡는다.
- **파티션이 많을수록 좋은 것은 아니다.** 파티션마다 파일 핸들과 리더 선출 비용이 붙는다. 브로커당 수천 개를 경험적 상한으로 두고, KRaft에서 메타데이터 한도가 풀렸다고 무작정 늘리지 않는다.
- **`auto.offset.reset` 기본값은 `latest`다.** 새 컨슈머 그룹이 과거 데이터를 못 읽는 원인 대부분이 이 설정이다. 커밋 오프셋이 보존 만료로 삭제된 범위를 가리켜도 같은 설정으로 복구 위치가 정해진다.
- **세그먼트가 너무 작으면 파일이 폭증한다.** `segment.bytes`를 수백 KB로 두면 파티션당 수만 개의 파일이 생겨 file descriptor와 메모리가 부담을 받는다. 최소 100MB 이상으로 유지하고, `segment.index.bytes`(기본 10MB) 한도에 걸려 조기 roll이 일어나는지도 본다.
- **보존 정책은 세그먼트 단위로 동작한다.** active 세그먼트는 삭제 대상이 아니므로, 트래픽이 적은 토픽은 `segment.ms`가 지나야 만료가 진행된다. 삭제 시점이 예상과 다르면 `kafka-dump-log.sh`로 세그먼트의 baseOffset과 타임스탬프를 직접 확인한다.

## 관련 글

- [설계 철학 — 왜 디스크·배치·Zero-Copy인가](/notes/kafka/design-philosophy/)
- [Producer 동작 원리 — 파티션 선택·ACK·멱등성](/notes/kafka/producer-internals/)
- [Log Compaction·Tiered Storage](/notes/kafka/log-compaction-tiered-storage/)
