---
title: "Mono와 Flux"
series: reactive-spring
part: "Reactor 기초"
order: 2
summary: "Mono는 0~1개, Flux는 0~N개를 지연 방출하는 Publisher이며 팩토리·변환·에러 처리 연산자의 선택 기준을 정리한다."
tags: [Mono, Flux, Project Reactor, flatMap, WebFlux]
sources: [2026-05-03-reactive-mono.md, 2026-05-03-reactive-flux.md, 2026-05-02-spring-webflux-basics.md]
updated: 2026-08-29
---

Reactive Streams 명세는 네 인터페이스만 정의한다. 이것만으로 비동기 결과를 다루려면 신호 순서, `request(n)` 배압, 취소 처리를 매번 직접 구현해야 하고 변환·에러 복구 로직도 재사용되지 않는다. 단건 조회와 끝이 없는 스트림을 같은 타입으로 표현하면 호출자는 완료 시점을 예측할 수 없다. Project Reactor는 이 문제를 `Mono<T>`와 `Flux<T>` 두 타입과 연산자 체인으로 해결한다.

## 핵심 개념

`Mono<T>`는 0개 또는 1개의 요소를 방출하는 Publisher다. 완료 시나리오는 세 가지다. 값이 있으면 `onNext` 후 `onComplete`, 값이 없으면 `onComplete`만, 실패하면 `onError`가 온다. `Flux<T>`는 0개 이상, 무한을 포함한 요소를 순차 방출하며 마지막 요소 이후 또는 `cancel` 시점에 끝난다.

| 항목 | `Mono<T>` | `Flux<T>` |
|:---|:---|:---|
| 요소 수 | 0 또는 1 | 0 ~ N (무한 가능) |
| 용도 | `findById`, `save`, `deleteById` | `findAll`, 스트리밍, `interval` |
| 완료 | 요소 하나 방출 후 | 모든 요소 방출 후 또는 cancel |

두 타입 모두 `subscribe()` 전까지 아무 일도 일어나지 않는다. WebFlux 컨트롤러가 `Mono`/`Flux`를 반환하면 프레임워크가 구독하므로 애플리케이션 코드는 리액티브 타입을 그대로 반환한다.

팩토리 메서드는 평가 시점으로 갈린다. `Mono.just(expr)`는 생성 순간 `expr`을 평가하므로 상수에만 적합하다. `fromSupplier`·`fromCallable`은 구독 시점에 평가하고 후자는 체크드 예외를 `onError`로 변환한다. `defer`는 구독마다 새 Publisher를 만든다. `Mono.just(null)`은 `NullPointerException`이므로 값 없음은 `Mono.empty()`로 표현한다.

Flux는 `just`·`fromIterable`·`fromArray`가 정적 값, `range(start, count)`가 연속 정수, `interval(Duration)`이 parallel 스케줄러에서 주기적 Long 값을 낸다. `range`의 두 번째 인자는 개수다. `fromStream`에는 재구독을 위해 `list::stream`처럼 Supplier를 넘긴다. 동적 생성은 `generate`(`SynchronousSink`, 호출당 `next` 한 번, 상태 전달)·`create`(`FluxSink`, 다중 방출, 멀티스레드 안전)·`push`(`create`와 같되 단일 스레드 전용)로 나뉜다.

`map`은 동기 1:1 변환, `flatMap`은 함수가 반환한 Publisher를 구독해 평탄화한다. `map` 안에서 `Mono`를 반환하면 `Mono<Mono<T>>`가 되어 내부 Mono가 구독되지 않는다. ==`zipWith`는 두 Mono를 동시에 구독해 결합하며 한쪽이 empty면 전체가 empty다.==

에러는 던지지 않고 신호로 다룬다. `onErrorReturn`은 값으로 대체해 정상 완료로 바꾸고, `onErrorResume`은 대체 Publisher로 전환하며, `onErrorMap`은 타입만 바꾸고 에러를 계속 흘린다. `switchIfEmpty`·`defaultIfEmpty`는 빈 완료를 대체한다. 타입 변환은 `mono.flux()`, `flux.next()`, `flux.collectList()`를 쓴다.

## 코드

`just`·`fromSupplier`·`defer`의 평가 시점 차이. 카운터 값으로 확인한다.

