---
title: "측정 구현 — gtag·GTM·이벤트·전자상거래"
series: experimentation
part: "GA4"
order: 13
summary: "gtag·GTM·Measurement Protocol의 역할을 나누고, 표준 이름과 items 구조로 전자상거래 퍼널을 깨지지 않게 구현한다"
tags: [GA4, Google Tag Manager, dataLayer, Measurement Protocol, ecommerce]
sources: [ga/2026-05-17-ga-measurement-methods.md, 2026-05-03-ga4-gtm-setup.md, 2026-05-03-ga4-events.md, 2026-05-03-ga4-advanced-tracking.md]
updated: 2026-08-30
---

gtag.js를 페이지에 직접 박으면 이벤트를 추가할 때마다 배포가 필요하고, GTM에 dataLayer push만 쌓고 트리거·태그를 연결하지 않으면 보고서가 빈다. 결제 웹훅이나 환불처럼 브라우저가 없는 시점의 전환은 클라이언트 측정으로 잡히지 않는다. 전자상거래 이벤트는 items 구조가 어긋나거나 transaction_id가 빠지면 퍼널과 매출 집계가 틀어진다.

## 핵심 개념

### 측정 경로

gtag.js는 페이지 코드에 직접 넣고, GTM은 대시보드에서 태그를 관리하며, Firebase SDK는 모바일 앱, Measurement Protocol은 서버가 직접 보낸다. 규모가 커지면 웹은 GTM, 앱은 Firebase, 서버는 Measurement Protocol이 맡고 한 속성의 서로 다른 스트림으로 모인다. ==gtag.js와 GTM을 한 페이지에 같이 두면 이벤트가 중복되므로 하나만 택한다.== `gtag()`는 `dataLayer.push`를 감싼 함수다.

### GTM 구성

GTM 작업은 무엇을(Tag), 언제(Trigger), 어떤 값으로(Variable) 실행할지 정하는 일이다. Google Tag가 Measurement ID(`G-XXXX`)로 속성에 연결하고 All Pages 트리거로 page_view를 만들며, GA4 Event 태그는 이 Google Tag를 참조해야 전송 대상이 정해진다. 컨테이너 ID(`GTM-XXXX`)와는 다른 값이다.

코드가 `dataLayer.push({event: 'add_to_cart', ...})`를 호출하면 같은 이름의 Custom Event 트리거가 반응하고 Data Layer Variable이 함께 push된 값을 태그 매개변수로 넘긴다. 변경은 Workspace → Preview → Submit → Publish를 거쳐야 라이브에 반영되며, Preview 상태에서만 GA4 DebugView에 이벤트가 실시간으로 보인다.

### 이벤트 계층과 이름

자동 수집(first_visit·session_start·page_view·user_engagement)은 측정 코드만 있으면 발생하고, 향상된 측정(scroll·outbound click·site search·video·file download)은 데이터 스트림 토글로 켜지므로 GTM에서 다시 만들지 않는다. 나머지가 커스텀 이벤트다.

이벤트 이름은 소문자·언더스코어·40자 이내이며, 매개변수는 `item_id`, `price`, `currency`처럼 표준 이름을 써야 전자상거래 보고서가 활성화된다. 매개변수는 이벤트 한 건에만 붙고, user_properties는 이후 모든 이벤트에 따라붙는다. 값은 HTML `data-*` 속성에서 읽는 편이 DOM 텍스트 추출보다 마크업 변경에 강하다.

### 전자상거래

퍼널은 view_item_list → select_item → view_item → add_to_cart → begin_checkout → purchase 순서이며, 모든 이벤트가 같은 `items` 배열을 공유하며 `item_id`·`item_name`만 필수이고 `item_variant`·`index`를 채울수록 분석이 깊어진다. items를 만드는 함수는 하나만 두고 재사용한다. ==매 push 직전 `dataLayer.push({ecommerce: null})`로 이전 items가 섞이는 것을 막고, purchase에는 문자열 `transaction_id`를 넣어 새로고침 중복을 제거한다.==

### Measurement Protocol

`POST /mp/collect?measurement_id=...&api_secret=...`로 서버가 직접 이벤트를 보낸다. 페이로드의 `client_id`가 브라우저 GA 쿠키 값과 일치해야 같은 사용자로 결합되므로, `gtag('get', id, 'client_id', cb)`로 꺼내 서버에 저장해 둔다. `/debug/mp/collect`는 payload 오류를 `validationMessages`로 돌려준다. 클라이언트 SDK를 보완하는 수단이지 대체하지 않는다.

## 코드

페이지 측 dataLayer push. `data-*` 속성에서 값을 읽어 push한다.

