---
title: "전환·잠재고객·보고서·탐색"
series: experimentation
part: "GA4"
order: 14
summary: "이벤트를 키 이벤트로 승격하고 잠재고객·탐색·기여 분석으로 비즈니스 가치를 읽어내는 절차를 정리한다"
tags: [GA4, Key Events, Audiences, Explorations, Attribution]
sources: [ga/2026-05-17-ga-events-conversions-audiences.md, 2026-05-03-ga4-conversions.md, ga/2026-05-17-ga-reports-explorations.md, 2026-05-03-ga4-reports.md]
updated: 2026-08-30
---

측정 구현이 끝나면 GA4에는 수십 종의 이벤트가 쌓이지만, 그중 무엇이 매출이나 가입 같은 비즈니스 목표인지 시스템은 알지 못한다. 광고 플랫폼은 최적화 대상을 잃고, 보고서는 페이지뷰와 구매를 같은 무게로 나열하며, 리타겟팅 대상도 추출할 수 없다. 이벤트에 목표 표시를 붙이고, 조건으로 사용자 집단을 정의하고, 탐색과 기여 모델로 결과를 읽는 단계가 필요하다.

## 핵심 개념

### 이벤트 계층과 키 이벤트

GA4 이벤트는 자동 수집(first_visit, session_start 등), 향상된 측정(scroll, file_download 등 웹 스트림 토글 항목), 권장 이벤트(sign_up, search, 전자상거래 12종), 맞춤 이벤트 네 계층으로 나뉜다. 권장 이벤트는 이름과 파라미터 규격을 모두 따라야 보고서가 인식한다. `purchase`에 `items`나 `value`가 빠지면 수익 보고서가 비고, `value`는 item별 price × quantity 합을 직접 계산해 보낸다.

목표 이벤트는 별도로 만들지 않고 기존 이벤트에 토글을 켜서 표시한다. 이 개념은 2024년 3월부터 전환(Conversion)이 아닌 키 이벤트(Key event)로 불리며, Google Ads 연동 시 광고 최적화에 쓰는 것만 전환으로 구분한다. 표준 속성은 최대 30개이나 5~15개로 제한해야 목표가 분산되지 않는다. 리드 제출이나 가입에도 `value`와 `currency`를 넣으면 Google Ads의 ROAS 계산과 입찰 자동화에 쓰인다. 이벤트 파라미터를 보고서 측정기준으로 쓰려면 맞춤 정의 등록이 필요하며 한도는 이벤트 범위 50개, 사용자 범위 25개, 항목 범위 10개, 맞춤 측정항목 50개다.

### 잠재고객과 세그먼트

잠재고객(Audience)은 조건에 맞는 사용자 집단이며 Google Ads·DV360·SA360과 자동 동기화되고 모든 보고서에서 쓰인다. 세그먼트는 탐색 보고서 안에서만 유효하다.

잠재고객 정의는 조건(최대 10개), 순서(시간 제약 가능), 범위(이벤트·세션·전체 세션), 회고 기간, 제외(임시·영구), 멤버십 기간(기본 30일, 최대 540일)으로 구성된다. 범위가 결과를 가장 크게 바꾼다. `country = KR AND purchase`를 전체 세션 범위로 두면 과거 한 번이라도 KR에서 접속했고 언젠가 구매한 사용자가 전부 포함된다. 카트 이탈자는 `add_to_cart` 조건에 `purchase` 영구 제외를 붙인다. 임시 제외면 환불 후 다시 진입해 광고가 재노출된다. 잠재고객은 생성 시점부터 채워지므로 일찍 만든다. 예측 잠재고객은 최근 28일 동안 조건별 1,000명 이상의 데이터가 있어야 활성화된다.

### 보고서와 탐색

표준 보고서는 실시간, 획득, 참여, 수익 창출, 유지, 인구통계, 기술 영역으로 고정되어 있다. User Acquisition은 첫 유입 채널, Traffic Acquisition은 세션별 유입 채널이라 같은 사용자가 두 표에서 다르게 잡힌다. 교차 분석과 시간 흐름 분석은 탐색(Explorations)에서 한다.

탐색 기법은 자유 형식(교차표), 유입경로(단계별 이탈), 경로(시작·종료 노드 기준 여정), 동질 집단(시기별 재방문율), 세그먼트 중복(최대 3개 교집합), 사용자 개별화 분석, 사용자 전체 기간(LTV·예측 측정항목) 일곱 가지다. 유입경로는 개방형(중간 진입 인정)과 폐쇄형(1단계부터 순서대로)의 결과가 두 배까지 벌어지므로 의도를 명시한다. 속성당 탐색 5,000개, 탐색당 세그먼트와 필터 각 10개가 한도이고 1천만 이벤트를 넘는 쿼리는 샘플링된다.

### 기여 분석

기여(Attribution) 모델은 여러 채널을 거친 키 이벤트의 공로를 배분하는 규칙이다. 2023년 11월 이후 최초 클릭·선형·시간 가치 하락·위치 기반 모델은 폐기되었고, 데이터 기반(DDA), 유료 및 자연 채널 마지막 클릭, Google 유료 채널 마지막 클릭 세 가지만 남았다. DDA가 기본값이며 마지막 클릭 모델에서 직접 유입은 공로를 받지 않는다. 회고 기간은 획득 30일, 키 이벤트 90일이 기본이자 최대값이다. 전환 경로 보고서는 초기·중기·후기 터치포인트의 공로 비율을 보여 주므로 채널이 퍼널의 어느 위치에서 작동하는지 판단하는 데 쓴다.

