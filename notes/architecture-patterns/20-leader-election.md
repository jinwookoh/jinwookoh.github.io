---
title: "리더 선출 — 인스턴스 하나만 작업하게 만들기"
series: architecture-patterns
part: "복원력"
order: 20
summary: "여러 인스턴스 중 하나만 작업하게 하는 락 기반·합의 기반 선출을 비교하고 분할 뇌를 막는 방법을 정리한다"
tags: [Leader Election, ShedLock, Redisson, Kubernetes Lease, Raft]
sources: [https://jinwookoh.tistory.com/246]
updated: 2026-09-06
---

새벽 1시에 정산 배치가 돌아야 하고 애플리케이션 서버는 다섯 대가 떠 있다. `@Scheduled`는 인스턴스마다 독립적으로 동작하므로 아무 조치가 없으면 다섯 대가 동시에 정산을 시작한다. 같은 주문에 정산 레코드가 다섯 번 생기거나 외부 결제 API가 다섯 번 호출된다. 스케줄 배치뿐 아니라 파티션 할당 관리, 캐시 워밍, 마이그레이션 실행처럼 한 시점에 정확히 하나의 인스턴스만 수행해야 하는 작업은 어디에나 있다. 리더 선출은 여러 인스턴스 가운데 하나를 골라 그 인스턴스만 작업하게 만들고, 그 인스턴스가 죽으면 다른 인스턴스가 역할을 이어받도록 하는 패턴이다.

## 핵심 개념

리더 선출의 본질은 누가 리더인지를 모든 인스턴스가 동일하게 판단할 수 있는 단일 진실 원천을 두는 것이다. 그 원천을 어디에 두느냐에 따라 두 계열로 나뉜다.

**락 기반 선출.** Redis나 RDBMS 같은 외부 저장소에 리더 키를 두고, 먼저 키를 만든 인스턴스가 리더가 된다. Redis라면 `SET key value NX PX ttl`, RDBMS라면 유니크 제약이 걸린 행 INSERT 또는 `SELECT ... FOR UPDATE`다. 리더가 죽었을 때 키가 영원히 남지 않도록 TTL을 걸고, 리더는 TTL이 만료되기 전에 주기적으로 갱신한다. 갱신이 끊기면 키가 사라지고 다음 인스턴스가 키를 잡는다.

**합의 기반 선출.** ZooKeeper, etcd, Consul 같은 코디네이터가 Raft나 ZAB 합의 알고리즘으로 상태를 복제한다. 인스턴스는 코디네이터와 세션을 맺고 임시 노드(ephemeral node)나 lease를 만든다. 세션이 끊기면 노드가 자동으로 제거되고, 이를 감시(watch)하던 인스턴스들이 즉시 재선출에 들어간다. Kubernetes의 `coordination.k8s.io/Lease` 객체도 etcd 위에서 동작하는 같은 원리다.

두 계열의 차이는 리더가 죽었음을 어떻게 아는가와 동시에 두 리더가 생길 수 있는가에 있다.

| 구분 | 락 기반 (Redis/RDBMS) | 합의 기반 (etcd/ZooKeeper) |
|---|---|---|
| 리더 판정 | 키 생성 성공 여부 | 세션 유지 + 노드 순서 |
| 장애 감지 | TTL 만료 후 | 세션 타임아웃 내 즉시 |
| 리더 중복 | TTL·GC 멈춤 조합으로 발생 가능 | 알고리즘이 단일 리더 보장 |
| 추가 인프라 | 기존 저장소 활용 | 코디네이터 클러스터 필요 |

어느 방식이든 ==리더 선출만으로는 작업의 단일 실행이 보장되지 않는다.== 락 기반에서 리더가 GC로 30초 멈춘 사이 TTL이 만료되고 다른 인스턴스가 리더가 되면, 깨어난 옛 리더는 자신이 여전히 리더라고 믿고 작업을 계속한다. 이 상태가 분할 뇌(split-brain)다. 막으려면 선출 시 단조 증가하는 세대 번호(fencing token)를 발급하고, 작업 대상 저장소가 오래된 토큰을 가진 쓰기를 거부하도록 만든다.

## 코드

ShedLock은 스케줄 메서드 단위로 락을 걸어 여러 인스턴스 중 하나만 실행하게 한다. `lockAtLeastFor`는 시계 오차로 인한 재실행을 막고, `lockAtMostFor`는 리더가 죽었을 때 락이 풀리는 상한이다.

```java
@Configuration
@EnableScheduling
@EnableSchedulerLock(defaultLockAtMostFor = "10m")
public class SchedulerLockConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(
            JdbcTemplateLockProvider.Configuration.builder()
                .withJdbcTemplate(new JdbcTemplate(dataSource))
                .usingDbTime()
                .build());
    }
}

@Component
@RequiredArgsConstructor
public class SettlementJob {

    private final SettlementService settlementService;

    @Scheduled(cron = "0 0 1 * * *")
    @SchedulerLock(name = "dailySettlement",
                   lockAtLeastFor = "5m", lockAtMostFor = "30m")
    public void run() {
        LockAssert.assertLocked();
        settlementService.settle(LocalDate.now().minusDays(1));
    }
}
```

작업이 얼마나 걸릴지 모를 때는 Redisson의 watchdog을 쓴다. `leaseTime`을 지정하지 않으면 락을 잡은 스레드가 살아 있는 동안 30초 TTL을 10초마다 자동 연장한다.

```java
@Component
@RequiredArgsConstructor
public class SettlementJob {

    private final RedissonClient redisson;
    private final SettlementService settlementService;

    @Scheduled(cron = "0 0 1 * * *")
    public void run() throws InterruptedException {
        RLock lock = redisson.getLock("lock:settlement-leader");
        if (!lock.tryLock(0, TimeUnit.SECONDS)) {   // leaseTime 미지정 → watchdog 연장
            return;
        }
        try {
            settlementService.settle(LocalDate.now().minusDays(1));
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}
```

배치가 아니라 상시 실행 워커라면 Spring Integration의 `LeaderInitiator`로 리더 여부를 이벤트로 받는다. Kubernetes 환경에서는 Spring Cloud Kubernetes의 leader 모듈이 같은 이벤트를 발행한다.

```java
@Component
public class PartitionWorker {

    private volatile boolean leader;

    @EventListener
    public void onGranted(OnGrantedEvent event) {
        leader = true;
        startConsuming();
    }

    @EventListener
    public void onRevoked(OnRevokedEvent event) {
        leader = false;
        stopConsuming();   // 리더를 잃으면 실행 중인 작업도 멈춘다
    }
}
```

## 실무에서 걸리는 지점

- **TTL을 작업 시간보다 짧게 잡는 실수.** 락 TTL이 10초인데 작업이 3분 걸리면 10초 뒤 다른 인스턴스가 같은 작업을 시작한다. ==고정 TTL은 작업의 최대 소요 시간보다 길게 잡고, 예측이 안 되면 watchdog으로 연장한다.==

- **`OnRevokedEvent` 무시.** 이벤트 기반 선출에서 리더 박탈 이벤트를 받고도 작업을 멈추지 않으면 새 리더와 함께 두 개가 돈다. 박탈 처리기는 플래그만 바꾸는 데 그치지 않고 실행 중인 작업을 실제로 중단해야 한다.

- **Redis 단일 노드 의존.** 락 저장소로 쓰는 Redis가 죽으면 리더 선출 자체가 멈춘다. 마스터-레플리카 구성에서는 마스터 장애 시 복제되지 않은 락이 유실되어 두 리더가 생길 수 있다. ==Redlock도 GC 멈춤과 시계 드리프트 앞에서는 단일 리더를 보장하지 못하므로 중복 실행이 치명적인 작업에는 합의 기반 코디네이터를 쓴다.==

- **리더 고착.** 리더 프로세스는 살아 있지만 특정 작업만 반복 실패하는 경우 리더가 바뀌지 않는다. 헬스 체크에 작업 성공 여부를 포함하거나, N회 연속 실패 시 스스로 리더를 반납하도록 만든다.

- **DB 락 테이블과 시계.** ShedLock의 JDBC 프로바이더는 `shedlock` 테이블에 행을 남기므로 테이블 생성이 배포 절차에 빠지면 첫 실행에서 예외가 난다. `usingDbTime()` 없이 애플리케이션 시계를 쓰면 인스턴스 간 시계 차이만큼 락 구간이 겹친다.

## 관련 글

- [헬스 체크 — Liveness와 Readiness](/notes/architecture-patterns/health-check/)
- [동시성 제어 — 비관적 락과 낙관적 락](/notes/architecture-patterns/optimistic-pessimistic-lock/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
