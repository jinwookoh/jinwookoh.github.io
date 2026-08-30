---
title: "WebFlux 성능과 마이크로서비스"
series: reactive-spring
part: "WebFlux"
order: 12
summary: "이벤트 루프를 막지 않는 설정과 서비스 조합 패턴을 갖춰야 WebFlux의 처리량이 실제로 나온다."
tags: [Spring WebFlux, WebClient, Schedulers, Resilience4j, Virtual Threads]
sources: [2026-05-03-webflux-performance.md, 2026-05-03-webflux-reactive-microservices.md, 2026-05-03-webflux-whats-next.md]
updated: 2026-08-29
---

==WebFlux를 도입했다는 사실만으로 처리량이 오르지는 않는다.== 이벤트 루프 스레드는 CPU 코어 수만큼만 있고, 그중 하나가 JPA 호출이나 파일 I/O에 붙잡히면 그 스레드가 담당하던 모든 요청이 함께 멈춘다. 연결 풀 없이 외부 서비스를 호출하면 요청마다 TCP 핸드셰이크가 반복되고, `flatMap`의 기본 동시성 256은 하위 서비스에 조용히 과부하를 건다. Aggregator에서 호출을 순차로 엮으면 지연이 합산되고, 하위 서비스 하나의 장애가 상위까지 전파된다.

## 핵심 개념

최적화 순서는 블로킹 코드 제거, 연결 풀, 응답 압축, `flatMap` 동시성 제한, 캐싱이며 서버 증설은 마지막이다. ==병목이 코드 안에 있으면 인스턴스를 늘려도 해결되지 않는다.==

**블로킹 격리.** 블로킹 호출은 `Mono.fromCallable`로 감싸고 `subscribeOn(Schedulers.boundedElastic())`으로 별도 풀에 보낸다. 기본 최대 스레드는 CPU 코어 × 10(최소 10), 대기 큐는 100,000개이며 큐가 차면 `RejectedExecutionException`이 발생한다. CPU 집약 작업은 `parallel()`을 쓰고, 개발 환경에서는 BlockHound로 블로킹 호출을 잡아낸다.

**연결 풀.** Reactor Netty의 `ConnectionProvider`로 `maxConnections`, `maxIdleTime`, `maxLifeTime`, `pendingAcquireTimeout`을 지정한다. `maxConnections`는 초당 최대 요청 수 × 평균 응답 시간(초)에 여유를 더해 잡는다.

**압축.** 서버는 `server.compression.enabled=true`에 더해 `min-response-size`와 `mime-types`를 명시하고, 클라이언트는 `HttpClient.create().compress(true)`로 `Accept-Encoding` 헤더를 보내야 압축 응답을 받는다.

**동시성 제어.** `flatMap(mapper, concurrency)`의 두 번째 인자로 동시 구독 수를 제한한다. 순서가 필요하면 `flatMapSequential`, 순차 실행이 필요하면 `concatMap`을 쓴다.

**서비스 조합.** 독립적인 두 호출은 `Mono.zip`으로 동시에 시작해 총 시간을 max(A, B)로 줄인다. `flatMap`으로 이으면 A + B가 된다. 하위 서비스의 HTTP 상태는 `onStatus`로 도메인 예외로 변환하고, 존재 검사와 조건 검사는 `switchIfEmpty`를 단계별로 분리해 오류 원인을 구분한다.

**트랜잭션.** R2DBC의 `@Transactional`은 구독 시점에 트랜잭션을 열고 완료 시 커밋, 오류 시 롤백한다. 같이 묶을 저장은 하나의 파이프라인 안에서 `Mono.zip`으로 실행해야 하며, 별도 `subscribe()`는 별도 트랜잭션이다. 서비스 간 2PC는 쓰지 않고 Saga 패턴으로 보상 트랜잭션을 설계한다.

**탄력성.** 타임아웃과 `onErrorReturn`이 최소 방어선이고, 운영에서는 Resilience4j의 Circuit Breaker(CLOSED → OPEN → HALF-OPEN)와 Bulkhead를 붙인다. TraceID는 ThreadLocal이 아니라 Reactor Context로 전파되며, Micrometer Tracing이 `WebClient` 호출에 `traceparent` 헤더를 자동으로 싣는다.

**가상 스레드와의 관계.** Java 21 가상 스레드는 기존 JPA·JDBC 코드를 유지한 채 동시성을 높일 때 적합하고, 스트리밍·취소 전파·백프레셔는 Reactor의 영역이다. Spring Boot 3.2+에서는 `spring.threads.virtual.enabled=true`로 켠다.

## 코드

블로킹 리포지토리 호출을 boundedElastic으로 격리하고, 결과를 TTL과 함께 캐싱한다.

