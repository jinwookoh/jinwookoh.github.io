---
title: "스트리밍 응답 — SSE·NDJSON"
series: reactive-spring
part: "WebFlux"
order: 11
summary: "Flux 반환만으로는 스트리밍이 되지 않는다. produces가 응답 형식을 결정하고 NDJSON과 SSE는 용도가 다르다."
tags: [WebFlux, SSE, NDJSON, Sinks, Backpressure]
sources: [2026-05-03-webflux-server-sent-events.md, 2026-05-03-webflux-streaming.md]
updated: 2026-08-29
---

컨트롤러가 `Flux<T>`를 반환해도 응답은 기본적으로 JSON 배열 하나다. WebFlux는 `produces`가 `application/json`이면 모든 원소를 모아 배열로 직렬화한 뒤 한 번에 내보낸다. DB에 100만 건이 있으면 100만 건이 메모리에 올라간 뒤 전송되고, 클라이언트는 그때까지 아무것도 받지 못한다. 대용량 조회나 실시간 알림처럼 준비된 원소부터 내보내야 하는 요구는 미디어 타입을 바꿔야 해결된다.

## 핵심 개념

리액티브 파이프라인과 HTTP 응답 방식은 별개다. `Flux`는 원소가 흐르는 파이프라인이고, 그것을 어떤 형식으로 쓰기 시작할지는 `produces`(또는 클라이언트 `Accept`)로 협상된 미디어 타입이 정한다.

| 미디어 타입 | 전송 방식 | 브라우저 지원 | 용도 |
|:---|:---|:---|:---|
| `application/json` | 전체 수집 후 배열 1회 전송 | 일반 fetch | 소량 조회 |
| `application/x-ndjson` | JSON 객체 1개를 1줄로 즉시 전송 | 직접 지원 없음, fetch 스트림으로 파싱 | 서비스 간 대용량 스트리밍 |
| `text/event-stream` | `data:` 블록 단위로 즉시 전송 | `EventSource` 내장 | 브라우저 실시간 푸시 |

NDJSON은 줄바꿈으로 구분된 JSON 객체의 나열이다. 이벤트 타입이나 재연결 개념은 없다.

SSE는 서버에서 클라이언트로 향하는 단방향 푸시다. 각 이벤트는 `data:`(본문), `event:`(타입, 기본값 `message`), `id:`(이벤트 식별자), `retry:`(재연결 간격 ms) 필드로 구성되며 빈 줄로 구분된다. `:`로 시작하는 줄은 주석이며 클라이언트는 무시한다. 브라우저 `EventSource`는 연결이 끊기면 스스로 재연결하고, 이때 마지막으로 받은 `id`를 `Last-Event-ID` 헤더로 보낸다. 서버가 이 헤더를 읽으면 끊긴 지점 이후부터 이어서 보낼 수 있다. 클라이언트에서 서버로 메시지를 보내야 한다면 SSE가 아니라 WebSocket이나 gRPC 양방향 스트리밍의 영역이다.

WebFlux에서 SSE 응답은 두 가지로 만든다. `Flux<T>`에 `TEXT_EVENT_STREAM_VALUE`를 붙이면 각 원소가 `data:` 필드에 JSON으로 직렬화된다. `id`·`event`·`retry`를 제어하려면 `Flux<ServerSentEvent<T>>`로 감싼다. 재연결 이어받기는 후자에서만 가능하다.

앞으로 발생할 이벤트를 연결된 구독자 전체에 전달하려면 명령형 코드에서 스트림에 원소를 주입할 통로가 필요하다. Reactor의 `Sinks.Many`가 그 역할이다. `unicast`는 구독자 1명만 허용하고, `multicast`는 구독 이전 원소를 전달하지 않으며, `replay().limit(n)`은 새 구독자에게 최근 n개를 재생한 뒤 실시간으로 이어간다. 끊겼다 돌아오는 클라이언트가 많은 SSE 알림에는 `replay`가 맞다.

Backpressure는 HTTP 스트리밍에서 별도 설정 없이 동작한다. Netty가 소켓의 쓰기 가능 상태에 맞춰 상위 Publisher에 `request`를 전달한다. `limitRate(n)`은 상위 파이프라인의 prefetch 크기를 제한하고 싶을 때만 추가한다.

## 코드

NDJSON과 SSE는 같은 파이프라인에 `produces`만 다르게 붙이면 된다. `delayElements`는 로컬에서 흐름을 눈으로 확인하기 위한 것이므로 운영 코드에는 남기지 않는다.

```java
@RestController
@RequestMapping("/products")
@RequiredArgsConstructor
public class ProductStreamController {

    private final ProductRepository productRepository;

    @GetMapping(value = "/ndjson", produces = MediaType.APPLICATION_NDJSON_VALUE)
    public Flux<Product> streamNdjson() {
        return productRepository.findAll()
                .limitRate(64)
                .doOnCancel(() -> log.info("client disconnected"));
    }

    @GetMapping(value = "/sse", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<Product> streamSse() {
        return productRepository.findAll();
    }

    @PostMapping(value = "/bulk", consumes = MediaType.APPLICATION_NDJSON_VALUE)
    public Mono<Long> uploadBulk(@RequestBody Flux<ProductDto> body) {
        return body.map(ProductDto::toEntity)
                .flatMap(productRepository::save)
                .count();
    }
}
```

