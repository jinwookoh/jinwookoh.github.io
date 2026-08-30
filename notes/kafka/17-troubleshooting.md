---
title: "장애 대응"
series: kafka
part: "운영"
order: 17
summary: "URP·Offline Partition·TimeoutException·Lag·리밸런스 루프를 증상에서 원인, 복구 조치까지 잇는 진단 절차를 정리한다."
tags: [Kafka, Troubleshooting, UnderReplicatedPartitions, Consumer Lag, Rebalance]
sources: [data-infra/2026-05-26-kafka-troubleshooting.md]
updated: 2026-08-29
---

모니터링은 `UnderReplicatedPartitions`가 0보다 크다는 증상을 보여줄 뿐, 왜 올랐고 무엇을 해야 하는지는 알려주지 않는다. ==증상과 조치를 잇는 절차가 없으면 브로커를 무작정 재기동하거나 설정 여러 개를 동시에 바꾸게 되고, 그 자체가 2차 장애의 원인이 된다.== 자주 발생하는 장애를 Broker·Producer·Consumer·컨트롤러·디스크 다섯 영역으로 나누어 증상, 원인, 조치 순서로 정리한다.

## 핵심 개념

### 공통 진단 순서

어떤 영역이든 같은 순서를 밟는다. 증상 확인 → 시점 → 최근 변경(배포·설정·트래픽) → 로그와 메트릭 교차 확인 → 가설 → 범위가 좁은 조치 → 회복 확인. 가장 자주 생략되는 단계가 최근 변경 확인이다. 장애의 상당수는 직전 배포, 설정 변경, 트래픽 급증이 방아쇠이므로 여기서 출발하면 진단이 빨라진다.

### Broker — UnderReplicated·Offline Partition

`UnderReplicatedPartitions`(URP)가 0보다 크면 팔로워 복제본이 리더를 따라오지 못해 ISR에서 이탈했다는 뜻이다. `OfflinePartitionsCount`가 0보다 크면 리더가 없어 읽기와 쓰기가 모두 멈춘 파티션이 있다는 뜻이며 훨씬 심각하다. 원인은 대부분 프로세스 다운, OOM, 긴 GC 정지, 디스크 풀, 네트워크 단절이다. ISR 크기가 `min.insync.replicas` 아래로 내려가면 `acks=all` 쓰기가 `NotEnoughReplicasException`으로 거부된다.

조치의 1순위는 죽은 브로커 복구다. 재기동하면 복제본이 리더를 따라잡으면서 URP가 서서히 0으로 내려가며, 이 속도가 느린 것은 정상이다. Offline Partition은 정상 복제본이 남아 있으면 리더 선출을 기다리고, 없으면 `unclean.leader.election.enable`로 데이터 손실을 감수하고 가용성을 되찾을지 판단한다.

### Producer — TimeoutException

로그에 `TimeoutException`이 쌓이고 `record-error-rate`가 튄다. 원인은 세 갈래다. `acks=all`인데 ISR이 부족해 응답을 받지 못하는 경우, 네트워크 지연으로 `request.timeout.ms`를 넘기는 경우, 전송 속도가 처리 속도를 넘어 `buffer.memory`가 차고 `max.block.ms`만큼 대기하다 실패하는 경우다.

원인을 가르는 기준은 범위다. 모든 Producer가 느리면 브로커나 네트워크 쪽이고, 특정 토픽·파티션만 느리면 해당 리더나 핫 파티션 쪽이다. Producer 측 조치는 `delivery.timeout.ms`로 재시도 여유를 주는 것이지만, 근본 원인을 고치지 않으면 재시도는 증상을 미룰 뿐이다.

### Consumer — Lag 폭증·리밸런스 루프

`records-lag-max`가 계속 우상향하면 생산 속도가 소비 속도를 넘어선 것이다. 트래픽 증가, 처리 지연, 컨슈머 수 부족에 따른 병렬도 부족이 원인이다. 리밸런스 루프는 `poll()` 이후 처리가 `max.poll.interval.ms`를 넘겨 컨슈머가 그룹에서 제외되고, 다시 합류하면서 리밸런스가 반복되는 현상이다.

