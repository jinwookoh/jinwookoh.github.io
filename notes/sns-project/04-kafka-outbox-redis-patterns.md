---
title: "Kafka 이벤트 흐름·Outbox·Redis 활용 패턴"
series: sns-project
part: "데이터와 검색"
order: 4
summary: "DB 커밋과 Kafka 발행을 Outbox·Debezium으로 묶고, Redis 하나로 캐시·랭킹·블랙리스트·락을 나눠 맡긴다"
tags: [Kafka, Outbox Pattern, Debezium, Redis, Redisson]
sources: [2026-05-04-javaex-sns-kafka-outbox.md, 2026-05-04-javaex-sns-redis-patterns.md]
updated: 2026-08-29
---

게시글 저장 뒤 `kafkaTemplate.send()`를 호출하면 커밋은 됐는데 발행이 실패해 알림이 사라지거나, 발행은 됐는데 롤백돼 없는 게시글의 알림이 나간다. 또 캐시·랭킹·로그아웃 토큰·중복 요청 차단까지 PostgreSQL에 맡기면 응답이 수백 ms로 늘어난다. 앞의 문제는 Outbox Pattern과 Debezium CDC로, 뒤의 문제는 Redis 역할 분담으로 푼다.

## 핵심 개념

### Outbox Pattern + Debezium CDC

이벤트를 브로커에 직접 보내는 대신 같은 트랜잭션 안에서 `outbox_events` 테이블에 INSERT한다. 게시글과 outbox 행이 함께 커밋되거나 롤백되므로 원자성이 DB 수준에서 보장된다. PostgreSQL을 `wal_level=logical`로 두면 Debezium(Kafka Connect)이 WAL에서 outbox 행 커밋을 감지하고, `EventRouter` SMT가 `aggregate_type` 값을 토픽명으로 써서 발행한다. 읽힌 outbox 행은 쓸모가 없으므로 `created_at` RANGE 파티션을 pg_partman으로 월별 생성하고 지난 파티션을 DROP해 디스크를 회수한다.

### 알림 파이프라인의 두 단계 분리

notification-service는 `Post` 토픽을 소비해 작성자와 구독자를 user-service에서 조회하고 알림을 DB에 저장한 뒤, 구독자별로 `notification.email` 토픽에 다시 발행한다. SMTP 발송은 별도 리스너가 맡으므로 메일이 실패해도 알림 레코드는 남고 재처리는 Kafka 재전송으로 끝난다. Spring MVC라 리스너 안에서 `WebClient`를 동기 호출해도 막히는 것은 컨슈머 스레드 하나뿐이다.

### 직렬화와 컨슈머 그룹

==`JsonSerializer`는 기본값으로 헤더에 Java 클래스 이름을 싣는데, 서비스마다 DTO 패키지가 달라 역직렬화가 실패한다.== `spring.json.add.type.headers=false`로 두면 컨슈머가 리스너 파라미터 타입으로 역직렬화하며, 컨슈머 쪽에는 `spring.json.trusted.packages`를 명시한다. 같은 `group-id`의 인스턴스들은 파티션을 자동으로 나눠 갖는다.

### Redis의 네 가지 역할

| 키 | 자료구조 | 용도 | 만료 |
|---|---|---|---|
| `cache:posts:{id}` | String | 게시글 상세 캐시 | TTL 5분 |
| `cache:posts:list` | String | 게시글 목록 캐시 | 이벤트로 삭제 |
| `ranking:posts` | Sorted Set | 인기 게시글 랭킹 | 없음 |
| `session:blacklist:{jti}` | String | JWT 블랙리스트 | 토큰 잔여 만료 시간 |
| `lock:post:create:{userId}` | Redisson 내부 | 게시글 생성 분산 락 | Watchdog |

키는 `<용도>:<엔티티>:<식별자>` 형식으로 통일하고, 분산 락만 `RedissonClient`가, 나머지는 `StringRedisTemplate`이 맡는다.

캐시는 Cache-Aside다. 상세는 캐시 미스 시 DB를 읽고 `afterCommit`에서 5분 TTL로 저장하고, 목록은 방금 쓴 글이 안 보이면 곧바로 드러나므로 생성 트랜잭션 안에서 즉시 삭제한다.

랭킹은 `score = likeCount × 2 + viewCount`를 Sorted Set에 넣는다. `ZREVRANGE`는 O(log N + M)이라 수백만 멤버가 있어도 밀리초 안에 상위 M개를 얻는다.

JWT 블랙리스트는 로그아웃 시 `jti`를 키로 저장하되 TTL을 토큰의 남은 만료 시간과 맞춘다. 만료된 토큰은 서명 검증에서 걸러지므로 저장소가 커지지 않는다.

분산 락은 Redisson `RLock`을 `tryLock(0, -1, SECONDS)`로 잡는다. `waitTime=0`은 즉시 실패, `leaseTime=-1`은 Watchdog 활성화다. Watchdog은 30초 TTL을 10초마다 갱신하므로 긴 작업에도 락이 유지되고, 서버가 죽으면 30초 뒤 해제된다. 락은 `@Transactional` 바깥에서 잡아야 커밋 이후에 해제된다.

## 코드

`outbox_events` 테이블이다.

