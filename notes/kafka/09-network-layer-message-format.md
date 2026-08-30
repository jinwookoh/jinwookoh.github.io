---
title: "내부 구현 — Network Layer·Message Format"
series: kafka
part: "설계와 내부"
order: 9
summary: "브로커가 수만 연결을 소수 스레드로 받는 NIO 구조와, wire·디스크가 공유하는 RecordBatch v2 포맷을 정리한다"
tags: [Kafka, NIO, RequestChannel, RecordBatch, Varint]
sources: [data-infra/2026-05-17-kafka-implementation-network-layer.md, data-infra/2026-05-17-kafka-implementation-message-format.md]
updated: 2026-08-29
---

브로커 한 대에는 수만 개의 TCP 연결이 동시에 맺힌다. 연결마다 스레드를 배정하면 OS 한계에 닿고 컨텍스트 스위칭만으로 CPU가 소진된다. 또한 수신 바이트를 변환해 저장하면 쓰기와 전송마다 직렬화 비용이 붙고 커널 zero-copy가 불가능해진다. ==Kafka는 Java NIO 기반 3단 스레드 풀과 wire·디스크 공용 바이너리 포맷으로 두 문제를 해결한다.==

## 핵심 개념

### 3단 스레드 풀과 RequestChannel

Acceptor는 리스너당 1개로 `accept()`만 수행하고 새 연결을 Processor에 라운드 로빈으로 넘긴다. Processor(`num.network.threads`, 기본 3)는 NIO Selector를 하나씩 보유해 준비된 채널만 골라 처리하므로 스레드 하나가 수천 연결을 다중화한다. 파싱된 요청은 RequestChannel의 request queue(`queued.max.requests`, 기본 500)에 들어가고, KafkaRequestHandler(`num.io.threads`, 기본 8)가 꺼내 로그 append·read를 수행한 뒤 응답을 Processor의 response queue로 돌려준다. request queue가 차면 Processor가 소켓 읽기를 멈춰 클라이언트에 backpressure가 걸린다.

리스너는 여러 개를 둘 수 있고 `listener.name.<name>.num.network.threads`로 리스너별 Processor 수를 분리한다. 브로커 간 복제는 `inter.broker.listener.name`으로 격리한다. 요청 지연은 JMX `RequestMetrics`에서 `RequestQueueTimeMs`·`LocalTimeMs`·`RemoteTimeMs`(복제 대기)·`ResponseQueueTimeMs`·`ResponseSendTimeMs`로 분해된다.

### RecordBatch v2 포맷

프로듀서가 보낸 바이트, 디스크에 쓰인 바이트, 컨슈머가 받는 바이트는 모두 같은 RecordBatch v2다. 브로커는 변환 없이 append하고 `sendfile()`로 그대로 내보낸다. 4.0부터 v0·v1 쓰기가 제거되어 구버전 클라이언트 변환 부담이 사라졌고 `message.format.version` 설정도 제거됐다.

배치 헤더는 `baseOffset`·`partitionLeaderEpoch`·`magic`(2)·`crc`·`attributes`·`lastOffsetDelta`·`baseTimestamp`·`maxTimestamp`·`producerId`·`producerEpoch`·`baseSequence`·`recordsCount`의 고정 길이 필드다. `attributes`는 bit 0~2 압축 코덱, bit 3 타임스탬프 타입, bit 4 트랜잭션, bit 5 컨트롤 배치다. 컨트롤 배치는 COMMIT·ABORT 마커를 담고 `read_committed` 컨슈머가 이를 보고 노출 여부를 정한다.

레코드는 `length`·`attributes`·`timestampDelta`·`offsetDelta`·key·value·headers 순이며 길이와 델타는 zigzag varint로 인코딩된다. 배치 안의 인접한 타임스탬프와 오프셋은 8바이트 대신 1~2바이트로 표현된다. 압축은 배치 단위로 레코드 영역에만 적용되고, 브로커가 재압축 없이 저장해 컨슈머가 처음 해제한다. `crc`는 `attributes`부터 끝까지의 CRC-32C이며 브로커와 컨슈머가 수신 시 검증한다.

## 코드

Processor 스레드의 골격을 재현한 NIO 루프다. Selector 하나가 accept·read 이벤트를 단일 스레드로 처리한다.