Lag 조치는 컨슈머 증설(파티션 수가 상한), 처리 로직 경량화, `max.poll.records` 축소다. 리밸런스 루프는 `max.poll.interval.ms`를 처리 시간에 맞게 늘리거나 `max.poll.records`를 줄이는 것이 1차 처방이다. Lag은 절대값보다 추세로 판단한다. 높아도 평평하면 따라잡는 중이고, 낮아도 우상향하면 곧 한계에 도달한다.

### 컨트롤러·디스크

클러스터 전체가 잠시 응답하지 않는 증상이면 컨트롤러를 의심한다. KRaft 모드에서는 컨트롤러 quorum 과반이 살아 있는지, `active-controller-count`가 1인지 확인한다. 디스크 풀은 흔한 다운 원인이다. 세그먼트가 쌓여 디스크가 100%에 이르면 해당 브로커는 사실상 다운된다. 이미 찼다면 retention을 줄이거나 디스크를 늘려 여유를 확보한다.

## 코드

`AdminClient`로 그룹 커밋 오프셋과 파티션 끝 오프셋을 비교해 파티션별 Lag을 계산하는 예제.

```java
@Service
public class ConsumerLagChecker {

    private final AdminClient admin;

    public ConsumerLagChecker(AdminClient admin) {
        this.admin = admin;
    }

    public Map<TopicPartition, Long> lag(String groupId) throws Exception {
        Map<TopicPartition, OffsetAndMetadata> committed =
                admin.listConsumerGroupOffsets(groupId)
                     .partitionsToOffsetAndMetadata().get();

        Map<TopicPartition, OffsetSpec> latestSpec = committed.keySet().stream()
                .collect(Collectors.toMap(tp -> tp, tp -> OffsetSpec.latest()));

        Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> latest =
                admin.listOffsets(latestSpec).all().get();

        Map<TopicPartition, Long> result = new HashMap<>();
        committed.forEach((tp, meta) ->
                result.put(tp, latest.get(tp).offset() - meta.offset()));
        return result;
    }
}
```

리밸런스 루프를 막기 위한 Consumer 설정. poll당 레코드 수를 줄이고 처리 시간에 맞춰 `max.poll.interval.ms`를 조정한다.

```java
@Configuration
public class ConsumerConfigProps {

    @Bean
    public ConsumerFactory<String, String> consumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "broker1:9092,broker2:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-processor");
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 100);
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 600_000);
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, 45_000);
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        return new DefaultKafkaConsumerFactory<>(props);
    }
}
```

Producer 타임아웃 예산 설정. `delivery.timeout.ms`는 `request.timeout.ms`와 `linger.ms`의 합보다 커야 한다.

```java
@Bean
public ProducerFactory<String, String> producerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "broker1:9092,broker2:9092");
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30_000);
    props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);
    props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 10_000);
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    return new DefaultKafkaProducerFactory<>(props);
}
```

## 실무에서 걸리는 지점

- **복구 중 과잉 조치.** URP 감소가 느리다고 다른 브로커를 재기동하거나 파티션 재배치를 시작하면 복제 트래픽이 겹쳐 회복이 더 늦어진다. ==조치는 한 번에 하나만 한다.==
- **재시도로 증상 가리기.** `delivery.timeout.ms`를 늘리면 에러 로그는 사라지지만 근본 원인은 남고, 버퍼가 차오르다 결국 `max.block.ms` 초과로 터진다.
- **Lag 절대값 알람.** 임계값 하나로 알람을 걸면 트래픽 피크마다 오탐이 난다. 기울기와 함께 판단한다.
- **`max.poll.interval.ms`만 늘리기.** 값을 키울수록 죽은 컨슈머 감지도 늦어진다. 긴 작업은 별도 스레드로 분리하고 `pause()`/`resume()`으로 poll 간격을 지킨다.
- **디스크 사용률 알람 부재.** retention이 유입량을 따라가지 못하면 디스크가 조용히 찬다. 사용률 80% 선에 알람을 걸고 `retention.bytes`·`retention.ms`를 토픽별로 산정한다.

## 관련 글

- [Replication — ISR·리더 선출·Unclean](/notes/kafka/replication-isr/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
- [Monitoring·Hardware·성능 튜닝](/notes/kafka/monitoring-performance/)
