---
title: "Loki·LogQL과 Tempo·TraceQL"
series: observability
part: "수집과 저장"
order: 6
summary: "Loki와 Tempo는 인덱스를 최소화하고 object storage에 저장해 비용을 낮추며, trace_id로 세 신호를 잇는다"
tags: [Loki, LogQL, Tempo, TraceQL, OpenTelemetry]
sources: [grafana/2026-05-18-grafana-loki-logql.md, grafana/2026-05-18-grafana-tempo-traceql.md]
updated: 2026-08-30
---

메트릭은 에러율이 튀었다는 사실만 알려 준다. 어떤 요청이 어디서 왜 실패했는지는 로그와 트레이스가 답하는데, 로그를 Elasticsearch에 전문 인덱싱하거나 모든 span을 저장하면 비용이 감당되지 않는다. Loki와 Tempo는 인덱스를 최소화하고 압축 데이터를 object storage에 두는 같은 설계로 이 문제에 답한다.

## 핵심 개념

### Loki — label만 인덱싱한다

Loki는 로그 본문을 인덱싱하지 않는다. label 집합만 TSDB 인덱스에 올리고, 같은 label 조합의 로그 묶음을 stream이라 부른다. 로그는 압축된 chunk로 S3·GCS에 저장되고, 검색은 label로 stream을 좁힌 뒤 chunk를 스캔한다.

label에는 정적 메타데이터만 둔다. request_id·user_id를 label로 쓰면 stream이 폭증해 Prometheus의 cardinality 장애와 같은 일이 난다. 동적 값은 로그 라인에 남기고 parser로 꺼낸다. 수집 agent는 Promtail 대신 Alloy가 권장이며, ==배포 모드는 100GB/일 미만이면 Single Binary, 5TB/일까지는 Simple Scalable, 그 이상은 Microservices다.==

### LogQL — 파이프라인으로 좁히고 시계열로 바꾼다

표현식은 stream selector로 시작해 파이프 단계를 거친다. line filter(`|=`, `!=`, `|~`, `!~`)가 원문을 거르고, parser(`| json`, `| logfmt`, `| pattern`)가 field를 추출하며, label filter(`| status >= 500`)가 그 field를 비교한다. `rate`·`count_over_time`을 감싸면 로그가 시계열이 되어 alert rule에서 Prometheus metric처럼 쓰인다.

### Tempo와 TraceQL

trace는 한 요청의 전체 경로이고, span은 그 안의 작업 단위로 trace_id·parent_span_id·service.name·duration·status를 가진다. Tempo는 OTLP·Jaeger·Zipkin을 수신하며 신규 계측은 OpenTelemetry를 쓴다. 압축 block을 object storage에 두고, trace_id 직접 조회는 즉시 끝나며 조건 검색은 bloom filter로 후보 block을 거른 뒤 스캔한다.

TraceQL은 `{ resource.service.name = "api" && span.http.status_code = 500 }`처럼 attribute를 필터하고 `| avg(duration) > 500ms` 같은 aggregate를 붙인다. 차별점은 구조 연산자다. `>`는 직접 자식, `>>`는 후손, `~`는 형제 관계를 뜻해 "frontend가 호출한 db span 중 느린 것"처럼 흐름 자체를 조건으로 건다.

### 세 신호를 잇는 장치

Tempo의 Metric Generator는 trace에서 RED metric(`traces_spanmetrics_*`)과 호출 관계 metric(`traces_service_graph_*`)을 만들어 Prometheus로 보내고, Grafana는 이를 Service Graph로 그린다. Exemplar는 histogram sample에 trace_id를 붙여 p99 그래프의 점에서 trace로 이동하게 한다. Loki의 Derived Field는 로그의 trace_id를 Tempo 링크로 바꾸고, Tempo의 Trace to logs는 span에서 같은 trace_id의 로그를 연다.

sampling은 tail 방식을 쓴다. ==head sampling은 에러 trace도 같은 비율로 버리지만, tail sampling은 trace가 끝난 뒤 에러·느린 trace를 전부 남기고 정상 trace만 일부 남긴다.==

## 코드

Spring Boot 3.x에서 Micrometer Tracing을 OTLP로 보내고 로그에 trace_id를 넣는 설정이다.

```yaml
management:
  tracing:
    sampling:
      probability: 1.0        # sampling 결정은 Collector의 tail sampling에 맡긴다
  otlp:
    tracing:
      endpoint: http://otel-collector:4318/v1/traces
  endpoints:
    web:
      exposure:
        include: health,prometheus

logging:
  pattern:
    level: "%5p [${spring.application.name},trace_id=%X{traceId:-},span_id=%X{spanId:-}]"
```

HTTP 자동 계측 위에 비즈니스 경계에만 span을 추가한다.

```java
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final ObservationRegistry registry;
    private final PaymentClient paymentClient;
    private final OrderRepository orderRepository;

    public OrderService(ObservationRegistry registry,
                        PaymentClient paymentClient,
                        OrderRepository orderRepository) {
        this.registry = registry;
        this.paymentClient = paymentClient;
        this.orderRepository = orderRepository;
    }

    public Order create(OrderRequest request) {
        return Observation.createNotStarted("order.create", registry)
            .lowCardinalityKeyValue("order.currency", request.currency())
            .observe(() -> {
                PaymentResult payment = Observation
                    .createNotStarted("order.payment", registry)
                    .observe(() -> paymentClient.charge(request));
                return orderRepository.save(Order.of(request, payment.transactionId()));
            });
    }
}
```

OTel Collector는 tail sampling으로 에러·느린 trace를 보존하고 민감 attribute를 지운 뒤 Tempo로 보낸다.

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
    timeout: 10s
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 1000 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
  attributes/redact:
    actions:
      - { key: user.email, action: delete }
      - { key: http.request.body, action: delete }

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, tail_sampling, attributes/redact]
      exporters: [otlp/tempo]
```

## 실무에서 걸리는 지점

- **LogQL 단계 순서가 성능을 결정한다.** selector는 app까지 좁히고, line filter는 매칭이 적은 패턴을 먼저 두며, `| json` parser는 양을 줄인 뒤 마지막에 건다.
- **retention은 compactor가 켜져야 실제로 삭제된다.** ==`retention_period`만 두고 `compactor.retention_enabled: true`를 빼면 저장소가 끝없이 커진다.==
- **Metric Generator의 dimension이 cardinality를 만든다.** service × operation × status에 dimension을 더할수록 시계열이 곱으로 늘어나므로 실제로 쓰는 것만 남긴다.
- **service.name이 흔들리면 Service Graph와 Trace to logs가 끊긴다.** `spring.application.name`을 배포 설정에서 일원화한다.
- **PII는 저장 전에 지운다.** 이메일·카드번호는 Alloy stage와 Collector의 attributes processor에서 걸러야 object storage에 남지 않는다.

## 관련 글

- [관측성 3 pillar와 LGTM 스택·Micrometer facade](/notes/observability/three-pillars-lgtm/)
- [Prometheus와 PromQL](/notes/observability/prometheus-promql/)
- [IaC·Cloud·OpenTelemetry 연동](/notes/observability/iac-cloud-opentelemetry/)
