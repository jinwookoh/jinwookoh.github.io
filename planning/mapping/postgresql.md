# postgresql 매핑 (23편)

D = data-infra/ 폴더, R = 루트(posts/study/ 바로 아래). 날짜 접두는 실제 파일명 그대로.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | storage-engine-wal | 내부 구조 — Storage Engine·페이지·WAL | DB 원리 | R/2026-05-03-db-eng-internals.md |
| 2 | acid-transactions-isolation | ACID·트랜잭션·격리 수준 | DB 원리 | R/2026-05-03-db-eng-acid.md, data-infra/2026-05-17-pg-transactions.md |
| 3 | partitioning-sharding | 파티셔닝과 샤딩 | DB 원리 | R/2026-05-03-db-eng-partitioning.md, R/2026-05-03-db-eng-sharding.md |
| 4 | replication-cap-saga | 복제·CAP·분산 트랜잭션 | DB 원리 | R/2026-05-03-db-eng-replication.md, R/2026-05-03-db-eng-advanced.md |
| 5 | what-is-postgresql | PostgreSQL이란 — MySQL과의 비교·아키텍처·관계형 모델 | 시작 | data-infra/2026-05-17-pg-intro.md, data-infra/2026-05-17-pg-architecture.md, data-infra/2026-05-17-pg-concepts.md |
| 6 | install-psql | 설치와 psql 접속 | 시작 | data-infra/2026-05-17-pg-install.md, data-infra/2026-05-17-pg-psql-start.md, data-infra/2026-05-17-pg-access-database.md |
| 7 | create-database-table | 데이터베이스와 테이블 만들기 | 시작 | data-infra/2026-05-17-pg-create-database.md, data-infra/2026-05-17-pg-create-table.md, data-infra/2026-05-17-pg-managing-databases.md |
| 8 | sql-basics-syntax | SQL 기초 — 어휘 구조와 문법 | SQL 기초 | data-infra/2026-05-17-pg-sql-basics.md, data-infra/2026-05-17-pg-sql-syntax-lexical.md, data-infra/2026-05-17-pg-sql-syntax.md |
| 9 | select-join | SELECT와 JOIN 표준 패턴 | SQL 기초 | data-infra/2026-05-17-pg-select.md, data-infra/2026-05-17-pg-join.md |
| 10 | insert-update-delete | INSERT·UPDATE·DELETE 표준 패턴 | SQL 기초 | data-infra/2026-05-17-pg-insert-data.md, data-infra/2026-05-17-pg-update.md, data-infra/2026-05-17-pg-delete.md |
| 11 | views-window-functions | 뷰·윈도우 함수·고급 SQL | SQL 기초 | data-infra/2026-05-17-pg-views.md, data-infra/2026-05-17-pg-window-advanced.md |
| 12 | ddl-tables-constraints | DDL 깊이 — CREATE TABLE·파티션·제약·외래 키 | DDL과 DML | data-infra/2026-05-17-pg-ddl-overview.md, data-infra/2026-05-17-pg-ddl-create-table.md, data-infra/2026-05-17-pg-ddl-constraints.md, data-infra/2026-05-17-pg-foreign-key.md |
| 13 | insert-bulk-copy-upsert | INSERT 깊이 — Bulk·COPY·UPSERT | DDL과 DML | data-infra/2026-05-17-pg-dml-overview.md, data-infra/2026-05-17-pg-dml-insert.md |
| 14 | update-delete-hot-bloat-vacuum | UPDATE·DELETE 깊이 — HOT·bloat·VACUUM | DDL과 DML | data-infra/2026-05-17-pg-dml-update.md, data-infra/2026-05-17-pg-dml-delete.md |
| 15 | query-structure | 쿼리 구조 — SELECT 절·FROM·WHERE·GROUP BY | DDL과 DML | data-infra/2026-05-17-pg-queries-overview.md, data-infra/2026-05-17-pg-queries-select-lists.md, data-infra/2026-05-17-pg-queries-table-expressions.md, data-infra/2026-05-17-pg-queries.md |
| 16 | data-types-jsonb | 데이터 타입과 JSONB | 타입·인덱스·성능 | data-infra/2026-05-17-pg-datatype.md, data-infra/2026-05-17-pg-datatype-json.md |
| 17 | index-types | 인덱스 — 원리와 종류 (B-Tree·Hash·GIN·GiST·BRIN) | 타입·인덱스·성능 | data-infra/2026-05-17-pg-indexes-intro.md, data-infra/2026-05-17-pg-indexes-types.md, R/2026-05-03-db-eng-indexing.md |
| 18 | index-operations-explain | 인덱스 운영과 EXPLAIN | 타입·인덱스·성능 | data-infra/2026-05-17-pg-indexes.md, data-infra/2026-05-17-pg-explain.md |
| 19 | performance-textsearch | 성능 팁과 전문 검색 | 타입·인덱스·성능 | data-infra/2026-05-17-pg-performance-tips.md, data-infra/2026-05-17-pg-textsearch.md |
| 20 | mvcc-isolation-locking | MVCC·격리 수준·락 | 동시성 | data-infra/2026-05-17-pg-mvcc-intro.md, data-infra/2026-05-17-pg-mvcc-isolation.md, R/2026-05-03-db-eng-concurrency.md |
| 21 | production-install-config | 운영 설치와 postgresql.conf | 운영 | data-infra/2026-05-17-pg-install-binaries.md, data-infra/2026-05-17-pg-runtime-config.md |
| 22 | roles-security | 사용자·역할·권한 | 운영 | data-infra/2026-05-17-pg-user-management.md |
| 23 | backup-restore-pitr | 백업과 복구 — pg_dump·PITR | 운영 | data-infra/2026-05-17-pg-backup.md |
