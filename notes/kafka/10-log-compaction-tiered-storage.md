---
title: "Log Compaction·Tiered Storage"
series: kafka
part: "설계와 내부"
order: 10
summary: "시간 기반 retention 의 두 대안 — key 별 최신 값만 남기는 compaction 과 오래된 segment 를 객체 저장소로 내리는 tiered storage"
tags: [Kafka, Log Compaction, Tombstone, Tiered Storage, RemoteStorageManager]
sources: [data-infra/2026-05-17-kafka-log-compaction.md, data-infra/2026-05-17-kafka-tiered-storage.md]
updated: 2026-08-29
---

기본 정책 `cleanup.policy=delete` 는 세그먼트를 시간이나 크기 기준으로 통째로 버린다. 이 모델이 놓치는 요구가 둘 있다. 하나는 프로필·설정·CDC 처럼 각 key 의 최신 상태만 의미 있는 데이터다. 시간으로 자르면 오래 갱신되지 않은 key 가 사라지고, 자르지 않으면 낡은 이력이 디스크를 채운다. 다른 하나는 수년치 이벤트를 보존해야 하는 경우다. 읽기는 최근 데이터에 몰리는데도 오래된 데이터가 브로커 SSD 를 복제본 수만큼 차지한다. Log Compaction 은 첫 번째를, Tiered Storage 는 두 번째를 해결한다.

## 핵심 개념

### Log Compaction — key 별 최신 값

`cleanup.policy=compact` 토픽은 같은 key 중 offset 이 가장 큰 레코드만 남기고 이전 레코드를 제거한다. 로그 크기는 key 수에 비례하므로 `retention.ms=-1` 과 조합하면 크기가 유계인 영구 저장소가 된다. 남은 레코드는 원래 offset 을 유지한다. `earliest` 부터 읽으면 모든 key 의 현재 상태가 한 번에 들어오며, Kafka Streams 의 KTable 과 `__consumer_offsets` 가 이 성질을 사용한다.

삭제는 tombstone, 즉 `value=null` 레코드로 표현한다. compaction 시 그 key 의 이전 레코드가 제거되고 tombstone 은 `delete.retention.ms`(기본 1일) 동안 남았다가 사라진다. 이 유예가 있어야 뒤처진 consumer 가 삭제 신호를 놓치지 않는다.

정리는 브로커의 log cleaner 스레드가 수행한다. 로그는 정리된 clean 구간과 미정리 dirty 구간으로 나뉘고, dirty 비율이 `min.cleanable.dirty.ratio`(기본 0.5) 를 넘거나 `max.compaction.lag.ms` 가 경과하면 시작된다. ==활성 세그먼트는 정리하지 않으므로 `segment.bytes` 가 작을수록 최신 값이 빨리 반영된다.== `compact,delete` 는 최신 값을 유지하면서 `retention.ms` 를 넘긴 세그먼트를 시간 기준으로도 삭제한다.

### Tiered Storage — local tier 와 remote tier

KIP-405 의 Tiered Storage(3.6 early access, 3.9 production-ready) 는 파티션 로그를 두 계층으로 나눈다. Local tier 는 브로커 디스크, remote tier 는 S3·HDFS·Blob 같은 외부 저장소다. 리더의 백그라운드 스레드가 롤링이 끝난 세그먼트를 remote 로 복사하고 `local.retention.ms` 를 넘긴 로컬 복사본을 삭제한다. 전체 보존은 로컬과 원격을 합친 `retention.ms` 가 결정한다. ==`local.retention.*` 을 생략하면 `retention.*` 과 같은 값이 되어 사실상 로컬만 쓴다.== Replication factor 는 local tier 에만 적용되고 remote 의 내구성은 저장소에 맡긴다.

Consumer 는 offset 만 지정하며, 로컬에 없는 offset 이면 브로커가 remote 에서 가져와 응답한다. page cache 는 마이크로초, remote fetch 는 수십~수백 밀리초로 응답 시간만 달라진다.

플러그인 인터페이스는 둘이다. `RemoteStorageManager` 는 세그먼트의 복사·조회·삭제를 담당하고, `RemoteLogMetadataManager` 는 세그먼트 위치 메타데이터를 관리하며 기본 구현은 내부 토픽 `__remote_log_metadata` 를 쓴다. Apache 배포판의 `LocalTieredStorage` 는 테스트용이고, 운영용 S3 구현은 Aiven 플러그인이나 MSK·Confluent 가 제공한다.

## 코드

`KafkaAdmin` 이 기동 시 생성하는 compacted 토픽 정의다.

```java
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class UserProfileTopicConfig {

    @Bean
    public NewTopic userProfilesTopic() {
        return TopicBuilder.name("user-profiles")
                .partitions(3)
                .replicas(3)
                .compact()
                .config("min.cleanable.dirty.ratio", "0.3")
                .config("delete.retention.ms", "86400000")
                .config("segment.bytes", "104857600")
                .config("retention.ms", "-1")
                .build();
    }
}
```

프로필 저장과 삭제를 같은 토픽에 발행한다. 삭제는 값이 `null` 인 tombstone 이다.

```java
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
public class UserProfilePublisher {

    private final KafkaTemplate<String, UserProfile> kafkaTemplate;

    public UserProfilePublisher(KafkaTemplate<String, UserProfile> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void upsert(UserProfile profile) {
        kafkaTemplate.send("user-profiles", profile.userId(), profile);
    }

    public void delete(String userId) {
        kafkaTemplate.send("user-profiles", userId, null);
    }
}
```

브로커에서 `remote.log.storage.system.enable=true` 를 켠 뒤, 30일 보존 중 3일만 로컬에 두는 토픽이다.

```java
@Bean
public NewTopic eventsTopic() {
    return TopicBuilder.name("events")
            .partitions(12)
            .replicas(3)
            .config("remote.storage.enable", "true")
            .config("local.retention.ms", "259200000")
            .config("retention.ms", "2592000000")
            .build();
}
```

## 실무에서 걸리는 지점

- **key 가 없으면 compaction 이 성립하지 않는다.** ==compacted 토픽에 key 가 `null` 인 레코드는 브로커가 거부한다.==
- **tombstone 을 보내지 않으면 영원히 남는다.** 반대로 `delete.retention.ms` 가 너무 짧으면 느린 consumer 가 삭제를 보지 못해 로컬 캐시에 유령 데이터가 남는다.
- **log cleaner 는 CPU 와 디스크 I/O 를 소비한다.** `log.cleaner.threads`, `log.cleaner.io.max.bytes.per.second` 로 조절하고, `uncleanable-partitions-count` 가 0 을 넘으면 cleaner 가 따라가지 못하는 상태다.
- ==**compacted 토픽은 tiered storage 를 켤 수 없다.**== `cleanup.policy` 에 `compact` 가 포함되면 `remote.storage.enable=true` 는 거부된다.
- **remote 읽기 폭증과 retention 불일치.** 재처리가 오래된 offset 을 한꺼번에 읽으면 remote fetch 지연과 비용이 함께 튄다. S3 lifecycle 이 `retention.ms` 보다 먼저 객체를 지우면 메타데이터만 남으므로 보존 기간은 Kafka 한쪽에서만 관리하고 `RemoteCopyLagBytes` 를 감시한다.

## 관련 글

- [Topic·Partition·Offset·Segment](/notes/kafka/topic-partition-offset-segment/)
- [Broker·Topic 설정](/notes/kafka/broker-topic-config/)
- [Streams — DSL·Processor API·상태 저장](/notes/kafka/streams-dsl-processor-state/)
