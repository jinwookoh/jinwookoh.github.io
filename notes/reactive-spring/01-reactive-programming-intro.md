---
title: "리액티브 프로그래밍 — 왜 필요한가·Reactive Streams"
series: reactive-spring
part: "Reactor 기초"
order: 1
summary: "스레드당 요청 모델의 한계를 Reactive Streams 명세와 이벤트 루프가 어떻게 넘어서는지 정리한다"
tags: [Reactive Streams, Project Reactor, Spring WebFlux, Backpressure, Event Loop]
sources: [2026-05-03-reactive-basics.md, 2026-05-03-webflux-reactive-vs-traditional.md]
updated: 2026-08-29
---

자바 플랫폼 스레드는 OS 커널 스레드를 1:1로 감싸며 스레드마다 약 1MB의 스택을 예약한다. Spring MVC는 요청 하나에 스레드 하나를 배정하는 Thread-per-Request 모델이고 Tomcat의 기본 워커는 200개다. 외부 API 응답에 10초가 걸리면 동시 접속 200건만으로 모든 워커가 I/O 대기에 묶이고 새 요청은 큐에 쌓인다. 스레드를 1만 개로 늘리면 스택만으로 10GB 가까운 메모리를 잡는다. 리액티브 프로그래밍은 I/O 대기 중 스레드를 반납하고 데이터가 도착했을 때 이어서 처리하는 비동기 논블로킹 모델을 선언적으로 작성하게 해, 적은 스레드로 많은 동시 요청을 처리한다.

## 핵심 개념

리액티브 프로그래밍은 비동기, 논블로킹, 배압(소비자 속도에 맞춘 생산 조절), 관찰자 패턴의 네 속성으로 정의된다.

Reactive Streams는 라이브러리가 아니라 2014년에 정립된 명세다. JPA와 Hibernate의 관계처럼 명세를 구현한 것이 Project Reactor와 RxJava이며, Java 9부터 같은 계약이 `java.util.concurrent.Flow`에 표준으로 들어왔다. 명세는 네 개의 인터페이스로 이루어진다.

| 인터페이스 | 역할 |
|:---|:---|
| `Publisher<T>` | `subscribe(Subscriber)`로 구독을 받고 데이터를 발행한다 |
| `Subscriber<T>` | `onSubscribe`·`onNext`·`onError`·`onComplete` 콜백으로 소비한다 |
| `Subscription` | `request(n)`으로 요청 개수를 알리고 `cancel()`로 끊는다 |
| `Processor<T,R>` | Subscriber이면서 Publisher인 중간 단계 |

통신 순서는 `subscribe` → `onSubscribe` → `request(n)` → `onNext` 최대 n번 → `onComplete` 또는 `onError` 중 하나다. Publisher는 요청받은 개수를 초과해 보낼 수 없고, 데이터가 부족하면 적게 보내고 완료할 수 있다. 이 `request(n)` 계약이 배압의 실체다.

Project Reactor는 Spring 팀이 만든 구현체이자 WebFlux의 기반이다. 핵심 타입은 0~1개를 내는 `Mono<T>`와 0~N개(무한 포함)를 내는 `Flux<T>`이며, ID 단건 조회처럼 결과가 없을 수 있는 경우도 `Mono`다. 파이프라인은 `subscribe()` 전까지 실행되지 않고(Lazy), 별도 지정이 없으면 구독을 호출한 스레드에서 실행되며, 각 연산자는 기존 스트림을 바꾸지 않고 새 Publisher를 반환한다.

WebFlux는 기본적으로 Netty 위에서 동작한다. Boss Group이 연결을 수락하고 Worker Group의 이벤트 루프 스레드(기본 CPU 코어 수 × 2)가 채널별 이벤트를 처리한다. I/O는 OS 비동기 I/O에 위임하고 완료 이벤트가 오면 콜백을 실행하는 사이에 다른 요청을 계속 받는다. 컨트롤러가 `Mono`·`Flux`를 반환하면 프레임워크가 구독하고, 클라이언트가 연결을 끊으면 구독 취소가 `WebClient`를 거쳐 외부 연결까지 전파된다. 다만 상대 서비스가 MVC라면 TCP만 끊기고 내부 처리는 끝까지 진행된다.

## 코드

Reactive Streams 계약을 직접 구현한 학습용 Publisher다. `request(n)`이 호출된 만큼만 `onNext`를 내고 데이터가 소진되면 `onComplete`를 호출한다.

