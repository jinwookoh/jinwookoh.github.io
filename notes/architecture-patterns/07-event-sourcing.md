---
title: "이벤트 소싱 — 상태 대신 이벤트를 저장하기"
series: architecture-patterns
part: "데이터"
order: 7
summary: "변경 이력을 이벤트로 append-only 저장하고 재생으로 상태를 복원하는 방식과, 스냅샷·업캐스팅·조회 모델 같은 운영 비용을 정리한다."
tags: [Event Sourcing, Event Store, Snapshot, CQRS, Audit]
sources: [https://jinwookoh.tistory.com/251]
updated: 2026-09-06
---

계좌 테이블의 `balance` 컬럼에 100만 원이 들어 있다. 이 값이 급여 입금으로 생긴 것인지, 적금 해지로 생긴 것인지, 어떤 순서의 거래를 거쳐 도달했는지는 테이블만 봐서는 알 수 없다. UPDATE는 이전 값을 덮어쓰기 때문에 변경의 원인과 맥락이 함께 사라진다. 잔액이 음수가 된 원인을 추적하거나 특정 시점의 상태를 재현해야 할 때 별도 이력 테이블이 없으면 방법이 없고, 이력 테이블을 둔다 해도 본 테이블과의 정합성을 애플리케이션이 직접 보장해야 한다. 이벤트 소싱은 상태 대신 상태를 바꾼 사건 자체를 저장해 이 문제를 구조적으로 해결한다.

## 핵심 개념

상태 저장 방식은 현재 시점의 값만 유지한다. 조회는 SELECT 한 번으로 끝나고 구현이 단순하지만, 과거 시점의 상태와 변경 원인은 저장되지 않는다.

이벤트 소싱은 애그리거트에 일어난 변경을 `Deposited`, `Withdrawn` 같은 불변 이벤트로 기록하고, 이벤트 스토어에 순서대로 추가만 한다. UPDATE와 DELETE는 없다. 현재 상태가 필요하면 빈 애그리거트에 이벤트를 발생 순서대로 다시 적용(replay)해 계산한다. 이벤트는 사실의 기록이므로 잘못된 이벤트를 고치는 방법도 수정이 아니라 취소 의미를 갖는 보상 이벤트를 추가하는 것이다.

이벤트 스토어는 애그리거트 ID별 스트림으로 이벤트를 관리하며, 각 이벤트에 스트림 안의 순번(version)을 붙인다. 이 순번은 재생 순서를 보장하는 동시에 동시성 제어에 쓰인다. 쓰기 시점에 기대 버전과 현재 버전을 비교해 다르면 거부하는 낙관적 락 방식이다.

이벤트가 누적될수록 재생 비용이 커지므로 일정 간격으로 스냅샷을 저장한다. 스냅샷은 특정 버전 시점의 애그리거트 상태를 통째로 직렬화한 것이고, 로드할 때는 최신 스냅샷 이후의 이벤트만 재생한다. 스냅샷은 최적화 수단일 뿐이며 원본은 항상 이벤트 스트림이다. 스냅샷을 지워도 재생으로 복구할 수 있어야 한다.

| 구분 | 상태 저장 | 이벤트 소싱 |
|---|---|---|
| 저장 대상 | 현재 값 | 변경 이벤트 시퀀스 |
| 수정·삭제 | UPDATE·DELETE | 없음, 보상 이벤트로 처리 |
| 특정 시점 조회 | 별도 이력 테이블 필요 | 해당 시점까지 재생 |
| 조회 모델 | 테이블 직접 조회 | 별도 읽기 모델 필요 |
| 복잡도 | 낮음 | 높음 |

이벤트 스트림은 단순 조회에 적합하지 않다. 잔액이 100만 원 이상인 계좌 목록 같은 질의를 이벤트 저장소에 직접 던질 수는 없으므로, 이벤트를 구독해 조회용 테이블을 갱신하는 읽기 모델이 필요하다. 이 때문에 이벤트 소싱은 CQRS와 함께 쓰이는 경우가 대부분이다.

## 코드

계좌 애그리거트. 명령 메서드는 검증 후 이벤트를 생성하고, 상태 변경은 `apply`에서만 일어난다. 재생과 신규 명령이 같은 경로를 타므로 상태 계산 로직이 한 곳에 모인다.

```java
public sealed interface AccountEvent permits Deposited, Withdrawn {}
public record Deposited(long amount) implements AccountEvent {}
public record Withdrawn(long amount) implements AccountEvent {}

public class Account {
    private final UUID id;
    private long balance;
    private long version;
    private final List<AccountEvent> pending = new ArrayList<>();

    public Account(UUID id) { this.id = id; }

    public void applyHistory(List<AccountEvent> history) {
        history.forEach(this::apply);
    }

    public void deposit(long amount) {
        if (amount <= 0) throw new IllegalArgumentException("amount must be positive");
        raise(new Deposited(amount));
    }

    public void withdraw(long amount) {
        if (balance < amount) throw new IllegalStateException("insufficient balance");
        raise(new Withdrawn(amount));
    }

    private void raise(AccountEvent event) {
        apply(event);
        pending.add(event);
    }

    private void apply(AccountEvent event) {
        switch (event) {
            case Deposited e -> balance += e.amount();
            case Withdrawn e -> balance -= e.amount();
        }
        version++;
    }

    public List<AccountEvent> pendingEvents() { return List.copyOf(pending); }
    public long version() { return version; }
    public long balance() { return balance; }
}
```

이벤트 스토어. `(stream_id, version)` 유니크 제약으로 동시 쓰기를 거부하고, 저장 직후 같은 트랜잭션 안에서 아웃박스에 기록해 외부 발행과의 이중 쓰기 문제를 피한다.

```java
@Entity
@Table(name = "event_store",
       uniqueConstraints = @UniqueConstraint(columnNames = {"stream_id", "version"}))
public class StoredEvent {
    @Id @GeneratedValue private Long id;
    @Column(name = "stream_id", nullable = false) private UUID streamId;
    @Column(nullable = false) private long version;
    @Column(name = "event_type", nullable = false) private String eventType;
    @Column(nullable = false, columnDefinition = "jsonb") private String payload;
    @Column(name = "occurred_at", nullable = false) private Instant occurredAt;
    // constructors, getters
}

@Service
public class AccountEventStore {
    private final StoredEventRepository repository;
    private final OutboxRepository outbox;
    private final EventSerializer serializer;

    @Transactional
    public void append(UUID streamId, long expectedVersion, List<AccountEvent> events) {
        long version = expectedVersion;
        for (AccountEvent event : events) {
            version++;
            StoredEvent stored = new StoredEvent(streamId, version,
                    event.getClass().getSimpleName(),
                    serializer.serialize(event), Instant.now());
            try {
                repository.saveAndFlush(stored);
            } catch (DataIntegrityViolationException e) {
                throw new ConcurrentModificationException(
                        "stream %s already at version %d".formatted(streamId, version));
            }
            outbox.save(OutboxMessage.from(stored));
        }
    }

    @Transactional(readOnly = true)
    public List<AccountEvent> load(UUID streamId, long afterVersion) {
        return repository.findByStreamIdAndVersionGreaterThanOrderByVersion(streamId, afterVersion)
                .stream()
                .map(e -> serializer.deserialize(e.getEventType(), e.getPayload()))
                .toList();
    }
}
```

애플리케이션 서비스. 스냅샷이 있으면 그 이후 이벤트만 재생하고, 명령 처리 후 새 이벤트를 저장한다.

```java
@Service
public class AccountCommandService {
    private static final int SNAPSHOT_INTERVAL = 100;

    private final AccountEventStore eventStore;
    private final SnapshotRepository snapshots;

    public void withdraw(UUID accountId, long amount) {
        Account account = load(accountId);
        long expected = account.version();
        account.withdraw(amount);
        eventStore.append(accountId, expected, account.pendingEvents());
        if (account.version() / SNAPSHOT_INTERVAL > expected / SNAPSHOT_INTERVAL) {
            snapshots.save(Snapshot.of(account));
        }
    }

    private Account load(UUID accountId) {
        Optional<Snapshot> snapshot = snapshots.findLatest(accountId);
        long from = snapshot.map(Snapshot::version).orElse(0L);
        Account base = snapshot.map(Snapshot::restore).orElseGet(() -> new Account(accountId));
        base.applyHistory(eventStore.load(accountId, from));
        return base;
    }
}
```

## 실무에서 걸리는 지점

- 이벤트 스키마 변경. 이벤트는 한번 저장되면 영구히 남으므로 필드를 바꾸는 순간 과거 이벤트와 새 코드 사이에 불일치가 생긴다. ==이벤트 클래스에 필드를 추가·변경할 때는 저장된 구버전 이벤트를 최신 형태로 변환하는 업캐스터를 함께 두어야 하며, 이를 빼먹으면 재생 시점에 역직렬화 실패나 잘못된 상태 계산이 조용히 발생한다.== 이벤트 타입명에 버전을 포함하거나 페이로드에 스키마 버전을 기록해 두는 편이 안전하다.
- 스냅샷 무효화. 애그리거트의 상태 계산 로직이 바뀌면 기존 스냅샷은 그 로직으로 만들어진 값이므로 신뢰할 수 없다. ==apply 로직이나 스냅샷 직렬화 형식을 바꿨다면 스냅샷을 전부 폐기하고 이벤트 스트림에서 다시 만들어야 한다.== 스냅샷에도 버전을 붙여 불일치 시 무시하도록 해 두면 배포 시 폐기 작업을 자동화할 수 있다.
- 개인정보 삭제 요구. append-only 원칙과 삭제권은 충돌한다. 이벤트 페이로드의 민감 필드를 사용자별 키로 암호화하고 삭제 요청 시 키만 폐기하는 crypto-shredding 방식이 일반적이며, 이벤트 자체를 물리 삭제하면 스트림 재생이 깨진다.
- 읽기 모델 지연. 이벤트를 구독해 조회 테이블을 갱신하므로 명령 직후 조회에서 이전 값이 보인다. 명령 응답에 새 버전을 돌려주고 조회 측이 그 버전 이상을 기다리게 하거나, UI에서 명령 결과를 낙관적으로 반영하는 식으로 대응한다.
- 도입 범위. 변경 이력 자체가 비즈니스 요구인 도메인, 즉 계좌·회계 장부·법적 감사 대상 데이터에 한정하는 편이 낫다. ==회원 정보나 게시판처럼 현재 값만 의미 있는 데이터에 이벤트 소싱을 적용하면 조회 모델·스냅샷·업캐스팅 유지 비용만 떠안게 되고, 한번 이벤트 스트림으로 저장한 데이터를 상태 저장 방식으로 되돌리는 마이그레이션은 재생과 검증 부담이 커서 되돌리기 어렵다.==

## 관련 글

- [CQRS — 명령과 조회 모델 분리](/notes/architecture-patterns/cqrs/)
- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
- [동시성 제어 — 비관적 락과 낙관적 락](/notes/architecture-patterns/optimistic-pessimistic-lock/)
