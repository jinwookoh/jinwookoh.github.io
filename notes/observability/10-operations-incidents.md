---
title: "운영 함정과 사고 케이스·Elasticsearch 모니터링"
series: observability
part: "운영"
order: 10
summary: "카디널리티·Gauge 누수·percentile 합산·alert 폭주·drift 등 관측 스택의 반복 사고와 Elasticsearch 감시 지표를 정리한다"
tags: [Micrometer, Grafana, Elasticsearch, Cardinality, Incident]
sources: [micrometer/2026-05-25-micrometer-operations-incidents.md, grafana/2026-05-18-grafana-operations-incidents.md, elasticsearch/2026-05-19-elasticsearch-monitoring.md, micrometer/2026-05-25-micrometer-series-conclusion.md, grafana/2026-05-18-grafana-series-conclusion.md]
updated: 2026-08-30
---

관측 스택은 트래픽과 팀이 커진 뒤에 무너진다. 동적 값을 태그로 넣은 메트릭 하나가 Prometheus를 OOM으로 떨어뜨리고, 인스턴스별 p99를 평균 낸 대시보드는 SLO 위반을 초록불로 표시하며, 리전 장애 한 번에 알림 1,000건이 동시에 발화한다. Micrometer 계측 계층, Grafana·Prometheus 운영 계층, Elasticsearch 클러스터에서 반복되는 사고를 원인과 예방 패턴 중심으로 정리한다.

## 핵심 개념

**카디널리티**는 label 조합으로 생성되는 고유 시계열 수다. `method(5) × status(30) × region(3) × service(20)`만으로 9,000개이고 raw path가 곱해지면 상한이 없다. `userId`·`requestId` 같은 값은 로그나 trace attribute로 보내고, URI는 `/products/{id}` 같은 route 패턴으로 정규화한다. `MeterFilter.maximumAllowableTags`, Prometheus relabel drop, `prometheus_tsdb_head_series` 감시가 세 겹의 방어선이다.

**Gauge**는 관찰 대상을 `WeakReference`로 잡는다. `Gauge.builder(name, obj, fn)` 형태는 obj가 GC 대상이 될 수 있지만, `() -> cache.size()` 같은 람다는 객체를 강하게 캡처해 회수를 막는다. 같은 이름·태그의 Meter는 첫 등록만 유효하다.

**percentile**은 `publishPercentiles()`로 만든 클라이언트 측 값이 위치 통계량이라 인스턴스 간 `avg()`가 성립하지 않는다. 다중 인스턴스 SLO는 `publishPercentileHistogram()`으로 bucket을 내보내고 `histogram_quantile`로 서버 측에서 계산한다. bucket은 10~15개로 유지한다.

**alert 폭주와 drift**는 Grafana 계층의 문제다. 리전 장애 alert가 발화하면 같은 `region` 라벨의 하위 alert를 inhibition으로 잠재우고, 인스턴스별 alert 대신 서비스 비율 alert 하나를 둔다. provisioning에 `editable: false`를 강제하고 CI가 Git과 실제 상태를 diff한다. 백업은 alert rule·contact point까지 포함하고 분기마다 복원 시험을 한다.

**Elasticsearch 감시**는 클러스터(`_cluster/health`의 status·unassigned_shards·pending_tasks), 노드(`_nodes/stats`의 heap·old GC·thread pool rejected), 쿼리(slow log), 색인(index_failed), 캐시(fielddata evictions) 다섯 계층이다. self-monitoring은 대상 클러스터와 함께 죽으므로 Metricbeat가 외부에서 수집해 별도 모니터링 클러스터에 저장하는 3-tier가 표준이며, Prometheus 경로는 `elasticsearch_exporter`를 쓴다. 알림은 Cluster Red·Heap 85%·Disk 85%·Unassigned Shards·Thread Pool Rejected 다섯 룰로 시작한다.

## 코드

카디널리티 상한과 공통 태그를 설정한 registry 구성이다. `MeterRegistryCustomizer`는 Spring Boot가 registry를 만들 때 자동 적용된다.

```java
@Configuration
public class MetricsConfig {

    @Bean
    MeterRegistryCustomizer<MeterRegistry> guardrails() {
        return registry -> registry.config()
            .commonTags("application", "order-service")
            .meterFilter(MeterFilter.maximumAllowableTags(
                "http.server.requests", "uri", 100, MeterFilter.deny()));
    }
}
```

Meter는 생성자에서 한 번 등록해 필드로 재사용한다. 요청마다 builder를 호출하면 해시 조회가 hot path에 누적된다.

```java
@Service
public class PaymentService {

    private final Counter success;
    private final Counter failed;
    private final Timer latency;

    public PaymentService(MeterRegistry registry, PaymentQueue queue) {
        this.success = Counter.builder("payment.processed")
            .tag("result", "success").register(registry);
        this.failed = Counter.builder("payment.processed")
            .tag("result", "failed").register(registry);
        this.latency = Timer.builder("payment.latency")
            .publishPercentileHistogram()
            .serviceLevelObjectives(Duration.ofMillis(100), Duration.ofMillis(300))
            .register(registry);
        Gauge.builder("payment.queue.size", queue, PaymentQueue::size)
            .register(registry);
    }

    public Receipt pay(PaymentRequest req) {
        return latency.record(() -> {
            try {
                Receipt r = gateway.charge(req);
                success.increment();
                return r;
            } catch (GatewayException e) {
                failed.increment();
                throw e;
            }
        });
    }
}
```

계측 동작은 `SimpleMeterRegistry`를 명시 주입해 검증한다. `Metrics.globalRegistry` 직접 참조는 테스트에서 조용히 통과하고 운영에서 누락된다.

```java
@Test
void 결제_성공시_카운터가_증가한다() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    PaymentService service = new PaymentService(registry, new PaymentQueue());

    service.pay(sampleRequest());

    Counter counter = registry.find("payment.processed")
        .tag("result", "success").counter();
    assertThat(counter.count()).isEqualTo(1.0);
}
```

## 실무에서 걸리는 지점

- **actuator 노출**: `/actuator/prometheus`는 기본으로 서비스 포트에 함께 열린다. `management.server.port: 8081`로 분리하고 NetworkPolicy로 monitoring namespace만 허용한다.
- **이중 계측과 태그셋 충돌**: `@Timed`와 수동 `Timer.record()`를 겹치면 카운트가 두 배가 된다. 같은 이름의 Meter에 다른 태그 키 집합을 쓰면 `IllegalArgumentException`이 나므로 키 집합은 고정하고 없는 값은 `unknown`으로 채운다.
- **비동기 컨텍스트 손실**: Observation과 span은 ThreadLocal로 전파되어 Reactor·`@Async` 경계에서 끊긴다. `context-propagation` 의존성을 추가하고 `Hooks.enableAutomaticContextPropagation()`을 호출한다.
- **PII와 비용**: 경로에 실린 email이 Loki에 남으면 GDPR·PIPA 위반이다. Alloy `stage.replace`로 ingestion 전에 마스킹한다. Loki chunk가 작으면 S3 PUT 비용이 폭증하므로 1.5MB·2시간 단위로 키운다.
- **Elasticsearch 임계 무시**: heap 75% 지속은 old GC와 circuit breaker로 이어지고, disk는 85%·90%·95% 순으로 할당 차단·강제 이동·read-only가 된다.

## 관련 글

- [Meter 타입·태그·카디널리티](/notes/observability/meter-types-tags-cardinality/)
- [Timer·percentile·histogram·SLO](/notes/observability/timer-percentile-slo/)
- [Alerting·Notification·SLO](/notes/observability/alerting-slo/)
