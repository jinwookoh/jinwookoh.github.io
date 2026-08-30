---
title: "HTTP 클라이언트 — RestClient"
series: java-spring
part: "운영·통합"
order: 33
summary: "Spring 6.1+ 동기 호출 표준 RestClient의 빌더·상태 코드 매핑·타임아웃·인터셉터·테스트 패턴을 정리한다"
tags: [RestClient, WebClient, RestTemplate, MockRestServiceServer, ClientHttpRequestInterceptor]
sources: [spring/2026-05-17-webclient-restclient.md, 2026-05-02-spring-rest-client.md]
updated: 2026-08-29
---

백엔드는 결제·회원·재고 같은 다른 서비스나 외부 API를 HTTP로 호출한다. 저수준 API로 직접 짜면 URL 인코딩, JSON 직렬화, 상태 코드 분기를 매 호출마다 반복하고, 인증 토큰 주입 같은 공통 관심사가 호출 코드 전체에 흩어진다. 타임아웃 없는 클라이언트로 응답 없는 외부 서비스를 호출하면 요청 스레드가 묶이고, 풀이 고갈되면 외부 장애가 그대로 우리 서비스 장애가 된다. Spring의 HTTP 클라이언트는 이 반복과 위험을 한 곳에서 관리하게 한다.

## 핵심 개념

Spring에는 도입 시점이 다른 HTTP 클라이언트가 공존한다.

| 클라이언트 | 방식 | 도입 | 상태 |
|:---|:---|:---|:---|
| `RestTemplate` | 동기·블로킹 | Spring 3.0 | 유지보수 모드 (deprecated 아님, 신규 기능 추가 없음) |
| `WebClient` | 비동기·논블로킹 | Spring 5.0 | 리액티브 표준, `spring-webflux` 필요 |
| `RestClient` | 동기·블로킹 | Spring 6.1 | 동기 호출 표준, Fluent API |

신규 동기 코드는 `RestClient`, 스트리밍이나 논블로킹이 필요한 리액티브 스택은 `WebClient`, 기존 `RestTemplate` 코드는 유지하다가 점진적으로 옮긴다. `RestClient`는 `spring-boot-starter-web`에 포함되고, `RestTemplate`과 같은 요청 팩토리·메시지 컨버터·인터셉터 인프라 위에서 동작하므로 기존 구성 요소를 그대로 재사용한다. `WebClient`는 `Mono`·`Flux`를 다뤄야 하고, `.block()`으로 동기 변환하면 논블로킹의 이점이 사라진다.

`RestClient` 호출 체인은 `get()`·`post()`로 메서드를 고르고, `uri()`로 경로 변수와 쿼리 파라미터를 지정하고, `retrieve()`를 거쳐 `body(Class)` 또는 `toEntity(Class)`로 결과를 꺼내는 순서다. `retrieve()`는 4xx·5xx에 기본적으로 `RestClientResponseException`을 던지며, `onStatus(predicate, handler)`로 특정 코드를 도메인 예외에 매핑한다. 제네릭 타입은 타입 소거 때문에 `ParameterizedTypeReference`로 받는다. URL은 문자열 연결 대신 템플릿 변수나 `UriBuilder`를 써서 한글·공백·특수 문자 인코딩을 클라이언트에 맡긴다.

공통 관심사는 `ClientHttpRequestInterceptor`로 처리한다. 매 요청 직전에 실행되어 헤더 추가·로깅·계측을 수행하며, 빌더의 `requestInterceptor(...)`로 등록해야 동작한다. OAuth2 client credentials 흐름이라면 `OAuth2AuthorizedClientManager`가 토큰 발급·캐싱·갱신을 담당하고, 인터셉터는 받은 액세스 토큰을 `Authorization` 헤더에 붙이기만 한다.

테스트는 `@RestClientTest`와 `MockRestServiceServer` 조합을 쓴다. 지정한 클라이언트만 컨텍스트에 올리고, `RestClient.Builder`에 바인딩된 가짜 서버가 등록된 요청에 미리 정한 응답을 돌려준다.

## 코드

빈으로 등록한 `RestClient`에 baseUrl·기본 헤더·타임아웃·인터셉터를 한 번에 설정한다. 생성 비용이 있으므로 호출마다 만들지 않고 재사용한다.

```java
@Configuration
public class PaymentClientConfig {

    @Bean
    RestClient paymentRestClient(RestClient.Builder builder,
                                 ClientHttpRequestInterceptor oauthInterceptor,
                                 @Value("${payment.base-url}") String baseUrl) {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build());
        factory.setReadTimeout(Duration.ofSeconds(10));

        return builder
                .baseUrl(baseUrl)
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .requestFactory(factory)
                .requestInterceptor(oauthInterceptor)
                .build();
    }

    @Bean
    ClientHttpRequestInterceptor oauthInterceptor(OAuth2AuthorizedClientManager manager) {
        return (request, body, execution) -> {
            OAuth2AuthorizeRequest authorizeRequest = OAuth2AuthorizeRequest
                    .withClientRegistrationId("payment-auth")
                    .principal("payment-client")
                    .build();
            OAuth2AuthorizedClient client = manager.authorize(authorizeRequest);
            if (client == null) {
                throw new IllegalStateException("OAuth2 토큰을 획득하지 못했다");
            }
            request.getHeaders().setBearerAuth(client.getAccessToken().getTokenValue());
            return execution.execute(request, body);
        };
    }
}
```

