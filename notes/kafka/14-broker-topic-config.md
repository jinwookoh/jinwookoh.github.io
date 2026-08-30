---
title: "Broker·Topic 설정"
series: kafka
part: "운영"
order: 14
summary: "Broker 기본값과 Topic 단위 override의 관계, 운영에서 실제로 손대는 설정과 적용 시점을 정리한다"
tags: [Kafka, Broker Config, Topic Config, KRaft, Retention]
sources: [data-infra/2026-05-17-kafka-broker-config.md, data-infra/2026-05-17-kafka-topic-config.md]
updated: 2026-08-29
---

Kafka broker 설정은 수백 개가 있고, topic 설정은 그 기본값을 topic 단위로 덮어쓴다. 두 층의 관계를 모르면 `acks=all`을 걸어 놓고도 `min.insync.replicas=1` 때문에 사실상 `acks=1`로 동작하거나, topic의 `max.message.bytes`만 올려 놓고 broker가 메시지를 거부하는 상황을 겪는다. `auto.create.topics.enable`이 켜진 운영 클러스터에는 오타 topic이 쌓인다.

## 핵심 개념

### Broker 설정의 범주

실무에서 조정하는 broker 설정은 다음과 같이 나뉜다.

- Identity: `node.id`, `process.roles`(`broker`, `controller`, `broker,controller`), `controller.quorum.voters`. KRaft 필수 항목이며 소규모는 결합, 대규모는 분리한다.
- Log: `log.dirs`(콤마 구분 JBOD), `log.retention.hours`/`log.retention.bytes`(먼저 도달한 쪽 발동), `log.segment.bytes`, `log.cleanup.policy`. `log.flush.interval.*`는 기본 무한대로 fsync를 OS pagecache에 맡긴다.
- Replication: `default.replication.factor=3`, `min.insync.replicas=2`, `unclean.leader.election.enable=false`.
- Network: `listeners`(bind 주소), `advertised.listeners`(클라이언트에게 알려주는 주소), `num.network.threads`, `num.io.threads`, `message.max.bytes`.
- Consumer Group: `offsets.retention.minutes`(기본 7일), `group.initial.rebalance.delay.ms`.
- Security·운영: `security.inter.broker.protocol`, `ssl.*`, `sasl.*`, `authorizer.class.name`, `auto.create.topics.enable=false`.

### Topic 설정과 default·override 관계

Topic 설정은 broker 설정과 접두사만 다른 짝을 이룬다. `log.retention.ms`와 `retention.ms`가 대표적이다. 명시하지 않은 값은 broker 기본값을 따르고 특수한 topic만 override한다. 자주 손대는 항목은 `retention.ms`/`retention.bytes`(partition 단위), `segment.bytes`/`segment.ms`, `cleanup.policy`, `compression.type`(`producer`가 기본), `min.insync.replicas`, `max.message.bytes`, `message.timestamp.type`이다. compact topic은 `min.cleanable.dirty.ratio`, `delete.retention.ms`를 추가로 조정한다.

### 동적 설정과 정적 설정

Broker 설정은 read-only(재시작 필요), per-broker, cluster-wide(`kafka-configs.sh`로 런타임 변경)로 나뉜다. Topic 설정은 전부 동적이며 대부분 즉시 반영된다. ==다만 `compression.type`과 `segment.bytes`는 새 segment부터 적용되고, `cleanup.policy`를 `compact`로 바꿔도 기존 데이터가 즉시 압축되지는 않는다.==

## 코드

운영 환경 broker 설정의 최소 골격이다. KRaft 결합 모드, RF=3, TLS 내부 통신을 전제로 한다.

