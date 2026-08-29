---
title: "INSERT·UPDATE·DELETE 표준 패턴"
series: postgresql
part: "SQL 기초"
order: 10
summary: "쓰기 세 동사의 표준 형태와 RETURNING·UPSERT·소프트 삭제·안전 가드를 한 번에 정리한다."
tags: [PostgreSQL, INSERT, UPDATE, DELETE, RETURNING]
sources: [data-infra/2026-05-17-pg-insert-data.md, data-infra/2026-05-17-pg-update.md, data-infra/2026-05-17-pg-delete.md]
updated: 2026-08-29
---

쓰기 SQL은 실수가 곧바로 데이터 손실로 이어진다. WHERE 절이 빠진 UPDATE는 전체 행을 덮어쓰고, 외래 키를 모르고 실행한 DELETE는 에러로 멈추거나 자식 행 수만 건을 함께 지운다. 한 건씩 넣는 루프는 대량 적재에서 수십 배 느리고, 생성된 ID를 다시 SELECT로 찾는 코드는 왕복을 두 배로 만든다. 세 동사의 표준 형태와 PostgreSQL 고유 확장을 알아야 이런 문제를 구조적으로 피할 수 있다.

## 핵심 개념

세 문장은 공통으로 `RETURNING` 절을 지원한다. 변경이 끝난 행을 같은 문장의 결과로 돌려주므로 자동 생성된 ID나 갱신 시각을 추가 SELECT 없이 받고, CTE로 묶으면 삽입 결과를 후속 INSERT의 입력으로 연결하는 다단계 쓰기를 한 문장으로 처리한다.

**INSERT**는 대상 컬럼을 항상 명시한다. 생략하면 테이블 정의 순서에 의존하게 되어 컬럼 추가 시 문장이 깨진다. 생략된 컬럼에는 DEFAULT 또는 NULL이 들어간다. 여러 행은 VALUES 뒤에 튜플을 나열해 한 문장으로 넣는다. 파싱·왕복·트랜잭션이 한 번으로 줄어 단건 반복보다 훨씬 빠르다. `INSERT ... SELECT`는 이관·아카이브·집계 저장에 쓰고, 파일 단위 대량 적재는 `COPY`(서버 파일)나 psql의 `\copy`(클라이언트 파일)가 표준이다.

`ON CONFLICT`는 유일 제약 충돌 시의 동작을 지정하는 UPSERT 구문이다. `DO UPDATE SET col = EXCLUDED.col`에서 `EXCLUDED`는 삽입하려던 행을 가리키고, `DO NOTHING`은 충돌을 무시해 멱등 입력을 만든다. 충돌 대상 컬럼에는 유일 인덱스가 반드시 있어야 하며, 부분 유일 인덱스라면 `ON CONFLICT (email) WHERE deleted_at IS NULL`처럼 인덱스 조건을 함께 적어야 추론이 성립한다.

**UPDATE**는 `SET`에 어떤 표현식이든 올 수 있다. 현재 값 기반 계산, 다른 컬럼 참조, `COALESCE`, `CASE` 조건 분기가 모두 가능하다. 다른 테이블 값으로 갱신할 때는 `UPDATE ... FROM`이 표준이다. 서브쿼리 방식은 행마다 재실행되어 느리고, FROM 절은 조인 한 번으로 끝난다. `UPDATE ... LIMIT`는 없으므로 분할 처리는 `WITH targets AS (SELECT id ... LIMIT n FOR UPDATE)` 뒤 `WHERE id IN (SELECT id FROM targets)`로 우회한다.

**DELETE**는 다른 테이블 조건으로 지울 때 `USING` 절을 쓴다. 전체 삭제는 `TRUNCATE`가 훨씬 빠르지만 행 트리거가 발동하지 않고 다른 테이블이 참조 중이면 거부된다. 외래 키가 걸린 부모 행 삭제는 `ON DELETE` 옵션에 따라 거부(NO ACTION·RESTRICT), 연쇄 삭제(CASCADE), NULL 대입(SET NULL), 기본값 대입(SET DEFAULT) 중 하나로 동작한다.

Soft Delete는 `deleted_at TIMESTAMPTZ` 컬럼을 두고 삭제를 UPDATE로 대체하는 방식이며 사용자·주문·결제처럼 감사·복구가 필요한 데이터에 쓴다. 세션·캐시·오래된 로그는 Hard Delete, 테스트 초기화는 TRUNCATE가 맞다. 조회마다 `deleted_at IS NULL` 필터가 붙어야 하고, 유일 제약은 `WHERE deleted_at IS NULL` 부분 인덱스로 활성 행에만 걸어야 탈퇴 후 재가입이 가능하다. GDPR 같은 삭제 요청은 실제 삭제 또는 익명화가 필요하므로 Soft Delete만으로 충족되지 않는다.

