---
title: "캐싱 — Look-aside·Write-through·Write-behind"
series: architecture-patterns
part: "데이터"
order: 4
summary: "읽기 부하는 Look-aside로 DB 앞에서 걸러내고, 쓰기 폭주는 유실을 감수할 수 있는 데이터에 한해 Write-behind로 모아서 반영한다."
tags: [Cache-aside, Write-through, Write-behind, Redis, Spring Cache]
sources: [https://jinwookoh.tistory.com/235]
updated: 2026-09-06
---

상품 상세나 게시글 본문처럼 거의 바뀌지 않는 데이터를 요청마다 DB에서 읽으면 디스크 I/O와 커넥션이 그만큼 소모되고, 트래픽이 늘수록 응답 지연이 DB 처리량에 묶인다. 반대로 조회수나 좋아요처럼 초당 수천 번 갱신되는 값을 매번 UPDATE로 반영하면 같은 행에 락 경합이 몰려 DB가 먼저 포화된다. 메모리 기반 캐시(Redis, Memcached)를 DB 앞에 두면 두 문제를 완화할 수 있지만, 캐시와 DB 중 어느 쪽에 먼저 쓰고 언제 동기화하느냐에 따라 정합성과 유실 위험이 달라진다. 이 선택이 캐싱 패턴이다.

## 핵심 개념

Look-aside(Cache-aside)는 애플리케이션이 캐시와 DB를 각각 직접 다룬다. 읽기는 캐시를 먼저 조회하고, 없으면 DB에서 읽어 캐시에 채운 뒤 반환한다. 쓰기는 DB를 갱신한 다음 해당 키를 캐시에서 삭제한다. 삭제 대신 갱신하지 않는 이유는 두 쓰기가 겹쳤을 때 DB 반영 순서와 캐시 반영 순서가 어긋나 오래된 값이 캐시에 남을 수 있기 때문이다. 삭제만 하면 다음 읽기가 DB의 최신 값을 다시 채운다. 캐시가 죽어도 DB로 서비스가 계속되고, 실제로 읽힌 데이터만 캐시에 올라온다. 대신 첫 조회는 항상 DB를 거치고, 인기 키가 만료되는 순간 요청이 DB로 몰린다.

Read-through는 미스 시 DB 조회를 캐시 라이브러리의 로더에 위임하는 변형으로, 동작 결과는 Look-aside와 같다.

Write-through는 쓰기 요청을 캐시와 DB에 동기적으로 모두 반영한 뒤 응답한다. 캐시에는 항상 최신 값이 있으므로 읽기 정합성이 가장 높지만, 쓰기마다 두 저장소를 거치므로 쓰기 지연이 늘고, 다시 읽히지 않을 데이터까지 캐시를 차지한다. ==캐시 쓰기와 DB 쓰기는 하나의 트랜잭션으로 묶이지 않으므로 둘 중 하나만 성공한 상태를 어떻게 복구할지 정해 두지 않으면 조용히 불일치가 남는다.== 보통 DB 트랜잭션 커밋 후 캐시를 갱신하고, 캐시 갱신 실패는 TTL로 자연 회복되도록 설계한다.

Write-behind(Write-back)는 캐시에만 쓰고 즉시 응답한 뒤, 스케줄러나 큐가 주기적으로 모아서 DB에 반영한다. 천 번의 UPDATE가 한 번의 벌크 반영으로 줄어 쓰기 처리량이 가장 높다. 대가는 유실 위험이다. DB에 반영되기 전에 캐시 프로세스가 내려가면 그 구간의 쓰기가 사라진다. 조회수·좋아요·로그 집계처럼 일부 유실이 허용되는 데이터에만 쓰고, 결제나 재고처럼 되돌릴 수 없는 데이터에는 쓰지 않는다.

| 구분 | Look-aside | Write-through | Write-behind |
|---|---|---|---|
| 최적화 대상 | 읽기 | 읽기 정합성 | 쓰기 처리량 |
| DB 반영 시점 | 쓰기 즉시, 캐시는 삭제 | 쓰기 즉시, 캐시도 갱신 | 지연 배치 |
| 캐시 장애 시 | DB로 계속 서비스 | DB로 계속 서비스 | 미반영 쓰기 유실 |
| 적합한 데이터 | 상품·프로필·본문 | 자주 읽히는 설정값 | 조회수·좋아요·집계 |

대부분의 읽기 캐시는 Look-aside로 충분하다. Write-behind는 쓰기 폭주가 확인된 특정 키에 부분적으로 도입한다.

## 코드

Spring Cache 추상화로 Look-aside를 구현한 예다. `@Cacheable`이 캐시 조회·미스 시 DB 조회·캐시 적재를 처리하고, `@CacheEvict`가 DB 갱신 후 키를 삭제한다. `sync = true`는 같은 키의 동시 미스를 한 스레드만 DB로 보낸다.

```java
@Service
public class BoardService {

    private final BoardRepository boardRepository;

    public BoardService(BoardRepository boardRepository) {
        this.boardRepository = boardRepository;
    }

    @Cacheable(cacheNames = "board", key = "#id", sync = true)
    @Transactional(readOnly = true)
    public BoardResponse getBoard(Long id) {
        return boardRepository.findById(id)
                .map(BoardResponse::from)
                .orElseThrow(() -> new NoSuchElementException("board " + id));
    }

    @CacheEvict(cacheNames = "board", key = "#id")
    @Transactional
    public void updateTitle(Long id, String title) {
        Board board = boardRepository.findById(id).orElseThrow();
        board.changeTitle(title);
    }
}
```

캐시 이름별 TTL과 직렬화 방식을 지정하는 RedisCacheManager 설정이다. 기본 JDK 직렬화 대신 JSON을 쓰고, `board` 캐시에는 10분 TTL을 준다.

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration base = RedisCacheConfiguration.defaultCacheConfig()
                .serializeValuesWith(RedisSerializationContext.SerializationPair
                        .fromSerializer(new GenericJackson2JsonRedisSerializer()))
                .disableCachingNullValues();

        return RedisCacheManager.builder(factory)
                .cacheDefaults(base.entryTtl(Duration.ofMinutes(1)))
                .withCacheConfiguration("board", base.entryTtl(Duration.ofMinutes(10)))
                .build();
    }
}
```

조회수를 Write-behind로 집계하는 예다. 요청 경로는 Redis INCR만 수행하고, 스케줄러가 1분마다 SCAN으로 키를 순회하며 GETDEL로 값을 읽는 동시에 지워 DB에 더한다.

```java
@Service
public class ViewCountService {

