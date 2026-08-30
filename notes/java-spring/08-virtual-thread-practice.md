---
title: "Virtual Thread — 실전·Spring Boot·Structured Concurrency"
series: java-spring
part: "자바 기초·모던 자바"
order: 8
summary: "Spring Boot 설정 한 줄로 Virtual Thread를 켠 뒤, 병렬 호출·외부 자원 보호·측정을 어떻게 설계하는가"
tags: [Virtual Thread, Spring Boot, Structured Concurrency, ScopedValue, JFR]
sources: [2026-05-03-vt-patterns.md, 2026-05-03-vt-performance.md, 2026-05-03-vt-spring-boot.md, 2026-05-03-vt-structured-concurrency.md]
updated: 2026-08-29
---

Tomcat 기본 워커 풀은 200개다. 요청이 외부 API나 DB 응답을 기다리는 동안 스레드가 묶이고, 동시 요청이 200을 넘으면 나머지는 큐에서 대기한다. 처리량을 올리려면 WebFlux로 다시 쓰거나 풀을 키워 메모리를 소모해야 했다. Virtual Thread를 서블릿 컨테이너와 `@Async`에 연결하면 동기 코드를 그대로 두고 이 한계를 넘는다. 다만 병목은 DB 커넥션과 외부 API로 옮겨가고, 여러 스레드를 한 작업 단위로 묶어 실패와 취소를 전파할 구조가 필요해진다.

## 핵심 개념

Spring Boot 3.2 이상과 Java 21에서 `spring.threads.virtual.enabled=true` 한 줄이 Tomcat·Jetty·Undertow 워커, `@Async` 실행기, `@Scheduled` 작업 스레드, 자동 구성 `TaskExecutor` 빈을 모두 Virtual Thread로 바꾼다. 직접 등록한 `ThreadPoolTaskExecutor`는 `VirtualThreadTaskExecutor`(Spring 6.1+)로 교체한다. 작업당 스레드를 새로 만드는 모델에서 풀 크기·큐 용량 설정은 의미가 없다.

MVC에 Virtual Thread를 얹으면 I/O 대기 위주 워크로드에서 WebFlux와 비슷한 처리량을 내면서 프로그래밍 모델은 동기 그대로다. WebFlux는 백프레셔가 결정적인 스트리밍이나 R2DBC 같은 Reactive 드라이버가 전제인 경우에 남는다. HTTP 클라이언트는 `RestClient`(Spring 6.1+)가 기본이다.

Structured Concurrency는 여러 Virtual Thread를 부모 스코프 안에서 시작하고 끝내는 규칙이다. `ExecutorService`의 `Future`는 하나가 실패해도 나머지가 계속 돈다. `StructuredTaskScope`는 try-with-resources로 열고 `fork`로 자식을 시작한 뒤 `join`으로 대기하며, 스코프를 벗어날 때 남은 자식을 정리한다. `ShutdownOnFailure`는 하나라도 실패하면 나머지를 interrupt하고 `throwIfFailed`로 예외를 던진다. `ShutdownOnSuccess`는 첫 성공 시 나머지를 취소하고 `result`로 반환한다. `joinUntil(Instant)` 초과 시에는 `TimeoutException`과 함께 자식이 취소된다. `Subtask.get()`은 상태가 SUCCESS일 때만 호출할 수 있다.

컨텍스트 전달은 `ScopedValue`를 쓴다. `ThreadLocal`은 수동 `remove`가 필요하고 스레드 수만큼 메모리가 는다. `ScopedValue`는 불변이고 스코프 종료 시 자동 해제되며 자식 스레드에 자동 상속된다. ==두 API 모두 Java 21에서는 Preview(`--enable-preview`)이고 이후 버전에서 재설계되었으므로 운영 반영은 JDK 버전을 확인한 뒤 결정한다.==

## 코드

Virtual Thread를 켜고 HikariCP 크기를 고정한다. 커넥션 풀 크기는 Virtual Thread 수와 무관하게 DB가 견디는 수준(보통 10~30)으로 둔다.

```yaml
spring:
  threads:
    virtual:
      enabled: true
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 10
management:
  endpoints:
    web:
      exposure:
        include: prometheus,metrics,threaddump
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
```

외부 서비스 세 개를 병렬 호출하고 2초 데드라인을 건 Fan-out이다. 하나가 실패하거나 시간이 초과되면 나머지가 취소된다.

