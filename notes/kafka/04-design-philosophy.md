---
title: "설계 철학 — 왜 디스크·배치·Zero-Copy인가"
series: kafka
part: "설계와 내부"
order: 4
summary: "Kafka가 디스크를 1급 저장소로 쓰면서도 빠른 이유를 순차 I/O·페이지 캐시·배치·sendfile로 설명한다"
tags: [Kafka, Page Cache, Zero-Copy, Batching, Compression]
sources: [data-infra/2026-05-17-kafka-design-motivation.md, data-infra/2026-05-17-kafka-design-persistence.md, data-infra/2026-05-17-kafka-design-efficiency.md]
updated: 2026-08-29
---

2010년 무렵 LinkedIn은 하루 수십억 건의 활동 데이터를 수십 개 시스템에 전달해야 했다. 소스 N개와 목적지 M개를 직접 연결하면 N×M개의 파이프라인이 생긴다. 기존 브로커(ActiveMQ·RabbitMQ)는 consume 즉시 메시지를 지우고 consumer별 큐를 BTree로 관리하므로, 며칠치 backlog 보관이나 여러 소비자의 독립적인 재처리를 감당하지 못했다. ==Kafka는 이 문제를 중앙 스트림 허브 하나로 풀되, 설계를 메시지 큐가 아니라 데이터베이스의 write-ahead log에 가깝게 잡았다.== 디스크 1급 저장, 배치, zero-copy는 그 결과다.

## 핵심 개념

설계 동인은 높은 처리량, 대량 backlog 보관, ms 단위 지연, partition 기반 실시간 처리, 장애 내성이다. 앞의 셋을 아래 세 기법이 담당한다.

### 순차 I/O와 페이지 캐시

디스크 성능은 접근 패턴이 결정한다. 7200rpm SATA 기준 순차 쓰기는 약 600MB/s, 랜덤 쓰기는 약 100KB/s로 6,000배 차이가 난다. 운영체제는 남는 메모리 전부를 페이지 캐시로 쓰고 read-ahead·write-behind로 순차 패턴을 최적화하므로, 순차 접근만 유지하면 디스크는 메모리에 근접한 처리량을 낸다.

Kafka는 도착한 메시지를 즉시 파일시스템 로그에 쓴다. 실제로는 커널 페이지 캐시에 기록되며 fsync를 강제하지 않고, 내구성은 replication으로 확보한다. consumer 읽기도 페이지 캐시를 경유하므로 최근 데이터를 따라가는 consumer는 디스크를 거의 건드리지 않는다.

JVM 힙에 자체 캐시를 두지 않는 이유는 Java 객체가 원본의 두 배 이상을 차지하고 힙이 커질수록 GC 정지가 길어지기 때문이다. 페이지 캐시는 GC가 없고 재시작 후에도 warm 상태가 유지된다.

### O(1) append-only 로그

BTree는 O(log N)이지만 디스크 seek가 10ms 단위라 데이터가 커질수록 성능이 급격히 나빠진다. Kafka는 partition을 append-only 파일로 두고, producer는 끝에 append하고 consumer는 자기 offset부터 순차 read만 한다. 모든 연산이 O(1)이라 1GB partition과 1TB partition의 속도가 같다. 그래서 retention 기간 동안 보존, consumer별 독립 offset, offset 되감기 재처리가 추가 비용 없이 성립한다. partition은 `log.segment.bytes`(기본 1GB) 단위 segment로 나뉘고, 만료된 segment는 통째로 삭제된다.

### 배치와 압축

메시지를 한 건씩 보내면 네트워크 왕복·syscall·압축 비용이 건마다 든다. producer는 `batch.size`와 `linger.ms`로 수십~수백 건을 record batch로 묶고, broker는 그 batch를 그대로 디스크에 쓰고 consumer에게 그대로 전달한다. 재배치나 재압축이 없다.

