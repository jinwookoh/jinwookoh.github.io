---
title: "SDK 통합·Identity·데이터 모델"
series: braze
part: "개념과 통합"
order: 2
summary: "External ID를 어떻게 정하고 언제 changeUser를 부르느냐가 이후 모든 세그먼트와 분석의 정확도를 결정한다."
tags: [Braze, External ID, changeUser, users/track, Custom Event]
sources: [braze/2026-05-17-braze-sdk-and-first-campaign.md, braze/2026-05-17-braze-developer-guide-identity.md]
updated: 2026-08-30
---

Braze의 세그먼트와 캠페인은 한 사용자 프로필에 상태·행동·결제가 정확히 쌓여야 동작한다. 그 연결 고리가 External ID인데, 통합 초기에 식별자 선택과 호출 시점을 대충 잡으면 같은 사람이 모바일과 웹에서 두 프로필로 갈라지고, 로그인 전 행동이 사라지고, 결제가 LTV 집계에서 빠진다. 나중에 바로잡으려면 프로필 마이그레이션 비용을 그대로 치른다.

## 핵심 개념

**두 통합 경로.** SDK(Web·iOS·Android)는 디바이스에서 세션·이벤트를 자동 수집하고 메시지를 수신한다. REST API는 서버가 `POST /users/track`으로 프로필·이벤트·결제를 명시적으로 기록한다. 운영은 둘을 함께 쓴다. SDK Key는 노출돼도 권한이 로깅·수신으로 제한되지만, REST API Key는 전체 운영 권한이므로 서버에만 두고 용도별 최소 권한으로 발급한다. 엔드포인트는 리전마다 다르므로(`sdk.iad-01.braze.com`, `rest.fra-01.braze.eu`) 콘솔에서 확인한 값을 환경변수로 관리한다.

**SDK 데이터 흐름.** SDK 호출은 버퍼에 쌓였다가 주기적으로 동기화된다. 마지막 호출 직후 앱이 종료되면 손실될 수 있으므로 `requestImmediateDataFlush()` 명시 플러시나 서버 측 이중 기록이 필요하다.

**External ID.** 우리 시스템 사용자와 Braze 프로필을 잇는 기본 키다. 없으면 익명 `braze_id`만 부여되어 API 기능이 제한되고 크로스 디바이스 추적이 끊긴다. 조건은 불변·유일·추측 불가다. UUID v4나 기존 ID의 SHA-256 해시가 적합하고, 순차 정수는 API Key 유출 시 프로필 열거 공격에 노출되며, email·phone은 변경 가능해 부적합하다. 크기는 987바이트 이하다.

**changeUser의 네 가지 동작.**

| 상황 | 동작 |
|:---|:---|
| 같은 ID로 재호출 | 세션 영향 없음 |
| 다른 ID로 변경 | 현재 세션 종료 후 새 세션 시작 |
| 익명 → 새 ID | 익명 프로필 데이터가 새 프로필로 병합 |
| 익명 → 기존 ID | 병합되지 않음 |

가입 직후 `changeUser`를 호출하면 가입 전 행동이 새 프로필에 보존된다. 반면 기존 사용자가 로그아웃 후 익명으로 남긴 행동은 재로그인해도 붙지 않는다. 그래서 로그아웃 시 `changeUser(null)`이나 공유 기본 ID(`"default-user"`) 호출은 금지 패턴이다. 전자는 익명 활동을 유실하고, 후자는 공용 키오스크의 여러 사람을 한 프로필로 합친다. 로그아웃은 별도 처리 없이 두고 다음 로그인에서 `changeUser`만 호출한다.

**User Alias.** name과 label(네임스페이스)로 구성된 부가 식별자다. 익명 상태 타깃팅이나 legacy·CRM ID 병행 조회에 쓰며, External ID를 대체하지는 못한다.

**`/users/track` 식별자 우선순위.** primary는 `external_id`·`user_alias`·`braze_id`, secondary는 `email`·`phone`이다. primary가 있으면 email·phone은 속성으로 저장된다. 한 요청에 attributes·events·purchases 합산 75개까지 보낼 수 있고, rate limit은 3초당 3,000요청이다.

**데이터 모델 네 단위.**

| 단위 | 성격 |
|:---|:---|
| Custom Attribute | 현재 상태. 덮어쓰기·증가·배열 조작 (tier, country) |
| Custom Event | 행동. 타임스탬프 부여, append-only (product_viewed) |
| Purchase | 결제 전용. LTV·ARPU·매출 세그먼트 자동 계산 |
| Session | SDK 자동 기록. 시작·종료·지속시간 |

