---
title: "운영 설치와 postgresql.conf"
series: postgresql
part: "운영"
order: 21
summary: "운영 PostgreSQL은 배포 옵션을 먼저 고르고, 기본값을 버리고 메모리·WAL·로그·계획자 설정을 호스트에 맞춰 튜닝한다"
tags: [PostgreSQL, postgresql.conf, RDS, Docker, tuning]
sources: [data-infra/2026-05-17-pg-install-binaries.md, data-infra/2026-05-17-pg-runtime-config.md]
updated: 2026-08-29
---

개발 PC에서 `apt install`로 띄운 PostgreSQL을 그대로 운영에 올리면 두 가지 문제가 생긴다. 단일 인스턴스라 디스크 장애나 패치 재시작이 곧 다운타임이 되고, 백업과 페일오버가 전부 사람 손에 달린다. ==또 기본 설정은 1GB급 호스트를 가정한 값이라 `shared_buffers` 128MB, `random_page_cost` 4가 32GB SSD 서버에서도 그대로 적용된다.== 메모리는 놀고 계획자는 순차 스캔을 고르며, 슬로우 쿼리 로그가 꺼져 있어 원인을 찾을 수도 없다.

## 핵심 개념

### 배포 옵션

| 옵션 | 운영 책임 | 적합한 경우 |
|---|---|---|
| 직접 바이너리 | OS·튜닝·백업·HA 전부 자체 | 온프레미스, 전담 DBA 보유 |
| Docker | 컨테이너·볼륨·백업 자체 | 온프레미스, 로컬·CI |
| 관리 서비스 (RDS·Aurora·Cloud SQL) | 백업·패치·페일오버는 클라우드 | 일반 서비스의 표준 |
| 서버리스 (Neon·Supabase) | 사용량 과금, 거의 전부 클라우드 | 사이드 프로젝트 |

관리 서비스는 자동 백업, Multi-AZ 페일오버, Read Replica, 패치 자동화를 기본 제공하지만 슈퍼유저가 없어 일부 확장을 못 쓰고 `postgresql.conf`를 직접 편집하지 못한다. Aurora는 6중 복제 분산 스토리지를 쓰며 페일오버가 10~30초로 빠르지만 비용이 1.5~2배다. 대부분은 RDS Multi-AZ에서 시작하고 트래픽이 커지면 Aurora를 검토한다. 환경은 로컬(Docker) → CI(Testcontainers) → Dev → Staging → Prod로 분리하고 메이저 버전·확장·파라미터를 일치시킨다.

### 설정 우선순위와 적용 방식

설정은 명령행 옵션 > `ALTER SYSTEM`(`postgresql.auto.conf`) > `postgresql.conf` > include 파일 > 기본값 순으로 우선하며, 현재 값과 출처는 `pg_settings`의 `source` 컬럼으로 본다. 파라미터는 세션 `SET`으로 바뀌는 것(`work_mem`), `pg_reload_conf()`로 반영되는 것(`log_min_duration_statement`), 재시작이 필요한 것(`shared_buffers`, `max_connections`, `shared_preload_libraries`)으로 나뉜다. ==`pg_settings.context`가 `postmaster`이면 재시작 대상이다.==

### 영역별 핵심 파라미터

메모리는 `shared_buffers` RAM 25%, `effective_cache_size` 75%다. 후자는 할당이 아니라 OS 캐시까지 포함한 기대 캐시량을 계획자에게 알려주는 힌트다. `work_mem`은 정렬·해시 연산 하나당 할당되므로 세션 수와 곱해 총량을 본다. WAL은 `wal_level = replica`, `max_wal_size` 4GB, `checkpoint_timeout` 15min이 시작점이며 `fsync`와 `synchronous_commit`은 켜 둔다. 계획자는 SSD라면 `random_page_cost` 1.1, `effective_io_concurrency` 200으로 바꾼다. 기본값은 HDD 기준이라 인덱스 스캔의 랜덤 I/O 비용을 과대평가한다. 로그는 슬로우 쿼리·체크포인트·락 대기·임시 파일·autovacuum을 켜고 pgBadger로 집계한다. 확장은 `pg_stat_statements`(쿼리별 누적 통계)와 `auto_explain`(임계 초과 쿼리의 실행 계획 자동 로깅)을 적재한다. 인증은 `pg_hba.conf`에서 `scram-sha-256`을 쓴다.

