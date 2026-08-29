---
title: "Actuator와 Micrometer"
series: java-spring
part: "운영·통합"
order: 35
summary: "Actuator 엔드포인트로 상태를 노출하고 Micrometer로 메트릭·트레이스를 수집해 운영 가시성을 확보하는 방법"
tags: [Actuator, Micrometer, Prometheus, Observation API, Kubernetes Probe]
sources: [spring/2026-05-17-spring-actuator.md, 2026-05-02-spring-observability.md, micrometer/2026-05-25-micrometer-spring-boot-actuator.md]
updated: 2026-08-29
---

컨테이너로 띄운 애플리케이션이 멈추면 콘솔 로그만으로는 원인을 찾기 어렵다. Kubernetes는 인스턴스가 살아 있는지, 트래픽을 받을 준비가 됐는지 판단할 신호가 필요하고, 운영자는 힙 사용량·커넥션 풀 대기·응답 시간 분포를 시계열로 봐야 장애 전조를 잡는다. Actuator는 이 운영 기능을 HTTP 엔드포인트로 제공하고, Micrometer는 메트릭을 수집해 Prometheus 같은 백엔드로 내보내는 추상화 계층을 맡는다.

## 핵심 개념

### Actuator 엔드포인트와 노출 제어

`spring-boot-starter-actuator` 의존성을 추가하면 `/actuator/*` 경로에 `health`(상태)·`info`(빌드 버전)·`metrics`·`prometheus`·`loggers`(로그 레벨 변경)·`env`·`heapdump` 등이 등록된다. Spring Boot 3.x 기준 웹으로 기본 노출되는 것은 `health` 하나뿐이며, 나머지는 `management.endpoints.web.exposure.include`에 명시해야 열린다. `/health`는 등록된 `HealthIndicator`를 모두 집계하며 DB·Redis·디스크 중 하나라도 DOWN이면 전체가 DOWN이다.

### Kubernetes 프로브

`management.health.probes.enabled=true`를 켜면 `/actuator/health/liveness`와 `/readiness`가 생긴다. Liveness 실패는 컨테이너 재시작을 유발하고, Readiness 실패는 라우팅에서 제외될 뿐 재시작하지 않는다. Readiness는 초기화가 끝날 때까지 OUT_OF_SERVICE를 유지하므로 DB 연결 대기 같은 일시적 상태는 Readiness에만 반영한다.

### Micrometer와 자동 계측

Micrometer는 메트릭의 SLF4J다. 코드는 `MeterRegistry`에만 의존하고, 클래스패스의 구현체(`micrometer-registry-prometheus`)가 백엔드 포맷을 결정한다. 자동 구성은 `PrometheusMeterRegistry` 빈과 `/actuator/prometheus`를 등록하고, 내장 `MeterBinder`들이 `jvm.memory.used`·`jvm.gc.pause`·`hikaricp.connections.pending`·`tomcat.threads.busy`·`http.server.requests`·`logback.events` 같은 메트릭을 일괄 등록한다. Meter 타입은 Counter(단조 증가), Gauge(현재 값), Timer(소요 시간과 횟수), DistributionSummary(크기 분포) 네 가지다. `/actuator/metrics`는 JSON 탐색용이고, Prometheus 스크레이프 대상은 `/actuator/prometheus`여야 한다.

### Observation API

Spring Boot 3.x의 Observation API는 하나의 Observation으로 Timer(메트릭)와 Span(트레이스)을 동시에 만든다. `lowCardinalityKeyValue`는 메트릭 태그와 span attribute 양쪽에, `highCardinalityKeyValue`는 span attribute에만 기록되어 주문 ID 같은 무한 값이 시계열을 폭발시키는 사고를 막는다. 트레이스를 실제로 내보내려면 `micrometer-tracing-bridge-otel`과 exporter 의존성이 추가로 필요하다.

## 코드

운영 기본 설정. 관리 포트를 분리하고 노출을 최소화하며 HTTP 요청 메트릭에만 히스토그램을 켠다.

