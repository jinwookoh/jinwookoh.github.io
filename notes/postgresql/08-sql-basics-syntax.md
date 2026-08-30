---
title: "SQL 기초 — 어휘 구조와 문법"
series: postgresql
part: "SQL 기초"
order: 8
summary: "키워드·식별자·리터럴·연산자·표현식 규칙을 알아야 따옴표·NULL·우선순위 실수 없이 SQL을 쓴다."
tags: [PostgreSQL, SQL, 식별자, 리터럴, 타입 캐스팅]
sources: [data-infra/2026-05-17-pg-sql-basics.md, data-infra/2026-05-17-pg-sql-syntax-lexical.md, data-infra/2026-05-17-pg-sql-syntax.md]
updated: 2026-08-29
---

ORM이 SQL을 대신 생성해 주는 환경에서도 로그에 찍힌 쿼리를 읽고, 느린 쿼리를 고치고, 마이그레이션 스크립트를 직접 써야 하는 순간이 온다. 어휘 규칙을 모르면 `"Alice"`를 문자열로 착각해 컬럼을 찾지 못하고, `WHERE col = NULL`이 아무 행도 돌려주지 않는 이유를 설명하지 못하며, `a AND b OR c`가 의도와 다르게 묶여 잘못된 데이터를 수정하게 된다. ==어휘 구조와 표현식 규칙은 이런 실수를 원천에서 막는 최소한의 문법 지식이다.==

## 핵심 개념

### 어휘 요소

SQL 문장은 세미콜론까지가 한 단위이며 공백·줄바꿈은 의미에 영향을 주지 않는다. 문장은 키워드, 식별자, 리터럴, 연산자, 주석 다섯 가지 어휘 요소로 이루어진다.

키워드는 `SELECT`·`FROM`·`WHERE`처럼 SQL이 예약한 단어로 대소문자를 구분하지 않으며 관례상 대문자로 쓴다. 이 가운데 예약어(`SELECT`·`ORDER`·`USER` 등)는 큰따옴표 없이 식별자로 쓸 수 없다. `CREATE TABLE order (...)`가 실패하는 이유가 여기 있으며, 복수형 `orders`를 쓰면 해결된다.

식별자는 테이블·컬럼·인덱스에 붙이는 이름이다. 글자·숫자·밑줄로 구성하고 첫 글자는 글자 또는 밑줄이어야 하며 기본 길이 제한은 63바이트다. 따옴표 없는 식별자는 소문자로 접히므로 `CREATE TABLE Users`는 `users`로 저장된다. 큰따옴표로 감싸면 대소문자가 보존되지만 이후 모든 참조에 큰따옴표를 붙여야 하고 ORM과 충돌하기 쉽다. 실무 관례는 소문자 snake_case에 테이블은 복수형이다.

리터럴은 문장에 직접 적는 값이다. 문자열은 작은따옴표로 감싸고 내부의 작은따옴표는 두 번 겹쳐 쓴다(`'It''s'`). ==큰따옴표는 식별자, 작은따옴표는 문자열이라는 구분이 가장 자주 틀리는 지점이다.== 함수 본문처럼 따옴표가 뒤섞인 문자열은 달러 인용(`$$...$$`, `$tag$...$tag$`)으로 감싸면 이스케이프가 필요 없다. 숫자는 `123`·`1.23e5`, 날짜는 `'2026-05-17'::DATE`, 바이너리는 `'\xDEADBEEF'::BYTEA`로 쓴다.

연산자는 산술(`+ - * / % ^`), 비교(`= <> < > <= >=`), 논리(`AND OR NOT`), 문자열 연결(`||`), 패턴(`LIKE`·`ILIKE`·정규식 `~`)으로 나뉜다. 주석은 `--`로 줄 끝까지, `/* */`로 여러 줄을 감싸며 블록 주석은 중첩할 수 있다.

### 값 표현식

값이 들어가는 모든 자리에는 값 표현식이 온다. 상수, 컬럼 참조, 위치 파라미터(`$1`), 연산자 식, 함수 호출, 서브쿼리 여섯 종류가 있고 서로 중첩할 수 있다.

타입 변환은 `표현식::TYPE` 또는 SQL 표준 `CAST(표현식 AS TYPE)`으로 명시한다. 문자열 리터럴은 문맥에 맞춰 암시적으로 변환되기도 하지만, 표현식이 복잡해질수록 명시적 캐스팅이 의도를 드러낸다. 정수끼리 나누면 정수가 나오므로(`10 / 3`은 3) 소수 결과가 필요하면 한쪽을 `NUMERIC`으로 바꿔야 한다.

연산자 우선순위는 `.` → `::` → 단항 `+ -` → `^` → `* / %` → `+ -` → `||`·기타 연산자 → 비교 → `IS` → `NOT` → `AND` → `OR` 순으로 낮아진다. `::`가 매우 강하게 묶이므로 `1 + 2::TEXT`는 오류가 나고 `(1 + 2)::TEXT`로 써야 `'3'`을 얻는다. `AND`가 `OR`보다 먼저 묶이므로 섞어 쓸 때는 괄호로 의도를 고정한다.

