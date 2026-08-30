---
title: "Monitoring·Hardware·성능 튜닝"
series: kafka
part: "운영"
order: 16
summary: "무엇을 관측하고, 어떤 하드웨어 위에 올리고, 어느 목표를 위해 어느 노브를 돌릴지를 하나로 묶는다"
tags: [Kafka, JMX, Prometheus, OS Tuning, Performance Tuning]
sources: [data-infra/2026-05-17-kafka-monitoring-jmx.md, data-infra/2026-05-17-kafka-hardware-and-os.md, data-infra/2026-05-26-kafka-performance-tuning.md]
updated: 2026-08-29
---

Kafka는 지표 없이 운영하면 장애를 사후에야 안다. ==복제본이 ISR에서 빠져도, 컨슈머 lag이 수십만으로 쌓여도 브로커 프로세스는 살아 있으므로 헬스체크로는 드러나지 않는다.== OS 기본값이 Kafka 규모에 맞지 않으면 file descriptor 고갈이나 mmap 한계로 브로커가 예고 없이 죽고, 처리량·지연·내구성·가용성이 상충한다는 사실을 모르면 한 지표를 올리며 다른 지표를 망가뜨린다.

## 핵심 개념

### 모니터링 파이프라인과 핵심 지표

브로커·프로듀서·컨슈머 모두 JMX로 지표를 노출한다. JMX Exporter(Java agent)가 Prometheus 포맷으로 변환하고 Grafana가 시각화·알람을 맡는다. 먼저 볼 지표는 소수다.

| 지표 | 정상 | 알람 기준 |
|:---|:---:|:---|
| `UnderReplicatedPartitions` | 0 | 5분 이상 > 0 |
| `UnderMinIsr` · `OfflinePartitionsCount` | 0 | 발생 즉시 |
| `ActiveControllerCount` | 1 | ≠ 1 (0=부재, 2=split-brain) |
| `RequestHandlerAvgIdlePercent` | > 0.3 | < 0.3 |
| `records-lag-max` | 수백 이하 | > 10,000 |
| `rebalance-rate-per-hour` | 0 | > 1 |
| GC pause | < 500ms | > 1s |

lag은 `LogEndOffset - CurrentOffset`이다. `records-consumed-rate`와 브로커 `BytesInPerSec`를 같이 놓고 유입 증가인지 처리 저하인지 구분한다.

### 하드웨어와 OS

성능의 중심은 OS 페이지 캐시다. 브로커는 sequential I/O 위주라 HDD JBOD로도 충분하고, SSD는 p99 지연이 결정적일 때 이득이 있다. JVM heap은 6~16GB로 제한하고 나머지 메모리를 캐시에 남긴다. RAID는 rebuild 부하가 브로커를 마비시키고 replication과 중복되므로 `log.dirs`에 디스크를 나열하는 JBOD를 쓴다. 파일시스템은 XFS 우선, NFS·EFS 금지. 플러시는 기본값(OS 위임)을 유지한다. fsync 강제는 처리량을 크게 떨어뜨리고 내구성은 replication이 보장한다.

OS 튜닝은 세 가지다. file descriptor는 세그먼트·커넥션마다 소비되므로 최소 100,000. `vm.max_map_count`는 세그먼트당 index mmap 2개를 차지해 기본 65,535로는 `OutOfMemoryError: Map failed`로 크래시하므로 최소 262,144. WAN 환경은 소켓 버퍼를 16MB로 키운다. GC는 G1GC에 GC 로그를 필수로 남긴다.

### 성능 튜닝은 목표 선택이다

네 목표는 서로 당긴다. 배치를 키우면 처리량은 오르고 지연이 늘며, `min.insync.replicas`를 높이면 복제본 하나만 빠져도 쓰기가 거부되어 가용성이 떨어진다.

| 목표 | 방향 |
|:---|:---|
| 처리량 | `batch.size`↑ · `linger.ms` 5~50ms · `compression.type=zstd` · `fetch.min.bytes`↑ · `max.poll.records`↑ |
| 지연 | `linger.ms=0` · `fetch.min.bytes=1` · `fetch.max.wait.ms`↓ · 필요 시 `acks=1` |
| 내구성 | `acks=all` · `enable.idempotence=true` · `min.insync.replicas=2` · `unclean.leader.election.enable=false` |
| 가용성 | `min.insync.replicas` 낮게 · unclean election 허용(손실 감수) |

