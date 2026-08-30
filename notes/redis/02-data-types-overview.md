---
title: "데이터 타입 개관"
series: redis
part: "데이터 타입"
order: 2
summary: "Redis 데이터 타입 13종의 용도를 매핑하고, 읽기·쓰기 패턴에 따라 어떤 타입을 골라야 하는지 정리한다."
tags: [Redis, 데이터 타입, Sorted Set, HyperLogLog, Stream]
sources: [data-infra/2026-05-17-redis-data-types-overview.md, 2026-05-02-redis-data-structures.md]
updated: 2026-08-29
---

Redis를 단순 키-값 캐시로만 쓰면 모든 데이터를 JSON 문자열로 직렬화해 String에 넣게 된다. 이 방식은 객체의 필드 하나를 바꾸려 해도 전체를 읽어 역직렬화하고 다시 쓰는 왕복이 필요하고, 랭킹이나 중복 제거처럼 서버 쪽 연산이 필요한 작업은 애플리케이션이 전부 떠안는다. ==Redis가 제공하는 자료구조를 용도에 맞게 고르면 이 연산을 서버 안에서 원자적으로 끝낼 수 있다.==

## 핵심 개념

Redis의 모든 데이터는 키 하나에 값 하나가 대응하는 구조이고, 데이터 타입은 그 값 자리에 들어가는 자료구조의 종류다. 현재 공식적으로 분류되는 타입은 13종이며, 실무에서 대부분의 작업은 앞의 6종 안에서 끝난다.

| 타입 | 자료구조 | 주 용도 | 핵심 연산 비용 |
|:---|:---|:---|:---|
| String | 바이트 열 (최대 512MB) | 캐시·카운터·세션 | O(1) |
| Hash | 필드-값 맵 | 객체 한 개 통째 저장 | 필드 접근 O(1) |
| List | 이중 연결 리스트 | 큐·최근 활동·작업 대기열 | 양 끝 O(1), 중간 O(N) |
| Set | 중복 없는 집합 | 태그·좋아요·블랙리스트 | 멤버십 O(1) |
| Sorted Set | 점수 기반 정렬 집합 | 랭킹·시간순 정렬·Rate Limiter | O(log N) |
| Stream | 추가 전용 로그 | 이벤트 로그·경량 메시지 큐 | 추가 O(1) |

String은 텍스트·정수·부동소수점·바이너리를 모두 담는다. 내용이 정수면 내부적으로 정수 인코딩을 사용하므로 `INCR`·`DECR`이 빠르고, 단일 스레드 명령 실행 모델 덕분에 동시에 1,000개의 `INCR`이 들어와도 정확히 1,000 증가한다. `SET key value NX`는 키가 없을 때만 저장하므로 분산 락의 기본 재료가 된다.

Hash는 하나의 키 아래 여러 필드-값 쌍을 둔다. 중첩 구조나 배열은 지원하지 않으며, 값은 항상 문자열이다. `HSET`으로 필드 하나만 갱신하고 `HINCRBY`로 특정 필드를 원자적으로 증감할 수 있다는 점이 JSON String 저장 방식과 갈리는 지점이다.

List는 배열이 아니라 이중 연결 리스트다. `LPUSH`·`RPUSH`·`LPOP`·`RPOP`은 O(1)이지만 `LINDEX`·`LSET` 같은 중간 접근은 O(N)이므로 Java의 `ArrayList`처럼 인덱스로 순회하면 안 된다.
Set은 순서 없는 고유 문자열 집합이다. `SISMEMBER`가 O(1)이라 데이터가 1억 건이어도 존재 확인 비용이 같고, `SINTER`·`SUNION`·`SDIFF`로 집합 연산을 서버에서 처리한다.

Sorted Set은 Set의 각 멤버에 부동소수점 점수를 붙여 점수 순으로 유지하는 구조다. 추가·순위 조회·범위 조회가 O(log N)이며, `ZRANGE key 0 9 REV WITHSCORES` 한 번으로 상위 10개가 나온다. Redis 6.2부터 `ZADD`에 `GT`·`LT` 옵션이 있어 최고점만 갱신하는 조건부 쓰기가 가능하다.

Stream은 타임스탬프 기반 ID(`1640000000000-0` 형식)를 가진 엔트리를 시간순으로 추가만 하는 로그다. 읽어도 엔트리가 삭제되지 않고, 컨슈머마다 자기 오프셋을 관리하며, Consumer Group으로 여러 소비자가 메시지를 분할 처리한다. Pub/Sub은 구독 중인 클라이언트에게만 전달하고 과거 메시지를 남기지 않으므로 재처리가 필요하면 Stream, 놓쳐도 되는 실시간 알림이면 Pub/Sub을 쓴다.