```java
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.util.Iterator;

public class SelectorLoop {
    public static void main(String[] args) throws Exception {
        Selector selector = Selector.open();
        ServerSocketChannel server = ServerSocketChannel.open();
        server.bind(new InetSocketAddress(9092));
        server.configureBlocking(false);
        server.register(selector, SelectionKey.OP_ACCEPT);

        ByteBuffer buf = ByteBuffer.allocateDirect(64 * 1024);
        while (!Thread.currentThread().isInterrupted()) {
            selector.select(300);
            Iterator<SelectionKey> it = selector.selectedKeys().iterator();
            while (it.hasNext()) {
                SelectionKey key = it.next();
                it.remove();
                if (key.isAcceptable()) {
                    SocketChannel client = server.accept();
                    client.configureBlocking(false);
                    client.register(selector, SelectionKey.OP_READ);
                } else if (key.isReadable()) {
                    SocketChannel ch = (SocketChannel) key.channel();
                    buf.clear();
                    if (ch.read(buf) < 0) { ch.close(); continue; }
                    buf.flip();
                    // 요청 프레임 파싱 후 RequestChannel에 enqueue
                }
            }
        }
    }
}
```

세그먼트 파일을 `FileRecords`로 열어 배치 헤더와 레코드를 읽는다. `kafka-dump-log.sh --deep-iteration`이 내부에서 하는 일과 같다.

```java
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.record.FileRecords;
import org.apache.kafka.common.record.Record;
import org.apache.kafka.common.record.RecordBatch;
import java.io.File;
import java.nio.charset.StandardCharsets;

public class SegmentDump {
    public static void main(String[] args) throws Exception {
        File segment = new File("/var/kafka-data/orders-0/00000000000000000000.log");
        try (FileRecords records = FileRecords.open(segment, false)) {
            for (RecordBatch batch : records.batches()) {
                System.out.printf("batch base=%d last=%d epoch=%d pid=%d codec=%s txn=%b control=%b%n",
                        batch.baseOffset(), batch.lastOffset(), batch.partitionLeaderEpoch(),
                        batch.producerId(), batch.compressionType(),
                        batch.isTransactional(), batch.isControlBatch());
                batch.ensureValid(); // CRC-32C 검증
                for (Record r : batch) {
                    StringBuilder headers = new StringBuilder();
                    for (Header h : r.headers()) {
                        headers.append(h.key()).append('=')
                               .append(new String(h.value(), StandardCharsets.UTF_8)).append(' ');
                    }
                    System.out.printf("  offset=%d ts=%d keySize=%d valueSize=%d headers=[%s]%n",
                            r.offset(), r.timestamp(), r.keySize(), r.valueSize(), headers);
                }
            }
        }
    }
}
```

Spring Kafka에서 레코드 헤더를 싣는 예다. 헤더는 배치 길이에 더해지므로 필요한 항목만 넣는다.

```java
import org.apache.kafka.clients.producer.ProducerRecord;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import java.nio.charset.StandardCharsets;

@Service
public class OrderEventPublisher {

    private final KafkaTemplate<String, String> template;

    public OrderEventPublisher(KafkaTemplate<String, String> template) {
        this.template = template;
    }

    public void publish(String orderId, String payload, String traceId) {
        ProducerRecord<String, String> record = new ProducerRecord<>("orders", orderId, payload);
        record.headers()
              .add("trace-id", traceId.getBytes(StandardCharsets.UTF_8))
              .add("schema-v", "2".getBytes(StandardCharsets.UTF_8));
        template.send(record);
    }
}
```

## 실무에서 걸리는 지점

- **스레드 증설 기준은 idle percent다.** `NetworkProcessorAvgIdlePercent`가 0.3 아래로 지속되면 `num.network.threads`를, `RequestHandlerAvgIdlePercent`가 0.3 아래면 `num.io.threads`를 늘린다. io 스레드 부족은 디스크 포화의 결과인 경우가 많다.
- ==**`RemoteTimeMs`는 스레드 문제가 아니다.**== `acks=all` Produce가 팔로워 복제 완료를 기다리는 시간이며, 팔로워 fetch 지연과 ISR 축소를 봐야 한다.
- **SSL 리스너는 zero-copy를 잃는다.** TLS는 유저 공간에서 수행되므로 `sendfile()`을 쓸 수 없고 Fetch마다 CPU 비용이 든다.
- **`compression.type`을 프로듀서와 브로커에서 맞춘다.** 토픽 설정이 `producer`가 아니고 코덱이 다르면 브로커가 매 배치를 재압축하며 그 비용이 RequestHandler 풀에 얹힌다.
- **`max.connections.per.ip`는 기본값이 사실상 무제한이다.** 커넥션을 반환하지 않는 클라이언트 버그가 Selector를 채우므로 상한을 둔다. `connections.max.idle.ms`(기본 10분)와 로드밸런서 idle timeout이 어긋나면 끊긴 연결에 대한 재시도가 폭증한다.

## 관련 글

- [설계 철학 — 왜 디스크·배치·Zero-Copy인가](/notes/kafka/design-philosophy/)
- [Topic·Partition·Offset·Segment](/notes/kafka/topic-partition-offset-segment/)
- [Monitoring·Hardware·성능 튜닝](/notes/kafka/monitoring-performance/)
