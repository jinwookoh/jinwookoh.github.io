---
title: "Spring Data Elasticsearch"
series: elasticsearch
part: "통합과 클라우드"
order: 20
summary: "단순 CRUD는 Repository, 복잡한 검색·집계는 Operations와 NativeQuery로 나누는 Spring 통합 기준을 정리한다"
tags: [Spring Data Elasticsearch, ElasticsearchRepository, ElasticsearchOperations, NativeQuery, Reactive]
sources: [elasticsearch/2026-05-19-elasticsearch-spring-data-integration.md, 2026-05-03-es-spring-integration.md]
updated: 2026-08-29
---

자바 서비스에서 Elasticsearch를 JSON DSL 문자열 조립으로 호출하면 필드 이름 오타를 컴파일 시점에 잡지 못하고, 응답 파싱 코드가 서비스마다 중복되며, 날짜 직렬화 형식이 매핑과 어긋나도 색인이 조용히 잘못된다. RestHighLevelClient는 deprecated이고 8.x에서는 Elasticsearch Java API Client가 표준이다. Spring Data Elasticsearch는 이 클라이언트 위에 POJO 매핑, Repository, Template 추상화를 얹어 JPA와 같은 형태로 Elasticsearch를 다루게 한다.

## 핵심 개념

의존성은 `spring-boot-starter-data-elasticsearch` 하나다. Spring Boot 3.x 기준 Spring Data Elasticsearch 5.x와 `elasticsearch-java`가 함께 들어오며, 서버 버전과의 호환 범위는 공식 호환표로 맞춘다. `spring.elasticsearch.uris`, `username`, `password`를 설정하면 자동 구성이 `ElasticsearchClient`, `ElasticsearchOperations`(구현체 `ElasticsearchTemplate`), Repository를 등록한다.

매핑은 `@Document(indexName)`이 클래스를 인덱스에, `@Field(type, analyzer, format)`이 필드 타입에, `@Id`가 `_id`에 대응한다. `@MultiField`와 `@InnerField`로 `name.keyword` 같은 하위 필드를 만들고, custom analyzer나 synonym은 `@Setting`, `@Mapping`으로 JSON 파일을 읽는다. `createIndex`는 기본값이 `true`라 기동 시 인덱스를 자동 생성하는데, 운영에서는 검토되지 않은 매핑이 들어가는 경로가 되므로 `false`로 잠그고 `IndexOperations`나 마이그레이션 스크립트로 만든다.

쿼리 작성 수단은 네 가지이며 조건의 복잡도와 동적 여부로 고른다.

| 수단 | 적합한 자리 | 표현력 |
|---|---|---|
| Repository 메서드 이름 | 1~2개 조건의 정적 조회 | 낮음 |
| `@Query` JSON | 조건이 고정된 복잡 쿼리 | 높음 |
| Criteria API | 선택에 따라 조건이 붙는 동적 필터 | 중간 |
| NativeQuery | 집계, function_score, nested 등 DSL 전체 | 가장 높음 |

메서드 이름은 JPA와 같은 키워드를 쓰지만 `findByBrand`는 `term`, `Containing`은 분석기를 거치는 `match`, `Between`은 `range`, `In`은 `terms`로 변환된다. `text` 필드의 정확 매칭은 `keyword` 하위 필드로 조회한다. NativeQuery는 Java API Client의 람다 빌더를 그대로 노출하며 구버전 `NativeSearchQuery`는 제거되었다. 결과는 `SearchHits<T>`로 받으며 문서와 total, aggregations, highlight가 함께 담긴다.

WebFlux 환경에는 `ReactiveElasticsearchOperations`와 `ReactiveElasticsearchRepository`가 있고 반환 타입만 `Mono`, `Flux`다. 전 구간이 비동기인 서비스에서만 쓴다.

## 코드

모든 필드에 타입을 명시하고 이름 필드는 풀텍스트와 정확 매칭을 위해 다중 필드로 잡은 도메인 클래스다.

