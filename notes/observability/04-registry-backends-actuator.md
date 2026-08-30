---
title: "Registry·push vs pull·Actuator 연동"
series: observability
part: "메트릭"
order: 4
summary: "MeterRegistry 구현체가 pull과 push로 어떻게 갈리는지, Actuator가 그 위에 무엇을 자동으로 얹는지 정리한다."
tags: [Micrometer, MeterRegistry, Spring Boot Actuator, Prometheus, PushGateway]
sources: [micrometer/2026-05-25-micrometer-registry-backends.md, micrometer/2026-05-25-micrometer-spring-boot-actuator.md]
updated: 2026-08-30
---

==계측 코드가 한 줄이어도 그 값이 어디로 어떻게 나가는지는 MeterRegistry 구현체가 결정한다.== 이 구조를 모르면 의존성은 넣었는데 `enabled`나 API 키가 빠져 메트릭이 어느 백엔드로도 나가지 않는 상태를 로그 없이 겪고, pull과 push의 카운터 의미 차이 때문에 같은 Counter가 두 백엔드에서 다른 숫자로 보이며, `@Timed`를 붙이고도 데이터가 없는 상황이 생긴다.

## 핵심 개념

MeterRegistry는 추상 클래스이고 실제 동작은 백엔드별 구현체가 한다. Spring Boot는 클래스패스의 레지스트리 의존성을 보고 구현체 빈을 만들고, 둘 이상이면 CompositeMeterRegistry로 묶어 주입한다. Composite는 한 호출을 모든 child에 전달할 뿐 이중 집계하지 않으므로 백엔드 이전 검증 기간에 적합하다.

| 구분 | pull | push |
|:---|:---|:---|
| 구현체 | PrometheusMeterRegistry | StepMeterRegistry 계열 (Datadog·StatsD·CloudWatch·OTLP) |
| 전송 주체 | Prometheus 서버가 `/actuator/prometheus`를 scrape | 앱 내부 push 스레드가 step마다 전송 |
| Counter 의미 | 단조 누적값, rate는 서버가 `rate()`로 계산 | step 동안의 증가량을 보내고 리셋 |

StepMeterRegistry는 step 구간 단위로 집계해 전송하므로 step 도중 프로세스가 사라지면 그 구간은 어디에도 남지 않는다. scrape 시점에 이미 종료된 배치 잡은 PushGateway에 push해 두고 Prometheus가 PushGateway를 scrape하게 한다. `shutdown-operation: push`로 정상 종료 시 마지막 push를 보장하되, 오래 사는 서비스에 쓰면 stale 메트릭이 남으므로 단명 작업 전용이다.

Actuator 연동은 auto-configuration이 맡는다. `spring-boot-starter-actuator`와 레지스트리 의존성이 있으면 레지스트리 빈과 `/actuator/prometheus`가 등록되고, 내장 MeterBinder가 JVM·HikariCP·Tomcat·HTTP 서버(`http.server.requests`, uri·method·status·outcome 태그)·HTTP 클라이언트·Logback·캐시·Kafka 메트릭을 자동 등록한다. ==노출은 자동이 아니라 `management.endpoints.web.exposure.include`에 `prometheus`를 명시해야 하고, `/actuator/metrics`는 JSON 탐색용이라 scrape target이 될 수 없다.==

직접 얹는 수단은 세 가지다. `@Timed`·`@Counted`는 TimedAspect·CountedAspect 빈이 있어야 동작한다. MeterRegistryCustomizer는 common tag와 MeterFilter를 주입하며, 타입 파라미터가 `MeterRegistry`면 모든 child에 적용된다. Observation API는 하나의 Observation으로 Timer와 Span을 동시에 만들고, `lowCardinalityKeyValue`는 메트릭 태그와 trace 양쪽에, `highCardinalityKeyValue`는 trace에만 기록된다. `@Observed`에는 ObservedAspect와 `micrometer-tracing-bridge-otel` 의존성이 필요하다.

## 코드

프로파일별로 레지스트리를 명시적으로 켜고 운영에서는 Prometheus와 Datadog을 동시에 활성화하는 설정이다.

```yaml
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, metrics
  metrics:
    tags:
      application: ${spring.application.name}
      env: ${SPRING_PROFILES_ACTIVE:local}
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 50ms, 100ms, 200ms, 500ms
  prometheus:
    metrics:
      export:
        enabled: false
  datadog:
    metrics:
      export:
        enabled: false

---
spring:
  config:
    activate:
      on-profile: local
management:
  prometheus:
    metrics:
      export:
        enabled: true

---
spring:
  config:
    activate:
      on-profile: production
  lifecycle:
    timeout-per-shutdown-phase: 30s
server:
  shutdown: graceful
management:
  prometheus:
    metrics:
      export:
        enabled: true
  datadog:
    metrics:
      export:
        enabled: true
        api-key: ${DATADOG_API_KEY}
        step: 15s
```

