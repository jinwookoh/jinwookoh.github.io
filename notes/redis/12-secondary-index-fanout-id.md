---
title: "Secondary Index·Fanout·분산 ID"
series: redis
part: "패턴"
order: 12
summary: "키-값 모델에서 속성 조회·팔로워 피드·충돌 없는 ID를 자료구조 조합으로 풀어내는 세 가지 패턴"
tags: [Redis, Secondary Index, Fanout, Snowflake, UUID]
sources: [data-infra/2026-05-17-redis-pattern-indexes.md, data-infra/2026-05-17-redis-pattern-twitter-clone.md, data-infra/2026-05-26-distributed-unique-id.md]
updated: 2026-08-29
---

Redis는 키로만 값을 찾는다. 가격이 10만 원 미만인 상품, 팔로우한 사람들이 올린 최근 글처럼 키가 아닌 속성으로 조회하려면 RDB의 `CREATE INDEX`에 해당하는 구조를 애플리케이션이 직접 만들어 유지해야 한다. 소셜 피드는 여기에 한 번의 쓰기를 수만 명의 읽기 뷰에 반영하는 팬아웃 문제가 얹히고, 데이터를 샤딩하는 순간 `auto_increment`가 샤드마다 독립적으로 발급돼 ID가 충돌한다. 세 문제 모두 키-값 모델 위에 관계형 편의 기능을 재구성하는 일이다.

## 핵심 개념

### Secondary Index

쿼리 형태에 따라 자료구조를 고른다. 범위·정렬·페이징은 Sorted Set(score=값, member=ID)에 `ZRANGE BYSCORE`, 카테고리·태그 같은 이산 값 필터는 값을 키에 넣은 Set, 문자열 prefix는 score를 0으로 둔 Sorted Set에 `ZRANGE BYLEX`, 좌표 반경은 Sorted Set 위에 geohash를 얹은 `GEOSEARCH`를 쓴다.

복합 조건은 집합 연산으로 조립한다. `AND`는 `SINTER`, `OR`는 `SUNION`, `AND NOT`은 `SDIFF`다. 범위와 필터가 섞이면 단일 명령으로 끝나지 않는다. 두 구조를 각각 읽어 애플리케이션에서 교집합을 잡거나, 필터 Set을 score 0인 Sorted Set으로도 유지해 `ZINTERSTORE WEIGHTS 1 0`으로 합치거나, Lua로 처리한다.

인덱스 유지는 전적으로 애플리케이션 책임이다. Pipelining은 왕복을 줄이지만 기존 값을 읽고 옮기는 조건부 로직이 별도 호출로 빠져 레이스가 생긴다. Lua는 읽기와 쓰기를 원자적으로 묶되 Cluster에서 모든 키가 같은 슬롯에 있어야 한다. 비동기 워커는 쓰기가 빠른 대신 결과적 일관성을 받아들여야 한다.

### Fanout

소셜 서비스는 프로필과 글 본문을 Hash, 팔로우 관계를 양방향 Set(`following:{uid}`, `followers:{uid}`), 타임라인을 score=timestamp인 Sorted Set으로 둔다. 팔로우 한 건은 Set 두 개를 함께 갱신하므로 `MULTI/EXEC` 또는 Lua로 묶는다.

글을 팔로워에게 전달하는 방식은 둘이다. Fanout-on-Write는 작성 시 팔로워 전원의 `home_timeline`에 `ZADD`해 두므로 피드 조회가 `ZRANGE REV` 한 번으로 끝나지만 쓰기가 팔로워 수만큼 늘어난다. Fanout-on-Read는 자기 `user_timeline`에만 쓰고 조회 시 팔로잉 N명의 타임라인을 읽어 merge하므로 쓰기는 가볍고 읽기가 비싸다. 팔로워 5,000만 명인 계정이 글 하나에 5,000만 번 `ZADD`를 하는 것은 현실적이지 않으므로, 임계치 미만 계정은 Push하고 그 이상은 Push를 생략한 뒤 조회 시 셀럽 계정만 Pull해서 merge하는 Hybrid가 실서비스의 표준이다.

