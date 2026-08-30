---
title: "Persistence — RDB·AOF·Hybrid"
series: redis
part: "운영"
order: 13
summary: "RDB 스냅샷·AOF 로그·Hybrid의 RPO/RTO 트레이드오프와 fsync 정책, fork 비용을 기준으로 영속화 옵션을 고른다."
tags: [Redis, RDB, AOF, fsync, Persistence]
sources: [data-infra/2026-05-17-redis-persistence.md, 2026-05-02-redis-persistence.md]
updated: 2026-08-29
---

Redis는 모든 데이터를 메모리에 두기 때문에 프로세스가 종료되면 데이터도 함께 사라진다. 세션·분산 락·랭킹·Stream처럼 Redis가 유일한 저장소인 데이터는 재시작 한 번에 유실되고, 캐시라 해도 재시작 직후 모든 요청이 DB로 몰려 워밍 비용이 장애로 번질 수 있다. 영속화는 메모리 상태를 디스크에 기록해 재시작 후 자동 복구하는 메커니즘이며, 어떤 방식을 어떤 설정으로 쓰느냐에 따라 허용 손실 시간(RPO)·복구 시간(RTO)·쓰기 성능이 달라진다.

## 핵심 개념

Redis의 영속화 옵션은 네 가지로 정리된다.

- **No Persistence** — `save ""` + `appendonly no`. 진실의 원천이 별도 DB에 있는 순수 캐시에만 쓴다.
- **RDB(Redis Database)** — 특정 시점의 전체 데이터셋을 바이너리 파일(`dump.rdb`)로 저장하는 스냅샷. `save <초> <변경 수>` 조건을 여러 줄 두면 OR로 동작해, 트래픽이 많을수록 자주 찍는다.
- **AOF(Append Only File)** — 모든 쓰기 명령을 RESP 형식으로 순차 기록한다. 재시작 시 명령을 처음부터 재실행해 복구한다.
- **Hybrid** — AOF를 켜고 `aof-use-rdb-preamble yes`를 두면 rewrite 시점에 RDB 스냅샷을 파일 앞부분에 두고 이후 변경만 AOF 로그로 이어 붙인다. Redis 7부터는 base 파일과 incremental 파일로 나뉜 multi-part AOF를 `appendonlydir` 아래에 둔다.

RDB 저장은 `BGSAVE`가 `fork()`로 만든 자식 프로세스가 fork 시점의 메모리를 디스크에 쓰는 방식이다. Copy-on-Write로 부모가 수정한 페이지만 복사되므로 부모는 계속 요청을 처리한다. `SAVE`는 메인 스레드가 직접 쓰기 때문에 완료까지 모든 요청이 차단되며 운영에서는 쓰지 않는다.

AOF의 핵심은 `appendfsync` 정책이다.

| 정책 | 데이터 손실 | 성능 영향 | 용도 |
|:---|:---|:---|:---|
| `always` | 없음 | 매우 큼 (TPS 1/10 수준까지) | 금융·법적 보장 |
| `everysec` | 최대 1초 | 작음 | 기본값, 대부분의 환경 |
| `no` | OS 플러시 주기(수 초~수십 초) | 없음 | 손실 허용 |

`everysec`은 별도 스레드가 매초 fsync를 수행하므로 메인 스레드 영향이 적다. 다만 fsync 직전 크래시 시 1초 분량은 사라지므로 무손실은 아니다.

AOF는 계속 커지므로 **rewrite**로 현재 메모리 상태를 최소 명령으로 다시 쓴다. `INCR counter` 1000회는 `SET counter 1000` 한 줄이 된다. `auto-aof-rewrite-percentage 100`과 `auto-aof-rewrite-min-size 64mb`가 모두 만족될 때 자동 실행되며 수동은 `BGREWRITEAOF`다.

RDB는 파일이 작고 한 번에 로드해 복구가 빠르며 원격 백업이 쉽지만 마지막 스냅샷 이후 수 분이 유실된다. AOF는 손실이 1초 이하지만 파일이 크고 재실행 복구가 느리다. Hybrid는 둘의 장점을 동시에 얻는다. 시작 시 AOF가 켜져 있으면 AOF를 우선 로드하고, 꺼져 있을 때만 `dump.rdb`를 읽는다.

용도별로는 순수 캐시는 No Persistence, 워밍 비용이 큰 캐시는 RDB only, 세션·중요 캐시와 DB 보완 용도는 Hybrid + everysec, 금융 거래는 AOF always에 정기 RDB 백업과 복제를 더한다.

## 코드