## 코드

Spring Data JDBC의 `JdbcClient`로 INSERT + RETURNING을 실행해 생성된 ID를 바로 받고, 유일 충돌 시 UPSERT로 처리한다.

```java
@Repository
public class UserWriter {

    private final JdbcClient jdbc;

    public UserWriter(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long upsert(String email, String name) {
        return jdbc.sql("""
                INSERT INTO users (email, name)
                VALUES (:email, :name)
                ON CONFLICT (email) WHERE deleted_at IS NULL
                DO UPDATE SET name = EXCLUDED.name, updated_at = now()
                RETURNING id
                """)
            .param("email", email)
            .param("name", name)
            .query(Long.class)
            .single();
    }
}
```

JPA 엔티티에 Hibernate 6의 `@SQLDelete`와 `@SQLRestriction`을 붙여 `deleteById()`가 Soft Delete로 동작하고 모든 조회에 활성 필터가 자동으로 붙게 한다. 상태 전이 UPDATE는 현재 상태를 WHERE에 함께 넣어 잘못된 전이를 차단한다.

```java
@Entity
@Table(name = "users")
@SQLDelete(sql = "UPDATE users SET deleted_at = now() WHERE id = ?")
@SQLRestriction("deleted_at IS NULL")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String email;
    private String name;
    private Instant deletedAt;
}

public interface OrderRepository extends JpaRepository<Order, Long> {

    @Modifying(clearAutomatically = true)
    @Query("""
           UPDATE Order o SET o.status = 'SHIPPED'
           WHERE o.id = :id AND o.status = 'PAID'
           """)
    int markShipped(@Param("id") Long id);
}
```

대량 삭제는 CTE와 `LIMIT`으로 분할하고, 서비스에서 영향 행이 0이 될 때까지 트랜잭션을 나눠 반복한다.

```java
@Service
public class LogPurger {

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;

    public LogPurger(JdbcClient jdbc, PlatformTransactionManager tm) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(tm);
    }

    public void purgeOlderThan(Duration age) {
        int deleted;
        do {
            deleted = tx.execute(status -> jdbc.sql("""
                    WITH targets AS (
                        SELECT id FROM logs
                        WHERE created_at < now() - :age::interval
                        LIMIT 5000 FOR UPDATE SKIP LOCKED
                    )
                    DELETE FROM logs WHERE id IN (SELECT id FROM targets)
                    """)
                .param("age", age.toSeconds() + " seconds")
                .update());
        } while (deleted > 0);
    }
}
```

## 실무에서 걸리는 지점

- **WHERE 누락.** UPDATE·DELETE에서 가장 치명적인 사고다. 서버 설정으로 막는 기능은 없으므로 운영 콘솔에서는 `BEGIN` → `SELECT COUNT(*)`로 영향 행 확인 → 실행 후 행 수 대조 → `RETURNING` 검증 → `COMMIT` 또는 `ROLLBACK` 순서를 표준 절차로 고정한다.
- **한 트랜잭션에 수백만 건.** 락 유지 시간, WAL 양, 메모리를 한꺼번에 키운다. 1,000~10,000건 단위로 나누어 커밋하고, 파일 적재는 COPY로 대체하며, 오래된 데이터의 주기적 삭제는 파티션 DROP이 가장 싸다.
- **JPA 변경 감지의 조건.** Dirty Checking은 트랜잭션 안에서만 UPDATE를 만든다. `@Modifying` 벌크 쿼리는 영속성 컨텍스트를 우회하므로 `clearAutomatically`로 1차 캐시를 비우지 않으면 같은 트랜잭션에서 읽은 엔티티가 옛 값을 보여준다.
- **updated_at과 통계 갱신.** 갱신 시각은 BEFORE UPDATE 트리거로 강제해야 누락이 없다. 대량 삭제 뒤에는 플래너 통계가 낡아 실행 계획이 틀어지므로 `ANALYZE`를 직접 실행한다.
- **CASCADE 남용.** 부모 한 건 삭제로 자식 수만 건이 사라질 수 있다. 운영 테이블은 NO ACTION을 기본으로 두고, 연쇄 삭제가 의도된 종속 관계에만 CASCADE를 명시한다.

## 관련 글

- [SELECT와 JOIN 표준 패턴](/notes/postgresql/select-join/)
- [INSERT 깊이 — Bulk·COPY·UPSERT](/notes/postgresql/insert-bulk-copy-upsert/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
