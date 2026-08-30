---
title: "Stream·Pub/Sub — 영속 로그와 실시간 전파"
series: redis
part: "데이터 타입"
order: 6
summary: "손실이 허용되는 실시간 신호는 Pub/Sub, 재처리와 ACK가 필요한 이벤트는 Stream Consumer Group으로 처리한다"
tags: [Redis, Stream, Pub/Sub, Consumer Group, XREADGROUP]
sources: [data-infra/2026-05-17-redis-streams.md, data-infra/2026-05-17-redis-pubsub.md, 2026-05-02-redis-pubsub-streams.md]
updated: 2026-08-29
---

서버 인스턴스가 여러 대로 늘어나면 캐시 무효화, 사용자 알림, 주문 이벤트 후속 처리를 인스턴스 간에 전달해야 한다. List를 큐로 쓰면 한 메시지가 한 워커에게만 가고, LPOP 직후 워커가 죽으면 메시지가 사라지며, 여러 서비스가 같은 이벤트를 각자 받는 구조도 만들 수 없다. Redis는 이 자리에 두 도구를 둔다. ==Pub/Sub는 저장 없이 즉시 전파하고, Stream은 추가 전용 로그에 쌓아 Consumer Group으로 나눠 처리한다.==

## 핵심 개념

### Pub/Sub — 저장하지 않는 전파

`PUBLISH channel message`는 그 순간 해당 채널을 `SUBSCRIBE`하고 있는 클라이언트에게만 메시지를 보낸다. 반환값은 받은 구독자 수이며 0이면 아무도 받지 못한 채 사라진 것이다. ==서버가 메시지를 저장하지 않으므로 재처리·ACK·과거 조회가 불가능하다.== `PSUBSCRIBE news.*`처럼 와일드카드 패턴 구독이 가능하고, `PUBSUB CHANNELS`·`NUMSUB`로 상태를 확인한다. 구독 모드 연결은 구독 관련 명령과 PING·QUIT 외의 일반 명령을 거부하므로 발행용 연결과 분리한다.

Cluster에서는 전통 Pub/Sub가 어느 노드에 구독자가 있는지 모르기 때문에 모든 노드로 broadcast하며, 노드 수에 비례해 비용이 커진다. Redis 7의 Sharded Pub/Sub(`SPUBLISH`·`SSUBSCRIBE`)는 채널 이름의 슬롯을 계산해 해당 shard 안에서만 메시지를 흘린다. 비용이 일정해지는 대신 구독자가 같은 shard에 연결되어야 하고 패턴 구독은 지원하지 않는다.

### Stream — 추가 전용 로그

`XADD key * field value ...`는 항목을 로그 끝에 붙이고 `<밀리초>-<시퀀스>` 형식의 단조 증가 ID를 돌려준다. `XRANGE key - +`로 범위를 조회하고 `XREAD BLOCK 0 STREAMS key $`로 새 항목을 기다린다. `0`은 처음부터, `$`는 현재 이후만을 뜻한다. 필드 값은 문자열만 저장되므로 객체는 JSON으로 직렬화한다.

`XREAD`로 여러 인스턴스가 같은 스트림을 읽으면 전부가 같은 메시지를 처리한다. 부하를 나누려면 Consumer Group을 만든다.

1. `XGROUP CREATE key group $ MKSTREAM` — 그룹 생성. `$`는 생성 이후, `0`은 처음부터 소비한다.
2. `XREADGROUP GROUP group consumer COUNT 10 STREAMS key >` — `>`는 그룹의 누구에게도 전달되지 않은 항목만 가져온다. 항목은 한 소비자에게만 배정되며 동시에 PEL(Pending Entries List)에 등록된다.
3. `XACK key group id` — 처리 완료를 알리고 PEL에서 제거한다.
4. `XPENDING key group` — 미ACK 항목을 확인한다. `XAUTOCLAIM key group consumer 30000 0-0`은 30초 이상 ACK되지 않은 항목을 다른 소비자로 넘긴다.

==죽은 워커의 항목을 회수해 다시 처리하므로 at-least-once가 성립한다.== 그룹이 여러 개면 각 그룹이 같은 메시지를 독립적으로 받는다.

### 세 도구의 보장 수준

| 항목 | Pub/Sub | List | Stream |
|:---|:---|:---|:---|
| 영속성 | 없음 | 있음 | 있음 |
| 재처리 | 불가 | LMOVE 패턴으로 보완 | 가능 |
| 다중 소비자 그룹 | 각자 SUBSCRIBE | 불가 | 가능 |
| 그룹 내 부하 분산 | 불가 | BLPOP 경합 | 가능 |
| ACK·워커 사망 복구 | 없음 | 없음 | XACK·XAUTOCLAIM |

Stream은 Kafka와 로그·Consumer Group·ACK 모델이 같지만, Kafka는 디스크 기반이라 TB 단위 보존과 파티션 자동 분산을 제공하고 Stream은 메모리 기반이라 `MAXLEN` 트림이 필수다. 이미 Redis가 있고 소~중규모면 Stream, 영구 보존과 대용량 처리량이 결정적이면 Kafka를 택한다.

## 코드

`StringRedisTemplate`으로 주문 이벤트를 발행하고 `MAXLEN ~ 10000` 근사 트림을 함께 건다.

