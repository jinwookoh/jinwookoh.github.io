---
title: "Repeat·Retry와 StepVerifier"
series: reactive-spring
part: "Reactor 심화"
order: 7
summary: "완료·에러 후 재구독하는 repeat/retry 전략과, 비동기 파이프라인을 가상 시간으로 검증하는 StepVerifier 사용법"
tags: [Project Reactor, retryWhen, backoff, StepVerifier, withVirtualTime]
sources: [2026-05-03-reactive-repeat-retry.md, 2026-05-03-reactive-step-verifier.md]
updated: 2026-08-29
---

외부 API 호출은 일시적으로 실패한다. 배포 중인 업스트림의 503은 몇 초 뒤 다시 시도하면 대부분 성공하지만, 재시도 로직이 없으면 순간적 장애가 그대로 사용자 에러가 되고, 루프와 `Thread.sleep`으로 직접 구현하면 논블로킹 파이프라인 안에서 스레드를 점유한다. ==Reactor는 이를 `repeat`와 `retry`로 파이프라인 안에 선언한다.== 검증도 문제다. `subscribe()`는 즉시 반환되므로 단언을 둘 곳이 없고, `block()`은 `delayElements`가 붙은 스트림을 실제 시간만큼 기다린다. reactor-test의 `StepVerifier`가 이 공백을 채운다.

## 핵심 개념

`repeat`와 `retry`는 구조가 같고 트리거만 다르다. `repeat`는 `onComplete`, `retry`는 `onError`를 받으면 업스트림을 다시 구독한다. 파이프라인 바깥의 상태는 초기화되지 않는다. 횟수 인자는 추가 실행 횟수라 `repeat(3)`은 총 4회 실행, `retry(2)`는 총 3회 시도다. 인자 없는 `repeat()`는 `take`·`takeUntil`로 종료 조건을 붙여야 하고, `retry()`는 영구 오류에 붙이면 CPU를 점유하는 무한 루프가 된다. `repeatWhen`은 완료 신호를 담은 companion Flux에 `delayElements`를 걸어 주기 폴링을 만든다.

정교한 재시도는 `retryWhen(Retry)`이 담당한다.

| 전략 | 메서드 | 특징 |
|:---|:---|:---|
| 즉시 | `Retry.max(n)` | 서버 부하 집중 |
| 고정 지연 | `Retry.fixedDelay(n, Duration)` | 동시 재시도가 몰림 |
| 지수 백오프 | `Retry.backoff(n, Duration)` | 실무 기본 |
| 무한 | `Retry.indefinitely()` | `filter` 필수 |

`Retry.backoff`는 기본 지터가 0.5라 대기 시간에 최대 50% 무작위 편차를 더해 thundering herd를 막고, `maxBackoff`로 상한을 둔다. `filter`는 재시도 대상 예외를 제한하고, `doBeforeRetry`는 `RetrySignal`을 받아 로깅에 쓴다. 재시도가 소진되면 원본 대신 `Retries exhausted: n/n` 메시지의 `IllegalStateException`이 전파되고 원본은 `getCause()`에 들어간다. 원본을 그대로 전파하려면 `onRetryExhaustedThrow((spec, signal) -> signal.failure())`를 쓴다.

StepVerifier는 Publisher를 구독하며 신호를 하나씩 소비해 선언된 기대와 대조한다. `create`는 시나리오만 만들고, `verify()`·`verifyComplete()`·`verifyError()` 같은 종결 메서드를 호출해야 구독과 검증이 시작된다. ==종결 메서드가 빠지면 아무 검증 없이 통과한다.== 값 검증은 `expectNext`(정확한 값), `expectNextMatches`(술어), `assertNext`(JUnit·AssertJ 단언), `expectNextCount`(개수만), `thenConsumeWhile`(술어가 참인 동안 전부 소비)로 나뉘고, 에러는 `expectError(Class)`, `expectErrorMessage`로 검증한다.

`withVirtualTime`은 스케줄러를 `VirtualTimeScheduler`로 교체해 `delayElements`, `interval`, `Retry.backoff` 같은 시간 기반 연산자를 실제 대기 없이 검증한다. `thenAwait`로 가상 시계를 진행하고 `expectNoEvent`로 구간에 신호가 없었음을 단언하는데, 구독도 이벤트이므로 그 앞에 `expectSubscription()`이 필요하다. 가상 스케줄러는 `withVirtualTime` 호출 시점에 설치되므로 Publisher는 반드시 `Supplier` 안에서 생성한다. `TestPublisher`는 테스트 코드가 직접 `next`·`error`·`complete`를 발행하며, 구독 전에 발행한 값은 사라지므로 `then()` 블록 안에서 발행한다.

## 코드

일시 장애 서비스에 지수 백오프 재시도를 적용하고, 소진 시 원본 예외를 전파하는 예제다.