나머지 7종은 특정 문제에서만 등장한다. Bitmap은 String 위의 비트 연산으로 사용자 1억 명의 일별 접속 여부를 12.5MB에 담고, Bitfield는 작은 정수 여러 개를 비트 단위로 묶어 저장하며, Geospatial은 위경도 기반 반경 검색을 처리한다. HyperLogLog·Bloom Filter 같은 Probabilistic 타입은 정확도를 일부 포기하고 메모리를 극단적으로 줄이는 구조로, HyperLogLog는 최대 12KB로 수백만 개의 고유 원소 수를 약 0.81% 표준 오차로 추정한다. JSON·Time Series·Vector Set은 Redis 8부터 기본 배포판에 포함된다.

타입 선택은 값이 하나인지 컬렉션인지, 컬렉션이면 중복 허용과 순서 의미가 있는지, 여러 필드를 가진 객체인지 시간순 이벤트인지 순서로 좁힌다. ==같은 카운터를 `INCR`·`HINCRBY`·`ZINCRBY`로 모두 만들 수 있으므로 최종 기준은 그 값을 어떤 패턴으로 읽고 쓰는가다.==

## 코드

Spring Boot 3.x의 `StringRedisTemplate`으로 String 카운터, Hash 객체 저장, Sorted Set 랭킹을 한 서비스에서 사용하는 예제다.

```java
import java.util.Map;
import java.util.Set;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.stereotype.Service;

@Service
public class ItemStatsService {

    private final StringRedisTemplate redis;

    public ItemStatsService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    // String: 조회수 카운터. INCR은 원자적이다.
    public long increaseView(String itemId) {
        Long v = redis.opsForValue().increment("item:views:" + itemId);
        return v == null ? 0 : v;
    }

    // Hash: 객체 한 개를 필드 단위로 저장하고 필드 하나만 증감한다.
    public void saveItem(String itemId, String name, long price) {
        redis.opsForHash().putAll("item:" + itemId,
                Map.of("name", name, "price", String.valueOf(price)));
    }

    public long like(String userId, String itemId) {
        redis.opsForSet().add("user:likes:" + userId, itemId);
        Long likes = redis.opsForHash().increment("item:" + itemId, "likes", 1);
        // Sorted Set: 좋아요 수를 점수로 넣어 랭킹을 유지한다.
        redis.opsForZSet().add("item:rank", itemId, likes);
        return likes;
    }

    public Set<ZSetOperations.TypedTuple<String>> top(int n) {
        return redis.opsForZSet().reverseRangeWithScores("item:rank", 0, n - 1);
    }
}
```

HyperLogLog로 같은 사용자의 반복 조회를 걸러내고, 새 사용자일 때만 Hash 카운터를 올리는 예제다.

```java
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class UniqueViewService {

    private final StringRedisTemplate redis;

    public UniqueViewService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    // PFADD는 내부 상태가 바뀌었을 때만 1을 반환한다.
    public void view(String itemId, String userId) {
        Long changed = redis.opsForHyperLogLog().add("item:uv:" + itemId, userId);
        if (changed != null && changed > 0) {
            redis.opsForHash().increment("item:" + itemId, "uniqueViews", 1);
        }
    }

    // HGETALL은 키가 없어도 null이 아닌 빈 맵을 돌려준다.
    public Map<Object, Object> findItem(String itemId) {
        Map<Object, Object> entries = redis.opsForHash().entries("item:" + itemId);
        return entries.isEmpty() ? null : entries;
    }
}
```

## 실무에서 걸리는 지점

- ==`HGETALL`은 키가 없을 때 null이 아니라 빈 컬렉션을 반환한다.== null 검사만으로는 "존재하지 않는 객체"를 구분할 수 없으므로 반드시 `isEmpty()`로 확인해야 한다.
- `LTRIM`은 지정 범위 밖의 요소를 즉시 영구 삭제한다. 최근 N개만 유지하는 캡 리스트에는 유용하지만 범위를 잘못 주면 복구할 수 없으므로 `LLEN`으로 길이를 확인한 뒤 적용한다.
- Sorted Set의 점수는 배정밀도 부동소수점이다. 2^53을 넘는 정수 ID를 점수로 쓰면 정밀도가 손실되어 복원이 어긋난다. 큰 ID는 멤버 쪽에 두거나 별도 Hash로 매핑한다.
- HyperLogLog는 추정값이다. 결제 건수나 재고처럼 정확성이 요구되는 값에는 쓰지 않고, UV·DAU 같은 통계 지표에 한정한다.
- `XREAD BLOCK`에 매번 `$`를 넘기면 처리 중에 도착한 메시지를 건너뛴다. 최초 호출에만 `$`를 쓰고 이후에는 마지막으로 처리한 ID를 넘기거나, 처음부터 Consumer Group과 ACK를 사용한다.

## 관련 글

- [Redis란 — 역할 분담과 CLI 첫걸음](/notes/redis/what-is-redis/)
- [String·Hash — 값 캐싱과 객체 저장](/notes/redis/string-hash/)
- [Sorted Set — 랭킹과 Rate Limiter](/notes/redis/sorted-set/)
