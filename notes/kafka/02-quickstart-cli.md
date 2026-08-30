---
title: "Quickstart — 설치·CLI·첫 메시지"
series: kafka
part: "기초"
order: 2
summary: "KRaft 단일 노드를 띄우고 kafka-topics·console-producer·consumer·consumer-groups로 메시지 흐름과 lag를 직접 확인한다"
tags: [Kafka, KRaft, CLI, Consumer Group, Spring Kafka]
sources: [data-infra/2026-05-17-kafka-quickstart.md, 2026-05-02-kafka-administration.md]
updated: 2026-08-29
---

Kafka의 설계 개념은 Topic·Partition·Consumer Group·Offset처럼 추상 용어가 많아, 문서만 읽고 넘어가면 각 용어가 실제로 어떤 모양인지 감이 잡히지 않는다. 이 상태로 Producer 설정이나 Rebalance를 공부하면 원인과 결과를 연결하지 못한다. ==로컬에 브로커 한 대를 띄우고 CLI로 메시지를 넣고 빼면서 partition 배분과 lag를 눈으로 확인해 두면 이후 개념 학습의 기준점이 생긴다.== 또한 운영 환경에서 장애를 진단할 때도 애플리케이션 코드보다 콘솔 도구가 먼저 손에 잡히므로, 기본 CLI 네 개는 반드시 익혀 둔다.

## 핵심 개념

**KRaft 모드.** Kafka 4.0부터 Zookeeper가 완전히 제거되었고 브로커가 자체 Raft 합의로 메타데이터를 관리한다. 브로커 실행 환경은 Java 17 이상이 필요하며(클라이언트는 Java 11 이상), 첫 실행 전에 `kafka-storage.sh format`으로 로그 디렉토리를 초기화해야 한다. 이 단계는 Zookeeper 시절에는 없던 절차라 가장 자주 빠뜨린다. `process.roles=broker,controller`로 한 노드가 두 역할을 겸하는 것이 단일 노드 구성이고, 운영 규모에서는 controller와 broker를 분리한다.

**Topic과 Partition.** Topic은 메시지가 쌓이는 논리적 단위이고, Partition은 그것을 병렬로 나눈 물리적 로그다. Partition 수는 늘릴 수만 있고 줄일 수 없다. 키 해시와 partition의 매핑이 깨지기 때문이며, 줄이려면 새 topic을 만들어 옮겨야 한다. Replication factor는 단일 노드에서 1이지만 운영 표준은 3이다.

**키와 Partition 선택.** 콘솔 producer의 기본 동작은 key 없이 value만 전송하며, 이 경우 partition은 sticky 방식으로 배치 단위로 분산된다. 키를 지정하면 같은 키는 항상 같은 partition으로 가므로 키 단위 순서가 보장된다.

**Consumer Group과 Offset.** 같은 `--group`으로 붙은 consumer들은 partition을 나눠 받는다. Partition 3개에 consumer 2개면 한쪽이 2개, 다른 쪽이 1개를 맡고, consumer가 partition보다 많으면 초과분은 아무것도 받지 못한다. 다른 group은 독립적으로 전체 메시지를 받는다. Group마다 partition별 처리 위치(offset)를 `__consumer_offsets` topic에 커밋하며, 브로커의 마지막 offset과 커밋된 offset의 차이가 lag다. Lag는 운영 모니터링의 가장 기본이 되는 메트릭이다.

## 코드

Kafka 4.0 배포판을 받아 KRaft 단일 노드를 기동한다. 4.0부터는 `config/server.properties`가 곧 KRaft 설정이다.

```bash
wget https://downloads.apache.org/kafka/4.0.0/kafka_2.13-4.0.0.tgz
tar -xzf kafka_2.13-4.0.0.tgz && cd kafka_2.13-4.0.0

KAFKA_CLUSTER_ID="$(bin/kafka-storage.sh random-uuid)"
bin/kafka-storage.sh format --standalone -t "$KAFKA_CLUSTER_ID" -c config/server.properties
bin/kafka-server-start.sh config/server.properties

# Docker로 대체할 경우 (이후 명령은 docker exec -it kafka /opt/kafka/bin/<cmd>)
docker run -d --name kafka -p 9092:9092 apache/kafka:4.0.0
```

