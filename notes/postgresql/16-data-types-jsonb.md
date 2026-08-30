---
title: "데이터 타입과 JSONB"
series: postgresql
part: "타입·인덱스·성능"
order: 16
summary: "컬럼 타입은 BIGINT·TEXT·TIMESTAMPTZ·NUMERIC·JSONB를 기본으로 잡고, JSONB는 GIN·표현식 인덱스와 함께 써야 검색이 성립한다."
tags: [PostgreSQL, JSONB, NUMERIC, TIMESTAMPTZ, GIN]
sources: [data-infra/2026-05-17-pg-datatype.md, data-infra/2026-05-17-pg-datatype-json.md]
updated: 2026-08-29
---

컬럼 타입을 잘못 고르면 문제는 데이터가 쌓인 뒤에 드러난다. 금액을 부동소수로 저장하면 합계가 원 단위에서 어긋나고, 시간대 없는 TIMESTAMP는 서버와 클라이언트의 시간대가 다를 때 같은 값이 다른 시각으로 읽힌다. INTEGER 기본 키는 21억에서 멈추고, JSON 타입에 넣은 이벤트 로그는 인덱스를 탈 수 없어 조회마다 전체 스캔과 재파싱을 반복한다. 타입 변경은 테이블 재작성을 동반하므로 나중에 고치는 비용이 처음 고르는 비용보다 훨씬 크다.

## 핵심 개념

**숫자.** 정수는 SMALLINT·INTEGER·BIGINT이며 기본 키와 카운터는 BIGINT를 기본으로 잡는다. 자동 증가는 SERIAL 대신 SQL 표준인 `GENERATED ALWAYS AS IDENTITY`를 쓴다. REAL·DOUBLE PRECISION은 이진 부동소수라 `0.1 + 0.2`가 `0.30000000000000004`로 계산되므로 금액과 단가는 NUMERIC(p, s)로 고정한다.

**문자.** CHAR·VARCHAR·TEXT는 저장 구조와 성능이 같다. TEXT를 기본으로 쓰고 길이 제한은 CHECK 제약으로 걸면 제한 변경이 제약 교체만으로 끝난다. 대소문자를 구분하지 않아야 하는 이메일은 citext 확장을 쓴다.

**날짜·시간.** TIMESTAMP는 시간대 정보가 없어 해석이 세션 설정에 의존한다. TIMESTAMPTZ는 입력값을 UTC로 정규화해 저장하고 조회 시 세션 시간대로 변환한다. 둘 다 8바이트이므로 표준은 TIMESTAMPTZ다. 기간은 INTERVAL, 절단과 추출은 DATE_TRUNC·EXTRACT를 쓴다.

**UUID.** 노드 간 조율 없이 고유 키를 만들고 순번 추측도 막는다. 대신 16바이트이고, v4는 무작위라 B-Tree 삽입 위치가 흩어져 인덱스 지역성이 나쁘다. PostgreSQL 13부터 `gen_random_uuid()`가 내장이라 uuid-ossp 확장은 필요 없고, 18은 시간 순 정렬이 되는 `uuidv7()`을 제공한다.

**배열·범위·ENUM.** `TEXT[]` 배열은 태그 같은 작은 컬렉션에 쓰고 `ANY`·`@>`·`&&` 연산자와 GIN 인덱스로 검색한다. TSTZRANGE 등 범위 타입은 EXCLUDE 제약과 결합해 예약 겹침을 DB 레벨에서 막는다. ENUM은 값 삭제와 순서 변경이 어려우므로 상태 집합이 바뀔 여지가 있으면 TEXT + CHECK가 낫다.

**JSON과 JSONB.** JSON은 입력 텍스트를 그대로 저장하고 조회마다 파싱한다. ==JSONB는 입력 시점에 파싱해 이진 구조로 저장하므로 키 순서가 보존되지 않고 중복 키는 마지막 값만 남지만==, 조회가 빠르고 GIN 인덱스를 걸 수 있다. 원본 포맷을 보존해야 하는 감사 로그가 아니라면 JSONB를 쓴다.

| 연산자 | 의미 | 결과 타입 |
|---|---|---|
| `->` / `#>` | 키·경로로 추출 | JSONB (체이닝 가능) |
| `->>` / `#>>` | 키·경로로 추출 | TEXT |
| `@>` / `<@` | 포함 / 포함됨 | BOOLEAN |
| `?` / `?|` / `?&` | 키 존재 / 하나라도 / 모두 | BOOLEAN |

