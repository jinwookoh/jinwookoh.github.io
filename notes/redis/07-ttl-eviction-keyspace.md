---
title: "TTL·Eviction·Keyspace Notification"
series: redis
part: "명령과 스크립트"
order: 7
summary: "키 수명은 TTL, 메모리 한계는 maxmemory-policy, 만료 후속 처리는 Keyspace Notification이 맡되 각각의 정확성 한계를 안다"
tags: [Redis, TTL, Eviction, maxmemory-policy, Keyspace Notifications]
sources: [data-infra/2026-05-17-redis-keyspace-expire.md, data-infra/2026-05-17-redis-keyspace-notifications.md, 2026-05-02-redis-commands.md]
updated: 2026-08-29
---

Redis는 메모리 위에서 동작하므로 세션·OTP·응답 캐시처럼 수명이 있는 데이터에 만료를 걸지 않으면 메모리 고갈로 서비스가 멈춘다. 만료를 걸어도 메모리가 가득 찼을 때 어떤 키를 버릴지 정해두지 않으면 기본값인 `noeviction`이 모든 쓰기를 거부한다. 반대로 세션 만료 시 통계를 남기는 식으로 키가 사라진 사실을 애플리케이션이 알아야 하는 경우도 있다. 이 세 문제를 각각 TTL 명령, `maxmemory-policy`, Keyspace Notification이 담당한다.

## 핵심 개념

### TTL 명령

만료 설정은 단위와 기준의 조합으로 네 개다. `EXPIRE`는 초 단위 상대 시간, `PEXPIRE`는 밀리초 상대, `EXPIREAT`·`PEXPIREAT`은 Unix 타임스탬프 기준 절대 시각을 받는다. 조회는 `TTL`·`PTTL`(남은 시간)과 `EXPIRETIME`·`PEXPIRETIME`(절대 만료 시각), `PERSIST`는 만료를 제거한다. `TTL` 반환값은 양수(남은 초), `-1`(키는 있으나 만료 없음), `-2`(키 없음)로 갈리며, `-1`과 `-2`를 구분하지 않으면 영구 키에 잘못 만료를 거는 버그가 생긴다. Redis 7부터는 `NX`·`XX`·`GT`·`LT` 옵션으로 기존 만료와의 관계를 조건으로 걸 수 있다.

실무에서는 `SET key value EX 3600`처럼 저장과 만료를 한 명령으로 묶는다. `SET`과 `EXPIRE`를 따로 부르면 그 사이 장애로 만료 없는 키가 남을 수 있고 왕복도 두 번이다. 옵션은 `EX`·`PX`·`EXAT`·`PXAT`·`KEEPTTL`이며, `GET`은 TTL을 갱신하지 않으므로 접근 시 만료를 연장하려면 `GETEX`를 쓴다.

### 만료 처리 방식

만료 시각이 지나도 키가 그 순간 삭제되지는 않는다. Lazy expiration은 접근 시점에 만료를 확인해 삭제하고 nil을 돌려준다. Active expiration은 서버가 주기적으로 만료가 설정된 키 일부를 표본 추출해 지우고, 표본의 만료 비율이 높으면 반복한다. 따라서 접근되지 않는 만료 키가 잠시 남을 수 있고, 만료 이벤트도 실제 시각보다 늦게 발생한다.

### maxmemory와 eviction policy

`maxmemory`에 도달하면 `maxmemory-policy`가 정한 규칙으로 키를 제거한다. 이름은 대상 범위와 선택 기준의 조합이다.

| 정책 | 대상 | 기준 |
|:---|:---|:---|
| `noeviction` | 제거 안 함 | 쓰기 명령 에러 (기본값) |
| `allkeys-lru` / `allkeys-lfu` / `allkeys-random` | 모든 키 | 최근 접근 / 접근 빈도 / 무작위 |
| `volatile-lru` / `volatile-lfu` / `volatile-random` | 만료가 설정된 키 | 최근 접근 / 접근 빈도 / 무작위 |
| `volatile-ttl` | 만료가 설정된 키 | 만료 시각이 가까운 순 |

LRU는 마지막 접근 시각, LFU는 접근 빈도를 보는 근사 알고리즘이며, 빈도 편차가 큰 워크로드가 아니면 LRU가 기본 선택이다. 순수 캐시는 `allkeys-lru`, 만료 있는 세션과 영구 데이터를 섞은 인스턴스는 `volatile-lru`, 유실이 허용되지 않는 저장소는 `noeviction`을 두고 쓰기 에러를 알람으로 받는다.

### Keyspace Notification

