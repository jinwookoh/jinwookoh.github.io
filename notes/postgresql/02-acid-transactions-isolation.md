---
title: "ACID·트랜잭션·격리 수준"
series: postgresql
part: "DB 원리"
order: 2
summary: "트랜잭션이 ACID를 어떻게 보장하고, PostgreSQL의 격리 수준 4단계가 동시 실행에서 무엇을 막는지 정리한다."
tags: [ACID, Transaction, Isolation Level, MVCC, WAL]
sources: [2026-05-03-db-eng-acid.md, data-infra/2026-05-17-pg-transactions.md]
updated: 2026-08-29
---

계좌 이체는 출금 UPDATE와 입금 UPDATE 두 문장으로 이루어진다. 첫 문장만 반영되고 프로세스가 죽으면 돈이 사라지고, 두 문장 사이에 다른 세션이 잔액을 읽으면 존재한 적 없는 중간 값을 보게 된다. 커밋 직후 정전이 나면 확정 응답한 데이터가 디스크에 없을 수도 있다. ==트랜잭션은 이 문제들을 하나의 실행 단위로 해결하는 장치이고, ACID는 그 단위가 지켜야 할 네 가지 성질이다.==

## 핵심 개념

트랜잭션은 여러 SQL을 하나의 논리적 작업 단위로 묶는다. `BEGIN`으로 열고 `COMMIT`으로 확정하거나 `ROLLBACK`으로 취소한다. PostgreSQL은 기본이 자동 커밋이므로 명시적 BEGIN이 없으면 각 SQL이 그 자체로 하나의 트랜잭션이 된다.

| 속성 | 의미 | PostgreSQL에서의 보장 수단 |
|:---|:---|:---|
| Atomicity | 전부 성공 또는 전부 실패 | MVCC 버전과 트랜잭션 상태(commit log) |
| Consistency | 제약 조건을 트랜잭션 전후로 만족 | PK·UNIQUE·FK·CHECK, 트리거 |
| Isolation | 동시 트랜잭션의 중간 상태를 보지 않음 | 스냅샷 기반 MVCC, 격리 수준 |
| Durability | 커밋된 데이터는 장애 후에도 남음 | WAL과 fsync |

ACID의 C는 무결성 규칙의 유지이고, CAP 정리의 C는 분산 노드 간 값의 일치를 뜻하므로 서로 다른 개념이다.

Durability는 WAL(Write-Ahead Log)이 담당한다. 변경 내용을 데이터 파일보다 먼저 WAL에 기록하고 fsync로 디스크에 내린 뒤에야 COMMIT 응답을 돌려주며, 장애 후 재시작 시 WAL을 재생해 마지막 커밋 상태로 복구한다. `synchronous_commit = off`로 바꾸면 fsync를 기다리지 않으므로 지연은 줄지만 장애 시 최근 커밋이 유실될 수 있다.

Isolation이 없을 때 나타나는 이상 현상은 네 가지다. Dirty Read는 커밋되지 않은 값을 읽는 것, Non-Repeatable Read는 같은 행을 두 번 읽었을 때 값이 달라지는 것, Phantom Read는 같은 조건으로 두 번 조회했을 때 행의 집합이 달라지는 것, Lost Update는 두 트랜잭션이 같은 값을 읽고 각자 갱신해 한쪽 변경이 덮어써지는 것이다.

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|:---|:---:|:---:|:---:|
| Read Uncommitted | 표준상 허용 | 허용 | 허용 |
| Read Committed | 방지 | 허용 | 허용 |
| Repeatable Read | 방지 | 방지 | 표준상 허용 |
| Serializable | 방지 | 방지 | 방지 |

PostgreSQL의 구현은 표준 표와 두 군데에서 다르다. Read Uncommitted를 요청해도 Read Committed로 동작하므로 Dirty Read는 어떤 수준에서도 발생하지 않는다. ==Repeatable Read는 트랜잭션 시작 시점의 스냅샷을 끝까지 유지하는 Snapshot Isolation이라 Phantom Read도 발생하지 않는다.== 다만 write skew 같은 직렬화 위반은 Serializable만 막는다. PostgreSQL의 Serializable은 SSI(Serializable Snapshot Isolation)로 구현되어, 락으로 선점하는 2PL과 달리 낙관적으로 실행하다가 읽기·쓰기 의존성 충돌 시 한쪽을 `could not serialize access` 오류로 중단시킨다. 재시도가 전제된다.

