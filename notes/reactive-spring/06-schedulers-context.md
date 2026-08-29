---
title: "Schedulers·스레딩·Context"
series: reactive-spring
part: "Reactor 심화"
order: 6
summary: "Reactor는 기본이 동기 실행이다. 스레드는 Schedulers로 옮기고, 요청 범위 데이터는 ThreadLocal 대신 Context로 전파한다."
tags: [Project Reactor, Schedulers, subscribeOn, publishOn, Reactor Context]
sources: [2026-05-03-reactive-threading-schedulers.md, 2026-05-03-reactive-context.md]
updated: 2026-08-29
---

Project Reactor는 `subscribeOn`이나 `publishOn`을 명시하지 않으면 소스부터 `subscribe` 콜백까지 호출자 스레드에서 동기적으로 실행한다. 비동기는 기본값이 아니라 개발자가 켜는 옵션이다. 파이프라인에 JDBC 조회를 넣으면 이벤트 루프 스레드가 응답을 기다리며 멈춘다. 반대로 스레드를 옮기면 요청 범위 데이터를 전파하던 `ThreadLocal`이 값을 잃는다. 전자는 Schedulers가, 후자는 Reactor Context가 담당한다.

## 핵심 개념

### Scheduler 종류

선택 기준은 작업이 블로킹인지, CPU를 쓰는지, 순서를 보장해야 하는지다.

| Scheduler | 스레드 수 | 용도 | 블로킹 허용 |
|:---|:---|:---|:---|
| `boundedElastic()` | 동적, 상한 CPU 코어×10 (스레드당 대기 큐 100,000) | 블로킹 I/O | O |
| `parallel()` | CPU 코어 수 고정 | CPU 집약 연산 | X |
| `single()` | 1 | 순차 처리 | X |
| `immediate()` | 현재 스레드 | 전환 없음, 테스트용 | - |

글로벌 인스턴스는 JVM 전체가 공유하므로 모듈별 격리가 필요하면 `Schedulers.newBoundedElastic(threadCap, queuedTaskCap, name)`으로 독립 인스턴스를 만든다.

### subscribeOn과 publishOn

두 연산자는 영향 범위가 반대다.

| 연산자 | 영향 범위 | 전파 방향 | 여러 개일 때 | 위치 |
|:---|:---|:---|:---|:---|
| `subscribeOn` | 소스를 포함한 upstream 전체 | 구독 신호 (아래→위) | 소스에 가장 가까운 것만 유효 | 무관 |
| `publishOn` | 해당 지점 이후 downstream | 데이터 신호 (위→아래) | 각각 유효 | 결과를 결정 |

`subscribeOn`은 구독 신호가 upstream으로 올라가며 처음 만나는 것이 소스의 실행 스레드를 결정하므로 체인 어디에 두어도 같다. `publishOn`은 데이터가 내려오다가 그 지점에서 스레드를 바꾸므로 그 위의 연산자는 영향을 받지 않고, 두 번 쓰면 두 번 전환된다.

`parallel()` 연산자는 Flux를 여러 rail로 분기할 뿐 스레드 풀인 `Schedulers.parallel()`과 다르다. `parallel().runOn(scheduler)`로 함께 써야 rail이 다른 스레드에서 돈다.

### Reactor Context

Context는 스레드가 아니라 구독에 붙는 불변 키-값 저장소라 스레드가 바뀌어도 유지된다. `contextWrite`로 쓰고 `deferContextual`로 읽는다. 전파 방향은 데이터와 반대인 downstream에서 upstream, 즉 구독 신호와 같은 방향이다. 따라서 `contextWrite`는 읽는 연산자보다 코드상 아래에 있어야 하며, 여러 개면 아래 것이 먼저 적용된다.

`ctx.put(k, v)`는 새 인스턴스를 반환하므로 반환값을 버리면 아무 변화가 없다. `ctx.get(k)`는 키가 없으면 `NoSuchElementException`을 던지므로 `getOrDefault`로 방어한다.

