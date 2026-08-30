---
title: "쿼리 구조 — SELECT 절·FROM·WHERE·GROUP BY"
series: postgresql
part: "DDL과 DML"
order: 15
summary: "SELECT 문의 작성 순서와 실행 순서가 다르다는 사실에서 출발해 각 절의 역할과 인덱스·페이지네이션 함정을 정리한다"
tags: [PostgreSQL, SELECT, GROUP BY, LATERAL, Pagination]
sources: [data-infra/2026-05-17-pg-queries-overview.md, data-infra/2026-05-17-pg-queries-select-lists.md, data-infra/2026-05-17-pg-queries-table-expressions.md, data-infra/2026-05-17-pg-queries.md]
updated: 2026-08-29
---

SELECT 문은 절이 아홉 개까지 붙는 긴 문장이지만, 각 절이 어떤 순서로 평가되고 무엇을 입력으로 받는지 모르면 오류와 성능 문제가 반복된다. WHERE에서 SELECT 별칭을 참조해 오류가 나고, HAVING에 행 필터를 넣어 인덱스를 버리며, OFFSET 기반 페이지네이션이 뒤 페이지로 갈수록 느려지는 현상이 대표적이다. 세 문제 모두 문법이 아니라 구조를 이해하지 못해서 생긴다.

## 핵심 개념

SELECT 문의 작성 순서는 WITH → SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT → OFFSET이다. 실행 순서는 다르다. FROM과 JOIN이 데이터 소스를 결정하고, WHERE가 행을 거르고, GROUP BY가 묶고, HAVING이 그룹을 거른 뒤에야 SELECT 목록의 표현식이 계산된다. 그 다음 DISTINCT, ORDER BY, LIMIT·OFFSET이 적용된다. WHERE가 SELECT보다 먼저 실행되므로 SELECT 별칭을 WHERE에서 쓸 수 없고, ORDER BY는 SELECT 이후라서 별칭을 쓸 수 있다.

FROM 절은 테이블만 받는 것이 아니다. 서브쿼리(인라인 뷰), `generate_series` 같은 집합 반환 함수(SRF), `VALUES` 목록, JOIN 결합, `TABLESAMPLE`, 상속 자식을 제외하는 `ONLY`가 모두 테이블 표현식이다. JOIN 조건은 `ON`이 표준이고, `USING (col)`은 같은 이름 컬럼을 한 번만 결과에 남기는 축약이며, `NATURAL JOIN`은 같은 이름 컬럼을 전부 자동 매칭하므로 컬럼이 추가되면 결과가 바뀐다. FROM 안의 서브쿼리는 기본적으로 바깥 테이블의 컬럼을 볼 수 없고, `LATERAL`을 붙여야 앞에 나온 테이블의 컬럼을 참조할 수 있다. 사용자별 최근 N건 같은 Top-N per group이 LATERAL의 대표 용도다.

WHERE는 비교·범위·IN·LIKE·정규식 연산자를 AND·OR로 결합한다. AND가 OR보다 우선순위가 높으므로 섞어 쓸 때는 괄호로 의도를 명시한다. NULL은 `=`로 비교되지 않으므로 `IS DISTINCT FROM`을 쓰면 NULL을 값처럼 다룰 수 있다. 인덱스는 `col = 1`, `col > 100`, `col LIKE 'A%'`처럼 컬럼이 그대로 노출된 조건에서만 쓰이고, `LOWER(col) = 'a'`나 `col + 1 = 100`처럼 컬럼을 가공하면 표현식 인덱스가 없는 한 순차 스캔이 된다.

GROUP BY는 SELECT의 비집계 컬럼을 모두 포함해야 하며, PostgreSQL은 이를 어기면 오류를 낸다. `ROLLUP`은 계층 소계와 총합, `CUBE`는 모든 차원 조합, `GROUPING SETS`는 지정한 조합만 한 번의 스캔으로 집계한다. 소계 행의 NULL은 원본 NULL과 구분되지 않으므로 `GROUPING(col)` 함수로 판별한다. 집계 함수에는 `FILTER (WHERE ...)`를 붙여 조건부 집계를 CASE 없이 표현하고, `STRING_AGG`·`ARRAY_AGG`·`JSONB_AGG`는 그룹을 문자열·배열·JSON으로 접는다. HAVING은 집계 결과에 대한 필터이고, WHERE는 그룹 전 행 필터다. 집계 없이 표현할 수 있는 조건은 WHERE에 두어야 인덱스와 조기 필터링의 이익을 얻는다.

