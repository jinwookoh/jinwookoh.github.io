---
title: "ArgumentResolver·파일 업로드·페이징"
series: java-spring
part: "Web MVC"
order: 20
summary: "컨트롤러 매개변수를 채우는 HandlerMethodArgumentResolver 원리와 MultipartFile 업로드·Pageable 페이징의 안전한 사용법"
tags: [HandlerMethodArgumentResolver, MultipartFile, Pageable, Slice, Spring MVC]
sources: [spring/2026-05-17-argument-resolver.md, spring/2026-05-17-file-upload.md, 2026-05-02-spring-mvc-features.md]
updated: 2026-08-29
---

컨트롤러가 늘어나면 같은 코드가 반복된다. 토큰에서 사용자를 조회하는 코드가 메서드마다 붙고, 파일은 `@RequestBody`로 받을 수 없으며, 목록 조회는 `page`·`size`·`sort`를 매번 파싱해야 한다. ==Spring MVC는 이 셋을 HandlerMethodArgumentResolver, MultipartFile, Pageable로 추상화하며, 모두 "컨트롤러 매개변수를 프레임워크가 대신 채운다"는 같은 메커니즘 위에서 동작한다.==

## 핵심 개념

### HandlerMethodArgumentResolver

`@PathVariable Long id`에 URL 문자열이 `Long`으로 들어오는 과정은 `HandlerMethodArgumentResolver`가 담당한다. `supportsParameter`가 처리 여부를 판단하고 `resolveArgument`가 값을 만든다. `RequestMappingHandlerAdapter`는 호출 직전에 매개변수마다 등록된 리졸버에 순서대로 묻고, 처음 `true`를 반환한 리졸버의 결과를 인자로 쓴다. `@RequestParam`·`@RequestBody`·`Pageable`의 기본 리졸버가 이 방식으로 등록되어 있다.

커스텀 리졸버는 마커 어노테이션, 구현체 Bean, `WebMvcConfigurer.addArgumentResolvers` 등록의 세 단계다. 추가한 리졸버는 기본 리졸버 뒤에 붙으므로 어노테이션과 타입을 AND로 검사해 조건이 겹치지 않게 한다. HandlerInterceptor가 흐름을 제어한다면 ArgumentResolver는 매개변수에 객체를 주입한다. Spring Security의 `@AuthenticationPrincipal`이 같은 일을 하므로 직접 만드는 경우는 경량 인증이나 Principal 가공이 필요할 때다.

### MultipartFile

파일 업로드 본문은 boundary로 구분된 여러 파트로 이루어진 `multipart/form-data`다. 파일 파트는 `MultipartFile`로 받는다. JSON 파트와 파일 파트를 한 요청으로 받을 때는 `@RequestPart`가 필요하다. 파트의 `Content-Type`에 맞는 `HttpMessageConverter`가 적용되어 JSON을 DTO로 역직렬화하고 `@Valid`도 붙는다. 기본 제한은 파일 1MB·요청 10MB이며 초과 시 `MaxUploadSizeExceededException`이 발생한다.

### Pageable과 Page·Slice

페이징·정렬 파라미터는 `Pageable`이 통째로 받아 `?page=0&size=25&sort=name,asc`를 `LIMIT`/`OFFSET`과 `ORDER BY`로 바꾼다. 페이지 번호는 0부터 시작하고 기본값은 `@PageableDefault`로 지정한다.

| 반환 타입 | COUNT 쿼리 | 다음 페이지 여부 | 용도 |
|---|---|---|---|
| `Page<T>` | 발생 | 제공 | 페이지 번호 UI |
| `Slice<T>` | 없음 (size+1 조회) | 제공 | 무한 스크롤 |
| `List<T>` | 없음 | 없음 | 정렬만 필요한 목록 |

선택적 조건이 많으면 파생 쿼리의 if-else 대신 `Specification`을 `and`로 합성한다. 조건 값이 null이면 `criteriaBuilder.conjunction()`을 반환해 그 조건이 빠진 것처럼 동작시킨다.

## 코드

현재 로그인 사용자를 주입하는 `@LoginUser` 리졸버. 어노테이션과 타입을 함께 검사한다.

```java
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface LoginUser {
}

@Component
@RequiredArgsConstructor
public class LoginUserArgumentResolver implements HandlerMethodArgumentResolver {

    private final UserService userService;

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(LoginUser.class)
            && User.class.isAssignableFrom(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter,
                                  ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest,
                                  WebDataBinderFactory binderFactory) {
        String header = webRequest.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            throw new UnauthorizedException("인증 토큰 없음");
        }
        return userService.findByToken(header.substring(7));
    }
}

@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {

    private final LoginUserArgumentResolver loginUserResolver;

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(loginUserResolver);
    }
}

@RestController
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    @GetMapping("/my-orders")
    public List<OrderResponse> myOrders(@LoginUser User user) {
        return orderService.findByUser(user);
    }
}
```

JSON 파트와 이미지 파트를 한 요청으로 받아 S3에 스트리밍 업로드하는 API.

