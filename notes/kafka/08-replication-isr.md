---
title: "Replication — ISR·리더 선출·Unclean"
series: kafka
part: "설계와 내부"
order: 8
summary: "ISR 전원 복제가 committed의 기준이며, RF=3·min.insync.replicas=2·acks=all 조합이 손실 없는 failover를 만든다."
tags: [Kafka, ISR, Replication, High Watermark, Unclean Leader Election]
sources: [data-infra/2026-05-17-kafka-replication.md, 2026-05-02-kafka-internals.md]
updated: 2026-08-29
---

Replication Factor가 1이면 브로커 한 대가 내려가는 순간 파티션은 오프라인이 되고 소비되지 않은 메시지는 복구할 수 없다. 복제본을 여럿 두더라도 어떤 복제본이 최신인지, 어느 시점을 "저장됨"으로 볼지, 누가 승격될지에 대한 규칙이 없으면 오래된 복제본이 리더가 되어 확인 응답까지 나간 메시지가 사라진다. ISR, High Watermark, `min.insync.replicas`, Unclean Leader Election이 이 규칙을 이룬다.

## 핵심 개념

### Leader·Follower와 복제 흐름

각 파티션은 리더 1개와 팔로워 N개로 구성되며, RF는 리더를 포함한 복제본 수다. 운영 표준은 3이고, 복제본은 서로 다른 브로커에 놓이므로 RF는 브로커 수를 넘을 수 없다. 쓰기는 항상 리더로 가고 읽기도 기본은 리더다(KIP-392로 팔로워 읽기 가능). 팔로워는 리더에서 pull로 가져온다.

### ISR과 이탈·재진입

ISR(In-Sync Replicas)은 리더와 동기화된 복제본 집합이며 리더 자신을 항상 포함한다. 조건은 컨트롤러 heartbeat 세션이 살아 있고, `replica.lag.time.max.ms`(기본 30초) 안에 리더 LEO에 한 번 이상 도달하는 것이다. 벗어난 팔로워는 ISR에서 제외되고 다시 따라잡으면 자동 재진입한다. ISR 변경은 클러스터 메타데이터에 영속화된다.

### Committed와 High Watermark

메시지는 ISR의 모든 복제본이 기록했을 때 committed로 간주된다. 각 복제본이 마지막으로 기록한 다음 오프셋이 LEO(Log End Offset)이고, ISR 전원이 도달한 최소 지점이 High Watermark(HW)다.

```
Leader   LEO = 150
Follower LEO = 140  (ISR)
Follower LEO = 130  (ISR)
HW = 130
```

컨슈머는 HW 이전만 읽는다. HW 너머를 노출한 뒤 리더가 죽으면 새 리더에 그 메시지가 없어 이미 읽은 메시지가 사라질 수 있기 때문이다.

### min.insync.replicas와 acks=all

==ISR이 리더만 남으면 `acks=all`도 사실상 `acks=1`과 같다.== `min.insync.replicas`는 `acks=all` 쓰기를 받기 위한 ISR 최소 크기다. RF=3, `min.insync.replicas=2`, `acks=all` 조합에서 브로커 한 대가 죽으면 쓰기가 유지되고, 두 대가 죽으면 `NotEnoughReplicasException`으로 쓰기가 거부된다. 읽기는 계속 가능하다.

### Quorum 방식과의 비교

| 구분 | Majority Quorum (Raft·Paxos) | Kafka ISR |
|:---|:---|:---|
| commit 조건 | 2f+1 중 f+1 동의 | ISR 전원 기록 |
| f개 장애 허용 시 복제본 | 2f+1 | f+1 |
| 지연 | 빠른 다수만 대기 | 가장 느린 ISR까지 대기 |

Quorum은 복제본 비용이 커서 대용량 로그에 맞지 않는다. Kafka는 데이터에는 ISR을, 메타데이터에만 KRaft(Raft)를 쓴다.

### 리더 선출과 컨트롤러

리더가 죽으면 컨트롤러가 감지하고 ISR 안에서 새 리더를 고른다. 새 리더 정보는 메타데이터 로그로 전파되고 클라이언트는 자동 재접속한다. 파티션마다 preferred replica가 있어 `auto.leader.rebalance.enable=true`(기본)면 복구 후 리더십이 되돌아간다. KRaft에서는 컨트롤러 3개 또는 5개가 Raft 과반 합의로 Active Controller를 하나만 유지해 스플릿 브레인을 막는다. 매 쓰기마다 fsync를 강제하지 않으므로 복구된 브로커는 리더와 완전히 재동기화한 뒤에만 ISR에 재진입한다.

