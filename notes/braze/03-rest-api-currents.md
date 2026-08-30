---
title: "REST API와 Currents"
series: braze
part: "개념과 통합"
order: 3
summary: "서버 이벤트로 Braze 발송을 트리거하고, Braze 안의 이벤트를 자사 데이터 인프라로 되가져오는 두 경로를 정리한다"
tags: [Braze, REST API, Currents, Messaging, Catalogs]
sources: [braze/2026-05-17-braze-rest-api-and-currents.md]
updated: 2026-08-30
---

SDK만으로 Braze를 운영하면 두 가지가 막힌다. 결제 완료·배송 상태 변경처럼 서버에서만 아는 사건을 발송 트리거로 쓸 수 없고, 발송·오픈·클릭 데이터가 Braze 콘솔 안에 갇혀 자사 BI나 추천 모델에서 쓸 수 없다. ==앞의 문제는 REST API가, 뒤의 문제는 Currents가 해결한다.==

## 핵심 개념

REST API는 9개 카테고리로 나뉘지만 백엔드가 실제로 손대는 것은 네 가지에 집중된다.

| 카테고리 | 대표 endpoint | 용도 |
|:---|:---|:---|
| User Data | `/users/track` `/users/identify` `/users/merge` `/users/delete` | 프로필 갱신, alias에 External ID 부여, 중복 통합, 삭제 |
| Messaging | `/messages/send` `/campaigns/trigger/send` `/canvas/trigger/send` | 발송 |
| Subscription | `/subscription/status/set` | 동의 그룹 갱신, 요청당 최대 50명 |
| Catalogs | `/catalogs/{name}/items` | 상품·콘텐츠 메타데이터 |

그 밖에 Email(bounce 해제·수신거부 목록), Data Export(캠페인·세그먼트 통계), Templates, Schedule, Live Activity·SMS가 있다.

### Messaging 3 endpoint의 분기

세 endpoint는 콘텐츠가 어디에 있느냐로 갈린다. `/messages/send`는 제목·본문을 요청에 담아 캠페인 없이 바로 보내므로 장애 안내 같은 소량 일회성 발송에 맞는다. `/campaigns/trigger/send`는 콘솔에서 만든 API-triggered 캠페인을 id로 지정하고 `trigger_properties`로 개인화 값만 넘긴다. 영수증·주문 상태 알림이 여기에 해당한다. `/canvas/trigger/send`는 다단계 journey인 Canvas의 진입점을 열고, `canvas_entry_properties`는 journey 전체 step에서 Liquid로 참조된다.

실무 호출의 대부분은 뒤의 두 trigger endpoint다. trigger 계열에는 re-eligibility 규칙이 붙어서, 콘솔에서 "사용자당 1회"로 설정된 캠페인은 API를 몇 번 호출해도 초과분을 조용히 건너뛴다. ==HTTP 201이 발송 성공을 뜻하지 않는다.==

### Catalogs

상품·게시글 메타데이터를 Braze 안에 두는 저장소다. 템플릿에서 `{% catalog_items %}`로 조회하면 가격·재고가 발송 시점 기준으로 치환되므로 매 호출마다 상품 정보를 실어 보낼 필요가 없다.

### Currents

Braze 안의 이벤트를 외부 destination으로 스트리밍하는 export 채널이다. destination은 S3·GCS 같은 스토리지, Snowflake 같은 웨어하우스, Kafka·Kinesis 같은 스트림, Mixpanel·mParticle 같은 분석·CDP 도구로 나뉜다. 이벤트는 채널별 발송·반응을 담는 Message events(`messages.email.Click` 등)와 사용자 행동·상태 변경을 담는 Behavior events(`users.behaviors.Purchase` 등) 두 계열이다. 각 이벤트는 `external_user_id`, Unix epoch `time`, `campaign_id` 또는 `canvas_id`, 그리고 이벤트별 필드를 가진다. destination 자원을 먼저 만들고 콘솔에서 export할 이벤트를 고른 뒤 활성화한다.

## 코드

Spring Boot 3.x `RestClient`로 Braze 호출을 감싼 클라이언트다. 429와 5xx는 지수 백오프로 재시도하고, External ID는 한 곳에서 정규화한다.

