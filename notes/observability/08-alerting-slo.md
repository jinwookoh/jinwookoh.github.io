---
title: "Alerting·Notification·SLO"
series: observability
part: "시각화와 알림"
order: 8
summary: "알림은 임계값이 아니라 SLO의 error budget 소진 속도로 설계해야 호출 피로 없이 실제 장애를 잡는다."
tags: [Grafana, Alerting, SLO, Alertmanager, Prometheus]
sources: [grafana/2026-05-18-grafana-alerting-slo.md]
updated: 2026-08-30
---

아무도 대시보드를 보지 않는 시간대에는 알림이 유일한 감지 수단인데, 알림 설계는 두 방향으로 실패한다. CPU 80% 같은 자원 임계값을 전부 page로 걸면 사용자 영향이 없는 상황에도 호출이 반복되고, 팀은 알림 채널을 무시해 실제 사고를 늦게 감지한다. 반대로 silence를 영구로 걸어 두면 장애가 조용히 지나간다. 이를 피하려면 알림을 SLO 기준으로 정의하고, 라우팅과 억제 규칙으로 통지량을 통제해야 한다.

## 핵심 개념

Grafana의 alert rule은 Query, Condition, Evaluation Interval, For, Labels, Annotations의 조합이다. 평가 주기마다 조건을 판정하고, 참인 상태가 `for` 시간 이상 지속되어야 firing으로 전환된다. `sum by (service)` 처럼 그룹핑된 쿼리는 label 조합마다 별도 alert 인스턴스를 만든다(multi-dimensional alert). Labels는 라우팅 키이므로 `severity`, `team`, `service`, `environment`를 모든 rule에 붙이고, Annotations에는 요약과 runbook 위치를 넣는다. 엔진은 datasource를 가리지 않는 Grafana-managed alert가 기본이고, Alertmanager나 Loki Ruler가 평가하는 datasource-managed alert는 기존 rule 자산이 있을 때 유지한다.

통지 계층은 Contact Point(Slack, PagerDuty, Webhook 같은 수신 채널)와 Notification Policy(label matcher로 alert를 Contact Point에 배정하는 트리)로 나뉜다. 루트 정책이 기본 receiver와 그룹핑 설정을 가지며, 자식 정책이 `severity = critical` 같은 matcher로 분기한다. ==`continue: true`는 매칭 후에도 형제 정책 평가를 계속해 critical을 PagerDuty와 Slack에 동시에 보낼 때 쓴다.== `group_by`는 한 통지로 묶을 label 집합, `group_wait`는 첫 alert 후 추가 alert를 모으는 대기 시간, `repeat_interval`은 미해결 alert의 재통지 주기다.

| 억제 수단 | 기준 | 대표 용도 |
|:---|:---|:---|
| Silence | matcher + 만료 시각 | 배포, 점검, 수정 중인 known issue |
| Inhibition | 상위 alert가 firing 중인지 | ClusterDown 시 같은 cluster의 warning 차단 |
| Mute Timing | 시간대 | 주말·정기 점검 시간의 non-critical 차단 |

SLO 기반 알림은 SLI(성공률, p99 latency 같은 실측 지표), SLO(지표에 대한 목표, 예: 30일 성공률 99.9%), error budget(`1 - SLO`, 허용 실패량) 위에 선다. ==99.9%면 월 43.2분이 예산이다.== burn rate는 예산 소진 속도로, 1x는 정확히 30일에 다 쓰는 속도이고 14.4x는 약 2일에 소진한다. 단순 임계값과 달리 burn rate alert는 "이 속도면 N일 후 SLO를 위반한다"는 근거를 가진다.

multi-window burn rate는 긴 창과 짧은 창을 AND로 묶는다. 긴 창만 보면 감지가 늦고 짧은 창만 보면 일시 spike에 반응하므로 둘 다 높을 때만 firing한다.

| 대응 | Long | Short | Burn rate | 창당 예산 소비 |
|:---|:---|:---|:---|:---|
| Page | 1h | 5m | 14.4x | 2% |
| Page | 6h | 30m | 6x | 5% |
| Ticket | 24h | 2h | 1x | 10% |
| Ticket | 72h | 6h | 0.5x | 30% |

