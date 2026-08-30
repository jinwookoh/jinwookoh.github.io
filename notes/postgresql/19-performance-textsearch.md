---
title: "성능 팁과 전문 검색"
series: postgresql
part: "타입·인덱스·성능"
order: 19
summary: "메모리·연결 풀·autovacuum 튜닝의 기준값과, LIKE 풀스캔을 tsvector·GIN 전문 검색으로 대체하는 방법을 정리한다."
tags: [PostgreSQL, shared_buffers, work_mem, PgBouncer, tsvector]
sources: [data-infra/2026-05-17-pg-performance-tips.md, data-infra/2026-05-17-pg-textsearch.md]
updated: 2026-08-29
---

PostgreSQL의 기본 설정은 메모리가 작은 호스트를 가정한다. 8GB 이상 서버에 기본값 그대로 올리면 shared_buffers가 128MB에 머물러 디스크 I/O가 잦아지고, 정렬이 디스크로 넘어가며, 연결 풀 없이 요청마다 백엔드 프로세스가 생성된다. 검색도 마찬가지다. `LIKE '%검색어%'`는 인덱스를 타지 못해 테이블 전체를 읽고, 랭킹이나 하이라이트를 제공하지 못한다. 두 문제 모두 별도 인프라 없이 설정과 내장 기능으로 해결된다.

## 핵심 개념

### 메모리 파라미터

| 파라미터 | 역할 | 기준값 (8GB 호스트) |
|---|---|---|
| `shared_buffers` | PostgreSQL 자체 페이지 캐시 | 메모리의 25% |
| `effective_cache_size` | OS 캐시 포함 추정치. 할당 없이 플래너 힌트로만 쓰인다 | 메모리의 75% |
| `work_mem` | 정렬·해시 작업 하나당 메모리 | 16~64MB |
| `maintenance_work_mem` | VACUUM·CREATE INDEX 메모리 | 512MB~2GB |

`work_mem`은 쿼리당이 아니라 정렬·해시 노드당 할당되므로 동시 쿼리 수와 곱해 총량을 본다. 큰 정렬이 필요한 배치 세션에서만 `SET work_mem = '256MB'`로 올린다.

### 체크포인트와 autovacuum

체크포인트는 WAL의 변경을 데이터 파일에 반영하는 시점이다. 너무 잦으면 디스크 쓰기가 몰리고, 너무 드물면 복구 시간이 길어진다. `checkpoint_timeout = 15min`, `max_wal_size = 4GB`, `checkpoint_completion_target = 0.9`가 출발점이다. `wal_compression = on`은 WAL 크기와 복제 대역폭을 줄인다.

autovacuum의 기본 `autovacuum_vacuum_scale_factor`는 0.2로, 테이블의 20%가 변경되어야 VACUUM이 시작된다. 큰 테이블은 dead tuple이 수백만 개 쌓인 뒤에야 동작하므로 0.05~0.1로 낮춘다.

### 연결 풀

PostgreSQL은 연결당 프로세스 하나를 띄우므로 연결 수 자체가 부하다. 앱 쪽에서는 HikariCP가 커넥션을 재사용하고, 서버 쪽에서는 PgBouncer가 여러 앱 인스턴스의 연결을 소수의 실제 연결로 다중화한다. 앱 풀 크기는 `(코어 수 × 2) + 디스크 수` 근처에서 시작해 측정으로 조정한다.

### 전문 검색 타입

`to_tsvector`는 텍스트를 어근(lexeme)과 위치의 집합으로 바꾸고, `to_tsquery`는 검색 조건을 만들며, `@@` 연산자가 둘을 매칭한다. `to_tsquery`는 공백이 섞인 입력에서 오류를 내므로 사용자 입력에는 따옴표·`OR`·`-` 접두사를 파싱하는 `websearch_to_tsquery`를 쓴다.

tsquery 연산자는 `&`(AND)·`|`(OR)·`!`(NOT)·`<->`(인접)·`<N>`(N 단어 거리 안)이다. `ts_rank`는 단어 빈도와 위치로 적합도 점수를 매기고, `setweight`로 제목(A)과 본문(B)에 다른 가중치를 준다. `ts_headline`은 매칭 부분 주변을 발췌해 강조 태그를 붙인다. tsvector는 매번 계산하지 않고 `GENERATED ALWAYS AS ... STORED` 컬럼에 저장한 뒤 GIN 인덱스를 건다.

