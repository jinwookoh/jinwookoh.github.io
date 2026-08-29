---
title: "Cluster와 일관된 해싱"
series: redis
part: "운영"
order: 15
summary: "단일 인스턴스의 메모리·쓰기 한계를 넘기 위한 샤딩 — 해시 링과 16384 슬롯이 키 이동을 최소화하는 원리"
tags: [Redis Cluster, Consistent Hashing, Hash Tag, CROSSSLOT, Sharding]
sources: [data-infra/2026-05-17-redis-cluster-scaling.md, data-infra/2026-05-26-redis-consistent-hashing.md]
updated: 2026-08-29
---

Replication과 Sentinel은 읽기 분산과 자동 failover를 제공하지만, 쓰기와 데이터는 여전히 마스터 한 대에 머문다. 데이터가 단일 노드 메모리를 넘거나 쓰기 TPS가 한 프로세스의 처리량을 넘으면 키 공간을 여러 노드에 나누는 샤딩이 필요하다. 가장 단순한 `hash(key) % N` 방식은 N이 바뀌는 순간 거의 모든 키의 목적지가 달라져 대량 캐시 미스가 DB로 쏟아진다. 이 문제를 푸는 것이 일관된 해싱이고, Redis Cluster는 같은 목표를 고정 슬롯 방식으로 구현한다.

## 핵심 개념

### 일관된 해싱 — 해시 링과 가상 노드

일관된 해싱은 해시 공간(0~2³²)을 원으로 보고, 서버와 키를 같은 해시 함수로 링 위에 배치한다. 키는 자기 위치에서 시계 방향으로 처음 만나는 서버에 저장된다. 서버를 추가하면 새 서버와 바로 앞 서버 사이 구간의 키만 이동하고, 제거하면 그 서버가 맡던 구간만 다음 서버로 넘어간다. 이동량은 modulo 방식이 거의 전부인 데 비해 평균 1/N에 그친다.

서버 수가 적으면 링 위의 점이 듬성듬성해져 구간 크기가 불균등해지고, 한 서버가 죽으면 부하가 다음 서버 한 대로 몰린다. 가상 노드는 서버 하나를 수십~수백 개의 가상 점으로 링에 흩뿌려 각 서버가 작은 구간 여러 개를 맡게 한다. 부하가 고르게 펴지고 장애 시 부하도 여러 서버로 분산된다.

### Redis Cluster — 16384 고정 슬롯

Redis Cluster는 해시 링 대신 키 공간을 16384개 슬롯(0~16383)으로 나누고, 각 마스터 노드가 슬롯 범위를 명시적으로 배정받는다. 슬롯 번호는 `CRC16(key) % 16384`로 계산하며 `CLUSTER KEYSLOT key`로 조회한다. 각 마스터는 자신의 replica를 가질 수 있어 3 마스터 + 3 replica 6노드가 최소 권장 구성이다.

두 방식의 차이는 제어권이다. 해시 링은 키 이동이 자동이라 편하지만 어느 키가 어디로 가는지 세밀하게 통제하기 어렵다. 슬롯 방식은 "슬롯 100~200을 노드 B로"처럼 슬롯 단위로 정확히 옮길 수 있다. 둘 다 "노드 수가 바뀌어도 전체를 재배치하지 않는다"는 원칙을 공유한다.

### Hash Tag와 CROSSSLOT

여러 키를 다루는 명령(`MGET`·`MSET`·`SINTER`·`MULTI/EXEC`·`EVAL`의 KEYS)은 모든 키가 같은 슬롯에 있어야 한다. 다른 슬롯이면 `CROSSSLOT Keys in request don't hash to the same slot` 오류가 난다. 키 이름에 `{}`를 넣으면 중괄호 안의 부분만 CRC16 대상이 되므로 `{user:42}:name`과 `{user:42}:email`은 같은 슬롯에 놓인다.

### MOVED · ASK Redirection

요청한 키가 다른 노드 담당이면 `MOVED <slot> <host:port>` 응답이 온다. 클러스터 인식 클라이언트는 재시도하고 슬롯 맵 캐시를 갱신한다. 슬롯이 이동 중(resharding)이라 임시로 다른 노드에 있으면 `ASK`가 오며, 클라이언트는 대상 노드에 `ASKING`을 먼저 보낸 뒤 명령을 재전송한다. MOVED는 영구, ASK는 일회성이다.

### Gossip과 자동 Failover

노드들은 클라이언트 포트 + 10000번의 cluster bus로 노드 상태·슬롯 맵·장애 정보를 교환한다. `cluster-node-timeout`(기본 15초) 안에 PING 응답이 없으면 PFAIL로 표시하고, 마스터 과반수가 같은 판단을 하면 FAIL로 확정한다. 죽은 마스터의 replica가 선출을 요청하고, 마스터 과반수 동의를 얻은 replica가 승격해 슬롯을 인수한다. 과반수 규칙이 split-brain을 막는다. 전체 과정은 수 초에서 30초 안팎이다.

## 코드

Spring Boot 3.x에서 Lettuce로 클러스터에 연결하는 설정이다. 토폴로지 주기 갱신을 켜야 failover 후 슬롯 맵이 자동으로 따라간다.

