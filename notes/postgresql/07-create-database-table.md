---
title: "데이터베이스와 테이블 만들기"
series: postgresql
part: "시작"
order: 7
summary: "CREATE DATABASE와 CREATE TABLE의 표준 옵션, 제약 설계, 운영에서 안전하게 만들고 지우는 절차를 정리한다."
tags: [PostgreSQL, CREATE DATABASE, CREATE TABLE, DDL, 제약]
sources: [data-infra/2026-05-17-pg-create-database.md, data-infra/2026-05-17-pg-create-table.md, data-infra/2026-05-17-pg-managing-databases.md]
updated: 2026-08-29
---

설치 직후 클러스터에는 `postgres`, `template0`, `template1` 세 데이터베이스만 있다. 여기에 애플리케이션 테이블을 직접 만들고 슈퍼유저로 접속하면 프로젝트 간 격리가 없고, 앱의 버그가 클러스터 전체 권한으로 실행된다. 인코딩과 로케일은 DB를 다시 만들지 않는 한 바꿀 수 없다. 기본 키·NOT NULL·CHECK 없는 테이블은 잘못된 데이터를 거부하지 못하고 정합성 검사가 애플리케이션 코드에 흩어진다. 처음 만들 때 옵션과 제약을 명시적으로 결정해야 한다.

## 핵심 개념

### 계층 구조와 격리

PostgreSQL은 Cluster → Database → Schema → Table 네 단계로 객체를 조직한다. 프로젝트마다 데이터베이스를 하나 만들며, 같은 클러스터 안의 데이터베이스는 서로 격리되어 다른 DB의 테이블을 직접 조회할 수 없고 권한과 설정도 DB 단위로 분리된다.

### CREATE DATABASE와 템플릿

`CREATE DATABASE`는 기존 데이터베이스를 복사하는 방식으로 동작한다. ==기본 원본은 `template1`이며, 여기에 추가된 객체는 이후 만드는 모든 DB에 복제된다.== `template0`은 수정되지 않는 빈 템플릿이어서 다른 인코딩·로케일을 지정할 때 필수이고 깨끗한 시작을 위해서도 명시한다. `TEMPLATE original_db`로 임의의 DB를 복제할 수도 있으며, 원본에 다른 세션이 없어야 한다. 대용량·원격 복제는 `pg_dump -Fc`와 `pg_restore`를 쓴다.

주요 옵션은 다음과 같다.

| 옵션 | 역할 | 권장값 |
|---|---|---|
| `OWNER` | 소유자 | 앱 전용 역할 |
| `ENCODING` | 인코딩 | `UTF8` |
| `LC_COLLATE` / `LC_CTYPE` | 정렬 / 문자 분류 | `ko_KR.UTF-8` 또는 `C` |
| `TEMPLATE` | 복제 원본 | `template0` |
| `CONNECTION LIMIT` | 동시 접속 상한 | 유한값 |
| `ALLOW_CONNECTIONS` | 접속 허용 | 유지보수 시 `FALSE` |

`createdb`와 `dropdb`는 같은 SQL을 실행하는 OS 명령이다. `ALTER DATABASE ... SET`으로 `timezone`, `search_path`, `work_mem` 같은 파라미터를 DB 단위로 바꿀 수 있다.

### CREATE TABLE과 제약

`CREATE TABLE`은 DDL의 핵심으로, 컬럼마다 타입과 제약을 선언한다. 자주 쓰는 타입은 `BIGINT GENERATED ALWAYS AS IDENTITY`(자동 증가 정수), `TEXT`, `BOOLEAN`, `TIMESTAMPTZ`, `DATE`, `NUMERIC(p,s)`, `JSONB`다. `BIGSERIAL`도 동작하지만 SQL 표준인 IDENTITY 컬럼이 시퀀스 권한 면에서 명확하다. 문자열은 `VARCHAR(N)` 대신 `TEXT`를 쓰고 길이 제한은 `CHECK`로 건다. 두 타입의 저장 방식과 성능은 같다.

제약은 여섯 가지다. `NOT NULL`은 값 누락을 거부하고, `UNIQUE`는 중복을 막으며 인덱스를 자동 생성한다. `PRIMARY KEY`는 둘을 합친 행 식별자로 테이블당 하나다. `DEFAULT`는 값이 생략됐을 때 채워지고, `CHECK`는 조건식 위반을 거부하며, `REFERENCES`는 다른 테이블의 키를 참조해 참조 무결성을 보장한다.

