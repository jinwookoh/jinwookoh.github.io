---
title: "Product Analytics와 Warehouse Native"
series: experimentation
part: "Statsig"
order: 10
summary: "이벤트 설계와 6종 차트, 그리고 데이터를 자사 웨어하우스에 둔 채 Statsig 통계 엔진을 쓰는 WHN 운영을 정리한다"
tags: [Statsig, Product Analytics, Warehouse Native, CUPED, dbt]
sources: [statsig/2026-05-17-statsig-product-analytics-deep.md, statsig/2026-05-17-statsig-warehouse-native-deep.md]
updated: 2026-08-30
---

Feature Gate와 Experiment만으로는 게이트를 켠 사용자가 결제 퍼널의 어느 단계에서 이탈하는지, 신규 코호트가 이전보다 오래 남는지 알 수 없다. 한편 데이터 규모가 크거나 PII·금융 데이터를 외부 SaaS로 보낼 수 없는 조직은 Cloud 모드 자체가 불가능하다. ==전자는 Product Analytics의 이벤트 설계가, 후자는 Warehouse Native(WHN)가 해결한다.==

## 핵심 개념

==Product Analytics의 원자 단위는 Event다.== eventName·value·metadata·timestamp로 구성되고, Funnel·Retention·Cohort는 모두 이 이벤트의 가공 결과다. Event가 단일 발생의 raw log라면 Metric은 이벤트를 집계해 의미를 붙인 정의로, Count·Sum·Mean·Ratio·Funnel·Retention·Time to Event 일곱 유형이 있다.

이벤트 설계 원칙은 다섯 가지다. 이름은 `checkout_completed`처럼 명사와 과거형 동사를 조합하고, 한 코드베이스 안에서 표기법을 하나로 통일한다. value에는 sum·avg가 의미 있는 정량값만 넣고 분류값은 property로 보낸다. user_id·session_id처럼 unique 값이 무한한 속성은 property로 넣지 않는다.

Metrics Explorer의 여섯 차트는 각각 다른 질문에 답한다.

| 차트 | 답하는 질문 |
|:---|:---|
| Metric Drilldown | 한 지표가 시간·세그먼트별로 어떻게 변하는가 |
| Funnels | 어느 단계에서 이탈하는가 (step 간 시간 제한, strict/loose 순서) |
| Retention | N일 후 재방문하는가 (Day N·Rolling·Bracket, 코호트 비교) |
| Distribution | 평균이 가리는 long tail이 있는가 (median·P90·P99) |
| User Journeys | 실제 경로가 예상과 다른가 (Sankey) |
| Lifecycle | New·Active·Returning·Dormant·Churned 전환 비율 |

Dashboards는 차트에 텍스트·단일값·Gate 및 Experiment 스냅샷을 묶는다. Statsig의 차별점은 게이트 Pass/Fail별 퍼널 비교나 Holdout 대비 D30 리텐션처럼 세 축을 한 데이터 흐름 위에서 조회한다는 점이다.

WHN은 이벤트와 노출 데이터를 Snowflake·BigQuery·Databricks·Redshift에 두고 Statsig가 SQL 쿼리만 실행하는 Enterprise 전용 모델이다. Full Platform은 할당부터 분석까지 Statsig가 담당하고 결과만 자사 웨어하우스에 적재한다. Existing Experiments는 LaunchDarkly나 자체 시스템의 할당 데이터를 그대로 두고 Statsig 통계 엔진만 분석 계층으로 끼운다. 워크플로는 Connect·Define·Log·Analyze 네 단계이며, 이벤트 테이블의 user_id·event_name·event_timestamp·value·properties를 매핑하고 exposure 테이블과 user_id로 join해 분석한다. 도구는 Pulse Analysis(가설 검증), Metrics Explorer, Exposure Analysis(첫 노출·실험 간 상호작용·SRM)다.

통계 기법으로는 실험 전 데이터를 공변량으로 써 분산을 줄이는 CUPED, 세그먼트별 50/50을 맞추는 Stratified Sampling, 사용자 단위 무작위화가 불가능한 가격·마켓플레이스에서 시간 구간을 교대 배정하는 Switchback Test가 있다.

