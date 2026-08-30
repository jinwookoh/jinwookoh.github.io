---
title: "BigQuery Export·API·운영과 Privacy"
series: experimentation
part: "GA4"
order: 15
summary: "GA4 데이터를 UI 밖으로 꺼내 쓰는 세 경로와, 운영에서 반드시 마주치는 한도·동의·PII 문제를 정리한다"
tags: [GA4, BigQuery, Data API, Admin API, Consent Mode]
sources: [ga/2026-05-17-ga-bigquery-export.md, ga/2026-05-17-ga-data-admin-api.md, ga/2026-05-17-ga-operations-privacy.md, 2026-05-03-ga4-best-practices.md, ga/2026-05-17-ga-series-conclusion.md]
updated: 2026-08-30
---

GA4 UI만으로는 실험 분석이 막히는 지점이 온다. 탐색은 1천만 이벤트를 넘으면 샘플링이 걸리고, 작은 세그먼트는 threshold로 행이 사라지며, dimension 고유값이 500을 넘으면 나머지가 (other)로 뭉개진다. Standard 속성의 보존 기간은 최대 14개월이다. 이를 푸는 경로가 BigQuery Export·Data API·Admin API이고, 동시에 Consent Mode와 PII 처리가 따라붙는다.

## 핵심 개념

BigQuery Export는 raw 이벤트를 GCP 데이터셋으로 내보낸다. 샘플링·threshold·cardinality 한도가 사라지고 SQL로 질의한다.

| 종류 | 도착 시점 | 비용·한도 | 테이블 |
|:---|:---|:---|:---|
| Daily | 전날 데이터가 다음 날 오후 | 무료, Standard는 1M event/일 | `events_YYYYMMDD` |
| Streaming | 수 분 내 | $0.05/GB, 무제한 | `events_intraday_YYYYMMDD` |
| Fresh Daily | 다음 날 이른 새벽 | 360 전용 | `events_YYYYMMDD` |

Streaming은 best-effort라 완전성을 보장하지 않고 신규 사용자의 traffic source가 24시간 뒤에 채워지므로, 실시간 감시에만 쓰고 공식 리포트는 daily로 만든다.

이벤트 한 건이 한 행이며 `event_params`·`user_properties`·`items`는 repeated record라 UNNEST가 필요하고, 파라미터 value는 `string_value`·`int_value`·`double_value` 중 하나만 채워진다. 날짜 suffix가 파티션이어서 `events_*`에는 `_TABLE_SUFFIX` 필터가 필수이고, clustering은 없으므로 scheduled query로 요약 테이블을 만들어 분석가와 BI 도구가 그쪽만 보게 한다. ==일일 테이블은 2일까지 소급 갱신되므로 확정 수치는 3일 전 기준이다.== 비용은 스토리지 $0.02/GB/월, 온디맨드 쿼리 $6.25/TB scanned다.

Data API는 집계 report를 코드로 꺼낸다. `runReport`·`batchRunReports`(최대 5개)·`runPivotReport`·`runRealtimeReport`(최근 30분) 네 메서드를 dimension·metric·dateRange·filter·orderBy·limit·offset으로 조립하며, Standard 속성은 하루 core token 25,000이 상한이다. Admin API는 Property·Stream·Custom Dimension·Audience·Key Event·Property Linking을 CRUD하므로 Terraform 같은 IaC와 결합한다. 서버 자동화는 Service Account를 쓰고 속성 Access Management에 등록해야 하며, Data API는 Viewer, Admin API는 Editor 이상이 필요하다.

Privacy의 핵심은 Consent Mode v2다. `analytics_storage`·`ad_storage`·`ad_user_data`·`ad_personalization` 네 유형을 배너 전 `default`에서 denied로 두고 선택 후 `update`한다. 뒤의 두 유형은 EU DMA 의무라 빠지면 EU 전환 데이터가 비고, 한국 PIPA는 명시 동의와 국외 이전 동의를 요구한다. 미동의 사용자는 cookieless ping으로 modeling에 쓰인다. 이메일·전화번호·주민번호는 약관이 금지하는 PII이며 대개 URL 파라미터·page_title로 자동 유입된다. User ID는 SHA-256 해시로 넘긴다.

## 코드

BigQuery 클라이언트로 어제 purchase의 items를 UNNEST해 상품별 매출을 집계하고, dry run으로 스캔 비용이 임계치를 넘으면 중단한다.

