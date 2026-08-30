---
title: "설치와 psql 접속"
series: postgresql
part: "시작"
order: 6
summary: "로컬 PostgreSQL을 Docker로 띄우고 psql 접속 옵션·메타 명령·인증 파일을 표준 형태로 정리한다"
tags: [PostgreSQL, psql, Docker, pg_hba.conf, Spring Boot]
sources: [data-infra/2026-05-17-pg-install.md, data-infra/2026-05-17-pg-psql-start.md, data-infra/2026-05-17-pg-access-database.md]
updated: 2026-08-29
---

PostgreSQL 작업은 서버 프로세스를 띄우고 클라이언트로 접속하는 데서 시작한다. 이 단계가 정리되어 있지 않으면 설치 방식마다 초기 사용자와 인증 규칙이 달라 접속에서 막히고, 개발 PC·CI·운영 서버 환경이 제각각이 되어 같은 SQL이 한 곳에서만 동작한다. 비밀번호를 환경 변수에 평문으로 남기는 습관도 여기서 굳어진다. 설치는 Docker를 기본으로 하고, 접속은 psql의 옵션·URI·설정 파일을 구분해 둔다.

## 핵심 개념

설치 경로는 세 가지다. Docker는 호스트를 오염시키지 않고 버전을 격리하며 CI·운영과 같은 이미지를 쓰므로 기본 선택이다. Homebrew는 macOS 네이티브 설치로 `postgres` 슈퍼유저와 OS 사용자명 롤을 자동 생성해 비밀번호 없이 로컬 접속이 된다. apt는 Ubuntu·Debian용으로 운영 서버에 가장 가깝고, `sudo -u postgres psql`로 접속한다. Windows는 WSL2 위의 apt 또는 Docker Desktop을 쓴다.

Docker 컨테이너는 `POSTGRES_PASSWORD`가 없으면 기동을 거부한다. `/var/lib/postgresql/data`는 컨테이너 삭제와 함께 사라지므로 named volume을 마운트한다.

psql은 PostgreSQL의 표준 CLI 클라이언트다. 접속 정보는 호스트·포트·사용자·데이터베이스·비밀번호·인증 방식 여섯 변수의 조합이며, 옵션 `-h`·`-p`·`-U`·`-d`·`-W`가 앞의 다섯을 담당한다. 기본값은 호스트가 Unix 소켓, 포트 5432, 사용자는 OS 사용자명, 데이터베이스는 사용자명과 같은 이름이다. 같은 접속을 connection URI(`postgresql://user@host:port/db`), `key=value` 문자열, `PGHOST` 같은 환경 변수로도 표현하며, 스크립트에서는 URI가 다루기 쉽다.

프롬프트 `postgres=#`는 현재 DB, 입력 대기, 슈퍼유저 여부(일반 사용자는 `>`)를 표시한다. 세미콜론 없이 줄을 바꾸면 `-#`로 바뀌어 문장이 끝나지 않았음을 알린다. 백슬래시 메타 명령은 SQL이 아니라 psql 자체의 기능이다.

| 명령 | 기능 |
|---|---|
| `\?` / `\h SELECT` | psql 도움말 / SQL 문법 도움말 |
| `\l` / `\c db [user]` | DB 목록 / DB·사용자 전환 |
| `\dt` / `\d name` | 테이블 목록 / 객체 구조 |
| `\du` / `\dn` | 롤 목록 / 스키마 목록 |
| `\timing` / `\x` | 실행 시간 토글 / 확장 표시 토글 |
| `\e` / `\i file` / `\copy` | 외부 에디터 / 파일 실행 / 클라이언트 파일 입출력 |
| `\conninfo` / `\q` | 접속 정보 / 종료 |

`\c - appuser`의 `-`는 현재 값 유지로, DB를 둔 채 사용자만 바꾼다. 전환 시 새 backend 프로세스가 생성되어 진행 중이던 트랜잭션은 종료된다.

원격 접속은 서버의 `pg_hba.conf`에서 허용 IP와 인증 방식을 모두 만족해야 통과한다. 인증 방식은 `trust`(무인증, 개발 전용), `peer`(OS 사용자명 매칭, 로컬 소켓), `md5`(PostgreSQL 18부터 deprecated), `scram-sha-256`(현행 표준)이 있고 신규 설정은 `scram-sha-256`만 쓴다. `postgresql.conf`의 `listen_addresses`가 `localhost`면 외부 TCP 접속이 열리지 않는다.

