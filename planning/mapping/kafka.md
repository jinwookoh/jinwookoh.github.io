# kafka 매핑 (28편)

D = data-infra/ 폴더, R = 루트(posts/study/ 바로 아래). 날짜 접두는 실제 파일명 그대로.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | what-is-kafka | Kafka란 — 이벤트 스트리밍과 활용 영역 | 기초 | data-infra/2026-05-17-kafka-intro.md, data-infra/2026-05-17-kafka-use-cases.md, R/2026-05-02-kafka-basics.md, R/2026-05-03-kafka-fundamentals.md |
| 2 | quickstart-cli | Quickstart — 설치·CLI·첫 메시지 | 기초 | data-infra/2026-05-17-kafka-quickstart.md, R/2026-05-02-kafka-administration.md |
| 3 | topic-partition-offset-segment | Topic·Partition·Offset·Segment | 기초 | R/2026-05-02-kafka-architecture.md, R/2026-05-03-kafka-topic-partition.md, data-infra/2026-05-17-kafka-implementation-log.md |
| 4 | design-philosophy | 설계 철학 — 왜 디스크·배치·Zero-Copy인가 | 설계와 내부 | data-infra/2026-05-17-kafka-design-motivation.md, data-infra/2026-05-17-kafka-design-persistence.md, data-infra/2026-05-17-kafka-design-efficiency.md |
| 5 | producer-internals | Producer 동작 원리 — 파티션 선택·ACK·멱등성 | 설계와 내부 | data-infra/2026-05-17-kafka-design-producer.md, R/2026-05-02-kafka-producers.md, R/2026-05-03-kafka-producer-consumer.md |
| 6 | consumer-internals-rebalance | Consumer 동작 원리 — Pull·Group·Offset·Rebalance | 설계와 내부 | data-infra/2026-05-17-kafka-design-consumer.md, R/2026-05-02-kafka-consumers.md, R/2026-05-03-kafka-consumer-group.md, data-infra/2026-05-17-kafka-consumer-rebalance-protocol.md |
| 7 | delivery-semantics-transactions | 전달 보증 — at-most·at-least·exactly-once와 트랜잭션 | 설계와 내부 | data-infra/2026-05-17-kafka-message-delivery-semantics.md, data-infra/2026-05-17-kafka-transaction-protocol.md |
| 8 | replication-isr | Replication — ISR·리더 선출·Unclean | 설계와 내부 | data-infra/2026-05-17-kafka-replication.md, R/2026-05-02-kafka-internals.md |
| 9 | network-layer-message-format | 내부 구현 — Network Layer·Message Format | 설계와 내부 | data-infra/2026-05-17-kafka-implementation-network-layer.md, data-infra/2026-05-17-kafka-implementation-message-format.md |
| 10 | log-compaction-tiered-storage | Log Compaction·Tiered Storage | 설계와 내부 | data-infra/2026-05-17-kafka-log-compaction.md, data-infra/2026-05-17-kafka-tiered-storage.md |
| 11 | producer-api-config | Producer API와 설정 | 클라이언트 | data-infra/2026-05-17-kafka-producer-api.md, data-infra/2026-05-17-kafka-producer-config.md |
| 12 | consumer-api-config | Consumer API와 설정 | 클라이언트 | data-infra/2026-05-17-kafka-consumer-api.md, data-infra/2026-05-17-kafka-consumer-config.md |
| 13 | admin-client | Admin Client — API 5종 개관과 관리 작업 | 클라이언트 | data-infra/2026-05-17-kafka-apis-overview.md, data-infra/2026-05-17-kafka-admin-client-api.md, data-infra/2026-05-17-kafka-admin-config.md |
| 14 | broker-topic-config | Broker·Topic 설정 | 운영 | data-infra/2026-05-17-kafka-broker-config.md, data-infra/2026-05-17-kafka-topic-config.md |
| 15 | operations-kraft | 운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft | 운영 | data-infra/2026-05-17-kafka-operations-basic.md, data-infra/2026-05-17-kafka-kraft.md, R/2026-05-03-kafka-cluster.md |
| 16 | monitoring-performance | Monitoring·Hardware·성능 튜닝 | 운영 | data-infra/2026-05-17-kafka-monitoring-jmx.md, data-infra/2026-05-17-kafka-hardware-and-os.md, data-infra/2026-05-26-kafka-performance-tuning.md |
| 17 | troubleshooting | 장애 대응 | 운영 | data-infra/2026-05-26-kafka-troubleshooting.md |
| 18 | multi-datacenter-mirrormaker | 다중 데이터센터·Geo-Replication (MirrorMaker 2) | 운영 | data-infra/2026-05-17-kafka-operations-datacenters.md, data-infra/2026-05-17-kafka-operations-geo-replication.md |
| 19 | security-tls-sasl | 인증 — TLS·SASL | 보안 | data-infra/2026-05-17-kafka-security-overview.md, data-infra/2026-05-17-kafka-security-ssl.md, data-infra/2026-05-17-kafka-security-sasl.md |
| 20 | security-acl-multitenancy | 인가 — ACL과 Multi-tenancy | 보안 | data-infra/2026-05-17-kafka-security-authorization-acl.md, data-infra/2026-05-17-kafka-multi-tenancy.md |
| 21 | connect-architecture-operations | Connect — 아키텍처·Distributed Mode·운영 | Connect | data-infra/2026-05-17-kafka-connect-overview.md, data-infra/2026-05-17-kafka-connect-user-guide.md, R/2026-05-02-kafka-connect-basics.md, R/2026-05-02-kafka-connect-configuration.md, R/2026-05-02-kafka-connect-advanced.md |
| 22 | connect-connectors-smt-custom | Connect — Connector·SMT·커스텀 개발 | Connect | data-infra/2026-05-17-kafka-connect-developer-guide.md, data-infra/2026-05-17-kafka-connect-config.md, R/2026-05-02-kafka-connect-connectors.md, R/2026-05-02-kafka-connect-transformations.md, R/2026-05-02-kafka-advanced.md |
| 23 | streams-intro-concepts | Streams — 입문과 핵심 개념 | Streams | data-infra/2026-05-17-kafka-streams-intro.md, data-infra/2026-05-17-kafka-streams-quickstart.md, data-infra/2026-05-17-kafka-streams-core-concepts.md |
| 24 | streams-dsl-processor-state | Streams — DSL·Processor API·상태 저장 | Streams | data-infra/2026-05-17-kafka-streams-dsl.md, data-infra/2026-05-17-kafka-streams-processor-api.md, data-infra/2026-05-17-kafka-streams-stateful-iq.md |
| 25 | streams-testing-operations | Streams — 테스트와 운영 | Streams | data-infra/2026-05-17-kafka-streams-write-run-app.md, data-infra/2026-05-17-kafka-streams-testing.md, data-infra/2026-05-17-kafka-streams-ops.md |
| 26 | spring-kafka | Spring Kafka — 배치·에러·트랜잭션·테스트 | Spring과 패턴 | data-infra/2026-05-17-kafka-spring-kafka.md, R/2026-05-03-kafka-spring.md, R/2026-05-03-kafka-batch-error-tx.md |
| 27 | spring-cloud-stream-reactor | Spring Cloud Stream·StreamBridge·Reactor Kafka | Spring과 패턴 | R/2026-05-03-kafka-scs-basics.md, R/2026-05-03-kafka-scs-tips.md, R/2026-05-03-kafka-streambridge.md, R/2026-05-03-kafka-reactor.md |
| 28 | event-patterns-outbox-saga | 이벤트 패턴 — Outbox·Saga·Fan-out | Spring과 패턴 | R/2026-05-03-kafka-outbox.md, R/2026-05-03-kafka-saga-choreography.md, R/2026-05-03-kafka-saga-orchestrator.md, R/2026-05-03-kafka-fan-out-in.md, R/2026-05-04-javaex-sns-kafka-outbox.md |
