---
title: "MVCC·격리 수준·락"
series: postgresql
part: "동시성"
order: 20
summary: "PostgreSQL이 MVCC 스냅샷으로 격리 수준을 구현하는 방식과, 락·Lost Update·Deadlock을 실무에서 다루는 기준을 정리한다."
tags: [PostgreSQL, MVCC, Isolation Level, Locking, Deadlock]
sources: [data-infra/2026-05-17-pg-mvcc-intro.md, data-infra/2026-05-17-pg-mvcc-isolation.md, 2026-05-03-db-eng-concurrency.md]
updated: 2026-08-29
---

여러 트랜잭션이 같은 행에 동시에 접근하면 Lost Update, Dirty Read, Non-Repeatable Read, Phantom Read가 발생한다. 초기 RDBMS는 이를 테이블 락으로 막았고, 쓰기 하나가 끝날 때까지 모든 읽기가 대기했다. PostgreSQL은 행의 여러 버전을 유지하는 MVCC로 읽기와 쓰기가 서로를 차단하지 않게 했다. ==다만 MVCC가 락을 없애는 것은 아니며, 격리 수준의 의미와 락이 걸리는 지점, 옛 버전 행의 운영 비용을 모르면 동시성 버그와 bloat가 함께 온다.==

## 핵심 개념

### MVCC와 xmin·xmax

MVCC(Multi-Version Concurrency Control)는 UPDATE를 제자리 덮어쓰기가 아니라 새 버전 추가와 옛 버전 무효화 표시로 처리한다. 각 행에는 시스템 컬럼 `xmin`(행을 만든 트랜잭션 ID)과 `xmax`(행을 무효화한 트랜잭션 ID, 살아 있으면 0)가 붙는다. DELETE는 `xmax`만 기록한다.

각 트랜잭션은 스냅샷 시점에 커밋된 행만 보고 이후 변경은 무시한다. 읽기는 락 없이 옛 버전을 읽고 쓰기는 새 버전을 만든다. Oracle, MySQL InnoDB도 같은 방식이며 SQL Server는 `READ_COMMITTED_SNAPSHOT` 옵션으로 켠다.

### 격리 수준과 스냅샷 시점

==격리 수준 차이는 스냅샷을 언제 찍는가의 차이다.== READ UNCOMMITTED를 지정해도 READ COMMITTED로 동작하며, Dirty Read는 어떤 수준에서도 발생하지 않는다.

| 수준 | 스냅샷 | Non-Repeatable | Phantom | Serialization Anomaly |
|---|---|---|---|---|
| READ COMMITTED (기본) | 문장마다 새로 | 발생 | 발생 | 발생 |
| REPEATABLE READ | 첫 문장 시점 고정 | 방지 | 방지 | 발생 |
| SERIALIZABLE | 고정 + SSI 충돌 검출 | 방지 | 방지 | 방지 |

REPEATABLE READ는 SQL 표준보다 강해서 Phantom Read까지 막는다. 대신 스냅샷 이후 다른 트랜잭션이 커밋한 행을 UPDATE하면 `could not serialize access due to concurrent update` 오류로 중단되므로 재시도가 필요하다. SERIALIZABLE은 SSI(Serializable Snapshot Isolation)로 구현되어, 읽기·쓰기 의존성을 추적하다 직렬 실행으로 나올 수 없는 결과가 감지되면 한쪽을 롤백한다. MySQL InnoDB 기본값은 REPEATABLE READ이므로 같은 SQL이 DB마다 다르게 동작한다.

### 여전히 락이 걸리는 곳

일반 SELECT는 락을 잡지 않지만 같은 행에 대한 두 UPDATE는 행 락으로 직렬화된다. `SELECT ... FOR UPDATE`는 읽는 시점에 배타 행 락을 잡아 다른 쓰기를 대기시키고, DDL은 테이블 수준 ACCESS EXCLUSIVE 락으로 모든 접근을 차단한다.

Lost Update 방지법은 세 가지다. 원자적 UPDATE(`SET val = val + 10`)로 읽기와 쓰기를 한 문장에 묶거나, `FOR UPDATE`로 비관적 락을 잡거나, version 컬럼을 WHERE에 넣는 낙관적 락으로 충돌 시 재시도한다. 충돌이 잦으면 비관적, 드물면 낙관적이 유리하다.

Deadlock은 두 트랜잭션이 서로의 락을 기다릴 때 생긴다. PostgreSQL은 `deadlock_timeout`(기본 1초) 후 한쪽을 롤백한다. 완전히 피할 수 없으므로 락 순서를 통일하고 재시도한다.

## 코드