```java
@Document(indexName = "products", createIndex = false)
public class Product {

    @Id
    private String id;

    @MultiField(
        mainField = @Field(type = FieldType.Text, analyzer = "nori"),
        otherFields = @InnerField(suffix = "keyword", type = FieldType.Keyword)
    )
    private String name;

    @Field(type = FieldType.Keyword)
    private String brand;

    @Field(type = FieldType.Long)
    private Long price;

    @Field(type = FieldType.Date, format = DateFormat.date_optional_time)
    private Instant createdAt;
}
```

단순 조회는 메서드 이름으로, 조건이 고정된 복합 쿼리는 `@Query`로 처리한다. `?0`, `?1`은 위치 파라미터다.

```java
public interface ProductRepository extends ElasticsearchRepository<Product, String> {

    List<Product> findByBrand(String brand);

    Page<Product> findByNameContaining(String keyword, Pageable pageable);

    @Query("""
        {
          "bool": {
            "must": [ { "match": { "name": "?0" } } ],
            "filter": [ { "range": { "price": { "lte": ?1 } } } ]
          }
        }
        """)
    List<Product> findByNameUnderPrice(String name, Long maxPrice);
}
```

집계와 정렬이 함께 필요한 검색은 `ElasticsearchOperations`와 NativeQuery로 작성하고 집계 결과는 Java API Client 타입으로 꺼낸다.

```java
@Service
public class ProductSearchService {

    private final ElasticsearchOperations operations;

    public ProductSearchService(ElasticsearchOperations operations) {
        this.operations = operations;
    }

    public Map<String, Long> searchAndCountByBrand(String keyword, long maxPrice) {
        NativeQuery query = NativeQuery.builder()
            .withQuery(q -> q.bool(b -> b
                .must(m -> m.match(mm -> mm.field("name").query(keyword)))
                .filter(f -> f.range(r -> r.number(n -> n.field("price").lte((double) maxPrice))))))
            .withAggregation("by_brand", Aggregation.of(a -> a.terms(t -> t.field("brand").size(10))))
            .withSort(s -> s.field(f -> f.field("price").order(SortOrder.Desc)))
            .withPageable(PageRequest.of(0, 20))
            .build();

        SearchHits<Product> hits = operations.search(query, Product.class);

        ElasticsearchAggregations aggs = (ElasticsearchAggregations) hits.getAggregations();
        StringTermsAggregate byBrand = aggs.get("by_brand").aggregation().getAggregate().sterms();

        return byBrand.buckets().array().stream()
            .collect(Collectors.toMap(b -> b.key().stringValue(), StringTermsBucket::docCount));
    }
}
```

## 실무에서 걸리는 지점

RefreshPolicy 누수. `save`의 기본 정책은 `NONE`이며, 테스트 편의로 걸어 둔 `IMMEDIATE`가 운영 빌드에 섞이면 색인마다 refresh가 돌아 처리량이 급감한다. 운영은 `NONE` 또는 `WAIT_UNTIL`만 쓰고 `IMMEDIATE`는 `@TestConfiguration`으로 격리한다.

동적 매핑 의존. `@Field` 타입을 생략하면 첫 문서 값으로 타입이 추론되어 숫자 문자열이 `text`로 잡히고 range 쿼리가 동작하지 않는다. 모든 필드에 타입을 명시하고 `dynamic: strict`로 잠근다.

Auditing 미활성. `@CreatedDate`, `@CreatedBy`는 `@EnableElasticsearchAuditing`이 있어야 동작하며 JPA Auditing만 켜 두면 예외 없이 `null`이 들어간다. Reactive 환경에서는 ThreadLocal 값이 Reactor 체인을 따라가지 않아 `Hooks.enableAutomaticContextPropagation()`이 필요하다.

매핑 변경과 배포 순서. Rolling deploy 도중 매핑이 다른 인스턴스가 트래픽을 받으면 색인 거부가 사용자 오류로 이어진다. 새 인덱스 생성, reindex, alias 교체 뒤에 코드를 배포하고 `indexName`에는 alias를 적는다.

테스트 환경. Embedded Elasticsearch는 없으므로 Testcontainers의 `ElasticsearchContainer`를 띄워 URI를 주입한다.

## 관련 글

- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [검색 문서 모델링과 무중단 재색인](/notes/elasticsearch/document-modeling-reindex/)
- [집계 — Metric·Bucket](/notes/elasticsearch/aggregations-metric-bucket/)
