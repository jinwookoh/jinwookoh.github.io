---
title: "캐싱 — @Cacheable과 Spring Data Redis"
series: java-spring
part: "데이터"
order: 30
summary: "@Cacheable·@CachePut·@CacheEvict로 메서드 결과를 캐싱하고, Redis 연동 시 TTL·직렬화·자기 호출 함정을 어떻게 다루는가"
tags: [Spring Cache, "@Cacheable", Redis, Spring Data Redis, Caffeine]
sources: [spring/2026-05-16-cacheable-caching.md, 2026-05-02-spring-caching-events.md, 2026-05-02-redis-spring-data.md, data-infra/2026-05-17-redis-spring-integration.md]
updated: 2026-08-29
---

상품 카탈로그, 공통 코드처럼 수백만 번 읽히지만 갱신은 몇 번뿐인 데이터를 매번 DB까지 보내면 읽기 트래픽이 곧 DB 병목이 된다. 첫 조회 결과를 메모리나 외부 저장소에 두고 같은 인자의 요청은 거기서 반환하면 응답 시간이 밀리초에서 마이크로초 단위로 내려간다. 다만 캐시를 손으로 넣고 빼는 코드가 서비스마다 흩어지면 갱신 누락과 키 불일치가 생기므로, Spring은 이를 어노테이션 기반 추상화로 표준화한다.

## 핵심 개념

Spring Cache는 저장소와 무관한 추상화 계층이다. 코드에는 어노테이션만 붙이고 실제 저장소는 `CacheManager` 구현으로 결정한다. 활성화는 `@EnableCaching`이며, 이것이 없으면 캐시 어노테이션은 무시된다.

동작 원리는 AOP 프록시다. 외부에서 메서드가 호출될 때 프록시가 먼저 캐시를 조회해, 값이 있으면 메서드를 실행하지 않고 반환하고 없으면 실행 후 결과를 저장한다. 프록시를 거치지 않는 호출에서는 캐시가 동작하지 않는다.

세 어노테이션의 차이는 메서드 실행 여부에 있다.

| 어노테이션 | 메서드 실행 | 캐시 동작 | 용도 |
|:---|:---|:---|:---|
| `@Cacheable` | 캐시 미스일 때만 | 결과 저장 후 반환 | 조회 |
| `@CachePut` | 항상 | 결과로 캐시 갱신 | 수정 |
| `@CacheEvict` | 항상 | 항목 또는 전체 삭제 | 삭제 |
| `@Caching` | 항상 | 위 어노테이션 여러 개 묶음 | 복합 무효화 |

키는 기본적으로 파라미터 조합으로 만들어지며 SpEL로 직접 지정할 수 있다. `#id`는 파라미터, `#result`는 반환값, `#root.methodName`은 메서드 이름이다. `condition`은 실행 전에 평가해 캐시 참여 여부를 결정하고, `unless`는 실행 후 반환값을 보고 저장을 거른다.

저장소 선택 기준은 인스턴스 수다. Boot 기본 `CacheManager`는 `ConcurrentHashMap` 기반이라 TTL과 최대 크기를 제어할 수 없다. 단일 인스턴스라면 Caffeine, 여러 인스턴스가 같은 데이터를 캐시한다면 Redis로 저장소를 공유해야 인스턴스 간 불일치가 사라진다.

Spring Data Redis는 Lettuce(기본)나 Jedis 위에 `RedisTemplate`, `RedisCacheManager`, `@RedisHash` Repository를 얹은 추상화다. Lettuce는 Netty 기반으로 연결을 공유하고 비동기·리액티브를 지원한다. `spring-boot-starter-data-redis`와 `spring.cache.type=redis`만으로 `@Cacheable`의 저장소가 Redis로 바뀌고, `RedisCacheManager`를 직접 정의하면 캐시별 TTL과 직렬화를 지정할 수 있다. Sorted Set·Hash 조작은 `RedisTemplate`의 `opsForZSet()`, `opsForHash()`로 직접 수행한다.

## 코드

조회·수정·삭제의 기본 패턴이다. 삭제 시 `@Caching`으로 단건 캐시와 목록 캐시를 함께 무효화한다.

