---
title: "Canvas·Campaign 운영과 도입 결정"
series: braze
part: "메시징과 운영"
order: 5
summary: "Canvas 5 구성 요소와 Step 종류로 journey를 설계하는 법, 그리고 Braze 도입 여부를 가르는 기준을 정리한다."
tags: [Braze, Canvas, Campaign, Journey Orchestration, 도입 결정]
sources: [braze/2026-05-17-braze-canvas-campaign-operations.md, braze/2026-05-17-braze-wrap-up.md]
updated: 2026-08-30
---

사용자 데이터를 쌓아도 언제 어떤 채널에 무엇을 보낼지 정하는 층이 없으면 발송은 개발자의 배치 스크립트로 되돌아간다. 가입 후 24시간 미결제면 push, 48시간 뒤에도 미결제면 in-app 같은 다단계 분기를 코드로 유지하면 조건이 바뀔 때마다 배포가 필요하고, 같은 사용자에게 여러 채널이 동시에 쏟아지는 폭격도 막기 어렵다. Braze에서 이 자리를 맡는 것이 Campaign과 Canvas이며, 이 층을 누가 운영하고 어느 규모에서 가치가 생기는지가 도입 결정을 가른다.

## 핵심 개념

Campaign은 단일 메시지를 한 번 보내는 단위이고, Canvas는 여러 메시지를 분기·지연·조건으로 엮은 journey 자동화 단위다. Campaign은 One-time(정해진 시각 1회), Trigger-based(사용자 행동 시 자동), API-triggered(`/campaigns/trigger/send`로 백엔드가 발송 시점 통제), Recurring(정기 반복) 네 타입으로 나뉜다. 서버가 시점을 아는 트랜잭션 메시지는 API-triggered Campaign, Onboarding·Cart Abandonment·Win-back처럼 상태에 따라 갈라지는 lifecycle은 Canvas가 맞다.

Canvas는 다섯 요소로 구성된다.

| 요소 | 역할 |
|:---|:---|
| Entry | 진입 트리거. Custom Event · Scheduled · API-triggered(`/canvas/trigger/send`) · Segment Entry |
| Audience | 진입 시점에 평가하는 전체 필터(구독 상태·국가·앱 버전 등) |
| Flow | Step의 연결 |
| Exit | 종료 조건. Goal event 도달 · Audience 위반 · Custom Event · timeout |
| Variants | Flow 전체에 겹치는 A/B 실험 층 |

Flow를 이루는 Step은 일곱 종류다. Message(채널별 발송), Delay(고정 시간·특정 시각·특정 요일까지), Decision(조건 분기), Webhook(외부 HTTP 호출), Update User Attribute(속성 변경), Audience Filter(중간 재평가), Wait Until(event 발생 또는 최대 대기 시간까지 대기)이다. Decision은 다시 행동 기반 Action Path(지난 N일 안 특정 event 발생 여부), 특성 기반 Audience Path(segment 멤버십), 무작위 Random Split(A/B/n)으로 갈린다.

Campaign의 variant가 제목·본문 수준이라면, Canvas의 variant는 "email → 24h → push"와 "push → 24h → email"처럼 채널 순서·타이밍·시퀀스 전체를 비교한다. 다만 통계 처리는 전용 실험 플랫폼보다 약하므로 제품 실험은 Statsig 계열에 두고 Braze는 메시징 시퀀스 비교에 한정하는 편이 분업이 깨끗하다.

도입 결정은 규모·채널·운영 주체로 갈린다. 사용자 1만 명 이하이거나 email 단일 채널이면 Mailchimp·OneSignal급으로 충분하고, 1만~10만은 Customer.io·Klaviyo 같은 mid-tier, 10만 이상에서 여러 채널을 함께 굴리며 마케터가 직접 journey를 설계해야 할 때 Braze의 multi-channel orchestration이 가치를 낸다. Shopify 중심은 Klaviyo, B2B CRM 결합은 HubSpot·Salesforce가 우세하고, self-host 필수 환경은 SaaS-only인 Braze로 풀 수 없다. 라이선스는 연 $50K~$200K대이며 free tier가 없다.

## 코드

결제 완료 시 API-triggered Canvas를 진입시키는 Spring Boot 3.x 클라이언트다. entry property는 마케터가 Liquid에서 참조하는 계약 필드이므로 record로 고정한다.

