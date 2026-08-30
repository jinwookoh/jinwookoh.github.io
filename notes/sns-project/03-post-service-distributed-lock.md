---
title: "게시물 서비스 — Redisson 분산 락과 동시성"
series: sns-project
part: "서비스"
order: 3
summary: "락은 트랜잭션 바깥에, 외부 시스템 갱신은 afterCommit 안에 두어야 게시글 중복 생성과 유령 데이터를 막을 수 있다."
tags: [Redisson, 분산 락, afterCommit, Outbox Pattern, 동시성]
sources: [2026-05-04-javaex-sns-post-service.md]
updated: 2026-08-29
---

게시글 생성 API는 겉보기에 단순한 INSERT지만, 같은 사용자의 요청이 수 밀리초 간격으로 두 번 들어오는 상황을 고려하지 않으면 중복 게시글이 그대로 저장된다. 인스턴스가 여러 대인 환경에서는 JVM 내부의 `synchronized`가 다른 인스턴스의 요청을 막지 못하므로 Redis 기반 분산 락이 필요하다. 문제는 락 하나로 끝나지 않는다. 게시글 저장과 함께 Redis 캐시, 랭킹 Sorted Set, Elasticsearch 인덱스, Kafka 이벤트까지 갱신해야 하는데, ==이 호출들을 DB 트랜잭션 안에서 실행하면 롤백 시 DB에는 없고 캐시와 검색 인덱스에만 남는 유령 게시글이 생긴다.== 좋아요 역시 동시 요청 두 건이 모두 INSERT에 성공하면 카운트가 두 번 올라간다. Post Service의 동시성 설계는 이 세 문제를 각각 다른 도구로 푼다.

## 핵심 개념

**락이 트랜잭션을 감싼다.** `@Transactional` 메서드 안에서 락을 획득하고 해제하면 `finally`의 `unlock()`이 커밋보다 먼저 실행된다. 락이 풀린 시점과 커밋 사이의 짧은 구간에 다른 스레드가 락을 획득해 같은 조건으로 INSERT를 시도할 수 있으므로, ==락 획득 → 트랜잭션 시작 → 커밋 → 락 해제 순서가 보장되도록 락을 잡는 메서드와 트랜잭션 메서드를 분리한다.== 이때 트랜잭션 메서드는 별도 빈에 두거나 프록시를 거쳐 호출해야 `@Transactional`이 실제로 적용된다. 같은 클래스 내부의 자기 호출은 프록시를 우회하므로 어노테이션이 무시된다.

**Redisson RLock과 Watchdog.** `tryLock(waitTime, leaseTime, unit)`에서 `waitTime=0`은 락을 못 잡으면 대기 없이 즉시 `false`를 반환한다는 뜻이고, `leaseTime=-1`은 만료 시간을 고정하지 않고 Watchdog에 맡긴다는 뜻이다. Watchdog은 Redisson 클라이언트의 백그라운드 스레드로, 락 TTL(기본 30초)을 10초 주기로 연장한다. `unlock()`이 호출되거나 프로세스가 죽어 갱신이 멈추면 TTL이 만료되어 락이 자연 해제되므로 작업 시간을 미리 예측해 TTL을 잡을 필요가 없다.

**afterCommit 동기화.** `TransactionSynchronizationManager.registerSynchronization()`으로 등록한 `afterCommit()` 콜백은 커밋이 성공한 뒤에만 실행된다. ==롤백되면 호출되지 않으므로 캐시 SET, 랭킹 갱신, ES 인덱싱처럼 되돌릴 수 없는 외부 호출을 여기에 둔다.== 조회수 증가처럼 JPA dirty checking에 의존하는 값도 커밋 이후에야 DB에 반영되므로, 랭킹 점수 계산은 커밋 후에 해야 DB와 어긋나지 않는다.

**Outbox 패턴.** Kafka 발행을 트랜잭션 안에서 직접 하면 DB 성공·Kafka 실패(이벤트 유실) 또는 Kafka 성공·DB 롤백(유령 이벤트) 중 하나가 발생한다. 이벤트를 같은 트랜잭션의 `outbox_events` 테이블에 INSERT하고 Debezium이 PostgreSQL WAL(`wal_level=logical`)을 읽어 Kafka에 발행하면 DB 저장과 이벤트 발행이 원자적으로 묶인다.

**DB UNIQUE 제약을 동시성 제어로 사용.** 좋아요처럼 "한 사용자당 한 건"이 규칙인 데이터는 `UNIQUE(user_id, post_id)` 제약만으로 동시 INSERT 중 하나만 통과시킬 수 있다. 실패한 쪽에서 발생하는 `DataIntegrityViolationException`을 잡아 정상 응답으로 처리하면 결과가 멱등해지고 분산 락이나 `SELECT FOR UPDATE`가 필요 없다.

## 코드

게시글 생성. 락을 잡는 메서드는 트랜잭션이 없고, 실제 저장은 별도 빈 `PostWriter`의 트랜잭션 메서드가 담당한다.

