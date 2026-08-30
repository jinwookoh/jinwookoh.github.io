---
title: "Braze란 — 고객 참여 플랫폼의 5 핵심 개념"
series: braze
part: "개념과 통합"
order: 1
summary: "Braze는 User·Segment·Campaign·Canvas·Content Card 다섯 개념으로 멀티채널 고객 여정을 자동화하는 CEP다."
tags: [Braze, Customer Engagement Platform, Canvas, Segment, Liquid]
sources: [braze/2026-05-17-braze-welcome.md]
updated: 2026-08-30
---

서비스가 커지면 고객 메시지가 채널별로 흩어진다. 이메일은 SendGrid, 푸시는 FCM, SMS는 문자 발송 업체로 나가고, "가입 후 24시간 안에 첫 결제가 없으면 쿠폰 푸시를 보낸다" 같은 조건은 백엔드 배치 코드에 박힌다. 같은 사용자가 어떤 메시지를 받았는지 한 곳에서 볼 수 없고, 문구나 조건을 바꿀 때마다 배포가 필요하며, 수신 거부 상태가 채널마다 따로 관리되어 법적 위험이 생긴다. Braze는 이 문제를 풀기 위한 Customer Engagement Platform(CEP)이다. 사용자 데이터를 한 프로필로 모으고, 어떤 시점에 어떤 채널로 무엇을 보낼지를 운영자가 대시보드에서 설계하며, 발송과 반응을 통합해 측정한다.

## 핵심 개념

Braze는 CDP(Segment), 마케팅 자동화(HubSpot), ESP(SendGrid), 푸시 전용 도구(OneSignal)의 기능을 부분적으로 모두 포함하지만 정확한 위치는 CEP이며, 같은 카테고리에 Iterable, Customer.io, Klaviyo가 있다. 모든 기능은 다섯 개념의 조합으로 설명된다.

**User**는 모든 데이터의 단위다. 우리 시스템의 user.id를 External ID로 매핑하고, 그 위에 email·country·language 같은 Standard Attribute, tier·last_order_date 같은 Custom Attribute, 사용자 행동인 Custom Event, 별도 모델로 추적하는 Purchase, 채널별 수신 동의 상태인 Subscription State가 쌓인다. Purchase를 분리하는 이유는 LTV·ARPU 같은 매출 지표를 플랫폼이 자동 계산하기 때문이다.

**Segment**는 사용자 집합의 정의다. "tier가 premium이고 country가 KR이며 최근 30일 안에 접속한 사용자"처럼 속성·이벤트·활동 시점 조건을 조합하며, 한 번 정의하면 여러 Campaign과 Canvas에서 대상 조건으로 재사용된다.

**Campaign**은 한 시점, 한 채널, 한 메시지의 단일 발송이다. One-time, Trigger-based, API-triggered, Recurring의 네 유형이 있다.

**Canvas**는 여러 단계와 분기, 시간 지연을 가진 여정 설계다. 가입 이벤트로 진입해 환영 이메일을 보내고, 24시간 뒤 첫 결제 여부로 분기해 미결제 사용자에게만 푸시를 보내고, 7일 뒤에도 결제가 없으면 SMS를 보내는 흐름을 코드 없이 구성한다. 단순 알림은 Campaign, 라이프사이클 자동화는 Canvas가 담당한다.

**Content Card**는 앱 안에 쌓이는 인박스형 메시지다. 푸시와 달리 사용자가 닫을 때까지 남고, 이미지와 CTA 버튼을 포함하며, 읽음과 닫음이 추적된다.

채널은 Email, Push, SMS, In-app Message, Web Push, Content Card 여섯 가지이며 모두 같은 사용자 프로필 위에서 운영된다. 긴급하면 SMS·Push, 분량이 많으면 Email, 앱 사용 중이면 In-app, 지속 노출이면 Content Card를 고른다.

