---
title: "백업과 복구 — pg_dump·PITR"
series: postgresql
part: "운영"
order: 23
summary: "논리·물리·PITR 세 가지 백업을 언제 쓰고, WAL 아카이브로 특정 시점까지 어떻게 복원하는가"
tags: [PostgreSQL, pg_dump, pg_basebackup, PITR, WAL]
sources: [data-infra/2026-05-17-pg-backup.md]
updated: 2026-08-29
---

복제본은 백업을 대신하지 못한다. 잘못된 `DELETE`나 `DROP TABLE`은 스트리밍 복제를 타고 그대로 스탠바이에 전파되고, 디스크 장애나 클라우드 계정 사고는 같은 리전의 모든 노드를 한꺼번에 무력화한다. 백업 설계는 "어느 시점까지의 데이터를 잃어도 되는가(RPO)"와 "얼마나 오래 멈춰도 되는가(RTO)"를 먼저 정한 뒤, 그 요구를 만족하는 방식을 고르는 순서로 진행한다.

## 핵심 개념

PostgreSQL 백업은 세 갈래로 나뉜다.

| 방식 | 도구 | 단위 | 복원 시점 | 제약 |
|---|---|---|---|---|
| 논리 백업 | pg_dump, pg_dumpall | SQL·객체 | 덤프 시각 | 버전·OS 무관, 복원 느림 |
| 물리 백업 | pg_basebackup | 데이터 디렉터리 전체 | 백업 시각 | 동일 메이저 버전·아키텍처 |
| PITR | 물리 백업 + WAL 아카이브 | 클러스터 전체 | 임의 시점 | 아카이브 연속성 필요 |

**논리 백업**은 객체 정의와 데이터를 SQL 또는 이진 아카이브로 뽑는다. `pg_dump`는 데이터베이스 하나를 대상으로 시작 시점 스냅샷 기준의 일관된 덤프를 만든다. 형식은 plain(`-Fp`), custom(`-Fc`), directory(`-Fd`), tar(`-Ft`)이며, 운영에서는 압축되고 테이블 단위 부분 복원이 가능한 custom을 기본으로 쓰고 병렬 덤프(`-j`)가 필요하면 directory를 택한다. 역할·테이블스페이스 같은 글로벌 객체는 `pg_dump`에 포함되지 않으므로 `pg_dumpall --globals-only`로 따로 받는다.

**물리 백업**은 데이터 디렉터리를 파일 수준으로 복사한다. `pg_basebackup`은 복제 프로토콜로 접속해 일관된 사본을 만들고, 백업 중 생성된 WAL도 함께 받아(`-X stream`) 단독 기동이 가능한 상태를 보장한다. 복원이 파일을 풀고 서버를 띄우는 것으로 끝나 대용량에서 RTO가 크게 줄지만, 같은 메이저 버전·같은 플랫폼에서만 쓸 수 있다.

**PITR**은 물리 백업을 출발점으로 그 이후의 WAL 세그먼트를 순서대로 재생해 원하는 시점까지 상태를 전진시킨다. 서버는 `archive_mode = on`과 `archive_command`로 세그먼트가 완성될 때마다 외부 저장소에 복사해야 하며, `wal_level`은 `replica` 이상, 트래픽이 적을 때를 대비해 `archive_timeout`으로 강제 전환 주기를 둔다. 복원 시에는 데이터 디렉터리에 `recovery.signal` 파일을 두고 `restore_command`, `recovery_target_time`(또는 `recovery_target_lsn`), `recovery_target_action`을 지정한 뒤 기동한다. 서버는 목표 시점까지 WAL을 적용한 후 `promote`이면 새 타임라인으로 서비스를 시작한다.

하루 한 번 `pg_dump`는 RPO 24시간, PITR은 마지막 아카이브 세그먼트까지(대개 1분 이내)이며, Multi-AZ 복제를 더하면 RTO도 1분 이내로 내려간다. 운영 표준은 PITR을 주 백업으로, 주기적 `pg_dump`를 이관·개별 테이블 복구용 보조로 두는 조합이다. WAL-G와 pgBackRest는 아카이빙·증분 백업·객체 스토리지 업로드·보존 정책을 묶어 주므로 직접 명령을 조합하는 대신 이 도구를 쓴다. RDS는 `backup_retention_period`를 1 이상으로 두면 자동 시점 복원이 가능하고, Aurora는 새 인스턴스 없이 클러스터를 되돌리는 Backtrack을 제공한다.

## 코드

논리 백업을 custom 형식으로 받고 병렬로 복원하는 명령이다. `--no-owner --no-privileges`는 다른 환경으로 옮길 때 소유자·권한 오류를 피하기 위해 붙인다.

