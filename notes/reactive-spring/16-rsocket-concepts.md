---
title: "RSocket — 개념·프레임·Interaction Model"
series: reactive-spring
part: "RSocket"
order: 16
summary: "RSocket이 단일 연결 위에서 REQUEST_N 백프레셔와 4가지 Interaction Model로 서비스 간 통신을 처리하는 원리"
tags: [RSocket, Reactive Streams, Backpressure, Interaction Model, Spring Boot]
sources: [2026-05-03-rsocket-basics.md, 2026-05-03-rsocket-interaction-models.md, 2026-05-03-rsocket-vs-grpc-websocket.md]
updated: 2026-08-29
---

서비스 간 통신을 HTTP로만 구성하면 스트리밍과 양방향 통신에서 한계가 드러난다. HTTP/2는 애플리케이션 수준의 흐름 제어가 없고, WebSocket은 메시지에 의미가 없어 수신 측이 처리하지 못해도 송신 측은 계속 보낸다. gRPC는 HTTP/2 흐름 제어에 기대므로 Reactive Streams의 `request(n)`과 직접 연결되지 않는다. 서버가 10만 건을 스트리밍하는데 클라이언트가 느리면 메모리가 쌓이다 OOM이 난다. ==RSocket은 Reactive Streams 명세를 프로토콜 수준으로 끌어올려 이 문제를 해결한다.==

## 핵심 개념

RSocket은 Reactive Streams 위에 정의된 바이너리 메시징 프로토콜이다. 전송 계층은 분리되어 TCP가 일반적이며, 브라우저 환경은 WebSocket, 초저지연은 Aeron(UDP)을 쓴다.

### 연결과 스트림

클라이언트는 연결 시작 시 SETUP 프레임을 한 번 보낸다. keepalive 간격, lifetime, MIME 타입, resume token, 인증 정보가 여기에 담긴다. 이후 하나의 연결 위에 여러 스트림이 Stream ID로 구분되어 동시에 흐르며, HTTP/2 다중화와 달리 스트림마다 요청·응답·취소·흐름 제어의 의미가 프로토콜에 정의되어 있다. 연결이 끊기면 resume token으로 재연결해 끊어진 지점부터 이어갈 수 있다.

### 프레임 구조

프레임이 데이터 단위다. 헤더 6바이트(Stream ID 4바이트 + Type과 Flags 2바이트) 뒤에 선택적인 Metadata와 Data가 따른다.

| 프레임 | 역할 |
|:---|:---|
| SETUP | 연결 시작, 연결당 한 번 |
| REQUEST_* | 4가지 모델의 요청 (RESPONSE·FNF·STREAM·CHANNEL) |
| PAYLOAD | 데이터 전달 |
| REQUEST_N | N개 더 받을 수 있음을 통보 |
| CANCEL / ERROR / KEEPALIVE | 취소 / 에러 / 연결 유지 |

핵심은 REQUEST_N이다. `Subscription.request(n)`이 그대로 프레임으로 전송되어, 클라이언트가 REQUEST_N(10)을 보내면 서버는 10개만 보내고 다음 REQUEST_N을 기다린다. ==흐름 제어가 TCP 윈도우가 아니라 프로토콜 의미론 안에서 이뤄진다는 점이 다른 프로토콜과의 결정적 차이다.==

### 4가지 Interaction Model

| 모델 | 입력 | 출력 | Spring 시그니처 |
|:---|:---:|:---:|:---|
| Request-Response | 1 | 1 | `Mono<T>` |
| Fire-and-Forget | 1 | 0 | `Mono<Void>` |
| Request-Stream | 1 | N | `Flux<T>` |
| Channel | N | N | `Flux<T>` → `Flux<R>` |

Request-Response는 HTTP와 같은 1:1이다. Fire-and-Forget은 응답이 없어 로깅·메트릭처럼 유실을 감수할 수 있는 곳에 쓴다. Request-Stream은 시세·로그 스트리밍처럼 SSE가 쓰이던 자리를 백프레셔를 갖춘 채 대체한다. Channel은 양쪽이 Flux를 주고받는 N:N 모델로 채팅·협업 편집에 쓴다. gRPC의 4가지 스트리밍 모드와 1:1로 대응하지만, 백프레셔가 프로토콜 표준이고 Reactive 타입과 직접 매핑된다는 점이 다르다.

한 라우트는 한 모델만 가진다. `@MessageMapping` 메서드가 `Mono`를 반환하면 Request-Response 또는 Fire-and-Forget, `Flux`를 반환하면 Request-Stream 또는 Channel로 동작하며, 같은 연결 위에 4개 모델이 공존한다.

