---
title: "집계 — Pipeline"
series: elasticsearch
part: "집계와 고급 검색"
order: 13
summary: "Metric·Bucket 집계 결과 위에 변화량·이동 평균·누적·필터·정렬을 한 요청 안에서 얹는 방법과 buckets_path 규칙"
tags: [Elasticsearch, Pipeline Aggregations, derivative, moving_fn, bucket_selector]
sources: [elasticsearch/2026-05-19-elasticsearch-aggregations-pipeline.md]
updated: 2026-08-29
---

Metric과 Bucket 집계만으로 일별 매출 합 같은 1차 통계는 구할 수 있다. 그러나 운영 화면이 요구하는 숫자는 대개 1차 통계의 변화다. 전일 대비 증감, 7일 이동 평균, 누적 가입자, 매출 상위 10개 카테고리는 응답을 받은 뒤 애플리케이션 코드에서 다시 계산해야 했다. 이 후처리를 Elasticsearch 안으로 끌어들여 한 요청에서 끝내는 것이 Pipeline Aggregation이다.

## 핵심 개념

Pipeline 집계는 문서를 직접 읽지 않는다. 이미 계산된 다른 집계의 결과를 입력으로 받아 한 번 더 가공하는 후처리 노드다. 그래서 모든 pipeline 집계의 공통 파라미터가 `buckets_path`이며, 어느 집계 결과를 입력으로 쓸지 가리키는 경로 문자열이다. `>`가 경로 구분자로, `sales_per_day>daily_revenue`는 `sales_per_day` 안의 `daily_revenue`를 뜻한다.

어디에 매달려 무엇을 보느냐에 따라 두 종류로 나뉜다.

| 분류 | 위치 | 입력 | 출력 | 대표 집계 |
|---|---|---|---|---|
| Parent | 부모 집계 안 | 부모의 각 버킷 | 각 버킷에 새 값 추가 | derivative, moving_fn, cumulative_sum, serial_diff, bucket_script, bucket_selector, bucket_sort |
| Sibling | 부모 집계 옆 | 부모의 전체 버킷 | 새 결과 한 개 | avg_bucket, sum_bucket, stats_bucket, extended_stats_bucket, percentiles_bucket |

Parent는 버킷마다 값을 하나씩 만들고, Sibling은 전체 버킷을 요약한 값 하나를 만든다.

- `derivative`: 직전 버킷과의 차이. 첫 버킷에는 비교 대상이 없어 값이 생략된다. `unit`을 주면 단위 시간당 변화량으로 환산한다.
- `serial_diff`: `lag`만큼 떨어진 버킷과의 차이. 7이면 주간, 30이면 월간 비교다. 기본값 1은 derivative와 같으므로 lag를 명시한다.
- `moving_fn`: 최근 `window`개 버킷 위에서 Painless 스크립트를 실행한다. `MovingFunctions` 헬퍼로 `unweightedAvg`, `ewma`, `holt`, `holtWinters`, `stdDev` 등을 제공한다. 과거의 `moving_avg`는 deprecated되었고 8.x에서는 `moving_fn`만 사용한다.
- `cumulative_sum`·`cumulative_cardinality`: 해당 버킷까지의 누적 합과 누적 unique 수. 누적 cardinality 위에 derivative를 얹으면 그날 처음 등장한 신규 사용자 수가 된다.
- `bucket_script`: 버킷 안의 여러 metric을 map 형태 `buckets_path`로 받아 `params.이름`으로 계산식을 실행한다. 비율 계산에 쓴다.
- `bucket_selector`: 조건을 만족하는 버킷만 남긴다. SQL의 HAVING에 해당한다.
- `bucket_sort`: 버킷을 정렬하고 `from`·`size`로 잘라낸다. terms의 `order`와 달리 복합 정렬이 된다.
- `stats_bucket`·`extended_stats_bucket`·`percentiles_bucket`: 전체 버킷 값의 분포를 sibling으로 요약한다. extended는 `sigma` 기준 `std_deviation_bounds`를 포함한다.

## 코드

일별 매출 위에 전일 대비 변화량, 7일 이동 평균, 주간 비교, 누적 합을 한 요청에 얹고 sibling으로 전체 평균과 분포를 받는 예제다.

```json
GET /orders/_search
{
  "size": 0,
  "aggs": {
    "sales_per_day": {
      "date_histogram": { "field": "ordered_at", "calendar_interval": "day" },
      "aggs": {
        "daily_revenue": { "sum": { "field": "amount" } },
        "revenue_delta": { "derivative": { "buckets_path": "daily_revenue" } },
        "wow_change": { "serial_diff": { "buckets_path": "daily_revenue", "lag": 7 } },
        "ma_7d": {
          "moving_fn": {
            "buckets_path": "daily_revenue",
            "window": 7,
            "script": "MovingFunctions.unweightedAvg(values)"
          }
        },
        "running_total": { "cumulative_sum": { "buckets_path": "daily_revenue" } }
      }
    },
    "avg_daily_revenue": { "avg_bucket": { "buckets_path": "sales_per_day>daily_revenue" } },
    "daily_revenue_bounds": {
      "extended_stats_bucket": { "buckets_path": "sales_per_day>daily_revenue", "sigma": 2 }
    }
  }
}
```

