---
title: "Sorted Set — 랭킹과 Rate Limiter"
series: redis
part: "데이터 타입"
order: 5
summary: "score가 붙은 집합 하나로 Top N 랭킹·순위 조회·Sliding Window Rate Limiter·우선순위 큐를 O(log N)에 처리한다"
tags: [Redis, Sorted Set, ZADD, Rate Limiter, Leaderboard]
sources: [data-infra/2026-05-17-redis-sorted-sets.md]
updated: 2026-08-29
---

점수 순으로 정렬된 목록에서 "내 순위"를 구하려면 관계형 DB에서는 `SELECT COUNT(*) WHERE score > :my_score` 같은 쿼리를 매번 실행해야 한다. 인덱스가 있어도 ms 단위이고, 점수가 초당 수천 번 갱신되는 리더보드나 인기 검색어라면 쓰기와 읽기가 서로를 잠그며 병목이 된다. "최근 60초 동안 몇 번 호출했는가"를 판정하는 rate limiter도 시간 범위 기준의 개수 세기와 오래된 기록 삭제를 원자적으로 처리할 저장소가 필요하다. Redis Sorted Set은 멤버마다 score를 붙여 항상 정렬 상태를 유지하는 자료구조로, 이 두 문제를 O(log N) 연산으로 해결한다.

## 핵심 개념

Sorted Set은 Set의 정렬판이 아니라 `(member, score)` 쌍의 컬렉션이다. member는 중복이 없고, score는 double 값으로 갱신할 수 있다. 조회는 순위(rank)·점수 범위(score)·사전순(lex) 세 축으로 가능하며, score가 같은 멤버는 사전순으로 정렬된다.

내부 구조는 크기에 따라 자동 전환된다. 작은 집합은 listpack으로 저장하고, `zset-max-listpack-entries`(기본 128)·`zset-max-listpack-value`(기본 64)를 넘으면 skiplist와 hashtable을 결합한 구조로 바뀐다. hashtable이 member→score 조회를 O(1)로, skiplist가 순위·범위 조회를 O(log N)으로 담당한다.

자주 쓰는 명령은 `ZADD`(추가·갱신, `NX·XX·GT·LT·CH·INCR` 옵션), `ZRANGE`(범위 조회), `ZRANK`/`ZREVRANK`(0-based 순위), `ZSCORE`, `ZINCRBY`(원자적 증감), `ZCARD`, `ZPOPMIN`/`ZPOPMAX`, `ZREMRANGEBYSCORE`(점수 범위 삭제)다. `ZSCORE`·`ZCARD`는 O(1), 나머지는 O(log N), 범위 연산은 반환 개수 M이 더해져 O(log N + M)이다.

Redis 6.2부터 `ZRANGE`가 `REV`·`BYSCORE`·`BYLEX`·`LIMIT` 옵션을 흡수했고 `ZREVRANGE`·`ZRANGEBYSCORE`·`ZRANGEBYLEX`는 deprecated 상태다. 점수 범위에서 `(`는 경계 제외, `-inf`·`+inf`는 무한대다.

```bash
> ZADD board 100 "A" 200 "B" 150 "C"
> ZRANGE board 0 9 REV WITHSCORES        # Top 10, 내림차순
> ZRANGE board (150 +inf BYSCORE         # 150 초과
> ZREVRANK board "C"                     # 1
> ZINCRBY board 50 "A"                   # 150
```

여러 Sorted Set을 합칠 때는 `ZUNIONSTORE`·`ZINTERSTORE`를 쓴다. 같은 member의 score는 기본 합산이며 `AGGREGATE MIN|MAX`와 `WEIGHTS`로 조정한다. 시간대별 키를 묶어 "최근 3시간 trending"을 만드는 데 쓴다.

이 구조 위에서 네 가지 패턴이 반복된다. 랭킹은 `ZADD` + `ZRANGE REV` + `ZREVRANK`, trending은 `ZINCRBY` + 시간 prefix 키 + `EXPIRE`, sliding window rate limiter는 score에 timestamp를 넣고 `ZREMRANGEBYSCORE` + `ZCARD`, 우선순위 큐와 지연 큐는 score에 우선순위 또는 실행 예정 시각을 넣고 `ZPOPMIN` 또는 `ZRANGE BYSCORE`로 꺼낸다.

## 코드

Spring Data Redis의 `ZSetOperations`로 리더보드를 감싼 서비스. 점수 갱신·Top N·내 순위·주변 경쟁자 조회를 담당한다.

