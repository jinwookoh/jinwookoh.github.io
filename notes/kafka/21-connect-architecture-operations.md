---
title: "Connect — 아키텍처·Distributed Mode·운영"
series: kafka
part: "Connect"
order: 21
summary: "Worker·Connector·Task 3계층과 내부 토픽 3개가 Connect 클러스터를 이루며, 운영은 REST API와 DLQ로 수렴한다"
tags: [Kafka Connect, Distributed Mode, REST API, Dead Letter Queue, Worker]
sources: [data-infra/2026-05-17-kafka-connect-overview.md, data-infra/2026-05-17-kafka-connect-user-guide.md, 2026-05-02-kafka-connect-basics.md, 2026-05-02-kafka-connect-configuration.md, 2026-05-02-kafka-connect-advanced.md]
updated: 2026-08-29
---

DB 변경분을 Kafka로 들여오고 Kafka를 S3나 Elasticsearch로 내보내는 작업은 거의 모든 조직이 같은 형태로 반복한다. 이를 Producer·Consumer 코드로 직접 구현하면 오프셋 추적, 장애 재시작, 병렬화, 배포·모니터링을 파이프라인마다 다시 만들어야 한다. Kafka Connect는 이 두 패턴을 설정 기반 프레임워크로 표준화하고, 분산 실행·오프셋 관리·failover·REST 관리 인터페이스를 프레임워크가 제공한다.

## 핵심 개념

Connect는 ETL 중 Extract와 Load만 담당한다. Source Connector는 외부 시스템을 읽어 토픽에 쓰고(Debezium CDC, JDBC), Sink Connector는 토픽을 구독해 외부에 쓴다(JDBC, S3, Elasticsearch). 한 클러스터가 둘을 동시에 실행한다.

실행 구조는 3계층이다. Worker는 실제 실행 서버인 JVM 프로세스, Connector는 JAR과 설정으로 이루어진 논리 단위, Task는 Connector가 `tasks.max` 이하로 만들어 Worker들에 분산하는 실제 데이터 이동 단위다.

Standalone 모드는 단일 프로세스가 Connector properties를 명령줄에서 함께 받아 시작하고 오프셋을 로컬 파일에 저장한다. 프로세스가 죽으면 전부 멈추므로 개발·테스트 전용이다. Distributed 모드는 같은 `group.id`를 가진 Worker 여러 개가 클러스터를 이루고, 상태를 내부 토픽 3개에 둔다. `connect-configs`(설정, 파티션 1 고정)·`connect-offsets`(Source 오프셋)·`connect-status`(상태)다.

Distributed에서는 Connector properties 파일이 없다. Worker만 띄워 두고 REST API로 등록하면 설정이 `connect-configs`에 저장되어 모든 Worker가 공유한다. Worker는 Consumer Group과 같은 프로토콜로 Task를 나눠 갖고, Worker 증감 시 Incremental Cooperative Rebalance로 영향받는 Task만 재배치된다. Source 오프셋은 프레임워크가 `connect-offsets`에 커밋하고 재시작 시 그 위치에서 재개한다.

Converter는 Connect 내부 표현과 Kafka 바이트 사이의 직렬화를 맡으며, 처리량이 큰 환경은 Avro + Schema Registry가 표준이다.

REST API는 어느 Worker에 보내도 결과가 같다. `POST /connectors`는 `{name, config}` 본문으로 생성하고, `PUT /connectors/{name}/config`는 config만 보내며 없으면 생성·있으면 갱신하는 멱등 호출이다. `GET .../status`는 Connector와 Task 상태(RUNNING·PAUSED·STOPPED·FAILED 등)와 `trace`를 돌려주는데, ==Connector가 RUNNING이어도 Task가 FAILED일 수 있어 둘을 따로 본다.== `POST .../restart?includeTasks=true&onlyFailed=true`는 실패 Task만 재시작한다.

에러 처리는 `errors.tolerance`가 결정한다. 기본값 `none`은 레코드 하나가 실패해도 Task를 FAILED로 만들고, `all`은 건너뛰고 진행한다. ==`all`을 쓸 때 DLQ를 지정하지 않으면 실패 레코드는 유실된다.== DLQ는 Sink Connector에서만 지원되며, `context.headers.enable=true`면 원본 토픽·파티션·오프셋·예외가 `__connect.errors.*` 헤더에 실린다.

## 코드

운영용 Distributed Worker 설정이다. 같은 클러스터에 합류하려면 `group.id`·내부 토픽 3개·`plugin.path`가 동일해야 한다.