절차는 고정이다. 목표를 정하고 `kafka-producer-perf-test.sh`로 baseline을 재고, 노브를 하나만 바꾸고 다시 잰다.

## 코드

JMX Exporter를 Java agent로 붙여 7071 포트에 노출하고 필요한 지표만 규칙으로 화이트리스트한다.

```bash
export KAFKA_OPTS="-javaagent:/opt/kafka/libs/jmx_prometheus_javaagent.jar=7071:/etc/kafka/jmx-exporter.yml"
export KAFKA_HEAP_OPTS="-Xms6g -Xmx6g"
export KAFKA_JVM_PERFORMANCE_OPTS="-XX:+UseG1GC -XX:MaxGCPauseMillis=20 -XX:InitiatingHeapOccupancyPercent=35"
export KAFKA_GC_LOG_OPTS="-Xlog:gc*:file=/var/log/kafka/gc.log:time,tags:filecount=10,filesize=100M"
```

```yaml
# /etc/kafka/jmx-exporter.yml
lowercaseOutputName: true
rules:
  - pattern: kafka.server<type=ReplicaManager, name=UnderReplicatedPartitions><>Value
    name: kafka_server_underreplicatedpartitions
    type: GAUGE
  - pattern: kafka.controller<type=KafkaController, name=(OfflinePartitionsCount|ActiveControllerCount)><>Value
    name: kafka_controller_$1
    type: GAUGE
  - pattern: kafka.server<type=BrokerTopicMetrics, name=(BytesInPerSec|BytesOutPerSec), topic=(.+)><>OneMinuteRate
    name: kafka_server_$1
    type: GAUGE
    labels:
      topic: "$2"
```

Spring Boot 3.x는 Micrometer가 클라이언트 JMX 지표를 `/actuator/prometheus`에 자동 노출한다. 내구성 우선 프로듀서와 처리량 우선 컨슈머 설정이다.

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, prometheus
spring:
  kafka:
    producer:
      acks: all
      properties:
        enable.idempotence: true
        linger.ms: 20
        batch.size: 131072
        compression.type: zstd
    consumer:
      properties:
        fetch.min.bytes: 1048576
        fetch.max.wait.ms: 500
        max.poll.records: 1000
```

OS 한계값은 systemd 드롭인과 sysctl로 영구 반영한다.

```ini
# /etc/systemd/system/kafka.service.d/override.conf
[Service]
LimitNOFILE=100000

# /etc/sysctl.d/99-kafka.conf
vm.max_map_count = 262144
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
```

## 실무에서 걸리는 지점

- ==**지표 카디널리티 폭증.** Exporter 규칙을 `.*`로 열면 토픽·파티션·클라이언트 조합마다 시계열이 생겨 Prometheus가 먼저 죽는다.== 파티션 단위 지표는 lag처럼 꼭 필요한 것만 남긴다.
- **알람 노이즈.** `UnderReplicatedPartitions`는 롤링 재시작 중에도 일시적으로 뜬다. 즉시 알람은 `UnderMinIsr`·`OfflinePartitionsCount`에만 걸고 나머지는 지속 조건을 둔다.
- **JVM heap 과다.** heap을 32GB로 잡으면 GC pause가 길어져 리밸런스가 잦아지고 페이지 캐시가 줄어 디스크 읽기가 는다. GC pause 1초 이상이면 heap을 줄이거나 브로커를 추가한다.
- **OS 한계값 미반영.** `ulimit`으로만 올리고 systemd 유닛에 반영하지 않으면 재시작 시 원복된다.
- **내구성 설정 일괄 적용.** `acks=all`·`min.insync.replicas=2`를 모든 토픽에 걸면 로그성 토픽까지 브로커 하나 장애에 쓰기가 멈춘다. 잃으면 안 되는 토픽에만 강하게 건다. burstable 인스턴스는 지속 부하에 부적합하다.

## 관련 글

- [Broker·Topic 설정](/notes/kafka/broker-topic-config/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
- [장애 대응](/notes/kafka/troubleshooting/)
