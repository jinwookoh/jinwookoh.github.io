---
title: "인덱스 운영과 EXPLAIN"
series: postgresql
part: "타입·인덱스·성능"
order: 18
summary: "인덱스는 만들고 끝이 아니라 EXPLAIN으로 검증하고 통계로 관찰하며 주기적으로 재구성·제거하는 운영 대상이다."
tags: [PostgreSQL, EXPLAIN, 인덱스, REINDEX, pg_stat_statements]
sources: [data-infra/2026-05-17-pg-indexes.md, data-infra/2026-05-17-pg-explain.md]
updated: 2026-08-29
---

인덱스를 만들었는데도 쿼리가 느린 경우는 흔하다. 통계가 오래되어 계획자가 인덱스를 무시하거나, `CONCURRENTLY` 생성이 실패해 INVALID 상태로 남았거나, 복합 인덱스의 컬럼 순서가 쿼리와 맞지 않는 경우다. 반대로 한 번도 조회되지 않는 인덱스가 모든 쓰기를 느리게 만드는 일도 잦다. 계획자가 택한 경로를 EXPLAIN으로 확인하고, `pg_stat_user_indexes`로 사용 여부를 관찰하고, REINDEX와 ANALYZE로 상태를 되돌리는 운영 절차가 필요하다.

## 핵심 개념

### 인덱스 라이프사이클

운영 인덱스는 설계 → 생성 → 검증 → 모니터링 → 튜닝 → 제거의 순환을 따른다. 설계 단계에서는 자주 나오는 WHERE·JOIN·ORDER BY 컬럼을 기준으로 인덱스 집합을 정한다. PRIMARY KEY와 UNIQUE 제약은 인덱스를 자동으로 만들지만 외래 키는 만들지 않으므로 직접 추가한다. 카디널리티가 매우 낮거나 갱신이 잦은 컬럼은 대상에서 빼거나 부분 인덱스로 범위를 줄인다. 갱신이 잦은 컬럼을 인덱스에서 빼면 HOT 업데이트가 가능해져 인덱스 갱신 자체를 피할 수 있다.

생성은 운영 환경에서 항상 `CREATE INDEX CONCURRENTLY`를 쓴다. 일반 `CREATE INDEX`는 완료될 때까지 테이블 쓰기를 막는다. `CONCURRENTLY`는 락 없이 진행하는 대신 실패하면 `pg_index.indisvalid = false`인 INVALID 인덱스를 남기며, 이 인덱스는 검색에 쓰이지 않으면서 쓰기 비용과 디스크만 소모한다.

튜닝은 두 축이다. 인덱스가 테이블 대비 비정상적으로 커졌으면 블로트를 의심하고 `REINDEX INDEX CONCURRENTLY`로 재구성한다. PostgreSQL 12부터 지원하며 기존 인덱스로 검색을 받으면서 새 인덱스를 만들어 교체한다. 대량 DML 이후에는 `ANALYZE`로 통계를 갱신한다. 계획자는 통계로 비용을 추정하므로 통계가 현실과 다르면 인덱스가 있어도 Seq Scan을 고른다.

### EXPLAIN 읽기

`EXPLAIN`은 추정 계획만 보여주고 `EXPLAIN ANALYZE`는 쿼리를 실제로 실행해 실측치를 함께 출력한다. 운영 진단 표준은 `EXPLAIN (ANALYZE, BUFFERS)`다. `BUFFERS`는 `shared hit`(캐시 적중)과 `read`(디스크 읽기)를 구분해 I/O 병목을 드러낸다.

`cost=START..TOTAL rows=N width=W`에서 START는 첫 행 반환까지의 추정 비용, TOTAL은 전체 완료 비용, rows는 추정 행 수다. `actual time=START..TOTAL rows=N loops=L`은 실측 ms와 실제 행 수, 노드 실행 횟수다. cost는 단위 없는 상대값이라 actual time과 직접 비교하지 않는다. 대신 추정 rows와 실제 rows를 비교하고, 수십 배 이상 어긋나면 `ANALYZE`를 돌린다. `loops`가 큰 노드는 time에 loops를 곱해야 총 소요 시간이 된다.

| 노드 | 진단 포인트 |
|---|---|
| Seq Scan | `Rows Removed by Filter`가 크면 인덱스 후보 |
| Index Scan | `Index Cond` 외에 `Filter`가 붙으면 인덱스가 조건을 다 못 덮음 |
| Index Only Scan | `Heap Fetches: 0`이 이상적. INCLUDE로 유도 |
| Bitmap Index Scan | OR 조건이나 넓은 범위에서 여러 인덱스 결합 |
| Nested Loop | 내부가 인덱스면 빠름. `loops`가 크면 내부 인덱스 점검 |
| Hash Join / Merge Join | 중간 규모의 기본 선택 / 양쪽 정렬 인덱스가 있을 때 |
| Sort | `external merge`면 디스크 정렬, `work_mem` 검토 |