운영 기본값으로 쓸 수 있는 Hybrid 설정이다.

```conf
# redis.conf
save 3600 1
save 300 100
save 60 10000
rdbcompression yes
rdbchecksum yes
stop-writes-on-bgsave-error yes

appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

Spring Boot에서 `INFO persistence`를 읽어 저장 상태와 rewrite 임박 여부를 헬스 체크로 노출하는 예제다.

```java
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.stereotype.Component;

import java.util.Properties;

@Component
public class RedisPersistenceHealthIndicator implements HealthIndicator {

    private final RedisConnectionFactory factory;

    public RedisPersistenceHealthIndicator(RedisConnectionFactory factory) {
        this.factory = factory;
    }

    @Override
    public Health health() {
        try (var conn = factory.getConnection()) {
            Properties info = conn.serverCommands().info("persistence");
            String bgsave = info.getProperty("rdb_last_bgsave_status", "unknown");
            String aofWrite = info.getProperty("aof_last_write_status", "unknown");
            long current = Long.parseLong(info.getProperty("aof_current_size", "0"));
            long base = Long.parseLong(info.getProperty("aof_base_size", "1"));
            long pending = Long.parseLong(info.getProperty("rdb_changes_since_last_save", "0"));

            Health.Builder b = "ok".equals(bgsave) && "ok".equals(aofWrite)
                    ? Health.up() : Health.down();
            return b.withDetail("rdb_last_bgsave_status", bgsave)
                    .withDetail("aof_last_write_status", aofWrite)
                    .withDetail("rdb_changes_since_last_save", pending)
                    .withDetail("aof_growth_ratio", (double) current / Math.max(base, 1))
                    .build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
```

트래픽이 적은 시간에 `BGSAVE`를 트리거하고 `LASTSAVE` 변화를 기다린 뒤 외부 스토리지로 복사하는 백업 스크립트다.

```bash
#!/bin/bash
set -e
DATA_DIR=/var/lib/redis
BACKUP_DIR=/backup/redis
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

PREV=$(redis-cli LASTSAVE)
redis-cli BGSAVE > /dev/null
while [ "$(redis-cli LASTSAVE)" -eq "$PREV" ]; do sleep 1; done

cp "$DATA_DIR/dump.rdb" "$BACKUP_DIR/dump.rdb.$STAMP"
aws s3 cp "$BACKUP_DIR/dump.rdb.$STAMP" "s3://my-redis-backup/$STAMP/"
find "$BACKUP_DIR" -name 'dump.rdb.*' -mtime +30 -delete
```

## 실무에서 걸리는 지점

- **fork 중 메모리 급증** — ==쓰기가 폭증하는 대용량 데이터셋에서는 BGSAVE 직후 대부분의 페이지가 복사돼 메모리가 2배 가까이 오르고, fork 자체도 수십 ms에서 수 초까지 메인 스레드를 멈춘다.== `vm.overcommit_memory=1`로 fork 실패를 막고 transparent hugepage를 끈다. 복제 동기화는 `repl-diskless-sync yes`로 디스크를 건너뛴다.
- **디스크 가득 참** — ==`aof_last_write_status`나 `rdb_last_bgsave_status`가 err로 바뀌면 `stop-writes-on-bgsave-error yes`에 따라 Redis가 쓰기 명령을 거부한다.== 디스크 사용량과 두 상태 값을 모니터링한다.
- **rewrite 시점의 부하** — fork와 새 파일 작성이 겹쳐 CPU·디스크 I/O를 크게 쓴다. `no-appendfsync-on-rewrite yes`로 rewrite 중 fsync를 미루면 지연은 줄지만 그 구간의 손실 폭이 커진다. 피크를 피하도록 threshold를 조정한다.
- **RDB만 빈번히 찍는 함정** — ==짧은 주기 RDB는 fork 비용이 계속 쌓여 오히려 AOF everysec보다 부담이 클 수 있다.== 손실 폭을 줄이려면 RDB 주기를 당기기보다 AOF를 켠다.
- **로컬 디스크 백업과 손상 복구** — 영속화 파일이 로컬에만 있으면 디스크 고장이 곧 영구 손실이므로 원격 스토리지로 자동 백업한다. ==`redis-check-aof --fix`는 손상 지점 이후를 잘라내므로 백업 없이 실행하면 그 이후 데이터를 잃는다.== 영속화는 재시작 대응, 복제는 노드 장애 대응이므로 둘을 함께 쓴다.

## 관련 글

- [Replication과 Sentinel](/notes/redis/replication-sentinel/)
- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
