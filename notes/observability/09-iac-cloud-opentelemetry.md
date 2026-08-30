---
title: "IaC·Cloud·OpenTelemetry 연동"
series: observability
part: "운영"
order: 9
summary: "scrape 대상·대시보드·알림을 코드로 선언하고, 앱은 OTel Collector 하나로만 push하도록 만드는 자동화 뼈대"
tags: [OpenTelemetry, ServiceMonitor, Terraform, Grafana Cloud, IaC]
sources: [micrometer/2026-05-25-micrometer-iac-otel.md, grafana/2026-05-18-grafana-cloud-iac.md, elasticsearch/2026-05-19-elasticsearch-observability-apm-uptime.md]
updated: 2026-08-30
---

Prometheus 설정에 타깃을 손으로 적고 Grafana UI에서 패널을 클릭으로 만드는 방식은 서비스가 수십 개로 늘어나면 무너진다. Pod가 재시작되면 IP가 바뀌어 scrape가 끊기고, UI에서 만든 대시보드는 Git 이력이 없다. 팀마다 메트릭 이름이 달라 전사 현황을 모으지 못하고, 백엔드를 추가할 때마다 앱을 재배포해야 한다. 여기에 OpenTelemetry를 들이면 Micrometer와의 경계부터 흔들린다. 이 경계를 정리하고 scrape·대시보드·알림·수집 경로를 코드로 선언하는 뼈대를 세운다.

## 핵심 개념

**Micrometer와 OpenTelemetry는 같은 계층이 아니다.** Micrometer는 앱 안에서 메트릭과 trace를 생성하는 계측 facade이고, OpenTelemetry(OTel)는 벤더 중립 wire format(OTLP)과 OTel Collector를 포함하는 생태계다. "생성은 Micrometer, 전송은 OTLP"가 현실적인 구도다. `micrometer-registry-otlp`의 `OtlpMeterRegistry`가 메트릭을 push하고, `micrometer-tracing-bridge-otel`이 Micrometer Tracing과 OTel SDK를 잇는다. Spring Boot 3.x는 bridge와 `opentelemetry-exporter-otlp`만 추가하면 자동 설정된다.

**OTel Collector는 팬아웃 허브다.** 앱은 Collector 하나에만 보내고, Collector가 Prometheus remote write, Grafana Cloud, Elastic 등으로 분배하므로 백엔드를 바꿔도 앱 재배포가 없다. Elastic도 OTel SDK를 받으며 신규 서비스에는 OTel 경로를 권장한다. ==SDK가 섞여도 W3C `traceparent` 헤더만 지키면 한 trace로 이어진다.==

**scrape 대상은 ServiceMonitor·PodMonitor CRD로 선언한다.** Prometheus Operator가 레이블 셀렉터로 대상을 자동 발견한다. ServiceMonitor가 기본이고, PodMonitor는 Service가 없는 DaemonSet·Job에만 쓴다.

| 필드 | 적용 시점 | 용도 |
|:---|:---|:---|
| `relabelings` | scrape 전 | 어떤 타깃을 긁을지 결정, 타깃 레이블 변환 |
| `metricRelabelings` | scrape 후 | 수집된 메트릭 이름·레이블 드롭 |

**Grafana IaC는 세 계층이다.** Terraform Grafana Provider는 데이터소스·폴더·권한·알림 규칙을, Helm은 배포·업그레이드를 맡고 ArgoCD와 결합하면 git push가 곧 반영이 된다. Provisioning은 `/etc/grafana/provisioning/` 아래 파일로 운영 설정을 박는 방식이며 `editable: false`를 강제해야 UI 수정과의 drift를 막는다. Grafana Cloud는 UI·알림만 맡기고 데이터는 자체 운영하는 hybrid가 가장 흔하다.

**커스텀 메트릭은 MeterBinder로 라이브러리화한다.** 사내 공통 jar의 `MeterBinder` Bean을 Spring Boot가 감지해 `bindTo`를 호출한다. `MeterFilter`로 prefix와 공통 태그를 강제하면 대시보드 템플릿을 그대로 재사용할 수 있다.

## 코드

Actuator 포트를 분리하고 메트릭·trace를 OTLP로 Collector에 보내는 설정이다. Prometheus export는 꺼서 이중 전송을 막는다.

```yaml
server:
  port: 8080

management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, metrics
  opentelemetry:
    resource-attributes:
      service.name: order-service
      service.version: "1.0.0"
      deployment.environment: production
  otlp:
    metrics:
      export:
        url: http://otel-collector.monitoring:4318/v1/metrics
        step: 30s
    tracing:
      endpoint: http://otel-collector.monitoring:4317
  tracing:
    sampling:
      probability: 0.1
  prometheus:
    metrics:
      export:
        enabled: false
```