```html
<button class="add-to-cart" data-item-id="SKU-001" data-item-name="Blue T-Shirt" data-price="29000">담기</button>
<script>
  window.dataLayer = window.dataLayer || [];
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-to-cart');
    if (!btn) return;
    const price = Number(btn.dataset.price);
    window.dataLayer.push({ ecommerce: null });
    window.dataLayer.push({
      event: 'add_to_cart',
      ecommerce: {
        currency: 'KRW', value: price,
        items: [{ item_id: btn.dataset.itemId, item_name: btn.dataset.itemName, price, quantity: 1 }]
      }
    });
  });
</script>
```

Spring Boot 3.x의 Measurement Protocol 클라이언트. 운영 프로필이 아니면 검증 엔드포인트를 먼저 호출한다.

```java
@Component
public class Ga4MeasurementClient {

    private final RestClient restClient;
    private final String measurementId;
    private final String apiSecret;
    private final boolean production;

    public Ga4MeasurementClient(RestClient.Builder builder,
                                @Value("${ga4.measurement-id}") String measurementId,
                                @Value("${ga4.api-secret}") String apiSecret,
                                Environment env) {
        this.restClient = builder.baseUrl("https://www.google-analytics.com").build();
        this.measurementId = measurementId;
        this.apiSecret = apiSecret;
        this.production = env.matchesProfiles("prod");
    }

    public void sendPurchase(String clientId, String userId, Order order) {
        List<Map<String, Object>> items = order.lines().stream()
            .map(l -> Map.<String, Object>of(
                "item_id", l.sku(), "item_name", l.name(),
                "price", l.unitPrice(), "quantity", l.quantity()))
            .toList();
        Map<String, Object> payload = Map.of(
            "client_id", clientId,
            "user_id", userId,
            "events", List.of(Map.of(
                "name", "purchase",
                "params", Map.of(
                    "transaction_id", order.id(),
                    "value", order.total(),
                    "currency", "KRW",
                    "items", items))));
        if (!production) {
            validate(payload);
        }
        post("/mp/collect", payload).toBodilessEntity();
    }

    private void validate(Map<String, Object> payload) {
        JsonNode messages = post("/debug/mp/collect", payload)
            .body(JsonNode.class).path("validationMessages");
        if (messages.isArray() && !messages.isEmpty()) {
            throw new IllegalStateException("GA4 validation failed: " + messages);
        }
    }

    private RestClient.ResponseSpec post(String path, Map<String, Object> payload) {
        return restClient.post()
            .uri(b -> b.path(path)
                .queryParam("measurement_id", measurementId)
                .queryParam("api_secret", apiSecret).build())
            .contentType(MediaType.APPLICATION_JSON)
            .body(payload)
            .retrieve();
    }
}
```

브라우저의 client_id를 서버에 저장하는 엔드포인트. 로그인 직후 한 번 호출한다.

```java
@RestController
@RequestMapping("/api/analytics")
public class ClientIdController {

    private final ClientIdRepository repository;

    public ClientIdController(ClientIdRepository repository) {
        this.repository = repository;
    }

    public record ClientIdRequest(@NotBlank String clientId) {}

    @PostMapping("/client-id")
    public ResponseEntity<Void> save(@AuthenticationPrincipal UserDetails user,
                                     @Valid @RequestBody ClientIdRequest request) {
        repository.upsert(user.getUsername(), request.clientId());
        return ResponseEntity.noContent().build();
    }
}
```

## 실무에서 걸리는 지점

- **SPA의 page_view 누락.** 라우트가 바뀌어도 페이지가 다시 로드되지 않아 자동 page_view가 한 번만 남는다. 라우터 훅에서 수동 전송하거나 GTM의 History Change 트리거를 쓴다.
- **폼 제출과 변수 빈 값.** ==Form Submission 트리거는 `Wait for Tags`를 켜지 않으면 리디렉션 직전에 이벤트가 유실된다.== 트리거 미발동의 대부분은 조건 값이 비어 있거나 대소문자·후행 슬래시가 다른 경우이므로 Preview의 Variables 탭에서 실제 값부터 확인한다.
- **비동기 상품 조회의 순서 역전.** 상품 정보를 API로 가져와 push하면 빠른 연속 클릭에서 응답 순서가 뒤바뀐다. 요청 카운터로 최신 응답만 처리하고 같은 상품은 캐시한다.
- **비밀값과 식별자.** `api_secret`은 서버 환경 변수에만 둔다. ==서버 hit는 사용자 IP가 없어 지역이 서버 위치로 찍히므로 IP 오버라이드가 필요하다.== User ID에는 PII 대신 해시된 식별자만 쓴다.
## 관련 글

- [GA4 데이터 모델 — 이벤트·세션·사용자](/notes/experimentation/ga4-data-model/)
- [전환·잠재고객·보고서·탐색](/notes/experimentation/ga4-conversions-reports/)
- [BigQuery Export·API·운영과 Privacy](/notes/experimentation/ga4-bigquery-api-privacy/)
