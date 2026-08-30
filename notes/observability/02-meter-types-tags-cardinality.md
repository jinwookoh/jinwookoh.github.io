---
title: "Meter 타입·태그·카디널리티"
series: observability
part: "메트릭"
order: 2
summary: "측정 대상의 성격에 맞는 Meter 타입을 고르고, 태그 값을 유한 집합으로 제한해 시계열 폭발을 막는다"
tags: [Micrometer, Counter, Gauge, Timer, MeterFilter]
sources: [micrometer/2026-05-25-micrometer-meter-types.md, micrometer/2026-05-25-micrometer-tags-cardinality.md]
updated: 2026-08-29
---

메트릭을 수집하기로 했다면 두 가지 결정이 따라온다. 어떤 종류의 값으로 기록할 것인가, 그 값을 어떤 축으로 쪼개서 볼 것인가. 전자를 잘못 고르면 대시보드가 거짓말을 하고, 후자를 잘못 고르면 요청마다 새 시계열이 생겨 Prometheus가 OOM으로 죽는다.

## 핵심 개념

### Meter 타입

| 타입 | 측정 대상 | 특징 |
|:---|:---|:---|
| Counter | 누적 총합 (요청 수·에러 수) | 단조 증가. rate는 백엔드가 계산 |
| Gauge | 현재 값 (큐 길이·커넥션 수) | 증감 가능. 객체 + 읽기 함수를 주기적으로 읽음 |
| Timer | 실행 시간 | count·totalTime·max. 내부 단위 나노초 |
| DistributionSummary | 시간이 아닌 수량 분포 (바이트·건수) | Timer와 같은 구조, 단위는 `baseUnit` |
| LongTaskTimer | 진행 중인 장기 작업 | active count와 경과 시간. 완료 latency는 집계 안 함 |
| FunctionCounter / FunctionTimer | 외부 라이브러리의 누적값 | 함수로 읽어 옴 |

"지금까지 총 몇 번"이면 Counter, "지금 이 순간 몇 개"이면 Gauge, "얼마나 걸렸나"이면 Timer, "크기나 건수가 얼마였나"이면 DistributionSummary다.

Gauge는 관찰 대상을 약한 참조로 잡아 대상이 GC되면 `NaN`을 보고한다. 반대로 람다가 외부 객체를 캡처하면 레지스트리가 Supplier를 강하게 붙들어 GC되지 않는다. 대상 객체를 두 번째 인자로 명시하면 두 문제를 모두 피한다.

### 태그는 차원이다

같은 이름의 Meter라도 태그 조합이 다르면 별개의 시계열이 되고, `sum by (region)`처럼 태그가 집계의 축이 된다. 시계열 수는 태그별 고유 값 수의 곱이라 region 3종 × type 2종이면 6개지만 `userId`를 넣으면 3 × 1,000,000이 된다. 각 시계열은 Prometheus 메모리에 상주하므로 태그 값은 유한 집합에서 나와야 한다. userId·requestId·raw URL·IP는 태그 값으로 쓰지 않으며, 요청별 추적은 로그와 트레이스의 영역이다.

### common tags와 URI 정규화

`application`·`env`처럼 모든 메트릭에 붙는 태그는 `management.metrics.tags.*` 설정이나 `MeterRegistryCustomizer` 빈으로 한 번만 등록한다. `instance`는 Prometheus가 이미 부여하므로 중복으로 넣지 않는다.

`http.server.requests`는 `uri="/order/{id}"` 템플릿으로 기록하지만, `getRequestURI()`를 직접 태그에 넣으면 주문 수만큼 시계열이 생긴다. 커스텀 Timer에는 `HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE`의 템플릿이나 상수를 쓴다.

### MeterFilter

`MeterFilter`는 레지스트리 레벨에서 Meter 등록을 가로채 차단·태그 값 치환·카디널리티 상한을 적용하므로 외부 라이브러리의 Meter도 통제한다. 필터는 등록 순서대로 체인 평가되므로 `accept`는 `deny`보다 앞에 와야 한다.

### 네이밍 규칙

Meter 이름과 태그 키는 소문자 dot-separated로 쓰고 각 백엔드가 자기 관례로 변환한다. Prometheus는 underscore로 바꾸고 Timer에 `_seconds`, Counter에 `_total`을 붙이므로, 이름에 단위를 넣으면 `api_latency_ms_seconds`처럼 중복된다. 단위는 `baseUnit()`으로 전달한다.

## 코드

처리 파이프라인을 Counter 세 개와 Gauge 하나로 계측한다. 누적 총합과 현재 진행 수를 함께 본다.