스키마는 강제하지 않고 JSON·Protobuf·CBOR를 인코더로 선택한다. 공개 API는 gRPC, 브라우저는 WebSocket, WebFlux 기반 내부 통신은 RSocket으로 계층별로 섞어 쓴다.

## 코드

`spring-boot-starter-rsocket`을 추가하면 `RSocketRequester.Builder`와 서버 설정이 자동 구성된다.

```yaml
spring:
  rsocket:
    server:
      port: 7000
      transport: tcp
```

한 컨트롤러에 4가지 모델을 모두 선언한다. 반환 타입과 파라미터 타입이 모델을 결정한다.

```java
@Controller
public class TradingController {

    private final OrderService orderService;
    private final PriceService priceService;
    private final ChatRoom chatRoom;

    public TradingController(OrderService orderService,
                             PriceService priceService,
                             ChatRoom chatRoom) {
        this.orderService = orderService;
        this.priceService = priceService;
        this.chatRoom = chatRoom;
    }

    // Request-Response: 1 -> 1
    @MessageMapping("order.place")
    public Mono<OrderResult> place(Order order) {
        return orderService.place(order);
    }

    // Fire-and-Forget: 1 -> 0
    @MessageMapping("event.log")
    public Mono<Void> log(LogEvent event) {
        return orderService.audit(event);
    }

    // Request-Stream: 1 -> N
    @MessageMapping("price.{symbol}")
    public Flux<Price> prices(@DestinationVariable String symbol) {
        return priceService.stream(symbol);
    }

    // Channel: N -> N
    @MessageMapping("chat.{room}")
    public Flux<ChatMessage> chat(@DestinationVariable String room,
                                  Flux<ChatMessage> incoming) {
        return incoming
                .flatMap(msg -> chatRoom.publish(room, msg))
                .thenMany(chatRoom.subscribe(room));
    }
}
```

클라이언트는 자동 구성된 `RSocketRequester.Builder`로 연결하고 모델별로 `retrieveMono`·`send`·`retrieveFlux`를 호출한다. `flatMap`의 동시성 값이 REQUEST_N으로 전달된다.

```java
@Component
public class TradingClient {

    private final RSocketRequester requester;

    public TradingClient(RSocketRequester.Builder builder) {
        this.requester = builder.tcp("localhost", 7000);
    }

    public Mono<OrderResult> place(Order order) {
        return requester.route("order.place")
                .data(order)
                .retrieveMono(OrderResult.class);
    }

    public Mono<Void> log(LogEvent event) {
        return requester.route("event.log")
                .data(event)
                .send();
    }

    public Flux<Price> watch(String symbol) {
        return requester.route("price.{symbol}", symbol)
                .retrieveFlux(Price.class)
                .flatMap(this::persist, 4);   // REQUEST_N(4)로 서버 페이스 제한
    }

    public Flux<ChatMessage> join(String room, Flux<ChatMessage> outgoing) {
        return requester.route("chat.{room}", room)
                .data(outgoing)
                .retrieveFlux(ChatMessage.class);
    }

    private Mono<Price> persist(Price price) {
        return Mono.just(price);
    }
}
```

## 실무에서 걸리는 지점

- **Fire-and-Forget은 전달을 보장하지 않는다.** 유실이 허용되지 않으면 Request-Response로 ack를 받거나 영속 메시지 큐를 쓴다.
- **SETUP은 연결당 한 번이다.** MIME 타입·인증 정보는 연결 시점에 고정되므로, 토큰 갱신처럼 연결 중 바뀌는 값은 요청별 메타데이터로 보낸다.
- **에러는 ERROR 프레임으로 전달되며 예외 타입이 보존되지 않는다.** 서버의 `RuntimeException`은 클라이언트에서 `ApplicationErrorException`으로 도착하므로 비즈니스 에러는 페이로드에 코드를 담는다.
- **백프레셔는 구독자가 요청량을 제한해야 동작한다.** ==`subscribe()`만 호출하면 무제한 요청이 되어 REQUEST_N이 의미를 잃는다.== `flatMap(fn, concurrency)`·`limitRate`·`BaseSubscriber`로 명시한다.
- **TCP 전송은 HTTP 인프라를 통과하지 못한다.** L7 로드 밸런서를 재사용하려면 WebSocket 전송을 택한다.

## 관련 글

- [Backpressure](/notes/reactive-spring/backpressure/)
- [RSocket — 서버·클라이언트·메타데이터 라우팅](/notes/reactive-spring/rsocket-server-client/)
- [gRPC — 개념·HTTP/2·Protobuf](/notes/reactive-spring/grpc-concepts-protobuf/)
