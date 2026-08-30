---
title: "다중 데이터센터·Geo-Replication (MirrorMaker 2)"
series: kafka
part: "운영"
order: 18
summary: "DC마다 로컬 클러스터를 두고 MirrorMaker 2로 복제하는 이유와 DR 시 오프셋 변환 방식을 정리한다."
tags: [Kafka, MirrorMaker 2, Geo-Replication, Multi-Datacenter, Disaster Recovery]
sources: [data-infra/2026-05-17-kafka-operations-datacenters.md, data-infra/2026-05-17-kafka-operations-geo-replication.md]
updated: 2026-08-29
---

단일 클러스터는 데이터센터 하나가 내려가면 그대로 멈춘다. 그렇다고 브로커를 두 데이터센터에 나눠 한 클러스터로 묶으면 모든 쓰기가 WAN 왕복을 기다리고, `min.insync.replicas` 충족 여부가 원격 링크 상태에 좌우된다. 링크가 끊기면 양쪽 모두 쓰기가 막힌다. 다중 데이터센터 운영은 분할 내성이 강제된 상황에서 일관성과 가용성 중 무엇을 양보할지 정하고, 그 선택을 복제 구조로 구현하는 문제다.

## 핵심 개념

### Local Cluster + Mirror

권장 구조는 데이터센터마다 독립된 Kafka 클러스터를 두고, 애플리케이션은 자기 지역 클러스터만 읽고 쓰며, 클러스터 사이의 동기화는 별도 복제 프로세스가 맡는 형태다. WAN 장애가 로컬 쓰기에 영향을 주지 않고 지연도 로컬 수준으로 유지된다. 대가는 복제 지연이며, DC 간 데이터는 최종적 일관성만 보장된다.

Stretched Cluster는 같은 메트로 안의 AZ처럼 왕복 지연이 10ms 안쪽일 때만 성립한다. `broker.rack`에 AZ를 지정하면 레플리카가 AZ별로 분산되어 AZ 하나가 죽어도 ISR이 유지된다.

### 배치 전략

| 전략 | 흐름 | 용도 |
|---|---|---|
| Active-Passive | primary → dr 단방향 | DR. 가장 단순하고 일반적 |
| Active-Active | 양방향 복제, 양쪽 모두 트래픽 처리 | 지역별 로컬 서비스. 토픽 네이밍과 중복 처리 설계 필요 |
| Aggregate | 여러 로컬 → 집계 클러스터 단방향 | 글로벌 분석·ML 학습 |
| Stretched | 단일 클러스터 + rack awareness | 같은 리전 Multi-AZ |

### MirrorMaker 2 구조

MirrorMaker 2(MM2)는 Kafka Connect 위에서 동작하는 커넥터 세 개의 묶음이다. 구 MirrorMaker가 못 하던 컨슈머 오프셋 추적, 토픽 설정·ACL 동기화, 양방향 복제 루프 차단을 지원한다.

- **MirrorSourceConnector**: 소스 토픽의 레코드를 파티션 1:1로 타깃에 복제한다. 키·값·타임스탬프·헤더를 그대로 옮기고 토픽 설정과 ACL도 동기화한다.
- **MirrorCheckpointConnector**: 소스 컨슈머 그룹의 커밋 오프셋을 타깃 토픽의 대응 오프셋으로 변환해 `<source>.checkpoints.internal`에 기록한다. `sync.group.offsets.enabled=true`면 타깃의 `__consumer_offsets`에도 주기적으로 반영한다.
- **MirrorHeartbeatConnector**: `heartbeats` 토픽에 주기적으로 레코드를 보내 복제 경로의 생존과 지연을 측정하게 한다.

`connect-mirror-maker.sh` 전용 모드는 같은 설정 파일을 여러 노드에서 실행하면 태스크를 나누고 장애 노드의 작업을 인수한다. 기존 Connect 클러스터가 있으면 REST API로 커넥터를 등록해도 된다.

### 토픽 네이밍과 루프 방지

기본 `DefaultReplicationPolicy`는 타깃 토픽 이름에 소스 클러스터 별칭을 접두어로 붙여 `primary`의 `orders`가 `primary.orders`가 된다. MirrorSourceConnector는 접두어로 원산지를 식별해 이미 복제된 토픽을 다시 복제하지 않으므로 Active-Active에서도 레코드가 왕복하지 않는다. ==`IdentityReplicationPolicy`는 접두어가 없어 DR 시 같은 토픽 이름으로 갈아탈 수 있지만 루프 차단 근거가 사라지므로 단방향에서만 쓴다.==

### WAN 환경 설정

