---
title: "Admin Client — API 5종 개관과 관리 작업"
series: kafka
part: "클라이언트"
order: 13
summary: "Kafka 5가지 API의 분담을 정리하고, Admin Client로 Topic·Consumer Group·ACL을 코드로 관리하는 방법을 다룬다."
tags: [Kafka, AdminClient, KafkaFuture, TopicBuilder, Provisioning]
sources: [data-infra/2026-05-17-kafka-apis-overview.md, data-infra/2026-05-17-kafka-admin-client-api.md, data-infra/2026-05-17-kafka-admin-config.md]
updated: 2026-08-29
---

Topic 생성·파티션 확장·Consumer Group offset 되돌리기를 매번 CLI로 수동 처리하면 환경마다 Topic 설정이 어긋나고, 배포 직후 없는 Topic 때문에 애플리케이션이 실패하며, 장애 복구 수단이 사람 손밖에 남지 않는다. Admin Client는 이런 운영 작업을 코드와 CI/CD 파이프라인 안으로 끌어들여 재현 가능하게 만드는 API다.

## 핵심 개념

### Kafka API 5종의 분담

| API | 역할 | 의존성 |
|:---|:---|:---|
| Producer | 메시지 send | `kafka-clients` |
| Consumer | 메시지 read | `kafka-clients` |
| Streams | Topic 간 변환·집계·조인 | `kafka-streams` |
| Connect | 외부 시스템 통합 | `connect-api` (커스텀 개발 시) |
| Admin | Topic·Group·ACL·Cluster 관리 | `kafka-clients` |

Producer·Consumer·Admin은 `kafka-clients` 하나로 모두 쓸 수 있다. Streams는 Producer와 Consumer 위에 스트림 처리 추상화를 얹은 별도 라이브러리이고, Connect는 애플리케이션과 분리된 worker 프로세스로 운영된다. 공식 유지보수 클라이언트는 Java뿐이며 다른 언어는 대부분 librdkafka 기반이다. Admin은 provisioning·모니터링·복구 스크립트에서 쓰인다.

### Admin Client의 작업 범위

`Admin.create(props)`로 생성한 인스턴스 하나로 Topic(`createTopics`·`describeTopics`·`deleteTopics`·`incrementalAlterConfigs`·`createPartitions`), Consumer Group(`describeConsumerGroups`·`listConsumerGroupOffsets`·`alterConsumerGroupOffsets`), ACL(`createAcls`·`describeAcls`·`deleteAcls`), Cluster(`describeCluster`)를 다룬다. `TopicDescription`은 파티션별 leader·replicas·ISR을 담는다. `listConsumerGroupOffsets`는 커밋된 offset만 주므로 log end offset은 `KafkaConsumer.endOffsets()`로 따로 조회한다.

모든 메서드는 `KafkaFuture`를 즉시 반환한다. `.get()`으로 블로킹하는 동기 방식이 운영 스크립트의 표준이고, `whenComplete` 콜백과 `thenApply` 체이닝은 애플리케이션 안에서 블로킹을 피할 때 쓴다. 실패는 `ExecutionException`으로 감싸지므로 원인은 `getCause()`로 판별한다.

### 설정

`bootstrap.servers`가 유일한 필수 항목이다. `request.timeout.ms`(기본 30초)는 요청 하나의 응답 대기, `default.api.timeout.ms`(기본 60초)는 retry를 포함한 호출 전체의 상한이며, 특정 호출만 바꾸려면 `CreateTopicsOptions().timeoutMs(...)`를 넘긴다. `client.id`는 broker 로그에서 호출 주체를 식별하므로 CI/CD 도구라면 명시한다. 일회성 작업은 CLI, 애플리케이션 시작 시 provisioning은 Admin API와 Spring `TopicBuilder`, GitOps 흐름은 Terraform이나 Strimzi `KafkaTopic` CRD가 맞는다.

## 코드

Topic 생성·조회·설정 변경·파티션 확장을 한 흐름으로 처리하며, 이미 존재하는 Topic은 정상으로 간주한다.