비밀번호는 `~/.pgpass`에 `host:port:db:user:password` 형식으로 두고 `chmod 600`을 적용한다. ==권한이 느슨하면 psql이 파일을 무시한다.== `~/.psqlrc`에는 `\timing on` 같은 설정을 넣는다.

## 코드

개발용 컨테이너를 named volume과 함께 띄우고 접속한 뒤 설치를 검증한다.

```bash
docker run -d \
  --name postgres-dev \
  -e POSTGRES_PASSWORD=devpass \
  -p 5432:5432 \
  -v pgdata:/var/lib/postgresql/data \
  postgres:18

docker exec -it postgres-dev psql -U postgres
```

```sql
SELECT version();
SELECT current_user;
\l
CREATE DATABASE myappdb;
\c myappdb
CREATE TABLE hello (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, msg TEXT);
INSERT INTO hello (msg) VALUES ('Hello PostgreSQL');
SELECT * FROM hello;
\d hello
\q
```

마이그레이션 파일을 한 트랜잭션으로 실행하고 `-c`로 한 줄 질의를 수행한다. 비밀번호는 `.pgpass`에서 읽힌다.

```bash
psql "postgresql://appuser@db.example.com:5432/myappdb" \
  --single-transaction -f migration.sql

psql "postgresql://appuser@db.example.com:5432/myappdb" \
  -v userid=42 -c "SELECT * FROM users WHERE id = :userid;"
```

Spring Boot 3.x 연결 설정이다. 드라이버 클래스는 URL에서 추론되므로 생략하고, 비밀번호는 환경 변수로 주입한다.

```yaml
# application-local.yml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/myappdb
    username: appuser
    password: ${DB_PASSWORD:devpass}

# application-prod.yml
spring:
  datasource:
    url: jdbc:postgresql://${DB_HOST}:${DB_PORT:5432}/${DB_NAME}
    username: ${DB_USER}
    password: ${DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
```

## 실무에서 걸리는 지점

- **포트 5432 충돌.** ==Homebrew PostgreSQL이 떠 있는 상태에서 Docker 컨테이너를 같은 포트로 띄우면 기동이 실패하거나 호스트 쪽 인스턴스에 접속되어 데이터가 엉뚱한 곳에 쌓인다.== 하나만 쓰거나 `-p 5433:5432`로 포트를 분리한다.
- **`localhost`와 Unix 소켓의 인증 규칙 차이.** `psql`만 치면 소켓으로, `-h localhost`를 주면 TCP로 붙고 `pg_hba.conf`의 `local` 행과 `host` 행이 각각 적용된다. 한쪽은 `peer`로 통과하고 다른 쪽은 비밀번호를 요구할 수 있다.
- **`PGPASSWORD` 평문 노출.** 환경 변수로 넘긴 비밀번호는 다른 사용자가 프로세스 환경에서 읽을 수 있다. `.pgpass`를 쓰고, 운영에서는 Secrets Manager나 Vault에서 주입한다. URI 비밀번호의 `@` 같은 특수문자는 `%40`으로 URL 인코딩해야 파싱된다.
- **`COPY`와 `\copy`.** ==`COPY`는 서버 파일 시스템을 읽는 SQL 명령이라 클라이언트의 로컬 파일을 볼 수 없고 별도 권한이 필요하다.== 클라이언트 쪽 CSV는 `\copy`로 옮긴다.
- **인코딩 불일치로 한글이 `?`로 출력.** `SHOW server_encoding`·`SHOW client_encoding`이 모두 UTF8인지 확인하고, 클라이언트는 `\encoding UTF8`로 바꾼다. 서버는 DB 생성 시 UTF8로 만든다.

## 관련 글

- [PostgreSQL이란 — MySQL과의 비교·아키텍처·관계형 모델](/notes/postgresql/what-is-postgresql/)
- [데이터베이스와 테이블 만들기](/notes/postgresql/create-database-table/)
- [사용자·역할·권한](/notes/postgresql/roles-security/)
