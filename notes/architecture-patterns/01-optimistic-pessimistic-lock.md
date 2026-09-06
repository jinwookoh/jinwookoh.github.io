---
title: "동시성 제어 — 비관적 락과 낙관적 락"
series: architecture-patterns
part: "데이터"
order: 1
summary: "같은 행을 동시에 갱신할 때 갱신 손실을 막는 두 방식과 충돌 빈도에 따른 선택 기준"
tags: [Pessimistic Lock, Optimistic Lock, JPA, "@Version", SELECT FOR UPDATE]
sources: [https://jinwookoh.tistory.com/229]
updated: 2026-09-06
---

재고가 1개 남은 상품에 두 요청이 동시에 들어오면 두 트랜잭션이 각각 재고 1을 읽고 각각 0으로 갱신한다. 두 요청 모두 성공 응답을 받지만 실제로는 재고 하나로 두 건이 팔린 셈이다. 나중에 커밋한 쪽이 먼저 커밋한 쪽의 변경을 덮어쓰는 이 현상을 갱신 손실(lost update)이라고 한다. 관계형 데이터베이스의 기본 격리 수준(READ COMMITTED, MySQL의 REPEATABLE READ 포함)은 이 문제를 막아주지 않는다. 읽기와 쓰기 사이의 간격을 어떻게 다룰지는 애플리케이션이 결정해야 하고, 그 선택지가 비관적 락과 낙관적 락이다.

## 핵심 개념

비관적 락은 충돌이 일어난다고 가정하고 읽는 시점에 행을 잠근다. `SELECT ... FOR UPDATE`가 대표적이며, 락을 잡은 트랜잭션이 커밋하거나 롤백할 때까지 같은 행을 잠그려는 다른 트랜잭션은 대기한다. 제어 주체는 데이터베이스이고, 잠금 범위와 대기 방식은 DB 엔진의 락 구현을 따른다. JPA에서는 `LockModeType.PESSIMISTIC_WRITE`가 `FOR UPDATE`로, `PESSIMISTIC_READ`가 `FOR SHARE`로 번역된다.

낙관적 락은 충돌이 드물다고 가정하고 잠그지 않는다. 대신 엔티티에 버전 컬럼을 두고, 갱신 시 `UPDATE ... SET version = 2 WHERE id = ? AND version = 1`처럼 읽었을 때의 버전을 조건에 포함한다. 그 사이 다른 트랜잭션이 버전을 올렸다면 갱신된 행 수가 0이 되고, JPA는 이를 `OptimisticLockException`으로 보고한다. 충돌 감지는 flush 시점에 일어나며, 실패한 쪽은 트랜잭션을 롤백하고 다시 읽어서 재시도해야 한다.

| 구분 | 비관적 락 | 낙관적 락 |
|---|---|---|
| 제어 주체 | 데이터베이스(행 잠금) | 애플리케이션(버전 비교) |
| 충돌 시 동작 | 대기 후 순차 처리 | 예외 발생, 재시도 필요 |
| 데드락 | 발생 가능 | 없음 |
| 유리한 상황 | 충돌이 잦고 재시도 비용이 큰 경우 | 충돌이 드물고 읽기가 많은 경우 |

두 방식은 서로 다른 질문에 답한다. 비관적 락은 충돌을 얼마나 확실히 막을 것인가에, 낙관적 락은 충돌이 없는 대부분의 요청에 얼마나 비용을 물리지 않을 것인가에 최적화되어 있다. 충돌률이 높은 곳에 낙관적 락을 쓰면 재시도가 반복되어 비관적 락보다 느려지고, 충돌이 거의 없는 곳에 비관적 락을 쓰면 일어나지도 않을 충돌을 막느라 모든 요청이 직렬화된다.

## 코드

비관적 락은 조회 메서드에 `@Lock`을 붙이면 된다. 대기 상한은 `jakarta.persistence.lock.timeout` 힌트로 주는데, 0은 NOWAIT로 번역되지만 임의의 밀리초 값을 지원하는지는 DB마다 다르다(Oracle은 지원, MySQL과 PostgreSQL은 NOWAIT와 SKIP LOCKED만 지원).

```java
public interface TicketRepository extends JpaRepository<Ticket, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "0"))
    @Query("select t from Ticket t where t.id = :id")
    Optional<Ticket> findByIdForUpdate(@Param("id") Long id);
}

@Service
@RequiredArgsConstructor
public class TicketService {

    private final TicketRepository ticketRepository;

    @Transactional
    public void buy(Long ticketId) {
        Ticket ticket = ticketRepository.findByIdForUpdate(ticketId)
                .orElseThrow(() -> new EntityNotFoundException("ticket " + ticketId));
        ticket.decreaseStock();   // 커밋 시점까지 이 행은 잠긴 상태
    }
}
```

낙관적 락은 `@Version` 필드 하나로 켜진다. 값은 Hibernate가 관리하므로 애플리케이션이 직접 바꾸지 않는다.

```java
@Entity
public class Ticket {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private int stock;

    @Version
    private Long version;

    public void decreaseStock() {
        if (stock <= 0) {
            throw new IllegalStateException("sold out");
        }
        stock--;
    }
}
```

재시도는 트랜잭션 바깥에서 감싼다. Spring이 던지는 예외는 `ObjectOptimisticLockingFailureException`이며, 트랜잭션 경계를 가진 빈과 재시도 루프를 다른 빈으로 분리해야 매 시도마다 새 트랜잭션과 새 영속성 컨텍스트가 만들어진다.

```java
@Service
@RequiredArgsConstructor
public class TicketFacade {

    private final TicketService ticketService;   // @Transactional 메서드를 가진 별도 빈

    public void buyWithRetry(Long ticketId) {
        int attempts = 0;
        while (true) {
            try {
                ticketService.buy(ticketId);
                return;
            } catch (ObjectOptimisticLockingFailureException e) {
                if (++attempts >= 3) {
                    throw e;
                }
            }
        }
    }
}
```

## 실무에서 걸리는 지점

- ==낙관적 락 재시도를 `@Transactional` 메서드 안에서 try-catch로 돌리면 재시도가 동작하지 않는다.== 예외가 발생한 시점에 트랜잭션은 이미 rollback-only로 표시되고 영속성 컨텍스트에는 낡은 엔티티가 남아 있어, 같은 트랜잭션 안의 재시도는 반복해서 실패하거나 커밋 시 `UnexpectedRollbackException`으로 끝난다. 재시도는 트랜잭션 밖 계층에서 한다.
- ==`FOR UPDATE`의 WHERE 조건이 인덱스를 타지 못하면 MySQL InnoDB는 행이 아니라 스캔한 범위 전체를 잠근다.== 한 건을 잠그려던 쿼리가 테이블 전체를 직렬화하고, 다른 요청이 락 대기 타임아웃으로 쏟아지는 형태로 장애가 드러난다.
- 비관적 락은 트랜잭션이 끝날 때까지 유지된다. 락을 잡은 채 외부 API 호출이나 메시지 발행처럼 응답 시간이 불확실한 작업을 하면 그 시간만큼 뒤의 요청이 모두 대기한다. 잠금 구간은 읽기, 검증, 갱신만 남기고 최소화한다.
- 여러 행을 잠글 때는 모든 코드 경로에서 같은 순서로 잠근다. A→B 순서와 B→A 순서가 섞이면 데드락이 발생하며, DB가 한쪽을 강제 롤백하므로 애플리케이션은 이 예외도 재시도 대상으로 다뤄야 한다.
- ==`@Modifying` 벌크 UPDATE나 네이티브 쿼리는 `@Version` 검사를 거치지 않는다.== 같은 테이블을 벌크 쿼리와 엔티티 갱신이 함께 수정하면 버전 조건을 우회한 갱신 손실이 조용히 발생한다. 벌크 쿼리를 쓴다면 `version = version + 1`을 직접 포함하거나, `UPDATE ... SET stock = stock - 1 WHERE id = ? AND stock > 0`처럼 조건 자체를 원자적으로 만든다.

## 관련 글

- [페이지네이션 — 오프셋과 커서](/notes/architecture-patterns/pagination/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
- [사가 — 코레오그래피와 오케스트레이션](/notes/architecture-patterns/saga/)
