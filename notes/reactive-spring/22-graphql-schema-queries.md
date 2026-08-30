---
title: "GraphQL — Schema·Query·Mutation·Spring for GraphQL"
series: reactive-spring
part: "GraphQL"
order: 22
summary: "GraphQL은 스키마를 계약으로 두고 클라이언트가 필요한 필드만 명시하며, Spring for GraphQL은 이를 애노테이션 컨트롤러로 매핑한다."
tags: [GraphQL, SDL, Spring for GraphQL, QueryMapping, BatchMapping]
sources: [2026-05-03-graphql-basics.md, 2026-05-03-graphql-queries-mutations.md, 2026-05-03-graphql-spring.md]
updated: 2026-08-29
---

REST는 응답 형태를 서버가 결정한다. 이름 하나만 필요해도 `GET /users/123`의 전체 필드를 받아야 하고(over-fetching), 사용자·게시물·댓글을 한 화면에 그리려면 엔드포인트 세 개를 순서대로 호출해야 한다(under-fetching). GraphQL은 타입 스키마를 계약으로 고정하고 클라이언트가 그 안에서 필요한 필드를 직접 명시하도록 해 이 문제를 푼다.

## 핵심 개념

GraphQL은 단일 엔드포인트(`/graphql`)로 요청을 받고 요청 문서의 필드 구조 그대로 응답을 구성한다. 서버는 SDL로 타입을 정의하며 이 스키마가 양쪽이 지켜야 할 계약이다. 내장 스칼라는 `ID`·`String`·`Int`·`Float`·`Boolean` 다섯 가지이고 `DateTime` 같은 값은 `scalar` 선언과 Coercing 구현으로 추가한다. `!`는 non-null이며 리스트는 `[User]`·`[User!]`·`[User!]!`로 null 허용 범위를 구분한다. 출력 타입은 인자로 쓸 수 없으므로 Mutation 인자는 `input`으로 선언한다.

루트 작업 타입은 `Query`(조회)·`Mutation`(변경)·`Subscription`(실시간 스트림) 셋이다. Query 최상위 필드는 병렬 실행될 수 있지만 Mutation 최상위 필드는 사양상 순차 실행된다. Mutation도 반환 타입을 가지므로 변경 결과를 같은 응답으로 받는다.

Argument는 필드에 붙는 인자이고 Variables는 `$id: ID!`처럼 문서 밖에서 타입을 선언해 주입하는 값으로, 사용자 입력은 쿼리 문자열에 끼워 넣지 않고 변수로 넘긴다. Alias는 같은 필드를 여러 번 호출할 때 응답 키 충돌을 피하고, Fragment는 필드 묶음을 재사용하며 Inline Fragment(`... on User`)는 union·interface 결과를 타입별로 분기한다.

에러는 HTTP 상태 코드가 아니라 응답 본문의 `errors` 배열로 전달되며 전송 계층 문제가 아닌 한 응답은 200이다. 검증 실패처럼 클라이언트가 처리해야 할 실패는 `CreateUserPayload { user, errors }` 같은 페이로드 타입으로 스키마에 올리는 패턴이 널리 쓰인다.

Spring for GraphQL은 graphql-java 위에 컨트롤러 모델을 얹는다. 스키마는 `classpath:graphql/**/*.graphqls`에서 자동 로드되고 애노테이션은 스키마 위치에 대응한다.

| 애노테이션 | 스키마 위치 | 역할 |
|:---|:---|:---|
| `@QueryMapping` | `Query.field` | 조회 진입점 |
| `@MutationMapping` | `Mutation.field` | 변경 진입점 |
| `@SubscriptionMapping` | `Subscription.field` | `Flux` 반환 스트림 |
| `@SchemaMapping` | `Type.field` | 부모 객체가 첫 인자 |
| `@BatchMapping` | `Type.field` | 부모 목록 배치 처리 |

메서드 이름이 스키마 필드와 같으면 자동 매핑되고 다르면 `name`으로 지정한다. 인자는 `@Argument`로 바인딩하며 `Mono`·`Flux` 반환이 그대로 인식된다. 리졸버는 필드 단위로 호출되므로 `users { posts }` 같은 중첩 조회는 사용자 수만큼 `posts` 리졸버가 실행되는 N+1 구조가 된다. `@BatchMapping`은 부모 목록을 한 번 받아 `Map<Parent, Result>`를 돌려주며 내부적으로 DataLoader를 등록해 배치 조회로 바꾼다.

## 코드

스키마 파일 `src/main/resources/graphql/schema.graphqls`. 출력 타입·input·페이로드·Custom Scalar를 선언한다.