```bash
pg_dump -h source -U postgres -Fc --schema=public --exclude-table='logs_*' mydb -f mydb.dump
pg_dumpall -h source -U postgres --globals-only -f globals.sql

psql -h target -U postgres -d postgres -f globals.sql
pg_restore -h target -U postgres -j 4 --no-owner --no-privileges \
    --create --clean --if-exists -d postgres mydb.dump
```

WAL 아카이빙 설정과 PITR 복원 절차다. `archive_command`는 종료 코드 0을 반환해야 아카이브 성공으로 간주하며, 같은 파일이 이미 있으면 덮어쓰지 않고 실패하도록 만드는 편이 안전하다.

```bash
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
archive_timeout = 60

# 베이스 백업
pg_basebackup -h source -U replicator -D /backup/base -Ft -z -X stream -P

# 복원: 데이터 디렉터리 초기화 후 베이스 풀기
tar -xzf /backup/base/base.tar.gz -C /var/lib/postgresql/data
tar -xzf /backup/base/pg_wal.tar.gz -C /var/lib/postgresql/data/pg_wal
touch /var/lib/postgresql/data/recovery.signal

# postgresql.conf 에 추가
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-08-29 14:30:00+09'
recovery_target_action = 'promote'

systemctl start postgresql
```

Spring Boot에서 WAL 아카이브 상태를 감시하는 예다. `pg_stat_archiver`의 마지막 실패가 마지막 성공보다 늦으면 DOWN으로 판정한다.

```java
@Component
@RequiredArgsConstructor
public class WalArchiveHealthIndicator implements HealthIndicator {

    private final JdbcClient jdbcClient;

    @Override
    public Health health() {
        record ArchiverStat(long failedCount, OffsetDateTime lastArchived, OffsetDateTime lastFailed) {}

        ArchiverStat stat = jdbcClient.sql("""
                SELECT failed_count, last_archived_time, last_failed_time
                FROM pg_stat_archiver
                """)
            .query((rs, i) -> new ArchiverStat(
                rs.getLong("failed_count"),
                rs.getObject("last_archived_time", OffsetDateTime.class),
                rs.getObject("last_failed_time", OffsetDateTime.class)))
            .single();

        boolean failing = stat.lastFailed() != null
            && (stat.lastArchived() == null || stat.lastFailed().isAfter(stat.lastArchived()));

        Health.Builder builder = failing ? Health.down() : Health.up();
        return builder
            .withDetail("failedCount", stat.failedCount())
            .withDetail("lastArchived", stat.lastArchived())
            .build();
    }
}
```

## 실무에서 걸리는 지점

- **아카이브 실패가 디스크를 채운다.** `archive_command`가 실패하면 해당 세그먼트를 지우지 않고 재시도하므로 `pg_wal`이 계속 커지고 결국 서버가 멈춘다. `pg_stat_archiver`의 `failed_count`와 `pg_wal` 용량에 알람을 건다.
- **검증하지 않은 백업은 없는 것과 같다.** 백업 파일 손상이나 절차 누락은 사고 당일에야 드러난다. 분기마다 별도 인스턴스에 실제로 복원해 핵심 테이블 건수와 최신 레코드를 확인한다.
- **논리 백업은 복원이 느리고 일관성 범위가 좁다.** 수백 GB 규모에서는 `pg_restore`가 인덱스 재생성 때문에 수 시간 걸리고, 여러 데이터베이스를 각각 덤프하면 서로 다른 시점이 섞인다. 재해 복구는 물리 백업과 PITR에 맡긴다.
- **복원 목표 시점은 시간대와 타임라인을 포함한다.** `recovery_target_time`에 시간대를 생략하면 서버 기본 시간대로 해석된다. 한 번 promote한 뒤 다른 시점으로 다시 복원하려면 새 타임라인이 생겼으므로 `recovery_target_timeline` 지정이 필요하다.
- **저장 위치와 암호화.** 원본과 같은 데이터센터에만 두면 장애 범위가 겹친다. 객체 스토리지에 다른 리전 복제를 걸고 저장 시 암호화하며, 보존은 일·주·월 단계로 나눈다. 관리형 서비스의 자동 백업을 비용 이유로 끄면 시점 복원 자체가 불가능해지므로 최소 7일은 유지한다.

## 관련 글

- [내부 구조 — Storage Engine·페이지·WAL](/notes/postgresql/storage-engine-wal/)
- [복제·CAP·분산 트랜잭션](/notes/postgresql/replication-cap-saga/)
- [운영 설치와 postgresql.conf](/notes/postgresql/production-install-config/)