```java
import java.util.concurrent.atomic.AtomicInteger;
import reactor.core.publisher.Mono;

public class FactoryTiming {

    public static void main(String[] args) {
        AtomicInteger counter = new AtomicInteger();

        Mono<Integer> just = Mono.just(counter.incrementAndGet());        // 생성 즉시 1
        Mono<Integer> lazy = Mono.fromSupplier(counter::incrementAndGet); // 구독 시 평가
        Mono<Integer> defer = Mono.defer(() -> Mono.just(counter.incrementAndGet()));

        just.subscribe(v -> System.out.println("just  " + v));   // 1
        just.subscribe(v -> System.out.println("just  " + v));   // 1
        lazy.subscribe(v -> System.out.println("lazy  " + v));   // 2
        lazy.subscribe(v -> System.out.println("lazy  " + v));   // 3
        defer.subscribe(v -> System.out.println("defer " + v));  // 4
        defer.subscribe(v -> System.out.println("defer " + v));  // 5
    }
}
```

`generate`로 상태 기반 순차 생성, `takeWhile`과 `takeUntil`의 경계 포함 여부 비교.

```java
import reactor.core.publisher.Flux;

public class FluxGenerateTake {

    public static void main(String[] args) {
        Flux<String> items = Flux.generate(
                () -> 0,
                (state, sink) -> {
                    sink.next("item-" + state);      // 호출당 next는 한 번만
                    if (state >= 9) sink.complete();
                    return state + 1;
                });
        items.subscribe(System.out::println);           // item-0 ~ item-9

        Flux.range(1, 10).takeWhile(n -> n < 5)
                .subscribe(System.out::println);        // 1 2 3 4
        Flux.range(1, 10).takeUntil(n -> n == 5)
                .subscribe(System.out::println);        // 1 2 3 4 5
    }
}
```

R2DBC 리포지토리 위에 변환·빈 결과·에러 연산자를 조합한 서비스와 컨트롤러.

```java
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class ProductService {

    private final ProductRepository repository;   // ReactiveCrudRepository<Product, Long>

    public ProductService(ProductRepository repository) {
        this.repository = repository;
    }

    public Flux<ProductDto> list() {
        return repository.findAll().map(ProductDto::from);
    }

    public Mono<ProductDto> update(Long id, ProductDto dto) {
        return repository.findById(id)
                .switchIfEmpty(Mono.error(new NotFoundException(id)))
                .map(found -> found.withName(dto.name()).withPrice(dto.price()))
                .flatMap(repository::save)                 // save가 Mono를 반환하므로 flatMap
                .map(ProductDto::from)
                .onErrorMap(DataAccessException.class,
                        e -> new ServiceException("product update failed", e));
    }
}

@RestController
@RequestMapping("/api/v1/products")
class ProductController {

    private final ProductService service;

    ProductController(ProductService service) {
        this.service = service;
    }

    @GetMapping
    Flux<ProductDto> list() {
        return service.list();
    }

    @PutMapping("/{id}")
    Mono<ProductDto> update(@PathVariable Long id, @RequestBody ProductDto dto) {
        return service.update(id, dto);      // 프레임워크가 구독한다
    }
}
```

## 실무에서 걸리는 지점

- **이벤트 루프 안의 `block()`.** 핸들러나 연산자 내부에서 `block()`을 호출하면 결과를 만들 스레드가 자기 자신이라 데드락이 난다. 테스트와 main 최외곽에서만 허용하고, 블로킹 I/O는 `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())`으로 격리한다.
- **`Mono.just`에 무거운 호출.** ==`Mono.just(blockingQuery())`는 생성 시점에 실행되어 재시도·조건부 실행이 동작하지 않는다.== `fromSupplier`·`fromCallable`·`defer`를 기본으로 쓴다.
- **구독되지 않은 파이프라인.** ==`void` 메서드에서 `repository.deleteById(id)`만 호출하면 실행되지 않는다.== 리액티브 타입을 끝까지 반환한다.
- **`interval`과 프로세스 종료.** 별도 스레드에서 돌기 때문에 main이 먼저 끝나면 출력이 없다. 테스트는 `StepVerifier` 가상 시간을 쓰고 무한 스트림에는 `take`로 상한을 둔다.
- **`generate`·`create` 계약 위반.** `generate`에서 `next`를 두 번 호출하면 `IllegalStateException`, `create`에서 `complete()`를 빠뜨리면 요청이 끝나지 않는다. `create`에는 `OverflowStrategy`를 명시한다.

## 관련 글

- [리액티브 프로그래밍 — 왜 필요한가·Reactive Streams](/notes/reactive-spring/reactive-programming-intro/)
- [연산자 — 변환·결합·배칭](/notes/reactive-spring/operators-combining-batching/)
- [Hot/Cold Publisher와 Sinks](/notes/reactive-spring/hot-cold-sinks/)