사용자 영향을 직접 측정하는 증상(symptom) alert만 page로 보내고, 디스크 90%처럼 영향을 예측하는 원인(cause) alert는 ticket으로 돌린다. page는 주당 5건 미만을 목표로 둔다.

## 코드

도메인 SLI의 원천이 되는 Timer에 SLO bucket을 걸어 `_bucket` 시계열을 노출한다.

```java
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.function.Supplier;

@Service
public class CheckoutService {

    private final Timer checkoutTimer;

    public CheckoutService(MeterRegistry registry) {
        this.checkoutTimer = Timer.builder("checkout.duration")
                .publishPercentileHistogram()
                .serviceLevelObjectives(Duration.ofMillis(200), Duration.ofMillis(500))
                .register(registry);
    }

    public <T> T timed(Supplier<T> action) {
        return checkoutTimer.record(action);
    }
}
```

Prometheus endpoint를 열고 라우팅용 공통 태그를 붙인다. 이 태그가 Notification Policy의 matcher 키가 된다.

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  metrics:
    tags:
      service: api
      team: backend
      environment: ${APP_ENV:dev}
```

99.9% SLO의 fast burn 규칙과 Notification Policy, inhibition이다. 예산 0.001에 burn rate를 곱한 값이 임계치이고, 테스트 환경은 트리 최상단에서 버린다.

```yaml
groups:
  - name: api_slo
    rules:
      - alert: ApiSloBurnFast
        expr: |
          (
            sum(rate(http_server_requests_seconds_count{service="api",status=~"5.."}[1h]))
            / sum(rate(http_server_requests_seconds_count{service="api"}[1h]))
          ) > (14.4 * 0.001)
          and
          (
            sum(rate(http_server_requests_seconds_count{service="api",status=~"5.."}[5m]))
            / sum(rate(http_server_requests_seconds_count{service="api"}[5m]))
          ) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: critical
          team: backend
          service: api
        annotations:
          summary: "API error budget burning at 14.4x"
          runbook_url: "wiki/runbooks/api-slo-burn"
---
route:
  receiver: slack-default
  group_by: [alertname, cluster, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: ['environment =~ "test|dev"']
      receiver: drop
    - matchers: ['severity = "critical"']
      receiver: pagerduty-oncall
      continue: true
      routes:
        - matchers: ['team = "backend"']
          receiver: slack-backend-critical
    - matchers: ['severity = "warning"', 'team = "backend"']
      receiver: slack-backend
    - matchers: ['severity = "info"']
      receiver: slack-info
      repeat_interval: 24h
      mute_time_intervals: [weekend]

inhibit_rules:
  - source_matchers: ['alertname = "ClusterDown"']
    target_matchers: ['severity = "warning"']
    equal: [cluster]

mute_time_intervals:
  - name: weekend
    time_intervals:
      - weekdays: ['saturday', 'sunday']
        location: 'Asia/Seoul'
```

## 실무에서 걸리는 지점

- `for: 0`으로 두면 일시 spike에 firing과 resolved가 반복되어 통지가 두 배로 늘어난다. 증상 alert는 2~5분, 원인 alert는 10~15분을 기본으로 잡는다.
- ==`group_by`에 `instance`까지 넣으면 인스턴스 100대의 같은 장애가 100건으로 쪼개진다.== `alertname, cluster, service`가 출발점이다.
- Silence에 만료 시각을 주지 않으면 점검이 끝난 뒤에도 alert가 묻힌다. 만료를 항상 명시하고 활성 silence 목록을 대시보드에 노출한다.
- staging 메트릭에 `environment` label이 없으면 production 라우트로 흘러들어 채널 신뢰도를 떨어뜨린다.
- 월 1회 false positive 비율, 5분 내 자동 resolve된 건, 가장 자주 울린 rule을 검토해 rule을 수정하거나 ticket으로 강등한다.

## 관련 글

- [Timer·percentile·histogram·SLO](/notes/observability/timer-percentile-slo/)
- [Prometheus와 PromQL](/notes/observability/prometheus-promql/)
- [Grafana Dashboard·Panel·Variable](/notes/observability/grafana-dashboards/)
