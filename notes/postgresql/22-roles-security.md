---
title: "사용자·역할·권한"
series: postgresql
part: "운영"
order: 22
summary: "ROLE 하나로 사용자와 그룹을 통합하고, 그룹 멤버십과 DEFAULT PRIVILEGES로 권한을 최소·자동화하는 방법"
tags: [PostgreSQL, ROLE, GRANT, DEFAULT PRIVILEGES, Row-Level Security]
sources: [data-infra/2026-05-17-pg-user-management.md]
updated: 2026-08-29
---

애플리케이션이 postgres 슈퍼유저 하나로 접속하는 구성은 초기에는 편하지만, 커넥션 문자열 하나가 유출되는 순간 DDL·데이터 삭제·설정 변경까지 모두 열린다. 분석가에게 쓰기 권한이 섞여 들어가거나, 새 테이블을 만들 때마다 GRANT를 잊어 서비스가 permission denied로 멈추는 사고도 권한 체계를 세우지 않은 데서 비롯된다. ==PostgreSQL의 ROLE·GRANT·DEFAULT PRIVILEGES·RLS는 이 문제를 접속 주체 단위로 분리하고, 새 객체에도 권한이 자동 적용되도록 만드는 도구다.==

## 핵심 개념

PostgreSQL 8.1부터 USER와 GROUP은 ROLE 하나로 통합됐다. `LOGIN` 속성이 있으면 접속 가능한 사용자로, `NOLOGIN`이면 권한을 묶는 그룹으로 동작한다. `CREATE USER`는 `CREATE ROLE ... LOGIN`의 별칭일 뿐이다. 그룹 역할을 사용자 역할에 `GRANT group TO user`로 부여하면 멤버십이 생기고, 사용자가 `INHERIT`(기본값)이면 그룹 권한을 자동으로 사용한다. `NOINHERIT`이면 `SET ROLE`로 명시적으로 전환해야만 그룹 권한이 살아난다.

ROLE 속성은 시스템 수준 능력을 정한다. `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`, `CONNECTION LIMIT`, `VALID UNTIL`이 대표적이다. `CREATEROLE`은 PostgreSQL 16부터 자신이 만든 역할만 관리하도록 축소됐다.

객체 권한은 `GRANT 권한 ON 객체 TO 역할` 형태로 통일되며, 대상 객체에 따라 권한 종류가 다르다.

| 객체 | 주요 권한 | 의미 |
|---|---|---|
| DATABASE | CONNECT, CREATE | 접속 허용, 스키마 생성 |
| SCHEMA | USAGE, CREATE | 스키마 내 객체 참조, 객체 생성 |
| TABLE | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES | 행 단위 DML, FK 참조 |
| COLUMN | SELECT, INSERT, UPDATE | 컬럼 단위 제한 |
| SEQUENCE | USAGE, SELECT, UPDATE | nextval 호출 등 |
| FUNCTION | EXECUTE | 실행 |

접속 경로는 계층적이다. 데이터베이스 CONNECT, 스키마 USAGE, 테이블 SELECT가 모두 있어야 한 행을 읽을 수 있다. PostgreSQL 15부터 public 스키마의 CREATE가 PUBLIC에서 제거됐으므로, 일반 역할이 public에 객체를 만들려면 CREATE를 명시적으로 부여한다.

==`GRANT ... ON ALL TABLES IN SCHEMA`는 실행 시점에 존재하는 객체에만 적용된다.== 이후 생성되는 객체는 `ALTER DEFAULT PRIVILEGES`로 처리하며, `FOR ROLE`로 "어떤 역할이 만드는 객체에" 적용할지를 지정한다.

Row-Level Security는 테이블 권한 아래에 행 단위 필터를 추가한다. `CREATE POLICY`의 `USING`은 읽기·갱신 대상 행을, `WITH CHECK`는 쓰기 허용 행을 정한다. 테이블 소유자와 `BYPASSRLS` 역할은 정책을 우회한다.

비밀번호 해시는 PostgreSQL 14부터 `scram-sha-256`이 기본값이다. md5는 폐기 예정이며 `pg_hba.conf`의 인증 방식도 같이 맞춘다.

## 코드

운영 표준으로 쓰는 그룹 역할 4종과 사용자 가입 구성이다. 사용자에게는 직접 GRANT하지 않고 그룹 멤버십만 부여한다.

