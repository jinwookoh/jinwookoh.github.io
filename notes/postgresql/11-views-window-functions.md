---
title: "뷰·윈도우 함수·고급 SQL"
series: postgresql
part: "SQL 기초"
order: 11
summary: "반복되는 쿼리는 VIEW로 이름을 붙이고, 행을 줄이지 않는 그룹 계산은 윈도우 함수와 CTE로 푼다"
tags: [PostgreSQL, VIEW, MATERIALIZED VIEW, Window Function, CTE]
sources: [data-infra/2026-05-17-pg-views.md, data-infra/2026-05-17-pg-window-advanced.md]
updated: 2026-08-29
---

같은 JOIN과 집계를 애플리케이션 곳곳에서 반복하면 수정 지점이 흩어지고, Soft Delete의 `deleted_at IS NULL` 필터는 한 곳만 빠져도 삭제된 데이터가 노출된다. 무거운 통계를 대시보드가 열릴 때마다 원본에서 다시 계산하면 비용이 조회 횟수에 비례해 늘어난다. "사용자별 상위 3개 주문"이나 "전일 대비 증감"처럼 그룹 맥락을 유지한 채 행마다 값을 붙이는 요구는 GROUP BY로 표현할 수 없다. ==이를 해결하는 도구가 뷰, MATERIALIZED VIEW, 윈도우 함수, CTE다.==

## 핵심 개념

### VIEW — 저장된 쿼리에 이름을 붙인 것

`CREATE VIEW name AS SELECT ...`는 쿼리 정의만 저장한다. 조회 시 뷰 정의와 바깥 쿼리를 합쳐 하나의 SQL로 실행하므로 항상 원본의 현재 상태를 반영하고, 성능도 원본 쿼리와 같다. 뷰 자체에는 인덱스를 만들 수 없다.

용도는 복잡한 JOIN·집계의 추상화, 민감 컬럼을 뺀 뷰만 GRANT 하는 권한 분리, Soft Delete 필터 고정, 컬럼명 변경 후 옛 인터페이스를 유지하는 마이그레이션 호환이다.

`CREATE OR REPLACE VIEW`는 기존 컬럼을 유지한 채 끝에 컬럼을 추가하는 변경만 허용하고, 삭제나 이름 변경은 DROP 후 재생성이다. 단일 테이블을 JOIN·GROUP BY·집계·DISTINCT 없이 참조하는 단순 뷰는 INSERT·UPDATE·DELETE가 원본으로 자동 변환되고, 그 외의 뷰는 읽기 전용이라 INSTEAD OF 트리거가 필요하다.

### MATERIALIZED VIEW — 결과를 저장하는 뷰

쿼리 결과를 실제 테이블처럼 저장한다. 조회가 빠르고 인덱스도 만들 수 있지만 원본 변경을 따라가지 않으므로 `REFRESH MATERIALIZED VIEW`로 다시 계산해야 한다.

| | VIEW | MATERIALIZED VIEW |
|---|---|---|
| 저장 대상 | 정의만 | 정의 + 결과 데이터 |
| 신선도 | 실시간 | REFRESH 시점 |
| 인덱스 | 불가 | 가능 |

기본 REFRESH는 ACCESS EXCLUSIVE 락을 잡아 갱신 중 SELECT까지 막는다. `REFRESH ... CONCURRENTLY`는 차이만 반영하므로 갱신 중에도 조회가 가능하지만, 모든 행을 식별하는 UNIQUE 인덱스가 있어야 하고 첫 REFRESH 전에는 쓸 수 없다. 내장 스케줄러는 없으므로 `pg_cron`, OS cron, Spring `@Scheduled` 중 하나로 주기 실행한다.

### 윈도우 함수 — 행을 줄이지 않는 그룹 계산

==GROUP BY는 그룹당 한 행을 남기지만, 윈도우 함수는 원래 행을 유지하면서 각 행에 그룹 맥락의 계산값을 붙인다.== `함수() OVER (PARTITION BY 그룹 ORDER BY 정렬 [프레임])` 형태로, PARTITION BY가 계산 단위를 나누고 ORDER BY가 파티션 안의 순서를 정하며 `ROWS BETWEEN ... AND ...` 프레임이 집계 대상 행의 범위를 제한한다.

순위 함수는 동률 처리가 다르다. 금액 50000·40000·40000·30000에 대해 `ROW_NUMBER()`는 1, 2, 3, 4, `RANK()`는 1, 2, 2, 4, `DENSE_RANK()`는 1, 2, 2, 3을 돌려준다. `LAG()`·`LEAD()`는 이전·다음 행 값을, `SUM()`·`AVG()` 같은 집계 함수는 OVER와 함께 쓰면 파티션 합·평균을, ORDER BY까지 주면 누적값을 각 행에 붙인다.