```java
@Service
public class PurchaseQueryService {

    private static final double USD_PER_TB = 6.25;
    private final BigQuery bigQuery = BigQueryOptions.getDefaultInstance().getService();

    public List<ItemRevenue> topItemsYesterday(String dataset) throws InterruptedException {
        String sql = """
            SELECT i.item_id, i.item_name, SUM(i.item_revenue) AS revenue
            FROM `%s.events_*`, UNNEST(items) AS i
            WHERE _TABLE_SUFFIX = FORMAT_DATE('%%Y%%m%%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY))
              AND event_name = 'purchase'
            GROUP BY i.item_id, i.item_name
            ORDER BY revenue DESC
            LIMIT 10
            """.formatted(dataset);

        Job dryRun = bigQuery.create(JobInfo.of(
                QueryJobConfiguration.newBuilder(sql).setDryRun(true).setUseQueryCache(false).build()));
        long bytes = ((JobStatistics.QueryStatistics) dryRun.getStatistics()).getTotalBytesProcessed();
        double cost = bytes / Math.pow(1024, 4) * USD_PER_TB;
        if (cost > 5.0) {
            throw new IllegalStateException("scan cost %.2f USD exceeds limit".formatted(cost));
        }

        TableResult result = bigQuery.query(QueryJobConfiguration.newBuilder(sql).build());
        List<ItemRevenue> rows = new ArrayList<>();
        for (FieldValueList row : result.iterateAll()) {
            rows.add(new ItemRevenue(
                    row.get("item_id").getStringValue(),
                    row.get("item_name").getStringValue(),
                    row.get("revenue").getDoubleValue()));
        }
        return rows;
    }

    public record ItemRevenue(String itemId, String itemName, double revenue) {}
}
```

Data API `runReport`로 어제 국가별 사용자·매출을 가져온다. `rowCount`와 받은 행 수를 비교해 페이지네이션 누락을 막는다.

```java
@Service
public class DailyReportService {

    private final String property;

    public DailyReportService(@Value("${ga4.property-id}") String propertyId) {
        this.property = "properties/" + propertyId;
    }

    public List<Row> yesterdayByCountry() throws IOException {
        LocalDate yesterday = LocalDate.now(ZoneId.of("Asia/Seoul")).minusDays(1);
        List<Row> rows = new ArrayList<>();
        try (BetaAnalyticsDataClient client = BetaAnalyticsDataClient.create()) {
            long offset = 0;
            int limit = 1000;
            while (true) {
                RunReportRequest request = RunReportRequest.newBuilder()
                        .setProperty(property)
                        .addDimensions(Dimension.newBuilder().setName("country"))
                        .addMetrics(Metric.newBuilder().setName("activeUsers"))
                        .addMetrics(Metric.newBuilder().setName("totalRevenue"))
                        .addDateRanges(DateRange.newBuilder()
                                .setStartDate(yesterday.toString()).setEndDate(yesterday.toString()))
                        .setReturnPropertyQuota(true)
                        .setLimit(limit).setOffset(offset)
                        .build();
                RunReportResponse response = client.runReport(request);
                rows.addAll(response.getRowsList());
                if (rows.size() >= response.getRowCount() || response.getRowsCount() < limit) {
                    break;
                }
                offset += limit;
            }
        }
        return rows;
    }
}
```

## 실무에서 걸리는 지점

- ==`SELECT * FROM events_*`를 `_TABLE_SUFFIX` 없이 실행하면 전체 이력이 스캔된다.== 컬럼을 명시하고 `INFORMATION_SCHEMA.JOBS`로 비용 상위 쿼리를 점검하며, Looker Studio는 요약 테이블에만 연결한다.
- ==`event_timestamp`와 `event_date`는 UTC다.== 한국 일자는 `DATE(TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul')`로 변환하고, 데이터셋 location은 BI 도구와 같은 리전으로 맞춘다.
- Custom Dimension의 scope와 Audience의 filter는 생성 후 변경할 수 없어 삭제 후 재생성뿐이다. Terraform 관리 리소스를 UI에서 손대면 drift가 생겨 다음 apply에서 되돌아간다.
- 대시보드가 수 초마다 `runReport`를 호출하면 quota가 소진되어 429가 온다. 결과를 캐시하고 `batchRunReports`로 묶으며 지수 backoff를 건다.
- ==GA 매출은 ad blocker·동의 거부 때문에 DB 매출의 85~95%가 정상이다.== 매일 reconcile해 편차 5% 초과 시 알리고, 같은 배치에서 PII 정규식 스캔과 page_location cardinality 감시를 돌린다.

## 관련 글

- [GA4 데이터 모델 — 이벤트·세션·사용자](/notes/experimentation/ga4-data-model/)
- [측정 구현 — gtag·GTM·이벤트·전자상거래](/notes/experimentation/ga4-measurement-gtm-events/)
- [전환·잠재고객·보고서·탐색](/notes/experimentation/ga4-conversions-reports/)