```java
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
public class OrderEventPublisher {

    private static final String STREAM = "orders:stream";
    private final StringRedisTemplate redis;

    public OrderEventPublisher(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public RecordId publish(long orderId, long amount, long userId) {
        var record = StreamRecords.newRecord()
                .in(STREAM)
                .ofMap(Map.of(
                        "order_id", String.valueOf(orderId),
                        "amount", String.valueOf(amount),
                        "user", String.valueOf(userId)));
        RecordId id = redis.opsForStream().add(record);
        redis.opsForStream().trim(STREAM, 10_000, true);
        return id;
    }
}
```

Consumer Group 소비자. 기동 시 그룹을 만들고(`BUSYGROUP`은 무시), `>`로 읽어 처리 후 ACK하며, 별도 스케줄에서 30초 이상 방치된 항목을 회수한다.

```java
import org.springframework.data.redis.RedisSystemException;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import jakarta.annotation.PostConstruct;
import java.time.Duration;
import java.util.List;
import java.util.Map;

@Component
public class OrderEventConsumer {

    private static final String STREAM = "orders:stream";
    private static final String GROUP = "order-workers";
    private final String consumerName = "worker-" + System.getenv().getOrDefault("HOSTNAME", "local");
    private final StringRedisTemplate redis;

    public OrderEventConsumer(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @PostConstruct
    void createGroup() {
        try {
            redis.opsForStream().createGroup(STREAM, ReadOffset.latest(), GROUP);
        } catch (RedisSystemException e) {
            if (e.getMessage() == null || !e.getMessage().contains("BUSYGROUP")) {
                throw e;
            }
        }
    }

    @Scheduled(fixedDelay = 500)
    public void consume() {
        List<MapRecord<String, Object, Object>> records = redis.opsForStream().read(
                Consumer.from(GROUP, consumerName),
                StreamReadOptions.empty().count(10).block(Duration.ofSeconds(2)),
                StreamOffset.create(STREAM, ReadOffset.lastConsumed()));
        if (records == null) {
            return;
        }
        for (MapRecord<String, Object, Object> record : records) {
            handle(record.getValue());
            redis.opsForStream().acknowledge(STREAM, GROUP, record.getId());
        }
    }

    @Scheduled(fixedDelay = 10_000)
    public void reclaimStale() {
        redis.execute((org.springframework.data.redis.core.RedisCallback<Void>) conn -> {
            conn.streamCommands().xClaim(
                    STREAM.getBytes(), GROUP, consumerName,
                    org.springframework.data.redis.connection.RedisStreamCommands.XClaimOptions
                            .minIdle(Duration.ofSeconds(30))
                            .ids(pendingIds()));
            return null;
        });
    }

    private org.springframework.data.redis.connection.stream.RecordId[] pendingIds() {
        var pending = redis.opsForStream().pending(STREAM, GROUP,
                org.springframework.data.domain.Range.unbounded(), 50);
        return pending.stream()
                .filter(p -> p.getElapsedTimeSinceLastDelivery().compareTo(Duration.ofSeconds(30)) > 0)
                .map(p -> p.getId())
                .toArray(org.springframework.data.redis.connection.stream.RecordId[]::new);
    }

    private void handle(Map<Object, Object> fields) {
        // 주문 처리 로직. 예외를 던지면 ACK되지 않아 PEL에 남고 reclaimStale이 회수한다.
    }
}
```

Pub/Sub 구독은 `RedisMessageListenerContainer`에 리스너를 등록한다. 컨테이너가 전용 연결을 잡으므로 일반 명령용 템플릿과 충돌하지 않는다.

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.data.redis.listener.adapter.MessageListenerAdapter;

@Configuration
public class CacheInvalidationConfig {

    @Bean
    RedisMessageListenerContainer listenerContainer(RedisConnectionFactory factory,
                                                    LocalCacheInvalidator invalidator) {
        var container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        container.addMessageListener(
                new MessageListenerAdapter(invalidator, "onMessage"),
                new PatternTopic("cache:invalidate:*"));
        return container;
    }
}
```

```java
import org.springframework.stereotype.Component;

@Component
public class LocalCacheInvalidator {

    public void onMessage(String key, String pattern) {
        // key = 무효화할 캐시 키. 각 인스턴스가 자기 로컬 캐시에서 제거한다.
    }
}
```

발행은 `redis.convertAndSend("cache:invalidate:user", "user:42")`로 한다.

## 실무에서 걸리는 지점

- ACK 누락은 PEL을 키운다. `XPENDING` 개수를 지표로 내보내고, 반복 실패 항목은 delivery count를 보고 dead letter 스트림으로 옮긴다.
- ==Stream은 자동으로 줄지 않는다.== `XADD`마다 `MAXLEN ~ N`을 붙이거나 `MINID`로 시간 기반 보존을 건다. `~` 없는 정확한 트림은 매 호출마다 비용이 붙는다.
- 그룹을 만든 스트림에 `XREAD`를 섞으면 그 항목은 PEL에 기록되지 않아 중복 처리가 난다. `XREADGROUP`만 쓴다.
- Pub/Sub 구독자가 느리면 출력 버퍼가 `client-output-buffer-limit pubsub`(기본 32mb hard, 8mb soft, 60초)를 넘는 순간 연결이 끊기고 그 사이 발행분은 복구되지 않는다.
- Cluster에서 대량 발행이면 Sharded Pub/Sub로 옮기되, Keyspace Notification은 전통 Pub/Sub만 지원하고 클라이언트의 `SSUBSCRIBE` 지원 여부를 확인한다.

## 관련 글

- [List·Set — 큐와 집합 연산](/notes/redis/list-set/)
- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
