---
title: "테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway"
series: java-spring
part: "운영·통합"
order: 34
summary: "슬라이스·통합·실제 DB 테스트를 어떤 기준으로 나누고, Testcontainers와 Flyway로 운영과 같은 환경을 재현하는가"
tags: [MockMvc, "@SpringBootTest", Testcontainers, Flyway, JUnit 5]
sources: [spring/2026-05-16-springboottest-integration-test.md, spring/2026-05-16-mockmvc-controller-test.md, spring/2026-05-17-testcontainers.md, 2026-05-02-spring-database-advanced.md, 2026-05-02-spring-mvc-rest.md]
updated: 2026-08-29
---

자동 테스트가 없으면 변경의 영향을 매번 손으로 확인해야 하고, 누락된 경로에서 장애가 난다. 테스트가 있어도 구성이 잘못되면 다른 문제가 생긴다. 모든 테스트를 `@SpringBootTest`로 작성하면 컨텍스트 기동 비용 때문에 스위트가 수십 분으로 늘어나 실행하지 않게 되고, H2에만 의존하면 PostgreSQL·MySQL 고유 문법 차이 때문에 테스트는 통과하는데 운영에서 SQL이 깨진다.

## 핵심 개념

`spring-boot-starter-test` 하나에 JUnit 5, AssertJ, Mockito, Spring Test가 포함된다. 테스트는 Given·When·Then으로 나누고 검증은 AssertJ `assertThat` 체이닝을 쓴다.

테스트는 띄우는 컨텍스트 범위에 따라 세 층으로 나뉜다. Mockito만으로 서비스 로직을 검증하는 단위 테스트가 가장 빠르고, 웹 계층만 올리는 `@WebMvcTest`나 JPA 계층만 올리는 `@DataJpaTest` 같은 슬라이스 테스트가 그 다음이며, 전체 컨텍스트를 올리는 `@SpringBootTest`가 가장 무겁다. 무거운 테스트는 전체 흐름을 검증하는 소수에 한정한다.

MockMvc는 서블릿 컨테이너 없이 DispatcherServlet 처리 흐름을 메모리에서 실행한다. `perform`으로 요청을 만들고 `andExpect`로 상태 코드·헤더·`jsonPath`를 검증하며 `andDo(print())`로 실제 요청·응답을 출력한다. `@WebMvcTest`에서는 컨트롤러가 의존하는 서비스 빈이 없으므로 `@MockitoBean`으로 대체해야 컨텍스트가 뜬다. Spring Boot 3.4부터 `@MockBean`은 deprecated이고 `@MockitoBean`이 대체한다. 전체 흐름을 HTTP 레벨에서 검증하려면 `@SpringBootTest` + `@AutoConfigureMockMvc`를 쓰고, Spring Security가 있으면 `@WithMockUser`로 인증 상태를 주입한다. 테스트 클래스에 `@Transactional`을 붙이면 각 테스트가 끝날 때 롤백되어 DB 상태가 격리된다.

Testcontainers는 테스트 실행 중 Docker 컨테이너를 기동하고 종료한다. `@Testcontainers`가 생명주기를 관리하고, `@Container`가 붙은 static 필드는 클래스당 한 번 기동된다. Spring Boot 3.1부터 `@ServiceConnection`을 붙이면 컨테이너 타입을 보고 `DataSource`·Redis·Kafka 연결 속성을 자동 구성하므로 `@DynamicPropertySource`로 URL·계정을 수동 등록할 필요가 없다. `@DataJpaTest`는 DataSource를 임베디드 DB로 교체하므로 컨테이너 DB를 쓰려면 `@AutoConfigureTestDatabase(replace = NONE)`을 명시한다.

Flyway는 `db/migration/`의 `V{버전}__{설명}.sql`을 순서대로 적용하고 이력과 체크섬을 `flyway_schema_history`에 기록한다. 적용된 스크립트를 수정하면 체크섬 불일치로 기동이 실패하므로 변경은 항상 새 버전 파일로 추가한다. Flyway를 쓰는 환경에서는 `ddl-auto`를 `validate` 또는 `none`으로 두어 스키마 소유권을 일원화한다. Testcontainers와 결합하면 빈 컨테이너에 Flyway가 운영 스키마를 만들므로 마이그레이션 스크립트도 매 빌드마다 검증된다.

## 코드