## 코드

운영용 Docker Compose. 비밀번호는 secrets로, 설정 파일은 외부 주입으로, 볼륨과 헬스체크를 둔다.

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_DB: appdb
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgresql.conf:/etc/postgresql/postgresql.conf:ro
      - ./pg_hba.conf:/etc/postgresql/pg_hba.conf:ro
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf",
              "-c", "hba_file=/etc/postgresql/pg_hba.conf"]
    secrets:
      - db_password
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres", "-d", "appdb"]
      interval: 10s
      timeout: 5s
      retries: 5
    ports:
      - "5432:5432"

secrets:
  db_password:
    file: ./secrets/db_password.txt

volumes:
  pgdata:
```

8GB RAM·SSD 호스트를 가정한 `postgresql.conf` 시작점.

```ini
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 16MB
maintenance_work_mem = 512MB
huge_pages = try

listen_addresses = '*'
max_connections = 100
password_encryption = scram-sha-256

wal_level = replica
max_wal_size = 4GB
min_wal_size = 1GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = on
synchronous_commit = on

random_page_cost = 1.1
effective_io_concurrency = 200
default_statistics_target = 100

logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_rotation_age = 1d
log_line_prefix = '%t [%p]: user=%u,db=%d,app=%a,client=%h '
log_min_duration_statement = 1000
log_checkpoints = on
log_lock_waits = on
log_temp_files = 0
log_autovacuum_min_duration = 0

shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = '5s'
auto_explain.log_analyze = on
auto_explain.log_buffers = on

autovacuum_max_workers = 4
autovacuum_vacuum_cost_delay = 2ms
timezone = 'Asia/Seoul'
```

설정 확인과 동적 변경. RDS는 같은 값을 파라미터 그룹으로 적용한다.

```sql
SELECT name, setting, unit, source, context, pending_restart
FROM pg_settings
WHERE name IN ('shared_buffers', 'random_page_cost',
               'log_min_duration_statement', 'shared_preload_libraries');

-- reload로 반영되는 항목
ALTER SYSTEM SET log_min_duration_statement = 500;
SELECT pg_reload_conf();

-- context = 'postmaster' 항목은 재시작 전까지 pending_restart = true
ALTER SYSTEM SET shared_buffers = '4GB';

-- 큰 테이블은 autovacuum 임계 비율을 테이블 단위로 낮춘다
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.05,
                        autovacuum_analyze_scale_factor = 0.02);
```

## 실무에서 걸리는 지점

- **`ALTER SYSTEM`과 파일 편집의 충돌.** `postgresql.auto.conf`가 `postgresql.conf`보다 우선한다. 파일을 고쳤는데 값이 안 바뀌면 `pg_settings.source`로 auto.conf에 같은 키가 있는지 확인한다. IaC로 관리한다면 `ALTER SYSTEM` 사용을 금지하는 편이 안전하다.
- ==**`max_connections`를 키워서 연결 문제를 푸는 것.**== 연결 하나가 프로세스 하나이며 `work_mem`도 연결마다 곱해진다. HikariCP와 PgBouncer를 두고 `max_connections`는 100 안팎으로 유지한다.
- **`shared_preload_libraries` 변경은 재시작 대상.** 첫 셋업에 넣고, RDS는 `apply_method = "pending-reboot"`로 지정해 유지보수 창에 반영한다.
- **autovacuum 기본 임계가 큰 테이블에 너무 느슨함.** `autovacuum_vacuum_scale_factor` 0.2는 1억 행 테이블에서 2천만 행이 죽어야 VACUUM이 시작된다는 뜻이다. 큰 테이블에 개별 저장 파라미터를 설정하고 autovacuum 로그로 실행 주기를 검증한다.
- **관리 서비스의 제약을 설계 전에 확인하지 않음.** RDS는 일부 확장과 서버 파일 경로 `COPY`를 쓸 수 없고, Aurora는 일부 WAL 파라미터를 무시한다. 필요한 확장과 파라미터가 지원되는지 인스턴스 생성 전에 확인한다.

## 관련 글

- [설치와 psql 접속](/notes/postgresql/install-psql/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [백업과 복구 — pg_dump·PITR](/notes/postgresql/backup-restore-pitr/)
