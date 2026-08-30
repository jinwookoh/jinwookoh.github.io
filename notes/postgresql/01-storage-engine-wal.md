---
title: "내부 구조 — Storage Engine·페이지·WAL"
series: postgresql
part: "DB 원리"
order: 1
summary: "PostgreSQL이 8KB 페이지와 Buffer Pool, WAL을 조합해 성능과 Durability를 동시에 확보하는 방식을 정리한다."
tags: [PostgreSQL, WAL, Buffer Pool, Page, Storage Engine]
sources: [2026-05-03-db-eng-internals.md]
updated: 2026-08-29
---

디스크는 메모리보다 수천 배 느리다. 모든 UPDATE를 디스크에 즉시 반영하면 처리량이 디스크 랜덤 쓰기 속도에 묶이고, 메모리에만 반영하면 장애 시 커밋된 데이터가 사라진다. 데이터베이스는 이 상충을 페이지 단위 I/O, 메모리 캐시(Buffer Pool), 변경 내역을 먼저 순차 기록하는 WAL(Write-Ahead Logging)로 해결한다. 이 세 층을 모르면 shared_buffers를 왜 조정하는지, 커밋 지연이 왜 fsync에 좌우되는지, 인덱스 스캔이 왜 항상 빠르지는 않은지 설명할 수 없다.

## 핵심 개념

### 처리 흐름

SQL은 Parser가 구문 트리로 바꾸고, Rewriter가 뷰와 규칙을 확장하며, Planner가 통계를 기반으로 실행 계획의 비용을 추정해 하나를 고른다. Executor가 계획을 실행하고 실제 디스크 접근은 Storage Engine이 맡는다. MySQL은 InnoDB·MyISAM처럼 엔진을 교체할 수 있지만 PostgreSQL은 heap 기반 단일 방식을 쓰며, TimescaleDB·Citus 같은 익스텐션으로 확장한다.

### 페이지 — 디스크 I/O의 단위

PostgreSQL은 8KB 고정 크기 페이지 단위로 디스크를 읽고 쓴다. 1바이트를 읽어도 페이지 하나를 통째로 읽으므로 쿼리 비용은 "몇 페이지를 건드리는가"로 환산되며, 인덱스가 빠른 이유도 적은 페이지만 읽고 답에 도달하기 때문이다.

페이지는 24바이트 헤더, 앞에서부터 채워지는 4바이트 아이템 포인터 배열, 뒤에서부터 채워지는 튜플 데이터, 그 사이의 여유 공간으로 구성된다. 각 행은 `ctid`(블록 번호, 아이템 번호)로 물리 위치를 식별하고 인덱스는 이 ctid를 가리킨다. 테이블은 삽입 순서대로 heap에 저장되며, InnoDB처럼 PK 순으로 정렬된 클러스터드 인덱스 구조가 아니다. ==`CLUSTER` 명령은 한 번 재정렬할 뿐 이후 삽입 순서를 유지하지 않는다.==

### Buffer Pool과 Dirty Page

디스크에서 읽은 페이지는 공유 메모리 shared_buffers에 올라간다. 기본값은 128MB이며 전용 서버라면 RAM의 25% 안팎을 권장한다. 공간이 부족하면 Clock-Sweep 알고리즘이 참조 횟수가 낮은 페이지를 밀어낸다.

UPDATE는 메모리 위 페이지만 수정하고 dirty 표시를 남긴다. 디스크 반영은 background writer와 checkpointer가 나중에 수행하므로, 커밋 시점에 데이터 페이지는 아직 디스크에 없다.

### WAL — 변경을 먼저 기록한다

WAL의 규칙은 하나다. 데이터 페이지를 디스크에 쓰기 전에 그 변경 내역을 담은 WAL 레코드가 먼저 fsync되어야 한다.

1. 트랜잭션이 페이지를 수정하면서 변경 내역을 WAL 버퍼에 기록한다.
2. COMMIT 시 WAL 버퍼를 `pg_wal`의 16MB 세그먼트 파일에 쓰고 fsync한다.
3. fsync가 끝난 뒤에야 클라이언트에 커밋 성공을 응답한다.
4. dirty 페이지는 checkpointer가 나중에 flush한다.

장애 후 재시작하면 마지막 checkpoint부터 WAL을 replay해 커밋된 변경을 복원하고, 커밋 레코드가 없는 트랜잭션은 버린다. WAL은 변경분만 담아 작고 항상 순차 쓰기이므로 랜덤 쓰기인 페이지 반영보다 훨씬 빠르다. 각 레코드는 단조 증가하는 LSN(Log Sequence Number)으로 위치를 식별하며, 스트리밍 복제와 PITR도 이 WAL을 전송·보관하는 방식으로 구현된다.