## 코드

이벤트 이름과 property 구조를 한 곳에 정의하고 호출부는 typed 메서드만 쓰도록 감싼 서비스다.

```java
@Service
public class AnalyticsTracker {

    public static final String CHECKOUT_COMPLETED = "checkout_completed";
    public static final String PRODUCT_VIEWED = "product_viewed";

    private final Statsig statsig;

    public AnalyticsTracker(Statsig statsig) {
        this.statsig = statsig;
    }

    public void checkoutCompleted(StatsigUser user, long cartValue, int itemsCount, String paymentMethod) {
        statsig.logEvent(user, CHECKOUT_COMPLETED, String.valueOf(cartValue), Map.of(
                "cart_value", String.valueOf(cartValue),
                "items_count", String.valueOf(itemsCount),
                "payment_method", paymentMethod,
                "currency", "KRW"));
    }

    public void productViewed(StatsigUser user, String productId, String category) {
        statsig.logEvent(user, PRODUCT_VIEWED, null, Map.of(
                "product_id", productId,
                "category", category));
    }
}
```

WHN Connect 단계의 Snowflake 권한이다. 읽기·쓰기·compute를 schema 단위로 분리하고 PII schema에는 권한을 주지 않는다.

```sql
GRANT USAGE ON DATABASE prod_analytics TO ROLE statsig_role;
GRANT USAGE ON SCHEMA prod_analytics.events TO ROLE statsig_role;
GRANT SELECT ON ALL TABLES IN SCHEMA prod_analytics.events TO ROLE statsig_role;

GRANT CREATE TABLE ON SCHEMA prod_analytics.statsig TO ROLE statsig_role;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA prod_analytics.statsig TO ROLE statsig_role;

GRANT USAGE ON WAREHOUSE STATSIG_WH TO ROLE statsig_role;
```

Statsig Metric의 입력이 되는 dbt 증분 모델이다. 비즈니스 로직은 dbt가 소유한다.

```sql
{{ config(materialized='incremental', unique_key=['date', 'user_id']) }}

SELECT
    DATE(event_timestamp) AS date,
    user_id,
    COUNT(*) AS event_count,
    MAX(CASE WHEN event_name = 'app_open' THEN 1 ELSE 0 END) AS is_active
FROM {{ ref('stg_events') }}
{% if is_incremental() %}
WHERE event_timestamp >= (SELECT MAX(date) FROM {{ this }})
{% endif %}
GROUP BY 1, 2
```

## 실무에서 걸리는 지점

- 이벤트 property의 의미 변경이나 제거는 과거 데이터와 호환되지 않으므로 `purchase_v2`처럼 새 이벤트로 분리한다. dbt 모델 컬럼이 바뀌면 Statsig Metric이 조용히 깨지므로 contract를 선언하고 함께 갱신한다.
- 퍼널 step 간 시간 제한을 1시간처럼 짧게 두면 며칠에 걸쳐 전환하는 대다수가 제외된다.
- 평균 주문 금액 상승만 보고 배포했더니 상위 5%의 일시 증가였던 사례가 흔하다. Distribution으로 median·P90·P99를 함께 본다. User Journeys는 3~5단계로 압축해야 경로가 unique해지지 않는다.
- ==WHN의 최대 비용은 웨어하우스 compute다.== 날짜 partition과 user_id·event_name clustering, materialized view, 전용 warehouse의 auto-suspend를 적용한다. 도입 전 PoC로 비용을 시뮬레이션하지 않으면 Metric 정의가 얽혀 Cloud로 돌아가기 어렵다.
- CUPED는 실험 전 데이터가 noise인 지표에서 검정력을 오히려 떨어뜨리므로 preview로 확인 후 적용한다. Switchback은 carry-over가 생기므로 전환 구간을 길게 잡고, Existing 모델에서는 외부 할당의 SRM을 Exposure Analysis로 점검한다.

## 관련 글

- [Feature Flags와 Experiments](/notes/experimentation/statsig-flags-experiments/)
- [통합·운영·도입 결정](/notes/experimentation/statsig-integrations-adoption/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
