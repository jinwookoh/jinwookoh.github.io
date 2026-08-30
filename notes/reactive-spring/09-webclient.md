---
title: "WebClient"
series: reactive-spring
part: "WebFlux"
order: 9
summary: "이벤트 루프를 막지 않고 외부 HTTP를 호출하는 WebClient의 설정·응답 처리·에러·타임아웃·재시도 패턴을 정리한다."
tags: [WebClient, retrieve, exchangeToMono, Retry, ExchangeFilterFunction]
sources: [2026-05-03-webflux-webclient.md, 2026-05-02-spring-webflux-advanced.md]
updated: 2026-08-29
---

WebFlux 서버는 적은 수의 이벤트 루프 스레드로 수천 개의 연결을 처리한다. 이 구조에서 `RestTemplate`이나 `RestClient`로 외부 API를 호출하면 응답이 올 때까지 이벤트 루프 스레드가 묶이고, 그 스레드가 담당하던 다른 요청이 함께 멈춘다. WebClient는 Reactor Netty 위에서 동작하는 논블로킹 HTTP 클라이언트로, 결과를 `Mono`·`Flux`로 돌려주므로 리액티브 체인에 그대로 이어 붙일 수 있다.

## 핵심 개념

WebClient는 `spring-boot-starter-webflux`에 포함되며 인스턴스는 불변이고 스레드 안전하다. 싱글톤 Bean으로 등록해 재사용하며, ==요청마다 `WebClient.create()`로 만들면 Netty 커넥션 풀이 공유되지 않는다.== Spring Boot가 자동 구성한 `WebClient.Builder`를 주입받아 `baseUrl`·기본 헤더·필터를 붙여 빌드하고, 설정을 바꿔야 하면 `mutate()`로 새 인스턴스를 만든다.

요청은 HTTP 메서드 선택, `uri()`, 본문 설정(`bodyValue()`), 응답 처리 순으로 이어진다. URI는 `uri("/products/{id}", id)`처럼 가변 인수로 바인딩하거나 `UriBuilder` 람다로 쿼리 파라미터를 조립한다. 응답 처리 진입점은 두 가지다.

| 항목 | `retrieve()` | `exchangeToMono()` / `exchangeToFlux()` |
|:---|:---|:---|
| 수준 | 고수준 | 저수준 |
| 접근 정보 | 응답 본문 | 상태 코드·헤더·쿠키·본문 전체 |
| 에러 처리 | `onStatus()`로 등록 | 람다 안에서 `statusCode()` 직접 분기 |
| 본문 소비 책임 | 프레임워크 | 개발자 |

`retrieve()`는 4xx·5xx 응답에 기본적으로 `WebClientResponseException`을 발생시키고, `onStatus()`로 상태 코드별 변환 규칙을 추가한다. `exchangeToMono()`는 응답 객체를 직접 받으므로 본문을 소비하거나 `releaseBody()`로 해제해야 한다. 과거의 `exchange()`는 이 책임을 전적으로 호출자에게 맡겨 연결 누수가 잦았기 때문에 Spring 5.3에서 deprecated되었다.

역직렬화는 `bodyToMono(Class)`(단일 객체), `bodyToFlux(Class)`(배열·스트림)로 하며, 타입을 모르는 JSON은 `Map`이나 `JsonNode`로 받는다.

타임아웃은 커넥터 층(`HttpClient`의 `CONNECT_TIMEOUT_MILLIS`·`responseTimeout()`)과 개별 호출의 `timeout()` 연산자 두 층에서 건다. 재시도는 `retryWhen(Retry.backoff(...))`로 지수 백오프와 지터를 주되 `filter()`로 대상을 한정한다. 여러 서비스 동시 호출은 `flatMap` 체인 대신 `Mono.zip()`으로 병렬 실행 후 결합한다.

`ExchangeFilterFunction`은 WebClient 쪽 인터셉터다. 로깅·인증 헤더 주입을 빌더의 `filter()`에 등록하면 모든 호출에 적용되며, OAuth2 토큰 주입도 `ServerOAuth2AuthorizedClientExchangeFilterFunction`을 같은 방식으로 등록한다.

## 코드

Bean 등록과 커넥터 수준 타임아웃 설정이다. 자동 구성된 `WebClient.Builder`를 주입받아 서비스별 인스턴스를 만든다.

```java
@Configuration
public class WebClientConfig {

    @Bean("productWebClient")
    public WebClient productWebClient(WebClient.Builder builder) {
        HttpClient httpClient = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5_000)
                .responseTimeout(Duration.ofSeconds(10));

        return builder
                .baseUrl("http://product-service:7070")
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .filter(logRequest())
                .build();
    }

    private static ExchangeFilterFunction logRequest() {
        return ExchangeFilterFunction.ofRequestProcessor(request -> {
            log.info("{} {}", request.method(), request.url());
            return Mono.just(request);
        });
    }
}
```