```java
@Service
public class ProductService {

    private final ProductRepository productRepository;

    public ProductService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Cacheable(cacheNames = "products", key = "#id", unless = "#result == null")
    public ProductDto findById(Long id) {
        return productRepository.findById(id).map(ProductDto::from).orElse(null);
    }

    @Cacheable(cacheNames = "productList", key = "#status + ':' + #page",
               condition = "#page == 0")
    public Page<ProductDto> list(String status, int page) {
        return productRepository.findByStatus(status, PageRequest.of(page, 20))
                .map(ProductDto::from);
    }

    @CachePut(cacheNames = "products", key = "#result.id")
    @CacheEvict(cacheNames = "productList", allEntries = true)
    public ProductDto update(Long id, ProductUpdateRequest request) {
        Product product = productRepository.findById(id).orElseThrow();
        product.update(request.name(), request.price());
        return ProductDto.from(product);
    }

    @Caching(evict = {
        @CacheEvict(cacheNames = "products", key = "#id"),
        @CacheEvict(cacheNames = "productList", allEntries = true)
    })
    public void delete(Long id) {
        productRepository.deleteById(id);
    }
}
```

Redis 캐시 저장소 설정이다. 키는 문자열, 값은 JSON으로 직렬화하고 캐시별 TTL을 분리한다.

```java
@Configuration
@EnableCaching
public class RedisCacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        RedisCacheConfiguration defaults = RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(10))
                .disableCachingNullValues()
                .serializeKeysWith(RedisSerializationContext.SerializationPair
                        .fromSerializer(new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair
                        .fromSerializer(new GenericJackson2JsonRedisSerializer()));

        return RedisCacheManager.builder(connectionFactory)
                .cacheDefaults(defaults)
                .withCacheConfiguration("products", defaults.entryTtl(Duration.ofHours(1)))
                .withCacheConfiguration("productList", defaults.entryTtl(Duration.ofMinutes(5)))
                .build();
    }
}
```

```yaml
spring:
  cache:
    type: redis
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 2s
```

랭킹 집계는 `RedisTemplate`으로 직접 다룬다. 직렬화기를 지정하지 않으면 JDK 직렬화가 적용되어 redis-cli에서 읽을 수 없으므로 Bean을 직접 정의한다.

```java
@Configuration
public class RedisTemplateConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }
}

@Service
public class RankingService {

    private final RedisTemplate<String, Object> redisTemplate;

    public RankingService(RedisTemplate<String, Object> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public void addScore(String userId, double delta) {
        redisTemplate.opsForZSet().incrementScore("leaderboard", userId, delta);
    }

    public Set<ZSetOperations.TypedTuple<Object>> top(int count) {
        return redisTemplate.opsForZSet().reverseRangeWithScores("leaderboard", 0, count - 1);
    }
}
```

## 실무에서 걸리는 지점

- **자기 호출.** 같은 클래스 안에서 `this.findById(id)`로 부르면 프록시를 거치지 않아 캐시가 적용되지 않는다. `@Transactional`과 같은 원리이며, 캐시 대상 메서드를 별도 Bean으로 분리한다. public 메서드에만 적용된다.
- **TTL 부재.** ==`RedisCacheManager` 기본 설정은 만료 없이 영구 보관이라 키가 쌓여 메모리가 고갈된다.== `entryTtl`이나 `spring.cache.redis.time-to-live`로 기본 TTL을 지정하고, `RedisTemplate`으로 직접 쓸 때도 `set(key, value, Duration)`으로 TTL을 함께 넘긴다.
- **null 캐싱.** ==null 결과도 저장되므로 데이터가 나중에 생겨도 TTL이 끝날 때까지 null만 반환된다.== `disableCachingNullValues()`나 `unless = "#result == null"`로 막는다.
- **무효화 누락과 키 설계.** 쓰기 경로에 `@CachePut`이나 `@CacheEvict`가 빠지면 오래된 데이터가 계속 반환된다. ==수정 메서드에 `@Cacheable`을 붙이면 두 번째 수정부터 DB 갱신이 생략된다.== 키가 거칠면 다른 조회가 같은 항목을 덮어쓰고, 세밀하면 미스가 잦아진다.
- **직렬화와 타입.** ==`GenericJackson2JsonRedisSerializer`는 클래스 정보를 JSON에 포함하므로 클래스 이름이 바뀌면 기존 캐시 역직렬화가 실패한다.== 배포 시 캐시를 비우거나 캐시 이름에 버전을 붙인다. `Object` 캐스팅은 `ClassCastException` 위험이 있으므로 타입별 `RedisTemplate`이나 `StringRedisTemplate`을 쓴다.
- **Lettuce 공유 연결과 Cluster.** `BLPOP` 같은 blocking 명령은 공유 연결을 멈추므로 전용 연결로 분리한다. Cluster에서 `multiGet`은 키가 다른 슬롯에 있으면 CROSSSLOT 오류가 나므로 hash tag로 모으거나 파이프라인으로 나눈다. 루프 안 Redis 호출은 `multiGet`이나 `executePipelined`로 묶는다.

## 관련 글

- [AOP와 SpEL](/notes/java-spring/aop-spel/)
- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
