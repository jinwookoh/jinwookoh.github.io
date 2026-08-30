---
title: "List·Set — 큐와 집합 연산"
series: redis
part: "데이터 타입"
order: 4
summary: "List는 양 끝 O(1)의 큐, Set은 O(1) 멤버십과 집합 연산 — 언제 어느 쪽을 쓰고 어디서 무너지는가"
tags: [Redis, List, Set, BLPOP, LMOVE, SINTER]
sources: [data-infra/2026-05-17-redis-lists.md, data-infra/2026-05-17-redis-sets.md]
updated: 2026-08-29
---

작업 대기열이나 "최근 본 상품 20개"를 String 하나에 JSON 배열로 직렬화해 두면 항목 하나를 넣고 뺄 때마다 전체를 읽고 다시 쓰게 되고, 워커 여러 개가 동시에 꺼내면 같은 작업을 두 번 처리한다. "이 사용자가 이미 좋아요를 눌렀는가", "두 태그를 모두 가진 글은 무엇인가"를 RDB로 풀면 JOIN 두 번에 인덱스가 있어도 ms 단위다. ==Redis List와 Set은 이 두 부류를 서버 측 원자 연산 한 번으로 처리하는 타입이다.==

## 핵심 개념

**List**는 양방향 링크드 리스트 계열 구조(내부적으로 quicklist·listpack)다. 양 끝 삽입·삭제(`LPUSH`·`RPUSH`·`LPOP`·`RPOP`)가 O(1)이고, 중간 인덱스 접근(`LINDEX`)과 중간 삽입(`LINSERT`)은 O(N)이다. ==Java `ArrayList`와 반대 특성이므로 인덱스 접근이 잦은 용도에는 맞지 않는다.== 명령어 접두사 `L*`은 head, `R*`은 tail을 뜻하며, 큐인지 스택인지는 넣는 쪽과 빼는 쪽의 조합으로 결정된다. 한쪽에서 넣고 반대쪽에서 빼면 FIFO 큐(`RPUSH` + `LPOP`이 관례), 같은 쪽에서 넣고 빼면 LIFO 스택이다. `LRANGE start end`는 팝 없이 범위를 조회하며 end가 포함이라 `0 -1`이 전체다. `LLEN`은 O(1)이다.

큐로 쓸 때 핵심은 blocking 변형이다. `LPOP`은 비어 있으면 즉시 nil을 돌려주므로 워커가 폴링해야 하지만, `BLPOP key [key ...] timeout`은 원소가 들어올 때까지 연결을 대기시키고 가장 오래 기다린 클라이언트 한 곳에만 원자적으로 전달한다. timeout은 초 단위(6.0부터 소수 허용)이고 0은 무한 대기다. 키를 여러 개 지정하면 앞선 키부터 확인하므로 `BLPOP q:high q:low 0` 형태로 단순 우선순위 큐가 된다.

`LMOVE src dst LEFT|RIGHT LEFT|RIGHT`는 한 List에서 꺼내 다른 List에 넣는 동작을 원자적으로 수행한다. 6.2에서 `RPOPLPUSH`를 대체하며 네 가지 방향 조합을 모두 지원하고, `BLMOVE`가 blocking 변형이다. `LTRIM start end`는 범위 밖 원소를 모두 잘라내며 `LPUSH` + `LTRIM 0 N-1` 조합이 "최근 N개만 유지"하는 캡 리스트 패턴이다.

**Set**은 중복 없는 무순서 컬렉션으로 Java `HashSet`과 같은 모델이다. `SADD`는 실제로 추가된 수를 반환해 중복 입력을 무시하고, `SISMEMBER`·`SCARD`는 멤버 수와 무관하게 O(1)이다. `SMEMBERS`는 O(N)이며 반환 순서는 삽입 순서와 무관하게 호출마다 달라질 수 있다. `SPOP`은 임의 멤버를 꺼내 제거한다. 차별점은 집합 연산이다. `SINTER`(교집합)·`SUNION`(합집합)·`SDIFF`(차집합)가 서버에서 한 번에 계산되고, `*STORE` 변형은 결과를 새 키에 저장한다. 내부 인코딩은 모든 멤버가 정수이면 intset, 작은 Set이면 listpack(7.2+), 그 이상은 hashtable로 자동 전환되며 `set-max-*` 설정으로 임계값을 조정한다.

| 기준 | List | Set |
|---|---|---|
| 중복 | 허용 | 불가 |
| 순서 | 삽입 순서 보존 | 없음 |
| 존재 확인 | O(N) | O(1) |
| 대표 용도 | 작업 큐·최근 N개 | 태그·좋아요·중복 제거·추천 |

## 코드