```sql
-- 읽기 전용 그룹
CREATE ROLE readonly NOLOGIN;
GRANT CONNECT ON DATABASE mydb TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;

-- 앱 CRUD 그룹
CREATE ROLE app_rw NOLOGIN;
GRANT CONNECT ON DATABASE mydb TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- 마이그레이션(DDL) 그룹 — 테이블 소유자
CREATE ROLE migrator NOLOGIN;
GRANT CONNECT, CREATE ON DATABASE mydb TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;

-- migrator 가 만드는 새 객체에 자동 권한
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
    GRANT SELECT ON TABLES TO readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- 로그인 사용자 = 그룹 가입만
CREATE ROLE app_prod LOGIN PASSWORD 'from-secret-manager' CONNECTION LIMIT 50;
GRANT app_rw TO app_prod;

CREATE ROLE flyway_prod LOGIN PASSWORD 'from-secret-manager';
GRANT migrator TO flyway_prod;

CREATE ROLE analyst_kim LOGIN PASSWORD 'from-secret-manager' VALID UNTIL '2026-12-31';
GRANT readonly TO analyst_kim;
```

멀티 테넌트 테이블에 RLS를 걸고, 세션 변수로 테넌트를 식별하는 정책이다. 소유자가 아닌 app_rw 계정으로 접속해야 정책이 적용된다.

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- 소유자에게도 적용

CREATE POLICY orders_tenant ON orders
    FOR ALL
    TO app_rw
    USING (tenant_id = current_setting('app.tenant_id', true)::BIGINT)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::BIGINT);
```

Spring Boot 3.x에서 쓰기 경로와 읽기 경로를 다른 계정·다른 호스트로 분리하고, 트랜잭션마다 테넌트 세션 변수를 심는 구성이다. `SET LOCAL`은 트랜잭션 종료 시 자동 해제되므로 커넥션 풀에 값이 남지 않는다.

```yaml
# application-prod.yml
spring:
  datasource:
    url: jdbc:postgresql://primary.internal:5432/mydb
    username: app_prod
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 20
  flyway:
    url: jdbc:postgresql://primary.internal:5432/mydb
    user: flyway_prod
    password: ${FLYWAY_PASSWORD}

readonly:
  datasource:
    url: jdbc:postgresql://replica.internal:5432/mydb
    username: analyst_kim
    password: ${RO_DB_PASSWORD}
```

```java
@Component
public class TenantSessionAspect {

    private final JdbcClient jdbcClient;

    public TenantSessionAspect(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void bind(long tenantId) {
        // SET LOCAL 은 파라미터 바인딩이 안 되므로 set_config 함수를 쓴다
        jdbcClient.sql("SELECT set_config('app.tenant_id', :tenant, true)")
                .param("tenant", String.valueOf(tenantId))
                .query(String.class)
                .single();
    }
}
```

## 실무에서 걸리는 지점

- ==앱 계정이 테이블 소유자면 RLS가 무력화된다.== 마이그레이션 계정이 소유자가 되고 앱 계정은 별도 역할로 두거나, `FORCE ROW LEVEL SECURITY`를 걸어야 정책이 실제로 작동한다.
- `ALTER DEFAULT PRIVILEGES`에서 `FOR ROLE`을 생략하면 명령을 실행한 역할이 만드는 객체에만 적용된다. DBA가 실행하고 migrator가 테이블을 만들면 기본 권한은 한 번도 발동하지 않는다. 스키마 단위이므로 새 스키마마다 다시 건다.
- 테이블 DML만 주고 SEQUENCE의 USAGE를 빠뜨리면 `bigserial`·identity 컬럼 INSERT가 실패한다. `ON ALL SEQUENCES`를 함께 부여한다.
- `DROP ROLE`은 그 역할이 소유하거나 권한을 받은 객체가 있으면 실패한다. `REASSIGN OWNED BY old TO new` 후 `DROP OWNED BY old`로 정리하며, 두 명령 모두 데이터베이스 단위라 클러스터의 모든 DB에서 반복한다.
- PostgreSQL 15 이하에서 `CREATEROLE`은 사실상 슈퍼유저에 준하므로 앱 계정에 주지 않는다. 16으로 올릴 때 동작이 바뀌어 기존 관리 스크립트가 실패할 수 있다.
- 비밀번호를 `.env`나 설정 파일에 평문으로 두지 않는다. Secrets Manager·Vault에서 주입하고, 임시 계정은 `VALID UNTIL`로 만료를 걸며, `pg_hba.conf`에 접속 원 IP 제한을 함께 적용한다.

## 관련 글

- [운영 설치와 postgresql.conf](/notes/postgresql/production-install-config/)
- [MVCC·격리 수준·락](/notes/postgresql/mvcc-isolation-locking/)
- [백업과 복구 — pg_dump·PITR](/notes/postgresql/backup-restore-pitr/)