    private final StringRedisTemplate redis;
    private final VideoRepository videoRepository;

    public ViewCountService(StringRedisTemplate redis, VideoRepository videoRepository) {
        this.redis = redis;
        this.videoRepository = videoRepository;
    }

    public void increase(long videoId) {
        redis.opsForValue().increment("views:" + videoId);
    }

    @Scheduled(fixedDelay = 60_000)
    @Transactional
    public void flush() {
        ScanOptions options = ScanOptions.scanOptions().match("views:*").count(500).build();
        try (Cursor<String> cursor = redis.scan(options)) {
            while (cursor.hasNext()) {
                String key = cursor.next();
                String value = redis.opsForValue().getAndDelete(key);
                if (value == null) {
                    continue;
                }
                long videoId = Long.parseLong(key.substring("views:".length()));
                videoRepository.addViews(videoId, Long.parseLong(value));
            }
        }
    }
}
```

`addViews`는 `UPDATE video SET view_count = view_count + :delta WHERE id = :id` 형태의 증분 갱신이어야 한다. 절대값으로 덮어쓰면 여러 인스턴스가 동시에 flush할 때 서로의 반영분을 지운다.

## 실무에서 걸리는 지점

- 쓰기 순서는 DB 갱신 후 캐시 삭제다. ==캐시를 먼저 지우고 DB를 갱신하면 그 사이에 들어온 읽기가 DB의 옛 값을 캐시에 다시 채우고, TTL이 끝날 때까지 그대로 남는다.== 삭제 자체가 실패하는 경우도 있으므로 TTL 없는 캐시 항목은 두지 않는다.
- 인기 키가 만료되는 순간 수많은 요청이 동시에 미스를 내고 DB로 몰리는 Cache Stampede가 생긴다. `sync = true`로 인스턴스 안에서 직렬화하거나, TTL에 무작위 편차를 주어 동시 만료를 분산하거나, 만료 전에 백그라운드로 갱신한다. 배포 직후 빈 캐시에서도 같은 현상이 나므로 주요 키는 기동 시 미리 채운다.
- 스케줄러에서 `keys("views:*")`를 쓰면 안 된다. ==KEYS는 전체 키 공간을 훑는 O(N) 명령이고 Redis는 명령을 단일 스레드로 처리하므로, 키가 수백만 개면 그동안 모든 요청이 멈춘다.== SCAN으로 나누어 순회한다.
- Write-behind에서 값을 GET한 뒤 별도 명령으로 DEL하면 두 명령 사이에 들어온 증가분이 사라진다. GETDEL(Redis 6.2 이상)이나 Lua 스크립트로 읽기와 삭제를 원자적으로 묶는다. Redis 자체가 재시작하는 경우에 대비하려면 AOF 영속화를 켜되, 그래도 마지막 fsync 이후 구간은 유실될 수 있음을 전제로 한다.
- RedisTemplate의 기본 직렬화는 JDK 직렬화라 클래스에 필드를 추가하거나 패키지를 옮기면 기존 캐시 값의 역직렬화가 실패한다. JSON 직렬화를 쓰고, 응답 DTO 구조를 바꾸는 배포에서는 캐시 이름에 버전을 붙이거나 배포 시점에 해당 캐시를 비운다.

## 관련 글

- [동시성 제어 — 비관적 락과 낙관적 락](/notes/architecture-patterns/optimistic-pessimistic-lock/)
- [CQRS — 명령과 조회 모델 분리](/notes/architecture-patterns/cqrs/)
- [샤딩 — 수평 분할과 샤드 키 선택](/notes/architecture-patterns/sharding/)