```sql
CREATE TABLE outbox_events (
    id             UUID         NOT NULL DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,  -- "Post"
    aggregate_id   VARCHAR(100) NOT NULL,  -- post.id
    type           VARCHAR(100) NOT NULL,  -- "PostCreated"
    payload        JSONB        NOT NULL,
    created_at     TIMESTAMP    NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- pg_partman이 월별 파티션을 생성·관리한다
```

`Post` 토픽을 소비해 알림을 저장하고 이메일 이벤트를 발행하는 리스너와 발송 리스너다.

```java
@Component
@RequiredArgsConstructor
public class PostCreatedConsumer {

    private final UserServiceClient userServiceClient;
    private final NotificationService notificationService;
    private final KafkaTemplate<String, EmailEvent> kafkaTemplate;

    @KafkaListener(topics = "Post", groupId = "notification-service")
    public void consume(PostCreatedEvent event) {
        InternalUserResponse author = userServiceClient.getUser(event.authorId()).orElse(null);
        if (author == null) return;                       // 작성자 삭제 시 건너뜀

        List<SubscriberResponse> subscribers = userServiceClient.getSubscribers(event.authorId());
        if (subscribers.isEmpty()) return;

        notificationService.saveAll(subscribers, event, author.nickname());

        for (SubscriberResponse s : subscribers) {
            EmailEvent email = new EmailEvent(s.userId(), author.nickname(), event.postId(), event.title());
            kafkaTemplate.send("notification.email", String.valueOf(s.userId()), email)
                    .whenComplete((result, ex) -> {
                        if (ex != null) log.error("이메일 이벤트 발행 실패 userId={}", s.userId(), ex);
                    });
        }
    }
}

@Component
@RequiredArgsConstructor
public class EmailSendConsumer {

    private final UserServiceClient userServiceClient;
    private final EmailService emailService;

    @KafkaListener(topics = "notification.email", groupId = "notification-service")
    public void consume(EmailEvent event) {
        userServiceClient.getUser(event.recipientUserId()).ifPresentOrElse(
                user -> emailService.sendNewPostNotification(
                        user.email(), user.nickname(),
                        event.authorNickname(), event.postTitle(), event.postId()),
                () -> log.warn("수신자 조회 실패 — 이메일 스킵 userId={}", event.recipientUserId()));
    }
}
```

게시글 생성에서 락은 트랜잭션 바깥, 캐시 삭제는 트랜잭션 안, 랭킹 갱신은 커밋 이후에 둔다.

```java
@Service
@RequiredArgsConstructor
public class PostService {

    private final RedissonClient redissonClient;
    private final StringRedisTemplate redisTemplate;
    private final PostRepository postRepository;
    private final OutboxEventRepository outboxEventRepository;
    private final ObjectMapper objectMapper;

    public PostResponse createPost(Long userId, PostRequest request) {
        RLock lock = redissonClient.getLock("lock:post:create:" + userId);
        boolean acquired;
        try {
            acquired = lock.tryLock(0, -1, TimeUnit.SECONDS);   // 즉시 실패 + Watchdog
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DuplicatePostRequestException(userId);
        }
        if (!acquired) throw new DuplicatePostRequestException(userId);   // 409
        try {
            return doCreatePost(userId, request);
        } finally {
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }
    }

    @Transactional
    PostResponse doCreatePost(Long userId, PostRequest request) {
        Post saved = postRepository.save(Post.of(userId, request));
        outboxEventRepository.save(OutboxEvent.postCreated(saved, objectMapper));  // 같은 트랜잭션
        redisTemplate.delete("cache:posts:list");                                 // 목록 캐시 즉시 무효화

        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                double score = saved.getLikeCount() * 2.0 + saved.getViewCount();
                redisTemplate.opsForZSet().add("ranking:posts", String.valueOf(saved.getId()), score);
            }
        });
        return PostResponse.from(saved);
    }
}
```

## 실무에서 걸리는 지점

- **`max.block.ms` 기본값 60초.** ==브로커에 연결되지 않으면 `send()`가 최대 60초 블로킹되므로 직접 발행하는 notification-service는 5초 안팎으로 줄인다.==
- **Debezium은 at-least-once다.** ==커넥터 재시작으로 같은 outbox 행이 두 번 발행될 수 있으므로 컨슈머는 outbox `id` 처리 이력이나 유니크 제약으로 멱등하게 만든다.==
- **랭킹 Sorted Set은 어긋난다.** Redis 재시작이나 `afterCommit` 예외로 점수가 DB와 달라지므로 Spring Batch Job이 `executePipelined()`로 ZADD를 묶어 주기적으로 재계산한다.
- **캐시 SET 타이밍.** 트랜잭션 안에서 SET하면 롤백된 값이 캐시에 남으므로 SET은 `afterCommit`에서 한다.
- **Redis 단일 장애점.** 블랙리스트 조회 실패 시 거부할지 통과시킬지 정책을 코드에 명시하고, 운영에서는 Sentinel 또는 Cluster로 가용성을 확보한다.

## 관련 글

- [게시물 서비스 — Redisson 분산 락과 동시성](/notes/sns-project/post-service-distributed-lock/)
- [API Gateway·JWT·OAuth2 인증](/notes/sns-project/gateway-jwt-oauth2/)
- [Elasticsearch 검색과 S3 업로드](/notes/sns-project/elasticsearch-s3/)
