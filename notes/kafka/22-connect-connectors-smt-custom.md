---
title: "Connect — Connector·SMT·커스텀 개발"
series: kafka
part: "Connect"
order: 22
summary: "Pre-built Connector 설정·Converter 짝 맞춤·SMT 체인으로 대부분을 해결하고, 없는 시스템만 SourceTask·SinkTask로 직접 구현한다"
tags: [Kafka Connect, Connector, SMT, Converter, Custom Connector]
sources: [data-infra/2026-05-17-kafka-connect-developer-guide.md, data-infra/2026-05-17-kafka-connect-config.md, 2026-05-02-kafka-connect-connectors.md, 2026-05-02-kafka-connect-transformations.md, 2026-05-02-kafka-advanced.md]
updated: 2026-08-29
---

외부 시스템과 Kafka를 잇는 코드를 직접 짜면 재시도, 오프셋 영속화, 장애 후 재개, 병렬 분할, 포맷 변환을 시스템마다 반복 구현하게 된다. ==Connect는 이 운영 기능을 프레임워크가 맡고 외부 시스템과 닿는 부분만 Connector 플러그인으로 교체하게 한다.== 작업은 Pre-built Connector 설정, 레코드 단위 변환인 SMT, Pre-built가 없을 때만 들어가는 커스텀 개발 세 층으로 갈린다.

## 핵심 개념

Connector 설정의 공통 필수값은 `name`, `connector.class`, `tasks.max`다. `name`은 Sink에서 Consumer Group ID(`connect-<name>`)로 쓰이므로 운영 중 바꾸면 토픽을 처음부터 다시 읽는다. 토픽 지정 키는 Source가 `topic`, Sink가 `topics` 또는 `topics.regex`다.

오프셋 저장 위치도 다르다. Source는 source partition과 source offset을 `connect-offsets` 내부 토픽에 기록하고, Sink는 일반 Consumer Group 오프셋을 쓴다. Sink의 `tasks.max`는 토픽 파티션 수가 상한이고, Source는 외부 시스템이 병렬 읽기를 지원하는 만큼만 유효하다.

Converter는 Struct와 바이트 사이의 직렬화 계층이며 key·value에 따로 지정한다. `JsonConverter`는 `schemas.enable=true`일 때 `schema`와 `payload`를 함께 싣고, `AvroConverter`는 스키마를 Schema Registry에 두고 메시지에는 ID만 넣는다. 같은 토픽을 오가는 Source와 Sink의 Converter 설정이 어긋나면 데이터가 깨지고, JDBC Sink처럼 컬럼 매핑에 스키마가 필요한 대상은 스키마를 켜야 한다.

SMT는 레코드 한 건을 받아 한 건을 돌려주는 stateless 변환이다. `transforms=A,B,C` 순서대로 체인이 실행되고, Source에서는 Converter 직전, Sink에서는 Converter 직후에 적용된다. 내장 SMT로 `InsertField`, `MaskField`, `RegexRouter`, `Flatten`, `Filter` 등이 있고, `predicates.*`로 조건을 걸어 일부 레코드에만 적용한다. 집계·조인처럼 상태가 필요한 변환은 Kafka Streams의 몫이다.

커스텀 Connector는 `ConfigDef`, `Connector`, `Task` 세 클래스로 구성된다. `taskConfigs(maxTasks)`가 작업을 분할한 설정 목록을 돌려주고, `SourceTask.poll()`은 `SourceRecord` 배치를, `SinkTask.put()`은 `SinkRecord` 컬렉션을 처리한다. Source는 `context.offsetStorageReader().offset(partition)`으로 마지막 위치를 복구하고, Sink의 오프셋 커밋은 `flush()` 성공 뒤 프레임워크가 수행한다.

## 코드

Pre-built Connector 설정. Avro Converter, SMT 체인과 Predicate, DLQ, ConfigProvider 비밀값 분리를 한 JSON에 담았다.