## 코드

블로킹 소스는 `boundedElastic`에서 읽고, CPU 가공은 `publishOn`으로 `parallel`에 넘기는 조합이다. `subscribeOn`은 소스에, `publishOn`은 전환 지점에 둔다.

```java
Flux.fromIterable(readLargeFile())          // 블로킹 I/O
    .subscribeOn(Schedulers.boundedElastic())
    .filter(line -> !line.isBlank())        // boundedElastic
    .publishOn(Schedulers.parallel())
    .map(this::processLine)                 // parallel
    .subscribe(this::saveResult);
```

`flatMap` 안에서 항목마다 `subscribeOn`을 걸면 블로킹 호출이 항목별로 동시에 실행된다. 블로킹 API인 `JdbcClient`는 `fromCallable`로 감싼다.

```java
Flux<String> names(JdbcClient jdbc, List<Long> ids) {
    return Flux.fromIterable(ids)
        .flatMap(id -> Mono.fromCallable(() ->
                jdbc.sql("SELECT name FROM users WHERE id = :id")
                    .param("id", id)
                    .query(String.class)
                    .single())
            .subscribeOn(Schedulers.boundedElastic()),
            8);                                 // 동시성 상한
}
```

WebFilter에서 헤더를 Context에 쓰고 서비스에서 읽는다. `chain.filter(exchange)` 뒤에 붙인 `contextWrite`는 컨트롤러·서비스 전체에서 보인다. `null`은 넣을 수 없으므로 헤더 부재를 먼저 처리한다.

```java
@Component
public class UserContextFilter implements WebFilter {
    static final String USER_ID = "userId";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
        Mono<Void> next = chain.filter(exchange);
        return userId == null
            ? next
            : next.contextWrite(ctx -> ctx.put(USER_ID, userId));
    }
}

@Service
public class OrderService {
    private final OrderRepository orders;
    OrderService(OrderRepository orders) { this.orders = orders; }

    public Flux<Order> myOrders() {
        return Flux.deferContextual(ctx -> {
            String userId = ctx.getOrDefault(UserContextFilter.USER_ID, "anonymous");
            return orders.findByUserId(userId);
        });
    }
}
```

## 실무에서 걸리는 지점

- **`parallel`에서 블로킹.** JDBC나 파일 I/O를 `Schedulers.parallel()`이나 Netty 이벤트 루프에서 호출하면 코어 수만큼의 요청이 동시에 들어올 때 서버 전체가 멈춘다. 블로킹은 `boundedElastic`으로 보내고, BlockHound를 테스트에 붙여 검출한다.
- **체인 내부 `block()`.** `flatMap` 안에서 다른 Mono를 `block()`하면 같은 풀을 기다리는 데드락이 생길 수 있고, `parallel` 스레드에서는 `IllegalStateException`이 난다. 내부 Publisher는 `flatMap`으로 연결한다.
- **`subscribeOn` 중복.** 라이브러리가 반환한 Mono에 이미 `subscribeOn`이 걸려 있으면 호출 측에서 다시 걸어도 무시된다.
- **`boundedElastic` 큐 적체.** 상한을 넘는 작업은 큐에 쌓이고 `queuedTaskCap`을 초과하면 `RejectedExecutionException`이 난다. `flatMap`의 동시성 인자로 유입을 제한한다.
- **Context와 MDC 연동.** Context는 로깅 MDC에 자동 반영되지 않는다. Reactor 3.5 이상에서 `context-propagation` 라이브러리와 `Hooks.enableAutomaticContextPropagation()`을 쓰면 연산자 경계마다 MDC가 복원되며, Spring Boot 3.x의 Micrometer Tracing이 이 방식으로 traceId를 전파한다.

## 관련 글

- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
- [Backpressure](/notes/reactive-spring/backpressure/)
- [WebFilter·예외 처리·검증](/notes/reactive-spring/webfilter-error-handling/)
