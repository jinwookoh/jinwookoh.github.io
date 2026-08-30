---
title: "GA4 데이터 모델 — 이벤트·세션·사용자"
series: experimentation
part: "GA4"
order: 12
summary: "GA4는 모든 상호작용을 이벤트로 기록하고, Client ID·User ID·세션 규칙으로 사용자와 방문을 묶는다."
tags: [GA4, Event Model, User ID, Session, Custom Dimension]
sources: [ga/2026-05-17-ga-welcome.md, ga/2026-05-17-ga-data-model-deep.md, 2026-05-03-ga4-basics.md]
updated: 2026-08-30
---

Universal Analytics(UA)는 2023년 7월에 종료됐지만 남은 자료 대부분은 UA 기준이다. UA의 히트·목표 개념으로 GA4를 보면 세션 수와 이탈률 정의가 어긋나고 사용자는 브라우저마다 따로 잡힌다. ==데이터 모델을 먼저 잡지 않으면 되돌릴 수 없는 스코프의 맞춤 측정기준을 만들거나, 로그아웃 처리를 빠뜨려 익명 사용자 전체가 한 명으로 합쳐진다.==

## 핵심 개념

### 계층 — Account · Property · Data Stream

계정(조직, 권한) → 속성(분석 단위, 서비스 하나) → 데이터 스트림(Web·iOS·Android 수집 진입점) 3단이다. UA는 앱과 웹이 별도 속성이었지만 GA4는 한 속성 아래 여러 스트림을 두어 크로스 플랫폼 사용자를 한 뷰로 본다. 스트림마다 Measurement ID(`G-XXXXXXXXXX`)가 발급되며 gtag·GTM 설치 시 이 값을 쓴다. 속성은 서비스 단위로 하나만 두고 페이지·기능은 파라미터로 구분한다.

### 이벤트 — 단일 스키마

GA4는 page_view·click·purchase가 모두 `event_name` + `event_params` + `user_properties` 구조의 이벤트다.

| 유형 | 발생 조건 | 예 |
|:---|:---|:---|
| 자동 수집 | 설치만으로 발생 | first_visit, session_start, page_view |
| 향상된 측정 | 웹 스트림 토글 | scroll, 외부 링크 click, file_download, video_* |
| 추천 이벤트 | 표준 이름을 개발자가 전송 | purchase, add_to_cart, sign_up |
| 맞춤 이벤트 | 직접 정의 | product_click |

추천 이벤트 이름을 쓰면 표준 보고서·전자상거래 퍼널·예측 지표가 자동으로 채워지고, `buy_now` 같은 임의 이름은 인식되지 않는다. 이름은 snake_case 40자 이내다.

파라미터는 해당 이벤트에만 붙고, 사용자 속성은 이후 모든 이벤트에 따라붙는다. 한도는 파라미터 이벤트당 25개(이름 40자·값 100자), 사용자 속성 25개(이름 24자·값 36자)이며 초과분은 오류 없이 잘린다.

### 사용자 식별 — 3개 계층

**Client ID**는 첫 방문 시 `_ga` 쿠키에 저장되는 브라우저·기기 단위 식별자다. 쿠키 삭제, 시크릿 모드, 다른 브라우저는 모두 새 사용자로 잡힌다. **User ID**는 서비스의 로그인 식별자를 개발자가 보내는 값으로, 여러 기기에서 같은 값으로 로그인하면 한 사용자로 묶인다. **Google Signals**는 Google 계정 로그인과 광고 개인 맞춤에 동의한 사용자를 Google이 기기 간 통합 인식한 결과로, User ID 없이도 일부 크로스 디바이스 통합과 인구통계 데이터를 준다.

### 세션 — 30분 비활동 규칙과 참여 세션

세션은 `session_start`로 시작하고 30분(스트림 설정에서 5분~7시간) 동안 활동이 없으면 끝난다. UA와 달리 자정에 끊기지 않고 캠페인 소스가 바뀌어도 새 세션이 생기지 않으므로 UA와 GA4의 세션 수는 추세만 비교한다.

참여 세션은 10초 이상 지속, page_view 2회 이상, 키 이벤트 발생 중 하나를 만족한 세션이다. GA4 이탈률은 1 − 참여율이라 UA 이탈률(1페이지 세션 비율)과 수치가 대응하지 않는다. 도메인 간 이동을 한 세션으로 유지하려면 웹 스트림에 cross-domain 도메인을 등록한다.

### 맞춤 측정기준 — 3개 스코프

==파라미터와 사용자 속성은 맞춤 측정기준(문자)·측정항목(숫자)으로 등록해야 보고서에 나타나며 스코프는 등록 후 바꿀 수 없다.==

