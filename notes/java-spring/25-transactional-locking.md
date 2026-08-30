---
title: "@Transactional 원리와 낙관/비관 락"
series: java-spring
part: "데이터"
order: 25
summary: "@Transactional은 원자성만 보장하며 동시 수정 충돌은 @Version 낙관적 락이나 @Lock 비관적 락으로 따로 막는다."
tags: [Spring, "@Transactional", JPA, 낙관적 락, 비관적 락]
sources: [spring/2026-05-16-transactional-annotation.md, spring/2026-05-26-jpa-optimistic-pessimistic-lock.md]
updated: 2026-08-29
---

계좌 이체는 출금과 입금이라는 두 번의 SQL로 이루어진다. 출금이 끝난 직후 예외가 발생하면 출금만 반영되고 입금은 누락된다. 여러 SQL을 하나의 단위로 묶어 모두 커밋되거나 모두 롤백되도록 보장하는 장치가 트랜잭션이고, Spring에서는 `@Transactional` 한 줄로 이를 선언한다. 그러나 트랜잭션은 한 작업 묶음의 원자성을 보장할 뿐, 다른 트랜잭션이 같은 행을 동시에 수정하는 것까지 막지 않는다. 재고 1개짜리 상품에 주문 두 건이 동시에 들어오면 둘 다 "1개 남음"을 읽고 각자 0으로 저장해 실제로는 2개가 팔린다. 이 갱신 손실(lost update)은 락으로 별도 처리해야 한다.

## 핵심 개념

트랜잭션은 ACID, 즉 원자성(Atomicity)·일관성(Consistency)·격리성(Isolation)·지속성(Durability)을 보장한다.

`@Transactional`은 Spring AOP 프록시로 동작한다. 컨테이너는 어노테이션이 붙은 빈 대신 프록시를 등록하고, 프록시가 메서드 호출 전에 `PlatformTransactionManager`로 트랜잭션을 시작한 뒤 정상 종료 시 커밋, 예외 시 롤백한다. Spring Boot가 JPA·JDBC에 맞는 트랜잭션 매니저를 자동 등록한다.

전파(Propagation)는 트랜잭션 메서드가 다른 트랜잭션 메서드를 호출할 때 결합 방식을 정한다. 기본값 `REQUIRED`는 기존 트랜잭션이 있으면 참여하고 없으면 새로 시작한다. `REQUIRES_NEW`는 기존 트랜잭션을 일시 중단하고 새 트랜잭션을 열어 감사 로그처럼 본 작업의 실패와 무관하게 커밋해야 할 때 쓴다. `NESTED`는 savepoint로 중첩하고, 나머지 `SUPPORTS`·`NOT_SUPPORTED`·`MANDATORY`·`NEVER`는 드물게 쓴다.

격리 수준(Isolation)은 `READ_UNCOMMITTED`, `READ_COMMITTED`, `REPEATABLE_READ`, `SERIALIZABLE` 순으로 강해진다. 기본값 `DEFAULT`는 DB 설정을 따르며 PostgreSQL은 READ_COMMITTED, MySQL InnoDB는 REPEATABLE_READ다. ==읽고 계산해서 다시 쓰는 패턴의 갱신 손실은 격리 수준만으로 막히지 않는다.==

롤백은 기본적으로 `RuntimeException`과 `Error`만 대상이며 checked exception은 던져도 커밋된다. `rollbackFor`로 대상을 넓히거나 `noRollbackFor`로 제외한다.

갱신 손실을 막는 락 전략은 두 가지다.

| | 낙관적 락 | 비관적 락 |
|---|---|---|
| 전제 | 충돌이 드물다 | 충돌이 잦다 |
| 방식 | `@Version` 컬럼으로 커밋 시점에 충돌 감지 | 읽는 시점에 `SELECT ... FOR UPDATE`로 행 잠금 |
| 충돌 시 | `ObjectOptimisticLockingFailureException`, 재시도 필요 | 뒤 트랜잭션이 대기 |
| 비용 | 락 대기 없음 | 대기·데드락·처리량 저하 |

낙관적 락은 엔티티를 읽을 때 version을 함께 읽고, UPDATE에 `WHERE version = ?` 조건을 붙인다. 그 사이 다른 트랜잭션이 version을 올렸으면 갱신 건수가 0이 되고 JPA가 예외를 던진다. 비관적 락의 `PESSIMISTIC_WRITE`는 행 배타 락으로 번역되어 먼저 잠근 트랜잭션이 커밋할 때까지 다른 트랜잭션의 읽기가 대기한다.