### 분산 ID

UUID v4는 128비트 랜덤 값이라 중앙 조율 없이 생성할 수 있지만 시간 순서가 없어 B-tree 인덱스의 임의 위치에 삽입되며 page split을 일으키고, 16바이트라 `bigint`의 두 배 무게가 인덱스와 외래 키마다 누적된다. UUID v7은 상위 비트를 타임스탬프로 채워 정렬 문제를 줄였으나 크기는 그대로다.

Snowflake는 64비트 정수를 부호 1비트, 밀리초 타임스탬프 41비트(약 69년), 워커 ID 10비트(1,024대), 시퀀스 12비트(1ms당 4,096개)로 나눈다. 타임스탬프가 상위 비트라 시간순 정렬이 보장되고 8바이트라 인덱스 친화적이다. UUID의 무충돌성과 `auto_increment`의 정렬성을 동시에 얻는다.

## 코드

가격 인덱스와 카테고리 인덱스를 원본 Hash와 함께 갱신하는 서비스. 카테고리 이동은 읽기-쓰기가 섞이므로 Lua로 원자성을 확보하고, 키에 해시 태그를 붙여 Cluster에서도 같은 슬롯에 둔다.

```java
@Service
@RequiredArgsConstructor
public class ProductIndexService {

    private final StringRedisTemplate redis;

    private static final RedisScript<Long> UPDATE = RedisScript.of("""
        local pid = ARGV[1]
        local oldCat = redis.call('HGET', KEYS[1], 'category')
        redis.call('HSET', KEYS[1], 'price', ARGV[2], 'category', ARGV[3])
        redis.call('ZADD', KEYS[2], ARGV[2], pid)
        if oldCat and oldCat ~= ARGV[3] then
            redis.call('SREM', KEYS[3] .. oldCat, pid)
        end
        redis.call('SADD', KEYS[3] .. ARGV[3], pid)
        return 1
        """, Long.class);

    public void update(long pid, long price, String category) {
        redis.execute(UPDATE,
            List.of("product:{idx}:" + pid, "products:{idx}:by_price", "products:{idx}:category:"),
            String.valueOf(pid), String.valueOf(price), category);
    }

    public Set<String> electronicsInRange(long min, long max) {
        Set<String> inCategory = redis.opsForSet().members("products:{idx}:category:electronics");
        Set<String> inRange = redis.opsForZSet().rangeByScore("products:{idx}:by_price", min, max);
        inRange.retainAll(inCategory);
        return inRange;
    }
}
```

Hybrid 팬아웃. 글 작성 시 팔로워 수가 임계치 미만일 때만 Push하고, 피드 조회 시 Push된 항목과 셀럽 계정의 타임라인을 merge한다.

```java
@Service
@RequiredArgsConstructor
public class TimelineService {

    private static final long CELEB_THRESHOLD = 100_000;
    private static final int HOME_LIMIT = 800;

    private final StringRedisTemplate redis;

    public void post(long uid, long tid, long ts) {
        redis.opsForZSet().add("user_timeline:" + uid, String.valueOf(tid), ts);
        Long followers = redis.opsForSet().size("followers:" + uid);
        if (followers == null || followers >= CELEB_THRESHOLD) {
            return;
        }
        Set<String> fids = redis.opsForSet().members("followers:" + uid);
        redis.executePipelined((RedisCallback<Object>) conn -> {
            for (String fid : fids) {
                byte[] key = ("home_timeline:" + fid).getBytes(StandardCharsets.UTF_8);
                conn.zSetCommands().zAdd(key, ts, String.valueOf(tid).getBytes(StandardCharsets.UTF_8));
                conn.zSetCommands().zRemRange(key, 0, -HOME_LIMIT - 1);
            }
            return null;
        });
    }

    public List<String> home(long uid, int limit) {
        var ops = redis.opsForZSet();
        Set<ZSetOperations.TypedTuple<String>> pushed =
            ops.reverseRangeWithScores("home_timeline:" + uid, 0, limit - 1);
        Set<String> celebs = redis.opsForSet().members("following:" + uid).stream()
            .filter(f -> Boolean.TRUE.equals(redis.opsForSet().isMember("celebs", f)))
            .collect(Collectors.toSet());
        List<ZSetOperations.TypedTuple<String>> merged = new ArrayList<>(pushed);
        for (String c : celebs) {
            merged.addAll(ops.reverseRangeWithScores("user_timeline:" + c, 0, limit - 1));
        }
        return merged.stream()
            .sorted(Comparator.comparing(ZSetOperations.TypedTuple<String>::getScore).reversed())
            .map(ZSetOperations.TypedTuple::getValue)
            .distinct()
            .limit(limit)
            .toList();
    }
}
```