`Limit → Sort → Seq Scan`이면 전체를 읽어 정렬한 뒤 잘라내는 것이므로, 인덱스 정렬 방향을 ORDER BY와 맞춰 `Limit → Index Scan`으로 바꾸는 것이 첫 개선 지점이다.

## 코드

주문 조회 패턴을 복합·BRIN·부분·INCLUDE 인덱스로 덮는 설계다.

```sql
-- WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
CREATE INDEX CONCURRENTLY idx_orders_user_created
    ON orders (user_id, created_at DESC);

-- WHERE status = ? AND created_at > ? ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY idx_orders_status_created
    ON orders (status, created_at DESC);

-- 자연 정렬된 대용량 시계열 집계에는 BRIN
CREATE INDEX CONCURRENTLY idx_orders_created_brin
    ON orders USING BRIN (created_at);

-- 처리 대기 건만 인덱싱 (부분 인덱스)
CREATE INDEX CONCURRENTLY idx_orders_pending
    ON orders (user_id, created_at)
    WHERE status = 'PENDING';

-- 자주 읽는 컬럼을 포함해 Index Only Scan 유도
CREATE INDEX CONCURRENTLY idx_orders_user_include
    ON orders (user_id) INCLUDE (status, amount);
```

느린 쿼리를 찾아 실행 계획을 확인하고 INVALID·미사용 인덱스를 정리하는 운영 쿼리다.

```sql
-- 1. 누적 실행 시간 상위 쿼리 (pg_stat_statements 확장 필요)
SELECT query, calls,
       total_exec_time / calls AS avg_ms,
       rows / calls            AS avg_rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- 2. 실측 계획. UPDATE·DELETE는 반드시 트랜잭션 안에서 롤백한다
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE user_id = 1 AND status = 'PAID'
ORDER BY created_at DESC LIMIT 10;
ROLLBACK;

-- 3. INVALID 인덱스
SELECT indexrelid::regclass AS index_name
FROM pg_index
WHERE NOT indisvalid;

-- 4. 한 번도 스캔되지 않은 인덱스 (제약용 제외, 큰 것부터)
SELECT schemaname || '.' || relname AS table_name,
       indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE idx_scan = 0
  AND NOT indisunique
  AND NOT indisprimary
ORDER BY pg_relation_size(indexrelid) DESC;

-- 5. 블로트 의심 인덱스 재구성과 통계 갱신
REINDEX INDEX CONCURRENTLY idx_orders_user_created;
ANALYZE orders;
```

Spring Data JPA 메서드 이름이 만드는 WHERE·ORDER BY에 맞춰 인덱스를 선언하는 예다. `@Index`는 스키마 생성 시에만 반영되므로 운영 DB에는 마이그레이션 도구로 `CONCURRENTLY` 생성을 별도 적용한다.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;

@Entity
@Table(name = "orders", indexes = {
        @Index(name = "idx_orders_user_status_created",
               columnList = "user_id, status, created_at DESC")
})
public class Order {
    @Id
    private Long id;
    private Long userId;
    private String status;
    private Instant createdAt;
}

public interface OrderRepository extends JpaRepository<Order, Long> {
    // WHERE user_id = ? AND status = ? ORDER BY created_at DESC
    // → (user_id, status, created_at DESC) 복합 인덱스를 탄다
    List<Order> findByUserIdAndStatusOrderByCreatedAtDesc(Long userId, String status);
}
```

## 실무에서 걸리는 지점

- **EXPLAIN ANALYZE는 실제 실행이다.** UPDATE·DELETE에 붙이면 데이터가 실제로 바뀐다. 쓰기 쿼리 진단은 `BEGIN`으로 열고 `ROLLBACK`으로 닫는다.
- **`CONCURRENTLY`는 실패 흔적을 남긴다.** 배포 파이프라인에서 `pg_index.indisvalid`를 점검하고, INVALID 인덱스는 `DROP INDEX CONCURRENTLY` 후 재생성한다.
- **통계 갱신을 잊으면 인덱스가 무시된다.** 대량 적재·삭제 뒤 autovacuum이 따라오기 전에는 계획자가 오래된 추정으로 Seq Scan을 고른다. 추정 rows와 실제 rows가 어긋나면 인덱스 추가보다 `ANALYZE`가 먼저다.
- **미사용 판단에는 관찰 기간이 필요하다.** 월말 배치만 쓰는 인덱스가 있으므로 `idx_scan = 0`만 보고 지우지 않는다. 통계 초기화 시점을 확인하고 최소 몇 주 관찰 뒤 제거한다.
- **인덱스 개수 자체가 쓰기 비용이다.** 앞 컬럼이 같은 중복 인덱스가 누적되면 모든 쓰기가 느려진다. 분기마다 `pg_stat_user_indexes`와 대조해 정리한다.

## 관련 글

- [인덱스 — 원리와 종류 (B-Tree·Hash·GIN·GiST·BRIN)](/notes/postgresql/index-types/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [성능 팁과 전문 검색](/notes/postgresql/performance-textsearch/)