```properties
bootstrap.servers=kafka-1:9092,kafka-2:9092,kafka-3:9092
group.id=connect-cluster-prod

key.converter=org.apache.kafka.connect.json.JsonConverter
key.converter.schemas.enable=false
value.converter=io.confluent.connect.avro.AvroConverter
value.converter.schema.registry.url=http://schema-registry:8081

config.storage.topic=connect-configs
config.storage.replication.factor=3
offset.storage.topic=connect-offsets
offset.storage.replication.factor=3
offset.storage.partitions=25
status.storage.topic=connect-status
status.storage.replication.factor=3
status.storage.partitions=5

offset.flush.interval.ms=60000
listeners=http://0.0.0.0:8083
plugin.path=/opt/kafka/connectors

config.providers=env
config.providers.env.class=org.apache.kafka.common.config.provider.EnvVarConfigProvider
```

Spring Boot 3.x의 `RestClient`로 Connector를 멱등 배포하고 상태를 확인하는 클라이언트다.

```java
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class ConnectAdminClient {

    private final RestClient client;

    public ConnectAdminClient(RestClient.Builder builder) {
        this.client = builder.baseUrl("http://connect-1:8083").build();
    }

    public void deploy(String name, Map<String, String> config) {
        client.put()
            .uri("/connectors/{name}/config", name)
            .contentType(MediaType.APPLICATION_JSON)
            .body(config)
            .retrieve()
            .toBodilessEntity();
    }

    public record TaskStatus(int id, String state, String worker_id, String trace) {}
    public record ConnectorStatus(String name, Map<String, String> connector, List<TaskStatus> tasks) {}

    public ConnectorStatus status(String name) {
        return client.get()
            .uri("/connectors/{name}/status", name)
            .retrieve()
            .body(ConnectorStatus.class);
    }

    public void restartFailedTasks(String name) {
        client.post()
            .uri("/connectors/{name}/restart?includeTasks=true&onlyFailed=true", name)
            .retrieve()
            .toBodilessEntity();
    }
}
```

위 클라이언트로 등록하는 S3 Sink 설정이다. `errors.tolerance=all`과 DLQ를 한 세트로 둔다.

```java
Map<String, String> s3Sink = Map.ofEntries(
    Map.entry("connector.class", "io.confluent.connect.s3.S3SinkConnector"),
    Map.entry("tasks.max", "6"),
    Map.entry("topics", "events"),
    Map.entry("s3.bucket.name", "my-data-lake"),
    Map.entry("s3.region", "ap-northeast-2"),
    Map.entry("aws.access.key.id", "${env:AWS_ACCESS_KEY_ID}"),
    Map.entry("aws.secret.access.key", "${env:AWS_SECRET_ACCESS_KEY}"),
    Map.entry("format.class", "io.confluent.connect.s3.format.parquet.ParquetFormat"),
    Map.entry("partitioner.class", "io.confluent.connect.storage.partitioner.TimeBasedPartitioner"),
    Map.entry("partition.duration.ms", "3600000"),
    Map.entry("path.format", "'year'=YYYY/'month'=MM/'day'=dd/'hour'=HH"),
    Map.entry("flush.size", "10000"),
    Map.entry("rotate.interval.ms", "3600000"),
    Map.entry("errors.tolerance", "all"),
    Map.entry("errors.deadletterqueue.topic.name", "dlq-s3-sink-events"),
    Map.entry("errors.deadletterqueue.topic.replication.factor", "3"),
    Map.entry("errors.deadletterqueue.context.headers.enable", "true"),
    Map.entry("errors.log.enable", "true")
);
connectAdminClient.deploy("s3-sink-events", s3Sink);
```

## 실무에서 걸리는 지점

- **Worker 수와 tasks.max.** Worker 1~2대는 Standalone과 다를 게 없으므로 최소 3대로 시작한다. Sink의 `tasks.max`가 토픽 파티션 수를 넘으면 초과 Task는 놀기만 하므로 Sink는 파티션 수, Source는 테이블·샤드 같은 소스의 병렬 단위에 맞춘다.
- **내부 토픽 replication factor.** 단일 브로커 개발 환경에서 3으로 두면 토픽 생성이 실패하고, 운영에서 1로 두면 브로커 하나 장애에 클러스터 상태를 잃는다.
- **`group.id` 불일치.** 일부 Worker만 `group.id`가 다르면 두 클러스터로 갈라진다. 일반 Consumer Group ID와 겹쳐도 안 된다.
- **restart로 풀리지 않는 FAILED.** 설정 오류나 외부 시스템 장애는 재시작해도 같은 자리에서 죽으므로 `trace`를 먼저 읽는다.
- **Rolling restart와 비밀 값 노출.** 3대 중 2대를 동시에 내리면 남은 1대에 Task가 몰리므로 한 대씩 RUNNING 복귀를 확인하며 진행한다. ==REST 본문의 비밀번호는 `connect-configs`에 그대로 저장되므로 비밀 값은 `config.providers` 참조로만 남긴다.==

## 관련 글

- [Connect — Connector·SMT·커스텀 개발](/notes/kafka/connect-connectors-smt-custom/)
- [Consumer 동작 원리 — Pull·Group·Offset·Rebalance](/notes/kafka/consumer-internals-rebalance/)
- [인가 — ACL과 Multi-tenancy](/notes/kafka/security-acl-multitenancy/)
