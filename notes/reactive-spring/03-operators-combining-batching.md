---
title: "연산자 — 변환·결합·배칭"
series: reactive-spring
part: "Reactor 기초"
order: 3
summary: "flatMap·zip·buffer 계열 연산자를 순서·동시성·완료 조건이라는 세 축으로 골라 쓰는 기준을 정리한다"
tags: [Project Reactor, flatMap, zip, buffer, groupBy]
sources: [2026-05-03-reactive-operators.md, 2026-05-03-reactive-combining-publishers.md, 2026-05-03-reactive-batching-windowing-grouping.md]
updated: 2026-08-29
---

Mono와 Flux는 데이터가 흐르는 통로일 뿐이고, 비즈니스 로직은 그 사이에 끼우는 연산자로 표현한다. 연산자 없이 `subscribe` 콜백 안에서 변환·분기·집계를 처리하면 콜백 중첩이 다시 생기고, 여러 소스의 결합이나 N건 단위 일괄 처리를 매번 직접 구현해야 한다. 문제는 연산자 이름이 비슷하다는 점이다. `flatMap`·`concatMap`·`switchMap`, `merge`·`concat`·`zip`, `buffer`·`window`·`groupBy`는 순서·동시성·완료 조건이 각각 다르며, 이 축을 모르고 고르면 순서가 뒤섞이거나 데이터가 조용히 버려지거나 메모리가 누수된다.

## 핵심 개념

연산자는 기존 Publisher를 감싸 새 Publisher를 반환하며 원본은 변경하지 않는다.

**변환·필터·집계.** `map`은 동기 1:1 변환이며 null을 반환하면 NullPointerException이 발생한다. 결과가 Publisher라면 `flatMap` 계열을 쓴다. `reduce`는 최종 누산값 하나를 `Mono<T>`로, `scan`은 초기값을 포함한 매 단계 누산값을 `Flux<T>`로 방출한다. `doOn*` 계열은 부수효과만 실행하므로 `doOnNext` 안에서 값을 바꿔도 반영되지 않는다. 빈 스트림에는 `defaultIfEmpty`·`switchIfEmpty`를, 에러에는 `onErrorReturn`·`onErrorResume`을 에러가 발생하는 연산자 뒤에 둔다.

**1→N 변환.** 세 연산자 모두 아이템마다 내부 Publisher를 만들지만 구독 방식이 다르다.

| 연산자 | 내부 구독 | 순서 | 이전 내부 Publisher |
|:---|:---|:---|:---|
| `flatMap` | 동시 | 보장 안 함 | 유지 |
| `concatMap` | 하나 완료 후 다음 | 보장 | 유지 |
| `switchMap` | 최신 하나만 | 최신만 | 취소 |

**N→1 결합.** `concat`은 앞 소스가 완료된 뒤 다음 소스를 구독해 순서를 보장하고, `merge`는 모든 소스를 동시에 구독해 도착 순서대로 내보낸다. `zip`은 각 소스의 같은 인덱스 아이템을 묶으며 가장 짧은 소스가 끝나면 완료된다. `combineLatest`는 어느 소스든 새 값이 오면 모든 소스의 최신 값을 조합하되, 모든 소스에 최초 값이 생기기 전까지는 방출하지 않는다. `startWith`는 앞에 prefix를 붙이고, `firstWithSignal`·`firstWithValue`는 가장 먼저 신호를 낸 소스만 남기고 나머지를 취소한다.

**배칭.** `buffer`는 `Flux<List<T>>`, `window`는 `Flux<Flux<T>>`, `groupBy`는 `Flux<GroupedFlux<K,T>>`를 반환한다. buffer는 리스트가 완성된 뒤에야 원소에 접근할 수 있고 그만큼 메모리를 쓴다. window와 groupBy는 내부 스트림이 열리는 순간부터 원소를 흘려보내지만, 내부 Flux를 `flatMap` 등으로 구독하지 않으면 데이터가 흐르지 않는다. 배치 경계는 개수(`buffer(n)`), 시간(`buffer(Duration)`), 둘 중 먼저 충족되는 쪽(`bufferTimeout`), 겹치는 구간(`buffer(n, skip)`)으로 잡는다.

## 코드

Java 21, Spring Boot 3.x 기준이며 각 Client는 WebClient를 감싼 빈이다. 독립된 서비스 세 개를 병렬 호출해 하나로 결합하고, 사용자별 주문 조회는 입력 순서를 유지한다.

