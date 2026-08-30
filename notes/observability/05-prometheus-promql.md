---
title: "Prometheus와 PromQL"
series: observability
part: "수집과 저장"
order: 5
summary: "Prometheus가 pull·label·TSDB로 메트릭을 쌓는 원리와 rate·histogram_quantile 중심 PromQL 작성법"
tags: [Prometheus, PromQL, Recording Rule, Alertmanager, Cardinality]
sources: [grafana/2026-05-18-grafana-prometheus-promql.md]
updated: 2026-08-30
---

애플리케이션이 Micrometer로 메트릭을 노출해도, 그 값을 주기적으로 수집해 시간축으로 저장하고 질의할 저장소가 없으면 "지금 p99가 얼마인가", "지난 1시간 에러율이 올랐는가"에 답할 수 없다. Prometheus는 이 자리를 채우는 시계열 데이터베이스이자 질의 엔진이며, Grafana가 가장 흔하게 연결하는 datasource다.

## 핵심 개념

Prometheus의 첫 설계 결정은 pull 모델이다. Prometheus가 각 서비스의 `/metrics` 엔드포인트를 일정 주기(scrape_interval, 보통 15~30초)로 호출하며, scrape 실패 자체가 `up == 0`이라는 신호가 되어 별도 health check 없이 인스턴스 다운을 감지한다. 예외는 scrape 주기보다 짧게 살다 끝나는 배치 작업이며, 이 경우에만 Pushgateway를 경유한다.

scrape 대상은 정적 목록 대신 Service Discovery(Kubernetes·Consul·EC2·DNS·파일)로 찾고, 무엇을 수집하고 라벨을 어떻게 붙일지는 `relabel_configs`가 결정한다. Prometheus 형식을 내지 않는 시스템은 node_exporter, jmx_exporter, blackbox_exporter 같은 exporter가 번역하고, 애플리케이션은 Micrometer로 직접 노출한다.

메트릭 이름과 라벨 집합의 조합 하나가 시계열 하나이고, 각 시계열은 (timestamp, value) 샘플의 나열이다. 타입은 Counter(단조 증가), Gauge(자유 변동), Histogram(bucket별 누적 카운트), Summary(클라이언트에서 quantile 계산) 네 가지이며, Summary는 인스턴스 간 합산이 불가능하므로 대부분 Histogram을 쓴다.

라벨 조합의 가짓수가 곧 시계열 수이며 이것이 cardinality다. user_id나 정규화되지 않은 URL(`/products/12345`)을 라벨로 넣으면 시계열이 수백만 개로 불어나 메모리가 고갈된다. 라벨 값은 method, status, route(`/products/{id}`)처럼 유한한 집합으로 제한한다.

PromQL에서 `http_requests_total`은 현재 시점의 값 집합(instant vector), `http_requests_total[5m]`은 지난 5분의 샘플 집합(range vector)이다. Counter는 원값 대신 `rate()`(구간 평균 초당 증가율), `irate()`(마지막 두 샘플 기준), `increase()`(구간 누적 증가량)로 읽으며, 이 함수들은 리셋을 보정한다. Histogram의 분위수는 bucket별 rate를 `le`로 합친 뒤 `histogram_quantile`에 넘긴다. 집계는 `sum`·`avg`·`max`·`topk`에 `by`·`without`을 붙이고, 두 벡터의 연산은 `on`·`ignoring`·`group_left`로 라벨을 맞춘다. subquery `[1h:1m]`은 내부 식을 1분 간격으로 재평가한 임시 시계열을 만든다.

자주 쓰는 무거운 식은 Recording Rule로 미리 계산해 `level:metric:operation` 이름의 새 메트릭으로 저장한다. Alert 평가는 Prometheus가 하고, grouping·routing·silence·inhibition·통보는 Alertmanager가 맡는다.

## 코드

Spring Boot 3.x 애플리케이션이 Prometheus 형식으로 메트릭을 노출하도록 Actuator 엔드포인트를 여는 설정이다.

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health, prometheus
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 100ms, 250ms, 500ms, 1s
```

위 애플리케이션을 scrape하고 rule 파일을 읽는 Prometheus 설정이다. `metrics_path`를 Actuator 경로로 바꿔야 한다.

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 30s

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: 'order-api'
    metrics_path: /actuator/prometheus
    static_configs:
      - targets: ['order-api-1:8080', 'order-api-2:8080']
```

Micrometer가 내는 `http_server_requests_seconds` 히스토그램으로 p99와 5xx 비율을 사전 계산하고, 그 결과로 alert를 거는 rule 파일이다.

```yaml
# /etc/prometheus/rules/order-api.yml
groups:
  - name: order_api_recording
    interval: 30s
    rules:
      - record: job:http_server_requests_p99:rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (le, job) (rate(http_server_requests_seconds_bucket[5m]))
          )
      - record: job:http_server_error_ratio:rate5m
        expr: |
          sum by (job) (rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
          /
          sum by (job) (rate(http_server_requests_seconds_count[5m]))

  - name: order_api_alerts
    rules:
      - alert: HighErrorRatio
        expr: job:http_server_error_ratio:rate5m > 0.05
        for: 5m
        labels:
          severity: critical
          team: backend
        annotations:
          summary: "5xx ratio above 5% on {{ $labels.job }}"
          description: "current: {{ $value | humanizePercentage }}"
      - alert: HighP99Latency
        expr: job:http_server_requests_p99:rate5m > 1
        for: 10m
        labels:
          severity: warning
          team: backend
```

## 실무에서 걸리는 지점

- Cardinality 폭발이 가장 흔한 장애 원인이다. 직접 등록한 태그에 원시 경로나 사용자 ID가 섞이면 시계열이 급증하므로 `count by (__name__) ({__name__=~".+"})`로 상위 메트릭을 주기적으로 확인한다.
- rate 윈도가 scrape_interval에 비해 짧으면 구간 안에 샘플이 1~2개뿐이라 값이 튄다. ==15초 scrape에 `[1m]`이 하한이고 대시보드 기본값은 `[5m]`이 안전하다.== 반대로 scrape_interval을 1~5초로 줄이면 저장 용량과 CPU가 비례해서 늘어난다.
- ==Histogram bucket이 기대 지연 분포와 맞지 않으면 `histogram_quantile`은 bucket 경계 사이를 선형 보간한 값을 돌려주므로 결과가 실제와 어긋난다.== Micrometer의 `slo` 설정으로 관심 구간 경계를 추가한다.
- Recording Rule interval을 scrape_interval보다 짧게 잡으면 평가 자체가 부하가 된다. 30초~1분을 기본으로 두고 raw → job 집계 → 비즈니스 지표의 계층으로 정리한다.
- ==단일 Prometheus는 retention(기본 15일)에 묶여 장기 추세를 볼 수 없으므로 Thanos나 Mimir로 remote write를 건다.== Alert는 `for` 없이 걸면 flap마다 발화하므로 5~15분의 지속 조건을 두고, severity·team별로 receiver를 나누지 않으면 한 채널에 몰린 알림이 곧 무시된다.

## 관련 글

- [Meter 타입·태그·카디널리티](/notes/observability/meter-types-tags-cardinality/)
- [Timer·percentile·histogram·SLO](/notes/observability/timer-percentile-slo/)
- [Registry·push vs pull·Actuator 연동](/notes/observability/registry-backends-actuator/)
