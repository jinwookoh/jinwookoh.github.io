---
title: "Hot/Cold Publisher와 Sinks"
series: reactive-spring
part: "Reactor 심화"
order: 4
summary: "구독마다 소스를 다시 실행하는 Cold를 Hot으로 바꾸는 연산자와, 외부에서 직접 신호를 주입하는 Sinks의 선택 기준을 정리한다"
tags: [Project Reactor, Hot Publisher, ConnectableFlux, Sinks, share]
sources: [2026-05-03-reactive-hot-cold-publishers.md, 2026-05-03-reactive-sinks.md]
updated: 2026-08-29
---

Reactor의 `Mono`와 `Flux`는 구독마다 소스를 처음부터 다시 실행한다. 하나의 `Flux`를 두 컴포넌트가 각각 구독하면 DB 쿼리나 HTTP 호출이 두 번 나가고, 웹소켓 피드처럼 연결이 비싼 소스라면 구독자 수만큼 연결이 열린다. 반대로 외부 이벤트 수신처럼 임의의 시점에 코드가 직접 값을 밀어 넣어야 하는 경우, 일반 생성 연산자로는 구독 시점과 발행 시점을 분리할 수 없다. 앞의 문제는 Hot 변환 연산자가, 뒤의 문제는 `Sinks`가 해결한다.

## 핵심 개념

Cold Publisher는 구독자마다 독립된 실행을 시작한다. `Flux.range`, `WebClient`의 `retrieve()` 결과, R2DBC 리포지토리 반환값 모두 Cold다. `Mono.just`도 Cold지만 인자는 assembly 시점에 한 번 평가되어 캡처되므로, 구독마다 계산을 다시 하려면 `Mono.fromSupplier`나 `Mono.defer`를 쓴다.

Hot Publisher는 하나의 실행을 여러 구독자가 공유하며, 늦게 합류한 구독자는 합류 시점 이후의 신호만 받는다. 진입점은 `publish()`가 반환하는 `ConnectableFlux`다. `connect()` 전까지 상위 소스를 구독하지 않으며, `connect()` 시점을 정하는 방식에 따라 파생 연산자가 갈린다.

| 연산자 | 소스 구독 시점 | 구독자 0명이 되면 | 재구독 시 | 이전 신호 |
|:---|:---|:---|:---|:---|
| `publish().connect()` | `connect()` 호출 | 계속 실행 | 현재 시점부터 | 없음 |
| `publish().autoConnect(n)` | n번째 구독 | 계속 실행 | 현재 시점부터 | 없음 |
| `publish().refCount(n)` | n번째 구독 | 소스 해지 | 처음부터 재시작 | 없음 |
| `share()` | 첫 구독 | 소스 해지 | 처음부터 재시작 | 없음 |
| `cache()` / `cache(n)` | 첫 구독 | 캐시 유지 | 캐시 재생 후 합류 | 전체 / 최근 n개 |

`share()`는 `publish().refCount(1)`과 동일하다. `autoConnect`는 구독자가 없어도 소스를 계속 실행하므로 재구독 시 그 시점의 값부터 받고, `refCount`는 구독자가 0이 되면 상위 구독을 취소하므로 재구독 시 소스가 처음부터 다시 시작된다. `cache()`는 발행된 신호를 저장해 두었다가 늦은 구독자에게 재생하는 Hot 변형으로, `replay().autoConnect()`에 해당한다.

`Sinks`는 파이프라인 바깥에서 코드가 직접 `onNext`, `onComplete`, `onError`를 주입하는 도구이며 구독 여부와 무관하게 발행할 수 있다. 과거의 `Processor` 계열은 3.5에서 제거되었다. `Sinks.One`은 `Mono` 대응이고, `Sinks.Many`는 `Flux` 대응이며 세 종류로 나뉜다.

- `unicast()` — 구독자 1명만 허용. 구독 전 발행분은 버퍼에 쌓였다가 전달되고, 두 번째 구독자는 `IllegalStateException` 에러 신호를 받는다.
- `multicast()` — 다중 구독자 브로드캐스트. 늦게 합류한 구독자는 이후 신호만 받는다. `directBestEffort()`는 버퍼 없이 느린 구독자에게 드롭한다.
- `replay()` — 새 구독자에게 이전 신호를 재전송. `all()`, `limit(n)`, `limit(Duration)`으로 범위를 정한다.

`tryEmitNext`는 `EmitResult`를 반환하고 처리를 호출자에게 맡기며, `emitNext`는 `EmitFailureHandler`가 재시도 여부를 결정한다. `Sinks`는 직렬화된 호출을 전제하므로 여러 스레드가 동시에 `tryEmitNext`를 호출하면 `FAIL_NON_SERIALIZED`가 반환되고, 이를 무시하면 신호가 예외 없이 사라진다.