```java
package app.ranking;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Set;

@Service
public class LeaderboardService {

    private static final String KEY = "leaderboard";
    private final ZSetOperations<String, String> zset;

    public LeaderboardService(StringRedisTemplate redis) {
        this.zset = redis.opsForZSet();
    }

    public double addScore(String userId, long delta) {
        Double score = zset.incrementScore(KEY, userId, delta);   // ZINCRBY
        return score == null ? 0 : score;
    }

    public List<RankEntry> topN(int n) {
        Set<ZSetOperations.TypedTuple<String>> tuples =
                zset.reverseRangeWithScores(KEY, 0, n - 1);       // ZRANGE REV WITHSCORES
        return tuples == null ? List.of() : tuples.stream()
                .map(t -> new RankEntry(t.getValue(), t.getScore()))
                .toList();
    }

    public long rankOf(String userId) {
        Long rank = zset.reverseRank(KEY, userId);                // ZREVRANK, 0-based
        return rank == null ? -1 : rank + 1;
    }

    public Set<String> neighbors(String userId, double margin) {
        Double my = zset.score(KEY, userId);                      // ZSCORE
        if (my == null) return Set.of();
        return zset.rangeByScore(KEY, my - margin, my + margin);  // ZRANGE BYSCORE
    }

    public record RankEntry(String userId, Double score) {}
}
```

Sliding window rate limiter. 삭제·개수 확인·추가·TTL 설정을 Lua 스크립트 하나로 묶어 race condition을 없앤다.

```java
package app.ratelimit;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

@Component
public class SlidingWindowRateLimiter {

    private static final String SCRIPT = """
            local key    = KEYS[1]
            local now    = tonumber(ARGV[1])
            local window = tonumber(ARGV[2])
            local limit  = tonumber(ARGV[3])
            local member = ARGV[4]
            redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
            if redis.call('ZCARD', key) >= limit then
              return 0
            end
            redis.call('ZADD', key, now, member)
            redis.call('PEXPIRE', key, window)
            return 1
            """;

    private final StringRedisTemplate redis;
    private final DefaultRedisScript<Long> script = new DefaultRedisScript<>(SCRIPT, Long.class);

    public SlidingWindowRateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** windowMillis 동안 limit 회까지 허용. 허용 시 true. */
    public boolean tryAcquire(String subject, long windowMillis, int limit) {
        long now = System.currentTimeMillis();
        String member = now + ":" + UUID.randomUUID();
        Long result = redis.execute(script,
                List.of("rate:" + subject),
                String.valueOf(now), String.valueOf(windowMillis),
                String.valueOf(limit), member);
        return result != null && result == 1L;
    }
}
```

위 limiter를 API에 적용하는 `HandlerInterceptor`. 차단 시 429를 반환한다.

```java
package app.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private final SlidingWindowRateLimiter limiter;

    public RateLimitInterceptor(SlidingWindowRateLimiter limiter) {
        this.limiter = limiter;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        String subject = req.getHeader("X-Api-Key") != null
                ? req.getHeader("X-Api-Key") : req.getRemoteAddr();
        if (limiter.tryAcquire(subject, 60_000, 60)) {
            return true;
        }
        res.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        res.setHeader("Retry-After", "60");
        return false;
    }
}
```

## 실무에서 걸리는 지점

- **Rate limiter의 member 충돌.** ==`ZADD key now now`처럼 timestamp를 member로 쓰면 같은 밀리초의 요청이 하나로 합쳐져 카운트가 샌다.== 요청마다 고유 suffix를 붙이고, 다중 인스턴스라면 시계 편차를 피해 `TIME` 명령으로 Redis 시각을 쓴다.
- **Rate limiter 메모리.** 윈도우 안 요청 수만큼 member가 쌓인다. ==분당 1만 회 같은 큰 한도라면 키 하나가 수 MB가 되므로==, 정확도가 덜 중요하면 String 카운터 기반 sliding window counter나 token bucket을 고려한다.
- **동점 처리.** score가 같으면 사전순이므로 "먼저 도달한 사람이 상위"는 자동으로 충족되지 않는다. `score = 점수 × 2^20 + (MAX_TS - timestamp)` 식으로 합성하되, double의 정수 정밀도 한계인 2^53을 넘지 않아야 한다.
- **범위 연산의 M.** `LIMIT` 없이 넓은 범위를 조회하면 반환 개수가 그대로 지연이 되고, 큰 범위 삭제는 단일 스레드를 점유한다. 페이징과 `LIMIT`을 기본으로 둔다.
- **무한히 커지는 trending 키.** 시간 prefix 키에 `EXPIRE`를 걸고, 주기적으로 `ZREMRANGEBYRANK key 0 -1001`로 하위를 잘라 상위 N만 유지한다.
- **Cluster의 집합 연산.** `ZUNIONSTORE`·`ZINTERSTORE`는 모든 키가 같은 슬롯에 있어야 한다. `trending:{search}:12` 같은 hash tag로 맞추지 않으면 CROSSSLOT 오류가 난다.

## 관련 글

- [List·Set — 큐와 집합 연산](/notes/redis/list-set/)
- [Lua Scripting과 Functions](/notes/redis/lua-scripting-functions/)
- [TTL·Eviction·Keyspace Notification](/notes/redis/ttl-eviction-keyspace/)