```java
import java.util.List;
import java.util.concurrent.Flow.Publisher;
import java.util.concurrent.Flow.Subscriber;
import java.util.concurrent.Flow.Subscription;

public class EmailPublisher implements Publisher<String> {

    private final List<String> emails = List.of(
        "user1@example.com", "user2@example.com", "user3@example.com");

    @Override
    public void subscribe(Subscriber<? super String> subscriber) {
        subscriber.onSubscribe(new EmailSubscription(subscriber, emails));
    }

    static final class EmailSubscription implements Subscription {
        private final Subscriber<? super String> subscriber;
        private final List<String> emails;
        private int index = 0;
        private volatile boolean cancelled = false;

        EmailSubscription(Subscriber<? super String> subscriber, List<String> emails) {
            this.subscriber = subscriber;
            this.emails = emails;
        }

        @Override
        public void request(long n) {
            long sent = 0;
            while (!cancelled && index < emails.size() && sent < n) {
                subscriber.onNext(emails.get(index++));
                sent++;
            }
            if (!cancelled && index >= emails.size()) {
                subscriber.onComplete();
            }
        }

        @Override
        public void cancel() {
            cancelled = true;
        }
    }

    public static void main(String[] args) {
        new EmailPublisher().subscribe(new Subscriber<>() {
            private Subscription subscription;

            @Override
            public void onSubscribe(Subscription s) {
                this.subscription = s;
                s.request(2);
            }

            @Override
            public void onNext(String email) {
                System.out.println("received: " + email);
                subscription.request(1);
            }

            @Override
            public void onError(Throwable t) {
                System.err.println("error: " + t.getMessage());
            }

            @Override
            public void onComplete() {
                System.out.println("completed");
            }
        });
    }
}
```

같은 일을 Reactor로 작성하면 파이프라인 정의와 구독이 분리된다. `subscribe()` 전까지 `doOnNext`는 실행되지 않는다.

```java
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public class ReactorBasics {

    public static void main(String[] args) {
        Mono<String> mono = Mono.just("Hello")
            .map(s -> s + " Reactive")
            .doOnNext(s -> System.out.println("pipeline: " + s));
        // 아직 아무것도 출력되지 않는다

        mono.subscribe(
            value -> System.out.println("onNext: " + value),
            error -> System.err.println("onError: " + error),
            () -> System.out.println("onComplete"));

        Flux.just(1, 2, 3, 4, 5)
            .filter(n -> n % 2 == 1)
            .subscribe(n -> System.out.println("odd: " + n));
    }
}
```

동일한 외부 API를 MVC와 WebFlux 컨트롤러가 호출하는 예다. 전통 컨트롤러는 응답을 모두 받을 때까지 스레드가 멈추고, 리액티브 컨트롤러는 `Flux`를 즉시 반환하며 실제 요청은 프레임워크가 구독하는 시점에 시작된다.

```java
import java.util.List;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;

record Product(Long id, String name, int price) {}

@RestController
@RequestMapping("/traditional")
class TraditionalProductController {

    private final RestClient restClient;

    TraditionalProductController(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("http://localhost:7070").build();
    }

    @GetMapping("/products")
    List<Product> products() {
        // 외부 응답이 끝날 때까지 이 스레드는 블로킹된다
        return restClient.get()
            .uri("/demo01/products")
            .retrieve()
            .body(new ParameterizedTypeReference<List<Product>>() {});
    }
}

@RestController
@RequestMapping("/reactive")
class ReactiveProductController {

    private final WebClient webClient;

    ReactiveProductController(WebClient.Builder builder) {
        this.webClient = builder.baseUrl("http://localhost:7070").build();
    }

    @GetMapping("/products")
    Flux<Product> products() {
        return webClient.get()
            .uri("/demo01/products")
            .retrieve()
            .bodyToFlux(Product.class)
            .doOnCancel(() -> System.out.println("client disconnected, upstream cancelled"));
    }
}
```

## 실무에서 걸리는 지점

- **이벤트 루프 위의 블로킹 호출.** JDBC, `Thread.sleep`, `RestTemplate`, `.block()`은 이벤트 루프 스레드를 점유해 서버 전체를 멈춘다. Netty는 코어 수만큼의 스레드가 전부다. 피할 수 없는 블로킹은 `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())`으로 격리한다.
- **컨트롤러 안에서의 `subscribe()`.** 프레임워크가 반환값을 구독하므로 직접 구독하면 외부 호출이 두 번 나간다. `doOnNext` 안의 중첩 구독도 오류 전파와 취소가 끊기므로 `flatMap`으로 체인에 편입한다.
- **`map`과 `flatMap`의 혼동.** 람다가 값을 반환하면 `map`, Publisher를 반환하면 `flatMap`이다. DB 조회를 `map`에 넣으면 `Mono<Mono<T>>`가 되어 안쪽 파이프라인이 구독되지 않는다.
- **"무조건 빠르다"는 오해.** 단일 요청 처리 시간은 MVC와 비슷하거나 약간 느리다. 이점은 동시 요청이 많고 I/O 대기 비중이 클 때 나타나며, CPU 집약 작업이나 단순 CRUD에는 없다. Java 21 가상 스레드는 요청-응답 패턴의 스레드 비용을 크게 줄이지만, 스트리밍과 배압이 필요한 경우는 여전히 리액티브가 적합하다.

## 관련 글

- [Mono와 Flux](/notes/reactive-spring/mono-flux/)
- [Backpressure](/notes/reactive-spring/backpressure/)
- [WebFlux 기본 — 애노테이션 컨트롤러와 Functional Endpoints](/notes/reactive-spring/webflux-basics-functional/)