### Checkpoint

Checkpoint는 모든 dirty 페이지를 flush하고 WAL에 "이 지점 이전은 replay가 필요 없다"는 표식을 남긴다. `checkpoint_timeout`(기본 5분) 또는 `max_wal_size` 초과 시 발생한다. 간격이 길수록 복구 시간이 늘고, 짧을수록 flush I/O 부담이 커진다.

## 코드

현재 WAL 위치와 checkpoint 횟수를 조회하는 Spring Boot 3.x `JdbcClient` 예제다.

```java
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class WalStatusRepository {

    private final JdbcClient jdbc;

    public WalStatusRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record WalStatus(String lsn, String walFile, long checkpoints) {}

    public WalStatus current() {
        return jdbc.sql("""
                SELECT pg_current_wal_lsn()::text AS lsn,
                       pg_walfile_name(pg_current_wal_lsn()) AS wal_file,
                       (SELECT num_timed + num_requested
                          FROM pg_stat_checkpointer) AS checkpoints
                """)
                .query((rs, i) -> new WalStatus(
                        rs.getString("lsn"),
                        rs.getString("wal_file"),
                        rs.getLong("checkpoints")))
                .single();
    }
}
```

테이블의 페이지 수와 Buffer Pool 적중 통계를 확인하는 예제다.

```java
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class StorageStatsRepository {

    private final JdbcClient jdbc;

    public StorageStatsRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record TableIo(String table, long pages, long heapRead, long heapHit) {}

    public TableIo of(String table) {
        return jdbc.sql("""
                SELECT c.relname, c.relpages, s.heap_blks_read, s.heap_blks_hit
                  FROM pg_class c
                  JOIN pg_statio_user_tables s ON s.relid = c.oid
                 WHERE c.relname = :table
                """)
                .param("table", table)
                .query((rs, i) -> new TableIo(
                        rs.getString("relname"),
                        rs.getLong("relpages"),
                        rs.getLong("heap_blks_read"),
                        rs.getLong("heap_blks_hit")))
                .single();
    }
}
```

소량 유실을 감수할 수 있는 로그성 트랜잭션에서만 WAL fsync 대기를 끄는 예제다. `SET LOCAL`은 트랜잭션 범위에서만 유효하다.

```java
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccessLogWriter {

    private final JdbcClient jdbc;

    public AccessLogWriter(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public void append(String path, int status) {
        jdbc.sql("SET LOCAL synchronous_commit = off").update();
        jdbc.sql("""
                INSERT INTO access_log (path, status, logged_at)
                VALUES (:path, :status, now())
                """)
                .param("path", path)
                .param("status", status)
                .update();
    }
}
```

## 실무에서 걸리는 지점

- **fsync 지연이 곧 커밋 지연이다.** 커밋 응답은 WAL fsync 완료 시점에 나가므로 WAL 디스크의 쓰기 지연이 트랜잭션 지연이 된다. `pg_wal`을 데이터 디렉터리와 다른 물리 디스크에 두면 페이지 flush와 WAL 쓰기가 I/O를 두고 경쟁하지 않는다.
- **synchronous_commit = off는 Durability를 포기하는 설정이다.** ==장애 시 커밋 직후 수백 밀리초 분량의 변경이 사라질 수 있다.== 정합성이 중요한 트랜잭션에는 적용하지 않고 `SET LOCAL`로 범위를 한정한다.
- **shared_buffers는 크다고 좋지 않다.** ==OS 페이지 캐시와 이중 캐싱되므로 RAM의 25%를 넘기면 이득이 줄고 checkpoint 시 flush 폭주가 심해진다.==
- **checkpoint 직후 WAL이 급증한다.** ==`full_page_writes`가 켜져 있으면 checkpoint 이후 처음 수정되는 페이지는 8KB 전체가 WAL에 기록된다.== 로그에 checkpoint가 너무 잦다는 경고가 보이면 `max_wal_size`를 올린다.
- **인덱스 스캔이 항상 빠르지는 않다.** 결과 행이 많으면 ctid를 따라 heap 페이지를 랜덤으로 읽는 비용이 순차 스캔을 넘어선다. Planner는 통계로 이를 판단하므로 대량 적재 뒤에는 `ANALYZE`로 통계를 갱신한다.

## 관련 글

- [MVCC·격리 수준·락](/notes/postgresql/mvcc-isolation-locking/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [백업과 복구 — pg_dump·PITR](/notes/postgresql/backup-restore-pitr/)
