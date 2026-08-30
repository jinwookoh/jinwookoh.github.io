---
title: "메모리 최적화와 클라이언트 (Jedis·Lettuce)"
series: redis
part: "운영"
order: 17
summary: "인코딩 임계값과 키 오버헤드로 메모리를 줄이고, 연결 모델 차이로 Jedis와 Lettuce를 고르는 기준을 정리한다."
tags: [Redis, listpack, fragmentation, Jedis, Lettuce]
sources: [data-infra/2026-05-17-redis-memory-optimization.md, data-infra/2026-05-17-redis-clients-overview.md, data-infra/2026-05-17-redis-clients-java.md]
updated: 2026-08-29
---

Redis는 데이터셋 전체를 메모리에 올리므로 메모리가 가장 비싼 자원이다. 같은 데이터라도 키를 나누는 방식과 내부 인코딩에 따라 사용량이 몇 배씩 달라지고, 단편화는 모니터링하지 않으면 조용히 쌓인다. 서버를 잘 튜닝해도 클라이언트가 요청마다 TCP 연결을 새로 열거나 공유 연결에 블로킹 명령을 보내면 지연과 장애는 애플리케이션 쪽에서 발생한다.

## 핵심 개념

### 내부 인코딩 자동 전환

작은 자료구조는 연속된 메모리 블록 하나에 필드와 값을 packing한 인코딩을 쓰고, 임계값을 넘으면 전통적인 자료구조로 바뀐다. Redis 6.2 이하의 ziplist는 7.0부터 listpack으로 대체됐다.

| 자료구조 | 작은 인코딩 | 큰 인코딩 | 전환 기준 |
|:---|:---|:---|:---|
| String | int·embstr | raw | 44바이트 초과 |
| Hash·Sorted Set | listpack | hashtable / skiplist | 128개 또는 값 64바이트 초과 |
| List | listpack | quicklist | listpack 노드 한계 초과 |
| Set (정수만) | intset | hashtable | 512개 초과 |
| Set (일반, 7.2+) | listpack | hashtable | 128개 또는 값 64바이트 초과 |

작은 인코딩은 3~10배 적은 메모리를 쓰고, O(N)이어도 N이 작아 CPU 캐시 친화적이라 실제로는 더 빠른 경우가 많다. 임계값은 `hash-max-listpack-entries` 같은 설정으로 조정하지만 기본값이 대체로 균형점이다. 한 번 큰 인코딩으로 전환된 키는 멤버를 다시 줄여도 되돌아오지 않으며, DEL 후 재생성해야 한다.

### 키 오버헤드와 Hash 묶기

키 하나마다 해시 테이블 슬롯·만료 정보 등으로 50~100바이트가 붙는다. 사용자 100만 명에 필드 10개를 `user:123:name` 식으로 나누면 1,000만 키에 약 1GB가 본문과 무관한 오버헤드로 빠진다. 객체 하나를 Hash 하나로 묶으면 오버헤드가 필드 수만큼 줄고, listpack 범위 안이면 추가로 절약된다. ID를 1000으로 나눠 같은 Hash에 여러 객체를 담는 Hash sharding은 접근 패턴이 복잡해지므로 키가 수천만 개 이상일 때만 고려한다.

### Fragmentation

jemalloc은 16·32·64바이트 같은 고정 등급으로 할당하므로 등급에 맞지 않는 크기의 남는 공간이 단편화로 쌓인다. `INFO memory`의 `mem_fragmentation_ratio`가 1.0~1.5면 정상, 1.5 초과면 완화가 필요하고, 1.0 미만이면 OS가 swap 중이라는 뜻으로 응답 시간이 밀리초 단위로 뛴다. `activedefrag yes`로 백그라운드 정리를 켜고, 키별 분석은 `MEMORY USAGE`, 큰 키 탐색은 `redis-cli --bigkeys`를 쓴다.

### 클라이언트 연결 모델

클라이언트는 RESP라는 텍스트 프로토콜로 통신하며 Redis 6부터 `HELLO 3`로 RESP3를 협상한다. TCP 연결 생성 비용이 작지 않으므로 Pool이나 공유 연결로 재사용하는 것이 표준이며, 동기·비동기·반응형 중 애플리케이션 모델에 맞는 API를 고른다.

