---
title: "트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결"
series: architecture-patterns
part: "서비스 통신"
order: 13
summary: "DB 커밋과 메시지 발행을 한 트랜잭션에 넣을 수 없을 때, 이벤트를 같은 DB에 먼저 기록하고 뒤에서 꺼내 보낸다."
tags: [Transactional Outbox, Dual Write, CDC, Debezium, Kafka]
sources: [https://jinwookoh.tistory.com/238]
updated: 2026-09-06
---

회원을 저장하고 곧바로 Kafka에 `MemberCreated` 이벤트를 보내는 코드는 두 가지 방식으로 깨진다. 트랜잭션 커밋 전에 발행하면 커밋이 실패했을 때 존재하지 않는 회원의 이벤트가 이미 브로커에 남는다. 커밋 후에 발행하면 브로커 장애나 네트워크 오류로 발행이 실패했을 때 회원은 있는데 이벤트가 없다. 관계형 DB와 메시지 브로커는 서로 다른 자원이라 하나의 트랜잭션으로 묶을 수 없고, 이 상황을 이중 쓰기 문제라고 부른다. 트랜잭셔널 아웃박스는 브로커 발행을 트랜잭션 밖으로 밀어내는 대신, 보낼 메시지를 비즈니스 데이터와 같은 DB 트랜잭션 안에 기록하고 별도 과정이 그 기록을 읽어 브로커로 옮기게 한다.

## 핵심 개념

애플리케이션은 비즈니스 테이블과 `outbox` 테이블에 같은 트랜잭션으로 INSERT한다. 여기까지는 단일 DB의 원자성이 보장하므로 둘 중 하나만 남는 상태는 생기지 않는다. 문제는 `outbox`에 쌓인 행을 어떻게 브로커로 옮기느냐이고, 방식은 두 가지다.

폴링 퍼블리셔는 스케줄러가 주기적으로 미발행 행을 조회해 브로커에 보낸 뒤 발행 완료로 표시하거나 삭제한다. 추가 인프라 없이 애플리케이션 코드와 DB만으로 완성되지만, 폴링 주기만큼 지연이 생기고 조회 쿼리가 DB에 계속 부하를 준다.

트랜잭션 로그 테일링은 DB의 트랜잭션 로그(MySQL binlog, PostgreSQL WAL)를 CDC 커넥터가 읽어 `outbox` INSERT를 감지하는 즉시 브로커로 전송한다. Debezium이 대표적이며, 애플리케이션은 아웃박스 행을 쓰는 것으로 역할이 끝난다. 커밋 직후 거의 실시간으로 발행되고 SELECT 부하가 없지만 Kafka Connect와 커넥터를 별도로 운영해야 한다.

| 구분 | 폴링 퍼블리셔 | 로그 테일링(CDC) |
|---|---|---|
| 발행 트리거 | 주기적 SELECT | 트랜잭션 로그 감지 |
| 지연 | 폴링 주기에 종속 | 커밋 직후 |
| DB 부하 | 조회 쿼리 지속 발생 | 로그 읽기만 수행 |
| 필요 인프라 | 없음 | Kafka Connect + Debezium |
| 적합한 경우 | 수 초 지연 허용, 소규모 | 대용량, 지연 민감 |

어느 방식이든 전달 보장은 at-least-once다. 발행 후 완료 표시 전에 프로세스가 죽으면 같은 메시지가 다시 나가므로, ==소비자는 이벤트 ID로 중복을 걸러내는 멱등 처리를 반드시 갖춰야 한다==. 아웃박스는 유실을 막는 장치이지 중복을 막는 장치가 아니다.

## 코드

아웃박스 엔티티. 이벤트 ID를 애플리케이션에서 UUID로 생성해 소비자 측 중복 제거 키로 쓴다.

```java
@Entity
@Table(name = "outbox")
public class OutboxEvent {

    @Id
    private UUID id;

    private String aggregateType;
    private String aggregateId;
    private String eventType;

    @Column(columnDefinition = "text")
    private String payload;

    private Instant createdAt;
    private Instant publishedAt;

    protected OutboxEvent() {}

    public OutboxEvent(String aggregateType, String aggregateId,
                       String eventType, String payload) {
        this.id = UUID.randomUUID();
        this.aggregateType = aggregateType;
        this.aggregateId = aggregateId;
        this.eventType = eventType;
        this.payload = payload;
        this.createdAt = Instant.now();
    }

    public void markPublished() {
        this.publishedAt = Instant.now();
    }
    // getters 생략
}
```

비즈니스 로직. 회원 저장과 아웃박스 저장이 같은 트랜잭션에 묶이며, 브로커 호출은 이 메서드 안에 없다.

```java
@Service
public class MemberService {

    private final MemberRepository memberRepository;
    private final OutboxRepository outboxRepository;
    private final ObjectMapper objectMapper;

    public MemberService(MemberRepository memberRepository,
                         OutboxRepository outboxRepository,
                         ObjectMapper objectMapper) {
        this.memberRepository = memberRepository;
        this.outboxRepository = outboxRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Long join(String email) throws JsonProcessingException {
        Member member = memberRepository.save(new Member(email));
        String payload = objectMapper.writeValueAsString(
                new MemberCreated(member.getId(), email));
        outboxRepository.save(new OutboxEvent(
                "Member", member.getId().toString(), "MemberCreated", payload));
        return member.getId();
    }
}
```

폴링 퍼블리셔. 미발행 행을 생성 순서로 잠근 채 읽고, 발행에 성공한 행만 완료로 표시한다. 인스턴스가 여러 개여도 `SKIP LOCKED`로 같은 행을 중복해서 가져가지 않는다.

```java
public interface OutboxRepository extends JpaRepository<OutboxEvent, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
    @Query("select e from OutboxEvent e where e.publishedAt is null order by e.createdAt")
    List<OutboxEvent> findUnpublished(Pageable pageable);
}

@Component
public class OutboxPublisher {

    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OutboxPublisher(OutboxRepository outboxRepository,
                           KafkaTemplate<String, String> kafkaTemplate) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
    }

    @Scheduled(fixedDelay = 1000)
    @Transactional
    public void publish() {
        List<OutboxEvent> events =
                outboxRepository.findUnpublished(PageRequest.of(0, 100));
        for (OutboxEvent event : events) {
            try {
                kafkaTemplate.send(event.getAggregateType(),
                                   event.getAggregateId(),
                                   event.getPayload()).get();
                event.markPublished();
            } catch (Exception e) {
                break;   // 순서 보존을 위해 이후 행은 다음 주기로 미룬다
            }
        }
    }
}
```

`jakarta.persistence.lock.timeout = -2`는 Hibernate 6에서 `SKIP LOCKED`로 번역된다. `send().get()`으로 브로커 응답을 기다린 뒤에만 완료 표시하므로 발행되지 않은 행이 완료로 남는 일은 없다.

## 실무에서 걸리는 지점

- 순서 보장: 같은 애그리거트의 이벤트는 순서가 뒤바뀌면 안 된다. 폴링에서 `createdAt` 정렬만으로는 부족하고, 서로 다른 인스턴스가 같은 애그리거트의 행을 나눠 가져가면 순서가 깨진다. ==Kafka 파티션 키를 애그리거트 ID로 고정하고, 실패한 행 이후는 건너뛰지 말고 다음 주기로 미뤄야 순서가 유지된다==.
- 테이블 비대화: 완료 행을 지우지 않으면 `outbox`가 무한히 커지고 미발행 조회의 인덱스 효율이 떨어진다. `publishedAt`이 NULL인 행만 잡는 부분 인덱스를 두고, 완료 행은 별도 배치로 주기 삭제한다.
- 폴링 주기와 부하의 상충: 주기를 줄이면 지연은 줄지만 빈 조회가 늘어난다. 배치 크기 100~500과 주기 0.5~2초 사이에서 트래픽에 맞춰 조정하고, 이 범위로 감당이 안 되면 CDC로 전환을 검토한다.
- CDC 운영 복잡도: Debezium은 DB의 로그 보존 설정(binlog 보존 기간, WAL replication slot)에 의존한다. ==PostgreSQL에서 커넥터가 멈춘 채 방치되면 replication slot이 WAL 삭제를 막아 디스크가 가득 찰 때까지 조용히 쌓인다==. 커넥터 지연을 모니터링 대상에 넣어야 한다.
- 페이로드 스키마 변경: 아웃박스에 직렬화된 JSON은 발행 시점이 아니라 저장 시점 스키마다. 필드를 제거하거나 타입을 바꾸면 아직 발행되지 않은 행이 깨진 상태로 나간다. 이벤트 버전 필드를 처음부터 포함시키고 소비자가 구버전을 읽을 수 있게 유지한다.

## 관련 글

- [메시징 — Point-to-Point와 Pub/Sub, 소비 모델](/notes/architecture-patterns/messaging/)
- [사가 — 코레오그래피와 오케스트레이션](/notes/architecture-patterns/saga/)
- [이벤트 소싱 — 상태 대신 이벤트를 저장하기](/notes/architecture-patterns/event-sourcing/)