| 스코프 | 적용 범위 | 예 | 한도 |
|:---|:---|:---|:---|
| Event | 이벤트 한 건 | article_category | 50 |
| User | 사용자의 이후 모든 이벤트 | user_tier | 25 |
| Item | items 배열의 각 상품 | brand, size | 10 |

고유값(cardinality)이 많아지면 보고서가 상위 값만 남기고 나머지를 `(other)`로 합친다. user_id·session_id·search_query 같은 값은 파라미터로만 보내고 BigQuery Export에서 조회한다.

## 코드

Measurement Protocol로 서버에서 purchase 이벤트를 보내는 컴포넌트다. `client_id`는 프론트가 `_ga` 쿠키에서 읽어 주문에 저장한 값이다.

```java
@Component
public class Ga4MeasurementClient {

    private final RestClient restClient;
    private final String measurementId;
    private final String apiSecret;

    public Ga4MeasurementClient(RestClient.Builder builder,
                                @Value("${ga4.measurement-id}") String measurementId,
                                @Value("${ga4.api-secret}") String apiSecret) {
        this.restClient = builder.baseUrl("https://www.google-analytics.com").build();
        this.measurementId = measurementId;
        this.apiSecret = apiSecret;
    }

    public void sendPurchase(String clientId, String userId, Order order) {
        var items = order.lines().stream()
                .map(l -> Map.of(
                        "item_id", l.productId(),
                        "item_name", l.productName(),
                        "item_brand", l.brand(),
                        "price", l.unitPrice(),
                        "quantity", l.quantity()))
                .toList();

        var event = Map.of(
                "name", "purchase",
                "params", Map.of(
                        "transaction_id", order.id(),
                        "value", order.totalAmount(),
                        "currency", "KRW",
                        "items", items));

        var body = new LinkedHashMap<String, Object>();
        body.put("client_id", clientId);
        if (userId != null) {
            body.put("user_id", userId);
        }
        body.put("events", List.of(event));

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

User ID 생성을 한 곳에 모아 형식 통일과 PII 검증을 강제하는 값 객체다.

```java
public record GaUserId(String value) {

    private static final Pattern ALLOWED = Pattern.compile("^user-\\d+$");

    public GaUserId {
        Objects.requireNonNull(value, "user id must not be null");
        if (value.contains("@") || value.matches(".*\\d{3}-\\d{4}-\\d{4}.*")) {
            throw new IllegalArgumentException("PII cannot be used as GA4 user_id");
        }
        if (!ALLOWED.matcher(value).matches()) {
            throw new IllegalArgumentException("user_id must match user-<numeric id>");
        }
    }

    public static GaUserId of(long dbUserId) {
        return new GaUserId("user-" + dbUserId);
    }
}
```

클라이언트는 로그인 시 같은 값을 설정하고 로그아웃 시 `null`로 되돌린다. 빈 문자열은 실제 ID로 기록된다.

```javascript
gtag('config', 'G-XXXXXXXXXX', { user_id: 'user-12345' });
gtag('set', 'user_properties', { user_tier: 'premium', country: 'KR' });

// 로그아웃
gtag('set', { user_id: null });
```

## 실무에서 걸리는 지점

- **User ID를 맞춤 측정기준으로 등록.** 고유값이 사용자 수만큼 늘어 `(other)`로 뭉개진다. 사용자 단위 분석은 BigQuery에서 한다.
- **스코프 선택 실수.** user_tier를 Event 스코프로 만들면 파라미터가 없는 이벤트에서 빈 값이 잡힌다. 사용자 상태는 User, 이벤트마다 다른 값은 Event, items 안의 값은 Item으로 정한다.
- ==**PII 전송.** 이메일·전화번호·실명을 보내면 정책 위반으로 속성이 정지될 수 있다.== 해시 값도 고유 식별이 가능하면 PII로 취급되므로 내부 ID만 보낸다.
- **환경별 속성 미분리.** dev·staging이 production Measurement ID를 쓰면 테스트 이벤트가 실데이터에 섞인다. 환경별로 속성을 나눈다.
- **보존 기간과 샘플링.** 이벤트 보존은 기본 2개월, 최대 14개월이고 트래픽이 많으면 탐색 보고서가 샘플링된다. BigQuery Export로 raw 이벤트를 직접 보관한다.

## 관련 글

- [측정 구현 — gtag·GTM·이벤트·전자상거래](/notes/experimentation/ga4-measurement-gtm-events/)
- [전환·잠재고객·보고서·탐색](/notes/experimentation/ga4-conversions-reports/)
- [BigQuery Export·API·운영과 Privacy](/notes/experimentation/ga4-bigquery-api-privacy/)