```java
@Service
public class ProductFacade {

    private static final Logger log = LoggerFactory.getLogger(ProductFacade.class);

    private final ProductClient productClient;
    private final ReviewClient reviewClient;
    private final PriceClient priceClient;
    private final OrderClient orderClient;

    public ProductFacade(ProductClient productClient, ReviewClient reviewClient,
                         PriceClient priceClient, OrderClient orderClient) {
        this.productClient = productClient;
        this.reviewClient = reviewClient;
        this.priceClient = priceClient;
        this.orderClient = orderClient;
    }

    // 독립 호출 3개 → Mono.zip: 모두 완료된 뒤 한 번 결합
    public Mono<ProductView> view(String productId) {
        return Mono.zip(
                productClient.name(productId),
                reviewClient.summary(productId).defaultIfEmpty("리뷰 없음"),
                priceClient.price(productId))
            .map(t -> new ProductView(t.getT1(), t.getT2(), t.getT3()))
            .doOnError(e -> log.warn("product view 실패: {}", productId, e));
    }

    // 결과 순서가 입력 순서와 같아야 하므로 concatMap
    public Flux<Order> ordersInUserOrder(Flux<String> userIds) {
        return userIds.concatMap(orderClient::ordersOf);
    }
}
```

검색어가 바뀌면 이전 요청을 취소하고 최신 검색어의 결과만 내보낸다. 값싼 필터를 앞에 두어 호출 횟수를 줄인다.

```java
public Flux<String> suggest(Flux<String> keywordInput, List<String> cached) {
    return keywordInput
        .filter(q -> q.length() >= 2)
        .distinctUntilChanged()
        .switchMap(searchClient::search)
        .startWith(Flux.fromIterable(cached));   // 캐시 먼저, 실시간 결과는 뒤에
}
```

주문을 카테고리별로 분기한 뒤 100건 또는 1초 중 먼저 차는 배치 단위로 저장한다.

```java
public Flux<Long> batchSave(Flux<Order> orders) {
    return orders
        .groupBy(Order::category)                       // 카디널리티가 낮은 키만
        .flatMap(group -> group
            .bufferTimeout(100, Duration.ofSeconds(1))
            .flatMap(batch -> orderRepository.saveAll(batch).count()
                .doOnNext(n -> log.info("{} 배치 저장 {}건", group.key(), n))));
}
```

## 실무에서 걸리는 지점

**flatMap의 순서 뒤섞임과 동시성 폭주.** 결제·이벤트 적재처럼 순서가 의미 있는 처리에 `flatMap`을 쓰면 결과가 뒤섞인다. 순서가 필요하면 `concatMap`, 순서는 지키되 내부 구독은 동시에 하려면 `flatMapSequential`을 쓴다. 기본 동시성 256을 외부 API 호출에 그대로 두면 연결이 폭주하므로 `flatMap(fn, concurrency)`로 상한을 명시한다.

**zip의 조용한 유실.** `zip`은 가장 짧은 소스가 끝나는 순간 완료되어 남은 아이템은 버려진다. `Mono.zip`은 하나라도 empty이면 결과 전체가 empty가 되므로 선택적 데이터에는 `defaultIfEmpty`를 먼저 붙인다.

**에러 전파 범위.** `merge` 중 한 소스가 에러를 내면 나머지 소스는 즉시 취소되고, `concat`은 에러 이후 소스를 구독하지 않는다. 에러를 마지막에 받으려면 `concatDelayError`·`mergeDelayError`를, 소스 단위 격리가 필요하면 결합 전에 각 소스에 `onErrorResume`을 붙인다.

**buffer(n)의 마지막 배치와 무한 대기.** 스트림이 완료되면 n개 미만인 마지막 배치도 방출되므로 배치 크기를 고정값으로 가정하면 안 된다. 완료되지 않는 스트림에서는 n개가 찰 때까지 마지막 배치가 나오지 않으므로 `bufferTimeout`을 쓴다. `buffer(Duration)`은 구간에 아이템이 없으면 빈 리스트를 방출한다.

**groupBy의 카디널리티와 미구독 그룹.** 키마다 `GroupedFlux`가 생기므로 무한 스트림에서 고유 키를 쓰면 그룹이 누적되어 메모리가 고갈된다. 그룹을 구독하지 않으면 내부 prefetch가 차면서 상류가 멈춘다. 키는 상태·카테고리처럼 유한한 값으로 제한하고, 무한 스트림에서는 그룹마다 `take`나 `buffer`로 경계를 둔다.

## 관련 글

- [Mono와 Flux](/notes/reactive-spring/mono-flux/)
- [Backpressure](/notes/reactive-spring/backpressure/)
- [Repeat·Retry와 StepVerifier](/notes/reactive-spring/retry-stepverifier/)
