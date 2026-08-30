---
title: "GraphQL — DataLoader·Federation·보안·테스트"
series: reactive-spring
part: "GraphQL"
order: 24
summary: "DataLoader로 N+1을 잡고, Depth·Complexity 제한과 필드 권한으로 단일 엔드포인트를 지키며, GraphQlTester로 검증한다"
tags: [GraphQL, DataLoader, Apollo Federation, Spring Security, GraphQlTester]
sources: [2026-05-03-graphql-advanced.md, 2026-05-03-graphql-security-testing.md]
updated: 2026-08-29
---

GraphQL은 클라이언트가 응답 형태를 결정한다. 그 대가로 서버는 두 가지 부담을 진다. 중첩 필드마다 리졸버가 따로 호출되므로 `users { posts { title } }` 한 번에 사용자 수만큼 게시물 조회가 발생하는 N+1이 기본값이고, 엔드포인트가 하나뿐이라 URL 단위 권한·속도 제한이 통하지 않으며 무한히 중첩한 쿼리 하나로 서버를 고갈시킬 수 있다. 서비스가 팀별로 쪼개지면 스키마 통합 문제가, 그 위에 이 동작들을 자동 테스트로 고정하는 문제가 따라온다.

## 핵심 개념

**DataLoader**는 리졸버가 요청한 키를 즉시 조회하지 않고 모아 두었다가 실행 단계가 끝나는 시점에 한 번의 배치 조회로 처리한다. 같은 tick의 요청을 묶는 batching, 같은 요청 안에서 동일 키 재조회를 막는 per-request caching, 배치 키의 중복을 제거하는 deduplication 세 가지가 핵심이다. `@BatchMapping`은 이 중 batching을 애노테이션 한 줄로 제공한다. 부모-자식 관계 하나를 푸는 일반적인 경우는 `@BatchMapping`으로 충분하고, 같은 로더를 여러 타입·필드에서 재사용하거나 요청 단위 캐시가 필요할 때 DataLoader를 직접 등록한다.

| 측면 | @BatchMapping | DataLoader 직접 등록 |
|:---|:---|:---|
| 요청 단위 캐시 | 없음 | 있음 |
| 재사용 | 필드마다 메서드 | 여러 필드에서 같은 로더 |
| 선택 기준 | 단일 부모-자식 관계 | 복합 관계·재사용 |

**Federation**은 서비스마다 자기 스키마(subgraph)를 운영하고 게이트웨이(Apollo Router 등)가 하나의 슈퍼그래프로 합쳐 노출하는 구조다. `@key(fields: "id")`로 엔티티 식별 필드를 선언하고, 다른 서비스는 `@external`로 그 키만 참조한 채 자신이 담당하는 필드를 덧붙인다. 수동으로 스키마를 이어 붙이던 Schema Stitching은 Federation으로 대체됐다. 스키마 변경은 버전 번호 대신 필드 추가와 `@deprecated`로 관리하고, 사용 메트릭이 0에 가까워진 뒤 제거한다.

**보안**은 세 층이다. 인증은 OAuth2 Resource Server의 JWT 검증을 쓰고, `/graphql`은 `permitAll`로 열어 둔 뒤 인가를 메서드 레벨과 필드 레벨(`@SchemaMapping` + `@PreAuthorize`)로 내린다. 같은 객체라도 호출자에 따라 노출 필드가 달라진다. 자원 보호는 `MaxQueryDepthInstrumentation`·`MaxQueryComplexityInstrumentation`으로 깊이·비용을 제한하고, 클라이언트별 rate limit을 WebFilter에 두며, 운영에서는 introspection을 끈다. Persisted Queries(trusted documents)를 적용하면 클라이언트는 등록된 쿼리 ID와 변수만 보내므로 임의 쿼리가 차단되고 GET + CDN 캐시가 가능해진다.

**테스트**는 `GraphQlTester` 계열로 통일된다. `@GraphQlTest`는 컨트롤러만 로드하는 슬라이스 테스트, `HttpGraphQlTester`는 실제 HTTP 통합 테스트, `WebSocketGraphQlTester`는 Subscription 검증용이다. `@WithMockUser`와 조합해 권한별 동작과 `FORBIDDEN` 에러를 확인한다.

## 코드

`BatchLoaderRegistry`에 로더를 등록하면 Spring이 요청마다 `DataLoaderRegistry`를 만들어 연결하고, 컨트롤러 메서드는 `DataLoader` 파라미터를 바로 받는다.

```java
@Configuration
public class DataLoaderConfig {

    @Bean
    public BatchLoaderRegistry.Registration<String, List<Post>> postsLoader(
            BatchLoaderRegistry registry, PostRepository repo) {
        return registry.forName("postsByAuthor")
            .registerMappedBatchLoader((Set<String> authorIds, BatchLoaderEnvironment env) ->
                repo.findByAuthorIdIn(authorIds)
                    .collectMultimap(Post::authorId)
                    .map(m -> m.entrySet().stream()
                        .collect(Collectors.toMap(Map.Entry::getKey, e -> List.copyOf(e.getValue())))));
    }
}

@Controller
public class UserController {

    @SchemaMapping(typeName = "User", field = "posts")
    public CompletableFuture<List<Post>> posts(User user,
            @ContextValue(name = "postsByAuthor") DataLoader<String, List<Post>> loader) {
        return loader.load(user.id());
    }
}
```