Event 이름은 `동사_명사` snake_case로 통일하고, 결제는 반드시 Purchase로 기록한다. 채널별 구독 상태(email·push·SMS)도 별도로 기록해 발송 필터와 법적 근거를 남긴다.

## 코드

Web SDK에서 가입 완료 시점에 Identity를 확정하고 초기 속성·이벤트를 한 함수로 동기화한다.

```javascript
import * as braze from "@braze/web-sdk";

braze.initialize(import.meta.env.VITE_BRAZE_SDK_KEY, {
  baseUrl: import.meta.env.VITE_BRAZE_BASE_URL,
  enableLogging: import.meta.env.DEV
});

export function syncUserToBraze(user) {
  braze.changeUser(user.externalId);          // 익명 활동이 새 ID로 병합
  const u = braze.getUser();
  u.setEmail(user.email);
  u.setCountry(user.country);
  u.setLanguage(user.language);
  u.setCustomUserAttribute("tier", user.tier);
  u.setEmailNotificationSubscriptionType(user.emailOptIn ? "opted_in" : "unsubscribed");
  braze.openSession();
}

export function trackPurchase(order) {
  for (const item of order.items) {
    braze.logPurchase(item.productId, item.price, "KRW", item.quantity,
      { category: item.category, order_id: order.id });
  }
  braze.requestImmediateDataFlush();
}
```

Spring Boot 3.x에서 `RestClient`로 `/users/track` 클라이언트를 만들고, 결제 완료 이벤트를 서버에서 다시 기록해 클라이언트 유실을 보완한다. 75개 단위 분할과 429 재시도를 포함한다.

```java
@Component
public class BrazeTrackClient {

    private static final int BATCH_LIMIT = 75;
    private final RestClient client;

    public BrazeTrackClient(@Value("${braze.rest-url}") String restUrl,
                            @Value("${braze.rest-api-key}") String apiKey) {
        this.client = RestClient.builder()
            .baseUrl(restUrl)
            .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build();
    }

    public record Purchase(String external_id, String product_id, String currency,
                           long price, int quantity, Instant time) {}

    @Retryable(retryFor = HttpClientErrorException.TooManyRequests.class,
               maxAttempts = 4, backoff = @Backoff(delay = 1000, multiplier = 2))
    public void trackPurchases(List<Purchase> purchases) {
        for (int i = 0; i < purchases.size(); i += BATCH_LIMIT) {
            var batch = purchases.subList(i, Math.min(i + BATCH_LIMIT, purchases.size()));
            client.post()
                .uri("/users/track")
                .body(Map.of("purchases", batch))
                .retrieve()
                .toBodilessEntity();
        }
    }
}

@Component
public class OrderCompletedListener {

    private final BrazeTrackClient braze;

    public OrderCompletedListener(BrazeTrackClient braze) { this.braze = braze; }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderCompletedEvent event) {
        var purchases = event.items().stream()
            .map(item -> new BrazeTrackClient.Purchase(
                event.userExternalId(), item.productId(), "KRW",
                item.price(), item.quantity(), event.completedAt()))
            .toList();
        braze.trackPurchases(purchases);
    }
}
```

## 실무에서 걸리는 지점

- **클라이언트와 서버의 External ID 불일치.** 클라이언트는 `user.id`, 서버는 `email`을 보내면 프로필이 둘로 갈라진다. `externalId`를 도메인 객체 한 곳에서 생성하고 양쪽이 같은 값을 읽게 한다.
- **익명 병합 가정.** 기존 사용자 재로그인 시 익명 활동이 자동으로 붙는다고 가정한 분석은 틀린다. 필요하면 Identity Merge API나 device-specific Alias로 설계하고, 아니면 익명 구간은 버린다고 명시한다.
- **Attribute cardinality 폭증.** `signup_timestamp`·`session_id`·IP처럼 사용자마다 고유한 값을 attribute로 넣으면 세그먼트 필터가 무의미해진다. 고유 값은 event property나 외부 시스템에 두고 attribute는 tier·country 같은 분류 값만 담는다.
- **푸시 권한 요청 시점.** 앱 시작 즉시 OS 다이얼로그를 띄우면 거부율이 절반에 이르고 OS 설정 전까지 복구되지 않는다. 자체 soft prompt로 가치를 설명한 뒤 첫 결제 같은 시점에 OS prompt를 띄우면 거부율을 20% 수준으로 낮출 수 있다.

## 관련 글

- [Braze란 — 고객 참여 플랫폼의 5 핵심 개념](/notes/braze/what-is-braze/)
- [REST API와 Currents](/notes/braze/rest-api-currents/)
- [메시지 채널과 Liquid 개인화](/notes/braze/channels-liquid-personalization/)
