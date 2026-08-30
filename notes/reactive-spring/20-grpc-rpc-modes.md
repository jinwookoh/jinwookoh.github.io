---
title: "gRPC — Unary·Server/Client/Bidirectional Streaming"
series: reactive-spring
part: "gRPC"
order: 20
summary: "gRPC 4가지 RPC 모드가 StreamObserver 하나로 어떻게 구분되고, 각각 언제 쓰는지 정리한다"
tags: [gRPC, StreamObserver, Streaming, reactor-grpc, Spring Boot]
sources: [2026-05-03-grpc-unary.md, 2026-05-03-grpc-server-streaming.md, 2026-05-03-grpc-client-streaming.md, 2026-05-03-grpc-bidirectional.md]
updated: 2026-08-29
---

REST는 요청 하나에 응답 하나라는 형태만 제공한다. 대용량 목록은 페이지 단위로 반복 호출하고, 실시간 알림은 폴링이나 별도 WebSocket 채널을 열고, 대량 업로드는 개별 호출로 쪼개야 한다. 통신 형태마다 프로토콜과 코드 패턴, 에러 모델이 달라진다. gRPC는 하나의 서비스 정의 안에서 네 가지 RPC 모드를 제공하며, 모두 같은 `StreamObserver` 인터페이스와 상태 코드 체계로 동작한다.

## 핵심 개념

네 모드는 proto 정의에서 요청과 응답 어느 쪽에 `stream`이 붙었는지로 결정된다.

| 모드 | proto 시그니처 | 흐름 | 대표 용도 |
|:---|:---|:---|:---|
| Unary | `rpc M (Req) returns (Res)` | 1:1 | 조회·단건 명령 |
| Server Streaming | `rpc M (Req) returns (stream Res)` | 1:N | 대용량 목록, 알림, 로그 tail |
| Client Streaming | `rpc M (stream Req) returns (Res)` | N:1 | 이벤트 배치, 청크 업로드, 집계 |
| Bidirectional | `rpc M (stream Req) returns (stream Res)` | N:N | 채팅, 게임, 트레이딩, IoT 제어 |

구현은 `StreamObserver<T>`의 `onNext`, `onCompleted`, `onError`로 수렴한다. Unary 서버는 `onNext` 한 번 뒤 `onCompleted`, Server Streaming 서버는 `onNext` 여러 번 뒤 `onCompleted`를 호출한다. Client Streaming과 Bidirectional에서는 서버 메서드가 응답용 observer를 인자로 받고, 클라이언트 메시지를 수신할 observer를 반환한다. 클라이언트도 `onNext`로 보내다가 끝나면 반드시 `onCompleted`를 호출한다.

모든 스트림은 `onCompleted` 또는 `onError`로 끝나야 하며, 어느 쪽도 호출하지 않으면 상대편은 무기한 대기한다. Bidirectional의 두 방향은 독립적이어서 클라이언트가 송신을 끝내도 서버는 계속 응답할 수 있다. 반면 `onError`는 한쪽이 호출하면 호출 전체가 종료되고 상대편은 `StatusRuntimeException`을 받는다.

클라이언트 Stub은 세 종류다. BlockingStub은 동기 호출이며 Server Streaming에서 `Iterator`를 반환한다. AsyncStub은 콜백 기반으로 네 모드를 모두 지원한다. FutureStub은 Unary 전용이다. Client Streaming과 Bidirectional은 AsyncStub만 쓴다. WebFlux 환경에서는 `reactor-grpc` 플러그인이 생성하는 Reactor Stub을 쓰면 Unary는 `Mono → Mono`, Server Streaming은 `Mono → Flux`, Client Streaming은 `Flux → Mono`, Bidirectional은 `Flux → Flux`로 대응하고, 서버도 `StreamObserver` 대신 Reactor 타입을 직접 반환한다.

Deadline은 `withDeadlineAfter`로 호출 단위에 설정하며 스트리밍에서는 스트림 전체 수명에 적용되고, `Context`를 통해 하위 gRPC 호출까지 전파된다.

## 코드

Unary 서버 구현. 없는 자원은 예외 대신 `Status`로 변환해 `onError`로 전달한다.

```java
@GrpcService
public class UserGrpcService extends UserServiceGrpc.UserServiceImplBase {

    private final UserRepository repository;

    public UserGrpcService(UserRepository repository) {
        this.repository = repository;
    }

    @Override
    public void getUser(UserRequest request, StreamObserver<User> responseObserver) {
        repository.findById(request.getId())
            .ifPresentOrElse(
                entity -> {
                    responseObserver.onNext(toProto(entity));
                    responseObserver.onCompleted();
                },
                () -> responseObserver.onError(
                    Status.NOT_FOUND
                        .withDescription("user not found: " + request.getId())
                        .asRuntimeException()));
    }
}
```

