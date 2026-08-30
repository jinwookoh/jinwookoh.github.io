---
title: "운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft"
series: kafka
part: "운영"
order: 15
summary: "Topic CRUD·파티션 재할당·무중단 재시작·KRaft 컨트롤러 쿼럼까지, 클러스터를 멈추지 않고 바꾸는 운영 절차를 정리한다."
tags: [Kafka, KRaft, Partition Reassignment, Rolling Restart, Admin Client]
sources: [data-infra/2026-05-17-kafka-operations-basic.md, data-infra/2026-05-17-kafka-kraft.md, 2026-05-03-kafka-cluster.md]
updated: 2026-08-29
---

트래픽이 늘면 파티션과 브로커를 늘려야 하고, 패치와 업그레이드 때문에 모든 브로커를 주기적으로 재시작해야 한다. 절차 없이 하면 문제가 바로 드러난다. 브로커를 추가만 하면 새 브로커는 빈 채로 놀고, 재할당을 제한 없이 실행하면 복제 트래픽이 정상 트래픽을 밀어내며, `kill -9`로 내리면 ISR이 깨져 unclean leader election 위험이 생긴다. ==Kafka 4.0부터 ZooKeeper가 제거되어 KRaft가 유일한 모드이므로 컨트롤러 쿼럼 설계와 포맷도 운영자의 몫이다.==

## 핵심 개념

### Topic·Consumer Group 관리

Topic CRUD는 `kafka-topics.sh`, 토픽별 설정은 `kafka-configs.sh`가 담당한다. 파티션 수는 늘릴 수만 있고, 늘려도 기존 메시지는 원래 파티션에 남아 같은 key의 순서 보장이 추가 시점을 경계로 끊어진다. 삭제는 비동기로 브로커가 백그라운드에서 처리한다.

Consumer Group은 `kafka-consumer-groups.sh --describe`로 파티션별 LAG를 확인한다. `--reset-offsets`는 `--to-earliest`·`--to-latest`·`--to-datetime`·`--to-offset`으로 재처리 시작점을 정하며, `--execute` 전에 `--dry-run`으로 확인한다. 활성 컨슈머가 있으면 리셋과 그룹 삭제 모두 거부된다.

### Partition Reassignment

브로커를 추가·제거할 때 레플리카를 옮기는 작업이다. `kafka-reassign-partitions.sh`의 `--generate`가 제안 배치 JSON을 만들고, `--execute`가 복제를 시작하며, `--verify`가 진행 상태를 보고하고 완료 시 스로틀을 제거한다. `--throttle`은 바이트/초 단위 복제 대역폭 상한이며 운영 환경에서는 항상 지정한다.

### Preferred Leader Election

레플리카 목록의 첫 브로커가 preferred leader다. 재할당이나 재시작 뒤 리더가 한쪽에 몰리면 `auto.leader.rebalance.enable=true`(기본)가 `leader.imbalance.per.broker.percentage` 기준으로 주기적으로 복구하고, 즉시 되돌리려면 `kafka-leader-election.sh --election-type preferred`를 실행한다.

### Rolling Restart

브로커를 한 대씩 내리고 올리면서 매 단계 `--under-replicated-partitions` 결과가 비어 있는지 확인한 뒤 다음으로 넘어간다. 그 전에 다음 브로커를 내리면 ISR이 `min.insync.replicas` 아래로 떨어져 쓰기가 거부된다. 브로커는 정상 종료 신호를 받아야 리더십을 넘기고 내려간다.

### KRaft 컨트롤러 쿼럼

KRaft는 Kafka가 자체 Raft 로그에 메타데이터를 저장하는 방식이다. 3.3에서 프로덕션 준비, 4.0에서 ZooKeeper 제거이며, 기존 ZooKeeper 클러스터는 3.9에서 마이그레이션을 마친 뒤 4.0으로 올린다.

각 노드는 `process.roles`로 역할을 정한다. `controller`는 메타데이터 쿼럼에만 참여하고, `broker`는 데이터만 다루며, `broker,controller`는 둘을 한 프로세스에서 맡는 combined 모드다. Combined는 브로커 부하가 컨트롤러 응답에 영향을 주므로 개발·테스트용이며, 운영 환경은 컨트롤러 전용 노드를 분리한 dedicated 모드로 구성한다.

| 컨트롤러 수 | 허용 장애 수 | 용도 |
|:---:|:---:|:---|
| 1 | 0 | 로컬 개발 |
| 3 | 1 | 소·중규모 운영 표준 |
| 5 | 2 | 대규모 또는 다중 AZ |

쿼럼은 과반 합의라 홀수로 구성하며, active controller가 죽으면 1초 안팎에 standby 중 새 리더가 선출된다. 초기 구성 시 `kafka-storage.sh random-uuid`로 만든 cluster ID로 모든 노드를 `format`해야 하고, 상태는 `kafka-metadata-quorum.sh describe --status`로 확인한다.

## 코드

브로커 4를 추가한 뒤 `orders` 토픽을 50 MB/s 스로틀로 재분배하는 CLI 절차다.

