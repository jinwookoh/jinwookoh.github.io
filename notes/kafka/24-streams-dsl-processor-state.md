---
title: "Streams — DSL·Processor API·상태 저장"
series: kafka
part: "Streams"
order: 24
summary: "DSL로 변환·집계·조인·윈도우를 선언하고, 시간 기반 작업과 복잡한 상태 조작은 Processor API로 내려가며, 저장된 상태는 Interactive Queries로 외부에 노출한다."
tags: [Kafka Streams, DSL, Processor API, State Store, Interactive Queries]
sources: [data-infra/2026-05-17-kafka-streams-dsl.md, data-infra/2026-05-17-kafka-streams-processor-api.md, data-infra/2026-05-17-kafka-streams-stateful-iq.md]
updated: 2026-08-29
---

Consumer API만으로 실시간 집계를 구현하면 키별 누적값 보관, 재시작 시 복구, 파티션 재할당 시 상태 이동, 늦은 레코드 처리를 전부 애플리케이션이 떠안는다. Kafka Streams는 이를 세 층으로 나눈다. DSL은 변환·집계·조인·윈도우를 선언적으로 표현하고, Processor API는 시간 기반 작업과 상태 조작을 저수준으로 제어하며, state store는 changelog로 복구되고 Interactive Queries로 외부에 노출된다.

## 핵심 개념

### DSL 연산의 네 영역

Stateless 연산(`filter`·`mapValues`·`flatMap`·`peek`·`selectKey`·`split`)은 상태 없이 레코드를 하나씩 처리한다. Stateful 연산(`groupByKey`·`groupBy` 뒤의 `count`·`reduce`·`aggregate`)은 키별 누적값을 state store에 유지하고 KTable을 돌려준다. Join은 KStream-KStream(시간 윈도우 기반), KStream-KTable(테이블의 현재 값을 붙이는 enrichment), KTable-KTable(두 상태의 최신값 결합) 세 조합이 있다. Window는 Tumbling(겹치지 않는 고정 구간), Hopping(advance 간격으로 겹침), Sliding(레코드 간 시간 차 기준), Session(비활동 gap 기준 가변 구간)으로 나뉘며, ==윈도우가 닫힌 뒤 grace period 안에 도착한 레코드만 반영되고 그 이후는 버려진다.==

### Repartition

`selectKey`·`groupBy`처럼 키를 바꾸는 연산 뒤에 집계나 조인이 오면 같은 키를 같은 파티션에 모으기 위해 내부 repartition 토픽이 생기고 브로커 I/O가 추가된다. 키를 건드리지 않는 `mapValues`·`groupByKey`는 repartition을 일으키지 않는다.

### Processor API

DSL은 Processor API 위의 추상화이다. `Topology`에 `addSource`·`addProcessor`·`addStateStore`·`addSink`로 노드를 연결해 DAG를 만든다. `Processor`는 `init`에서 state store와 Punctuator를 등록하고, `process`에서 레코드를 처리한 뒤 `context.forward`로 하류에 전달한다. Punctuator는 `STREAM_TIME`(레코드 타임스탬프가 진행할 때만 호출)과 `WALL_CLOCK_TIME`(실제 시계 기준) 두 종류다. Kafka 3.3부터 DSL 체인 안의 `process`·`processValues`는 KStream을 반환해 하류 연산을 이어갈 수 있고, `transform` 계열은 deprecated이다.

### 상태 저장과 외부 조회

State store는 기본적으로 RocksDB 기반이며 `KeyValueStore`·`WindowStore`·`SessionStore`가 있다. `Materialized.as("이름")`으로 명명한 store는 Interactive Queries(IQ) 대상이 된다. IQ v2(`streams.query`)는 `KeyQuery`·`RangeQuery`·`WindowKeyQuery`·`WindowRangeQuery`를 지원한다. 상태는 파티션 단위로 분산되므로 `queryMetadataForKey`로 위치를 확인하고, 원격이면 `application.server`에 등록된 주소로 전달한다. `num.standby.replicas`를 1 이상으로 두면 failover가 빨라지고 standby에서도 조회할 수 있다.

## 코드

주문 스트림을 프로필 KTable과 조인한 뒤 카테고리별 1시간 매출을 명명된 store에 집계하는 DSL 토폴로지이다.

```java
@Configuration
@EnableKafkaStreams
public class RevenueTopology {

    @Bean
    public KStream<String, EnrichedOrder> revenue(StreamsBuilder builder) {
        KTable<String, UserProfile> profiles = builder.table("user-profiles",
                Consumed.with(Serdes.String(), new JsonSerde<>(UserProfile.class)));

        KStream<String, Order> orders = builder.stream("orders",
                Consumed.with(Serdes.String(), new JsonSerde<>(Order.class)));

        KStream<String, EnrichedOrder> enriched = orders.join(profiles,
                (order, profile) -> new EnrichedOrder(order, profile));

        enriched
            .groupBy((userId, o) -> o.category(),
                     Grouped.with(Serdes.String(), new JsonSerde<>(EnrichedOrder.class)))
            .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofHours(1), Duration.ofMinutes(5)))
            .aggregate(() -> 0.0,
                       (category, o, total) -> total + o.amount(),
                       Materialized.<String, Double, WindowStore<Bytes, byte[]>>as("hourly-revenue")
                           .withKeySerde(Serdes.String())
                           .withValueSerde(Serdes.Double()))
            .toStream()
            .to("hourly-revenue",
                Produced.with(WindowedSerdes.timeWindowedSerdeFrom(String.class, Duration.ofHours(1).toMillis()),
                              Serdes.Double()));

        return enriched;
    }
}
```

