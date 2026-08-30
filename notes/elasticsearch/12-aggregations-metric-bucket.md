---
title: "집계 — Metric·Bucket"
series: elasticsearch
part: "집계와 고급 검색"
order: 12
summary: "Metric은 숫자 하나를 계산하고 Bucket은 문서를 묶는다. 근사값 집계와 size·time_zone 함정을 정리한다."
tags: [Elasticsearch, Aggregations, terms, percentiles, cardinality]
sources: [elasticsearch/2026-05-19-elasticsearch-aggregations-metric.md, elasticsearch/2026-05-19-elasticsearch-aggregations-bucket.md, 2026-05-03-es-aggregations.md]
updated: 2026-08-29
---

검색 엔진의 본업은 조건에 맞는 문서를 돌려주는 것이다. 그런데 전자상거래·로그·관측 화면에서 자주 필요한 값은 카테고리별 평균 가격, 일별 4xx 비율, p95 응답 시간 같은 숫자 요약이다. 검색 결과를 전부 끌어와 애플리케이션에서 계산하면 네트워크와 힙이 먼저 바닥나고, 별도 OLAP으로 복제하면 정합성 관리가 늘어난다. Aggregations는 한 요청 안에서 검색 hits와 집계 결과를 함께 돌려준다.

## 핵심 개념

집계는 Doc Values라는 컬럼 지향 자료구조 위에서 동작한다. 각 샤드가 부분 집계를 만들고 코디네이터 노드가 병합하는 분산 구조이며, 이 구조가 정확도 함정의 근원이다. 집계는 세 종류로 나뉜다.

| 분류 | 역할 | 대표 집계 |
|---|---|---|
| Metric | 숫자 하나를 계산 | sum·avg·min·max·stats·percentiles·cardinality |
| Bucket | 문서를 그룹으로 묶음 | terms·histogram·date_histogram·range·filters·composite·nested |
| Pipeline | 다른 집계 결과를 후처리 | avg_bucket·derivative·moving_fn |

Bucket 안에 `aggs`로 Metric을 넣으면 SQL의 `GROUP BY` + 집계 함수와 같고, 다단 중첩은 다중 `GROUP BY`에 해당한다. 집계만 필요한 요청은 `size: 0`으로 hits를 비운다.

**Metric 집계.** `sum·avg·min·max`는 정확한 값이고, `value_count`는 필드에 값이 있는 문서 수만 센다. 필드가 없는 문서는 무시되며 `missing`으로 대체값을 줄 수 있다. 같은 필드의 여러 통계는 `stats` 또는 `extended_stats`(분산·표준편차 추가) 한 번으로 묶는다. `percentiles`는 T-Digest 근사 알고리즘을 쓰며 `tdigest.compression`(기본 100)이 정확도와 메모리를 좌우한다. 중앙 구간은 정확하지만 p99.9 이상 꼬리는 오차가 커진다. `percentile_ranks`는 값을 주면 분위를 돌려주므로 SLO 준수율 질문에 직접 대응한다. `cardinality`는 HyperLogLog++ 기반 근사 고유값 수로, `precision_threshold`(기본 3,000, 최대 40,000) 이하에서는 거의 정확하다. `top_hits`는 버킷 안 대표 문서를 통째로, `top_metrics`는 지정 필드만 꺼낸다.

**Bucket 집계.** `terms`는 keyword·numeric·boolean 값별로 묶는다. text 필드는 토큰 단위로 묶이므로 keyword multi-field를 쓴다. `size` 기본값은 10이고, 각 샤드는 `shard_size`(기본 `size * 1.5 + 10`)만큼만 후보를 올리므로 고카디널리티 필드에서는 상위 N이 어긋날 수 있다. 응답의 `doc_count_error_upper_bound`가 오차 상한이다. `histogram`은 숫자를 균등 `interval`로, `date_histogram`은 날짜를 `fixed_interval`(항상 같은 길이) 또는 `calendar_interval`(달력 기준) 중 하나로 묶는다. `range`는 구간을 직접 지정하며 `from`은 포함, `to`는 미포함이다. `filters`는 임의 쿼리마다 버킷 하나를 만든다. `composite`는 여러 source를 조합한 키로 버킷을 만들고 `after_key`로 페이징하며, 정렬은 `_key` 기준만 가능하다. nested 필드는 `nested` 집계로 경계를 넘어야 라인 아이템 단위로 집계되고, 부모 단위로 돌아오려면 `reverse_nested`를 쓴다.

## 코드