```yaml
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, metrics, loggers
  endpoint:
    health:
      show-details: when-authorized
  health:
    probes:
      enabled: true
  metrics:
    tags:
      application: ${spring.application.name}
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 50ms, 100ms, 200ms, 500ms
server:
  shutdown: graceful
```

Actuator 전용 `SecurityFilterChain`. `health`·`info`만 무인증으로 열고 나머지는 ADMIN으로 제한하며, `@Order(1)`로 API 체인보다 먼저 평가되게 한다.

```java
@Configuration
public class ActuatorSecurityConfig {

    @Bean
    @Order(1)
    SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
        http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(EndpointRequest.to("health", "info")).permitAll()
                .anyRequest().hasRole("ADMIN"))
            .httpBasic(Customizer.withDefaults());
        return http.build();
    }
}
```

커스텀 헬스 인디케이터와 계측. `@Observed`는 `ObservedAspect` 빈이 있어야 동작한다.

```java
@Component
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final PaymentGateway gateway;

    public PaymentGatewayHealthIndicator(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    @Override
    public Health health() {
        try {
            return gateway.ping()
                ? Health.up().withDetail("latencyMs", gateway.latencyMillis()).build()
                : Health.down().withDetail("reason", "ping failed").build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}

@Configuration
public class MetricsConfig {

    @Bean
    ObservedAspect observedAspect(ObservationRegistry registry) {
        return new ObservedAspect(registry);
    }

    @Bean
    MeterRegistryCustomizer<MeterRegistry> meterFilters() {
        return registry -> registry.config()
            .meterFilter(MeterFilter.maximumAllowableTags(
                "http.server.requests", "uri", 100, MeterFilter.deny()));
    }
}

@Service
public class OrderService {

    private final ObservationRegistry observationRegistry;

    public OrderService(ObservationRegistry observationRegistry) {
        this.observationRegistry = observationRegistry;
    }

    @Observed(name = "orders.process", lowCardinalityKeyValues = {"team", "checkout"})
    public Order process(CreateOrderRequest request) {
        return Observation.createNotStarted("orders.validate", observationRegistry)
            .lowCardinalityKeyValue("type", request.type().name())
            .highCardinalityKeyValue("orderId", request.orderId().toString())
            .observe(() -> validateAndSave(request));
    }
}
```

## 실무에서 걸리는 지점

- **`include: "*"`를 운영에 두는 것.** `/env`는 시크릿을, `/heapdump`는 메모리 전체를 노출한다. `health,info,prometheus`로 제한하고 관리 포트를 분리한다.
- **`@Timed`·`@Observed`를 붙였는데 메트릭이 없다.** `TimedAspect`·`ObservedAspect` 빈이 없으면 AOP가 연결되지 않고 컴파일 오류도 없다. `http.server.requests`만 잡히는 증상이면 Aspect 빈부터 확인한다.
- **`initialDelaySeconds`가 짧으면 재시작 루프에 빠진다.** 기동이 60초 넘게 걸리면 Liveness가 먼저 실패해 컨테이너가 계속 죽는다. `startupProbe`를 두거나 지연을 기동 시간에 맞춘다.
- **히스토그램을 모든 Timer에 켜면 Prometheus 메모리가 급증한다.** `histogram_quantile()`을 실제로 쓰는 메트릭에만 켜고 `uri` 태그 카디널리티를 `MeterFilter`로 제한한다.
- **SecurityFilterChain에 `@Order`가 없으면 Actuator 요청이 401을 받는다.** API 체인이 먼저 매칭될 수 있다. `/actuator/loggers` POST는 반드시 인증 뒤에 둔다.

## 관련 글

- [로깅 — Logback·SLF4J](/notes/java-spring/logging-logback-slf4j/)
- [CORS와 Spring Security — OAuth2·JWT](/notes/java-spring/cors-security-oauth2-jwt/)
- [배포 — Docker·Buildpack](/notes/java-spring/deploy-docker-buildpack/)