압축도 batch 단위다. 메시지별 압축은 헤더 오버헤드 때문에 짧은 메시지가 오히려 커지지만, batch 압축은 반복 패턴을 활용해 JSON 기준 5~10배까지 줄어든다. gzip은 압축률이 높지만 느리고, snappy·lz4는 빠르지만 압축률이 낮으며, zstd가 균형이 가장 좋다.

### Zero-Copy

broker가 로그 파일을 consumer 소켓으로 보내는 일반 경로는 디스크→커널 버퍼→user 버퍼→소켓 버퍼→NIC의 4회 복사와 2회 context switch를 거친다. `sendfile()`은 user space를 거치지 않고 커널 버퍼에서 NIC로 DMA 전송하므로 CPU 소모가 크게 준다. Java에서는 `FileChannel.transferTo()`가 이 syscall을 호출한다. 페이지 캐시와 결합하면 consumer 여러 개가 같은 데이터를 읽어도 커널 안에서 전송이 끝난다.

## 코드

Spring Boot 3.x의 배치·압축 설정이다. producer는 `linger.ms`·`batch.size`, consumer는 `fetch.min.bytes`·`fetch.max.wait.ms`가 배치 크기를 결정한다.

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      compression-type: zstd
      batch-size: 65536
      properties:
        linger.ms: 10
        buffer.memory: 67108864
    consumer:
      group-id: order-consumer
      properties:
        fetch.min.bytes: 65536
        fetch.max.wait.ms: 200
        max.poll.records: 500
```

`KafkaTemplate.send()`는 `CompletableFuture`를 반환한다. `get()`으로 블로킹하면 배치가 채워지지 않으므로 콜백을 붙인다.

```java
@Service
public class OrderEventProducer {

    private static final Logger log = LoggerFactory.getLogger(OrderEventProducer.class);

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public OrderEventProducer(KafkaTemplate<String, OrderEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(OrderEvent event) {
        kafkaTemplate.send("orders", event.orderId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("send failed orderId={}", event.orderId(), ex);
                    return;
                }
                RecordMetadata md = result.getRecordMetadata();
                log.debug("sent {}-{}@{}", md.topic(), md.partition(), md.offset());
            });
    }
}
```

zero-copy 전송을 Java NIO로 재현한 예제다. `transferTo()`는 일부만 보낼 수 있으므로 반환값만큼 반복한다.

```java
public static void sendFile(Path path, SocketAddress address) throws IOException {
    try (FileChannel file = FileChannel.open(path, StandardOpenOption.READ);
         SocketChannel socket = SocketChannel.open(address)) {
        long position = 0;
        long size = file.size();
        while (position < size) {
            position += file.transferTo(position, size - position, socket);
        }
    }
}
```

## 실무에서 걸리는 지점

- ==**TLS와 zero-copy는 양립하지 않는다.**== 암호화가 user space에서 이뤄지므로 TLS 리스너는 sendfile 경로를 타지 못한다. consumer가 많으면 kTLS나 TLS 종단 분리를 검토한다.
- **`linger.ms`는 그대로 지연에 더해진다.** 배치가 차지 않으면 설정값만큼 대기하므로 실시간 경로는 5~10ms로 제한한다.
- **broker 힙을 크게 잡으면 페이지 캐시가 줄어든다.** 힙은 4~8GB로 두고 나머지를 OS에 남긴다. lag가 커져 캐시 밖 segment를 읽으면 디스크 I/O가 급증한다.
- **이미 압축된 payload에 압축을 겹치면 CPU만 낭비한다.** 이미지·압축 파일은 압축률이 1.0~1.5배에 그치므로 `compression.type=none`으로 둔다.
- **zstd는 2.1 이상 클라이언트만 해제할 수 있다.** 구버전 consumer가 남아 있으면 `UNSUPPORTED_COMPRESSION_TYPE` 오류가 난다.

## 관련 글

- [Topic·Partition·Offset·Segment](/notes/kafka/topic-partition-offset-segment/)
- [내부 구현 — Network Layer·Message Format](/notes/kafka/network-layer-message-format/)
- [Log Compaction·Tiered Storage](/notes/kafka/log-compaction-tiered-storage/)
