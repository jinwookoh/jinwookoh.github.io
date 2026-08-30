---
title: "복제·CAP·분산 트랜잭션"
series: postgresql
part: "DB 원리"
order: 4
summary: "복제 모드와 CAP·PACELC 트레이드오프를 기준으로 읽기 라우팅·Failover·Saga 보상 설계를 정리한다"
tags: [Replication, CAP, PACELC, Saga, Failover]
sources: [2026-05-03-db-eng-replication.md, 2026-05-03-db-eng-advanced.md]
updated: 2026-08-29
---

단일 노드 PostgreSQL은 그 노드가 곧 SPOF다. 디스크가 죽으면 서비스가 멈추고, 읽기 트래픽이 늘어도 수직 확장 외에 선택지가 없다. 복제는 이 두 문제를 동시에 푼다. 그러나 노드가 둘 이상이 되는 순간 네트워크 단절, 복제 지연, 두 노드가 동시에 primary라고 믿는 상황이 생기고, 여러 서비스에 걸친 업무를 원자적으로 묶던 트랜잭션 경계도 사라진다.

## 핵심 개념

### 복제 토폴로지

Primary-Replica 구성은 한 노드가 모든 쓰기를 받고, WAL을 스트리밍해 여러 replica가 읽기를 나눠 맡는다. 충돌이 없어 단순하지만 primary가 SPOF다. Multi-Primary는 여러 노드가 동시에 쓰기를 받으므로 충돌 해결 전략(Last-Write-Wins, 사용자 정의 규칙, CRDT)이 필수이며, PostgreSQL은 BDR 같은 확장 없이는 지원하지 않는다.

Physical(Streaming) 복제는 WAL을 그대로 전달하므로 replica가 primary와 같은 바이트 상태를 유지하고 메이저 버전이 같아야 한다. Logical 복제는 변경을 행 단위로 디코딩해 전달하므로 테이블 선택 복제나 버전 간 마이그레이션에 쓴다.

### 동기·비동기와 일관성

| 모드 | 커밋 응답 시점 | 특징 |
|:---|:---|:---|
| Asynchronous | primary WAL 기록 즉시 | 빠름, primary 장애 시 미전송 트랜잭션 유실 |
| Synchronous | 지정 standby가 WAL 수신·flush 후 | 유실 없음, standby 지연이 커밋 지연으로 전파 |
| Quorum(`ANY n`) | n대가 응답하면 | 유실 방지와 지연의 절충 |

비동기 복제에서는 Replication Lag이 필연적으로 생기고, 방금 쓴 사용자가 replica에서 자기 쓰기를 못 보는 문제가 발생한다. 대응은 read-your-own-writes다. 쓰기 직후의 읽기는 primary로, 검색·통계처럼 stale이 허용되는 조회만 replica로 보낸다. 일관성 요구를 Strong, Read-Your-Writes, Eventual로 나눠 쿼리마다 라우팅을 결정한다.

### Failover와 Split-Brain

primary 장애 시 replica를 승격하는 것이 Failover다. 수동 승격은 다운타임이 분에서 시간 단위로 늘어나므로 Patroni처럼 etcd·Consul 합의로 새 primary를 정하는 자동화를 쓴다. 핵심은 정족수(Quorum)와 Fencing이다. ==과반 합의 없이 승격하면 옛 primary와 새 primary가 동시에 쓰기를 받는 Split-Brain이 발생하고, 수동 병합 외에 복구 방법이 없다.==

### CAP과 PACELC

네트워크 분할(P)은 피할 수 없으므로 실제 선택은 분할 중에 일관성(C)과 가용성(A) 중 무엇을 지킬지다. 동기 복제 + 과반 승격은 CP에, 비동기 복제 + 즉시 응답은 AP에 가깝다. CAP은 장애 시점만 설명하므로 정상 시 지연(L)과 일관성(C)의 선택까지 포함한 PACELC가 실무 판단에 더 유용하다. 동기 복제가 정상 시에도 매 커밋에 왕복 지연을 더하는 것이 EC 선택의 비용이다.

### 분산 트랜잭션

2PC는 코디네이터가 참여자 전원에게 PREPARE를 보내고 전원 동의 시 COMMIT한다. 코디네이터가 PREPARE 이후 죽으면 참여자는 락을 쥔 채 무한 대기하는 블로킹 프로토콜이라 서비스 간 트랜잭션에는 거의 쓰지 않는다. Saga는 업무를 로컬 트랜잭션의 연쇄로 나누고 각 단계에 보상 트랜잭션을 정의한다. Orchestration은 중앙 코디네이터가 순서를 제어하고, Choreography는 각 서비스가 이벤트를 구독해 진행한다. Saga는 BASE만 보장하므로 중간 상태가 노출되며, 보상이 정의 가능한 업무에만 적용한다.