신규 상품이 저장될 때마다 연결된 모든 클라이언트에 알리고, 재연결한 클라이언트는 `Last-Event-ID` 이후부터 이어받는다. 하트비트는 주석 이벤트로 보내 프록시 유휴 타임아웃을 막는다.

```java
@Service
@RequiredArgsConstructor
public class ProductEventService {

    private final ProductRepository productRepository;
    private final Sinks.Many<Product> sink = Sinks.many().replay().limit(100);

    public Mono<Product> save(ProductDto dto) {
        return productRepository.save(dto.toEntity())
                .doOnSuccess(saved -> {
                    Sinks.EmitResult result = sink.tryEmitNext(saved);
                    if (result.isFailure()) {
                        log.warn("emit failed: {}", result);
                    }
                });
    }

    public Flux<ServerSentEvent<Product>> events(String lastEventId) {
        long from = lastEventId == null ? 0L : Long.parseLong(lastEventId);

        Flux<ServerSentEvent<Product>> missed = productRepository.findByIdGreaterThan(from)
                .map(this::toEvent);
        Flux<ServerSentEvent<Product>> live = sink.asFlux()
                .filter(p -> p.getId() > from)
                .map(this::toEvent);
        Flux<ServerSentEvent<Product>> heartbeat = Flux.interval(Duration.ofSeconds(25))
                .map(t -> ServerSentEvent.<Product>builder().comment("keep-alive").build());

        return Flux.merge(Flux.concat(missed, live), heartbeat);
    }

    private ServerSentEvent<Product> toEvent(Product p) {
        return ServerSentEvent.<Product>builder()
                .id(String.valueOf(p.getId()))
                .event("product-added")
                .data(p)
                .retry(Duration.ofSeconds(3))
                .build();
    }
}
```

```java
@GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<Product>> events(
        @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId) {
    return productEventService.events(lastEventId);
}
```

무한 스트림 테스트는 `expectComplete` 대신 `thenCancel`로 끝낸다.

```java
@Test
void streamsProducts() {
    webTestClient.get().uri("/products/ndjson")
            .accept(MediaType.APPLICATION_NDJSON)
            .exchange()
            .expectStatus().isOk()
            .returnResult(Product.class)
            .getResponseBody()
            .as(StepVerifier::create)
            .expectNextCount(10)
            .thenCancel()
            .verify();
}
```

## 실무에서 걸리는 지점

- **`produces` 누락.** `Flux<T>`만 반환하면 JSON 배열로 전체 수집 후 전송된다. 스트리밍이 안 되는 것뿐 아니라 대용량 조회에서 OOM으로 이어진다. `curl`도 기본 버퍼링을 하므로 확인할 때는 `curl -N`을 붙인다.
- **Sink 스코프.** 요청 핸들러 안에서 `Sinks.many()`를 만들면 매 요청마다 아무도 발행하지 않는 새 Sink가 생긴다. Sink는 싱글톤 빈의 필드로 두고 `asFlux()`만 노출한다. `replay().all()`은 원소를 무한히 보관하므로 `limit(n)` 또는 `limit(Duration)`으로 제한한다.
- **`tryEmitNext` 결과 무시.** 반환값 `EmitResult`가 `FAIL_ZERO_SUBSCRIBER`, `FAIL_OVERFLOW`, `FAIL_NON_SERIALIZED`일 수 있다. 여러 스레드에서 동시에 발행한다면 `emitNext`에 `EmitFailureHandler`를 넘긴다.
- **커밋 전 발행.** `doOnNext`에서 이벤트를 내보내면 구독자가 아직 커밋되지 않은 행을 조회할 수 있다. 저장 `Mono`의 `doOnSuccess` 또는 트랜잭션 커밋 이후 시점에서 발행한다.
- **프록시 유휴 타임아웃.** 이벤트가 뜸한 SSE 연결은 로드밸런서가 끊는다. 주석 이벤트로 하트비트를 보내고 프록시의 응답 버퍼링을 끈다. 재연결 시 `Last-Event-ID`를 처리하지 않으면 그 사이 이벤트는 유실된다.
- **클라이언트 스트리밍의 완료 신호.** `@RequestBody Flux<T>`를 `count()`로 마무리하는 핸들러는 요청 본문이 `onComplete`되어야 응답한다. 클라이언트가 스트림을 닫지 않으면 응답이 나가지 않으므로 타임아웃을 둔다.

## 관련 글

- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [Backpressure](/notes/reactive-spring/backpressure/)
- [WebClient](/notes/reactive-spring/webclient/)
