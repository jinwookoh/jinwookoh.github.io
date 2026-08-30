---
title: "AOP와 SpEL"
series: java-spring
part: "Spring 코어"
order: 16
summary: "횡단 관심사를 프록시로 분리하는 Spring AOP의 동작 원리와 SpEL 표현식의 역할·경계를 정리한다"
tags: [Spring AOP, SpEL, Proxy, Pointcut, Advice]
sources: [spring/2026-05-16-spring-expression-language.md, spring/2026-05-16-aop-cross-cutting-concerns.md, spring/2026-05-16-spring-aspect-first-aop.md]
updated: 2026-08-29
---

서비스 메서드를 열어 보면 비즈니스 로직은 몇 줄이고 로깅·시간 측정·권한 검증·트랜잭션 관리 같은 공통 코드가 나머지를 차지하는 경우가 많다. 이 코드가 수백 개 메서드에 반복되면 한 줄을 고치려 해도 모든 위치를 수정해야 하고, 핵심 로직이 부가 코드에 묻힌다. 여러 모듈을 가로질러 반복되는 횡단 관심사(cross-cutting concern)를 한 곳에 정의해 컨테이너가 대상 메서드에 끼워 넣게 하는 기법이 AOP다. `@PreAuthorize`나 `@Cacheable`처럼 AOP 기반 어노테이션이 조건이나 키를 문자열로 받을 때 그 문자열을 해석하는 것이 SpEL이다.

## 핵심 개념

| 용어 | 의미 |
|---|---|
| Aspect | 횡단 관심사를 모은 단위. `@Aspect` 클래스 |
| Join Point | Advice가 끼어들 수 있는 지점. Spring AOP는 메서드 실행만 해당 |
| Pointcut | Join Point 중 실제 적용 대상을 고르는 표현식 |
| Advice | 선택된 지점에서 실행되는 코드 |
| Weaving | Aspect와 대상 코드를 결합하는 과정. Spring AOP는 런타임 프록시로 수행 |

Spring AOP는 대상 Bean을 감싼 프록시를 컨테이너에 대신 등록한다. 호출자는 프록시를 주입받고, 프록시가 Advice를 실행한 뒤 원본에 위임한다. 인터페이스 기반 JDK 동적 프록시와 서브클래스를 만드는 CGLIB 방식이 있으며, Spring Boot는 `spring.aop.proxy-target-class=true`가 기본이라 CGLIB를 쓴다. `@Transactional`, `@PreAuthorize`, `@Cacheable`, `@Retryable`, `@Timed`가 모두 이 구조 위에서 동작한다. 프록시 방식이므로 가로챌 수 있는 것은 메서드 실행뿐이고, 프록시를 거치지 않는 호출에는 Advice가 적용되지 않는다. 바이트코드를 직접 엮는 AspectJ에는 이 제약이 없다.

Advice는 `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`, `@Around` 다섯 종류다. `@Around`만 `ProceedingJoinPoint`로 실행 자체를 제어한다. `proceed()`를 호출하지 않으면 원본이 실행되지 않고, 인자를 바꿔 넘기거나 반환값을 가공할 수 있다. Pointcut은 `@annotation(...)`이 어노테이션 기준, `execution(* com.example.service.*.*(..))`이 시그니처 기준이며 `*`는 한 토큰, `..`는 하위 패키지 전체 또는 임의 개수의 인자를 뜻한다.

SpEL(Spring Expression Language)은 문자열 속 표현식을 런타임에 평가한다. 리터럴, 산술·논리 연산, 프로퍼티 접근과 메서드 호출, 인덱스 `[0]`과 맵 키 `['tag']`, null이면 멈추는 `?.`, Bean 참조 `@beanName`, 타입 참조 `T(...)`를 지원한다. `@Value`에서 `${app.timeout:30}`은 설정값을 치환하는 프로퍼티 플레이스홀더이고 `#{...}`가 SpEL이며 `#{'${app.name}'.toUpperCase()}`처럼 중첩도 된다. AOP 어노테이션 안에서는 `#userId`처럼 메서드 인자를 참조한다. 직접 쓸 일은 드물고 주로 `@PreAuthorize` 조건, `@Cacheable` 키, `@ConditionalOnExpression`에서 만난다.

## 코드

`spring-boot-starter-aop`를 추가하면 `@EnableAspectJAutoProxy`가 자동 구성된다. 마커 어노테이션과 실행 시간을 기록하는 `@Around` Aspect다.

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface LogExecution {
}