`retrieve()`와 `onStatus()`로 상태 코드를 도메인 예외로 변환하고, 호출별 타임아웃과 5xx 한정 재시도를 붙인 조회 예제다.

```java
@Service
public class ProductClient {

    private final WebClient webClient;

    public ProductClient(@Qualifier("productWebClient") WebClient webClient) {
        this.webClient = webClient;
    }

    public Mono<Product> findById(String id) {
        return webClient.get()
                .uri("/products/{id}", id)
                .retrieve()
                .onStatus(HttpStatusCode::is4xxClientError, response ->
                        response.bodyToMono(ProblemDetail.class)
                                .flatMap(pd -> Mono.error(new ProductNotFoundException(pd.getDetail()))))
                .onStatus(HttpStatusCode::is5xxServerError, response ->
                        Mono.error(new ServiceUnavailableException("product-service")))
                .bodyToMono(Product.class)
                .timeout(Duration.ofSeconds(3))
                .retryWhen(Retry.backoff(3, Duration.ofMillis(300))
                        .maxBackoff(Duration.ofSeconds(2))
                        .jitter(0.3)
                        .filter(ex -> ex instanceof ServiceUnavailableException
                                || ex instanceof TimeoutException));
    }

    public Flux<Product> search(int page, int size, String name) {
        return webClient.get()
                .uri(b -> b.path("/products")
                        .queryParam("page", page)
                        .queryParam("size", size)
                        .queryParamIfPresent("name", Optional.ofNullable(name))
                        .build())
                .retrieve()
                .bodyToFlux(Product.class);
    }
}
```

`exchangeToMono()`로 헤더를 직접 다루는 예와 `Mono.zip()` 병렬 호출 예제다.

```java
public Mono<Product> findWithEtag(String id) {
    return webClient.get()
            .uri("/products/{id}", id)
            .exchangeToMono(response -> {
                if (response.statusCode().is2xxSuccessful()) {
                    String etag = response.headers().header(HttpHeaders.ETAG).stream()
                            .findFirst().orElse(null);
                    return response.bodyToMono(Product.class)
                            .map(p -> p.withEtag(etag));
                }
                return response.createError();   // 본문을 읽어 WebClientResponseException으로 변환
            });
}

public Mono<TradeInfo> tradeInfo(Integer customerId, String ticker) {
    return Mono.zip(
            stockClient.get().uri("/stocks/{t}", ticker)
                    .retrieve().bodyToMono(StockPrice.class),
            customerClient.get().uri("/customers/{id}", customerId)
                    .retrieve().bodyToMono(CustomerInfo.class))
            .map(t -> new TradeInfo(t.getT1(), t.getT2()));
}
```

## 실무에서 걸리는 지점

- **`block()` 호출.** 결과를 `block()`으로 꺼내면 블로킹 클라이언트와 다를 바 없고, Netty 이벤트 루프 스레드에서는 예외가 발생한다. 동기 호출만 필요하면 `RestClient`가 맞다.
- **`exchangeToMono()`에서 본문 미소비.** ==에러 분기에서 본문을 읽지 않고 `Mono.error()`만 반환하면 연결이 풀로 반환되지 않아 누수가 생긴다.== `createError()`·`releaseBody()`·`bodyToMono()` 중 하나로 소비한다.
- **4xx 재시도.** 필터 없이 `Retry.backoff()`를 걸면 404·400도 반복 호출해 부하만 준다. 대상은 5xx·타임아웃·연결 오류로 제한하고, 멱등하지 않은 POST는 재시도 자체를 재검토한다.
- **응답 버퍼 한도.** ==코덱의 기본 인메모리 버퍼는 256KB이며 초과 시 `DataBufferLimitException`이 발생한다.== `codecs(c -> c.defaultCodecs().maxInMemorySize(...))`로 조정하거나 `bodyToFlux()`로 스트리밍한다.
- **타임아웃과 재시도 순서.** ==`timeout()`을 `retryWhen()` 앞에 둬야 시도마다 타임아웃이 적용된다.== 뒤에 두면 전체 재시도 시간에 한 번만 걸린다.
- **비동기 테스트 대기.** `subscribe()` 후 `Thread.sleep()`으로 기다리면 CI 환경에 따라 실패한다. `StepVerifier`나 Awaitility를 쓴다.

## 관련 글

- [WebFlux 기본 — 애노테이션 컨트롤러와 Functional Endpoints](/notes/reactive-spring/webflux-basics-functional/)
- [Repeat·Retry와 StepVerifier](/notes/reactive-spring/retry-stepverifier/)
- [WebFilter·예외 처리·검증](/notes/reactive-spring/webfilter-error-handling/)
