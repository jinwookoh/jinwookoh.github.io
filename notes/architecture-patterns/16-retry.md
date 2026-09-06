---
title: "재시도 — 지수 백오프와 지터"
series: architecture-patterns
part: "복원력"
order: 16
summary: "재시도는 일시적 오류에만, 멱등한 호출에만, 지수 백오프에 지터를 더해 한 계층에서만 해야 서버를 살린다."
tags: [Retry, Exponential Backoff, Jitter, Resilience4j, Spring Retry]
sources: [https://jinwookoh.tistory.com/241]
updated: 2026-09-06
---

분산 환경에서 원격 호출은 일정 비율로 실패한다. 커넥션이 끊기고, 로드 밸런서가 인스턴스를 교체하는 사이 503이 돌아오고, GC 정지로 응답이 타임아웃을 넘긴다. 이런 일시적 오류(transient fault)를 곧바로 사용자 오류로 올리면 몇 백 밀리초 뒤에는 성공했을 요청이 실패로 끝난다. 반대로 아무 규칙 없이 재시도하면 더 큰 문제가 생긴다. 과부하로 응답을 못 하던 서버에 실패한 요청 수천 개가 같은 간격으로 동시에 다시 몰려오고, 서버는 복구되기도 전에 다시 무너진다. 재시도 패턴은 어떤 오류를, 몇 번, 어떤 간격으로 다시 시도할지를 정해 이 두 실패 사이의 균형을 잡는다.

## 핵심 개념

재시도 대상은 일시적 오류로 한정한다. 연결 거부·타임아웃·503·429처럼 잠시 뒤 결과가 달라질 수 있는 실패만 해당하고, 400·401·404 같은 클라이언트 오류나 검증 실패는 몇 번을 반복해도 결과가 같으므로 즉시 실패로 처리한다.

고정 백오프는 실패할 때마다 같은 시간을 기다린다. 구현이 단순하고 실패 확정이 빠르지만, 같은 시각에 실패한 클라이언트들이 같은 시각에 다시 요청하므로 부하가 주기적으로 되풀이된다. 지수 백오프는 대기 시간을 `base × 2^n`으로 늘려 서버가 회복할 시간을 준다. 상한(cap)을 두지 않으면 대기가 무한히 커지므로 보통 수 초에서 수십 초로 제한한다.

지수 백오프만으로는 부족하다. 같은 순간 실패한 요청은 같은 지수 스케줄을 따르므로 여전히 뭉쳐서 도착한다. 지터(jitter)는 대기 시간에 무작위성을 섞어 재시도를 시간축 위에 흩뿌린다. 대기 시간에 수십 밀리초를 더하는 정도로는 효과가 거의 없고, 0부터 지수 상한 사이에서 균등하게 뽑는 full jitter가 서버 부하 관점에서 가장 효과가 크다. 이전 대기 시간을 기준으로 다음 값을 뽑는 decorrelated jitter도 널리 쓰인다.

| 구분 | 고정 백오프 | 지수 백오프 + 지터 |
|---|---|---|
| 대기 시간 | 1초 → 1초 → 1초 | 0~1초 → 0~2초 → 0~4초 (무작위) |
| 서버 부하 | 동시 재시도가 주기적으로 반복 | 시간축으로 분산 |
| 실패 확정 | 빠름 | 느림 (총 대기 시간이 길어짐) |
| 적합한 곳 | 내부망 DB·캐시의 짧은 순단 | 외부 API, 서비스 간 호출, 모바일 클라이언트 |

재시도의 전제는 멱등성이다. 조회처럼 여러 번 실행해도 결과가 같은 호출은 안전하지만, 결제 요청이나 주문 생성은 그렇지 않다. 재시도가 필요한 쓰기 호출에는 클라이언트가 생성한 `Idempotency-Key`를 실어 서버가 같은 키의 요청을 한 번만 처리하도록 만든다.

재시도는 서킷 브레이커와 짝을 이룬다. 재시도는 개별 호출의 짧은 실패를 흡수하고, 실패율이 임계값을 넘으면 서킷 브레이커가 호출 자체를 차단해 재시도가 헛되이 반복되는 것을 막는다.

## 코드

지수 백오프에 full jitter를 적용한 순수 Java 구현이다. 대기 시간은 0부터 `min(cap, base × 2^(n-1))` 사이에서 균등하게 뽑는다.

```java
public final class Retrier {

    public static <T> T call(Supplier<T> action, int maxAttempts,
                             Duration base, Duration cap) throws InterruptedException {
        for (int attempt = 1; ; attempt++) {
            try {
                return action.get();
            } catch (TransientException e) {
                if (attempt >= maxAttempts) {
                    throw e;
                }
                long exp = Math.min(cap.toMillis(), base.toMillis() << (attempt - 1));
                long sleepMs = ThreadLocalRandom.current().nextLong(exp + 1); // full jitter
                Thread.sleep(sleepMs);
            }
        }
    }
}
```

Spring Retry 2.x를 쓴 선언형 재시도다. `spring-retry`와 `spring-boot-starter-aop` 의존성을 추가하고 설정 클래스에 `@EnableRetry`를 붙인다. `random = true`가 지터를 켜고, `@Recover` 메서드는 모든 시도가 실패한 뒤 호출된다.

```java
@Service
public class PaymentGateway {

    private final RestClient restClient;

    public PaymentGateway(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("https://bank.example.com").build();
    }

    @Retryable(
        retryFor = { ResourceAccessException.class, HttpServerErrorException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 500, multiplier = 2.0, maxDelay = 4_000, random = true)
    )
    public PaymentResult pay(PaymentRequest request) {
        return restClient.post()
                .uri("/payments")
                .header("Idempotency-Key", request.idempotencyKey())
                .body(request)
                .retrieve()
                .body(PaymentResult.class);
    }

    @Recover
    public PaymentResult recover(Exception e, PaymentRequest request) {
        return PaymentResult.pending(request.idempotencyKey());
    }
}
```

Resilience4j(`resilience4j-spring-boot3`)로 같은 정책을 설정 파일에 옮긴 예다. 지수 백오프와 무작위 대기를 함께 켜면 `ofExponentialRandomBackoff`가 적용되고, 서킷 브레이커가 열려서 던지는 예외는 재시도에서 제외한다.

```yaml
resilience4j:
  retry:
    instances:
      bank:
        max-attempts: 3
        wait-duration: 500ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        exponential-max-wait-duration: 4s
        enable-randomized-wait: true
        randomized-wait-factor: 0.5
        retry-exceptions:
          - org.springframework.web.client.ResourceAccessException
          - org.springframework.web.client.HttpServerErrorException
        ignore-exceptions:
          - io.github.resilience4j.circuitbreaker.CallNotPermittedException
```

```java
@Retry(name = "bank", fallbackMethod = "pending")
@CircuitBreaker(name = "bank")
public PaymentResult pay(PaymentRequest request) { /* RestClient 호출 */ }

private PaymentResult pending(PaymentRequest request, Throwable t) {
    return PaymentResult.pending(request.idempotencyKey());
}
```

## 실무에서 걸리는 지점

- 타임아웃은 서버가 요청을 받지 못한 것이 아니라 응답이 돌아오지 않은 것이다. ==타임아웃 뒤에 멱등 키 없이 결제·주문 같은 쓰기 호출을 재시도하면 서버는 같은 요청을 두 번 처리한다.== 재시도를 붙이기 전에 서버 쪽 중복 제거를 먼저 만든다.
- 재시도는 계층마다 곱해진다. ==클라이언트·API 게이트웨이·서비스가 각각 3회씩 재시도하면 원 서버에는 한 요청당 최대 27개의 요청이 도달한다.== 재시도는 호출 사슬에서 한 계층에만 두고 나머지는 실패를 그대로 전파한다.
- 총 대기 시간을 호출자의 타임아웃 안에 맞춘다. 500ms에서 시작해 3회 지수 백오프하면 대기만 최대 3.5초이고 각 시도의 타임아웃이 더해진다. 호출자가 3초 뒤에 포기했는데 뒤에서 재시도가 계속되면 자원만 낭비된다.
- 429나 503 응답에 `Retry-After` 헤더가 있으면 계산한 백오프 대신 그 값을 따른다. 서버가 명시한 대기 시간보다 빨리 재시도하면 처리율 제한에 다시 걸리거나 차단 시간이 길어진다.
- Resilience4j의 기본 데코레이터 순서는 Retry가 가장 바깥이다. ==`CallNotPermittedException`을 `ignore-exceptions`에 넣지 않으면 서킷이 열린 뒤에도 재시도 횟수만큼 대기와 실패가 반복된다.== 반대로 Retry가 안쪽에 있으면 재시도가 모두 실패한 뒤에야 서킷 브레이커가 한 번의 실패로 집계한다.
- Spring Retry의 `@Retryable`은 AOP 프록시로 동작하므로 같은 클래스 안에서 호출하면 재시도가 적용되지 않는다. 재시도 대상 메서드는 별도 빈으로 분리한다.

## 관련 글

- [서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태](/notes/architecture-patterns/circuit-breaker/)
- [벌크헤드 — 스레드 풀·세마포어로 자원 격리](/notes/architecture-patterns/bulkhead/)
- [처리율 제한 — 고정 윈도·슬라이딩 윈도·토큰 버킷](/notes/architecture-patterns/rate-limiter/)