Server Streaming 서버 구현. `ServerCallStreamObserver`로 캐스팅해 클라이언트 취소 시 소스 구독을 해제한다.

```java
@GrpcService
public class NotificationGrpcService
        extends NotificationServiceGrpc.NotificationServiceImplBase {

    private final NotificationSource source;

    public NotificationGrpcService(NotificationSource source) {
        this.source = source;
    }

    @Override
    public void subscribe(Subscription request, StreamObserver<Notification> responseObserver) {
        ServerCallStreamObserver<Notification> observer =
            (ServerCallStreamObserver<Notification>) responseObserver;

        Disposable disposable = source.stream(request.getUserId())
            .subscribe(
                observer::onNext,
                e -> observer.onError(Status.INTERNAL.withCause(e).asRuntimeException()),
                observer::onCompleted);

        observer.setOnCancelHandler(disposable::dispose);
    }
}
```

Client Streaming과 Bidirectional을 Reactor Stub으로 구현한 서버와 클라이언트. 서버는 `Flux`를 받아 `Mono` 또는 `Flux`를 반환하고 클라이언트는 `Flux`를 넘긴다.

```java
@GrpcService
public class AnalyticsGrpcService
        extends ReactorAnalyticsServiceGrpc.AnalyticsServiceImplBase {

    private final EventService eventService;
    private final Sinks.Many<ChatMessage> broadcast =
        Sinks.many().multicast().onBackpressureBuffer();

    public AnalyticsGrpcService(EventService eventService) {
        this.eventService = eventService;
    }

    // Client Streaming: Flux<Event> -> Mono<UploadResult>
    @Override
    public Mono<UploadResult> uploadEvents(Flux<Event> events) {
        return events
            .flatMap(eventService::persist)
            .count()
            .map(count -> UploadResult.newBuilder().setEventCount(count.intValue()).build());
    }

    // Bidirectional: Flux<ChatMessage> -> Flux<ChatMessage>
    @Override
    public Flux<ChatMessage> chat(Flux<ChatMessage> incoming) {
        Flux<ChatMessage> outgoing = broadcast.asFlux();
        return incoming
            .doOnNext(broadcast::tryEmitNext)
            .thenMany(Flux.empty())
            .mergeWith(outgoing);
    }
}
```

```java
@Service
public class AnalyticsClient {

    @GrpcClient("analytics-service")
    private ReactorAnalyticsServiceGrpc.ReactorAnalyticsServiceStub stub;

    public Mono<UploadResult> upload(List<Event> events) {
        return stub
            .withDeadlineAfter(5, TimeUnit.MINUTES)
            .uploadEvents(Flux.fromIterable(events));
    }

    public Flux<ChatMessage> chat(Flux<ChatMessage> userInput) {
        return stub.chat(userInput);
    }
}
```

## 실무에서 걸리는 지점

- **취소 감지 없는 무한 스트림.** 클라이언트가 `Iterator`를 버리거나 `cancel`을 호출해도 서버가 감지하지 않으면 구독한 소스는 계속 돈다. `setOnCancelHandler`로 정리 코드를 연결하고, Reactor Stub에서는 `doOnCancel`을 쓴다.
- **백프레셔는 HTTP/2 flow control 수준이다.** `request(n)` 같은 수요 신호가 없고, `setOnReadyHandler` 안에서 `isReady()`를 확인하며 보내는 방식으로만 제어된다. 수요 기반 백프레셔가 핵심이면 RSocket이 맞다.
- **`StreamObserver`는 스레드 안전하지 않다.** 여러 스레드가 같은 observer의 `onNext`를 동시에 호출하면 순서가 깨지거나 예외가 난다. 브로드캐스트 구조에서는 `Sinks.Many` 같은 직렬화 계층을 둔다.
- **부분 실패와 `onError`를 구분한다.** Client Streaming에서 메시지 하나가 실패했다고 `onError`를 호출하면 스트림 전체가 종료된다. 개별 실패는 카운트만 하고 최종 응답에 성공·실패 수를 담는다.
- **큰 파일과 Deadline 전파.** 청크 업로드는 서버 메모리와 커넥션을 오래 점유하므로 수십 MB 이하까지만 쓰고 그 이상은 객체 스토리지에 직접 올린다. 상위 호출의 짧은 Deadline이 하위 호출까지 전파되므로 장기 스트림에는 별도 값을 주거나 설정하지 않는다.

## 관련 글

- [gRPC — 개념·HTTP/2·Protobuf](/notes/reactive-spring/grpc-concepts-protobuf/)
- [gRPC — 에러·인터셉터·보안·운영](/notes/reactive-spring/grpc-errors-interceptors-security/)
- [RSocket — 개념·프레임·Interaction Model](/notes/reactive-spring/rsocket-concepts/)