깊이·복잡도 제한과 introspection 차단을 `GraphQlSourceBuilderCustomizer`로 묶고, 필드 레벨 권한은 리졸버에 직접 붙인다.

```java
@Configuration
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
public class GraphQlSecurityConfig {

    @Bean
    public SecurityWebFilterChain filterChain(ServerHttpSecurity http) {
        return http
            .authorizeExchange(auth -> auth
                .pathMatchers("/graphql").permitAll()
                .anyExchange().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
            .build();
    }

    @Bean
    public GraphQlSourceBuilderCustomizer queryLimits(Environment env) {
        boolean prod = env.matchesProfiles("prod");
        return builder -> builder
            .configureGraphQl(gql -> gql.instrumentation(new ChainedInstrumentation(
                new MaxQueryDepthInstrumentation(10),
                new MaxQueryComplexityInstrumentation(1000))))
            .configureRuntimeWiring(wiring -> {
                if (prod) {
                    wiring.fieldVisibility(NoIntrospectionGraphqlFieldVisibility.NO_INTROSPECTION_FIELD_VISIBILITY);
                }
            });
    }
}

@Controller
public class UserFieldController {

    @SchemaMapping(typeName = "User", field = "email")
    @PreAuthorize("hasRole('ADMIN') or authentication.name == #user.id()")
    public Mono<String> email(User user) {
        return Mono.just(user.email());
    }
}
```

슬라이스 테스트에서 권한별 결과를 검증한다. `@MockitoBean`은 Spring Boot 3.4부터 `@MockBean`을 대체한다.

```java
@GraphQlTest(UserController.class)
@Import(GraphQlSecurityConfig.class)
class UserControllerTest {

    @Autowired GraphQlTester tester;
    @MockitoBean UserService userService;

    @Test
    @WithMockUser(roles = "USER")
    void emailHiddenFromOtherUser() {
        given(userService.findById("1"))
            .willReturn(Mono.just(new User("1", "Alice", "alice@x.com")));

        tester.document("query { user(id: \"1\") { name email } }")
            .execute()
            .errors().satisfy(errors ->
                assertThat(errors).anyMatch(e -> e.getErrorType() == ErrorType.FORBIDDEN))
            .path("user.name").entity(String.class).isEqualTo("Alice");
    }

    @Test
    void deepQueryRejected() {
        String deep = "query { user(id: \"1\") { posts { author { posts { author { posts { author { posts { author { posts { author { id } } } } } } } } } } } }";
        tester.document(deep)
            .execute()
            .errors().satisfy(errors ->
                assertThat(errors).anyMatch(e -> e.getMessage().contains("maximum query depth")));
    }
}
```

## 실무에서 걸리는 지점

- **DataLoader 캐시는 요청 범위다.** 애플리케이션 캐시를 대신하지 못하고, ==반대로 같은 요청 안에서 Mutation 직후 같은 키를 읽으면 갱신 전 값이 나올 수 있다.== 변경 리졸버에서 `loader.clear(key)`를 호출한다.
- **배치 로더의 반환 정렬.** ==`BatchLoader`는 입력 키 순서와 같은 길이의 리스트를 반환해야 하며 어긋나면 엉뚱한 부모에 붙는다.== 키가 누락될 수 있는 관계는 `MappedBatchLoader`로 Map을 돌려주는 편이 안전하다.
- **Depth 제한은 Complexity 제한을 대신하지 못한다.** ==깊이 3짜리 쿼리라도 `first: 10000`을 여러 필드에 걸면 비용이 폭발한다.== 필드별 비용 계산기와 페이지 크기 상한을 스키마 수준에서 강제하고, 제한값은 실제 쿼리 로그를 보고 정한다.
- **`permitAll` 엔드포인트와 인가 누락.** ==`/graphql`을 열어 둔 구조에서는 `@PreAuthorize`가 빠진 리졸버가 곧 공개 API다.== 민감 필드를 익명 사용자로 조회하는 테스트를 기본 세트에 포함한다.
- **Federation의 경계 비용.** 게이트웨이가 서비스 간 조인을 수행하므로 subgraph 간 엔티티 참조가 많으면 내부 호출이 늘어난다. `_entities` 리졸버에도 DataLoader를 적용하고 게이트웨이의 쿼리 플랜을 추적으로 확인한다.

## 관련 글

- [GraphQL — Schema·Query·Mutation·Spring for GraphQL](/notes/reactive-spring/graphql-schema-queries/)
- [GraphQL — 리액티브 통합과 Subscription](/notes/reactive-spring/graphql-reactive-subscriptions/)
- [gRPC — 에러·인터셉터·보안·운영](/notes/reactive-spring/grpc-errors-interceptors-security/)