```java
@Component
public class BrazeCanvasClient {

    private final RestClient restClient;
    private final String canvasId;

    public BrazeCanvasClient(RestClient.Builder builder,
                             @Value("${braze.rest-endpoint}") String endpoint,
                             @Value("${braze.api-key}") String apiKey,
                             @Value("${braze.canvas.receipt-id}") String canvasId) {
        this.restClient = builder
                .baseUrl(endpoint)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                .build();
        this.canvasId = canvasId;
    }

    public record ReceiptProperties(String orderId, long value, String currency) {}

    public void triggerReceipt(String externalId, ReceiptProperties props) {
        var body = Map.of(
                "canvas_id", canvasId,
                "recipients", List.of(Map.of(
                        "external_user_id", externalId,
                        "canvas_entry_properties", Map.of(
                                "order_id", props.orderId(),
                                "value", props.value(),
                                "currency", props.currency()))));
        restClient.post()
                .uri("/canvas/trigger/send")
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .toBodilessEntity();
    }
}
```

Webhook Step이 호출하는 수신 엔드포인트다. Braze는 실패 시 재시도하므로 사용자와 step을 키로 멱등 처리하고 실제 작업은 비동기로 넘긴다.

```java
@RestController
@RequestMapping("/internal/braze")
public class BrazeWebhookController {

    private final IdempotencyStore idempotencyStore;
    private final ApplicationEventPublisher publisher;

    public BrazeWebhookController(IdempotencyStore idempotencyStore,
                                  ApplicationEventPublisher publisher) {
        this.idempotencyStore = idempotencyStore;
        this.publisher = publisher;
    }

    public record CanvasStepPayload(@NotBlank String externalId, @NotBlank String step) {}

    @PostMapping("/canvas-step")
    public ResponseEntity<Void> onCanvasStep(
            @RequestHeader("X-Braze-Signature") String signature,
            @Valid @RequestBody CanvasStepPayload payload) {
        if (!idempotencyStore.markIfAbsent(payload.externalId() + ":" + payload.step())) {
            return ResponseEntity.ok().build();
        }
        publisher.publishEvent(new CanvasStepReached(payload.externalId(), payload.step()));
        return ResponseEntity.accepted().build();
    }
}
```

## 실무에서 걸리는 지점

- Audience 필터는 Entry 시점에 한 번 평가된다. 진입 후 국가나 구독 상태가 바뀐 사용자도 journey를 계속 타므로, 중간 재평가가 필요하면 Audience Filter Step을 끼우고 Exit 조건에 구독 해지를 넣는다. 구독 상태 동기화가 늦으면 수신 거부자에게 발송된다.
- Exit 조건 없이 goal에 도달한 사용자에게 후속 메시지가 계속 나가는 사고가 잦다. Cart Abandonment는 `checkout_completed`, Onboarding은 첫 결제처럼 goal event 자동 종료를 기본으로 두고 최대 기간(7일·30일)도 함께 건다.
- 마케터가 Liquid에서 쓰는 attribute·event property는 엔지니어가 실제로 보내는 것과 일치해야 한다. 서버가 보낸 적 없는 `preferred_category`를 참조하면 모든 사용자에게 빈 개인화가 나간다. 사용 가능한 attribute·event·trigger property 목록을 계약으로 명문화하고 default 값을 강제한다.
- 운영 중인 Canvas의 Audience·Flow·Goal 변경은 이미 진입한 사용자 경로를 흔든다. 콘텐츠 수정은 다음 발송부터 반영되어 안전하지만, 구조 변경은 새 Canvas를 만들고 기존 것은 진입만 끊는다.
- variant별 표본이 수백 명이면 검정력이 나오지 않는다. 각 variant 수천 명 이상, 1주 이상 운영 뒤 판단하고 우월한 variant는 100%로 전환한다. 도입 1년 뒤에도 캠페인 수가 그대로이고 A/B 실험이 없다면 도구가 아니라 운영 방식이 안 바뀐 것이다.

## 관련 글

- [Braze란 — 고객 참여 플랫폼의 5 핵심 개념](/notes/braze/what-is-braze/)
- [REST API와 Currents](/notes/braze/rest-api-currents/)
- [메시지 채널과 Liquid 개인화](/notes/braze/channels-liquid-personalization/)
