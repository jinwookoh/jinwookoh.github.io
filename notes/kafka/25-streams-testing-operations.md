---
title: "Streams — 테스트와 운영"
series: kafka
part: "Streams"
order: 25
summary: "TopologyTestDriver로 토폴로지를 검증하고, 예외 핸들러·standby·reset 도구로 Streams 앱을 운영하는 방법"
tags: [Kafka Streams, TopologyTestDriver, Spring Boot, Exception Handler, Application Reset]
sources: [data-infra/2026-05-17-kafka-streams-write-run-app.md, data-infra/2026-05-17-kafka-streams-testing.md, data-infra/2026-05-17-kafka-streams-ops.md]
updated: 2026-08-29
---

Kafka Streams는 JVM 프로세스 안의 라이브러리이므로 테스트와 운영의 책임이 애플리케이션에 남는다. 실제 클러스터에 붙여야만 토폴로지를 검증할 수 있으면 피드백 루프가 늘어지고, 예외 핸들러를 지정하지 않으면 잘못된 메시지 하나에 스트림 스레드가 죽은 채 복구되지 않는다. 상태 저장소 위치와 standby를 정해 두지 않으면 배포와 장애 때마다 상태 재구축에 시간을 쓴다.

## 핵심 개념

### 테스트의 두 층위

단위 테스트는 `kafka-streams-test-utils`의 `TopologyTestDriver`를 쓴다. 브로커 없이 토폴로지를 단일 스레드·인메모리로 실행하며 `TestInputTopic`으로 레코드를 넣고 `TestOutputTopic`으로 결과를 읽는다. 레코드마다 타임스탬프를 지정해 이벤트 시간 윈도를 결정적으로 검증하고, `advanceWallClockTime`으로 Punctuator를 호출하며, `getKeyValueStore`로 상태 저장소를 조회한다.

통합 테스트는 실제 브로커를 띄운다. Spring Kafka의 `@EmbeddedKafka`는 JVM 안에, Testcontainers의 `KafkaContainer`는 Docker에 브로커를 올린다. 리밸런스·EOS처럼 스레드와 파티션 경계에서 생기는 동작은 이 층에서만 검증된다.

### 라이프사이클과 예외 핸들러

`KafkaStreams`는 `CREATED → REBALANCING → RUNNING`을 오가다 `close()` 시 `NOT_RUNNING`, 예외 시 `ERROR`로 전이한다.

예외 핸들러는 세 지점에 있다. `deserialization.exception.handler`의 기본값 `LogAndFailExceptionHandler`는 입력 포맷이 깨지면 스트림을 종료하므로 운영에서는 `LogAndContinueExceptionHandler`나 DLQ 커스텀 구현을 쓴다. `production.exception.handler`는 출력 쓰기 실패에서 `CONTINUE`/`FAIL`을 결정한다. `StreamsUncaughtExceptionHandler`는 새어 나온 예외를 받아 `REPLACE_THREAD`·`SHUTDOWN_CLIENT`·`SHUTDOWN_APPLICATION` 중 하나를 반환하며, 실패한 스레드만 교체하는 `REPLACE_THREAD`가 기본 선택이다.

### 상태와 무중단 배포

상태는 `state.dir` 아래 RocksDB에 두고 변경분은 `<app-id>-<store>-changelog` 토픽에 기록된다. 인스턴스가 사라지면 다른 인스턴스가 changelog를 읽어 상태를 재구축하는데, `num.standby.replicas ≥ 1`이면 복제본을 가진 인스턴스가 즉시 인계받는다. 여기에 `group.instance.id`를 더하면 rolling update가 무중단으로 진행된다. Blue-Green은 `application.id`가 달라져 상태를 새로 빌드해야 하고, Canary는 두 버전이 파티션을 나눠 갖게 되므로 맞지 않는다.

### 보안과 Reset

Streams는 내부적으로 producer·consumer·admin을 모두 쓰므로 SASL_SSL 설정이 세 클라이언트에 적용되어야 하며, ACL은 입출력 토픽 외에 `application.id` 접두사의 PREFIXED 토픽·그룹·transactional-id, EOS용 cluster IdempotentWrite가 필요하다.

재처리나 상태 손상 복구에는 `kafka-streams-application-reset.sh`를 쓴다. 컨슈머 그룹 오프셋을 초기화하고 내부 토픽을 재생성한다. 애플리케이션을 정지한 뒤 `--dry-run`으로 확인하고 `--execute`하며, 로컬 `state.dir`은 별도로 삭제한다.

## 코드

TopologyTestDriver로 단어 집계 토폴로지를 검증한다.

```java
class WordCountTopologyTest {

    private TopologyTestDriver driver;
    private TestInputTopic<String, String> input;
    private TestOutputTopic<String, Long> output;

    @BeforeEach
    void setUp() {
        StreamsBuilder builder = new StreamsBuilder();
        builder.<String, String>stream("input-topic")
               .flatMapValues(v -> List.of(v.split(" ")))
               .groupBy((k, w) -> w, Grouped.with(Serdes.String(), Serdes.String()))
               .count(Materialized.as("word-counts"))
               .toStream()
               .to("output-topic", Produced.with(Serdes.String(), Serdes.Long()));

        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "test-" + UUID.randomUUID());
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "dummy:1234");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.StringSerde.class);
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.StringSerde.class);

        driver = new TopologyTestDriver(builder.build(), props);
        input = driver.createInputTopic("input-topic", new StringSerializer(), new StringSerializer());
        output = driver.createOutputTopic("output-topic", new StringDeserializer(), new LongDeserializer());
    }

    @AfterEach
    void tearDown() {
        driver.close();
    }

    @Test
    void countsWordsAndMaterializesStore() {
        input.pipeInput("k1", "hello world hello", Instant.parse("2026-08-29T09:00:00Z"));

        Map<String, Long> result = output.readKeyValuesToMap();
        assertEquals(2L, result.get("hello"));
        assertEquals(1L, result.get("world"));
        assertTrue(output.isEmpty());

        KeyValueStore<String, Long> store = driver.getKeyValueStore("word-counts");
        assertEquals(2L, store.get("hello"));
    }
}
```