```properties
node.id=1
process.roles=broker,controller
controller.quorum.voters=1@host1:9093,2@host2:9093,3@host3:9093
controller.listener.names=CONTROLLER

log.dirs=/var/kafka-data
log.retention.hours=168
log.segment.bytes=1073741824

default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
num.replica.fetchers=4

listeners=SSL://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
advertised.listeners=SSL://kafka-1.example.com:9092
num.network.threads=8
num.io.threads=16
compression.type=producer

security.inter.broker.protocol=SSL
ssl.keystore.location=/etc/kafka/ssl/keystore.jks
ssl.truststore.location=/etc/kafka/ssl/truststore.jks
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer

auto.create.topics.enable=false
delete.topic.enable=true
```

CLI로 topic override를 생성·변경·조회하고 broker 동적 설정을 바꾼다.

```bash
kafka-topics.sh --bootstrap-server localhost:9092 --create --topic orders \
  --partitions 3 --replication-factor 3 \
  --config retention.ms=86400000 --config compression.type=zstd

kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics --entity-name orders \
  --alter --add-config "retention.ms=172800000,min.insync.replicas=2"

kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics --entity-name orders --describe

kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type brokers --entity-name 1 \
  --alter --add-config "log.retention.hours=240"
```

Spring Boot 3.x에서 `KafkaAdmin`이 기동 시 `NewTopic` bean을 생성하고, `incrementalAlterConfigs`로 운영 중 override를 바꾼다.

```java
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AlterConfigOp;
import org.apache.kafka.clients.admin.ConfigEntry;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.config.ConfigResource;
import org.apache.kafka.common.config.TopicConfig;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaAdmin;

@Configuration
public class TopicConfiguration {

    @Bean
    public NewTopic ordersTopic() {
        return TopicBuilder.name("orders")
                .partitions(3)
                .replicas(3)
                .config(TopicConfig.RETENTION_MS_CONFIG, "604800000")
                .config(TopicConfig.MIN_IN_SYNC_REPLICAS_CONFIG, "2")
                .config(TopicConfig.COMPRESSION_TYPE_CONFIG, "producer")
                .build();
    }

    @Bean
    public NewTopic productStateTopic() {
        return TopicBuilder.name("product-state")
                .partitions(6)
                .replicas(3)
                .compact()
                .config(TopicConfig.SEGMENT_BYTES_CONFIG, "104857600")
                .config(TopicConfig.DELETE_RETENTION_MS_CONFIG, "86400000")
                .build();
    }

    public void extendRetention(KafkaAdmin kafkaAdmin, String topic, long retentionMs)
            throws ExecutionException, InterruptedException {
        try (Admin admin = Admin.create(kafkaAdmin.getConfigurationProperties())) {
            ConfigResource resource = new ConfigResource(ConfigResource.Type.TOPIC, topic);
            AlterConfigOp op = new AlterConfigOp(
                    new ConfigEntry(TopicConfig.RETENTION_MS_CONFIG, String.valueOf(retentionMs)),
                    AlterConfigOp.OpType.SET);
            admin.incrementalAlterConfigs(Map.of(resource, List.of(op))).all().get();
        }
    }
}
```

## 실무에서 걸리는 지점

- `retention.bytes`는 partition 단위다. ==partition 10개에 1GB를 주면 topic 전체는 10GB까지 커진다.==
- `max.message.bytes`를 topic에서만 올리면 broker의 `message.max.bytes`에 걸려 거부된다. 두 값을 함께 조정하고 consumer의 `max.partition.fetch.bytes`도 맞춘다.
- `advertised.listeners`가 resolve되지 않는 호스트명이면 bootstrap 연결은 되어도 metadata의 주소로 재연결하면서 실패한다.
- `log.flush.interval.*`를 명시하면 매번 fsync가 발생해 처리량이 크게 떨어진다. 내구성은 replication과 `min.insync.replicas`로 보장한다.
- ==`compression.type=producer`는 producer가 압축하지 않으면 비압축으로 저장된다.== `segment.bytes`를 너무 낮추면 파일 수가 폭증해 file descriptor를 소진한다.

## 관련 글

- [Replication — ISR·리더 선출·Unclean](/notes/kafka/replication-isr/)
- [Admin Client — API 5종 개관과 관리 작업](/notes/kafka/admin-client/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