```java
@Service
@RequiredArgsConstructor
public class PostService {

    private final RedissonClient redissonClient;
    private final PostWriter postWriter;

    public PostResponse createPost(Long userId, PostRequest request) {
        RLock lock = redissonClient.getLock("lock:post:create:" + userId);
        boolean acquired = false;
        try {
            acquired = lock.tryLock(0, -1, TimeUnit.SECONDS);
            if (!acquired) {
                throw new DuplicatePostRequestException(userId); // HTTP 409
            }
            return postWriter.create(userId, request);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("lock interrupted", e);
        } finally {
            if (acquired && lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}

@Component
@RequiredArgsConstructor
public class PostWriter {

    private final PostRepository postRepository;
    private final OutboxEventRepository outboxEventRepository;
    private final StringRedisTemplate redisTemplate;
    private final PostIndexer postIndexer;

    @Transactional
    public PostResponse create(Long userId, PostRequest request) {
        Post saved = postRepository.save(Post.of(userId, request));
        outboxEventRepository.save(
                OutboxEvent.of("Post", saved.getId(), "PostCreated", saved.toPayload()));

        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                redisTemplate.delete("cache:posts:list");
                postIndexer.index(saved);
            }
        });
        return PostResponse.from(saved);
    }
}
```

좋아요 토글. 락 없이 UNIQUE 제약과 예외 처리만으로 멱등성을 확보한다.

```java
@Transactional
public void toggleLike(Long postId, Long userId) {
    Post post = postRepository.findById(postId)
            .orElseThrow(() -> new PostNotFoundException(postId));

    Optional<Like> existing = likeRepository.findByUserIdAndPostId(userId, postId);
    if (existing.isPresent()) {
        likeRepository.delete(existing.get());
        post.decrementLikeCount();
    } else {
        try {
            likeRepository.saveAndFlush(new Like(userId, postId)); // UNIQUE(user_id, post_id)
            post.incrementLikeCount();
        } catch (DataIntegrityViolationException e) {
            return; // 동시 요청이 먼저 INSERT — 멱등하게 무시
        }
    }

    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
            double score = post.getLikeCount() * 2.0 + post.getViewCount();
            redisTemplate.opsForZSet().add("ranking:posts", String.valueOf(postId), score);
        }
    });
}
```

랭킹 조회. Redis가 돌려준 순서를 유지하며 DB에서 본문을 채운다.

```java
public List<PostSummaryResponse> getRanking(int limit) {
    Set<String> ids = redisTemplate.opsForZSet().reverseRange("ranking:posts", 0, limit - 1);
    if (ids == null || ids.isEmpty()) return List.of();

    List<Long> orderedIds = ids.stream().map(Long::parseLong).toList();
    Map<Long, Post> byId = postRepository.findAllById(orderedIds).stream()
            .collect(Collectors.toMap(Post::getId, Function.identity()));

    return orderedIds.stream()
            .filter(byId::containsKey)
            .map(byId::get)
            .map(PostSummaryResponse::from)
            .toList();
}
```

## 실무에서 걸리는 지점

- **자기 호출로 트랜잭션이 사라진다.** 락 메서드와 트랜잭션 메서드를 같은 클래스에 두고 `this.doCreate()`로 부르면 ==프록시를 거치지 않아 `@Transactional`이 적용되지 않는다.== 별도 빈으로 분리하거나 `TransactionTemplate`을 직접 사용한다.
- **UNIQUE 위반 예외는 flush 시점에 발생한다.** `save()`만 호출하면 INSERT가 커밋 직전까지 지연되어 `catch` 블록을 지나친 뒤 커밋에서 예외가 터진다. `saveAndFlush()`로 즉시 INSERT를 보내야 의도한 위치에서 잡힌다. 또한 예외가 발생한 트랜잭션은 rollback-only로 표시되므로, 좋아요 취소 분기와 섞이지 않도록 흐름을 설계한다.
- **afterCommit 안의 예외는 전파되지 않는다.** 커밋은 이미 끝났으므로 캐시나 ES 호출 실패는 로그만 남고 요청은 성공으로 응답된다. 재시도 큐를 두거나, 정확성이 필요한 값은 배치 재계산으로 보정한다. 랭킹 점수는 Spring Batch가 청크 단위로 주기 재계산해 이 불일치를 흡수한다.
- **Watchdog은 프로세스가 살아 있는 한 락을 유지한다.** 트랜잭션 메서드가 커넥션 풀 고갈이나 외부 API 지연으로 멈추면 락도 함께 잡혀 있어 해당 사용자의 생성 요청이 계속 409를 받는다. 트랜잭션 타임아웃을 명시하고 락 보유 시간을 모니터링한다.
- **`findAllById`는 순서를 보장하지 않는다.** Map으로 변환한 뒤 Redis 순서로 재조립하는 단계를 생략하면 점수가 높은 글이 아래에 표시되는 버그가 조용히 남는다.

## 관련 글

- [서비스 분해와 아키텍처](/notes/sns-project/microservices-architecture/)
- [Kafka 이벤트 흐름·Outbox·Redis 활용 패턴](/notes/sns-project/kafka-outbox-redis-patterns/)
- [Elasticsearch 검색과 S3 업로드](/notes/sns-project/elasticsearch-s3/)