## 코드

`share()`와 `autoConnect`의 재구독 동작 차이를 `Flux.interval`로 확인한다.

```java
import reactor.core.Disposable;
import reactor.core.publisher.Flux;

import java.time.Duration;

public class HotReplayDemo {

    public static void main(String[] args) throws InterruptedException {
        Flux<Long> refCounted = Flux.interval(Duration.ofMillis(100)).share();
        Flux<Long> autoConnected = Flux.interval(Duration.ofMillis(100))
                .publish()
                .autoConnect(1);

        Disposable d1 = refCounted.subscribe(n -> System.out.println("share: " + n));
        Disposable d2 = autoConnected.subscribe(n -> System.out.println("auto: " + n));
        Thread.sleep(500);

        d1.dispose();   // 구독자 0명 → 상위 구독 취소
        d2.dispose();   // 구독자 0명이지만 소스는 계속 실행
        Thread.sleep(500);

        refCounted.subscribe(n -> System.out.println("share 재구독: " + n));    // 0, 1, 2 ...
        autoConnected.subscribe(n -> System.out.println("auto 재구독: " + n));  // 10, 11 ...
        Thread.sleep(500);
    }
}
```

R2DBC 조회 결과를 두 소비자가 공유하되 늦은 구독자도 전체를 받아야 하면 `cache()`를 쓴다. `share()`는 두 번째 구독자가 지나간 행을 놓친다.

```java
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
public class UserSyncService {

    private final UserRepository userRepository;      // ReactiveCrudRepository<User, Long>
    private final SearchIndexer indexer;
    private final AuditWriter audit;

    public UserSyncService(UserRepository userRepository, SearchIndexer indexer, AuditWriter audit) {
        this.userRepository = userRepository;
        this.indexer = indexer;
        this.audit = audit;
    }

    public Flux<User> syncAll() {
        Flux<User> users = userRepository.findAll().cache();   // 쿼리 1회, 늦은 구독자도 전체 수신
        Flux<User> indexed = users.flatMap(indexer::index);
        Flux<User> audited = users.flatMap(audit::record);
        return Flux.merge(indexed, audited).thenMany(users);
    }
}
```

`Sinks.Many`로 내부 이벤트 버스를 만든다. 여러 스레드에서 발행하므로 `emitNext`에 재시도 핸들러를 넘긴다.

```java
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Component
public class EventBus {

    private final Sinks.Many<Object> bus = Sinks.many().multicast().onBackpressureBuffer();

    public void publish(Object event) {
        bus.emitNext(event, (signalType, result) ->
                result == Sinks.EmitResult.FAIL_NON_SERIALIZED);   // true면 재시도
    }

    public <T> Flux<T> on(Class<T> type) {
        return bus.asFlux().filter(type::isInstance).cast(type);
    }
}
```

```java
@Component
public class WelcomeMailListener {

    public WelcomeMailListener(EventBus bus, MailSender mailSender) {
        bus.on(UserCreatedEvent.class)
           .flatMap(e -> mailSender.sendWelcome(e.userId()))
           .subscribe();
    }
}
```

## 실무에서 걸리는 지점

- `cache()`와 `replay().all()`을 무한 스트림에 붙이면 저장된 신호가 해제되지 않아 OOM으로 이어진다. 끝이 없는 소스에는 `cache(n)`, `cache(Duration)`, `replay().limit(n)`처럼 상한을 둔다.
- `share()`는 구독자가 잠시 0이 되는 구간마다 소스를 끊고 재연결하며 시퀀스가 리셋된다. 연결 유지가 목적이면 `autoConnect`를, 마지막 구독자 이탈 후 유예를 두려면 `refCount(n, Duration)`을 쓴다.
- `Sinks.One`은 값을 한 번만 받는다. 두 번째 `tryEmitValue`는 `FAIL_TERMINATED`를 반환하고 조용히 무시되므로 반환값을 로그로 남긴다.
- `multicast().onBackpressureBuffer()`는 느린 구독자 때문에 버퍼가 차면 `FAIL_OVERFLOW`를 반환한다. 손실이 허용되는 알림성 이벤트에는 `directBestEffort()`가 맞고, 아니면 버퍼 크기와 소비 속도를 함께 조정한다.
- 생성자에서 `subscribe()`한 구독은 컨텍스트 재시작 시 누적될 수 있다. `Disposable`을 보관하고 `@PreDestroy`에서 해제한다.

## 관련 글

- [Mono와 Flux](/notes/reactive-spring/mono-flux/)
- [Backpressure](/notes/reactive-spring/backpressure/)
- [스트리밍 응답 — SSE·NDJSON](/notes/reactive-spring/streaming-sse-ndjson/)