Snowflake ID 생성기. 시계 역행을 감지하면 예외를 던지고, 같은 밀리초 안에서 시퀀스가 고갈되면 다음 밀리초까지 대기한다.

```java
public final class SnowflakeIdGenerator {

    private static final long EPOCH = 1_700_000_000_000L;
    private static final long WORKER_BITS = 10;
    private static final long SEQUENCE_BITS = 12;
    private static final long MAX_SEQUENCE = (1L << SEQUENCE_BITS) - 1;

    private final long workerId;
    private long lastTs = -1L;
    private long sequence = 0L;

    public SnowflakeIdGenerator(long workerId) {
        if (workerId < 0 || workerId >= (1L << WORKER_BITS)) {
            throw new IllegalArgumentException("workerId out of range: " + workerId);
        }
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long ts = System.currentTimeMillis();
        if (ts < lastTs) {
            throw new IllegalStateException("clock moved backwards by " + (lastTs - ts) + "ms");
        }
        if (ts == lastTs) {
            sequence = (sequence + 1) & MAX_SEQUENCE;
            if (sequence == 0) {
                while ((ts = System.currentTimeMillis()) <= lastTs) { }
            }
        } else {
            sequence = 0;
        }
        lastTs = ts;
        return ((ts - EPOCH) << (WORKER_BITS + SEQUENCE_BITS))
            | (workerId << SEQUENCE_BITS)
            | sequence;
    }
}
```

## 실무에서 걸리는 지점

- **인덱스 갱신 누락과 CROSSSLOT.** 원본만 바꾸고 인덱스를 빠뜨리면 조회 결과가 조용히 틀어진다. 갱신 경로를 한 메서드로 모으고, Cluster에서는 해시 태그로 원본·인덱스를 같은 슬롯에 묶지 않으면 Lua와 `MULTI`가 CROSSSLOT 오류로 실패한다.
- **큰 Set과 `SMEMBERS`.** 팔로워 Set이 수십만 멤버로 커지면 `SMEMBERS` 한 번이 이벤트 루프를 붙잡는다. `SSCAN`으로 나눠 읽고, 집합 연산 결과가 클 때는 `SINTERCARD`로 카디널리티만 먼저 확인한다.
- **타임라인 정리 비용.** `home_timeline`은 `ZREMRANGEBYRANK`로 최근 N개만 유지하지 않으면 무한히 자란다. 언팔로우 후 남은 글과 삭제된 글은 팔로워 전원의 타임라인에서 빼야 하므로 팬아웃의 역연산 비용이 든다.
- **셀럽 Hot Key.** 임계치 이상 계정의 `user_timeline`은 피드 조회마다 Pull되어 한 슬롯에 요청이 집중된다. 로컬 캐시나 짧은 TTL 복제본으로 읽기를 분산한다.
- **Snowflake 시계와 워커 ID.** NTP 보정으로 시각이 뒤로 가면 예외 또는 대기로 막고, 워커 ID는 배포 설정·DB 등록·Redis `SET NX` 같은 유일 배정 체계로 관리한다. Sorted Set score는 double이라 2^53을 넘는 ID를 score로 쓰면 정밀도가 깨지므로 ID는 member에, 시각은 score에 둔다.

## 관련 글

- [Sorted Set — 랭킹과 Rate Limiter](/notes/redis/sorted-set/)
- [Lua Scripting과 Functions](/notes/redis/lua-scripting-functions/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