Java 공식 클라이언트는 Jedis와 Lettuce다. Jedis는 인스턴스 하나가 연결 하나에 대응하는 동기 클라이언트로 스레드 안전하지 않아 JedisPool이 필수이고, 100 스레드면 100 연결이 필요하다. Lettuce는 Netty 기반으로 연결 하나를 여러 스레드가 multiplexing해 공유하며 스레드 안전하다. 동기·비동기·반응형 API를 같은 연결에서 제공하고 auto-reconnect·Cluster topology adaptive refresh·Master/Replica 읽기 라우팅을 내장한다. Spring Boot 2.0부터 기본 클라이언트가 Lettuce인 이유다. 단순 명령 성능은 둘이 거의 같고, 차이는 고동시성 환경에서 연결 수로 벌어진다. Redisson은 `RLock` 같은 분산 객체와 Watchdog(TTL 자동 연장)을 제공하는 세 번째 선택지로, Lettuce와 함께 쓰는 조합이 흔하다.

## 코드

Spring Boot 3.x에서 Lettuce를 기본으로 두고 타임아웃과 Cluster topology refresh를 설정한다.

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      username: app
      password: pass
      timeout: 2s
      connect-timeout: 1s
      lettuce:
        cluster:
          refresh:
            adaptive: true
            period: 60s
```

Lettuce 연결 하나에서 세 API를 모두 쓰고, 블로킹 명령은 별도 연결로 분리한다.

```java
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import reactor.core.publisher.Mono;

public class LettuceExample {
    public static void main(String[] args) {
        RedisClient client = RedisClient.create("redis://app:pass@localhost:6379");
        try (StatefulRedisConnection<String, String> conn = client.connect()) {
            conn.sync().hset("user:123", java.util.Map.of("name", "John", "email", "john@example.com"));
            conn.async().hget("user:123", "name")
                .thenAccept(name -> System.out.println("async: " + name));
            Mono<Long> size = conn.reactive().hlen("user:123");
            System.out.println("reactive: " + size.block());
        }
        try (StatefulRedisConnection<String, String> blocking = client.connect()) {
            blocking.sync().blpop(5, "queue:jobs");
        }
        client.shutdown();
    }
}
```

Jedis를 써야 한다면 Pool에서 빌린 인스턴스를 try-with-resources로 반드시 반환한다.

```java
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;

public class JedisExample {
    public static void main(String[] args) {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(50);
        config.setMaxIdle(10);
        config.setMinIdle(2);
        try (JedisPool pool = new JedisPool(config, "localhost", 6379, 2000, "app", "pass")) {
            try (Jedis jedis = pool.getResource()) {
                jedis.hset("user:123", "name", "John");
                System.out.println(jedis.memoryUsage("user:123"));
            }
        }
    }
}
```

## 실무에서 걸리는 지점

- `maxmemory`를 지정하지 않으면 eviction이 발동하지 않고 OS OOM killer가 프로세스를 죽인다. `used_memory / maxmemory` 비율과 `mem_fragmentation_ratio`를 알림 대상으로 둔다.
- 장시간 운영하면 단편화가 누적된다. `activedefrag`는 CPU 부담이 약간 늘고, `mem_allocator`가 jemalloc인지 확인한다.
- Lettuce 공유 연결에 `BLPOP 0`·`SUBSCRIBE`를 보내면 그 연결의 모든 명령이 멈춘다. 블로킹 명령과 Pub/Sub은 전용 연결을 쓴다.
- Jedis에서 `getResource()` 후 close를 빠뜨리면 connection leak으로 pool exhaustion이 온다. 인스턴스 하나를 여러 스레드가 공유하면 응답이 뒤섞인다.
- Cluster-aware 클라이언트라도 MGET·SINTER 같은 multi-key 명령은 슬롯이 다르면 CROSSSLOT 오류를 낸다. 구버전 Jedis 3.x는 Redis 7 신규 명령을 지원하지 않는다.

## 관련 글

- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
- [분산 락 — SET NX와 Redlock](/notes/redis/distributed-lock-redlock/)
