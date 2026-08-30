---
title: "Streams — 입문과 핵심 개념"
series: kafka
part: "Streams"
order: 23
summary: "Kafka Streams는 별도 클러스터 없는 클라이언트 라이브러리이며, Topology·Task·State Store·EOS가 파티션 위에서 맞물리는 구조를 정리한다."
tags: [Kafka Streams, KStream, KTable, Topology, State Store]
sources: [data-infra/2026-05-17-kafka-streams-intro.md, data-infra/2026-05-17-kafka-streams-quickstart.md, data-infra/2026-05-17-kafka-streams-core-concepts.md]
updated: 2026-08-29
---

Kafka 토픽의 이벤트를 필터링·집계·조인해 다른 토픽으로 내보내야 할 때, Consumer API로 직접 구현하면 파티션 재분배·상태 복구·정확히 한 번 처리를 손으로 짜야 하고, Spark Streaming·Flink를 쓰면 별도 클러스터 운영과 잡 제출이라는 인프라 부담이 따라온다. Kafka Streams는 이 사이를 메운다. Kafka 클러스터만 있으면 되는 클라이언트 라이브러리로, 의존성 하나로 분산·내결함성·exactly-once를 갖춘 스트림 처리를 얻는다.

## 핵심 개념

### 라이브러리 모델

애플리케이션 프로세스 안에서 동작하며, 입력과 출력이 모두 Kafka 토픽이라는 전제 위에서 파티션 분산과 consumer group 재분배를 그대로 활용한다. Kafka 밖의 DB·HTTP는 Connect와 결합해야 하고, 수천 노드 규모의 배치·ML 워크로드는 Spark·Flink 영역이다.

### KStream·KTable과 duality

KStream은 append-only 레코드 스트림으로 같은 키의 이벤트를 각각 독립된 사실로 취급한다. KTable은 changelog 스트림으로 키별 최신 값만 의미를 가진다. KStream을 `groupByKey` 후 집계하면 KTable이 되고, `toStream()`으로 변경 이력을 다시 스트림으로 꺼낸다.

### Topology → SubTopology → Task → Thread → Instance

DSL 코드는 Source → Processor → Sink 노드로 이루어진 topology를 정의한다. `groupBy`처럼 키를 바꾸는 연산은 내부 repartition 토픽에 쓰고 다시 읽으므로 topology는 그 지점에서 SubTopology로 나뉜다. Task는 SubTopology 하나와 입력 파티션 하나의 조합이며 자기 파티션과 자기 state store만 갖는 격리된 실행 단위다. 총 task 수는 SubTopology 수 × 입력 파티션 수다. 한 인스턴스 안에서는 `num.stream.threads`개의 스레드가 task를 나눠 실행하고, 인스턴스를 추가하면 cooperative 재분배로 task가 옮겨간다. 스케일 상한은 파티션 수다.

### State store와 changelog

count·aggregate·join은 상태가 필요하다. 기본 store는 RocksDB로 로컬 디스크에 두고, 모든 변경은 `<application.id>-<store>-changelog` 내부 토픽에 기록되어 재시작 시 replay로 복구한다. `num.standby.replicas`를 1 이상으로 두면 다른 인스턴스가 같은 state를 미리 따라가 failover 시 복구 대기가 사라진다. `application.id`는 consumer group id·내부 토픽 prefix·state 디렉토리 이름으로 쓰이므로 클러스터 안에서 유일해야 한다.

### Time semantics와 exactly-once

발생 시각(event time), 브로커 append 시각(ingestion time), 처리 시점(processing time) 중 windowing은 event time을 기준으로 해야 순서가 뒤바뀐 이벤트를 올바르게 다룬다. value 안의 비즈니스 시각을 쓰려면 `TimestampExtractor`를 구현한다. task가 관측한 최대 timestamp가 stream time이며 window 종료와 grace period를 이 값으로 판단한다.

`processing.guarantee=exactly_once_v2` 한 줄로 트랜잭션 producer, `read_committed` consumer, state store·changelog·출력 토픽의 원자적 커밋이 함께 켜진다. V2는 스레드 단위로 producer를 공유하며 브로커 3.0 이상이 필요하다.

## 코드

Spring Boot 3.x 설정. Streams 전용 옵션은 `properties` 아래에 넣는다.

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    streams:
      application-id: wordcount-app
      properties:
        default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.value.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.timestamp.extractor: com.example.streams.OccurredAtExtractor
        processing.guarantee: exactly_once_v2
        num.stream.threads: 2
        num.standby.replicas: 1
        replication.factor: 3
```

WordCount topology. `@EnableKafkaStreams`가 `StreamsBuilder`를 주입하고 `KafkaStreams` 생명주기를 관리한다.

```java
@Configuration
@EnableKafkaStreams
public class WordCountTopology {

    @Bean
    public KStream<String, String> wordCount(StreamsBuilder builder) {
        KStream<String, String> lines = builder.stream("streams-input",
                Consumed.with(Serdes.String(), Serdes.String()));

        lines.flatMapValues(line -> Arrays.asList(line.toLowerCase().split("\\W+")))
             .filter((key, word) -> !word.isBlank())
             .groupBy((key, word) -> word, Grouped.with(Serdes.String(), Serdes.String()))
             .count(Materialized.as("word-count-store"))
             .toStream()
             .to("streams-output", Produced.with(Serdes.String(), Serdes.Long()));

        return lines;
    }
}
```

이벤트 본문의 발생 시각을 event time으로 쓰는 extractor.

```java
public class OccurredAtExtractor implements TimestampExtractor {

    @Override
    public long extract(ConsumerRecord<Object, Object> record, long partitionTime) {
        if (record.value() instanceof OrderEvent event) {
            return event.occurredAt().toEpochMilli();
        }
        return partitionTime;
    }
}
```

기동 시 topology를 로그로 남겨 SubTopology 경계를 확인한다.

```java
@Component
public class TopologyLogger implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(TopologyLogger.class);
    private final StreamsBuilderFactoryBean factoryBean;

    public TopologyLogger(StreamsBuilderFactoryBean factoryBean) {
        this.factoryBean = factoryBean;
    }

    @Override
    public void run(ApplicationArguments args) {
        log.info("{}", factoryBean.getTopology().describe());
    }
}
```

## 실무에서 걸리는 지점

- **파티션 수가 스케일 상한이다.** 입력 파티션 수를 넘는 인스턴스는 유휴 상태로 남는다. 예상 인스턴스 수의 4~8배로 파티션을 잡는다.
- ==**`application.id` 변경은 state 재빌드다.**== 내부 토픽·state 디렉토리 이름이 바뀌어 처음부터 다시 쌓는다.
- **changelog RF와 standby 기본값은 복구를 길게 만든다.** RF 1은 브로커 한 대 손실로 state를 잃을 수 있고, ==standby 0이면 인스턴스 교체마다 changelog 전체를 다시 읽는다.== 운영은 RF 3, standby 1 이상으로 둔다.
- **Serde 누락은 런타임에야 드러난다.** `count()` 결과를 `Produced.with` 없이 내보내면 기본 String Serde가 `ClassCastException`을 던진다.
- **스레드와 디스크는 호스트 자원에 맞춘다.** `num.stream.threads`가 CPU 코어를 넘으면 context switch 비용만 늘고, RocksDB state는 데이터 크기에 비례해 디스크를 점유한다.

## 관련 글

- [Consumer 동작 원리 — Pull·Group·Offset·Rebalance](/notes/kafka/consumer-internals-rebalance/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [Streams — DSL·Processor API·상태 저장](/notes/kafka/streams-dsl-processor-state/)
