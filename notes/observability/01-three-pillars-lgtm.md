---
title: "관측성 3 pillar와 LGTM 스택·Micrometer facade"
series: observability
part: "개념"
order: 1
summary: "Metrics·Logs·Traces를 앱 계측(Micrometer)·저장(LGTM)·시각화(Grafana)로 나눠 각 계층의 역할과 경계를 정리한다"
tags: [Observability, Micrometer, Grafana, LGTM, Prometheus]
sources: [micrometer/2026-05-25-micrometer-welcome.md, grafana/2026-05-18-grafana-welcome.md]
updated: 2026-08-29
---

서비스가 느려졌다는 신고가 들어왔을 때 로그만 있는 시스템은 "어느 시각에 어떤 에러가 찍혔는가"까지만 답한다. 어느 엔드포인트의 p99가 언제부터 튀었는지는 로그 텍스트로는 나오지 않는다. 앱이 자기 상태를 수치·이벤트·요청 흐름의 세 형태로 내보내고 그 셋을 한 화면에서 엮을 수 있어야 "왜, 어디서"에 답할 수 있다. 이 능력이 관측성이고, Java·Spring 진영에서 그 시작점이 Micrometer, 저장과 시각화의 끝점이 Grafana Labs의 LGTM 스택이다.

## 핵심 개념

모니터링은 사전에 정의한 지표를 임계치로 감시해 "무엇이 잘못됐는가"에 답하고, 관측성은 외부로 나온 데이터만으로 내부 상태를 추론해 "왜, 어디서, 어떤 흐름으로"에 답한다. 세 종류 데이터 사이의 연결(correlation)과 drill-down이 가능해야 하며, 그 세 종류가 3 pillar다.

| pillar | 답하는 질문 | 형태 | 특성 |
|:---|:---|:---|:---|
| Metrics | 지금 상태 | 시계열 수치 (RPS·p99·큐 크기) | 저장 효율이 높고 알림·트렌드에 적합 |
| Logs | 발생한 일 | 시각 + 자유 텍스트 이벤트 | context가 풍부하지만 저장 비용이 높다 |
| Traces | 요청의 여정 | span의 트리 (frontend → auth → db) | 분산 시스템의 병목 위치를 드러낸다 |

메트릭에서 p99가 5초로 뛴 구간을 찾고, 같은 시간대 로그에서 "connection pool exhausted"를 확인하고, 그 시각의 trace에서 DB 쿼리 span이 4.8초를 차지한 것을 보면 원인이 커넥션 풀 고갈이라는 결론에 도달한다.

파이프라인은 생산·저장·시각화의 세 계층으로 나뉜다. Micrometer는 생산 계층이다. 코드는 `MeterRegistry`라는 벤더 중립 API만 호출하고, 어느 백엔드로 나갈지는 클래스패스의 `micrometer-registry-*` 의존성이 결정한다. SLF4J가 Logback을 숨기는 것과 같은 구조다.

Meter는 이름과 태그(key=value) 조합으로 식별된다. `http.server.requests{uri="/api/orders", status="500"}`처럼 태그가 차원이 되어 에러율을 계산하게 하는 것이 dimensional metrics다. 백엔드 전달은 Prometheus가 `/actuator/prometheus`를 주기적으로 긁어 가는 pull과, Datadog·CloudWatch·OTLP처럼 앱이 일정 step마다 밀어내는 push로 나뉜다. Observation API는 한 번의 계측으로 Timer(메트릭)와 Span(트레이스)을 동시에 만들며, Spring Cloud Sleuth를 대체한 Micrometer Tracing이 Brave 또는 OpenTelemetry bridge로 span을 내보낸다.