```bash
cat > topics-to-move.json <<'EOF'
{"version": 1, "topics": [{"topic": "orders"}]}
EOF

kafka-reassign-partitions.sh --bootstrap-server broker-1:9092 \
  --topics-to-move-json-file topics-to-move.json \
  --broker-list "1,2,3,4" --generate > proposal.txt
# proposal.txt 의 "Proposed partition reassignment" 블록을 reassignment.json 으로 저장

kafka-reassign-partitions.sh --bootstrap-server broker-1:9092 \
  --reassignment-json-file reassignment.json \
  --execute --throttle 50000000

kafka-reassign-partitions.sh --bootstrap-server broker-1:9092 \
  --reassignment-json-file reassignment.json --verify
```

같은 작업을 Spring Boot 3.x에서 `AdminClient`로 수행하는 예제다. 스로틀을 걸고 재할당을 제출한 뒤 완료를 폴링하고 스로틀을 제거한다.

```java
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AlterConfigOp;
import org.apache.kafka.clients.admin.ConfigEntry;
import org.apache.kafka.clients.admin.NewPartitionReassignment;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.config.ConfigResource;
import org.springframework.stereotype.Service;

@Service
public class ReassignmentService {

    private static final List<String> THROTTLE_KEYS = List.of(
        "leader.replication.throttled.rate", "follower.replication.throttled.rate");

    private final AdminClient admin;

    public ReassignmentService(AdminClient admin) {
        this.admin = admin;
    }

    public void move(String topic, int partition, List<Integer> replicas, long throttleBytes)
            throws Exception {
        setThrottle(replicas, String.valueOf(throttleBytes), AlterConfigOp.OpType.SET);

        var tp = new TopicPartition(topic, partition);
        admin.alterPartitionReassignments(
                Map.of(tp, Optional.of(new NewPartitionReassignment(replicas))))
            .all().get(30, TimeUnit.SECONDS);

        while (!admin.listPartitionReassignments(Set.of(tp))
                .reassignments().get(1, TimeUnit.MINUTES).isEmpty()) {
            Thread.sleep(5_000);
        }

        setThrottle(replicas, "", AlterConfigOp.OpType.DELETE);
    }

    private void setThrottle(List<Integer> brokers, String value, AlterConfigOp.OpType op)
            throws Exception {
        for (int brokerId : brokers) {
            var resource = new ConfigResource(ConfigResource.Type.BROKER, String.valueOf(brokerId));
            var ops = THROTTLE_KEYS.stream()
                .map(k -> new AlterConfigOp(new ConfigEntry(k, value), op))
                .toList();
            admin.incrementalAlterConfigs(Map.of(resource, ops)).all().get(30, TimeUnit.SECONDS);
        }
    }
}
```

롤링 재시작에서 다음 브로커로 넘어가도 되는지 판정하는 헬스체크다. 모든 파티션의 ISR이 레플리카 수와 같고 쿼럼 리더가 있을 때만 true다.

```java
import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.admin.AdminClient;
import org.springframework.stereotype.Component;

@Component
public class RollingRestartGate {

    private final AdminClient admin;

    public RollingRestartGate(AdminClient admin) {
        this.admin = admin;
    }

    public boolean safeToProceed() throws Exception {
        var topics = admin.listTopics().names().get(30, TimeUnit.SECONDS);
        var descriptions = admin.describeTopics(topics).allTopicNames().get(1, TimeUnit.MINUTES);

        boolean fullyReplicated = descriptions.values().stream()
            .flatMap(d -> d.partitions().stream())
            .allMatch(p -> p.isr().size() == p.replicas().size());

        var quorum = admin.describeMetadataQuorum().quorumInfo().get(30, TimeUnit.SECONDS);
        boolean quorumHealthy = quorum.leaderId() >= 0 && quorum.voters().size() >= 3;

        return fullyReplicated && quorumHealthy;
    }
}
```

## 실무에서 걸리는 지점

- ==**파티션 추가는 되돌릴 수 없다.**== 추가 시점 전후로 같은 key가 다른 파티션에 흩어지므로 key 순서에 의존하는 컨슈머의 영향을 먼저 확인한다.
- **스로틀은 재할당 자체도 느리게 만든다.** 새 데이터가 스로틀 값보다 빠르게 쌓이면 재할당이 끝나지 않는다. 진행이 멈추면 `--additional --throttle`로 상한을 올린다.
- **재할당 중 리더 이동은 `NotLeaderOrFollowerException`으로 나타난다.** 재시도를 끈 클라이언트는 이를 실패로 본다.
- **Combined 모드의 롤링 재시작은 쿼럼을 같이 흔든다.** 3노드에서 한 노드를 내린 상태로 두 번째 노드에 문제가 생기면 메타데이터 변경 자체가 멈춘다.
- **cluster ID가 다르게 포맷된 노드는 조용히 분리된다.** 프로비저닝 스크립트에서 `describe --status`의 ClusterId와 대조한다.

## 관련 글

- [Admin Client — API 5종 개관과 관리 작업](/notes/kafka/admin-client/)
- [Replication — ISR·리더 선출·Unclean](/notes/kafka/replication-isr/)
- [Broker·Topic 설정](/notes/kafka/broker-topic-config/)