## 코드

앱 전용 역할을 만들고 그 역할 소유로 데이터베이스를 생성한 뒤 DB 단위 설정을 지정하는 표준 절차다.

```sql
CREATE ROLE appuser WITH LOGIN PASSWORD 'strongpass';

CREATE DATABASE myappdb
    WITH OWNER            = appuser
         ENCODING         = 'UTF8'
         LC_COLLATE       = 'ko_KR.UTF-8'
         LC_CTYPE         = 'ko_KR.UTF-8'
         TEMPLATE         = template0
         CONNECTION LIMIT = 100;

ALTER DATABASE myappdb SET timezone = 'Asia/Seoul';

-- 접속 전환과 확인
\c myappdb appuser
\l
```

여섯 제약이 모두 들어간 테이블 정의다. `IF NOT EXISTS`로 반복 실행해도 안전하다.

```sql
CREATE TABLE IF NOT EXISTS users (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    amount     NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    status     TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'PAID', 'CANCELED', 'SHIPPED', 'DELIVERED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

\d users
```

`users` 테이블에 대응하는 Spring Boot 3.x JPA 엔티티다. `IDENTITY` 전략은 키 생성을 DB에 맡기고, `@Generated`와 `insertable = false`로 `created_at`의 DB DEFAULT를 그대로 쓴다.

```java
import jakarta.persistence.*;
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;
import java.time.OffsetDateTime;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(unique = true)
    private String email;

    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", insertable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected User() {}

    public User(String name, String email) {
        this.name = name;
        this.email = email;
    }
}
```

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/myappdb
    username: appuser
    password: ${DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
```

`ddl-auto`는 `validate`로 두어 엔티티와 테이블이 어긋나면 기동에 실패하게 하고, 스키마 변경은 Flyway로 관리한다.

## 실무에서 걸리는 지점

- **인코딩·로케일은 되돌릴 수 없다.** `SQL_ASCII`로 만든 DB는 덤프 후 새 DB에 복원해야 한다. ==`ko_KR.UTF-8` 콜레이션은 `C`보다 비교 비용이 크고 LIKE 접두 검색에 B-Tree 인덱스가 쓰이지 않으므로==, `C` 로케일에 컬럼별 COLLATE를 얹는 선택도 검토한다.
- **DROP DATABASE는 접속이 있으면 실패하고 취소할 수 없다.** 자기 자신에게 접속한 채로는 지울 수 없어 `\c postgres`로 옮긴 뒤 실행하고, 다른 세션은 `pg_terminate_backend(pid)`로 끊거나 `ALLOW_CONNECTIONS = FALSE`로 차단한다. 백업 확인 후 운영 시간 외에 실행한다.
- **CONNECTION LIMIT 기본값은 무제한이다.** 한 DB가 커넥션을 모두 점유하면 다른 DB까지 접속 불가가 된다. 커넥션 풀 합계보다 약간 큰 값으로 상한을 둔다.
- **큰 테이블의 ALTER TABLE은 락을 잡는다.** ==`ALTER COLUMN ... TYPE`이나 `NOT NULL` 추가는 테이블 전체를 다시 쓰거나 검사하며 쓰기가 막힌다.== 상수 DEFAULT 컬럼 추가는 즉시 끝나므로, 변경별 락 수준을 확인하고 필요하면 `pg_repack`이나 단계적 마이그레이션으로 나눈다.
- **`idle in transaction` 세션이 DDL을 대기시킨다.** ==열어 둔 트랜잭션이 있으면 ALTER와 DROP이 락을 기다리고 뒤따르는 쿼리까지 막힌다.== `pg_stat_activity`에서 오래된 세션을 정리하고 DDL 전에 `lock_timeout`을 설정한다.

## 관련 글

- [설치와 psql 접속](/notes/postgresql/install-psql/)
- [DDL 깊이 — CREATE TABLE·파티션·제약·외래 키](/notes/postgresql/ddl-tables-constraints/)
- [사용자·역할·권한](/notes/postgresql/roles-security/)