Spring Data Redis(`StringRedisTemplate`) 기준이다. 작업 큐 producer와 at-least-once consumer: `LMOVE`로 처리 중 목록에 옮겨 두고 성공 시 `LREM`으로 제거한다.

```java
@Service
@RequiredArgsConstructor
public class JobQueue {

    private static final String PENDING = "queue:jobs";
    private static final String PROCESSING = "queue:processing";
    private final StringRedisTemplate redis;

    public void enqueue(String jobId) {
        redis.opsForList().rightPush(PENDING, jobId);
    }

    /** 비어 있으면 최대 5초 대기. 반환값 null이면 타임아웃. */
    public String take() {
        return redis.opsForList().move(
                PENDING, ListOperations.Direction.LEFT,
                PROCESSING, ListOperations.Direction.RIGHT,
                Duration.ofSeconds(5));
    }

    public void ack(String jobId) {
        redis.opsForList().remove(PROCESSING, 1, jobId);
    }
}
```

캡 리스트: 사용자 활동을 앞에 넣고 100개로 잘라 무한 증가를 막는다. 두 명령을 파이프라인으로 묶어 왕복을 한 번으로 줄인다.

```java
public void recordActivity(long userId, String event) {
    String key = "activity:" + userId;
    redis.executePipelined((RedisCallback<Object>) conn -> {
        byte[] k = key.getBytes(StandardCharsets.UTF_8);
        conn.listCommands().lPush(k, event.getBytes(StandardCharsets.UTF_8));
        conn.listCommands().lTrim(k, 0, 99);
        return null;
    });
}
```

태그 양방향 인덱스와 교집합 조회: 글마다 태그 Set, 태그마다 글 Set을 두고 `SINTER`로 두 태그를 모두 가진 글을 찾는다.

```java
public void tag(String articleId, String... tags) {
    redis.opsForSet().add("tags:" + articleId, tags);
    for (String t : tags) {
        redis.opsForSet().add("articles:" + t, articleId);
    }
}

public Set<String> articlesWithAll(String... tags) {
    List<String> keys = Arrays.stream(tags).map(t -> "articles:" + t).toList();
    return redis.opsForSet().intersect(keys);
}

public boolean liked(String articleId, long userId) {
    return Boolean.TRUE.equals(
            redis.opsForSet().isMember("likes:" + articleId, String.valueOf(userId)));
}
```

## 실무에서 걸리는 지점

- ==**`LPOP` 큐는 at-most-once다.**== 꺼낸 직후 워커가 죽으면 작업이 사라진다. `LMOVE`로 processing 목록에 보관하면 at-least-once가 되지만 중복 실행이 가능해지므로 작업 처리는 멱등해야 하고, 죽은 워커가 남긴 항목을 processing에서 다시 pending으로 되돌리는 회수 로직이 별도로 필요하다.
- **Blocking 명령은 연결을 점유한다.** `BLPOP`·`BLMOVE`는 대기 중 커넥션을 붙잡으므로 Lettuce의 공유 커넥션이나 작은 풀에서 다른 요청을 막는다. 워커 전용 커넥션을 분리하고, 무한 대기(0) 대신 유한 timeout으로 루프를 돌려 종료 신호를 처리할 수 있게 한다.
- **큰 컬렉션의 O(N) 명령은 서버 전체를 막는다.** Redis는 명령을 단일 스레드로 실행하므로 수십만 원소 List의 `LINDEX`·`LRANGE 0 -1`, 수백만 멤버 Set의 `SMEMBERS`는 다른 요청을 지연시킨다. 전체 조회는 `SSCAN`으로 페이징하고, 인덱스 접근이 잦으면 Sorted Set으로 설계를 바꾼다.
- **집합 연산은 Cluster에서 같은 슬롯을 요구한다.** `SINTER`·`SINTERSTORE` 대상 키가 다른 슬롯에 있으면 CROSSSLOT 오류가 나므로 hash tag(`{article}:...`)로 묶는다. 결과 개수만 필요하면 `SINTERCARD`(7.0+)가 결과 집합을 만들지 않아 가볍다.
- **고유 방문자 카운팅에 Set을 쓰면 메모리가 선형으로 증가한다.** 정수 ID는 intset으로 압축되지만 문자열 ID는 원소당 수십 바이트를 차지한다. 정확한 멤버십 없이 수만 필요하면 HyperLogLog가 12KB 고정으로 근사값을 준다.

## 관련 글

- [데이터 타입 개관](/notes/redis/data-types-overview/)
- [Sorted Set — 랭킹과 Rate Limiter](/notes/redis/sorted-set/)
- [Pipelining·Transaction·WATCH](/notes/redis/pipelining-transactions/)