검사 연산자는 GIN 인덱스가 가속한다. 기본 클래스 `jsonb_ops`는 위 연산자를 모두 지원하고, `jsonb_path_ops`는 `@>`만 지원하는 대신 크기가 절반 수준이고 빠르다. 특정 키 하나만 자주 조건에 걸리면 `((payload->>'user'))` 표현식 인덱스가 더 작고 빠르다. 수정은 `jsonb_set(target, path, value, create_if_missing)`·`-`·`||`, 경로 질의는 PostgreSQL 12부터 들어온 `jsonb_path_query`, 조립은 `jsonb_build_object`·`jsonb_agg`를 쓴다.

## 코드

타입 선택 기준을 반영한 테이블 정의와 인덱스다.

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       CITEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL CHECK (char_length(name) <= 100),
    balance     NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
    tags        TEXT[] NOT NULL DEFAULT '{}',
    meta        JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_tags  ON users USING GIN (tags);
CREATE INDEX idx_users_meta  ON users USING GIN (meta jsonb_path_ops);
CREATE INDEX idx_users_theme ON users ((meta->'preferences'->>'theme'));
```

JSONB 조회·수정·집계를 한 세트로 묶은 예제다. 포함 검색은 `jsonb_path_ops` GIN을, 테마 조건은 표현식 인덱스를 탄다.

```sql
INSERT INTO users (email, name, tags, meta) VALUES
    ('Alice@Example.com', 'Alice', ARRAY['java', 'spring'],
     '{"preferences": {"theme": "dark", "lang": "ko"}, "verified": true}');

SELECT id, name FROM users WHERE meta @> '{"verified": true}';
SELECT id, name FROM users WHERE meta->'preferences'->>'theme' = 'dark';
SELECT id, name FROM users WHERE tags @> ARRAY['java'];

UPDATE users
SET meta = jsonb_set(COALESCE(meta, '{}'::JSONB), '{preferences,theme}', '"light"', TRUE)
WHERE id = 1;

SELECT u.id,
       jsonb_agg(jsonb_build_object('id', o.id, 'amount', o.amount)) AS orders
FROM users u
JOIN orders o ON o.user_id = u.id
GROUP BY u.id;
```

Spring Boot 3.x 엔티티 매핑이다. Hibernate 6.2 이상은 `@JdbcTypeCode(SqlTypes.JSON)`만으로 별도 라이브러리 없이 Map을 JSONB로 직렬화한다.

```java
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.Map;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String email;

    @Column(nullable = false, precision = 14, scale = 2)
    private BigDecimal balance;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> meta;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
```

## 실무에서 걸리는 지점

- **JPA 타입 매핑.** ==TIMESTAMPTZ는 `OffsetDateTime`이나 `Instant`로 받아야 하며 `LocalDateTime`은 JVM 시간대에 따라 값이 밀린다.== NUMERIC은 `BigDecimal`, 상태 컬럼은 `@Enumerated(EnumType.STRING)`으로 DB CHECK와 맞춘다.
- **인덱스와 조건 형태 불일치.** `@>`·`?`는 GIN이, `->>` 비교는 표현식 인덱스가 담당한다. 인덱스가 있어도 조건 형태가 다르면 순차 스캔이다.
- **jsonb_set의 NULL 전파.** ==대상이 NULL이면 결과도 NULL이 되어 컬럼이 통째로 비워진다.== `COALESCE`로 감싸고 새 키 추가 시 네 번째 인자를 TRUE로 명시한다.
- **큰 JSONB와 TOAST.** ==값이 2KB를 넘으면 TOAST로 분리 저장되고, JSONB는 부분 갱신이 없어 키 하나를 바꿔도 값 전체를 다시 쓴다.== 자주 읽거나 바뀌는 필드는 일반 컬럼으로 승격한다.
- **UUID v4 기본 키.** 무작위 키는 B-Tree 전역에 삽입이 흩어져 캐시 적중률이 떨어지고 bloat가 빨라진다. 분산 키가 필요하면 UUIDv7, 단일 DB라면 BIGINT IDENTITY가 단순하다.

## 관련 글

- [DDL 깊이 — CREATE TABLE·파티션·제약·외래 키](/notes/postgresql/ddl-tables-constraints/)
- [인덱스 — 원리와 종류 (B-Tree·Hash·GIN·GiST·BRIN)](/notes/postgresql/index-types/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