한국어는 내장 형태소 분석기가 없다. `simple` 설정으로 공백 단위 토큰화만 하거나, `pg_trgm`(3글자)·`pg_bigm`(2글자) 확장으로 부분 문자열 매칭을 인덱싱하거나, mecab-ko 계열 확장을 붙인다.

## 코드

가중치가 적용된 생성 컬럼과 GIN 인덱스를 만들고, 매칭·랭킹·하이라이트를 한 쿼리로 처리한다.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE posts (
    id            BIGSERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    tags          TEXT[],
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(body, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(array_to_string(tags, ' '), '')), 'C')
    ) STORED
);

CREATE INDEX idx_posts_search     ON posts USING GIN (search_vector);
CREATE INDEX idx_posts_title_trgm ON posts USING GIN (title gin_trgm_ops);

SELECT id, title,
       ts_rank(search_vector, q) AS rank,
       ts_headline('simple', body, q,
                   'StartSel=<mark>, StopSel=</mark>, MaxFragments=2') AS snippet
FROM posts, websearch_to_tsquery('simple', '"spring framework" -legacy') q
WHERE search_vector @@ q
ORDER BY rank DESC, created_at DESC
LIMIT 20;
```

JPQL은 `@@`를 지원하지 않으므로 native query로 호출하고 페이징은 `Pageable`로 넘긴다.

```java
public interface PostRepository extends JpaRepository<Post, Long> {

    @Query(value = """
            SELECT p.* FROM posts p
            WHERE p.search_vector @@ websearch_to_tsquery('simple', :q)
            ORDER BY ts_rank(p.search_vector, websearch_to_tsquery('simple', :q)) DESC,
                     p.created_at DESC
            """,
           countQuery = """
            SELECT count(*) FROM posts p
            WHERE p.search_vector @@ websearch_to_tsquery('simple', :q)
            """,
           nativeQuery = true)
    Page<Post> search(@Param("q") String query, Pageable pageable);
}
```

HikariCP 풀과 PgBouncer 설정이다. transaction 모드에서는 드라이버의 서버 측 prepared statement를 끈다.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://pgbouncer:6432/mydb?prepareThreshold=0
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 30000
      max-lifetime: 1800000
```

```ini
[databases]
mydb = host=pg-primary port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction
default_pool_size = 25
max_client_conn = 1000
```

## 실무에서 걸리는 지점

- **work_mem 과다 설정으로 OOM**: 100MB × 동시 쿼리 100개면 10GB까지 요구할 수 있다. 전역값은 보수적으로 두고 `EXPLAIN (ANALYZE, BUFFERS)`에서 `external merge`가 보이는 쿼리만 세션 단위로 올린다. `log_temp_files = 0`을 켜면 디스크로 넘친 정렬을 추적할 수 있다.
- **PgBouncer transaction 모드와 세션 상태**: 서버 측 prepared statement, `SET`, advisory lock, `LISTEN`은 트랜잭션 경계를 넘어 유지되지 않는다. JDBC의 `prepareThreshold=0`과 `SET LOCAL`로 회피한다.
- **GIN 인덱스 없는 to_tsvector 호출**: 인덱스가 없으면 모든 행에서 tsvector를 계산하므로 LIKE보다 느려질 수 있다. 생성 컬럼과 GIN은 세트로 둔다.
- **한국어에 'english' 설정 사용**: 영어 스테머는 한글을 처리하지 못해 조사가 붙은 어절이 통째로 토큰이 된다. `simple` + `pg_trgm`으로 부분 매칭을 보완하거나 형태소 확장을 붙인다.
- **모니터링 부재**: `pg_stat_statements`와 `log_min_duration_statement = 1000`이 없으면 느린 쿼리를 사후에 찾을 수 없다. 캐시 hit 비율이 95% 아래면 shared_buffers 부족을 의심한다. 수억 문서·집계가 필요한 검색은 Elasticsearch의 영역이다.

## 관련 글

- [인덱스 — 원리와 종류 (B-Tree·Hash·GIN·GiST·BRIN)](/notes/postgresql/index-types/)
- [인덱스 운영과 EXPLAIN](/notes/postgresql/index-operations-explain/)
- [운영 설치와 postgresql.conf](/notes/postgresql/production-install-config/)
