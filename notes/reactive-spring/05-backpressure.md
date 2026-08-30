---
title: "Backpressure"
series: reactive-spring
part: "Reactor 심화"
order: 5
summary: "생산 속도가 소비 속도를 앞지를 때 request(n)과 오버플로우 전략으로 메모리 고갈을 막는 방법을 정리한다."
tags: [Backpressure, Project Reactor, limitRate, onBackpressureBuffer, BaseSubscriber]
sources: [2026-05-03-reactive-backpressure.md]
updated: 2026-08-29
---

생산자와 소비자가 같은 스레드에서 동작하면 소비자가 `onNext` 처리를 끝내야 생산자가 다음 값을 내보낼 수 있으므로 속도 불균형이 드러나지 않는다. `publishOn`으로 소비자를 다른 스레드로 분리하면 생산자는 자기 속도로 값을 내보내고 느린 소비자 앞의 큐에 값이 쌓인다. 누적이 계속되면 `OutOfMemoryError`로 프로세스가 죽는다. Reactive Streams 명세는 이 문제를 소비자 주도의 수요 신호 `Subscription.request(n)`으로 해결한다. 소비자가 처리할 수 있는 개수만 요청하고 생산자는 그 이상 내보내지 않는 것이 Backpressure다.

## 핵심 개념

### request(n)과 unbounded 요청

`Flux.subscribe(consumer)` 형태의 기본 구독은 `request(Long.MAX_VALUE)`를 호출한다. 무제한 요청이므로 기본 구독만으로는 배압이 걸리지 않는다. 배압이 동작하려면 `publishOn`·`flatMap`처럼 내부 큐를 두는 연산자가 있거나 `limitRate`·`BaseSubscriber`로 요청량을 명시해야 한다.

### 내부 큐와 75% 보충 규칙

큐를 가진 연산자는 기본 prefetch 256개를 업스트림에 요청하고, 소비자가 그중 75%를 처리한 시점에 그만큼을 다시 요청한다. `limitRate(100)`은 처음 100개를 요청하고 75개가 처리되면 다음 75개를 요청한다. 임계값을 직접 정하려면 `limitRate(highTide, lowTide)`를 쓴다.

### 배압을 준수하는 소스와 그렇지 않은 소스

`Flux.range`, `Flux.generate`, `Flux.fromIterable`은 요청받은 개수만큼만 값을 만들므로 배압을 자동으로 준수한다. 반면 `Flux.create`는 외부 콜백이 임의 시점에 `sink.next()`를 호출하므로 요청량과 무관하게 값이 들어오고, 기본 `OverflowStrategy.BUFFER`가 초과분을 무제한 큐에 담는다. `sink.onRequest()`로 수요에 맞춰 생산하거나 `Flux.create(emitter, OverflowStrategy.DROP)`처럼 전략을 지정해야 한다. Hot Publisher인 `Sinks.Many`도 구독자 수요와 무관하게 발행하므로 `onBackpressureBuffer(size)` 같은 버퍼 설정이 필수다.

### 오버플로우 전략

요청량을 초과한 값이 이미 도착했을 때의 처리 방식을 정하는 연산자다.

| 연산자 | 초과분 처리 | 적합한 데이터 |
|:---|:---|:---|
| `onBackpressureBuffer()` | 무제한 버퍼 저장 | 결제·거래처럼 유실 불가 |
| `onBackpressureBuffer(n, strategy)` | 크기 n 버퍼, 초과 시 DROP_LATEST·DROP_OLDEST·ERROR | 일부 손실 허용 |
| `onBackpressureDrop()` | 새 값을 버림 | 로그·메트릭 |
| `onBackpressureLatest()` | 대기 값을 최신 값으로 교체 | 센서 값·UI 상태 |
| `onBackpressureError()` | `OverflowException`으로 종료 | 배압 위반 즉시 감지 |

