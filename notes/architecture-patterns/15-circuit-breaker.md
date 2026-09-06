---
title: "서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태"
series: architecture-patterns
part: "복원력"
order: 15
summary: "실패율이 임계값을 넘은 의존 서비스로의 호출을 차단해 즉시 실패시키고, 호출 측의 스레드를 지켜 연쇄 장애를 막는다"
tags: [Circuit Breaker, Resilience4j, Spring Boot, Fallback, Sliding Window]
sources: [https://jinwookoh.tistory.com/234]
updated: 2026-09-06
---

주문 서비스가 결제 서비스를 동기 호출하는 구조에서 결제 서비스가 응답을 멈추면, 주문 서비스의 요청 스레드는 타임아웃이 날 때까지 대기한다. 초당 수백 건의 요청이 들어오는 상황이라면 이 대기는 곧 스레드 풀 고갈로 이어지고, 결제와 무관한 조회 API까지 응답하지 못하게 된다. 장애가 호출 체인을 따라 상위로 번지는 이 현상을 연쇄 장애(cascading failure)라고 한다. 서킷 브레이커는 의존 서비스의 실패율이 임계값을 넘으면 호출 자체를 차단하고 즉시 실패(fail fast)시킨다. 호출 측은 자원을 지키고, 장애가 난 서비스는 회복할 시간을 얻는다.

## 핵심 개념

### 세 가지 상태

- **Closed**: 정상 상태. 모든 호출을 통과시키고 결과(성공·실패·느린 호출)를 슬라이딩 윈도에 기록한다. 실패율 또는 느린 호출 비율이 임계값을 넘으면 Open으로 전이한다.
- **Open**: 차단 상태. 원격 호출을 보내지 않고 `CallNotPermittedException`을 즉시 던진다. `waitDurationInOpenState`가 지나면 Half-Open으로 전이한다.
- **Half-Open**: 회복 확인 상태. `permittedNumberOfCallsInHalfOpenState`만큼의 호출만 통과시키고 나머지는 거부한다. 통과시킨 호출의 실패율이 임계값 아래면 Closed로, 넘으면 다시 Open으로 돌아간다.

### 실패율을 계산하는 슬라이딩 윈도

Resilience4j는 두 종류의 윈도를 제공한다.

| 구분 | COUNT_BASED | TIME_BASED |
|---|---|---|
| 집계 대상 | 최근 N개의 호출 | 최근 N초 동안의 호출 |
| 자료 구조 | 고정 크기 원형 배열 | 1초 단위 버킷 N개 |
| 트래픽이 적을 때 | N개가 채워지면 판단 가능 | 윈도 안에 호출이 부족하면 판단 불가 |
| 트래픽이 많을 때 | 표본이 빠르게 교체됨 | 현재 시점의 상태를 반영 |

호출 빈도가 낮은 배치나 내부 도구는 횟수 기반, 초당 수십 건 이상 들어오는 고객 API는 시간 기반이 맞는다. 어느 쪽이든 `minimumNumberOfCalls` 이상의 호출이 쌓이기 전에는 실패율을 계산하지 않으며, ==`slidingWindowSize`와 `minimumNumberOfCalls`의 기본값은 모두 100이므로 설정 없이 쓰면 호출이 100건 쌓이기 전까지는 어떤 실패도 서킷을 열지 못한다==.

### 무엇을 실패로 볼 것인가

기본 설정은 모든 예외를 실패로 기록한다. `ignoreExceptions`에 지정한 예외는 성공도 실패도 아닌 것으로 취급되고, `recordExceptions`를 지정하면 그 예외만 실패로 센다. 실패율과 별도로 `slowCallDurationThreshold`를 넘긴 호출은 느린 호출로 집계되며, 그 비율이 `slowCallRateThreshold`를 넘으면 실패율과 무관하게 서킷이 열린다.

## 코드

의존성은 `io.github.resilience4j:resilience4j-spring-boot3`와 `spring-boot-starter-aop`이다. 결제 서비스용 서킷을 시간 기반 윈도로 설정하고, 클라이언트 오류인 결제 거절은 실패에서 제외한다. HTTP 타임아웃은 Spring Boot 3.4부터 지원하는 `spring.http.client` 속성으로 `RestClient`에 적용한다.

```yaml
spring:
  http:
    client:
      connect-timeout: 1s
      read-timeout: 2s

resilience4j:
  circuitbreaker:
    instances:
      payment:
        slidingWindowType: TIME_BASED
        slidingWindowSize: 10
        minimumNumberOfCalls: 20
        failureRateThreshold: 50
        slowCallDurationThreshold: 1500ms
        slowCallRateThreshold: 80
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 5
        automaticTransitionFromOpenToHalfOpenEnabled: true
        registerHealthIndicator: true
        ignoreExceptions:
          - com.example.order.payment.PaymentDeclinedException
```

`@CircuitBreaker`를 붙인 메서드에서 예외가 나오면 같은 클래스의 `fallbackMethod`가 호출된다. 폴백은 원본 메서드와 같은 매개변수 뒤에 예외 타입 하나를 더 받으며, 예외 타입이 구체적인 오버로드가 우선 선택된다.

```java
@Service
public class OrderPaymentService {

    private static final Logger log = LoggerFactory.getLogger(OrderPaymentService.class);
    private final RestClient paymentClient;

    public OrderPaymentService(RestClient.Builder builder) {
        this.paymentClient = builder.baseUrl("http://payment-service").build();
    }

    @CircuitBreaker(name = "payment", fallbackMethod = "payFallback")
    public PaymentResult pay(Order order) {
        return paymentClient.post()
                .uri("/payments")
                .body(new PaymentRequest(order.id(), order.amount()))
                .retrieve()
                .body(PaymentResult.class);
    }

    // 서킷이 열려 호출 자체가 거부된 경우: 원격 호출 없이 즉시 응답한다
    public PaymentResult payFallback(Order order, CallNotPermittedException e) {
        log.warn("payment circuit open, order {} deferred", order.id());
        return PaymentResult.deferred(order.id());
    }

    // 타임아웃·5xx 등 실제 호출이 실패한 경우
    public PaymentResult payFallback(Order order, Exception e) {
        log.error("payment call failed, order {}", order.id(), e);
        return PaymentResult.deferred(order.id());
    }
}
```

상태 전이는 운영에서 반드시 관찰해야 하는 이벤트이므로 레지스트리에 리스너를 등록해 로그와 알림으로 내보낸다.

```java
@Component
public class CircuitBreakerStateLogger {

    private static final Logger log = LoggerFactory.getLogger(CircuitBreakerStateLogger.class);

    public CircuitBreakerStateLogger(CircuitBreakerRegistry registry) {
        registry.getAllCircuitBreakers().forEach(this::subscribe);
        registry.getEventPublisher().onEntryAdded(event -> subscribe(event.getAddedEntry()));
    }

    private void subscribe(io.github.resilience4j.circuitbreaker.CircuitBreaker cb) {
        cb.getEventPublisher().onStateTransition(event ->
                log.warn("circuit [{}] {} -> {}",
                        event.getCircuitBreakerName(),
                        event.getStateTransition().getFromState(),
                        event.getStateTransition().getToState()));
    }
}
```

## 실무에서 걸리는 지점

- **타임아웃 없는 서킷 브레이커는 스레드를 지키지 못한다.** 서킷 브레이커는 새 호출을 거부할 뿐 진행 중인 호출을 끊지 않는다. ==HTTP 클라이언트에 읽기 타임아웃이 없으면 응답이 멈춘 호출은 실패로도 느린 호출로도 기록되지 않은 채 스레드를 붙들고 있으므로 서킷이 열리지 않는다==. 타임아웃을 먼저 두고 그 위에 서킷을 얹는다.
- **비즈니스 예외를 실패로 세면 멀쩡한 서비스가 차단된다.** 잔액 부족·유효하지 않은 카드 같은 4xx 응답은 의존 서비스가 정상 동작한 결과다. 이를 `ignoreExceptions`로 빼지 않으면 특정 사용자군의 요청이 몰릴 때 서킷이 열려 모든 결제가 막힌다.
- **Open에서 Half-Open으로의 전이는 기본적으로 호출이 있어야 일어난다.** `automaticTransitionFromOpenToHalfOpenEnabled`가 false(기본값)면 대기 시간이 지나도 다음 호출이 들어올 때 비로소 전이된다. 트래픽이 끊긴 서비스는 헬스 체크에 OPEN으로 계속 남아 장애가 지속 중이라고 오판하기 쉽다.
- **서킷 상태는 인스턴스별이다.** 통계와 상태는 JVM 메모리에 있으므로 파드 10개 중 3개만 열려 있는 상황이 정상적으로 발생한다. Actuator의 `resilience4j.circuitbreaker.state` 메트릭을 인스턴스 태그와 함께 봐야 부분 차단을 읽을 수 있다.
- **같은 클래스 안에서의 호출에는 어노테이션이 적용되지 않는다.** Spring AOP 프록시를 거치지 않는 자기 호출(self-invocation)은 서킷 통계에 잡히지 않는다. 또한 `@Retry`와 함께 쓰면 기본 어스펙트 순서상 Retry가 바깥에 위치해 재시도 한 번 한 번이 서킷에 별도 호출로 기록된다.

## 관련 글

- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
- [벌크헤드 — 스레드 풀·세마포어로 자원 격리](/notes/architecture-patterns/bulkhead/)
- [헬스 체크 — Liveness와 Readiness](/notes/architecture-patterns/health-check/)