Spring Boot에서 `@EnableKafkaStreams`로 토폴로지를 등록하고 예외 핸들러와 Actuator 헬스를 붙인다. 유효하지 않은 레코드는 `split()`으로 DLQ에 분기한다.

```java
@Configuration
@EnableKafkaStreams
public class OrderStreamsConfig {

    @Bean
    public KStream<String, String> orderTopology(StreamsBuilder builder) {
        KStream<String, String> orders = builder.stream("orders");
        Map<String, KStream<String, String>> branches = orders.split(Named.as("orders-"))
            .branch((k, v) -> v != null && v.startsWith("{"), Branched.as("valid"))
            .defaultBranch(Branched.as("invalid"));
        branches.get("orders-valid").mapValues(String::toUpperCase).to("orders-processed");
        branches.get("orders-invalid").to("orders-dlq");
        return orders;
    }

    @Bean
    public StreamsBuilderFactoryBeanConfigurer streamsConfigurer() {
        return factoryBean -> {
            factoryBean.setStateListener((newState, oldState) ->
                LoggerFactory.getLogger(getClass()).info("streams {} -> {}", oldState, newState));
            factoryBean.setStreamsUncaughtExceptionHandler(ex ->
                StreamsUncaughtExceptionHandler.StreamThreadExceptionResponse.REPLACE_THREAD);
        };
    }

    @Bean
    public HealthIndicator kafkaStreamsHealth(StreamsBuilderFactoryBean factoryBean) {
        return () -> {
            KafkaStreams streams = factoryBean.getKafkaStreams();
            if (streams == null) {
                return Health.down().withDetail("reason", "not started").build();
            }
            KafkaStreams.State state = streams.state();
            Health.Builder builder = state.isRunningOrRebalancing() ? Health.up() : Health.down();
            return builder.withDetail("state", state.name()).build();
        };
    }
}
```

운영용 `application.yml`이다.

```yaml
spring:
  kafka:
    bootstrap-servers: kafka1:9093,kafka2:9093,kafka3:9093
    streams:
      application-id: order-streams-prod
      state-dir: /var/lib/kafka-streams
      properties:
        num.stream.threads: 4
        processing.guarantee: exactly_once_v2
        commit.interval.ms: 1000
        replication.factor: 3
        num.standby.replicas: 1
        acceptable.recovery.lag: 10000
        max.warmup.replicas: 2
        group.instance.id: ${HOSTNAME}
        deserialization.exception.handler: org.apache.kafka.streams.errors.LogAndContinueExceptionHandler
        security.protocol: SASL_SSL
        sasl.mechanism: SCRAM-SHA-512
        sasl.jaas.config: >
          org.apache.kafka.common.security.scram.ScramLoginModule required
          username="${KAFKA_USER}" password="${KAFKA_PASSWORD}";
        ssl.truststore.location: /etc/kafka/ssl/truststore.jks
        ssl.truststore.password: ${TRUSTSTORE_PASSWORD}
```

## 실무에서 걸리는 지점

- **TopologyTestDriver가 통과해도 운영에서 어긋나는 영역이 있다.** 파티션 간 순서, 리밸런스 중 재처리, RocksDB 동작은 검증되지 않는다. 운영과 같은 Serializer를 써야 바이트 호환성도 검증된다.
- **`advanceWallClockTime`은 Punctuator에만 영향을 준다.** 이벤트 시간 윈도는 `pipeInput`의 타임스탬프로 진행시키고, 닫으려면 grace period를 넘기는 후속 레코드를 넣는다.
- **`state.dir` 기본값은 `/tmp` 아래다.** 재시작 시 상태가 사라져 changelog 전체를 다시 읽는다. 영구 볼륨과 standby 1 이상이 없으면 복구가 수 시간 걸릴 수 있다.
- **EOS에서는 커밋 주기가 곧 트랜잭션 주기다.** `commit.interval.ms`를 지나치게 낮추면 처리량이 떨어진다. `exactly_once`(v1)는 deprecated이므로 `exactly_once_v2`를 쓴다.
- **`application.id`가 겹치면 컨슈머 그룹과 내부 토픽이 섞인다.** 접두사로 환경을 분리한다. 메이저 업그레이드는 `upgrade.from`을 적고 rolling restart, 안정화 후 제거하고 다시 rolling restart한다.

## 관련 글

- [Streams — 입문과 핵심 개념](/notes/kafka/streams-intro-concepts/)
- [Streams — DSL·Processor API·상태 저장](/notes/kafka/streams-dsl-processor-state/)
- [Spring Kafka — 배치·에러·트랜잭션·테스트](/notes/kafka/spring-kafka/)