GET·POST·목록 조회와 상태 코드별 예외 매핑을 한 클라이언트에 모은다. 404는 도메인 예외로, 5xx는 재시도 가능한 예외로 구분한다.

```java
@Service
public class PaymentClient {

    private final RestClient restClient;

    public PaymentClient(RestClient paymentRestClient) {
        this.restClient = paymentRestClient;
    }

    public Payment getPayment(String id, String traceId) {
        return restClient.get()
                .uri(uri -> uri.path("/payments/{id}").queryParam("includeDetail", true).build(id))
                .header("X-Trace-Id", traceId)
                .retrieve()
                .onStatus(status -> status.value() == 404, (req, res) -> {
                    throw new PaymentNotFoundException(id);
                })
                .onStatus(HttpStatusCode::is5xxServerError, (req, res) -> {
                    throw new PaymentUpstreamException(res.getStatusCode());
                })
                .body(Payment.class);
    }

    public Payment createPayment(PaymentRequest request) {
        ResponseEntity<Payment> entity = restClient.post()
                .uri("/payments")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .toEntity(Payment.class);
        return entity.getBody();
    }

    public List<Payment> listPayments(long userId) {
        return restClient.get()
                .uri("/payments?userId={id}", userId)
                .retrieve()
                .body(new ParameterizedTypeReference<>() {});
    }
}
```

`@RestClientTest`로 클라이언트만 띄우고 `MockRestServiceServer`가 응답을 대신한다. 마지막의 `verify()`가 등록한 요청이 실제로 발생했는지 확인한다.

```java
@RestClientTest(PaymentClient.class)
class PaymentClientTest {

    @Autowired PaymentClient paymentClient;
    @Autowired MockRestServiceServer server;
    @Autowired ObjectMapper objectMapper;

    @Test
    void getPayment_returnsBody() throws Exception {
        Payment expected = new Payment("p-1", 12000L, "DONE");
        server.expect(method(HttpMethod.GET))
              .andExpect(requestTo(containsString("/payments/p-1")))
              .andExpect(header("X-Trace-Id", "t-1"))
              .andRespond(withSuccess(objectMapper.writeValueAsString(expected),
                                      MediaType.APPLICATION_JSON));

        Payment actual = paymentClient.getPayment("p-1", "t-1");

        assertThat(actual.id()).isEqualTo("p-1");
        server.verify();
    }

    @Test
    void getPayment_404_mapsToDomainException() {
        server.expect(requestTo(containsString("/payments/missing")))
              .andRespond(withResourceNotFound());

        assertThatThrownBy(() -> paymentClient.getPayment("missing", "t-2"))
                .isInstanceOf(PaymentNotFoundException.class);
        server.verify();
    }
}
```

## 실무에서 걸리는 지점

- **타임아웃 미설정.** 기본 요청 팩토리의 타임아웃은 사실상 무한이다. 연결·읽기 타임아웃을 항상 명시하고 외부 서비스별 SLA에 맞춰 값을 다르게 둔다.
- **직렬 호출.** 독립적인 외부 API를 순서대로 부르면 응답 시간이 합산된다. `CompletableFuture`나 Virtual Thread 기반 Executor로 병렬화하면 가장 느린 호출 수준으로 줄지만, 외부 서비스 동시 부하와 커넥션 풀 크기를 함께 조정한다.
- **재시도 범위.** Spring Retry나 Resilience4j로 재시도할 때 대상은 연결 실패·5xx·타임아웃 같은 일시 오류로 한정한다. 멱등하지 않은 POST를 재시도하면 중복 결제 같은 사고가 나고, 백오프 없는 즉시 재시도는 장애 중인 서비스를 더 밀어붙인다.
- **String으로 받아 직접 파싱.** 응답을 `String.class`로 받아 수동으로 JSON을 뜯으면 스키마 변경에 조용히 깨진다. DTO에 `@JsonIgnoreProperties(ignoreUnknown = true)`를 붙여 받고, `Page<T>` 같은 인터페이스 타입은 `PageImpl`을 상속한 구체 클래스에 `@JsonCreator`로 매핑한다.
- **테스트의 `verify()` 누락과 빌더 바인딩.** `verify()`를 빠뜨리면 호출이 발생하지 않아도 테스트가 통과한다. 주입받은 `RestClient.Builder`는 생성자에서 한 번만 `build()`해야 가짜 서버와 바인딩되며, 메서드 안에서 매번 빌드하면 테스트 설정이 적용되지 않는다.

## 관련 글

- [이벤트·비동기·스케줄링](/notes/java-spring/events-async-scheduling/)
- [CORS와 Spring Security — OAuth2·JWT](/notes/java-spring/cors-security-oauth2-jwt/)
- [테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway](/notes/java-spring/testing-mockmvc-testcontainers/)