```java
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import reactor.core.publisher.Mono;
import reactor.util.retry.Retry;

public class FlakyClient {

    private final AtomicInteger attempts = new AtomicInteger();

    public Mono<String> call() {
        return Mono.fromSupplier(() -> {
            int n = attempts.incrementAndGet();
            if (n < 3) {
                throw new ServiceUnavailableException("attempt " + n);
            }
            return "ok";
        });
    }

    public Mono<String> callWithRetry() {
        return call().retryWhen(
            Retry.backoff(3, Duration.ofMillis(200))
                .maxBackoff(Duration.ofSeconds(2))
                .jitter(0.5)
                .filter(ServiceUnavailableException.class::isInstance)
                .doBeforeRetry(signal ->
                    System.out.printf("retry #%d cause=%s%n",
                        signal.totalRetries() + 1, signal.failure().getMessage()))
                .onRetryExhaustedThrow((spec, signal) -> signal.failure())
        );
    }

    static class ServiceUnavailableException extends RuntimeException {
        ServiceUnavailableException(String message) { super(message); }
    }
}
```

2초 간격 폴링에 5xx 재시도를 결합한 예제다. `retryWhen`을 `repeat` 아래에 두어야 재시도가 폴링 루프 전체를 다시 구독한다.

```java
public Flux<String> pollUntilDone(WebClient client) {
    return client.get().uri("/orders/status")
        .retrieve()
        .bodyToMono(String.class)
        .repeatWhen(done -> done.delayElements(Duration.ofSeconds(2)))
        .takeUntil("DONE"::equals)
        .retryWhen(
            Retry.fixedDelay(20, Duration.ofSeconds(1))
                .filter(ex -> ex instanceof WebClientResponseException wcre
                    && wcre.getStatusCode().is5xxServerError())
        );
}
```

StepVerifier 테스트다. 백오프 대기는 가상 시간으로 건너뛴다.

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import reactor.test.publisher.TestPublisher;
import reactor.util.retry.Retry;

class FlakyClientTest {

    @Test
    void retriesUntilSuccessWithoutRealWaiting() {
        StepVerifier.withVirtualTime(() -> new FlakyClient().callWithRetry())
            .expectSubscription()
            .expectNoEvent(Duration.ofMillis(100))
            .thenAwait(Duration.ofSeconds(5))
            .expectNext("ok")
            .verifyComplete();
    }

    @Test
    void nonRetryableErrorFailsImmediately() {
        Mono<String> source = Mono.<String>error(new IllegalArgumentException("bad request"))
            .retryWhen(Retry.max(3)
                .filter(FlakyClient.ServiceUnavailableException.class::isInstance)
                .onRetryExhaustedThrow((spec, signal) -> signal.failure()));

        StepVerifier.create(source)
            .expectError(IllegalArgumentException.class)
            .verify();
    }

    @Test
    void delayedStreamWithVirtualTime() {
        StepVerifier.withVirtualTime(() ->
                Flux.range(1, 5).delayElements(Duration.ofSeconds(10)))
            .expectSubscription()
            .expectNoEvent(Duration.ofSeconds(10))
            .expectNext(1)
            .thenAwait(Duration.ofSeconds(40))
            .expectNext(2, 3, 4, 5)
            .verifyComplete();
    }

    @Test
    void manualEmissionWithTestPublisher() {
        TestPublisher<String> publisher = TestPublisher.create();

        StepVerifier.create(publisher.flux().map(String::toUpperCase))
            .then(() -> {
                publisher.next("hi");
                publisher.error(new IllegalStateException("boom"));
            })
            .expectNext("HI")
            .expectErrorMessage("boom")
            .verify();
    }

    @Test
    void collectListThenAssert() {
        StepVerifier.create(Flux.range(1, 50).map(i -> i * 2).collectList())
            .assertNext(list -> {
                assertThat(list).hasSize(50);
                assertThat(list).allMatch(i -> i % 2 == 0);
            })
            .verifyComplete();
    }
}
```

## 실무에서 걸리는 지점

- `filter` 없는 `retryWhen`은 4xx처럼 반복해도 결과가 같은 예외에 대기 시간만 소모한다. 5xx·타임아웃·커넥션 예외로 대상을 한정한다.
- 타임아웃으로 실패한 POST는 서버에서 이미 처리됐을 수 있다. ==멱등 키 없는 재시도는 중복 실행이 된다.==
- WebClient·서비스·게이트웨이에 각각 재시도가 있으면 시도 횟수가 곱해진다. 재시도는 한 곳에서만 선언한다.
- 소진 예외 타입이 바뀌므로 `retryWhen` 아래의 `onErrorResume(TimeoutException.class, ...)`는 매칭되지 않는다. `onRetryExhaustedThrow`로 원본을 전파하거나 `getCause()`로 분기한다.
- 시간 기반 연산자를 실제 시간으로 테스트하면 CI가 느려지고 타이밍에 따라 실패한다. 부분 소비 테스트는 `cancel()` 후 `verify()`로 끝내 무한 대기를 피한다.

## 관련 글

- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [WebClient](/notes/reactive-spring/webclient/)