`DISTINCT ON (col)`은 ORDER BY 첫 컬럼과 일치시켜 그룹별 첫 행만 남기는 PostgreSQL 확장이다. 집합 연산 UNION·INTERSECT·EXCEPT는 컬럼 수와 타입이 같아야 하고, ORDER BY는 마지막에 한 번만 붙는다. UNION은 중복 제거를 위해 정렬이나 해시가 필요하므로 중복이 없는 것이 확실하면 UNION ALL을 쓴다.

## 코드

사용자별 최근 주문 3건을 LATERAL로 붙이고, 조건부 집계를 FILTER로 계산하는 쿼리다.

```sql
WITH active_users AS (
    SELECT id, name FROM users WHERE deleted_at IS NULL
)
SELECT u.name,
       recent.id        AS order_id,
       recent.amount,
       stat.paid_count,
       stat.canceled_count
FROM active_users u
LEFT JOIN LATERAL (
    SELECT id, amount FROM orders
    WHERE user_id = u.id
    ORDER BY created_at DESC LIMIT 3
) recent ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE status = 'PAID')     AS paid_count,
           COUNT(*) FILTER (WHERE status = 'CANCELED') AS canceled_count
    FROM orders WHERE user_id = u.id
) stat ON true;
```

국가·도시 소계와 총합을 한 번에 구하고, 소계 행을 `GROUPING`으로 구분한다.

```sql
SELECT country, city,
       GROUPING(country) AS is_total,
       GROUPING(city)    AS is_country_subtotal,
       SUM(amount)       AS total_amount
FROM orders
WHERE created_at >= DATE '2026-08-01'
GROUP BY ROLLUP (country, city)
ORDER BY country NULLS LAST, city NULLS LAST;
```

Spring Boot 3.x의 `JdbcClient`로 키셋 페이지네이션을 구현한 저장소다. `(created_at, id)` 행 비교로 정렬 키가 겹치는 행도 빠짐없이 넘어간다.

```java
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class OrderQueryRepository {

    private final JdbcClient jdbc;

    public OrderQueryRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record OrderRow(long id, long userId, int amount, Instant createdAt) {}

    public List<OrderRow> findPage(long userId, Instant cursorAt, Long cursorId, int size) {
        String sql = """
            SELECT id, user_id, amount, created_at
            FROM orders
            WHERE user_id = :userId
              AND (:cursorAt::timestamptz IS NULL
                   OR (created_at, id) < (:cursorAt, :cursorId))
            ORDER BY created_at DESC, id DESC
            LIMIT :size
            """;
        return jdbc.sql(sql)
                .param("userId", userId)
                .param("cursorAt", cursorAt)
                .param("cursorId", cursorId)
                .param("size", size)
                .query(OrderRow.class)
                .list();
    }
}
```

## 실무에서 걸리는 지점

- **스칼라 서브쿼리의 N+1**: SELECT 목록 안의 `(SELECT COUNT(*) FROM orders WHERE user_id = u.id)`는 바깥 행 수만큼 실행된다. LEFT JOIN + GROUP BY 또는 LATERAL로 바꾸고 EXPLAIN으로 실행 계획을 확인한다.
- **깊은 OFFSET**: `LIMIT 20 OFFSET 100000`은 앞의 십만 행을 읽고 버린다. 정렬 키를 커서로 넘기는 키셋 페이지네이션으로 바꾸면 페이지 위치와 무관하게 비용이 일정하다. Spring Data의 `Pageable`은 내부적으로 OFFSET을 쓰므로 대용량 목록에는 맞지 않는다.
- **ORDER BY와 인덱스 방향**: `ORDER BY created_at DESC LIMIT 10`은 같은 방향의 인덱스가 있으면 정렬 없이 인덱스 끝에서 바로 읽는다. WHERE 컬럼과 ORDER BY 컬럼을 하나의 복합 인덱스 `(user_id, created_at DESC)`에 넣으면 필터와 정렬을 모두 인덱스로 처리한다.
- **join_collapse_limit**: JOIN이 기본값 8개를 넘으면 계획자가 순서 탐색을 포기하고 작성 순서대로 결합한다. 한도를 올리면 계획 시간이 늘어나므로, 큰 쿼리는 CTE로 분해하는 편이 계획자와 사람 모두에게 낫다.
- **STRING_AGG 순서 비결정**: 집계 안에 ORDER BY를 명시하지 않으면 연결 순서가 실행 계획에 따라 달라진다. `STRING_AGG(name, ', ' ORDER BY created_at)`처럼 정렬을 지정한다.

## 관련 글

- [SELECT와 JOIN 표준 패턴](/notes/postgresql/select-join/)
- [뷰·윈도우 함수·고급 SQL](/notes/postgresql/views-window-functions/)
- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
