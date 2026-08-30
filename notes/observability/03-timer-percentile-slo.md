---
title: "Timer·percentile·histogram·SLO"
series: observability
part: "메트릭"
order: 3
summary: "평균 latency는 극단값을 숨기므로 histogram 버킷을 노출하고 Prometheus에서 percentile을 계산해야 다중 인스턴스에서도 정확하다"
tags: [Micrometer, Timer, percentile, histogram, SLO]
sources: [micrometer/2026-05-25-micrometer-timer-percentile.md]
updated: 2026-08-29
---

요청 100개 중 99개가 10ms에 끝나고 1개가 9,910ms 걸리면 평균은 108ms다. 대시보드에는 정상으로 보이지만 한 사용자는 10초를 기다렸다. latency는 비대칭 분포라 DB 락·GC·재시도로 튀는 소수의 값은 평균에 희석되고, "평균 응답 200ms 이내" 같은 SLO는 사용자 경험과 무관한 숫자가 된다. 반대로 인스턴스마다 p99를 따로 계산하면 전체 시스템의 p99를 합쳐 구할 방법이 없다. 어디서 percentile을 계산하고 무엇을 노출할지가 이 글의 주제다.

## 핵심 개념

Timer는 `record()` 한 번마다 count·totalTime·max를 갱신하고, Prometheus 포맷에서는 `_count`·`_sum`·`_max` 시계열로 나온다. max는 누적 최댓값이 아니라 최근 시간 창(기본 2분, `distributionStatisticExpiry`)의 최댓값이라 창이 회전하면 값이 바뀌므로 p100 대용으로 쓸 수 없다.

percentile은 특정 비율의 요청이 그 값 이하로 끝났음을 뜻하는 경계값이다. SLO는 "p99 < 500ms"처럼 percentile로 정의해야 꼬리 latency가 기준에 포함된다. Micrometer에서 percentile을 얻는 방식은 두 가지다.

| 항목 | `publishPercentiles` | `publishPercentileHistogram` |
|:---|:---|:---|
| 계산 위치 | 앱 내부(HdrHistogram 기반, 회전 시간 창) | Prometheus(`histogram_quantile`) |
| 노출 형태 | `{quantile="0.99"}` 게이지 | `_bucket{le="..."}` 누적 카운터 |
| 인스턴스 합산 | 불가 | 가능(버킷 카운트 합산) |
| 시계열 수 | percentile 개수만큼 | 버킷 개수만큼(수십 개) |
| 적합한 환경 | 단일 인스턴스·로컬 확인 | 다중 인스턴스 프로덕션 |

`publishPercentiles`는 이미 요약된 수치라 다른 인스턴스의 값과 합칠 수 없다. 인스턴스 3대의 p99가 100ms·200ms·900ms일 때 산술평균 400ms는 아무 분포의 p99도 아니다. 각 인스턴스가 "99번째 하나"만 남기면 전체 분포 정보가 사라지기 때문이다.

histogram은 이 문제를 버킷 카운트로 푼다. `le="0.01"` 버킷 값이 3841이면 10ms 이하 요청이 3841개라는 뜻이고, 이 카운트는 인스턴스 간에 더할 수 있다. Prometheus가 `le`별로 합산한 뒤 `histogram_quantile()`로 역산하면 전체 시스템의 p99가 나온다.

자동 생성 버킷 경계는 1ms·5ms·10ms·25ms·50ms·100ms·250ms처럼 로그 스케일이라 SLO 기준이 120ms이면 100ms와 250ms 사이에 끼어 정확한 비율을 구할 수 없다. `serviceLevelObjectives`는 지정한 값에 버킷 경계를 정확히 추가하며, `publishPercentileHistogram` 없이 단독으로도 `_bucket` 시계열을 만든다. `minimumExpectedValue`·`maximumExpectedValue`는 자동 생성 버킷의 범위만 제한하고 SLO 경계에는 영향을 주지 않는다.

## 코드

프로덕션 다중 인스턴스 기준 Timer 설정이다. client-side percentile은 켜지 않고 histogram과 SLO 경계만 노출한다.

```java
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.time.Duration;

@Service
public class OrderService {

    private final Timer processingTimer;

    public OrderService(MeterRegistry registry) {
        this.processingTimer = Timer.builder("orders.processing.time")
            .description("Order processing latency")
            .tag("type", "online")
            .publishPercentileHistogram()
            .serviceLevelObjectives(
                Duration.ofMillis(50),
                Duration.ofMillis(100),
                Duration.ofMillis(300),
                Duration.ofMillis(1000))
            .minimumExpectedValue(Duration.ofMillis(1))
            .maximumExpectedValue(Duration.ofSeconds(10))
            .register(registry);
    }

    public Order process(CreateOrderRequest request) {
        return processingTimer.record(() -> doProcess(request));
    }

    private Order doProcess(CreateOrderRequest request) {
        // 실제 처리
        return new Order();
    }
}
```

Spring Boot가 자동 등록하는 `http.server.requests` 같은 Timer는 설정으로 같은 옵션을 적용하며, 이름 prefix 단위로 매칭된다.

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
        orders: true
      slo:
        http.server.requests: 50ms,100ms,300ms,1s
      minimum-expected-value:
        http.server.requests: 1ms
      maximum-expected-value:
        http.server.requests: 10s
```

Prometheus 쪽에서는 `sum by (le)`로 인스턴스를 합산한 뒤 분위수를 계산하고, SLO 위반율은 SLO 경계 버킷과 `_count`의 비율로 구한다.

```promql
histogram_quantile(0.99,
  sum(rate(orders_processing_time_seconds_bucket[5m])) by (le)
)

1 - (
  sum(rate(orders_processing_time_seconds_bucket{le="0.1"}[5m]))
  /
  sum(rate(orders_processing_time_seconds_count[5m]))
)
```

## 실무에서 걸리는 지점

- **quantile 시계열을 `avg()`로 합산.** `{quantile="0.99"}` 값을 Grafana에서 인스턴스 평균으로 묶는 사례가 가장 흔하다. 의미 없는 수치이므로 `publishPercentileHistogram()`으로 바꾸고 `histogram_quantile`로 계산한다.
- **`_bucket` 없이 `histogram_quantile` 쿼리.** `publishPercentiles`만 켜면 `quantile` 레이블 시계열만 생기고 `_bucket`은 없다. 쿼리 결과가 비어 있으면 `/actuator/prometheus` 응답에서 `_bucket` 존재부터 확인한다.
- **버킷 수 폭증.** Timer 하나가 수십 개의 `_bucket` 시계열을 만들고 태그 조합 수와 곱으로 늘어난다. `minimumExpectedValue`·`maximumExpectedValue`로 실제 latency 범위에 맞게 자동 버킷을 줄인다.
- **`max`를 최악 latency로 해석.** `_max`는 회전 시간 창의 최댓값이라 창이 넘어가면 떨어진다. 꼬리 추적은 p99·p99.9로 하고, 최근 구간 변화는 `rate()`를 씌운 histogram으로 본다.
- **`@Timed`의 한계.** `@Timed(histogram = true)`는 Spring Boot 3.x에서 `TimedAspect` 빈을 직접 등록해야 동작하고 min/max expected value를 지정할 수 없다. 세밀한 설정은 빌더나 `management.metrics.distribution.*` 프로퍼티로 옮긴다.

## 관련 글

- [Meter 타입·태그·카디널리티](/notes/observability/meter-types-tags-cardinality/)
- [Prometheus와 PromQL](/notes/observability/prometheus-promql/)
- [Alerting·Notification·SLO](/notes/observability/alerting-slo/)
