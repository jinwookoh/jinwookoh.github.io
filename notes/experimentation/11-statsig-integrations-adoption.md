---
title: "통합·운영·도입 결정"
series: experimentation
part: "Statsig"
order: 11
summary: "Statsig를 사내 도구와 연결하는 통합 계층, 부수 기능의 비용·privacy, 도입 여부를 가르는 결정 기준을 정리한다."
tags: [Statsig, Webhook, OpenTelemetry, Session Replay, MCP]
sources: [statsig/2026-05-17-statsig-integrations-deep.md, statsig/2026-05-17-statsig-companion-features.md, statsig/2026-05-17-statsig-wrap-up.md]
updated: 2026-08-30
---

Statsig가 사내 다른 시스템과 단절되어 있으면 운영 부담은 줄지 않는다. Segment로 수집 중인 이벤트를 SDK로 한 번 더 보내야 하고, 실험 결과는 콘솔을 열어야 보이며, gate 변경 이력은 컴플라이언스용 저장소에 남지 않는다. 인프라 지표와 제품 지표가 따로 놓여 실험이 latency에 준 영향을 사람이 두 대시보드를 비교해 추정한다. ==통합 계층이 이 단절을 메우고, 부수 기능과 도입 결정은 어디까지 확장할지를 정한다.==

## 핵심 개념

통합은 네 범주다. CDP(Segment·Rudderstack·Hightouch·mParticle)는 한 번의 `track` 호출을 여러 destination에 분배하므로 Statsig를 destination으로 추가하면 SDK의 `logEvent`를 따로 심지 않아도 된다. ==핵심은 user ID mapping이다.== 로그인 전 anonymousId와 로그인 후 userId를 `userID`·`customIDs`에 일관되게 대응시키지 않으면 같은 사용자가 두 entity로 갈라져 variant가 바뀐다.

메시징은 Slack이다. Product·General·Personal 세 카테고리를 releases·experiments·results·audit·alerts 채널로 나눠 팀별로 구독하고, Daily Digest로 수동 확인을 대체한다.

운영 통합은 Webhook·Console REST API·MCP다. Webhook은 gate 변경이나 실험 종료 이벤트를 지정 URL로 POST하며, 수신 측은 HMAC-SHA256 서명으로 위조를 차단하고 재시도에 대비해 멱등하게 처리한다. Console API는 콘솔의 모든 작업을 노출하므로 gate 정의를 YAML로 git에 두고 CI에서 동기화하는 gate-as-code가 가능하다. MCP는 Console API를 AI 개발 도구(Claude Code·Cursor 등)가 호출하도록 감싼 서버로 Gate·Experiment·Metric 등 7범주를 조회·생성한다.

모니터링은 OpenTelemetry가 축이다. 애플리케이션은 vendor-neutral OTel SDK로 metric·trace·log를 내보내고 Collector가 Statsig와 Datadog으로 동시에 export한다. Infra Analytics(Log Explorer·Alerts·Metrics Explorer)를 Product Analytics와 결합하면 gate를 켠 순간의 전환율 상승과 p99 latency 악화를 한 화면에서 대조한다.

부수 기능은 셋이다. Session Replay는 rrweb 기반으로 DOM 변화와 입력 이벤트 시퀀스를 기록해 재생한다. 5분 세션이 수백 KB라 5~10% 샘플링이나 조건부 기록이 필수이고, `maskInputs` 활성·`data-private` 마킹·동의 배너 없이 production에 올리면 privacy 사고가 된다. Web Analytics는 GA를 대체하기보다 실험 결합 분석용으로 병행한다.

도입 결정은 사용자 규모, 연간 실험 건수, 데이터 통제 요구, 기존 stack, 분석 인력, 예산 등으로 판단한다. 연 실험 4건 미만이거나 사용자 1,000명 미만이면 수작업이 낫고, 통제 요구가 강하면 Warehouse Native를 검토한다. Flag만 필요하면 LaunchDarkly·GrowthBook, self-host가 필수면 PostHog가 대안이며, Flag·실험·분석을 한 데이터로 묶는 가치가 클 때 Statsig가 우세하다. 마이그레이션은 진행 중 실험을 기존 도구에서 끝낸 뒤 새 실험부터 옮긴다.

## 코드

Webhook 수신 컨트롤러. 원본 바이트로 HMAC-SHA256을 계산해 서명 헤더와 상수 시간 비교하고, 이벤트 ID 기준으로 중복을 걸러 재시도에 멱등하게 대응한다.