NULL은 "알 수 없음"이므로 산술·비교·문자열 연결 어디에 끼어도 결과가 NULL이다. `NULL = NULL`조차 TRUE가 아니며 비교는 `IS NULL`로만 한다. NULL을 다루는 도구는 `COALESCE`(첫 NULL 아닌 값), `NULLIF`(두 값이 같으면 NULL, 0 나눗셈 회피), `CONCAT`(NULL을 빈 문자열로 취급)이며, 조건 분기는 `CASE WHEN ... END`로 표현한다. 행 값 `(a, b) = (1, 2)`로 여러 컬럼을 한 번에 비교할 수 있다.

## 코드

캐스팅·행 값 비교·NULL 안전 연산·정규식을 한 문장에서 확인하는 예제다.

```sql
-- 식별자는 소문자 snake_case, 문자열은 작은따옴표
SELECT
    o.id,
    u.name || ' <' || COALESCE(u.email, 'no-email') || '>' AS contact,
    (o.amount * 1.1)::NUMERIC(12, 2)                       AS amount_with_tax,
    o.amount / NULLIF(o.quantity, 0)                        AS unit_price,
    CASE
        WHEN o.amount >= 100000 THEN 'large'
        WHEN o.amount >= 10000  THEN 'medium'
        ELSE 'small'
    END                                                     AS bucket
FROM orders o
JOIN users  u ON u.id = o.user_id
WHERE (o.status, o.currency) = ('PAID', 'KRW')
  AND (o.created_at >= '2026-01-01'::DATE OR o.flagged IS TRUE)
  AND u.name ~ '^[A-Z]';  /* 정규식 연산자 */
```

달러 인용은 함수 본문처럼 따옴표가 섞인 긴 문자열에 쓴다. 본문 안의 작은따옴표를 이스케이프하지 않아도 된다.

```sql
CREATE OR REPLACE FUNCTION greet(who TEXT DEFAULT 'guest')
RETURNS TEXT
LANGUAGE sql
AS $body$
    SELECT 'Hello, ' || who || '. It''s ' || CURRENT_DATE::TEXT;
$body$;

SELECT greet(who => 'Alice');   -- 명명 매개변수 호출
```

Spring Boot 3.x의 `JdbcClient`에서는 리터럴을 문자열로 이어 붙이지 않고 파라미터에 바인딩하며, 날짜는 캐스팅 대신 타입이 있는 자바 값으로 넘긴다.

```java
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.List;

@Repository
public class OrderQueryRepository {

    private final JdbcClient jdbc;

    public OrderQueryRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record OrderContact(long id, String contact, java.math.BigDecimal amountWithTax) {}

    public List<OrderContact> findPaidSince(LocalDate since, String status) {
        return jdbc.sql("""
                SELECT o.id,
                       u.name || ' <' || COALESCE(u.email, 'no-email') || '>' AS contact,
                       (o.amount * 1.1)::NUMERIC(12, 2)                       AS amount_with_tax
                FROM   orders o
                JOIN   users  u ON u.id = o.user_id
                WHERE  o.status = :status
                  AND  o.created_at >= :since
                ORDER  BY o.id
                """)
            .param("status", status)
            .param("since", since)
            .query(OrderContact.class)
            .list();
    }
}
```

## 실무에서 걸리는 지점

- ==**큰따옴표와 작은따옴표 혼동.**== 자바 습관대로 `WHERE name = "Alice"`라고 쓰면 `Alice`라는 컬럼을 찾다가 실패한다. 대소문자가 섞인 식별자를 큰따옴표로 만들어 두면 이후 모든 쿼리에서 따옴표를 강제하게 되므로 처음부터 소문자 snake_case로 통일한다.
- **정수 나눗셈과 `::` 우선순위.** `SUM(a) / COUNT(*)`는 정수로 잘려 평균이 틀리게 나온다. 한쪽을 `NUMERIC`으로 캐스팅하되 `::`의 범위를 괄호로 명시한다.
- **NULL 전파.** `||`로 이름과 이메일을 이어 붙이다 이메일이 NULL이면 결과 전체가 NULL이 된다. `COALESCE`나 `CONCAT`으로 기본값을 정하고, 조건에서는 `IS NULL`을 쓴다.
- **AND·OR 혼합.** `status = 'PAID' AND region = 'KR' OR vip = TRUE`는 VIP 전체를 포함하는 조건이 된다. 두 논리 연산자가 한 WHERE에 같이 오면 괄호를 친다.
- **예약어 식별자와 명명 매개변수.** `order`·`user`·`limit` 같은 이름은 예약어와 충돌하므로 피한다. 매개변수가 여러 개인 함수는 `name => value`로 호출해야 시그니처가 바뀌어도 호출부가 조용히 깨지지 않는다.

## 관련 글

- [SELECT와 JOIN 표준 패턴](/notes/postgresql/select-join/)
- [쿼리 구조 — SELECT 절·FROM·WHERE·GROUP BY](/notes/postgresql/query-structure/)
- [데이터 타입과 JSONB](/notes/postgresql/data-types-jsonb/)