저장 계층이 LGTM이다. Loki는 로그를 label만 인덱싱해 객체 스토리지에 저장하고 LogQL로 조회한다. Tempo는 OpenTelemetry·Jaeger·Zipkin 형식의 trace를 객체 스토리지에 저장하고 TraceQL로 조회한다. Mimir는 Prometheus를 remote write로 받아 수평 확장과 장기 보관을 제공하며 PromQL을 그대로 지원한다. Grafana는 데이터를 저장하지 않고 datasource를 실시간 조회하며, Mixed datasource로 3 pillar를 한 화면에 모은다. 수집 에이전트 Alloy(구 Grafana Agent)는 메트릭·로그·트레이스를 한 프로세스로 처리한다.

## 코드

Actuator와 Prometheus 레지스트리를 붙이는 최소 의존성이다. `micrometer-registry-datadog`으로 교체하면 push 백엔드로 전환된다.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
    <scope>runtime</scope>
</dependency>
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
```

Meter는 생성자에서 한 번 등록하고 필드로 재사용한다. `register(registry)`를 빠뜨리면 컴파일은 되지만 데이터가 수집되지 않는다.

```java
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.time.Duration;

@Service
public class OrderService {

    private final Counter created;
    private final Counter failed;
    private final Timer processing;

    public OrderService(MeterRegistry registry) {
        this.created = Counter.builder("orders.created")
                .description("Successfully created orders")
                .register(registry);
        this.failed = Counter.builder("orders.failed")
                .register(registry);
        this.processing = Timer.builder("orders.processing.time")
                .publishPercentileHistogram()
                .serviceLevelObjectives(Duration.ofMillis(100),
                        Duration.ofMillis(300), Duration.ofMillis(1000))
                .register(registry);
    }

    public Order createOrder(CreateOrderRequest req) {
        return processing.record(() -> {
            try {
                Order order = doCreate(req);
                created.increment();
                return order;
            } catch (RuntimeException e) {
                failed.increment();
                throw e;
            }
        });
    }
}
```

Observation API는 한 블록으로 Timer와 Span을 함께 만든다. 태그는 `lowCardinalityKeyValue`로만 붙이고, 무한히 늘어나는 식별자는 `highCardinalityKeyValue`로 분리해 span에만 남긴다.

```java
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;

public Order createObserved(ObservationRegistry registry, CreateOrderRequest req) {
    return Observation.createNotStarted("orders.create", registry)
            .lowCardinalityKeyValue("region", req.region())
            .highCardinalityKeyValue("order.id", req.orderId())
            .observe(() -> doCreate(req));
}
```

## 실무에서 걸리는 지점

- 태그 값에 `userId`·`requestId` 같은 동적 식별자를 넣으면 시계열이 사용자 수만큼 늘어나 Prometheus·Mimir 메모리가 고갈된다. 태그 값은 유한 집합이어야 하며 식별자는 로그나 trace의 속성으로 보낸다.
- "지금까지 몇 번"은 단조 증가 Counter, "지금 몇 개"는 Gauge다. 시간이 아닌 크기(페이로드 바이트·배치 건수)는 Timer가 아니라 DistributionSummary로 잰다.
- 커스텀 Meter 이름이 Actuator 자동 계측 prefix(`http.`, `jvm.`, `tomcat.`)와 겹치면 충돌하므로 도메인 prefix(`orders.`)를 붙인다.
- Push 백엔드는 기본 step이 1분이라 짧은 스파이크를 놓친다. `management.<backend>.metrics.export.step`으로 줄이면 API 호출 비용이 비례해 늘어난다. Micrometer Tracing은 bridge 의존성이 없으면 span이 나가지 않는다.
- 단일 Prometheus는 retention 15일 정도가 권장 한도라 Mimir·Thanos 또는 관리형 서비스를 붙여야 하고, Grafana Cloud는 무료 한도를 넘긴 뒤의 비용 분기점을 self-host와 미리 비교한다.

## 관련 글

- [Meter 타입·태그·카디널리티](/notes/observability/meter-types-tags-cardinality/)
- [Registry·push vs pull·Actuator 연동](/notes/observability/registry-backends-actuator/)
- [Loki·LogQL과 Tempo·TraceQL](/notes/observability/loki-tempo/)
