---
title: "Grafana Dashboard·Panel·Variable"
series: observability
part: "시각화와 알림"
order: 7
summary: "Panel 선택·Variable 체인·Transformation·Annotation 자동화로 운영 가능한 Grafana 대시보드를 구성하는 기준을 정리한다"
tags: [Grafana, Dashboard, Variable, Annotation, Library Panel]
sources: [grafana/2026-05-18-grafana-dashboards-panels.md]
updated: 2026-08-30
---

메트릭·로그·트레이스를 수집해 두어도 PromQL을 직접 작성하는 사람만 볼 수 있다면 관측 데이터는 팀 자산이 되지 못한다. 장애 때마다 쿼리를 새로 짜고, 지표가 튄 시각과 배포 시각을 대조하려고 CI 로그를 따로 뒤지게 된다. ==같은 데이터라도 어떤 panel과 변수로 보여주느냐에 따라 사용성과 신뢰도가 갈린다.== Grafana의 Dashboard·Panel·Variable은 이 표현 계층을 담당한다.

## 핵심 개념

### Panel

Panel은 쿼리 결과 하나를 시각화 하나로 표현하는 단위다. 시계열(Time series·Bar chart·Histogram·Heatmap·State timeline), 단일 값(Stat·Gauge·Bar gauge·Pie chart), 표·텍스트(Table·Logs·Text), 특수(Traces·Geomap·Node graph·Canvas·Alert list)로 나뉜다. 시계열 지표는 Time series, 단일 KPI는 Stat, 지연 시간 분포는 Heatmap, 상태 전이는 State timeline, 의존 관계는 Node graph를 고른다. 운영 대시보드의 대부분은 Time series·Stat·Table로 구성된다.

### Variable

Variable은 드롭다운으로 고른 값을 모든 panel의 쿼리에 주입한다. type은 Query(datasource 질의, `label_values(up, instance)`), Custom(고정 목록), Constant(URL 비노출), Data source, Interval(`$__interval` 후보), Ad hoc filter(전 panel에 label 필터), Text box 일곱 가지다.

앞 변수의 선택값이 뒤 변수의 query에 들어가는 구조가 cascading이다. environment → cluster → namespace → pod 순서로 좁혀야 의미 있는 범위만 조회된다. Multi-value나 Include All 변수는 `=~` 매처로 받고, `${var:regex}`, `${var:csv}`, `${var:json}` 같은 format modifier로 치환 형식을 지정한다.

### Transformation

쿼리 결과와 시각화 사이에서 데이터를 가공한다. Join by field로 Prometheus의 RPS와 Loki의 에러율을 service 기준으로 합치거나, Add field from calculation으로 계산 열을 만들거나, Organize fields로 열을 정리한다. datasource에서 처리 가능한 연산은 PromQL·SQL로 끝내고 transformation은 마지막 단계로만 쓴다.

### Annotation

Time series 위에 세로선으로 이벤트를 표시한다. built-in은 alert 상태 변화를 표시하고, annotation query는 datasource 쿼리 결과를 그리며(Loki의 `{app="ci-deploy"} | json | event="deploy_completed"`), manual은 UI에서 입력한다. ==CI가 배포 직후 `/api/annotations`에 POST하면 지표 급등이 배포 때문인지 즉시 확인된다.==

### Library Panel, Dashboard JSON, 권한

Library panel은 panel 하나를 여러 대시보드에서 참조하며, 한 곳을 수정하면 모두 반영된다. 대시보드 정의는 JSON이고 UI, grafana.com ID, `POST /api/dashboards/db`로 import한다. Grafonnet이나 Terraform provider로 코드화하면 Git 이력과 PR 리뷰를 얻는다. 권한은 Organization → Folder → Dashboard 세 계층에 Admin·Editor·Viewer role을 Team 단위로 부여한다. Public dashboard는 인증 없는 공개 URL이다.

## 코드

cascading variable 두 개와 Time series panel 하나를 가진 최소 Dashboard JSON이다.

```json
{
  "title": "Service Dashboard",
  "time": { "from": "now-1h", "to": "now" },
  "templating": {
    "list": [
      { "name": "environment", "type": "custom", "query": "dev,staging,prod" },
      { "name": "service", "type": "query", "datasource": "Prometheus",
        "query": "label_values(http_server_requests_seconds_count{env=\"$environment\"}, service)",
        "multi": true, "includeAll": true }
    ]
  },
  "panels": [
    {
      "id": 1, "type": "timeseries", "title": "RPS by service",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "datasource": "Prometheus",
      "targets": [{ "expr": "sum by (service) (rate(http_server_requests_seconds_count{env=\"$environment\", service=~\"${service:regex}\"}[$__rate_interval]))" }]
    }
  ]
}
```

Spring Boot 3.x 애플리케이션이 기동 완료 시점에 `RestClient`로 배포 annotation을 남기는 예다.

```java
@Component
public class DeployAnnotationPublisher {

    private final RestClient client;
    private final String version;

    public DeployAnnotationPublisher(RestClient.Builder builder,
                                     @Value("${grafana.url}") String url,
                                     @Value("${grafana.token}") String token,
                                     BuildProperties build) {
        this.client = builder.baseUrl(url)
                .defaultHeader("Authorization", "Bearer " + token)
                .build();
        this.version = build.getVersion();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void publish() {
        client.post().uri("/api/annotations")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "tags", List.of("deploy", "production"),
                        "text", "Deploy " + version,
                        "time", Instant.now().toEpochMilli()))
                .retrieve()
                .toBodilessEntity();
    }
}
```

에러율을 PromQL로 계산한 Stat 쿼리다.

```promql
sum(rate(http_server_requests_seconds_count{env="$environment", service=~"${service:regex}", status=~"5.."}[$__rate_interval]))
/
sum(rate(http_server_requests_seconds_count{env="$environment", service=~"${service:regex}"}[$__rate_interval]))
* 100
```

## 실무에서 걸리는 지점

- **panel 과다.** 30개 넘는 panel은 로딩이 느리고 읽히지 않는다. Overview·Service·Cluster·Business로 독자별 분리한다.
- ==**기본 시간 범위.** last 30 days로 저장하면 열 때마다 모든 panel이 30일을 스캔한다.== 기본은 last 1 hour로 두고, chain 없이 전체 service를 조회하는 쿼리도 피한다.
- **공개 대시보드 무수정 사용.** Node Exporter Full(1860) 같은 대시보드는 metric 이름이 달라 panel이 비기 쉽다. Spring Boot용 대시보드도 Boot 2 이름을 쓰는 경우가 있어 Boot 3의 `http_server_requests_seconds_*`에 맞춰 고친다.
- **Public dashboard 정보 유출.** 링크를 아는 누구나 접근한다. 개인정보 label이나 내부 지표 panel은 분리한 뒤 공개한다.
- **복사·붙여넣기와 JSON 손편집.** panel 복사는 drift를, JSON 직접 수정은 import 실패를 만든다. 표준 panel은 Library panel로, 정의는 Grafonnet·Terraform으로 관리한다. Annotation은 배포·incident·feature flag만 남긴다.

## 관련 글

- [Prometheus와 PromQL](/notes/observability/prometheus-promql/)
- [Loki·LogQL과 Tempo·TraceQL](/notes/observability/loki-tempo/)
- [Alerting·Notification·SLO](/notes/observability/alerting-slo/)