Elasticsearch Java API Client로 카테고리별 매출 합계를 매출 순으로 받는 예제다.

```java
@Service
public class CategoryRevenueService {

    private final ElasticsearchClient client;

    public CategoryRevenueService(ElasticsearchClient client) {
        this.client = client;
    }

    public Map<String, Double> revenueByCategory() throws IOException {
        SearchResponse<Void> res = client.search(s -> s
                .index("orders")
                .size(0)
                .aggregations("by_category", a -> a
                        .terms(t -> t
                                .field("category")
                                .size(20)
                                .shardSize(200)
                                .order(NamedValue.of("total_revenue", SortOrder.Desc)))
                        .aggregations("total_revenue", sub -> sub
                                .sum(m -> m.field("amount")))),
                Void.class);

        Map<String, Double> result = new LinkedHashMap<>();
        for (StringTermsBucket b : res.aggregations()
                .get("by_category").sterms().buckets().array()) {
            result.put(b.key().stringValue(),
                    b.aggregations().get("total_revenue").sum().value());
        }
        return result;
    }
}
```

일별 버킷마다 p95·p99 응답 시간과 근사 고유 사용자 수를 함께 계산하는 예제다.

```java
public record DailyLatency(String day, double p95, double p99, long users) {}

public List<DailyLatency> dailyLatency() throws IOException {
    SearchResponse<Void> res = client.search(s -> s
            .index("access-logs-*")
            .size(0)
            .query(q -> q.range(r -> r.date(d -> d
                    .field("@timestamp").gte("now-7d/d").lt("now/d"))))
            .aggregations("per_day", a -> a
                    .dateHistogram(h -> h
                            .field("@timestamp")
                            .calendarInterval(CalendarInterval.Day)
                            .timeZone("Asia/Seoul")
                            .format("yyyy-MM-dd")
                            .minDocCount(1))
                    .aggregations("latency", sub -> sub
                            .percentiles(p -> p
                                    .field("response_time_ms")
                                    .percents(95.0, 99.0)
                                    .tdigest(t -> t.compression(200))))
                    .aggregations("users", sub -> sub
                            .cardinality(c -> c
                                    .field("user_id")
                                    .precisionThreshold(40000)))),
            Void.class);

    return res.aggregations().get("per_day").dateHistogram().buckets().array()
            .stream()
            .map(b -> new DailyLatency(
                    b.keyAsString(),
                    b.aggregations().get("latency").tdigestPercentiles()
                            .values().keyed().get("95.0").doubleValue(),
                    b.aggregations().get("latency").tdigestPercentiles()
                            .values().keyed().get("99.0").doubleValue(),
                    b.aggregations().get("users").cardinality().value()))
            .toList();
}
```

## 실무에서 걸리는 지점

- **근사값을 정확값으로 오인.** `cardinality`와 `percentiles`는 근사값이다. 광고 인보이스나 재무 보고처럼 정확성이 계약 조건인 자리는 원본을 별도 저장소에서 계산하고, 대시보드 라벨에 근사값임을 표기한다.
- **terms `size` 기본값 10과 고카디널리티.** `size`를 빼먹으면 상위 10개만 오고 나머지는 `sum_other_doc_count`로 합산된다. 반대로 user_id 같은 필드에 `size: 1000000`을 주면 코디네이터 메모리가 폭주하고 circuit breaker가 쿼리를 끊는다. 전수는 `composite` 페이징으로 받는다.
- **date_histogram의 `time_zone` 누락.** 기본값이 UTC라 한국 데이터를 `1d`로 묶으면 오전 9시에 날짜가 바뀐다. `calendar_interval`과 `fixed_interval`을 함께 쓰면 오류가 난다.
- **매핑이 집계를 막는 경우.** keyword 필드에 `sum`을 걸거나 `doc_values: false`인 필드를 집계하면 실패한다. nested 필드를 `nested` 집계 없이 `terms`로 묶으면 한 주문에 같은 상품이 세 개 있어도 한 번만 세어진다.
- **비용이 새는 요청 패턴.** 같은 필드에 통계를 따로 걸면 Doc Values를 여러 번 스캔하므로 `stats`로 묶는다. `filters` 조건이 수십 개면 각 조건이 개별 검색과 같고, `top_hits.size`가 크면 버킷 수와 곱해진 문서가 응답에 실린다.

## 관련 글

- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [Term-level·Compound 쿼리](/notes/elasticsearch/term-compound-queries/)
- [집계 — Pipeline](/notes/elasticsearch/aggregations-pipeline/)