```java
@Component
public class BrazeClient {

    private final RestClient rest;

    public BrazeClient(RestClient.Builder builder,
                       @Value("${braze.endpoint}") String endpoint,
                       @Value("${braze.api-key}") String apiKey) {
        this.rest = builder
                .baseUrl(endpoint)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .build();
    }

    public static String normalizeExternalId(String raw) {
        return raw.strip().toLowerCase(Locale.ROOT);
    }

    @Retryable(retryFor = BrazeRetryableException.class, maxAttempts = 4,
               backoff = @Backoff(delay = 1000, multiplier = 2))
    public Map<String, Object> post(String path, Object body) {
        return rest.post()
                .uri(path)
                .body(body)
                .retrieve()
                .onStatus(s -> s.value() == 429 || s.is5xxServerError(),
                          (req, res) -> { throw new BrazeRetryableException(res.getStatusCode()); })
                .body(new ParameterizedTypeReference<>() {});
    }
}
```

결제 완료 도메인 이벤트를 받아 콘솔 캠페인을 trigger한다. 같은 주문의 중복 이벤트는 `order_id`로 걸러 재발송을 막는다.

```java
@Component
@RequiredArgsConstructor
public class OrderCompletedListener {

    private final BrazeClient braze;
    private final ProcessedEventRepository processed;

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderCompletedEvent event) {
        if (!processed.markIfAbsent("order-receipt:" + event.orderId())) {
            return;
        }
        var recipient = Map.of(
                "external_user_id", BrazeClient.normalizeExternalId(event.userId()),
                "trigger_properties", Map.of(
                        "order_id", event.orderId(),
                        "amount", event.totalAmount()));
        braze.post("/campaigns/trigger/send", Map.of(
                "campaign_id", "receipt-email",
                "recipients", List.of(recipient)));
    }
}
```

Currents가 Kafka로 내보낸 이메일 클릭 이벤트를 Spring Kafka로 소비한다. 스키마 변경에 대비해 고정 클래스 대신 `JsonNode`로 받는다.

```java
@Component
@RequiredArgsConstructor
public class CurrentsClickConsumer {

    private final ObjectMapper mapper;
    private final ClickTracker tracker;

    @KafkaListener(topics = "braze-currents", groupId = "engagement-tracker")
    public void consume(String payload) throws JsonProcessingException {
        JsonNode event = mapper.readTree(payload);
        if (!"messages.email.Click".equals(event.path("event_type").asText())) {
            return;
        }
        tracker.record(
                event.path("external_user_id").asText(),
                event.path("campaign_id").asText(null),
                event.path("url").asText(null),
                Instant.ofEpochSecond(event.path("time").asLong()));
    }
}
```

## 실무에서 걸리는 지점

- Rate limit. `/users/track`은 요청당 attributes·events·purchases를 각 75개까지 묶을 수 있다. 대량 마이그레이션은 75건 batch에 백오프를 붙이고 응답 헤더의 잔여 한도를 보며 동시성을 조절한다.
- 발송이 안 됐는데 에러가 없다. ==re-eligibility에 걸린 호출은 정상 응답 후 조용히 버려진다.== 콘솔 설정과 Currents의 Send 이벤트를 함께 본다.
- External ID 표기 불일치. SDK와 서버가 대소문자·공백이 다른 값을 보내면 사용자가 둘로 갈라진다. 이미 갈라진 프로필은 `/users/merge`로 합친다.
- Catalogs 동기화 지연. daily sync만 두면 신규 상품이 최대 하루 늦게 반영된다. 상품 변경 이벤트에 즉시 upsert를 붙이고 daily sync는 정합성 보정용으로 남긴다.
- Currents 비용과 스키마 변경. 모든 이벤트를 모든 destination으로 보내면 비용이 빠르게 오른다. 필요한 이벤트만 고르고 destination을 한두 개로 제한하며, 웨어하우스는 JSON 컬럼으로 받아 필드 추가에 대비한다.
- 삭제 요청의 부분 처리. 자사 DB만 지우고 `/users/delete`를 빠뜨리면 삭제된 사용자에게 메시지가 계속 나간다. 삭제 워크플로에 외부 vendor 호출과 감사 로그를 함께 넣는다.

## 관련 글

- [SDK 통합·Identity·데이터 모델](/notes/braze/sdk-identity-data-model/)
- [메시지 채널과 Liquid 개인화](/notes/braze/channels-liquid-personalization/)
- [Canvas·Campaign 운영과 도입 결정](/notes/braze/canvas-operations-adoption/)
