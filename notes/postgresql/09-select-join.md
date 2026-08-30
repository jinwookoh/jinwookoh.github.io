---
title: "SELECT와 JOIN 표준 패턴"
series: postgresql
part: "SQL 기초"
order: 9
summary: "SELECT 8개 절의 순서와 WHERE·정렬·페이지네이션 패턴, JOIN 종류 선택 기준과 ON·WHERE 차이를 정리한다"
tags: [PostgreSQL, SELECT, JOIN, LATERAL, Pagination]
sources: [data-infra/2026-05-17-pg-select.md, data-infra/2026-05-17-pg-join.md]
updated: 2026-08-29
---

관계형 데이터베이스는 한 사실을 한 테이블에만 저장한다. 사용자는 users, 주문은 orders에 나뉘어 있으므로 "누가 무엇을 주문했는가"를 알려면 두 테이블을 합쳐야 한다. ==SELECT의 절 순서와 JOIN 종류를 정확히 모르면 어떤 10건인지 알 수 없는 목록 API, 깊은 OFFSET으로 느려지는 페이지네이션, 조건 한 줄 때문에 LEFT JOIN이 INNER JOIN으로 바뀌는 조회 결과가 만들어진다.==

## 핵심 개념

### SELECT 절의 순서와 실행 순서

SELECT 문은 `SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT → OFFSET` 순서로 작성한다. 실제 실행은 `FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT` 순이므로, WHERE에서는 SELECT의 별칭을 참조할 수 없고 ORDER BY에서는 참조할 수 있다. 운영 코드에서는 `SELECT *` 대신 컬럼을 명시한다. 컬럼이 추가되면 매핑 코드가 깨진다.

### WHERE 조건의 종류

비교 연산자와 `AND`·`OR`·`NOT`이 기본이다. `IN`은 여러 값 중 하나를 고르며 서브쿼리를 넣을 수 있고, `BETWEEN a AND b`는 `>= a AND <= b`의 단축으로 양 끝을 포함한다. `LIKE`는 `%`(임의 길이)와 `_`(한 글자) 와일드카드를 쓰고, `ILIKE`는 PostgreSQL이 제공하는 대소문자 무시 버전이다. 정규식은 `~`·`~*`·`!~` 연산자로 지원한다. NULL은 `= NULL`로 비교하면 결과가 NULL이 되어 거짓으로 취급되므로 `IS NULL`을 써야 한다. NULL 대체에는 `COALESCE`, 특정 값을 NULL로 바꿀 때는 `NULLIF`를 쓴다.

### 정렬과 페이지네이션

ORDER BY의 기본은 ASC이고, `NULLS FIRST`·`NULLS LAST`로 NULL 위치를 지정한다(기본은 ASC일 때 NULLS LAST, DESC일 때 NULLS FIRST). LIMIT은 반드시 ORDER BY와 함께 써야 결정적인 결과를 얻는다. OFFSET은 건너뛴 행을 모두 읽고 버리므로 페이지가 깊어질수록 느려진다. 큰 테이블은 마지막으로 본 키를 조건으로 넘기는 커서 방식(`WHERE id > :lastId ORDER BY id LIMIT n`)을 쓴다. `DISTINCT ON (col)`은 그룹별 첫 행을 가져오는 PostgreSQL 확장으로, ORDER BY 선두 컬럼과 일치해야 한다.

### JOIN 종류

| 종류 | 결과 | 용도 |
|---|---|---|
| INNER JOIN | 양쪽 모두 매칭되는 행 | 관계가 반드시 존재하는 조회 |
| LEFT JOIN | 왼쪽 전부 보존, 오른쪽 없으면 NULL | 목록 + 있을 수도 있는 부속 정보 |
| RIGHT JOIN | 오른쪽 보존 | 테이블 순서를 바꿔 LEFT로 대체 |
| FULL OUTER JOIN | 양쪽 보존 | 양쪽 불일치를 모두 확인할 때 |
| CROSS JOIN | m × n 데카르트 곱 | 모든 조합 생성 |
| LATERAL | 서브쿼리에서 외부 컬럼 참조 | 그룹별 Top-N |

`INNER`는 생략 가능하다. 같은 테이블에 두 별칭을 붙이는 SELF JOIN은 계층 구조에 쓴다. `USING (col)`은 양쪽 컬럼 이름이 같을 때 `ON`을 줄인 형태다. `NATURAL JOIN`은 이름이 같은 모든 컬럼을 자동 매칭하므로 컬럼이 추가되면 의미가 바뀐다.

### ON과 WHERE의 차이