```java
@Service
public class OrderPipelineService {

    private final Counter received;
    private final Counter processed;
    private final Counter failed;
    private final AtomicInteger inProgress = new AtomicInteger();
    private final Timer processingTimer;

    public OrderPipelineService(MeterRegistry registry) {
        this.received = Counter.builder("orders.received")
            .description("Orders received into pipeline").register(registry);
        this.processed = Counter.builder("orders.processed")
            .description("Successfully processed orders").register(registry);
        this.failed = Counter.builder("orders.failed")
            .description("Failed order processing attempts").register(registry);
        this.processingTimer = Timer.builder("orders.processing")
            .description("Order processing latency").register(registry);
        Gauge.builder("orders.in.progress", inProgress, AtomicInteger::get)
            .description("Orders currently being processed").register(registry);
    }

    public void process(Order order) {
        received.increment();
        inProgress.incrementAndGet();
        try {
            processingTimer.record(() -> doProcess(order));
            processed.increment();
        } catch (RuntimeException e) {
            failed.increment();
            throw e;
        } finally {
            inProgress.decrementAndGet();
        }
    }
}
```

배치 작업에는 LongTaskTimer와 Timer를 함께 건다. 전자는 지금 몇 개가 얼마나 오래 돌고 있는지, 후자는 완료된 배치의 소요 시간 분포를 답한다.

```java
@Component
public class SettlementJob {

    private final MeterRegistry registry;
    private final LongTaskTimer activeTimer;
    private final Timer completionTimer;

    public SettlementJob(MeterRegistry registry) {
        this.registry = registry;
        this.activeTimer = LongTaskTimer.builder("batch.settlement.active")
            .tag("job", "daily-settlement").register(registry);
        this.completionTimer = Timer.builder("batch.settlement")
            .tag("job", "daily-settlement").register(registry);
    }

    @Scheduled(cron = "0 0 2 * * *")
    public void run() {
        LongTaskTimer.Sample active = activeTimer.start();
        Timer.Sample sample = Timer.start(registry);
        try {
            doSettlement();
        } finally {
            active.stop();
            sample.stop(completionTimer);
        }
    }
}
```

common tags와 MeterFilter 체인을 하나의 `MeterRegistryCustomizer`에 모은다. uri는 숫자 경로를 템플릿으로 치환하고 고유 값 100개를 넘으면 차단한다.

```java
@Configuration
public class MetricsConfig {

    @Bean
    MeterRegistryCustomizer<MeterRegistry> metricsCustomizer(
            @Value("${spring.application.name}") String appName,
            @Value("${spring.profiles.active:local}") String env) {
        return registry -> registry.config()
            .commonTags(
                "application", appName,
                "env", env,
                "region", System.getenv().getOrDefault("AWS_REGION", "local"))
            .meterFilter(MeterFilter.denyNameStartsWith("tomcat.servlet"))
            .meterFilter(MeterFilter.replaceTagValues(
                "uri",
                v -> v.matches(".*/\\d+(/.*)?") ? v.replaceAll("/\\d+", "/{id}") : v))
            .meterFilter(MeterFilter.maximumAllowableTags(
                "http.server.requests", "uri", 100, MeterFilter.deny()));
    }
}
```

## 실무에서 걸리는 지점

- **Counter로 감소를 표현하려는 시도.** `increment(-1)`은 반영되지 않는다. `orders.cancelled` Counter를 따로 두거나 Gauge를 쓴다.
- **같은 이름에 다른 타입 등록.** `orders.total`을 Counter와 Gauge로 함께 등록하면 `IllegalArgumentException`이 난다. 이름에 성격을 담아 구분한다.
- **수동 시간 계산.** `System.currentTimeMillis()` 차이를 넘기면 예외 경로에서 기록이 빠진다. `timer.record(Runnable)`에 맡기고, `Timer.Sample`의 `stop()`은 `finally`에서 호출한다.
- **404·봇 트래픽이 만드는 시계열.** 스캐너가 두드린 raw 경로가 uri 태그에 쌓인다. `replaceTagValues`로 fallback 값에 모으거나 `maximumAllowableTags`로 상한을 걸되, 상한은 초과분을 버리는 2차 방어선이다.
- **방어적 태그 과다.** 태그 여섯 개를 달면 3 × 4 × 2 × 10 × 5 × 3 = 3,600 시계열이 된다. 실제 쿼리에서 쓰는 3~4개로 줄이고 `topk`로 시계열 수 상위 메트릭을 점검한다.

## 관련 글

- [관측성 3 pillar와 LGTM 스택·Micrometer facade](/notes/observability/three-pillars-lgtm/)
- [Timer·percentile·histogram·SLO](/notes/observability/timer-percentile-slo/)
- [Registry·push vs pull·Actuator 연동](/notes/observability/registry-backends-actuator/)