DSL 체인에 Processor를 삽입해 키별 마지막 접근 시각을 기록하고, 1시간마다 7일 넘게 비활동인 키를 정리한다.

```java
public class LastSeenProcessor implements Processor<String, Event, String, Event> {

    private KeyValueStore<String, Long> store;
    private ProcessorContext<String, Event> context;

    @Override
    public void init(ProcessorContext<String, Event> context) {
        this.context = context;
        this.store = context.getStateStore("last-seen");
        context.schedule(Duration.ofHours(1), PunctuationType.WALL_CLOCK_TIME, now -> {
            long cutoff = now - Duration.ofDays(7).toMillis();
            try (KeyValueIterator<String, Long> it = store.all()) {
                while (it.hasNext()) {
                    KeyValue<String, Long> kv = it.next();
                    if (kv.value < cutoff) store.delete(kv.key);
                }
            }
        });
    }

    @Override
    public void process(Record<String, Event> record) {
        store.put(record.key(), record.timestamp());
        context.forward(record);
    }
}

// 토폴로지 등록
builder.addStateStore(Stores.keyValueStoreBuilder(
        Stores.persistentKeyValueStore("last-seen"), Serdes.String(), Serdes.Long()));

builder.stream("events", Consumed.with(Serdes.String(), new JsonSerde<>(Event.class)))
       .process(LastSeenProcessor::new, "last-seen")
       .to("events-seen");
```

명명된 store를 IQ v2로 조회하는 엔드포인트이다. 키가 다른 인스턴스에 있으면 `RestClient`로 전달한다.

```java
@RestController
public class RevenueQueryController {

    private final StreamsBuilderFactoryBean factory;
    private final RestClient restClient = RestClient.create();
    private final HostInfo self;

    public RevenueQueryController(StreamsBuilderFactoryBean factory,
                                  @Value("${spring.kafka.streams.properties.application.server}") String server) {
        this.factory = factory;
        this.self = HostInfo.buildFromEndpoint(server);
    }

    @GetMapping("/revenue/{category}")
    public Double revenue(@PathVariable String category, @RequestParam long windowStart) {
        KafkaStreams streams = factory.getKafkaStreams();
        KeyQueryMetadata meta = streams.queryMetadataForKey(
                "hourly-revenue", category, Serdes.String().serializer());
        if (meta == null || meta.equals(KeyQueryMetadata.NOT_AVAILABLE)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
        }
        if (!meta.activeHost().equals(self)) {
            return restClient.get()
                    .uri("http://{h}:{p}/revenue/{c}?windowStart={w}",
                         meta.activeHost().host(), meta.activeHost().port(), category, windowStart)
                    .retrieve().body(Double.class);
        }
        StateQueryRequest<Double> request = StateQueryRequest
                .inStore("hourly-revenue")
                .withQuery(WindowKeyQuery.<String, Double>withKeyAndWindowStartRange(
                        category, Instant.ofEpochMilli(windowStart), Instant.ofEpochMilli(windowStart)))
                .withPartitions(Set.of(meta.partition()));
        return streams.query(request).getOnlyPartitionResult().getResult();
    }
}
```

## 실무에서 걸리는 지점

- **윈도우 상태 누적**: 윈도우 크기·키 카디널리티·grace period가 함께 커지면 state store와 changelog가 비례해 커진다. KStream-KStream 조인 윈도우는 업무상 필요한 최소 범위로 잡는다.
- **SerDe 미지정**: `Grouped.with`·`Produced.with`·`Materialized.with`로 명시하지 않으면 기본 SerDe로 떨어지고 타입이 어긋나면 런타임 예외가 난다. 윈도우 결과 출력에는 `WindowedSerdes`가 필요하다.
- **Punctuator 종류**: ==`STREAM_TIME`은 레코드가 없으면 호출되지 않으므로 heartbeat·주기적 정리는 `WALL_CLOCK_TIME`으로 등록한다.==
- **외부 호출과 iterator 누수**: `process`에서 HTTP·DB를 동기 호출하면 stream thread가 막힌다. `store.all()`·`range()`의 iterator는 try-with-resources로 닫는다.
- **IQ 일관성과 메모리**: ==IQ는 커밋 전 상태와 standby의 지연된 상태를 그대로 보여 주므로 stale read를 허용하는 조회에만 쓴다.== ==RocksDB는 JVM heap 밖 native 메모리를 쓰므로 컨테이너 한도를 heap 기준으로만 잡으면 OOM kill이 난다.== store 이름을 바꾸면 상태를 다시 빌드한다.

## 관련 글

- [Streams — 입문과 핵심 개념](/notes/kafka/streams-intro-concepts/)
- [Streams — 테스트와 운영](/notes/kafka/streams-testing-operations/)
- [Spring Kafka — 배치·에러·트랜잭션·테스트](/notes/kafka/spring-kafka/)