ON 조건은 매칭 규칙에만 영향을 주고, WHERE는 JOIN이 끝난 뒤 결과를 필터링한다. ==LEFT JOIN에서 오른쪽 컬럼 조건을 WHERE에 두면 NULL로 채워진 행이 제거되어 INNER JOIN과 같은 결과가 된다.==

### JOIN 실행 방식

플래너는 Nested Loop(작은 집합), Hash Join(중간 규모), Merge Join(정렬 인덱스가 있을 때) 중 하나를 통계 기반으로 고른다. EXPLAIN으로 확인하며, 결정 변수는 JOIN 키의 인덱스 유무다.

## 코드

목록 조회의 표준 형태. ON 절 조건으로 결제 완료 주문만 붙이되 주문이 없는 사용자도 유지한다.

```sql
SELECT
    u.id,
    u.name,
    COALESCE(u.email, 'no-email') AS email,
    CASE
        WHEN u.age < 18 THEN 'MINOR'
        WHEN u.age < 65 THEN 'ADULT'
        ELSE 'SENIOR'
    END AS age_group,
    o.id      AS order_id,
    o.amount
FROM users u
LEFT JOIN orders o
    ON o.user_id = u.id
   AND o.status = 'PAID'
WHERE u.deleted_at IS NULL
  AND u.name ILIKE 'a%'
ORDER BY u.created_at DESC, u.id DESC
LIMIT 20;
```

각 사용자의 최근 주문 3건을 붙이는 그룹별 Top-N. 서브쿼리가 외부의 `u.id`를 참조한다.

```sql
SELECT u.name, r.id, r.amount, r.created_at
FROM users u
LEFT JOIN LATERAL (
    SELECT id, amount, created_at
    FROM orders
    WHERE user_id = u.id
    ORDER BY created_at DESC
    LIMIT 3
) r ON true;
```

Spring Data JPA의 커서 페이지네이션과 fetch join. 파생 쿼리는 단순 조건까지만 쓰고 JOIN은 JPQL로 명시한다.

```java
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserRepository extends JpaRepository<User, Long> {

    // SELECT ... WHERE city = ? AND age > ?
    List<User> findByCityAndAgeGreaterThan(String city, int age);

    // 커서 페이지네이션: Pageable의 page 번호는 0으로 고정하고 size만 사용
    @Query("""
            SELECT u FROM User u
            WHERE u.deletedAt IS NULL AND u.id > :lastId
            ORDER BY u.id ASC
            """)
    List<User> findNextPage(@Param("lastId") long lastId, Pageable pageable);

    // fetch join으로 N+1 회피
    @Query("SELECT u FROM User u LEFT JOIN FETCH u.orders WHERE u.id = :id")
    Optional<User> findByIdWithOrders(@Param("id") Long id);
}
```

## 실무에서 걸리는 지점

- ==**LEFT JOIN이 INNER JOIN으로 바뀌는 문제.**== 오른쪽 테이블 컬럼 조건을 WHERE에 두면 NULL 행이 걸러진다. 왼쪽을 보존해야 하는 조건은 ON 절에 두거나 `OR o.id IS NULL`로 NULL을 명시적으로 허용한다.
- **선행 와일드카드 LIKE.** `LIKE '%alice'`는 B-Tree 인덱스를 쓰지 못해 전체 스캔이 된다. 접두 검색으로 바꾸거나 pg_trgm 기반 GIN 인덱스를 검토한다.
- **깊은 OFFSET.** `LIMIT 10 OFFSET 1000000`은 백만 행을 읽고 버린다. 커서 방식으로 바꾸고, ORDER BY 키에 유일 컬럼을 덧붙여 페이지 경계에서 행이 중복·누락되지 않게 한다.
- **JOIN 조건 누락과 컬럼 모호성.** 쉼표 구분(`FROM users, orders`)에 WHERE를 빠뜨리면 데카르트 곱이 그대로 실행된다. 같은 이름의 컬럼은 `column reference "id" is ambiguous` 오류가 나므로 항상 별칭으로 한정한다.
- **JPA의 N+1과 fetch join 제약.** 지연 로딩 컬렉션을 반복문에서 접근하면 행 수만큼 쿼리가 나간다. fetch join으로 한 번에 가져오되, 컬렉션 fetch join에 Pageable을 결합하면 메모리 페이징이 되므로 `@BatchSize`나 별도 조회로 분리한다.

## 관련 글

- [SQL 기초 — 어휘 구조와 문법](/notes/postgresql/sql-basics-syntax/)
- [쿼리 구조 — SELECT 절·FROM·WHERE·GROUP BY](/notes/postgresql/query-structure/)
- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