```java
@Service
public class ProductQueryService {

    private final ProductJpaRepository jpaRepository;
    private final Map<Long, Mono<ProductDto>> cache = new ConcurrentHashMap<>();

    public ProductQueryService(ProductJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    public Mono<ProductDto> findById(Long id) {
        return cache.computeIfAbsent(id, key ->
                Mono.fromCallable(() -> jpaRepository.findById(key).orElseThrow())
                        .subscribeOn(Schedulers.boundedElastic())
                        .map(ProductDto::from)
                        .cache(Duration.ofMinutes(10)));
    }
}
```

연결 풀·압축·타임아웃을 갖춘 WebClient 빈. 주입해 재사용해야 풀이 공유된다.

```java
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient productWebClient() {
        ConnectionProvider provider = ConnectionProvider.builder("product-pool")
                .maxConnections(200)
                .maxIdleTime(Duration.ofSeconds(20))
                .maxLifeTime(Duration.ofSeconds(120))
                .pendingAcquireTimeout(Duration.ofSeconds(30))
                .pendingAcquireMaxCount(500)
                .evictInBackground(Duration.ofSeconds(60))
                .metrics(true)
                .build();

        HttpClient httpClient = HttpClient.create(provider)
                .compress(true)
                .responseTimeout(Duration.ofSeconds(10))
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5_000);

        return WebClient.builder()
                .baseUrl("http://product-service:8080")
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .codecs(c -> c.defaultCodecs().maxInMemorySize(10 * 1024 * 1024))
                .build();
    }
}
```

Aggregator가 고객 정보와 포트폴리오를 동시에 가져온 뒤 종목별 현재가를 동시성 5로 조회한다. 주가 조회에는 타임아웃과 Circuit Breaker를 건다.

```java
@Service
public class PortfolioAggregator {

    private final CustomerServiceClient customerClient;
    private final StockServiceClient stockClient;

    public PortfolioAggregator(CustomerServiceClient customerClient,
                               StockServiceClient stockClient) {
        this.customerClient = customerClient;
        this.stockClient = stockClient;
    }

    public Mono<PortfolioSummary> summarize(Integer customerId) {
        return Mono.zip(
                        customerClient.getCustomer(customerId),
                        customerClient.getPortfolio(customerId).collectList())
                .flatMap(tuple -> Flux.fromIterable(tuple.getT2())
                        .flatMap(item -> priceOf(item.ticker())
                                .map(price -> new PortfolioLine(
                                        item.ticker(), item.quantity(), price)), 5)
                        .collectList()
                        .map(lines -> PortfolioSummary.of(tuple.getT1(), lines)));
    }

    @CircuitBreaker(name = "stock-service", fallbackMethod = "priceFallback")
    public Mono<Integer> priceOf(String ticker) {
        return stockClient.getStockPrice(ticker)
                .timeout(Duration.ofSeconds(3))
                .map(StockDto::price);
    }

    private Mono<Integer> priceFallback(String ticker, Throwable cause) {
        return Mono.just(-1);
    }
}
```

## 실무에서 걸리는 지점

- `Mono.cache()`를 `ConcurrentHashMap`에 넣는 방식은 값의 TTL만 있고 맵 엔트리는 제거되지 않는다. 키 공간이 크거나 인스턴스가 여러 개면 Reactive Redis로 옮긴다.
- ==`pendingAcquireTimeout`이 없으면 풀 고갈 시 요청이 무한 대기한다.== Gzip 효과는 localhost에서 측정되지 않으므로 네트워크 구간이 있는 환경에서 부하 도구로 확인한다.
- `onStatus` 조건에 `HttpStatus.NOT_FOUND::equals`처럼 enum 동일성을 쓰면 `HttpStatusCode` 구현체에 따라 매칭이 빗나갈 수 있다. `status -> status.value() == 404`로 비교한다.
- SSE를 릴레이하는 엔드포인트에 `produces = TEXT_EVENT_STREAM_VALUE`가 없으면 Flux가 JSON 배열로 수집돼 스트림이 끊긴다. 클라이언트 쪽도 `accept(MediaType.TEXT_EVENT_STREAM)`과 `bodyToFlux`로 받아야 한다.
- Resilience4j 애노테이션은 `resilience4j-reactor` 어댑터가 있어야 Mono/Flux를 인식한다. 코어 모듈만 추가하면 리액티브 파이프라인에서 동작하지 않는다.

## 관련 글

- [WebClient](/notes/reactive-spring/webclient/)
- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
- [스트리밍 응답 — SSE·NDJSON](/notes/reactive-spring/streaming-sse-ndjson/)