재고 차감은 원자적 UPDATE 한 문장으로 처리한다. 영향 행 수 0은 재고 부족이다.

```java
@Repository
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Product p SET p.stock = p.stock - :qty " +
           "WHERE p.id = :id AND p.stock >= :qty")
    int decreaseStock(@Param("id") Long id, @Param("qty") int qty);
}

@Service
public class OrderService {

    private final ProductRepository productRepository;

    public OrderService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Transactional
    public void order(Long productId, int qty) {
        int updated = productRepository.decreaseStock(productId, qty);
        if (updated == 0) {
            throw new IllegalStateException("재고 부족: productId=" + productId);
        }
    }
}
```

여러 행은 항상 id 오름차순으로 잠가 Deadlock을 피한다. `@Lock(PESSIMISTIC_WRITE)`는 `FOR UPDATE`로 변환된다.

```java
@Repository
public interface AccountRepository extends JpaRepository<Account, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id IN :ids ORDER BY a.id")
    List<Account> findAllForUpdate(@Param("ids") Collection<Long> ids);
}

@Service
public class TransferService {

    private final AccountRepository accountRepository;

    public TransferService(AccountRepository accountRepository) {
        this.accountRepository = accountRepository;
    }

    @Transactional
    public void transfer(Long fromId, Long toId, long amount) {
        Map<Long, Account> locked = accountRepository
                .findAllForUpdate(List.of(fromId, toId)).stream()
                .collect(Collectors.toMap(Account::getId, a -> a));
        Account from = locked.get(fromId);
        Account to = locked.get(toId);
        if (from.getBalance() < amount) {
            throw new IllegalStateException("잔액 부족");
        }
        from.setBalance(from.getBalance() - amount);
        to.setBalance(to.getBalance() + amount);
    }
}
```

SERIALIZABLE 또는 낙관적 락 트랜잭션은 직렬화 실패와 버전 충돌을 재시도로 감싼다. `@Retryable`은 `spring-retry`와 `@EnableRetry`가 필요하다.

```java
@Entity
public class Coupon {
    @Id
    private Long id;
    private int remaining;
    @Version
    private long version;
    // getter, setter 생략
}

@Service
public class CouponService {

    private final CouponRepository couponRepository;

    public CouponService(CouponRepository couponRepository) {
        this.couponRepository = couponRepository;
    }

    @Retryable(
        retryFor = {
            CannotAcquireLockException.class,
            ObjectOptimisticLockingFailureException.class
        },
        maxAttempts = 3,
        backoff = @Backoff(delay = 50, multiplier = 2)
    )
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void issue(Long couponId) {
        Coupon coupon = couponRepository.findById(couponId).orElseThrow();
        if (coupon.getRemaining() <= 0) {
            throw new IllegalStateException("쿠폰 소진");
        }
        coupon.setRemaining(coupon.getRemaining() - 1);
    }
}
```

## 실무에서 걸리는 지점

- ==**오래 열린 트랜잭션이 bloat를 만든다.**== 스냅샷이 살아 있는 동안 생긴 옛 버전 행은 VACUUM이 회수하지 못한다. 방치된 `idle in transaction` 커넥션 하나가 테이블을 부풀린다. `idle_in_transaction_session_timeout`을 설정하고 트랜잭션을 짧게 끊는다.
- **트랜잭션 ID Wraparound.** 트랜잭션 ID는 32bit이며 약 20억 개를 지나면 행의 가시성이 뒤집힌다. autovacuum이 오래된 행을 frozen 처리해 막는데, 밀리면 DB가 쓰기를 거부한다. `age(datfrozenxid)`를 모니터링하고 autovacuum을 끄지 않는다.
- **SERIALIZABLE 남용.** 모든 트랜잭션에 걸면 SSI 추적 비용과 재시도가 처리량을 무너뜨린다. 일반 API는 READ COMMITTED, 보고서는 REPEATABLE READ, 돈·재고만 SERIALIZABLE에 재시도를 붙인다.
- **낙관적 락 예외를 삼키면 갱신이 사라진다.** `ObjectOptimisticLockingFailureException`을 catch만 하고 넘기면 변경이 유실된다. 재시도하거나 충돌을 알린다.
- **락 대기는 pg_stat_activity로 잡는다.** `wait_event_type = 'Lock'`인 세션과 `pg_blocking_pids(pid)`로 차단 관계를 확인한다. 작업 큐 처리에는 `FOR UPDATE SKIP LOCKED`를 쓴다.

## 관련 글

- [ACID·트랜잭션·격리 수준](/notes/postgresql/acid-transactions-isolation/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [운영 설치와 postgresql.conf](/notes/postgresql/production-install-config/)
