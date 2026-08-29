---
title: "Replication과 Sentinel"
series: redis
part: "운영"
order: 14
summary: "비동기 복제로 읽기를 분산하고 Sentinel의 quorum 합의로 master 장애를 자동 승격하는 원리와 함정"
tags: [Redis, Replication, Sentinel, Failover, PSYNC]
sources: [data-infra/2026-05-17-redis-replication.md, data-infra/2026-05-17-redis-sentinel.md, 2026-05-02-redis-cluster-ha.md]
updated: 2026-08-29
---

Redis를 인스턴스 하나로 운영하면 그 프로세스가 곧 단일 장애점이다. 호스트가 내려가면 이를 의존하는 모든 서비스가 멈추고 마지막 스냅샷 이후의 데이터는 사라진다. Replication은 복제본을 두어 읽기를 분산하고 사본을 확보하며, Sentinel은 master 장애를 감지해 복제본을 자동 승격한다. 둘은 별개라 Replication만 구성하면 failover는 여전히 사람이 해야 한다.

## 핵심 개념

### Master-Replica 비동기 복제

replica 쪽에서 `REPLICAOF <ip> <port>`를 실행하거나 redis.conf에 `replicaof`를 두면 복제가 시작되고, 기본값 `replica-read-only yes`로 replica는 읽기만 받는다. 복제는 비동기다. master는 메모리를 갱신한 즉시 응답하고 그 뒤에 변경 스트림을 replica로 보낸다. 따라서 쓴 직후 replica에서 읽으면 이전 값이 나올 수 있고, 전파 전에 master가 죽으면 그 쓰기는 손실된다.

`WAIT <numreplicas> <timeout>`은 특정 쓰기에 한해 지정한 수의 replica가 ack할 때까지 기다리고 실제 ack 수를 반환한다. 이것도 동기 복제는 아니며 강한 일관성은 보장하지 않는다.

### PSYNC — Replication ID와 Offset

데이터셋 버전은 Replication ID(이력을 나타내는 임의 문자열)와 offset(복제 스트림 바이트 카운터) 쌍으로 표현된다. replica는 재접속 시 `PSYNC <replid> <offset>`을 보낸다.

- Partial resync: ID가 master의 현재 또는 secondary ID와 일치하고 `repl-backlog-size` 백로그에 offset 이후 데이터가 남아 있으면 놓친 구간만 전송한다.
- Full resync: ID가 다르거나 백로그가 부족하면 RDB를 만들어 전송하고 이후 스트림을 이어받는다. 데이터셋이 크면 수 분이 걸린다.

수동 failover는 replica에서 `REPLICAOF NO ONE`으로 승격하고 나머지에 새 master를 지정한다. 승격된 노드는 이전 ID를 secondary로 유지하므로 다른 replica가 partial resync로 붙을 수 있다.

### Sentinel

Sentinel은 데이터 노드와 별개 프로세스이며 기본 포트는 26379다. master·replica를 감시하고(monitoring), 장애를 알리며(notification), replica를 자동 승격하고(failover), 클라이언트에게 현재 master 주소를 알려준다(configuration provider).

장애 판정은 두 단계다. 한 Sentinel이 `down-after-milliseconds` 동안 응답을 받지 못하면 SDOWN(주관적 다운)으로 표시하고, 다른 Sentinel에 물어 quorum 수만큼 동의하면 ODOWN(객관적 다운)이 되어 failover가 시작된다. quorum은 ODOWN 판정에 필요한 동의 수이고, failover 진행은 leader 선출에서 전체 Sentinel의 과반(majority) 표가 필요하다. 5개에 quorum 2면 ODOWN은 2개로 되지만 failover 인가에는 3표가 필요하다.

failover는 ODOWN 뒤 leader를 뽑고, leader가 replica를 골라 `REPLICAOF NO ONE`을 보내고 나머지를 재지정한 뒤 `+switch-master` 이벤트를 발행한다. 승격 대상은 `replica-priority`가 가장 낮은 것, 그중 offset이 가장 큰 것 순이며 priority 0은 후보에서 제외된다.

Sentinel은 최소 3개, 홀수로 서로 다른 failure domain에 둔다. 2개면 네트워크 분리 시 양쪽이 각자 failover를 진행해 master가 둘이 되는 split-brain이 생긴다. Sentinel은 샤딩 없이 단일 master의 HA만 담당하므로 데이터가 한 노드 RAM을 넘으면 Cluster로 간다.

## 코드

sentinel.conf 최소 구성. `monitor`의 마지막 인자가 quorum이다.

```
port 26379
sentinel monitor mymaster 10.0.0.1 6379 2
sentinel auth-pass mymaster redis-secret
sentinel down-after-milliseconds mymaster 30000
sentinel failover-timeout mymaster 180000
sentinel parallel-syncs mymaster 1
```

Spring Boot 3.x Sentinel 연결 설정. Lettuce가 Sentinel에 master 주소를 물어 접속하고 failover 후 재연결한다.

```yaml
spring:
  data:
    redis:
      sentinel:
        master: mymaster
        nodes:
          - sentinel-1:26379
          - sentinel-2:26379
          - sentinel-3:26379
        password: sentinel-secret
      password: redis-secret
```

읽기를 replica로 보내는 Lettuce 설정과, 중요 쓰기에 `WAIT`를 거는 서비스.

```java
@Configuration
public class RedisConfig {

    @Bean
    public LettuceClientConfigurationBuilderCustomizer readFromReplica() {
        return builder -> builder.readFrom(ReadFrom.REPLICA_PREFERRED);
    }
}

@Service
public class OrderStateStore {

    private final StringRedisTemplate redis;

    public OrderStateStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public long saveConfirmed(long orderId, String state) {
        redis.opsForValue().set("order:" + orderId + ":state", state);
        // replica 1개가 ack할 때까지 최대 500ms 대기, 실제 ack 수 반환
        Long acked = redis.execute((RedisCallback<Long>) conn ->
                (Long) conn.execute("WAIT", "1".getBytes(), "500".getBytes()));
        return acked == null ? 0 : acked;
    }
}
```

## 실무에서 걸리는 지점

- 복제 지연. `INFO replication`의 `lag`이 수 초로 벌어지면 네트워크·replica 스펙을 점검한다. `REPLICA_PREFERRED`는 쓰기 직후 읽기에 이전 값을 줄 수 있으므로 본인이 쓴 값을 바로 보여주는 경로는 master에서 읽는다.
- 백로그 부족. 기본 `repl-backlog-size 1mb`는 짧은 끊김에도 full resync를 유발한다. 수십~수백 MB로 잡는다. full resync마다 master가 fork하므로 메모리가 최대 2배까지 오른다.
- `down-after-milliseconds`가 너무 짧으면 GC pause가 불필요한 failover를 일으킨다. 수십 초 단위로 잡는다.
- master IP를 하드코딩한 클라이언트는 failover 후 옛 master에 쓰기를 보내 `READONLY` 에러를 받는다. Sentinel 목록과 master 이름으로만 접속한다.
- RPO는 0이 아니다. failover 시점에 전파되지 않은 쓰기는 사라진다. `notification-script`를 붙이지 않으면 failover가 일어난 사실조차 알 수 없다.

## 관련 글

- [Persistence — RDB·AOF·Hybrid](/notes/redis/persistence-rdb-aof/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