```graphql
scalar DateTime

type Query {
  user(id: ID!): User
  users(first: Int = 20): [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): CreateUserPayload!
}

type User {
  id: ID!
  name: String!
  email: String
  joinedAt: DateTime!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  authorId: ID!
}

input CreateUserInput {
  name: String!
  email: String!
}

type CreateUserPayload {
  user: User
  errors: [FieldError!]!
}

type FieldError {
  field: String!
  message: String!
}
```

컨트롤러. `User.posts`는 `@BatchMapping`으로 해결하고 `@Argument @Valid`로 `jakarta.validation`을 적용한다.

```java
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import org.springframework.graphql.data.method.annotation.*;
import org.springframework.stereotype.Controller;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Controller
public class UserController {

    private final UserService userService;
    private final PostService postService;

    public UserController(UserService userService, PostService postService) {
        this.userService = userService;
        this.postService = postService;
    }

    @QueryMapping
    public Mono<User> user(@Argument String id) {
        return userService.findById(id);
    }

    @QueryMapping
    public Flux<User> users(@Argument int first) {
        return userService.findAll(first);
    }

    @MutationMapping
    public Mono<CreateUserPayload> createUser(@Argument @Valid CreateUserInput input) {
        return userService.create(input)
            .map(user -> new CreateUserPayload(user, List.of()))
            .onErrorResume(DuplicateEmailException.class, e ->
                Mono.just(new CreateUserPayload(null,
                    List.of(new FieldError("email", e.getMessage())))));
    }

    @BatchMapping(typeName = "User", field = "posts")
    public Mono<Map<User, List<Post>>> posts(List<User> users) {
        List<String> ids = users.stream().map(User::id).toList();
        return postService.findByAuthorIds(ids)
            .collectMultimap(Post::authorId)
            .map(byAuthor -> users.stream().collect(Collectors.toMap(
                u -> u,
                u -> List.copyOf(byAuthor.getOrDefault(u.id(), List.of())))));
    }

    public record CreateUserInput(@NotBlank String name, @Email @NotBlank String email) {}
    public record CreateUserPayload(User user, List<FieldError> errors) {}
    public record FieldError(String field, String message) {}
}
```

Custom Scalar 등록과 예외 변환. `graphql-java-extended-scalars`의 `DateTime`을 연결하고, 컨트롤러 밖으로 새는 예외는 `@GraphQlExceptionHandler`로 `errors` 항목으로 바꾼다.

```java
@Configuration
public class GraphQlConfig {

    @Bean
    RuntimeWiringConfigurer runtimeWiringConfigurer() {
        return wiring -> wiring.scalar(ExtendedScalars.DateTime);
    }
}

@ControllerAdvice
class GraphQlExceptionAdvice {

    @GraphQlExceptionHandler(NotFoundException.class)
    GraphQLError handleNotFound(NotFoundException e, DataFetchingEnvironment env) {
        return GraphqlErrorBuilder.newError(env)
            .errorType(ErrorType.NOT_FOUND)
            .message(e.getMessage())
            .build();
    }
}
```

## 실무에서 걸리는 지점

- 응답이 항상 200이라 상태 코드 기반 알람은 동작하지 않으며 `errors` 배열을 별도로 집계해야 한다.
- 목록 응답의 하위 필드에 `@SchemaMapping`을 쓰면 부모 수만큼 DB 호출이 발생한다. `@BatchMapping`을 기본으로 하고, 반환 `Map`의 키는 전달받은 부모 인스턴스 그대로여야 매칭된다.
- 조회 깊이를 클라이언트가 정하므로 재귀 타입은 서버 부하를 키운다. `MaxQueryDepthInstrumentation`을 등록하고 목록 필드에 `first` 상한을 둔다.
- Introspection과 GraphiQL은 스키마를 노출한다. 운영 프로파일에서 `spring.graphql.graphiql.enabled=false`, `spring.graphql.schema.introspection.enabled=false`로 끈다.
- 단일 엔드포인트 POST라 HTTP 캐시와 CDN이 응답을 캐시하지 못한다. 캐시가 중요한 조회는 persisted query와 GET을 쓴다.

## 관련 글

- [GraphQL — 리액티브 통합과 Subscription](/notes/reactive-spring/graphql-reactive-subscriptions/)
- [GraphQL — DataLoader·Federation·보안·테스트](/notes/reactive-spring/graphql-dataloader-security/)
- [WebFlux 기본 — 애노테이션 컨트롤러와 Functional Endpoints](/notes/reactive-spring/webflux-basics-functional/)
