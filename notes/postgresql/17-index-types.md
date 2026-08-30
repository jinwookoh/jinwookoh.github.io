---
title: "인덱스 — 원리와 종류 (B-Tree·Hash·GIN·GiST·BRIN)"
series: postgresql
part: "타입·인덱스·성능"
order: 17
summary: "PostgreSQL 인덱스가 빠른 이유와 여섯 가지 인덱스 종류를 언제 골라야 하는지 정리한다"
tags: [PostgreSQL, Index, B-Tree, GIN, BRIN]
sources: [data-infra/2026-05-17-pg-indexes-intro.md, data-infra/2026-05-17-pg-indexes-types.md, 2026-05-03-db-eng-indexing.md]
updated: 2026-08-29
---

인덱스가 없는 테이블에서 `WHERE email = ?` 조건으로 한 행을 찾으면 PostgreSQL은 모든 행을 순서대로 읽는 Sequential Scan을 수행한다. 1,000만 행이면 한 쿼리가 수 초를 소비하고, 동시 요청이 겹치는 운영 환경에서는 CPU와 디스크 I/O가 포화된다. 인덱스는 컬럼 값에서 행의 물리 위치를 직접 찾는 별도 자료구조로, 검사 대상을 수천만 회에서 수십 회로 줄인다. 다만 종류마다 지원 연산자와 비용 구조가 다르므로 조건에 맞는 인덱스를 골라야 효과를 얻는다.

## 핵심 개념

### B-Tree가 빠른 이유

PostgreSQL의 기본 인덱스는 B-Tree다. 엄밀히는 내부 노드에 키만 두고 리프 노드에 키와 행 포인터를 두며 리프끼리 연결 리스트로 이어진 B+Tree 구조다. 내부 노드가 키만 저장하므로 한 페이지에 많은 키가 들어가 트리 깊이가 얕고, 1,000만 행에서도 서너 페이지 접근으로 리프에 도달한다. 리프가 연결되어 있어 `BETWEEN`이나 `ORDER BY` 같은 범위 처리도 리프를 순서대로 따라가면 된다.

PostgreSQL의 모든 인덱스는 힙(테이블 파일)의 행 위치인 CTID를 가리킨다. ==기본 키 인덱스도 별도 B-Tree이며 테이블 자체는 정렬되지 않는다.== 이 점이 MySQL InnoDB와 다르다. InnoDB는 기본 키가 클러스터 인덱스라 리프가 곧 행 데이터이고, 보조 인덱스는 기본 키 값을 저장해 두 단계 조회가 일어난다.

### 스캔 방식

플래너는 통계를 근거로 스캔 방식을 고른다. Index Only Scan은 필요한 컬럼이 모두 인덱스에 있어 힙을 읽지 않고, Index Scan은 인덱스로 위치를 찾은 뒤 힙을 읽는다. Bitmap Index Scan은 조건에 맞는 페이지를 비트맵으로 모아 힙을 순서대로 읽으며, 결과 행이 많거나 여러 인덱스를 결합할 때 선택된다. 결과가 테이블 대부분이면 Seq Scan이 더 빠르므로 인덱스가 있어도 쓰지 않는다. ==Index Only Scan은 visibility map이 최신이어야 하므로 VACUUM이 따라줘야 한다.==

### 여섯 가지 인덱스 종류

| 종류 | 대상 | 연산자 |
|---|---|---|
| B-Tree | 정렬 가능한 모든 타입 | `=` `<` `>` `BETWEEN` `IS NULL` `LIKE 'abc%'` `ORDER BY` |
| Hash | 동등 비교만 | `=` |
| GIN | 배열·JSONB·tsvector 같은 다중 값 | `@>` `<@` `&&` `?` `@@` |
| GiST | 범위·기하·EXCLUDE 제약 | `&&` `<<` `@>` |
| BRIN | 물리 순서와 값 순서가 일치하는 대용량 컬럼 | 범위 비교 |
| SP-GiST | 접두사·IP처럼 공간 분할이 맞는 비균등 데이터 | 타입별 |

Hash는 PostgreSQL 10부터 WAL에 기록되어 복제에 안전해졌지만, B-Tree가 동등 비교도 충분히 빠르고 범위와 정렬까지 지원하므로 고를 이유가 거의 없다. GIN은 배열이나 JSONB의 각 요소를 항목으로 만드는 역색인이라 읽기는 빠르지만 한 행 삽입에 여러 항목이 생긴다. `fastupdate`가 켜져 있으면 pending list에 모았다가 일괄 반영해 쓰기 부담을 줄인다. GiST는 범위 타입과 기하 타입에 쓰이며 `EXCLUDE USING GIST`로 기간 중복 방지 제약을 만들 때 필수다. `btree_gist` 확장을 더하면 `=` 조건을 함께 묶을 수 있다. BRIN은 페이지 범위마다 최솟값과 최댓값만 저장해 크기가 B-Tree의 1/100 수준이지만, 값이 물리 순서대로 저장된 로그성 컬럼에서만 효과가 있다.