TCP 버퍼(`socket.send.buffer.bytes`, `socket.receive.buffer.bytes`)를 대역폭 × RTT로 계산해 키우고, 프로듀서의 `linger.ms`·`batch.size`를 늘려 왕복 횟수를 줄인다. Stretched 구성이라면 `replica.lag.time.max.ms`도 WAN 지연에 맞춰 조정한다.

## 코드

Active-Passive DR용 MM2 설정. 전용 모드에서 이 파일 하나로 세 커넥터가 모두 기동된다.

```properties
clusters = primary, dr
primary.bootstrap.servers = kafka-dc1:9092
dr.bootstrap.servers = kafka-dc2:9092

primary->dr.enabled = true
primary->dr.topics = orders, payments, users.*
primary->dr.replication.factor = 3
primary->dr.tasks.max = 10

primary->dr.sync.topic.configs.enabled = true
primary->dr.sync.topic.acls.enabled = true
primary->dr.sync.group.offsets.enabled = true
primary->dr.sync.group.offsets.interval.seconds = 30
primary->dr.emit.checkpoints.interval.seconds = 30

primary->dr.replication.policy.class = org.apache.kafka.connect.mirror.IdentityReplicationPolicy
```

```bash
bin/connect-mirror-maker.sh mm2.properties
```

DR 클러스터로 전환될 때 체크포인트 토픽에서 변환된 오프셋을 읽어 그룹에 커밋하는 Spring Boot 3.x 서비스.

```java
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.connect.mirror.RemoteClusterUtils;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

@Service
public class DrOffsetMigrator {

    private final Map<String, Object> drClientProps;

    public DrOffsetMigrator(org.springframework.boot.autoconfigure.kafka.KafkaProperties props) {
        this.drClientProps = new HashMap<>(props.buildConsumerProperties(null));
    }

    public Map<TopicPartition, OffsetAndMetadata> migrate(String groupId) throws Exception {
        Map<TopicPartition, OffsetAndMetadata> translated =
                RemoteClusterUtils.translateOffsets(
                        drClientProps, "primary", groupId, Duration.ofSeconds(10));
        try (var consumer = new org.apache.kafka.clients.consumer.KafkaConsumer<byte[], byte[]>(
                drClientProps)) {
            consumer.commitSync(translated);
        }
        return translated;
    }
}
```

리스너가 붙기 전에 오프셋을 반영하는 `ApplicationRunner`. 실패 시 기동을 중단한다.

```java
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
public class DrFailoverRunner implements ApplicationRunner {

    private final DrOffsetMigrator migrator;

    public DrFailoverRunner(DrOffsetMigrator migrator) {
        this.migrator = migrator;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (args.containsOption("dr-failover")) {
            var offsets = migrator.migrate("order-workers");
            if (offsets.isEmpty()) {
                throw new IllegalStateException("translated offsets are empty; checkpoint topic missing");
            }
        }
    }
}
```

## 실무에서 걸리는 지점

- **오프셋 변환은 근사치다.** ==체크포인트는 주기적으로 기록되므로 마지막 체크포인트와 장애 시점 사이의 레코드는 재처리된다.== at-least-once만 보장되며 컨슈머 쪽 멱등 처리가 전제다.
- **Active-Active에서의 중복.** 로컬 토픽과 상대 접두어 토픽을 하나의 스트림으로 합쳐 소비하면 같은 이벤트가 두 번 보일 수 있다. 원산지 DC를 네이밍과 ACL로 고정하고, 소비 측은 접두어 패턴 구독(`.*orders`)과 키 기준 중복 제거를 함께 설계한다.
- **`refresh.topics.enabled` 기본값.** ==소스에 새 토픽이 생기면 패턴에 맞는 한 자동으로 복제가 시작된다.== 테스트용 토픽까지 WAN을 타지 않도록 허용 목록을 명시한다.
- **MM2 워커의 가용성과 자격증명.** 워커는 최소 3개를 띄우고 소스와 타깃 양쪽의 자격증명을 모두 보유해야 한다. ==한쪽 인증이 갱신되면 복제가 조용히 멈추므로 `heartbeats` 수신과 `record-age-ms-avg`에 경보를 건다.==
- **WAN 비용과 DR 훈련.** 복제 바이트가 곧 리전 간 전송 요금이므로 압축을 켜고 복제 대상 토픽을 최소화한다. DNS 전환, 오프셋 반영, 복구 후 역방향 복제까지 반복 훈련하지 않은 DR 구성은 장애 당일에 처음 검증된다.

## 관련 글

- [Replication — ISR·리더 선출·Unclean](/notes/kafka/replication-isr/)
- [장애 대응](/notes/kafka/troubleshooting/)
- [Connect — 아키텍처·Distributed Mode·운영](/notes/kafka/connect-architecture-operations/)
