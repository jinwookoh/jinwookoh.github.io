---
title: "헬스 체크 — Liveness와 Readiness"
series: architecture-patterns
part: "복원력"
order: 19
summary: "재시작 판단과 트래픽 차단 판단은 답이 다르므로 헬스 체크를 두 개로 분리해야 한다"
tags: [Health Check, Liveness, Readiness, Kubernetes, Spring Boot Actuator]
sources: [https://jinwookoh.tistory.com/240]
updated: 2026-09-06
---

프로세스는 떠 있는데 DB 커넥션 풀이 고갈되어 모든 요청에 500을 돌려주는 인스턴스가 있다고 하자. 로드 밸런서가 TCP 포트가 열려 있는지만 확인한다면 이 인스턴스는 계속 정상으로 분류되어 트래픽을 받는다. 반대로 배포 직후 캐시를 채우는 중인 인스턴스에 트래픽이 들어오면 타임아웃이 난다. 헬스 체크는 오케스트레이터와 로드 밸런서가 "이 인스턴스를 다시 시작해야 하는가"와 "이 인스턴스에 요청을 보내도 되는가"를 판단하는 근거다. 이 두 질문은 답이 다르다. 하나의 `/health` 엔드포인트로 둘을 동시에 답하려 하면 어느 한쪽이 반드시 잘못 동작한다.

## 핵심 개념

Liveness 검사는 프로세스가 응답 가능한 상태인지만 본다. 실패하면 컨테이너를 재시작한다. 검사 대상은 애플리케이션 자체이며, 데드락이나 메모리 누수로 멈춘 프로세스를 감지하는 것이 목적이다. DB나 캐시 같은 외부 의존성은 검사하지 않는다. 의존성이 죽었다고 프로세스를 재시작해 봐야 해결되는 것이 없기 때문이다.

Readiness 검사는 지금 요청을 처리할 수 있는지 본다. 실패하면 재시작하지 않고 서비스 엔드포인트 목록에서 제외해 트래픽만 끊는다. 부팅 중 워밍업이 끝나지 않았거나, 필수 의존성 연결이 끊긴 인스턴스가 에러 응답을 내보내는 것을 막는 것이 목적이다. 의존성이 복구되면 다시 통과하고 트래픽이 재투입된다.

| 구분 | Liveness | Readiness |
|---|---|---|
| 질문 | 프로세스가 살아 있는가 | 요청을 처리할 수 있는가 |
| 실패 시 | 컨테이너 재시작 | 트래픽 차단, 재시작 없음 |
| 검사 범위 | 애플리케이션 자체 | 워밍업 상태, 필수 의존성 |
| 비용 | 즉시 응답 | 의존성 확인만큼 무거움 |

Kubernetes는 여기에 Startup 검사를 더한다. 부팅이 느린 애플리케이션에서 Liveness가 부팅 완료 전에 실패해 재시작 루프에 빠지는 것을 막기 위해, Startup 검사가 통과할 때까지 나머지 두 검사를 유예한다.

Spring Boot Actuator는 이 구분을 `ApplicationAvailability`로 모델링한다. `LivenessState`는 `CORRECT`와 `BROKEN`, `ReadinessState`는 `ACCEPTING_TRAFFIC`과 `REFUSING_TRAFFIC` 두 값을 가진다. Kubernetes 환경으로 감지되면 `/actuator/health/liveness`와 `/actuator/health/readiness`가 자동으로 열리고, 그 외 환경에서는 `management.endpoint.health.probes.enabled=true`로 켠다. 상태가 `DOWN`이나 `OUT_OF_SERVICE`면 HTTP 503, `UP`이면 200을 돌려준다. ==readiness 그룹에는 기본적으로 `readinessState` 인디케이터만 들어 있고 DB 인디케이터는 자동으로 포함되지 않는다.== DB가 끊겨도 `/actuator/health`는 503인데 `/actuator/health/readiness`는 200인 상황이 생기므로, 검사에 넣을 의존성은 그룹 설정에 명시해야 한다.

## 코드

Readiness 그룹에 DB 인디케이터를 추가하고, 관리 엔드포인트를 별도 포트로 분리하는 설정이다.

```yaml
management:
  server:
    port: 9090
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
      group:
        readiness:
          include: readinessState, db
        liveness:
          include: livenessState
  endpoints:
    web:
      exposure:
        include: health
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

인스턴스별로 독립된 의존성을 검사하는 커스텀 인디케이터다. 검사 자체가 요청 스레드를 잡아먹지 않도록 타임아웃을 둔다.

```java
@Component("localCache")
public class LocalCacheHealthIndicator implements HealthIndicator {

    private final CacheWarmer warmer;

    public LocalCacheHealthIndicator(CacheWarmer warmer) {
        this.warmer = warmer;
    }

    @Override
    public Health health() {
        try {
            boolean loaded = warmer.awaitLoaded(Duration.ofMillis(500));
            return loaded
                    ? Health.up().withDetail("entries", warmer.size()).build()
                    : Health.outOfService().withDetail("reason", "warming").build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
```

워밍업이 끝나기 전까지 트래픽을 받지 않도록 Readiness 상태를 코드에서 직접 바꾸는 예다. `ApplicationReadyEvent` 시점에 Spring Boot가 `ACCEPTING_TRAFFIC`으로 올리므로, 그보다 먼저 `REFUSING_TRAFFIC`을 게시하고 작업이 끝난 뒤 되돌린다.

```java
@Component
public class CacheWarmer {

    private final ApplicationEventPublisher publisher;
    private final ProductRepository repository;

    public CacheWarmer(ApplicationEventPublisher publisher, ProductRepository repository) {
        this.publisher = publisher;
        this.repository = repository;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void warmUp() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
        try {
            repository.preloadHotItems();
        } finally {
            AvailabilityChangeEvent.publish(publisher, this, ReadinessState.ACCEPTING_TRAFFIC);
        }
    }
}
```

## 실무에서 걸리는 지점

- ==Liveness에 DB 검사를 넣으면 DB가 느려지는 순간 모든 인스턴스가 동시에 재시작된다.== 재시작된 인스턴스가 커넥션 풀을 새로 만들며 DB 부하를 더 키우고, 다시 Liveness가 실패하는 루프가 돈다. 원인이 DB인 장애를 재시작으로 고칠 수는 없다.
- Readiness에 넣는 의존성은 인스턴스마다 독립적으로 복구되는 것으로 한정한다. ==모든 인스턴스가 공유하는 외부 API를 Readiness에 넣으면 그 API 장애 시 전 인스턴스가 한꺼번에 트래픽에서 빠져 서비스 전체가 멈춘다.== 그 API 없이도 부분 응답이 가능하다면 서킷 브레이커로 격리하고 Readiness에서는 뺀다.
- 검사 자체가 부하가 된다. `periodSeconds` 10초에 파드 30개면 DB 검증 쿼리가 초당 3회 추가되고, 커넥션 풀이 고갈된 상황에서는 헬스 체크가 커넥션을 기다리다 `timeoutSeconds`를 넘겨 실패한다. 관리 포트를 분리하면 별도 서버 스레드로 처리되어 요청 스레드 풀이 막혀도 Liveness는 응답한다.
- 종료 순서를 맞춰야 무중단이 된다. ==SIGTERM으로 `REFUSING_TRAFFIC`이 되어도 로드 밸런서 엔드포인트에서 빠지기까지 수 초의 지연이 있고, 그 사이 도착한 요청은 실패한다.== `preStop`에 짧은 sleep을 두고, `terminationGracePeriodSeconds`를 `timeout-per-shutdown-phase`보다 길게 잡는다.
- 헬스 엔드포인트는 인디케이터 이름과 상세 정보로 내부 구성을 드러낸다. `show-details`는 `never`를 유지하고, 관리 포트는 클러스터 내부 네트워크에서만 접근 가능하게 막는다.

## 관련 글

- [서비스 디스커버리 — 클라이언트 사이드와 서버 사이드](/notes/architecture-patterns/service-discovery/)
- [서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태](/notes/architecture-patterns/circuit-breaker/)
- [벌크헤드 — 스레드 풀·세마포어로 자원 격리](/notes/architecture-patterns/bulkhead/)