## 코드

서버에서 확정된 주문을 Measurement Protocol로 전송한다. `value`는 서버가 합산하고, gtag가 발급한 `client_id`를 그대로 써야 세션과 기여 정보가 이어진다.

```java
@Service
public class Ga4PurchaseSender {

    private final RestClient restClient;
    private final String measurementId;
    private final String apiSecret;

    public Ga4PurchaseSender(RestClient.Builder builder,
                             @Value("${ga4.measurement-id}") String measurementId,
                             @Value("${ga4.api-secret}") String apiSecret) {
        this.restClient = builder.baseUrl("https://www.google-analytics.com").build();
        this.measurementId = measurementId;
        this.apiSecret = apiSecret;
    }

    public void send(String clientId, Order order) {
        List<Map<String, Object>> items = order.lines().stream()
                .map(l -> Map.<String, Object>of(
                        "item_id", l.sku(),
                        "item_name", l.name(),
                        "price", l.unitPrice(),
                        "quantity", l.quantity()))
                .toList();
        long value = order.lines().stream()
                .mapToLong(l -> l.unitPrice() * l.quantity())
                .sum();

        Map<String, Object> body = Map.of(
                "client_id", clientId,
                "events", List.of(Map.of(
                        "name", "purchase",
                        "params", Map.of(
                                "transaction_id", order.id(),
                                "currency", "KRW",
                                "value", value,
                                "items", items))));

        restClient.post()
                .uri(uri -> uri.path("/mp/collect")
                        .queryParam("measurement_id", measurementId)
                        .queryParam("api_secret", apiSecret)
                        .build())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .toBodilessEntity();
    }
}
```

Data API로 유입경로 집계를 코드에서 뽑는다. 개방형을 명시하고 기기 카테고리로 분해해 단계별 이탈을 매주 자동 점검한다.

```java
@Component
public class CheckoutFunnelReport {

    private final BetaAnalyticsDataClient client;
    private final String property;

    public CheckoutFunnelReport(BetaAnalyticsDataClient client,
                                @Value("${ga4.property-id}") String propertyId) {
        this.client = client;
        this.property = "properties/" + propertyId;
    }

    public RunFunnelReportResponse lastWeek() {
        Funnel funnel = Funnel.newBuilder()
                .setIsOpenFunnel(true)
                .addSteps(step("view_item", "상품 상세"))
                .addSteps(step("add_to_cart", "장바구니"))
                .addSteps(step("begin_checkout", "결제 시작"))
                .addSteps(step("purchase", "구매"))
                .build();

        RunFunnelReportRequest request = RunFunnelReportRequest.newBuilder()
                .setProperty(property)
                .addDateRanges(DateRange.newBuilder()
                        .setStartDate("7daysAgo").setEndDate("yesterday"))
                .setFunnel(funnel)
                .setFunnelBreakdown(FunnelBreakdown.newBuilder()
                        .setBreakdownDimension(Dimension.newBuilder()
                                .setName("deviceCategory")))
                .build();
        return client.runFunnelReport(request);
    }

    private FunnelStep step(String eventName, String label) {
        return FunnelStep.newBuilder()
                .setName(label)
                .setFilterExpression(FunnelFilterExpression.newBuilder()
                        .setFunnelEventFilter(FunnelEventFilter.newBuilder()
                                .setEventName(eventName)))
                .build();
    }
}
```

## 실무에서 걸리는 지점

- `purchase`에 `transaction_id`·`currency`·`value`·`items`가 모두 있어야 수익이 집계된다. 같은 `transaction_id`를 재전송하면 수익이 중복되므로 서버 전송 경로에 멱등 처리를 둔다.
- 잠재고객의 회고 기간과 순서 시간 제약이 없으면 lifetime 기준으로 평가되어 석 달 뒤 구매까지 포함된다. 멤버십 기간은 광고 반응 지연을 넘도록 60~90일로 잡고 활동 시 갱신을 켠다.
- DDA는 최근 28일 동안 해당 키 이벤트가 300건 이상 쌓여야 동작하고 부족하면 마지막 클릭으로 되돌아간다.
- 직접 유입 비중이 60%를 넘으면 UTM 누락, HTTPS→HTTP 리퍼러 손실, Safari ITP 차단을 먼저 의심한다.
- 샘플링된 탐색에서는 작은 차이가 노이즈에 묻히므로 날짜 범위를 줄이거나 BigQuery Export 원본으로 옮긴다. 사용자 개별화 분석은 개인 식별 위험이 있어 접근 권한과 감사 기록을 함께 둔다.

## 관련 글

- [측정 구현 — gtag·GTM·이벤트·전자상거래](/notes/experimentation/ga4-measurement-gtm-events/)
- [BigQuery Export·API·운영과 Privacy](/notes/experimentation/ga4-bigquery-api-privacy/)
- [A/B 테스트 — 대조군·전환율·가설과 지표 설계](/notes/experimentation/ab-test-basics-design/)