```java
@RestController
@RequestMapping("/api/products")
@RequiredArgsConstructor
public class ProductController {

    private static final Set<String> ALLOWED = Set.of("image/jpeg", "image/png", "image/webp");
    private static final long MAX_IMAGE = 5L * 1024 * 1024;

    private final ProductService productService;
    private final S3Client s3;

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ProductResponse create(@RequestPart("info") @Valid ProductRequest info,
                                  @RequestPart("image") MultipartFile image) throws IOException {
        validate(image);
        String key = "products/" + UUID.randomUUID() + "-"
                + StringUtils.cleanPath(Objects.requireNonNull(image.getOriginalFilename()));
        s3.putObject(PutObjectRequest.builder()
                        .bucket("my-uploads").key(key)
                        .contentType(image.getContentType())
                        .build(),
                RequestBody.fromInputStream(image.getInputStream(), image.getSize()));
        return productService.create(info, key);
    }

    private void validate(MultipartFile file) {
        if (file.isEmpty()) throw new BadRequestException("빈 파일");
        if (file.getSize() > MAX_IMAGE) throw new BadRequestException("파일 크기 초과");
        if (!ALLOWED.contains(file.getContentType())) throw new BadRequestException("허용되지 않는 형식");
        String name = StringUtils.cleanPath(Objects.requireNonNull(file.getOriginalFilename()));
        if (name.contains("..")) throw new BadRequestException("파일명 위험");
    }
}
```

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 50MB
```

정렬 필드를 화이트리스트로 검증하고 `Specification`을 합성하는 목록 조회.

```java
@RestController
@RequestMapping("/api/products")
@RequiredArgsConstructor
public class ProductQueryController {

    private static final Set<String> SORTABLE = Set.of("name", "category", "price", "createdAt");

    private final ProductRepository productRepository;

    @GetMapping
    public Page<ProductResponse> list(
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) BigDecimal minPrice,
            @RequestParam(required = false) BigDecimal maxPrice,
            @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC)
            Pageable pageable) {

        pageable.getSort().stream()
                .map(Sort.Order::getProperty)
                .filter(p -> !SORTABLE.contains(p))
                .findFirst()
                .ifPresent(p -> { throw new BadRequestException("허용되지 않는 정렬 필드: " + p); });

        Specification<Product> spec = Specification
                .where(ProductSpecs.nameContains(name))
                .and(ProductSpecs.categoryIs(category))
                .and(ProductSpecs.priceBetween(minPrice, maxPrice));

        return productRepository.findAll(spec, pageable).map(ProductResponse::from);
    }
}

public final class ProductSpecs {

    public static Specification<Product> nameContains(String name) {
        return (root, query, cb) -> !StringUtils.hasText(name)
                ? cb.conjunction()
                : cb.like(cb.lower(root.get("name")), "%" + name.toLowerCase() + "%");
    }

    public static Specification<Product> categoryIs(String category) {
        return (root, query, cb) -> category == null
                ? cb.conjunction()
                : cb.equal(root.get("category"), category);
    }

    public static Specification<Product> priceBetween(BigDecimal min, BigDecimal max) {
        return (root, query, cb) -> {
            if (min == null && max == null) return cb.conjunction();
            if (min == null) return cb.lessThanOrEqualTo(root.get("price"), max);
            if (max == null) return cb.greaterThanOrEqualTo(root.get("price"), min);
            return cb.between(root.get("price"), min, max);
        };
    }
}
```

## 실무에서 걸리는 지점

- **`supportsParameter` 조건이 느슨하면 다른 매개변수를 가로챈다.** 어노테이션만 검사하면 `@LoginUser String`에 `User`를 반환하고, 타입만 검사하면 의도하지 않은 `User` 매개변수까지 처리한다.
- **`Content-Type`은 클라이언트가 보내는 값이다.** 매직 바이트 검사(Apache Tika 등)를 추가하고, 업로드 파일은 정적 리소스 경로 밖에 UUID 이름으로 저장한다.
- **`getBytes()`는 파일 전체를 힙에 올린다.** 동시 요청 수만큼 배가되므로 `getInputStream()`으로 스트리밍하고, 수백 MB 이상은 presigned URL로 서버를 거치지 않게 한다.
- ==**`size`와 `sort`를 그대로 받으면 공격 벡터가 된다.**== `size=999999`는 테이블 전체를 읽고 `sort=password`는 숨겨야 할 컬럼을 건드린다. `spring.data.web.pageable.max-page-size`를 낮추고 정렬 필드는 화이트리스트로 검증한다.
- ==**컬렉션 fetch join과 페이징은 함께 쓸 수 없다.**== `JOIN FETCH` 쿼리에 `Pageable`을 넘기면 Hibernate가 `HHH90003004` 경고와 함께 전체 결과를 메모리에서 페이징한다. ID만 먼저 페이징한 뒤 `IN`으로 fetch join한다. 무한 스크롤에는 `Slice`로 COUNT 쿼리를 없앤다.

## 관련 글

- [Controller와 요청 바인딩](/notes/java-spring/controller-request-binding/)
- [요청 처리 흐름 — DispatcherServlet·Filter·Interceptor](/notes/java-spring/dispatcher-servlet-filter-interceptor/)
- [쿼리 — 메서드 이름·@Query·QueryDSL·Auditing](/notes/java-spring/jpa-queries-querydsl-auditing/)