`MeterBinder`·`MeterFilter`로 표준 메트릭과 prefix·공통 태그·카디널리티 상한을 강제하고, actuator 경로를 IP로 보호하는 설정이다.

```java
@Configuration
public class MetricsConfig {

    private static final Set<String> AUTO_PREFIXES =
            Set.of("jvm.", "http.", "system.", "process.", "tomcat.", "hikaricp.", "spring.");

    @Bean
    public MeterBinder orderMetrics() {
        return registry -> {
            Counter.builder("company.orders.created.total")
                    .description("주문 생성 건수")
                    .register(registry);
            Timer.builder("company.orders.processing.seconds")
                    .publishPercentileHistogram()
                    .register(registry);
        };
    }

    @Bean
    public MeterRegistryCustomizer<MeterRegistry> namingConvention(
            @Value("${spring.application.name}") String appName) {
        return registry -> registry.config()
                .meterFilter(new MeterFilter() {
                    @Override
                    public Meter.Id map(Meter.Id id) {
                        String name = id.getName();
                        boolean auto = AUTO_PREFIXES.stream().anyMatch(name::startsWith);
                        if (auto || name.startsWith("company.")) {
                            return id;
                        }
                        return id.withName("company." + appName + "." + name);
                    }
                })
                .meterFilter(MeterFilter.maximumAllowableTags(
                        "company.", "userId", 100, MeterFilter.deny()))
                .commonTags("service", appName,
                        "environment", System.getenv().getOrDefault("ENV", "local"));
    }

    @Bean
    public SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
        return http
                .securityMatcher("/actuator/**")
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/actuator/health").permitAll()
                        .requestMatchers("/actuator/prometheus")
                                .access(IpAddressAuthorizationManager.hasIpAddress("10.0.0.0/8"))
                        .anyRequest().hasRole("ADMIN"))
                .build();
    }
}
```

관리 포트 Service를 레이블로 발견하는 ServiceMonitor와, 표준 메트릭 이름을 참조하는 Terraform 대시보드·알림 규칙이다.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: order-service
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      monitoring: "true"
  namespaceSelector:
    matchNames: [production]
  endpoints:
    - port: management
      path: /actuator/prometheus
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: environment
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: 'jvm_gc_pause_seconds_bucket'
          action: drop
```

```hcl
resource "grafana_dashboard" "order_service" {
  folder = grafana_folder.microservices.uid
  config_json = templatefile("${path.module}/dashboards/service.json", {
    service = "order-service"
  })
}

resource "grafana_rule_group" "order_slo" {
  name             = "order-slo"
  folder_uid       = grafana_folder.microservices.uid
  interval_seconds = 60

  rule {
    name      = "OrderSloBurnFast"
    condition = "A"
    for       = "2m"
    data {
      ref_id         = "A"
      datasource_uid = grafana_data_source.prometheus.uid
      model = jsonencode({
        expr = "sum(rate(company_orders_failed_total{service=\"order-service\"}[1h])) / sum(rate(company_orders_created_total{service=\"order-service\"}[1h])) > 0.0144"
      })
    }
    labels = { severity = "critical" }
  }
}
```

## 실무에서 걸리는 지점

- **actuator 공개망 노출.** ingress 실수로 `/actuator/prometheus`가 열리면 JVM 상태와 비즈니스 메트릭이 그대로 읽힌다. 포트 분리, NetworkPolicy, IP 필터 세 겹을 둔다.
- **이중 수집.** ==같은 Pod를 ServiceMonitor와 PodMonitor가 동시에 잡거나 OTLP와 Prometheus registry가 함께 켜지면 `rate()`가 두 배로 나온다.== OTel Java agent와 tracing bridge를 함께 쓰면 span도 중복된다.
- **ServiceMonitor 미발견.** Operator는 `serviceMonitorSelector`와 맞는 레이블만 처리하므로 `metadata.labels`를 맞춘다. drop regex는 staging에서 먼저 검증한다.
- **Collector 단일 장애점.** ==큐 없이 batch만 쓰면 재시작 동안 데이터가 증발한다.== `sending_queue`, `retry_on_failure`, `file_storage`로 디스크 큐를 두고 복수 replica를 둔다.
- **IaC 상태와 비밀값.** Terraform state는 remote backend에 두고, Helm values의 비밀값은 Vault로 주입한다. ==Grafana Cloud Free 한도 초과는 자동 과금이므로 usage alert를 건다.==

## 관련 글

- [Registry·push vs pull·Actuator 연동](/notes/observability/registry-backends-actuator/)
- [Grafana Dashboard·Panel·Variable](/notes/observability/grafana-dashboards/)
- [운영 함정과 사고 케이스·Elasticsearch 모니터링](/notes/observability/operations-incidents/)