## 코드

Spring에서 `@Transactional(readOnly = true)`인 경우 replica로, 나머지는 primary로 보내는 라우팅 DataSource다. 트랜잭션 동기화 시점의 readOnly 플래그를 키로 쓴다.

```java
public class ReplicaRoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        boolean readOnly = TransactionSynchronizationManager.isCurrentTransactionReadOnly();
        return readOnly ? "replica" : "primary";
    }
}

@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(
            @Qualifier("primaryDataSource") DataSource primary,
            @Qualifier("replicaDataSource") DataSource replica) {
        var routing = new ReplicaRoutingDataSource();
        routing.setTargetDataSources(Map.of("primary", primary, "replica", replica));
        routing.setDefaultTargetDataSource(primary);
        // LazyConnectionDataSourceProxy가 없으면 readOnly 결정 전에 커넥션을 잡아 항상 primary로 간다
        return new LazyConnectionDataSourceProxy(routing);
    }
}
```

primary에서 복제 상태와 각 standby의 지연 바이트를 확인하는 쿼리다. 알람 임계값은 초 단위 lag과 바이트 단위 lag을 함께 본다.

```sql
SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       replay_lag
FROM pg_stat_replication;

-- standby에서 실행: 마지막 재생 트랜잭션 기준 지연
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```

주문·결제·재고를 Orchestration Saga로 묶은 예다. 각 단계는 별도 서비스의 로컬 트랜잭션이며, 실패 시 완료된 단계의 보상을 역순으로 실행한다.

```java
@Service
public class OrderSagaOrchestrator {

    private final OrderClient orders;
    private final PaymentClient payments;
    private final InventoryClient inventory;

    public OrderSagaOrchestrator(OrderClient orders, PaymentClient payments, InventoryClient inventory) {
        this.orders = orders;
        this.payments = payments;
        this.inventory = inventory;
    }

    public void place(PlaceOrderCommand cmd) {
        Deque<Runnable> compensations = new ArrayDeque<>();
        try {
            UUID orderId = orders.create(cmd);
            compensations.push(() -> orders.cancel(orderId));

            UUID paymentId = payments.charge(orderId, cmd.amount());
            compensations.push(() -> payments.refund(paymentId));

            inventory.reserve(orderId, cmd.items());
            compensations.push(() -> inventory.release(orderId));

            orders.confirm(orderId);
        } catch (RuntimeException e) {
            while (!compensations.isEmpty()) {
                compensations.pop().run();   // 보상은 멱등해야 재시도가 안전하다
            }
            throw new SagaFailedException(e);
        }
    }
}
```

## 실무에서 걸리는 지점

- **복제는 백업이 아니다.** ==primary에서 잘못 실행한 DELETE는 밀리초 안에 모든 replica에 반영된다.== 복구는 WAL 아카이브 기반 PITR이나 pg_dump 같은 별도 백업으로만 가능하다.
- ==**`synchronous_standby_names`를 켠 상태에서 standby가 전부 내려가면 커밋이 멈춘다.**== `ANY 1 (s1, s2)` 정족수로 낮추거나 장애 시 설정을 풀 운영 절차를 준비해야 한다.
- **long transaction과 replica 충돌.** ==standby의 긴 조회는 primary VACUUM이 만든 WAL과 충돌해 취소되거나(`hot_standby_feedback` off), primary의 dead tuple 정리를 막는다(on).== 분석 쿼리는 전용 replica로 분리한다.
- **Cascade 복제는 lag이 누적된다.** replica의 replica는 primary lag과 중간 노드 lag을 합산한 지연을 가지므로 Eventual 조회 전용으로 격리한다.
- **Saga의 보상은 항상 성공한다는 가정이 틀리다.** 환불 API가 실패하거나 두 번 호출될 수 있으므로 보상은 멱등하게 만들고, 실패한 보상은 outbox 테이블에 기록해 재처리한다. 보상 불가능한 단계는 Saga의 마지막에 둔다.

## 관련 글

- [파티셔닝과 샤딩](/notes/postgresql/partitioning-sharding/)
- [MVCC·격리 수준·락](/notes/postgresql/mvcc-isolation-locking/)
- [백업과 복구 — pg_dump·PITR](/notes/postgresql/backup-restore-pitr/)