카테고리별 이익률을 계산하고, 매출 5천만 원 이상인 버킷만 남긴 뒤 이익률 상위 10개를 돌려주는 예제다. terms의 `size`를 키워 selector 전에 버킷이 잘리지 않게 한다.

```json
GET /orders/_search
{
  "size": 0,
  "aggs": {
    "categories": {
      "terms": { "field": "category", "size": 1000 },
      "aggs": {
        "total_revenue": { "sum": { "field": "amount" } },
        "total_cost": { "sum": { "field": "cost" } },
        "profit_margin": {
          "bucket_script": {
            "buckets_path": { "rev": "total_revenue", "cost": "total_cost" },
            "script": "(params.rev - params.cost) / params.rev * 100"
          }
        },
        "min_50m": {
          "bucket_selector": {
            "buckets_path": { "rev": "total_revenue" },
            "script": "params.rev > 50000000"
          }
        },
        "top10": {
          "bucket_sort": { "sort": [{ "profit_margin": { "order": "desc" } }], "size": 10 }
        }
      }
    }
  }
}
```

Spring Boot 3.x에서 Elasticsearch Java API Client로 첫 번째 요청을 구성하고 각 버킷의 값을 꺼내는 코드다. pipeline 값이 없는 첫 버킷은 `null` 처리한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.aggregations.Aggregate;
import co.elastic.clients.elasticsearch._types.aggregations.CalendarInterval;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;
import java.util.Map;

@Service
public class DailyRevenueService {

    private static final String DAILY_REVENUE = "daily_revenue";
    private static final String REVENUE_DELTA = "revenue_delta";
    private static final String MA_7D = "ma_7d";

    private final ElasticsearchClient client;

    public DailyRevenueService(ElasticsearchClient client) {
        this.client = client;
    }

    public record DailyPoint(String day, double revenue, Double delta, Double movingAvg) {}

    public List<DailyPoint> dailyRevenue() throws IOException {
        SearchResponse<Void> res = client.search(s -> s
                .index("orders")
                .size(0)
                .aggregations("sales_per_day", a -> a
                        .dateHistogram(h -> h.field("ordered_at").calendarInterval(CalendarInterval.Day))
                        .aggregations(DAILY_REVENUE, m -> m.sum(v -> v.field("amount")))
                        .aggregations(REVENUE_DELTA, d -> d.derivative(p -> p.bucketsPath(b -> b.single(DAILY_REVENUE))))
                        .aggregations(MA_7D, f -> f.movingFn(p -> p
                                .bucketsPath(b -> b.single(DAILY_REVENUE))
                                .window(7)
                                .script("MovingFunctions.unweightedAvg(values)")))),
                Void.class);

        return res.aggregations().get("sales_per_day").dateHistogram().buckets().array().stream()
                .map(b -> {
                    Map<String, Aggregate> aggs = b.aggregations();
                    double revenue = aggs.get(DAILY_REVENUE).sum().value();
                    Double delta = aggs.containsKey(REVENUE_DELTA) ? aggs.get(REVENUE_DELTA).derivative().value() : null;
                    Double ma = aggs.containsKey(MA_7D) ? aggs.get(MA_7D).simpleValue().value() : null;
                    return new DailyPoint(b.keyAsString(), revenue, delta, ma);
                })
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- `buckets_path` 오타는 400 에러로 잡히지 않는다. 잘못된 경로는 빈 결과나 NaN으로 돌아온다. 경로와 metric 이름을 상수로 관리하고 Kibana Dev Tools에서 먼저 확인한다.
- `bucket_selector`는 terms가 `size`만큼 버킷을 확정한 뒤에 동작한다. 상위 10개 안에 없던 조건 충족 버킷은 이미 잘려 있으므로 size를 전체 개수에 가깝게 키운다. terms의 `order`에 pipeline 결과를 넣는 것도 동작하지 않으며, 정렬은 `bucket_sort`로 분리한다.
- `bucket_script`는 버킷 수만큼 스크립트를 실행한다. 식이 복잡하면 집계 본체보다 스크립트 비용이 커지므로 식을 단순하게 유지하고 selector로 버킷을 먼저 줄인다.
- `percentiles_bucket`은 입력 버킷 수가 표본 크기다. 7개 버킷의 p99는 통계적으로 의미가 없고, 최소 30~50개 버킷 이상에서만 쓴다.
- pipeline 집계는 데이터 노드에 분산되지 않고 coordinator 노드에 모인 결과 위에서 실행된다. `cumulative_cardinality`는 버킷마다 HyperLogLog 상태를 유지해 부담이 더 크다. 버킷이 수만 단위로 늘어나면 selector로 미리 자르거나 pipeline을 빼고 클라이언트에서 계산한다.

## 관련 글

- [집계 — Metric·Bucket](/notes/elasticsearch/aggregations-metric-bucket/)
- [성능 튜닝](/notes/elasticsearch/performance-tuning/)
- [Kibana·Elastic Cloud·OpenSearch·IaC](/notes/elasticsearch/kibana-cloud-opensearch-iac/)