```java
@RestController
@RequestMapping("/webhooks/statsig")
public class StatsigWebhookController {

    private final String secret;
    private final AuditEventRepository auditRepo;

    public StatsigWebhookController(@Value("${statsig.webhook-secret}") String secret,
                                    AuditEventRepository auditRepo) {
        this.secret = secret;
        this.auditRepo = auditRepo;
    }

    @PostMapping
    public ResponseEntity<Void> receive(@RequestBody byte[] body,
                                        @RequestHeader("X-Statsig-Signature") String signature) {
        if (!MessageDigest.isEqual(hmacHex(body).getBytes(StandardCharsets.UTF_8),
                                   signature.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        StatsigEvent event = parse(body);
        if (auditRepo.existsByEventId(event.id())) {
            return ResponseEntity.ok().build();
        }
        auditRepo.save(AuditEvent.from(event, Instant.now()));
        return ResponseEntity.ok().build();
    }

    private String hmacHex(byte[] body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(body));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

Console API로 오래된 temporary gate를 archive하는 클라이언트. `RestClient`를 쓰고, 429 응답에는 지수 backoff로 재시도한다.

```java
@Component
public class GateCleanupClient {

    private final RestClient client;

    public GateCleanupClient(RestClient.Builder builder,
                             @Value("${statsig.console-key}") String consoleKey) {
        this.client = builder
            .baseUrl("https://statsigapi.net/console/v1")
            .defaultHeader("STATSIG-API-KEY", consoleKey)
            .build();
    }

    public List<Gate> listGates() {
        return client.get().uri("/gates").retrieve()
            .body(GatePage.class).data();
    }

    @Retryable(retryFor = HttpClientErrorException.TooManyRequests.class,
               maxAttempts = 5,
               backoff = @Backoff(delay = 1000, multiplier = 2))
    public void archive(String gateId) {
        client.patch().uri("/gates/{id}", gateId)
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("isArchived", true))
            .retrieve().toBodilessEntity();
    }

    public void archiveStale(Instant cutoff) {
        listGates().stream()
            .filter(g -> g.lastModified().isBefore(cutoff))
            .forEach(g -> archive(g.id()));
    }
}
```

애플리케이션 측 OTel 계측. Spring Boot의 OpenTelemetry 자동 구성이 제공하는 `Meter`로 카운터를 만들고, Collector가 Statsig와 Datadog으로 분배한다.

```java
@Service
public class CheckoutService {

    private final LongCounter checkoutCounter;

    public CheckoutService(OpenTelemetry otel) {
        this.checkoutCounter = otel.getMeter("com.example.checkout")
            .counterBuilder("checkout.requests")
            .setDescription("Number of checkout requests")
            .build();
    }

    public void process(CheckoutCommand cmd) {
        // 비즈니스 로직
        checkoutCounter.add(1, Attributes.of(
            AttributeKey.stringKey("payment.method"), cmd.paymentMethod(),
            AttributeKey.stringKey("service"), "checkout"));
    }
}
```

## 실무에서 걸리는 지점

- Webhook endpoint가 일시 중단되면 Statsig가 재시도하므로 같은 이벤트가 여러 번 도착한다. 이벤트 ID로 중복을 거르지 않으면 audit DB 이중 기록이나 배포 자동화 중복 실행이 생긴다.
- Console API에는 분당 rate limit이 있어 대량 cleanup 시 429가 난다. backoff와 시간 분산이 필요하고, 키가 git history에 남으면 즉시 rotation한다.
- ==MCP에 콘솔 전체 권한을 주면 AI 도구가 production gate를 실수로 바꿀 수 있다.== read-only로 시작해 저위험 범주부터 write를 넓히고 production gate 변경은 사람이 확인한다.
- OTel metric label에 user_id·request_id 같은 high cardinality 값을 넣으면 시계열이 폭증한다. Collector 단일 인스턴스는 단일 실패점이므로 다중 인스턴스로 둔다.
- Daily Digest는 전날 이벤트가 덜 도착한 상태에서 발송되면 지표가 거짓으로 하락해 보이므로 24~48시간 delay window를 둔다. Web Analytics와 GA는 샘플링·bot 필터가 달라 절대값이 아닌 추세로 비교한다.

## 관련 글

- [Feature Flags와 Experiments](/notes/experimentation/statsig-flags-experiments/)
- [Product Analytics와 Warehouse Native](/notes/experimentation/statsig-analytics-warehouse/)
- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