@Aspect
@Component
public class LoggingAspect {

    private static final Logger log = LoggerFactory.getLogger(LoggingAspect.class);

    @Around("@annotation(com.example.shop.aop.LogExecution)")
    public Object logExecution(ProceedingJoinPoint pjp) throws Throwable {
        String method = pjp.getSignature().toShortString();
        long start = System.nanoTime();
        try {
            Object result = pjp.proceed();
            log.info("{} ok {}ms", method, (System.nanoTime() - start) / 1_000_000);
            return result;
        } catch (Throwable t) {
            log.error("{} failed: {}", method, t.getMessage());
            throw t;
        }
    }
}

@Service
public class OrderService {

    @LogExecution
    @Transactional
    public void placeOrder(Order order) {
        // 비즈니스 로직만 남는다
    }
}
```

`proceed()`를 생략하면 원본이 실행되지 않는 점을 이용한 단순 캐시다. `@Cacheable`과 같은 발상이다.

```java
@Aspect
@Component
public class SimpleCacheAspect {

    private final Map<String, Object> cache = new ConcurrentHashMap<>();

    @Around("@annotation(com.example.shop.aop.SimpleCached)")
    public Object cache(ProceedingJoinPoint pjp) throws Throwable {
        String key = pjp.getSignature().toLongString() + Arrays.toString(pjp.getArgs());
        Object hit = cache.get(key);
        if (hit != null) {
            return hit;
        }
        Object result = pjp.proceed();
        if (result != null) {
            cache.put(key, result);
        }
        return result;
    }
}
```

어노테이션 안의 SpEL과 직접 평가다. 직접 평가는 메서드 호출·타입 참조가 차단된 `SimpleEvaluationContext`를 쓴다.

```java
@Service
public class ProductService {

    @Value("${app.default-page-size:20}")
    private int defaultPageSize;

    @Value("#{'${app.region}'.toUpperCase()}")
    private String region;

    @Cacheable(cacheNames = "product", key = "#productId")
    public Product find(Long productId) { /* ... */ return null; }

    @PreAuthorize("hasRole('ADMIN') or #ownerId == authentication.principal.id")
    public void update(Long ownerId, Product product) { /* ... */ }
}

ExpressionParser parser = new SpelExpressionParser();
EvaluationContext ctx = SimpleEvaluationContext.forReadOnlyDataBinding().build();
record Order(long amount, String grade) {}
Boolean vip = parser.parseExpression("amount > 100000 and grade == 'GOLD'")
        .getValue(ctx, new Order(150_000, "GOLD"), Boolean.class);
```

## 실무에서 걸리는 지점

- **자기 호출**. ==같은 클래스 안에서 `this.method()`로 부르면 프록시를 거치지 않아 `@Transactional`도 `@Cacheable`도 적용되지 않는다.== 다른 Bean으로 분리하는 것이 정석이고 `AopContext.currentProxy()`는 최후 수단이다.
- **프록시가 못 감싸는 메서드**. ==CGLIB는 서브클래스를 만들므로 `final`·`private` 메서드에는 Advice가 걸리지 않는다.== 오류 없이 넘어가므로 테스트로 확인한다.
- **Aspect 순서와 예외 전파**. 여러 Aspect가 겹치면 `@Order` 없이는 순서가 보장되지 않는다. ==`@Around`에서 예외를 삼키면 바깥 `@Transactional`이 롤백을 판단하지 못한다.==
- **넓은 Pointcut의 비용**. `execution(* com.example..*.*(..))`처럼 잡으면 거의 모든 Bean이 프록시가 되어 기동 시간과 호출 오버헤드가 늘어난다. 마커 어노테이션 기반 Pointcut이 범위를 명시적으로 유지한다.
- **SpEL과 사용자 입력**. `T(java.lang.Runtime).getRuntime().exec(...)`이 평가되면 서버에서 명령이 실행된다. ==외부 입력을 `StandardEvaluationContext`로 평가하는 코드는 원격 코드 실행 취약점이며 실제 CVE가 반복된 경로다.== 불가피하면 `SimpleEvaluationContext`로 제한한다.

## 관련 글

- [Bean Scope와 생명주기](/notes/java-spring/bean-scope-lifecycle/)
- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
- [캐싱 — @Cacheable과 Spring Data Redis](/notes/java-spring/caching-cacheable-redis/)