```java
import java.time.Instant;
import java.util.concurrent.StructuredTaskScope;
import java.util.concurrent.StructuredTaskScope.Subtask;
import java.util.concurrent.TimeoutException;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class DashboardService {

    private final RestClient restClient = RestClient.create();

    public Dashboard load(String userId) throws InterruptedException {
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            Subtask<User> user = scope.fork(() -> get("/users/" + userId, User.class));
            Subtask<Orders> orders = scope.fork(() -> get("/orders?user=" + userId, Orders.class));
            Subtask<Profile> profile = scope.fork(() -> get("/profiles/" + userId, Profile.class));

            scope.joinUntil(Instant.now().plusSeconds(2));
            scope.throwIfFailed(DashboardException::new);

            return new Dashboard(user.get(), orders.get(), profile.get());
        } catch (TimeoutException e) {
            throw new DashboardException(e);
        }
    }

    private <T> T get(String path, Class<T> type) {
        return restClient.get().uri("http://api.internal" + path).retrieve().body(type);
    }
}
```

외부 API를 `Semaphore`로 보호하면서 `ScopedValue`로 컨텍스트를 자식에 전달한다. `Semaphore.acquire`는 대기 중 캐리어를 반납한다.

```java
import java.util.concurrent.Semaphore;
import java.util.concurrent.StructuredTaskScope;

public class PriceAggregator {

    static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();
    private final Semaphore vendorLimit = new Semaphore(50);

    public Quote quote(String traceId, String sku) throws Exception {
        return ScopedValue.where(TRACE_ID, traceId).call(() -> {
            try (var scope = new StructuredTaskScope.ShutdownOnSuccess<Quote>()) {
                scope.fork(() -> ask(vendorA, sku));
                scope.fork(() -> ask(vendorB, sku));
                scope.join();
                return scope.result();
            }
        });
    }

    private Quote ask(Vendor vendor, String sku) throws InterruptedException {
        vendorLimit.acquire();
        try {
            return vendor.quote(sku, TRACE_ID.get());
        } finally {
            vendorLimit.release();
        }
    }
}
```

## 실무에서 걸리는 지점

- **무제한 동시성은 DB와 외부 API 폭주로 이어진다.** ==Platform Thread 풀은 그 자체가 백프레셔였다.== Virtual Thread에서는 커넥션을 못 얻은 스레드가 HikariCP 앞에 무한정 쌓이므로 `Semaphore`·RateLimiter·Circuit Breaker를 명시적으로 둔다.
- **Pinning 비율이 처리량을 직접 깎는다.** ==1,000 동시 요청에서 Pinning 30%만 있어도 처리 시간이 약 1초에서 3초로 는다.== JDBC 드라이버·HikariCP·Logback을 최신으로 올리고 JFR의 `jdk.VirtualThreadPinned` 이벤트로 추적한다. Java 24부터는 `synchronized` 안의 블로킹이 Pinning을 일으키지 않는다.
- **CPU 집약 작업은 이득이 없다.** 캐리어 전환 비용만 더해지므로 `ForkJoinPool`로 분리한다. Virtual Thread를 `newFixedThreadPool`에 넣는 것도 재사용 이득이 없으므로 `newVirtualThreadPerTaskExecutor`를 쓴다.
- **자동 취소는 interrupt에 의존한다.** `Thread.sleep`·소켓 I/O처럼 interrupt에 반응하는 지점이 있어야 멈추므로 루프 연산은 `isInterrupted()`를 검사한다. `ShutdownOnSuccess` 기반 Race는 비용이 후보 수만큼 는다.
- **측정 없이 도입 효과를 판단하지 않는다.** 처리량·p99 지연·메모리를 전후 비교한다. Actuator의 `http.server.requests` 히스토그램과 `jvm.threads.virtual.live`·`peak`를 Prometheus로 수집하고, 부하는 wrk·Gatling, 운영 워크로드는 JFR 캡처 후 JMC로 본다. Virtual Thread 스택은 힙에 있어 수백만 개가 살아 있으면 GC 빈도가 오른다.

## 관련 글

- [Virtual Thread — 원리·API·Pinning](/notes/java-spring/virtual-thread-basics/)
- [이벤트·비동기·스케줄링](/notes/java-spring/events-async-scheduling/)
- [HTTP 클라이언트 — RestClient](/notes/java-spring/http-client-restclient/)