컨트롤러 슬라이스 테스트. 서비스는 `@MockitoBean`으로 대체하고 정상 응답·404·검증 실패 응답을 확인한다.

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {

    @Autowired MockMvc mockMvc;
    @Autowired ObjectMapper objectMapper;
    @MockitoBean OrderService orderService;

    @Test
    void 주문_단건_조회() throws Exception {
        given(orderService.findById(1L))
                .willReturn(Optional.of(new OrderResponse(1L, 10_000, "PENDING")));

        mockMvc.perform(get("/api/orders/{id}", 1L).accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.amount").value(10_000))
                .andExpect(jsonPath("$.status").value("PENDING"));
    }

    @Test
    void 없는_주문은_404() throws Exception {
        given(orderService.findById(anyLong())).willReturn(Optional.empty());

        mockMvc.perform(get("/api/orders/{id}", 99L))
                .andExpect(status().isNotFound());
    }

    @Test
    void 검증_실패는_400과_필드_오류() throws Exception {
        var invalid = new OrderRequest(null, -100);

        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(invalid)))
                .andDo(print())
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[*].field",
                        containsInAnyOrder("productId", "amount")));
    }
}
```

PostgreSQL 컨테이너 위에서 Flyway 마이그레이션을 적용하고 전체 흐름을 검증하는 통합 테스트. 컨테이너는 static 필드로 두어 클래스 내 테스트가 공유한다.

```java
@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
@Transactional
class OrderIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired MockMvc mockMvc;
    @Autowired ObjectMapper objectMapper;
    @Autowired OrderRepository orderRepository;
    @MockitoBean PaymentGateway paymentGateway;

    @Test
    void 주문_생성_API_전체_흐름() throws Exception {
        given(paymentGateway.charge(any())).willReturn(PaymentResult.approved("tx-1"));

        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new OrderRequest(1L, 10_000))))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"));

        assertThat(orderRepository.findAll())
                .singleElement()
                .extracting(Order::getStatus)
                .isEqualTo(OrderStatus.PAID);
    }

    @Test
    void 결제_실패_시_주문이_남지_않는다() throws Exception {
        given(paymentGateway.charge(any())).willThrow(new PaymentFailedException("declined"));

        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new OrderRequest(1L, 10_000))))
                .andExpect(status().isUnprocessableEntity());

        assertThat(orderRepository.count()).isZero();
    }
}
```

위 테스트가 전제하는 설정. Flyway가 스키마를 만들고 Hibernate는 검증만 하며, DataSource 접속 정보는 `@ServiceConnection`이 채운다.

```yaml
# src/test/resources/application-test.yml
spring:
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
  flyway:
    enabled: true
    locations: classpath:db/migration
```

## 실무에서 걸리는 지점

- **컨텍스트 캐시가 깨지는 구성.** Spring Test는 같은 설정의 컨텍스트를 캐시해 재사용하는데, 클래스마다 `@MockitoBean` 조합이나 프로퍼티가 다르면 다시 띄운다. 통합 테스트는 공통 추상 클래스에 구성을 모아 캐시 히트를 높인다.
- **컨테이너 기동 비용.** `@Container`를 인스턴스 필드에 두면 메서드마다 기동된다. static 필드나 수동 `start()`한 싱글턴 컨테이너를 공유하면 스위트 전체에서 한 번만 기동된다. `.withReuse(true)`는 `~/.testcontainers.properties`에 `testcontainers.reuse.enable=true`가 있어야 동작하고 JVM 종료 후에도 컨테이너가 남으므로 로컬 개발용으로만 쓴다.
- **`@Transactional` 롤백이 가리는 결함.** `REQUIRES_NEW`로 분리된 트랜잭션, `AFTER_COMMIT` 이벤트 리스너, 비동기 스레드의 DB 접근은 롤백 환경에서 실제와 다르게 동작한다. 이런 경로는 롤백 없이 실행하고 `@Sql`로 정리한다.
- **Flyway 버전 충돌과 큰 DML.** 브랜치마다 마이그레이션을 만들면 같은 V 번호가 두 개 생겨 병합 후 기동이 실패한다. 병합 시점에 번호를 확정하는 규칙이 안전하다. 대량 UPDATE는 락으로 배포가 멎으므로 단계를 나눈다.
- **Docker 없는 CI.** Testcontainers는 Docker 데몬이 필수다. 컨테이너 안에서 빌드하는 러너는 소켓 마운트나 Testcontainers Cloud 설정이 없으면 시작 단계에서 실패한다.

## 관련 글

- /notes/java-spring/exception-handling-validation/
- /notes/java-spring/transactional-locking/
- /notes/java-spring/jpa-hibernate-spring-data/