메시지 본문은 Shopify가 만든 Liquid 템플릿 언어로 개인화한다. `{{${first_name} | default: '회원님'}}`처럼 속성을 치환하고 `{% if %}`로 조건 분기한다. Connected Content는 발송 직전 외부 API를 호출해 응답 JSON을 메시지에 넣는 기능이고, Currents는 반대로 Braze의 발송·열람·클릭 이벤트를 S3, Snowflake, Kafka로 스트리밍한다. 데이터 유입은 클라이언트 SDK와 서버 REST API 두 경로이며, 앱 내 행동은 SDK로, 결제 확정처럼 서버가 진실 원천인 데이터는 REST API로 보낸다.

## 코드

Spring Boot 3.x에서 Braze REST API를 호출하기 위한 `RestClient` 설정이다. 엔드포인트는 인스턴스 지역별로 다르므로 설정값으로 분리한다.

```java
@Configuration
public class BrazeClientConfig {

    @Bean
    RestClient brazeRestClient(
            @Value("${braze.rest-endpoint}") String endpoint,
            @Value("${braze.api-key}") String apiKey) {
        return RestClient.builder()
                .baseUrl(endpoint)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .build();
    }
}
```

`/users/track` 한 번의 호출로 속성, 이벤트, 구매를 함께 보낸다. 결제 완료 시 서버에서 등급 갱신과 Purchase 기록을 동시에 전송하는 예제다.

```java
@Service
public class BrazeUserTracker {

    private final RestClient brazeRestClient;

    public BrazeUserTracker(RestClient brazeRestClient) {
        this.brazeRestClient = brazeRestClient;
    }

    public void trackCheckout(long userId, String productId, long amountKrw, String tier) {
        String externalId = String.valueOf(userId);
        Map<String, Object> body = Map.of(
                "attributes", List.of(Map.of(
                        "external_id", externalId,
                        "tier", tier)),
                "events", List.of(Map.of(
                        "external_id", externalId,
                        "name", "checkout_completed",
                        "time", Instant.now().toString(),
                        "properties", Map.of("payment_method", "card"))),
                "purchases", List.of(Map.of(
                        "external_id", externalId,
                        "product_id", productId,
                        "currency", "KRW",
                        "price", amountKrw,
                        "quantity", 1,
                        "time", Instant.now().toString())));

        brazeRestClient.post()
                .uri("/users/track")
                .body(body)
                .retrieve()
                .toBodilessEntity();
    }
}
```

## 실무에서 걸리는 지점

- **External ID 매핑 누락.** ==SDK 초기화 시 `changeUser`로 우리 DB의 user.id를 넘기지 않으면 익명 프로필과 로그인 프로필이 별개 사용자로 남는다.== 로그인 직후 반드시 External ID를 설정하고, 서버 API도 같은 값을 쓴다.
- **Custom Attribute의 카디널리티 폭증.** 가입 timestamp처럼 사용자마다 고유한 값을 속성으로 넣으면 세그먼트 조건으로 쓸 수 없고 저장 비용만 늘어난다. 범주형 값만 속성으로 두고 고유 값은 이벤트 property로 보낸다.
- **Liquid default 누락.** 속성이 비어 있는 사용자에게 "안녕하세요, 님" 형태의 메시지가 나간다. 모든 개인화 변수에 `default` 필터를 붙인다.
- **Connected Content 지연.** ==발송 시점에 우리 API를 호출하므로 응답이 느리면 발송 전체가 밀린다.== 해당 엔드포인트는 500ms 이내 응답을 보장하고 캐시를 앞단에 둔다.
- **Subscription State 무시.** 수신 거부 사용자에게 마케팅 메시지를 보내면 정보통신망법·CAN-SPAM 위반이므로 채널별 동의 상태를 발송 전에 필터링한다.

## 관련 글

- [SDK 통합·Identity·데이터 모델](/notes/braze/sdk-identity-data-model/)
- [메시지 채널과 Liquid 개인화](/notes/braze/channels-liquid-personalization/)
- [Canvas·Campaign 운영과 도입 결정](/notes/braze/canvas-operations-adoption/)