키에 일어난 이벤트를 Pub/Sub으로 발행하는 기능으로, 기본값은 꺼져 있다. 채널은 두 종류다. `__keyspace@<db>__:<key>`는 한 키의 모든 이벤트를 받고 본문은 이벤트 이름이다. `__keyevent@<db>__:<event>`는 한 이벤트가 일어난 모든 키를 받고 본문은 키 이름이다. 세션 만료 처리처럼 이벤트 한 종류를 넓게 잡는 자리에는 `__keyevent__`를 쓴다.

`notify-keyspace-events`는 플래그 조합이다. `K`·`E`는 각 채널 발행을 켜며 둘 중 하나는 필수다. `g`는 범용 명령, `$lshzx`는 타입별 명령, `e`는 만료, `t`는 eviction, `A`는 `g$lshzxet`의 별칭이다. 만료 이벤트만 받는 `Ex`가 가장 흔한 조합이고, `KEA`는 개발 환경 전용이다.

## 코드

`StringRedisTemplate`으로 만료 있는 저장, 접근 시 만료 연장, 남은 TTL 조회를 처리하는 세션 저장소다.

```java
import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class SessionStore {

    private static final Duration SESSION_TTL = Duration.ofHours(1);
    private final StringRedisTemplate redis;

    public SessionStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public void save(String sessionId, String payload) {
        // SET session:{id} payload EX 3600
        redis.opsForValue().set("session:" + sessionId, payload, SESSION_TTL);
    }

    public String touch(String sessionId) {
        // GETEX — 조회하면서 만료를 1시간으로 재설정
        return redis.opsForValue().getAndExpire("session:" + sessionId, SESSION_TTL);
    }

    public long remainingSeconds(String sessionId) {
        Long ttl = redis.getExpire("session:" + sessionId);
        // -2: 키 없음, -1: 만료 없음
        return ttl == null ? -2 : ttl;
    }
}
```

`notify-keyspace-events Ex`가 켜진 서버에서 `__keyevent@0__:expired`를 구독해 세션 만료 후속 처리를 실행하는 리스너다.

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

@Configuration
public class ExpiredKeyListenerConfig {

    @Bean
    public RedisMessageListenerContainer keyEventContainer(
            RedisConnectionFactory connectionFactory,
            SessionExpiredHandler handler) {
        var container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(handler, new PatternTopic("__keyevent@0__:expired"));
        return container;
    }
}

@Component
class SessionExpiredHandler implements MessageListener {

    private final SessionStatsService stats;

    SessionExpiredHandler(SessionStatsService stats) {
        this.stats = stats;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String key = new String(message.getBody()); // 만료된 키 이름
        if (key.startsWith("session:")) {
            stats.recordSessionEnd(key.substring("session:".length()));
        }
    }
}
```

재시작 없이 메모리 한계·정책·알림 플래그를 바꾸는 명령이다. 영구 반영은 `redis.conf` 수정 또는 `CONFIG REWRITE`로 한다.

```bash
CONFIG SET maxmemory 4gb
CONFIG SET maxmemory-policy allkeys-lru
CONFIG SET notify-keyspace-events Exe
INFO memory   # used_memory · used_memory_rss · mem_fragmentation_ratio
```

## 실무에서 걸리는 지점

- **volatile 정책과 만료 없는 키.** `volatile-*`는 만료가 설정된 키만 제거하므로 만료 없는 키로 메모리가 차면 `noeviction`과 똑같이 쓰기가 실패한다. TTL을 빠뜨린 코드 한 곳이 인스턴스 전체의 쓰기 장애가 된다.
- **만료 이벤트의 지연.** 이벤트는 Redis가 키를 실제로 삭제하는 시점에 발생한다. 정확한 시각에 실행되어야 하는 작업은 Sorted Set 기반 지연 큐나 별도 스케줄러에 맡긴다.
- **Pub/Sub의 at-most-once.** 구독자가 끊겨 있는 동안의 이벤트는 보관되지 않는다. 리스너 재배포 중 만료된 세션은 후속 처리를 받지 못하므로, 누락이 허용되지 않으면 애플리케이션이 Stream에 상태 변화를 직접 기록하는 쪽이 안전하다.
- **플래그 범위와 CPU.** 모든 명령에 이벤트를 발행하면 쓰기 처리량이 떨어진다. 필요한 플래그만 켜고, `K`나 `E` 누락으로 이벤트가 오지 않는 설정 실수도 점검한다.

## 관련 글

- [String·Hash — 값 캐싱과 객체 저장](/notes/redis/string-hash/)
- [Stream·Pub/Sub — 영속 로그와 실시간 전파](/notes/redis/stream-pubsub/)
- [캐싱 패턴 — Cache-Aside·스탬피드·Hot Key](/notes/redis/caching-patterns-stampede/)