윈도우 함수는 WHERE·GROUP BY·HAVING이 끝난 뒤 SELECT 단계에서 계산되므로 같은 쿼리의 WHERE에서 결과를 참조할 수 없다. 필터링하려면 서브쿼리나 CTE로 감싼다.

### CTE와 재귀 CTE

`WITH name AS (...)`는 쿼리 안의 임시 결과 집합에 이름을 붙여 여러 단계를 위에서 아래로 읽히게 만들며, 윈도우 결과로 필터링하는 그룹별 TOP-N의 표준 형태다. PostgreSQL 12부터 한 번만 참조되는 CTE는 본문에 인라인되고, 실행을 분리하려면 `MATERIALIZED`를 붙인다.

`WITH RECURSIVE`는 앵커 쿼리와 재귀 쿼리를 UNION ALL로 연결해 조직도·카테고리 트리처럼 깊이를 모르는 계층을 순회한다. 재귀 쿼리가 행을 더 만들지 않을 때 끝나므로 종료 조건이 필수다. 테이블 상속(`INHERITS`)은 선언적 파티셔닝이 대체했다.

## 코드

일별 매출 MATERIALIZED VIEW와 CONCURRENTLY 갱신용 UNIQUE 인덱스, pg_cron 스케줄을 정의한다.

```sql
CREATE MATERIALIZED VIEW dashboard_daily_revenue AS
SELECT
    DATE(o.created_at) AS day,
    p.category         AS category,
    COUNT(*)           AS orders,
    SUM(o.amount)      AS revenue
FROM orders o
JOIN products p ON o.product_id = p.id
WHERE o.status = 'PAID'
GROUP BY DATE(o.created_at), p.category;

CREATE UNIQUE INDEX idx_dashboard_day_cat
    ON dashboard_daily_revenue (day, category);

-- 첫 REFRESH는 CONCURRENTLY 없이 실행한다
REFRESH MATERIALIZED VIEW dashboard_daily_revenue;

SELECT cron.schedule('refresh-dashboard', '0 3 * * *',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_daily_revenue');
```

사용자별 순위, 전일 대비 증감, 누적 매출을 윈도우 함수로 계산한다.

```sql
SELECT user_id, id, amount,
       RANK() OVER (PARTITION BY user_id ORDER BY amount DESC) AS rank_in_user
FROM orders;

SELECT day, amount,
       amount - LAG(amount) OVER (ORDER BY day) AS diff_from_prev,
       SUM(amount) OVER (ORDER BY day
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
FROM daily_sales;
```

Spring Data JPA에서 그룹별 TOP-N은 native 쿼리로, 뷰는 Hibernate `@Immutable` 읽기 전용 엔티티로 다룬다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    @Query(value = """
        WITH ranked AS (
            SELECT o.*,
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY amount DESC) AS rn
            FROM orders o
        )
        SELECT id, user_id, amount, status, created_at
        FROM ranked
        WHERE rn <= :limit
        """, nativeQuery = true)
    List<Order> findTopOrdersPerUser(@Param("limit") int limit);
}

@Entity
@Immutable
@Table(name = "user_order_summary")   -- 단순 VIEW: user_id 단일 키
public class UserOrderSummary {

    @Id
    private Long userId;
    private String userName;
    private long orderCount;
    private BigDecimal totalAmount;
}
```

## 실무에서 걸리는 지점

- **뷰 위에 뷰를 쌓는 중첩**: 3단계 이상 중첩되면 실행 계획 추적이 어렵다. 뷰는 한두 단계까지만 쓰고 그 이상은 CTE로 쿼리 안에서 푼다.
- ==**REFRESH 락과 UNIQUE 인덱스**: CONCURRENTLY 없는 REFRESH는 갱신 동안 조회를 막고, CONCURRENTLY는 UNIQUE 인덱스가 없으면 오류를 낸다.== 뷰 생성과 인덱스 생성을 같은 마이그레이션에 묶는다.
- **LAST_VALUE의 기본 프레임**: ORDER BY가 있는 윈도우의 기본 프레임은 현재 행까지라서 LAST_VALUE가 현재 행 자신을 돌려준다. 파티션 마지막 값이 필요하면 `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`을 명시한다.
- **재귀 CTE의 순환 데이터**: `manager_id`가 서로를 가리키면 무한히 돈다. PostgreSQL 14부터 `CYCLE` 절로 감지하고, 이전 버전은 깊이 상한으로 막는다.

## 관련 글

- [SELECT와 JOIN 표준 패턴](/notes/postgresql/select-join/)
- [쿼리 구조 — SELECT 절·FROM·WHERE·GROUP BY](/notes/postgresql/query-structure/)
- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