기본값은 Read Committed이며 문장 단위로 새 스냅샷을 잡으므로 한 트랜잭션 안에서도 앞뒤 SELECT 결과가 다를 수 있다. MySQL InnoDB 기본값은 Repeatable Read다.

특정 행의 동시 갱신만 막으려면 `SELECT ... FOR UPDATE`로 행 락을 잡는다. `FOR SHARE`는 갱신만 차단하고, `NOWAIT`는 대기 없이 즉시 오류를 내며, `SKIP LOCKED`는 잠긴 행을 건너뛴다.

## 코드

계좌 이체와 이력 기록을 한 트랜잭션으로 묶는다. 한 문장이라도 실패하면 세 변경이 모두 취소된다.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 10000 WHERE id = 1;
UPDATE accounts SET balance = balance + 10000 WHERE id = 2;
INSERT INTO transfers (from_id, to_id, amount) VALUES (1, 2, 10000);
COMMIT;
```

SAVEPOINT는 트랜잭션 안의 부분 취소점이다. PostgreSQL은 오류가 난 트랜잭션의 후속 SQL을 모두 거부하므로 실패 가능 구간을 SAVEPOINT로 감싼다.

```sql
BEGIN;
INSERT INTO orders (user_id, amount) VALUES (1, 10000) RETURNING id;
SAVEPOINT after_order;
UPDATE inventory SET stock = stock - 1 WHERE product_id = 100 AND stock > 0;
-- 갱신된 행이 없으면 재고 부족으로 판단해 이 구간만 되돌린다
ROLLBACK TO SAVEPOINT after_order;
UPDATE orders SET status = 'PENDING_STOCK' WHERE id = 42;
COMMIT;
```

Spring의 `@Transactional`은 진입 시 BEGIN, 정상 반환 시 COMMIT, 런타임 예외 시 ROLLBACK을 처리한다. Serializable로 실행하고 직렬화 실패를 재시도한다.

```java
@Service
public class TransferService {

    private final AccountRepository accountRepository;
    private final TransferRepository transferRepository;

    public TransferService(AccountRepository accountRepository,
                           TransferRepository transferRepository) {
        this.accountRepository = accountRepository;
        this.transferRepository = transferRepository;
    }

    @Retryable(retryFor = CannotSerializeTransactionException.class,
               maxAttempts = 3, backoff = @Backoff(delay = 50))
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void transfer(long fromId, long toId, long amount) {
        Account from = accountRepository.findById(fromId).orElseThrow();
        Account to = accountRepository.findById(toId).orElseThrow();
        from.withdraw(amount);
        to.deposit(amount);
        transferRepository.save(new Transfer(fromId, toId, amount));
    }
}
```

## 실무에서 걸리는 지점

- 트랜잭션 안에서 외부 API를 호출하면 응답 대기 동안 행 락과 커넥션이 잡혀 다른 트랜잭션이 연쇄 대기한다. 외부 호출은 트랜잭션 밖으로 빼고, 원자성이 필요하면 Outbox 테이블에 발송 요청을 같이 커밋한 뒤 별도 워커가 전송한다.
- 수백만 행을 한 트랜잭션으로 갱신하면 WAL이 급증하고 락 보유 시간이 길어지며 VACUUM이 막힌다. 기본 키 범위로 나눠 처리한다.
- ==`@Transactional`은 프록시로 동작하므로 같은 클래스 안에서 자기 메서드를 호출하면 적용되지 않는다.== 기본적으로 unchecked 예외에서만 롤백하며 checked 예외는 `rollbackFor`를 지정해야 한다.
- Read Committed에서 조회 후 갱신하는 코드는 Lost Update에 노출된다. `SET balance = balance - 100`처럼 DB에서 계산하거나, `FOR UPDATE`로 잠그거나, 버전 컬럼으로 낙관적 락을 건다.
- Serializable과 Repeatable Read는 직렬화 실패를 정상 동작으로 반환한다. 재시도가 없으면 간헐적 오류로 보이고, 재시도 안에 멱등하지 않은 부수 효과가 있으면 중복 처리된다.

## 관련 글

- [내부 구조 — Storage Engine·페이지·WAL](/notes/postgresql/storage-engine-wal/)
- [MVCC·격리 수준·락](/notes/postgresql/mvcc-isolation-locking/)
- [복제·CAP·분산 트랜잭션](/notes/postgresql/replication-cap-saga/)