```java
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.common.config.ConfigResource;
import org.apache.kafka.common.errors.TopicExistsException;
import java.util.*;
import java.util.concurrent.ExecutionException;

public class TopicProvisioner {

    public void provision() throws Exception {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka1:9092,kafka2:9092");
        props.put(AdminClientConfig.CLIENT_ID_CONFIG, "ci-cd-provisioner");
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, "15000");
        props.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, "60000");

        try (Admin admin = Admin.create(props)) {
            NewTopic orders = new NewTopic("orders", 3, (short) 3)
                    .configs(Map.of(
                            "retention.ms", "604800000",
                            "compression.type", "zstd",
                            "min.insync.replicas", "2"));
            try {
                admin.createTopics(List.of(orders)).all().get();
            } catch (ExecutionException e) {
                if (!(e.getCause() instanceof TopicExistsException)) {
                    throw e;
                }
            }

            TopicDescription desc = admin.describeTopics(List.of("orders"))
                    .allTopicNames().get().get("orders");
            desc.partitions().forEach(p -> System.out.printf(
                    "P%d leader=%d isr=%s%n",
                    p.partition(), p.leader().id(), p.isr()));

            ConfigResource resource = new ConfigResource(ConfigResource.Type.TOPIC, "orders");
            AlterConfigOp op = new AlterConfigOp(
                    new ConfigEntry("retention.ms", "1209600000"), AlterConfigOp.OpType.SET);
            admin.incrementalAlterConfigs(Map.of(resource, List.of(op))).all().get();

            admin.createPartitions(Map.of("orders", NewPartitions.increaseTo(6))).all().get();
        }
    }
}
```

Consumer Group의 lag을 계산하고 offset을 되돌린다. end offset은 Admin이 아닌 Consumer에서 조회한다.

```java
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.TopicPartition;
import java.util.*;

public class GroupOperator {

    private final Admin admin;
    private final Properties consumerProps;

    public GroupOperator(Admin admin, Properties consumerProps) {
        this.admin = admin;
        this.consumerProps = consumerProps;
    }

    public Map<TopicPartition, Long> lag(String groupId) throws Exception {
        Map<TopicPartition, OffsetAndMetadata> committed = admin
                .listConsumerGroupOffsets(groupId)
                .partitionsToOffsetAndMetadata().get();

        try (KafkaConsumer<byte[], byte[]> consumer = new KafkaConsumer<>(consumerProps)) {
            Map<TopicPartition, Long> ends = consumer.endOffsets(committed.keySet());
            Map<TopicPartition, Long> result = new HashMap<>();
            committed.forEach((tp, meta) -> result.put(tp, ends.get(tp) - meta.offset()));
            return result;
        }
    }

    // 그룹의 모든 멤버가 내려간 상태에서만 호출한다
    public void resetToBeginning(String groupId, String topic, int partition) throws Exception {
        admin.alterConsumerGroupOffsets(groupId, Map.of(
                new TopicPartition(topic, partition), new OffsetAndMetadata(0L)
        )).all().get();
    }
}
```

Spring Boot에서는 `NewTopic` Bean을 선언하면 `KafkaAdmin`이 시작 시 Topic을 생성하고 이미 있으면 건너뛴다. 설정은 `spring.kafka.admin.properties`에 둔다.

```java
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic ordersTopic() {
        return TopicBuilder.name("orders")
                .partitions(3)
                .replicas(3)
                .config("retention.ms", "604800000")
                .config("min.insync.replicas", "2")
                .build();
    }
}
```

```yaml
spring:
  kafka:
    bootstrap-servers: kafka1:9092,kafka2:9092
    admin:
      properties:
        client.id: app-provisioner
        request.timeout.ms: 15000
        default.api.timeout.ms: 60000
        security.protocol: SASL_SSL
        sasl.mechanism: SCRAM-SHA-512
```

## 실무에서 걸리는 지점

- **파티션은 늘릴 수만 있다.** 늘리는 순간 key 기반 매핑이 바뀌어 같은 key의 순서 보장이 그 시점에 끊긴다. 기존 메시지는 원래 파티션에 남고 새 메시지만 재해시된다.
- **`deleteTopics`는 요청만 접수한다.** 실제 삭제는 broker가 백그라운드에서 처리하며 큰 Topic은 수 분이 걸린다. 같은 이름으로 재생성하려면 `listTopics`로 확인한 뒤 진행한다.
- **`.get()`은 hot path에 두지 않는다.** `default.api.timeout.ms`만큼 스레드가 묶이므로 동기 호출은 시작 시점과 운영 스크립트로 한정한다.
- **`alterConsumerGroupOffsets`는 그룹이 비어 있어야 한다.** 활성 멤버가 있으면 실패하므로 Consumer를 모두 내린 뒤 offset을 옮기고 다시 올린다.
- **ACL 환경에서는 별도 권한이 필요하다.** `Cluster:Describe`·`Topic:Create` 권한이 없으면 `AuthorizationException`이 발생한다. 애플리케이션 계정과 provisioning 계정을 분리한다. 수백 개 Topic을 만들 때는 리스트로 묶어 controller 부하를 줄인다.

## 관련 글

- [Producer API와 설정](/notes/kafka/producer-api-config/)
- [Consumer API와 설정](/notes/kafka/consumer-api-config/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