`limitRate`는 업스트림 요청량을 줄여 초과 발행을 사전에 막는 수단이고, `onBackpressure*`는 이미 초과 발행된 값을 사후에 처리하는 수단이다. 소스가 요청을 존중하지 않으면 `limitRate`만으로 누적을 막지 못한다.

## 코드

요청받은 개수만큼만 생산하는 `Flux.create` 패턴이다. `limitRate(5)`와 결합하면 5개 단위로 생산된다.

```java
Flux<Integer> source = Flux.<Integer>create(sink -> {
    AtomicInteger counter = new AtomicInteger();
    sink.onRequest(n -> {
        for (long i = 0; i < n && !sink.isCancelled(); i++) {
            sink.next(counter.incrementAndGet());
        }
    });
});

source.limitRate(5)
      .take(20)
      .subscribe(v -> System.out.println("처리: " + v));
```

수요를 무시하는 소스에 크기 100 버퍼와 DROP_OLDEST 전략을 적용한 예다.

```java
Flux.<Integer>create(sink -> {
        for (int i = 1; i <= 1_000; i++) {
            sink.next(i);
        }
        sink.complete();
    })
    .onBackpressureBuffer(
        100,
        dropped -> System.out.println("버림: " + dropped),
        BufferOverflowStrategy.DROP_OLDEST
    )
    .publishOn(Schedulers.boundedElastic())
    .subscribe(v -> {
        Thread.sleep(10);
        System.out.println("처리: " + v);
    });
```

`BaseSubscriber`로 `request(n)` 시점을 직접 제어하는 예다. 한 건 처리가 끝날 때마다 다음 한 건을 요청한다.

```java
public class OneByOneSubscriber extends BaseSubscriber<Integer> {

    @Override
    protected void hookOnSubscribe(Subscription subscription) {
        request(1);
    }

    @Override
    protected void hookOnNext(Integer value) {
        System.out.println("처리: " + value + " @ " + Thread.currentThread().getName());
        request(1);
    }

    @Override
    protected void hookOnError(Throwable throwable) {
        System.err.println("에러: " + throwable.getMessage());
    }
}

Flux.range(1, 10)
    .publishOn(Schedulers.parallel())
    .subscribe(new OneByOneSubscriber());
```

`BaseSubscriber`는 `Subscriber` 규약 처리를 대신한다. `hookOnSubscribe`를 재정의하지 않으면 기본 구현이 `request(Long.MAX_VALUE)`를 호출한다.

## 실무에서 걸리는 지점

- **단일 스레드 파이프라인에는 `onBackpressureBuffer`가 효과가 없다.** 같은 스레드면 초과 발행 자체가 없다. 배압 연산자가 동작하지 않는다면 `publishOn`·`subscribeOn`으로 스레드가 분리되어 있는지 먼저 확인한다.
- **무제한 `onBackpressureBuffer()`와 무한 스트림의 조합은 OOM으로 이어진다.** 유실 불가 데이터라면 소스가 요청을 존중하게 만들거나, 크기 제한 버퍼에 ERROR 전략을 걸어 초과를 즉시 실패로 드러낸다.
- **`limitRate`는 소비 측 요청량만 줄인다.** `Flux.create` 루프가 `sink.next()`를 전부 호출한 뒤라면 값은 이미 내부 버퍼에 있다. 생산을 늦추려면 `sink.onRequest()`와 `sink.isCancelled()` 확인이 필요하다.
- **`Sinks.Many`의 `tryEmitNext`는 버퍼가 차면 `FAIL_OVERFLOW`를 반환한다.** 반환값을 확인하지 않으면 값이 조용히 사라진다.
- **Drop과 Latest는 보존 대상이 반대다.** Drop은 오래된 값을 지키고 새 값을 버리며, Latest는 대기 값을 새 값으로 교체한다. 최신 값만 의미 있는 데이터에 Drop을 쓰면 오래된 값이 소비된다.

## 관련 글

- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
- [리액티브 프로그래밍 — 왜 필요한가·Reactive Streams](/notes/reactive-spring/reactive-programming-intro/)