```json
{
  "name": "jdbc-source-orders",
  "config": {
    "connector.class": "io.confluent.connect.jdbc.JdbcSourceConnector",
    "tasks.max": "4",
    "connection.url": "jdbc:postgresql://db:5432/shop",
    "connection.password": "${file:/etc/kafka-connect/secrets.properties:db_password}",
    "topic.prefix": "pg-",
    "mode": "incrementing",
    "incrementing.column.name": "id",

    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "io.confluent.connect.avro.AvroConverter",
    "value.converter.schema.registry.url": "http://schema-registry:8081",

    "transforms": "MaskPii,AddIngestedAt,Route",
    "transforms.MaskPii.type": "org.apache.kafka.connect.transforms.MaskField$Value",
    "transforms.MaskPii.fields": "email,phone",
    "transforms.AddIngestedAt.type": "org.apache.kafka.connect.transforms.InsertField$Value",
    "transforms.AddIngestedAt.timestamp.field": "_ingestedAt",
    "transforms.Route.type": "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.Route.regex": "pg-(.*)",
    "transforms.Route.replacement": "shop.$1",
    "transforms.Route.predicate": "IsOrders",
    "predicates": "IsOrders",
    "predicates.IsOrders.type": "org.apache.kafka.connect.transforms.predicates.TopicNameMatches",
    "predicates.IsOrders.pattern": "pg-orders.*",

    "errors.tolerance": "all",
    "errors.deadletterqueue.topic.name": "dlq-jdbc-source-orders",
    "errors.deadletterqueue.context.headers.enable": "true"
  }
}
```

커스텀 Source Connector. 비밀값은 `Type.PASSWORD`로 잡고, `poll()`은 source partition과 offset을 `SourceRecord`에 실어 재시작 시 이어 읽게 한다.

```java
public class IssueSourceConfig extends AbstractConfig {
    public static final ConfigDef DEF = new ConfigDef()
        .define("topic", ConfigDef.Type.STRING, ConfigDef.Importance.HIGH, "target topic")
        .define("repo", ConfigDef.Type.STRING, ConfigDef.Importance.HIGH, "owner/repo")
        .define("api.token", ConfigDef.Type.PASSWORD, "", ConfigDef.Importance.HIGH, "API token")
        .define("batch.size", ConfigDef.Type.INT, 100, ConfigDef.Range.between(1, 100),
                ConfigDef.Importance.LOW, "records per poll");

    public IssueSourceConfig(Map<?, ?> originals) { super(DEF, originals); }
}

public class IssueSourceConnector extends SourceConnector {
    private Map<String, String> props;

    @Override public void start(Map<String, String> props) { this.props = props; }
    @Override public Class<? extends Task> taskClass() { return IssueSourceTask.class; }
    @Override public List<Map<String, String>> taskConfigs(int maxTasks) { return List.of(props); }
    @Override public void stop() { }
    @Override public ConfigDef config() { return IssueSourceConfig.DEF; }
    @Override public String version() { return "1.0.0"; }
}

public class IssueSourceTask extends SourceTask {
    private static final Schema VALUE_SCHEMA = SchemaBuilder.struct().name("Issue")
        .field("number", Schema.INT32_SCHEMA)
        .field("title", Schema.STRING_SCHEMA)
        .field("updatedAt", Timestamp.SCHEMA)
        .build();

    private IssueSourceConfig config;
    private IssueClient client;
    private Map<String, String> sourcePartition;
    private int lastNumber;

    @Override
    public void start(Map<String, String> props) {
        config = new IssueSourceConfig(props);
        sourcePartition = Map.of("repository", config.getString("repo"));
        Map<String, Object> offset = context.offsetStorageReader().offset(sourcePartition);
        lastNumber = offset == null ? -1 : ((Number) offset.get("lastNumber")).intValue();
        client = new IssueClient(config.getString("repo"), config.getPassword("api.token").value());
    }

    @Override
    public List<SourceRecord> poll() throws InterruptedException {
        List<Issue> issues = client.fetchAfter(lastNumber, config.getInt("batch.size"));
        if (issues.isEmpty()) {
            Thread.sleep(5_000);
            return List.of();
        }
        List<SourceRecord> records = new ArrayList<>(issues.size());
        for (Issue issue : issues) {
            lastNumber = issue.number();
            Struct value = new Struct(VALUE_SCHEMA)
                .put("number", issue.number())
                .put("title", issue.title())
                .put("updatedAt", Date.from(issue.updatedAt()));
            records.add(new SourceRecord(
                sourcePartition, Map.of("lastNumber", lastNumber),
                config.getString("topic"), null,
                Schema.STRING_SCHEMA, config.getString("repo") + "#" + issue.number(),
                VALUE_SCHEMA, value));
        }
        return records;
    }

    @Override public void stop() { client.close(); }
    @Override public String version() { return "1.0.0"; }
}
```