### 복합·부분·표현식·커버링 인덱스

복합 인덱스 `(a, b, c)`는 왼쪽 접두사부터 활용된다. ==`WHERE a = ?`, `WHERE a = ? AND b > ?`는 인덱스를 타지만 `WHERE b = ?`는 타지 않는다.== 컬럼 순서는 동등 비교이면서 선별성이 높은 컬럼을 앞에, 범위 비교 컬럼을 뒤에 둔다. 부분 인덱스는 `WHERE deleted_at IS NULL`처럼 조건에 맞는 행만 담아 크기를 줄이고, 표현식 인덱스는 `LOWER(email)` 같은 함수 결과를 저장한다. `INCLUDE`로 검색 키가 아닌 컬럼을 리프에 함께 저장하면 Index Only Scan 범위가 넓어진다.

## 코드

Flyway 마이그레이션으로 관리하는 인덱스 DDL이다. 운영 테이블에는 `CONCURRENTLY`가 필요하며 이 옵션은 트랜잭션 안에서 실행할 수 없으므로 파일 상단에 트랜잭션 비활성 지시를 둔다.

```sql
-- V17__order_indexes.sql
-- flyway:executeInTransaction=false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user_status_created
    ON orders (user_id, status, created_at DESC)
    INCLUDE (amount);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_lower_active
    ON users (LOWER(email))
    WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_payload_gin
    ON events USING GIN (payload jsonb_path_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_access_logs_created_brin
    ON access_logs USING BRIN (created_at);
```

Spring Data JPA 리포지토리다. 첫 메서드는 복합 인덱스의 접두사 순서와 정렬 방향을 그대로 따르고, 두 번째는 표현식 인덱스와 같은 형태로 함수를 적용해야 인덱스를 탄다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    List<Order> findByUserIdAndStatusAndCreatedAtAfterOrderByCreatedAtDesc(
            Long userId, OrderStatus status, Instant since);

    @Query("select u from User u where lower(u.email) = lower(:email) and u.deletedAt is null")
    Optional<User> findActiveByEmail(@Param("email") String email);
}
```

JSONB 포함 검색은 JPQL에 연산자가 없으므로 네이티브 쿼리로 작성한다. `@>` 연산자만 `jsonb_path_ops` GIN 인덱스를 활용한다.

```java
@Repository
public class EventQueryRepository {

    private final JdbcClient jdbcClient;

    public EventQueryRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public List<Long> findIdsByPayloadContains(String jsonFilter) {
        return jdbcClient.sql("select id from events where payload @> cast(:f as jsonb)")
                .param("f", jsonFilter)
                .query(Long.class)
                .list();
    }
}
```

## 실무에서 걸리는 지점

- 외래 키 컬럼에는 인덱스가 자동으로 생기지 않는다. 기본 키와 UNIQUE 제약은 인덱스를 만들지만 `REFERENCES`는 만들지 않으므로, 조인과 부모 행 삭제 시 참조 검사가 Seq Scan으로 떨어진다.
- 자주 갱신되는 컬럼에 인덱스를 걸면 HOT 업데이트가 막힌다. 인덱스 컬럼이 바뀌면 모든 인덱스에 항목이 추가되어 쓰기 비용과 bloat가 함께 늘어난다.
- 카디널리티가 낮은 컬럼의 단독 인덱스는 플래너가 쓰지 않는다. `is_deleted = false`처럼 대부분 행이 매칭되는 조건은 부분 인덱스로 바꾼다.
- UUID v4를 기본 키로 쓰면 삽입 위치가 무작위라 페이지 분할과 캐시 미스가 늘어난다. 시간 순서가 보장되는 UUID v7이나 ULID를 쓰면 B-Tree 오른쪽 끝에 순차 삽입된다.
- ==BRIN은 데이터가 갱신이나 삭제로 뒤섞이면 페이지 범위의 최소·최대 폭이 넓어져 효과가 사라진다.== append 전용 로그 테이블에만 적용한다.

## 관련 글

- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [데이터 타입과 JSONB](/notes/postgresql/data-types-jsonb/)