Topic을 만들고, 키 포함 메시지를 보낸 뒤, 두 개의 group으로 소비하며 lag를 확인한다.

```bash
bin/kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic quickstart-events --partitions 3 --replication-factor 1
bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic quickstart-events

# Producer — key:value 형식, 입력 후 Ctrl+C
bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic quickstart-events \
  --property parse.key=true --property key.separator=:
>user42:Made a payment
>user99:Logged in

# Consumer — 키·파티션·타임스탬프 출력, 처음부터
bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic quickstart-events \
  --group group-1 --from-beginning \
  --property print.key=true --property print.partition=true --property print.timestamp=true

# 같은 명령을 다른 터미널에서 --group group-1로 한 번 더 실행하면 partition이 나뉜다
# --group group-2로 실행하면 전체 메시지를 독립적으로 받는다

bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group group-1
# GROUP    TOPIC              PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# group-1  quickstart-events  0          5               5               0

# 재처리 — group의 consumer를 모두 내린 뒤 실행
bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --group group-1 \
  --reset-offsets --to-earliest --topic quickstart-events --execute

bin/kafka-topics.sh --bootstrap-server localhost:9092 --delete --topic quickstart-events
```

같은 topic을 Spring Boot 3.x에서 읽고 쓰는 최소 구성이다. `spring-kafka` 의존성 하나로 `KafkaTemplate`과 `@KafkaListener`가 자동 구성된다.

```java
@Service
public class QuickstartEvents {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public QuickstartEvents(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void send(String key, String value) {
        kafkaTemplate.send("quickstart-events", key, value);
    }

    @KafkaListener(topics = "quickstart-events", groupId = "spring-group")
    public void listen(ConsumerRecord<String, String> record) {
        System.out.printf("p=%d key=%s value=%s%n",
                record.partition(), record.key(), record.value());
    }
}
```

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
```

## 실무에서 걸리는 지점

- ==**`--from-beginning`은 커밋된 offset이 없을 때만 동작한다.**== 이미 offset을 커밋한 group에 붙이면 커밋 지점부터 이어 읽는다. 처음부터 다시 읽으려면 `--reset-offsets`를 써야 하고, 이 명령은 해당 group의 consumer가 모두 종료된 상태에서만 적용된다. 애플리케이션의 `auto.offset.reset=earliest`도 같은 조건으로만 효과가 있다.
- **첫 연결은 되는데 그 다음부터 Connection refused가 난다면 `advertised.listeners`를 본다.** 클라이언트는 `bootstrap.servers`로 접속한 뒤 메타데이터에 실린 광고 주소로 재연결한다. Docker·Kubernetes·클라우드에서 브로커가 컨테이너 내부 주소를 광고하면 이 두 번째 연결이 실패한다.
- **Partition 수 이상의 consumer는 놀고 있다.** Lag가 쌓여 consumer를 늘렸는데 처리량이 그대로라면 partition 수부터 확인한다. 반대로 partition을 과도하게 잡으면 메타데이터·컨트롤러 부담과 장애 복구 시간이 늘어난다.
- **`auto.create.topics.enable`에 의존하지 않는다.** 개발용 기본값이 켜져 있으면 오타 난 topic 이름으로 partition 1개짜리 topic이 조용히 생성된다. 운영에서는 끄고 `kafka-topics.sh --create` 또는 Admin Client로 명시적으로 만든다.
- **콘솔 producer는 스모크 테스트 도구이지 부하 도구가 아니다.** 기본 설정이 운영 producer와 다르므로(`acks`, 배치, 압축) 성능 수치를 여기서 판단하면 안 된다. `--producer-property acks=all`처럼 설정을 맞춰도 처리량 비교는 별도 도구로 한다.

## 관련 글

- [Kafka란 — 이벤트 스트리밍과 활용 영역](/notes/kafka/what-is-kafka/)
- [Topic·Partition·Offset·Segment](/notes/kafka/topic-partition-offset-segment/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