커스텀 SMT. `Transformation<R>`을 구현하고 `newRecord(...)`로 값만 바꾼 레코드를 돌려준다.

```java
public class UpperCaseField<R extends ConnectRecord<R>> implements Transformation<R> {
    private static final ConfigDef DEF = new ConfigDef()
        .define("field", ConfigDef.Type.STRING, ConfigDef.Importance.HIGH, "field to upper-case");
    private String field;

    @Override
    public void configure(Map<String, ?> configs) {
        field = new SimpleConfig(DEF, configs).getString("field");
    }

    @Override
    public R apply(R record) {
        if (!(record.value() instanceof Struct value)) return record;
        Struct updated = new Struct(value.schema());
        for (Field f : value.schema().fields()) {
            Object v = value.get(f);
            updated.put(f, f.name().equals(field) && v instanceof String s ? s.toUpperCase() : v);
        }
        return record.newRecord(record.topic(), record.kafkaPartition(),
            record.keySchema(), record.key(), value.schema(), updated, record.timestamp());
    }

    @Override public ConfigDef config() { return DEF; }
    @Override public void close() { }
}
```

## 실무에서 걸리는 지점

- **plugin.path 구조와 의존성 격리.** `plugin.path`는 Connector 디렉토리들의 부모 경로이며, 각 디렉토리에 의존성 jar까지 들어 있어야 한다. 플러그인별 classloader가 분리되므로 의존성이 빠지면 `ClassNotFoundException`이 나고, `connect-api`를 `provided`가 아닌 스코프로 묶으면 런타임과 충돌한다. 모든 Worker에 같은 플러그인을 설치한다.
- ==**Sink의 Exactly-once는 외부 시스템 몫이다.**== 외부 쓰기와 오프셋 커밋이 원자적이지 않아 재시작 시 중복 쓰기가 생긴다. JDBC Sink의 `insert.mode=upsert`와 `pk.mode=kafka`처럼 멱등 쓰기를 대상 쪽에서 보장한다. 중첩 필드는 `Flatten` SMT로 평탄화한 뒤 적재한다.
- **외부 API의 rate limit과 인터럽트.** 외부 API를 호출하는 Source는 `X-RateLimit-Remaining` 헤더를 보고 스스로 쉬어야 하고, `InterruptedException`은 반드시 다시 던져야 Connect가 Task를 종료시킬 수 있다.
- **비밀값 노출.** `Type.STRING`으로 잡은 토큰은 로그와 REST 응답에 그대로 찍힌다. `Type.PASSWORD`로 정의하고, Connector JSON에서는 ConfigProvider의 `${file:path:key}` 참조로 값을 밖에 둔다.
- **Connector RUNNING과 Task FAILED는 별개다.** 상태 점검은 Task 단위까지 내려가야 하고, `errors.tolerance=all`과 DLQ가 없으면 레코드 하나의 실패로 Task가 멈춘다.

## 관련 글

- [Connect — 아키텍처·Distributed Mode·운영](/notes/kafka/connect-architecture-operations/)
- [Streams — 입문과 핵심 개념](/notes/kafka/streams-intro-concepts/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