Aspect 빈, common tag와 카디널리티 필터, 기동 시 활성 레지스트리 로그를 한 클래스에 모은 예다.

```java
import io.micrometer.core.aop.CountedAspect;
import io.micrometer.core.aop.TimedAspect;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.composite.CompositeMeterRegistry;
import io.micrometer.core.instrument.config.MeterFilter;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.observation.aop.ObservedAspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.actuate.autoconfigure.metrics.MeterRegistryCustomizer;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;

@Configuration
public class MetricsConfig {

    private static final Logger log = LoggerFactory.getLogger(MetricsConfig.class);

    @Bean
    TimedAspect timedAspect(MeterRegistry registry) {
        return new TimedAspect(registry);
    }

    @Bean
    CountedAspect countedAspect(MeterRegistry registry) {
        return new CountedAspect(registry);
    }

    @Bean
    ObservedAspect observedAspect(ObservationRegistry registry) {
        return new ObservedAspect(registry);
    }

    @Bean
    MeterRegistryCustomizer<MeterRegistry> commonCustomizer() {
        return registry -> registry.config()
            .commonTags("region", System.getenv().getOrDefault("AWS_REGION", "local"))
            .meterFilter(MeterFilter.maximumAllowableTags(
                "http.server.requests", "uri", 100, MeterFilter.deny()));
    }

    @EventListener(ApplicationReadyEvent.class)
    void logActiveRegistries(ApplicationReadyEvent event) {
        MeterRegistry registry = event.getApplicationContext().getBean(MeterRegistry.class);
        if (registry instanceof CompositeMeterRegistry composite) {
            log.info("active registries: {}", composite.getRegistries().stream()
                .map(r -> r.getClass().getSimpleName()).toList());
        } else {
            log.info("active registry: {}", registry.getClass().getSimpleName());
        }
    }
}
```

인메모리 SimpleMeterRegistry로 계측을 검증하는 단위 테스트다. 테스트마다 새 인스턴스를 만들어 오염을 막는다.

```java
import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OrderServiceMetricsTest {

    private SimpleMeterRegistry registry;
    private OrderService service;

    @BeforeEach
    void setUp() {
        registry = new SimpleMeterRegistry();
        service = new OrderService(registry);
    }

    @Test
    void createOrderIncrementsCounter() {
        service.createOrder(new CreateOrderRequest("us-east", "online"));
        service.createOrder(new CreateOrderRequest("us-east", "online"));

        double count = registry.find("orders.created")
            .tags("region", "us-east", "type", "online")
            .counter()
            .count();

        assertThat(count).isEqualTo(2.0);
    }
}
```

## 실무에서 걸리는 지점

- ==**child 없는 Composite.** `enabled: false`이거나 API 키가 비면 빈 Composite가 주입돼 메트릭이 조용히 사라진다.== 기동 시 `getRegistries()`를 로그로 남긴다.
- **step·scrape 주기와 강제 종료.** scrape 주기는 push step 이하로 맞추고, graceful shutdown 대기 시간을 step보다 길게 잡아야 마지막 구간이 전송된다. SIGKILL은 shutdown hook을 건너뛰므로 `terminationGracePeriodSeconds`도 늘린다.
- **PushGateway 레이블.** scrape 설정에 `honor_labels: true`가 없으면 잡별 `job`·`instance` 레이블이 덮어써진다.
- **Aspect·클라이언트 빈 누락.** HTTP 메트릭은 잡히는데 서비스 메서드 메트릭만 없다면 Aspect 빈 미등록을 의심한다. HTTP 클라이언트는 `RestClient.Builder`·`WebClient.Builder` 빈으로 만들어야 계측된다.
- **비용과 노출 범위.** `percentiles-histogram`은 `histogram_quantile()`을 쓰는 메트릭에만 켜고, CloudWatch `batch-size`는 한도 20을 넘기지 않는다. `include: *`는 `env`·`heapdump`를 여는 셈이므로 관리 포트를 분리한다.

## 관련 글

- [Meter 타입·태그·카디널리티](/notes/observability/meter-types-tags-cardinality/)
- [Timer·percentile·histogram·SLO](/notes/observability/timer-percentile-slo/)
- [Prometheus와 PromQL](/notes/observability/prometheus-promql/)
