# redis 매핑 (18편)

D = data-infra/ 폴더, R = 루트(posts/study/ 바로 아래). 날짜 접두는 실제 파일명 그대로.
Spring Data Redis(D73, R redis-spring-data)는 java-spring 30편에서 이미 통합했으므로 여기서는 제외한다.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | what-is-redis | Redis란 — 역할 분담과 CLI 첫걸음 | 기초 | data-infra/2026-05-17-redis-intro.md, R/2026-05-02-redis-basics.md |
| 2 | data-types-overview | 데이터 타입 개관 | 데이터 타입 | data-infra/2026-05-17-redis-data-types-overview.md, R/2026-05-02-redis-data-structures.md |
| 3 | string-hash | String·Hash — 값 캐싱과 객체 저장 | 데이터 타입 | data-infra/2026-05-17-redis-strings.md, data-infra/2026-05-17-redis-hashes.md |
| 4 | list-set | List·Set — 큐와 집합 연산 | 데이터 타입 | data-infra/2026-05-17-redis-lists.md, data-infra/2026-05-17-redis-sets.md |
| 5 | sorted-set | Sorted Set — 랭킹과 Rate Limiter | 데이터 타입 | data-infra/2026-05-17-redis-sorted-sets.md |
| 6 | stream-pubsub | Stream·Pub/Sub — 영속 로그와 실시간 전파 | 데이터 타입 | data-infra/2026-05-17-redis-streams.md, data-infra/2026-05-17-redis-pubsub.md, R/2026-05-02-redis-pubsub-streams.md |
| 7 | ttl-eviction-keyspace | TTL·Eviction·Keyspace Notification | 명령과 스크립트 | data-infra/2026-05-17-redis-keyspace-expire.md, data-infra/2026-05-17-redis-keyspace-notifications.md, R/2026-05-02-redis-commands.md |
| 8 | pipelining-transactions | Pipelining·Transaction·WATCH | 명령과 스크립트 | data-infra/2026-05-17-redis-pipelining.md, data-infra/2026-05-17-redis-transactions.md, R/2026-05-02-redis-performance.md |
| 9 | lua-scripting-functions | Lua Scripting과 Functions | 명령과 스크립트 | data-infra/2026-05-17-redis-lua-scripting.md, data-infra/2026-05-17-redis-functions.md |
| 10 | caching-patterns-stampede | 캐싱 패턴 — Cache-Aside·스탬피드·Hot Key | 패턴 | R/2026-05-02-redis-caching-patterns.md, data-infra/2026-05-26-cache-stampede-hotkey.md, data-infra/2026-05-17-redis-patterns-overview.md |
| 11 | distributed-lock-redlock | 분산 락 — SET NX와 Redlock | 패턴 | data-infra/2026-05-17-redis-distributed-lock.md |
| 12 | secondary-index-fanout-id | Secondary Index·Fanout·분산 ID | 패턴 | data-infra/2026-05-17-redis-pattern-indexes.md, data-infra/2026-05-17-redis-pattern-twitter-clone.md, data-infra/2026-05-26-distributed-unique-id.md |
| 13 | persistence-rdb-aof | Persistence — RDB·AOF·Hybrid | 운영 | data-infra/2026-05-17-redis-persistence.md, R/2026-05-02-redis-persistence.md |
| 14 | replication-sentinel | Replication과 Sentinel | 운영 | data-infra/2026-05-17-redis-replication.md, data-infra/2026-05-17-redis-sentinel.md, R/2026-05-02-redis-cluster-ha.md |
| 15 | cluster-consistent-hashing | Cluster와 일관된 해싱 | 운영 | data-infra/2026-05-17-redis-cluster-scaling.md, data-infra/2026-05-26-redis-consistent-hashing.md |
| 16 | security-acl-tls | 보안 — ACL·TLS | 운영 | data-infra/2026-05-17-redis-acl-security.md, data-infra/2026-05-17-redis-tls-encryption.md |
| 17 | memory-clients | 메모리 최적화와 클라이언트 (Jedis·Lettuce) | 운영 | data-infra/2026-05-17-redis-memory-optimization.md, data-infra/2026-05-17-redis-clients-overview.md, data-infra/2026-05-17-redis-clients-java.md |
| 18 | modules-json-search-ts-vector | 확장 모듈 — JSON·Search·TimeSeries·Vector | 확장 모듈 | data-infra/2026-05-17-redis-json.md, data-infra/2026-05-17-redis-search-query.md, data-infra/2026-05-17-redis-timeseries.md, data-infra/2026-05-17-redis-vector-database.md |