### Unclean Leader Election

ISR 전원이 죽고 ISR 밖의 뒤처진 복제본만 살아 있을 때의 정책이다. `unclean.leader.election.enable=false`(기본)면 파티션은 ISR 구성원이 돌아올 때까지 오프라인이 되며 데이터는 보존된다. `true`면 뒤처진 복제본이 승격되어 서비스는 재개되지만 거기 없는 committed 메시지는 영구 손실된다. 결제·주문·감사 로그는 `false`, 클릭 스트림·메트릭처럼 가용성이 우선인 데이터만 `true`를 검토한다. CAP 관점에서 Kafka는 CP 시스템이다.

## 코드

토픽 생성 시 복제 설정을 토픽 레벨에서 고정한다. `KafkaAdmin`이 시작 시점에 `NewTopic` 빈을 반영한다.

```java
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.config.TopicConfig;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class PaymentTopicConfig {

    @Bean
    public NewTopic paymentsTopic() {
        return TopicBuilder.name("payments")
                .partitions(12)
                .replicas(3)
                .config(TopicConfig.MIN_IN_SYNC_REPLICAS_CONFIG, "2")
                .config(TopicConfig.UNCLEAN_LEADER_ELECTION_ENABLE_CONFIG, "false")
                .build();
    }
}
```

프로듀서는 `acks=all`과 멱등성을 켜고, ISR 부족 거부를 구분해 처리한다.

```yaml
spring:
  kafka:
    producer:
      acks: all
      properties:
        enable.idempotence: true
        delivery.timeout.ms: 120000
```

```java
import org.apache.kafka.common.errors.NotEnoughReplicasException;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletionException;

@Service
public class PaymentPublisher {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public PaymentPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public long publish(String paymentId, String payload) {
        try {
            // 반환된 offset은 ISR 전원이 기록을 마친 committed 오프셋이다
            return kafkaTemplate.send("payments", paymentId, payload)
                    .join().getRecordMetadata().offset();
        } catch (CompletionException e) {
            if (e.getCause() instanceof NotEnoughReplicasException) {
                throw new IllegalStateException("ISR < min.insync.replicas, 쓰기 거부", e);
            }
            throw e;
        }
    }
}
```

`AdminClient`로 파티션별 ISR 크기를 조회해 under-replicated 파티션을 찾는다.

```java
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.TopicDescription;

import java.util.List;
import java.util.concurrent.ExecutionException;

public class IsrChecker {

    public List<String> underReplicated(AdminClient admin, String topic)
            throws ExecutionException, InterruptedException {
        TopicDescription desc = admin.describeTopics(List.of(topic))
                .allTopicNames().get().get(topic);
        return desc.partitions().stream()
                .filter(p -> p.isr().size() < p.replicas().size())
                .map(p -> topic + "-" + p.partition()
                        + " isr=" + p.isr().size() + "/" + p.replicas().size())
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- `acks=all`만 켜고 `min.insync.replicas`를 기본값 1로 두면 ISR이 리더만 남은 순간부터 리더 단독 기록으로 응답이 나간다. 두 설정은 세트로 본다.
- ==`min.insync.replicas`를 RF와 같게 두면 팔로워 하나만 느려져도 쓰기가 멈춘다.== RF=3에는 2가 적정하다.
- `replica.lag.time.max.ms`를 줄이면 짧은 GC 정지에도 ISR이 흔들려 `NotEnoughReplicas`가 산발한다.
- `UnderReplicatedPartitions`가 0을 넘는 상태는 아직 손실이 아니지만 지속되면 위험하다. `UnderMinIsrPartitions`와 `OfflinePartitionsCount`는 즉시 대응 대상이다.
- ==`unclean.leader.election.enable=true`를 브로커 전역으로 열면 내부 토픽까지 적용된다.== 필요한 토픽에만 토픽 레벨로 건다.

## 관련 글

- [Producer 동작 원리 — 파티션 선택·ACK·멱등성](/notes/kafka/producer-internals/)
- [전달 보증 — at-most·at-least·exactly-once와 트랜잭션](/notes/kafka/delivery-semantics-transactions/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
