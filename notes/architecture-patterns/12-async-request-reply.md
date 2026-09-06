---
title: "비동기 요청-응답 — 오래 걸리는 작업과 폴링"
series: architecture-patterns
part: "서비스 통신"
order: 12
summary: "긴 작업은 202로 접수하고 상태 리소스를 따로 두며, 완료 통지는 클라이언트 위치에 따라 폴링과 웹훅 중 고른다"
tags: [Asynchronous Request-Reply, Polling, Webhook, 202 Accepted, Spring Boot]
sources: [https://jinwookoh.tistory.com/245]
updated: 2026-09-06
---

리포트 생성이나 대량 파일 변환처럼 수 분이 걸리는 작업을 HTTP 요청 하나로 처리하면 응답이 오기 전에 연결이 끊긴다. 로드 밸런서와 리버스 프록시의 유휴 타임아웃은 보통 60초 안팎이고, 브라우저와 HTTP 클라이언트도 각자 읽기 타임아웃을 가진다. 연결이 끊겨도 서버는 작업을 계속하므로 결과는 버려지고, 클라이언트가 재시도하면 같은 작업이 두 번 실행된다. 요청을 처리하는 서블릿 스레드가 그 시간 동안 점유되므로 동시 요청이 몇십 개만 쌓여도 스레드 풀이 고갈돼 무관한 요청까지 대기한다. 비동기 요청-응답 패턴은 요청 접수와 결과 전달을 분리해 이 문제를 피한다.

## 핵심 개념

서버는 작업을 즉시 실행하지 않고 큐나 작업 테이블에 등록한 뒤 `202 Accepted`로 응답한다. 응답에는 작업 상태를 조회할 수 있는 URL을 `Location` 헤더로 실어 보낸다. 이 시점에 HTTP 연결은 끝나고, 실제 작업은 별도 워커가 처리한다. 작업은 `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` 같은 상태를 가지며 상태 조회 리소스는 이 값을 반환한다. 완료된 뒤에는 결과 리소스로 안내한다.

완료 사실을 클라이언트가 알아내는 방법은 두 가지다.

폴링은 클라이언트가 상태 URL을 주기적으로 호출하는 방식이다. 클라이언트에 HTTP 클라이언트만 있으면 되고, 요청 방향이 항상 클라이언트에서 서버로 향하므로 클라이언트가 사설망이나 NAT 뒤에 있어도 동작한다. 브라우저와 모바일 앱은 공인 주소로 요청을 받을 수 없으므로 폴링이 사실상 유일한 선택이다. 단점은 대부분의 요청이 "아직"이라는 답만 받는다는 점과, 완료 시점이 아니라 다음 폴링 주기에 완료를 알게 된다는 지연이다. 서버는 `Retry-After` 헤더로 다음 조회까지 기다릴 시간을 알려 주고, 클라이언트는 조회 간격을 점차 늘려 부하를 줄인다.

웹훅은 클라이언트가 요청 시 콜백 URL을 함께 등록하고, 서버가 작업 완료 후 그 URL로 결과를 POST하는 방식이다. 불필요한 조회가 없고 완료 즉시 통지된다. 대신 클라이언트가 외부에서 접근 가능한 수신 엔드포인트를 열어야 하고, 그 요청이 실제로 서버가 보낸 것인지 검증하는 서명 절차가 필요하다. 결제 승인 통지, 외부 API 연동 같은 서버 간 통신에서 표준으로 쓰인다.

| 구분 | 폴링 | 웹훅 |
|---|---|---|
| 통신 방향 | 클라이언트 → 서버, 반복 | 서버 → 클라이언트, 완료 시 1회 이상 |
| 클라이언트 요건 | HTTP 클라이언트 | 공인 수신 엔드포인트, 서명 검증 |
| 완료 인지 지연 | 폴링 주기만큼 | 즉시 |
| 적합한 경우 | 브라우저, 모바일, 방화벽 뒤 클라이언트 | 서버 간 연동, 긴 작업 |

한 서비스가 두 방식을 모두 제공하는 경우도 흔하다. 웹훅을 주 경로로 쓰되 통지가 유실됐을 때를 대비해 상태 조회 API를 남겨 두는 구성이다.

## 코드

작업을 접수해 `202`와 상태 URL을 돌려주고, 상태 조회에서는 진행 중이면 `Retry-After`를, 완료면 결과 위치로 `303`을 반환하는 컨트롤러다.

```java
@RestController
@RequestMapping("/reports")
public class ReportController {

    private final ReportJobService jobService;

    public ReportController(ReportJobService jobService) {
        this.jobService = jobService;
    }

    @PostMapping
    public ResponseEntity<Void> submit(@RequestBody ReportRequest request,
                                       @RequestHeader("Idempotency-Key") String idempotencyKey) {
        String jobId = jobService.submit(request, idempotencyKey);
        return ResponseEntity.accepted()
                .location(URI.create("/reports/" + jobId + "/status"))
                .build();
    }

    @GetMapping("/{jobId}/status")
    public ResponseEntity<JobStatusResponse> status(@PathVariable String jobId) {
        ReportJob job = jobService.find(jobId);
        return switch (job.status()) {
            case COMPLETED -> ResponseEntity.status(HttpStatus.SEE_OTHER)
                    .location(URI.create("/reports/" + jobId + "/result"))
                    .build();
            case FAILED -> ResponseEntity.ok(new JobStatusResponse("FAILED", job.errorMessage()));
            default -> ResponseEntity.ok()
                    .header(HttpHeaders.RETRY_AFTER, "5")
                    .body(new JobStatusResponse(job.status().name(), null));
        };
    }
}
```

작업 상태는 여러 인스턴스가 공유하는 저장소에 두고, 실제 처리는 `@Async` 워커에 넘긴다. 완료 후 콜백 URL이 등록돼 있으면 `RestClient`로 HMAC 서명을 붙여 웹훅을 보낸다.

```java
@Service
public class ReportJobService {

    private final ReportJobRepository repository;
    private final RestClient restClient;
    private final byte[] webhookSecret;

    public ReportJobService(ReportJobRepository repository,
                            RestClient.Builder builder,
                            @Value("${webhook.secret}") String secret) {
        this.repository = repository;
        this.restClient = builder.build();
        this.webhookSecret = secret.getBytes(StandardCharsets.UTF_8);
    }

    @Transactional
    public String submit(ReportRequest request, String idempotencyKey) {
        return repository.findByIdempotencyKey(idempotencyKey)
                .map(ReportJob::id)
                .orElseGet(() -> {
                    ReportJob job = ReportJob.pending(UUID.randomUUID().toString(),
                            idempotencyKey, request.callbackUrl());
                    repository.save(job);
                    process(job.id(), request);
                    return job.id();
                });
    }

    @Async
    public void process(String jobId, ReportRequest request) {
        repository.updateStatus(jobId, JobStatus.RUNNING);
        try {
            String resultUri = generateReport(request);
            repository.complete(jobId, resultUri);
            if (request.callbackUrl() != null) {
                notify(jobId, request.callbackUrl(), resultUri);
            }
        } catch (Exception e) {
            repository.fail(jobId, e.getMessage());
        }
    }

    private void notify(String jobId, String callbackUrl, String resultUri) {
        String body = """
                {"eventId":"%s","jobId":"%s","status":"COMPLETED","resultUri":"%s"}
                """.formatted(UUID.randomUUID(), jobId, resultUri).strip();
        long timestamp = Instant.now().getEpochSecond();
        restClient.post()
                .uri(callbackUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Webhook-Timestamp", String.valueOf(timestamp))
                .header("X-Webhook-Signature", sign(timestamp + "." + body))
                .body(body)
                .retrieve()
                .toBodilessEntity();
    }

    private String sign(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(webhookSecret, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

수신 측은 서명을 검증하고 이벤트 ID로 중복을 걸러낸 뒤, 무거운 후속 처리는 큐에 넘기고 곧바로 응답한다.

```java
@RestController
public class ReportWebhookController {

    private final WebhookSignatureVerifier verifier;
    private final ProcessedEventRepository processedEvents;
    private final ApplicationEventPublisher publisher;

    public ReportWebhookController(WebhookSignatureVerifier verifier,
                                   ProcessedEventRepository processedEvents,
                                   ApplicationEventPublisher publisher) {
        this.verifier = verifier;
        this.processedEvents = processedEvents;
        this.publisher = publisher;
    }

    @PostMapping("/hooks/report-finished")
    public ResponseEntity<Void> onReportFinished(@RequestBody String rawBody,
                                                 @RequestHeader("X-Webhook-Timestamp") long timestamp,
                                                 @RequestHeader("X-Webhook-Signature") String signature) {
        if (!verifier.verify(timestamp, rawBody, signature)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        ReportFinished event = ReportFinished.parse(rawBody);
        if (!processedEvents.markIfAbsent(event.eventId())) {
            return ResponseEntity.ok().build();
        }
        publisher.publishEvent(event);
        return ResponseEntity.ok().build();
    }
}
```

## 실무에서 걸리는 지점

- 작업 상태를 인스턴스의 메모리 맵에 두면 폴링 요청이 로드 밸런서를 거쳐 다른 인스턴스로 갈 때 존재하지 않는 작업으로 처리된다. ==상태는 DB나 Redis처럼 모든 인스턴스가 공유하는 저장소에 두고, 완료된 작업의 보관 기간과 결과 파일의 만료 정책을 함께 정한다.==
- 접수 요청 자체가 중복될 수 있다. `202`를 받기 전에 연결이 끊긴 클라이언트는 같은 요청을 다시 보내고, 서버는 같은 작업을 두 번 등록한다. 멱등 키를 받아 같은 키의 작업을 반환하는 처리가 접수 단계에 필요하다.
- 상태 조회에 `303`을 쓰면 `fetch`와 대부분의 HTTP 클라이언트가 리다이렉트를 자동으로 따라가 결과 본문을 그대로 받는다. 결과가 대용량 파일이면 폴링 클라이언트가 의도치 않게 파일을 내려받으므로, 그런 경우 `200`에 결과 URL을 담은 JSON을 돌려주는 편이 안전하다.
- 웹훅 전송은 수신 측 장애나 네트워크 오류로 실패할 수 있어 재시도가 붙고, 재시도가 붙는 순간 같은 통지가 두 번 도착할 수 있다. ==수신 측은 이벤트 ID로 중복을 걸러내야 하며, 송신 측은 재시도 횟수를 초과한 통지를 별도 큐에 남겨 수동 복구 경로를 확보해야 한다.== 수신 핸들러가 무거운 처리를 동기로 수행하면 송신 측 타임아웃에 걸려 불필요한 재시도를 유발하므로, 검증과 중복 제거만 하고 즉시 응답한다.
- 콜백 URL은 외부에서 들어온 입력이다. ==검증 없이 그대로 요청을 보내면 내부 관리 API나 메타데이터 엔드포인트로 서버가 대신 요청을 날리는 SSRF가 된다.== 스킴을 HTTPS로 제한하고 사설 대역과 루프백 주소를 차단하며, 가능하면 등록 시점에 소유권 확인을 거친다. 서명 검증에서는 타임스탬프를 페이로드에 포함해 재전송 공격 창을 좁히고, 비교는 `MessageDigest.isEqual` 같은 상수 시간 비교를 쓴다.

## 관련 글

- [메시징 — Point-to-Point와 Pub/Sub, 소비 모델](/notes/architecture-patterns/messaging/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