## 코드

송금 서비스에 `@Transactional`을 붙이고 checked exception도 롤백하도록 지정한다.

```java
@Service
public class TransferService {

    private final AccountRepository accountRepository;

    public TransferService(AccountRepository accountRepository) {
        this.accountRepository = accountRepository;
    }

    @Transactional(rollbackFor = Exception.class)
    public void transfer(Long from, Long to, long amount) throws IOException {
        accountRepository.withdraw(from, amount);
        accountRepository.deposit(to, amount);
    }
}
```

낙관적 락은 `@Version` 필드 하나로 활성화되며, 재시도는 트랜잭션 메서드 바깥에서 트랜잭션 전체를 다시 호출하는 구조여야 한다.

```java
@Entity
public class Product {
    @Id @GeneratedValue
    private Long id;
    private int stock;

    @Version
    private Long version;

    public void decreaseStock(int qty) {
        if (stock < qty) throw new IllegalStateException("재고 부족");
        stock -= qty;
    }
}

@Service
public class StockService {

    private final StockTxService stockTxService;

    public StockService(StockTxService stockTxService) {
        this.stockTxService = stockTxService;
    }

    public void decrease(Long productId, int qty) {
        for (int attempt = 1; ; attempt++) {
            try {
                stockTxService.decreaseOnce(productId, qty);
                return;
            } catch (ObjectOptimisticLockingFailureException e) {
                if (attempt >= 3) throw e;
            }
        }
    }
}

@Service
public class StockTxService {

    private final ProductRepository productRepository;

    public StockTxService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Transactional
    public void decreaseOnce(Long productId, int qty) {
        Product product = productRepository.findById(productId).orElseThrow();
        product.decreaseStock(qty);
    }
}
```

비관적 락은 리포지토리 조회 메서드에 `@Lock`을 붙이고 타임아웃 힌트를 함께 지정한 뒤, 반드시 트랜잭션 안에서 호출한다.

```java
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    @Query("select p from Product p where p.id = :id")
    Optional<Product> findByIdForUpdate(@Param("id") Long id);
}

@Service
public class PessimisticStockService {

    private final ProductRepository productRepository;

    public PessimisticStockService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Transactional
    public void decrease(Long productId, int qty) {
        Product product = productRepository.findByIdForUpdate(productId).orElseThrow();
        product.decreaseStock(qty);
    }
}
```

## 실무에서 걸리는 지점

- 자기 호출과 private 메서드. 같은 클래스 안에서 `this.save()`로 호출하면 프록시를 거치지 않아 트랜잭션이 열리지 않고, ==private 메서드의 `@Transactional`은 무시된다==. 위 코드에서 재시도 루프와 트랜잭션 메서드를 다른 빈으로 나눈 이유다.
- 예외 흡수. ==트랜잭션 메서드 안에서 try-catch로 예외를 삼키면 프록시는 정상 종료로 판단해 커밋한다.== 롤백하려면 `TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()`를 호출한다. 반대로 `REQUIRED`로 참여한 내부 트랜잭션의 예외를 바깥에서 잡으면 전체가 rollback-only가 되어 `UnexpectedRollbackException`이 난다.
- 재시도 위치. ==낙관적 락 재시도를 트랜잭션 안에서 돌리면 영속성 컨텍스트가 낡은 version을 계속 들고 있어 무한 실패한다.== 기존 테이블에 `@Version`을 추가할 때는 기존 행의 null version을 마이그레이션으로 0으로 채운다.
- 비관적 락 대기와 데드락. 락 타임아웃이 없으면 요청이 무한 대기하고, 두 트랜잭션이 서로의 행을 기다리면 데드락이 된다. `jakarta.persistence.lock.timeout` 힌트로 상한을 두고 여러 행은 항상 같은 순서로 잠근다.
- 락이 필요 없는 경우. 이메일 중복 가입처럼 유일성만 필요하면 unique 제약이 락보다 싸고 확실하다. 조회 전용 메서드는 `readOnly = true`로 더티 체킹을 끈다. 트랜잭션 경계는 서비스 레이어에 두고 컨트롤러나 리포지토리에는 붙이지 않는다.

## 관련 글

- [JDBC·DataSource·JdbcTemplate](/notes/java-spring/jdbc-jdbctemplate/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
- [계층 설계 — 서비스 레이어 분리](/notes/java-spring/layered-architecture/)