```java
import io.lettuce.core.cluster.ClusterClientOptions;
import io.lettuce.core.cluster.ClusterTopologyRefreshOptions;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisClusterConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.List;

@Configuration
public class RedisClusterConfig {

    @Bean
    public LettuceConnectionFactory redisConnectionFactory() {
        var cluster = new RedisClusterConfiguration(
                List.of("10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379"));
        cluster.setMaxRedirects(3);

        var refresh = ClusterTopologyRefreshOptions.builder()
                .enablePeriodicRefresh(Duration.ofSeconds(30))
                .enableAllAdaptiveRefreshTriggers()
                .build();

        var clientConfig = LettuceClientConfiguration.builder()
                .clientOptions(ClusterClientOptions.builder()
                        .topologyRefreshOptions(refresh)
                        .build())
                .commandTimeout(Duration.ofSeconds(2))
                .build();

        return new LettuceConnectionFactory(cluster, clientConfig);
    }

    @Bean
    public StringRedisTemplate stringRedisTemplate(LettuceConnectionFactory factory) {
        return new StringRedisTemplate(factory);
    }
}
```

Hash Tag로 사용자 한 명의 키를 같은 슬롯에 묶어 `MSET`·`MGET`과 트랜잭션을 안전하게 쓰는 예다. 태그 없이 `user:42:name` 형태로 쓰면 CROSSSLOT이 난다.

```java
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class UserProfileCache {

    private final StringRedisTemplate redis;

    public UserProfileCache(StringRedisTemplate redis) {
        this.redis = redis;
    }

    private static String key(long userId, String field) {
        return "{user:" + userId + "}:" + field;
    }

    public void save(long userId, String name, String email) {
        redis.opsForValue().multiSet(Map.of(
                key(userId, "name"), name,
                key(userId, "email"), email));
    }

    public List<String> load(long userId) {
        return redis.opsForValue().multiGet(
                List.of(key(userId, "name"), key(userId, "email")));
    }
}
```

가상 노드를 둔 일관된 해싱 링을 `TreeMap`으로 구현한 것이다. 애플리케이션 레벨에서 캐시 노드를 직접 샤딩할 때 쓴다.

```java
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.SortedMap;
import java.util.TreeMap;

public class ConsistentHashRing {

    private final TreeMap<Long, String> ring = new TreeMap<>();
    private final int virtualNodes;

    public ConsistentHashRing(int virtualNodes) {
        this.virtualNodes = virtualNodes;
    }

    public void addNode(String node) {
        for (int i = 0; i < virtualNodes; i++) {
            ring.put(hash(node + "#" + i), node);
        }
    }

    public void removeNode(String node) {
        for (int i = 0; i < virtualNodes; i++) {
            ring.remove(hash(node + "#" + i));
        }
    }

    public String nodeFor(String key) {
        if (ring.isEmpty()) throw new IllegalStateException("no nodes");
        SortedMap<Long, String> tail = ring.tailMap(hash(key));
        return tail.isEmpty() ? ring.firstEntry().getValue() : tail.get(tail.firstKey());
    }

    private static long hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5")
                    .digest(s.getBytes(StandardCharsets.UTF_8));
            return ((long) (d[3] & 0xFF) << 24) | ((d[2] & 0xFF) << 16)
                    | ((d[1] & 0xFF) << 8) | (d[0] & 0xFF);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

## 실무에서 걸리는 지점

- **마이그레이션 시 CROSSSLOT이 가장 큰 작업량이다.** 단일 인스턴스에서 잘 돌던 `MGET`·`SINTER`·Lua 스크립트·트랜잭션이 클러스터로 옮기는 순간 깨진다. Hash Tag를 도입하거나, 원자성이 필요 없으면 파이프라인으로 단일 키 명령을 나눠 보낸다. 파이프라인은 명령별로 라우팅되므로 슬롯이 달라도 동작한다.
- **Hash Tag 남용은 hot slot을 만든다.** 사용자 한 명의 모든 키를 한 태그로 묶었는데 그 사용자에게 트래픽이 몰리면 노드 한 대에 부하가 집중된다. 원자적으로 함께 다뤄야 하는 키만 묶고 노드별 메모리·QPS를 모니터링한다.
- **Cluster를 무조건 고르는 것이 함정이다.** 운영 복잡도가 Sentinel 구성보다 훨씬 크다. 데이터가 단일 노드 메모리에 들어가고 쓰기 TPS가 감당되는 규모라면 Replication + Sentinel이 낫다.
- **Resharding은 I/O 부담이 있다.** `redis-cli --cluster reshard`로 슬롯을 온라인 이동하지만 대상 슬롯의 키를 모두 복사하므로 트래픽이 적은 시간에 수행한다. 이동 중 ASK를 처리하지 못하는 구버전 클라이언트는 오류가 난다.
- **전통 Pub/Sub은 모든 노드에 broadcast된다.** 클러스터가 커질수록 cluster bus 부담이 커진다. Redis 7 이상의 Sharded Pub/Sub(`SPUBLISH`·`SSUBSCRIBE`)은 채널을 슬롯에 매핑해 해당 샤드에서만 전파한다.

## 관련 글

- [Replication과 Sentinel](/notes/redis/replication-sentinel/)
- [Stream·Pub/Sub — 영속 로그와 실시간 전파](/notes/redis/stream-pubsub/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
