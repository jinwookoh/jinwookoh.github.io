---
title: "Term-level·Compound 쿼리"
series: elasticsearch
part: "검색"
order: 10
summary: "정확 일치 조건은 bool.filter에, 점수가 필요한 풀텍스트만 must·should에 두는 이유와 조립 규칙"
tags: [Elasticsearch, Term Query, Bool Query, Filter Context, function_score]
sources: [elasticsearch/2026-05-19-elasticsearch-term-level-queries.md, elasticsearch/2026-05-19-elasticsearch-compound-queries.md, 2026-05-03-es-query-dsl.md]
updated: 2026-08-29
---

상품명에 키워드가 들어가고, 가격은 일정 구간이며, 카테고리는 지정 값이고, 단종 상품은 빼고, 베스트셀러는 앞으로 올린다. 이 요구사항은 풀텍스트 쿼리 하나로 표현할 수 없다. 카테고리·가격은 analyzer를 거치지 않는 정확 일치 쿼리가 필요하고, 조건들을 AND·OR·NOT·점수 조정으로 묶는 조합 쿼리가 필요하다. 이 둘을 구분하지 않으면 `text` 필드에 `term`을 던져 0건이 나오거나, 캐시를 받지 못하는 쿼리가 운영에 올라간다.

## 핵심 개념

Term-level 쿼리는 검색어를 가공하지 않고 색인된 토큰과 1:1로 비교한다. `keyword`·숫자·날짜·boolean·ip처럼 정확 일치가 의미 있는 필드에서만 의도대로 동작하며, `text` 필드는 `.keyword` multi-field로 조회한다.

| 쿼리 | 역할 | 주의 |
|:---|:---|:---|
| `term` / `terms` | 한 값 일치 / 여러 값 중 하나 (SQL `IN`) | 큰 리스트는 `terms_lookup`으로 다른 인덱스 문서의 배열 참조 |
| `range` | `gte`·`lte`·`gt`·`lt` 구간 | 날짜는 `format`·`time_zone` 명시, `now-7d/d` date math 지원 |
| `exists` | 필드 값 존재 여부 | `null`·빈 배열은 없는 것으로 판정. `IS NULL`은 `must_not` + `exists` |
| `prefix` / `wildcard` / `regexp` | 시작 일치 / glob / Lucene 정규식 | 앞쪽 `*`는 전체 토큰 스캔 |
| `fuzzy` | 편집 거리 기반 오타 허용 | `fuzziness: AUTO` + `prefix_length` 1~2 |

Compound 쿼리는 이 조각들을 조합한다. 실무 쿼리의 대부분은 `bool` 하나이고, 랭킹 조정이 필요할 때 `function_score`·`dis_max`·`boosting`이 한 겹 더 붙는다. `bool`의 네 절은 컨텍스트가 다르다. `must`·`should`는 query context에서 `_score`를 계산하고, `filter`·`must_not`은 filter context에서 매칭 여부만 판정해 결과가 node-level query cache에 저장된다. `must`와 `filter`는 둘 다 AND이지만 점수 계산과 캐시 여부가 갈리므로, 점수가 필요 없는 정확 일치 조건은 `filter`에 둔다.

`should`는 위치에 따라 의미가 바뀐다. ==`must`나 `filter`가 함께 있으면 점수만 올리는 옵션이고, `should`만 있으면 최소 하나는 매칭해야 하는 OR 조건이 된다.== `minimum_should_match`로 명시하며 정수, 퍼센트, 조합식(`"3<75%"`)을 받는다.

랭킹 조정 계열은 역할이 나뉜다. `constant_score`는 매칭된 모든 문서에 같은 점수를 준다. `dis_max`는 같은 키워드를 여러 필드에 던져 최고 점수를 채택하고 `tie_breaker`로 나머지를 일부 반영한다. `function_score`는 쿼리로 후보를 잡은 뒤 `field_value_factor`·decay(`gauss`·`linear`·`exp`)·`script_score`·`weight`로 점수를 재계산하며, 함수끼리 합치는 방식이 `score_mode`, 쿼리 점수와 합치는 방식이 `boost_mode`(기본 `multiply`)다. `boosting`은 `negative` 절에 매칭된 문서를 제외하지 않고 `negative_boost`를 곱해 뒤로 민다.

## 코드

상품 검색의 기본형이다. 풀텍스트는 `must`, 정확 일치는 `filter`, 제외는 `must_not`에 둔다.

```json
GET /products/_search
{
  "query": {
    "bool": {
      "must":     [ { "match": { "name": "에어팟" } } ],
      "should":   [ { "term": { "is_bestseller": true } } ],
      "must_not": [ { "term": { "discontinued": true } } ],
      "filter": [
        { "term":  { "category": "audio" } },
        { "range": { "price": { "lte": 100000 } } },
        { "range": { "created_at": { "gte": "now-1y/d", "time_zone": "+09:00" } } }
      ]
    }
  }
}
```

같은 쿼리를 Elasticsearch Java Client로 조립한 Spring 서비스다. Spring Boot 3.x가 자동 구성한 `ElasticsearchClient` 빈을 주입받는다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.query_dsl.Query;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;

@Service
public class ProductSearchService {

    private final ElasticsearchClient client;

    public ProductSearchService(ElasticsearchClient client) {
        this.client = client;
    }

    public List<Product> search(String keyword, String category, long maxPrice) throws IOException {
        Query fullText = Query.of(q -> q.match(m -> m.field("name").query(keyword)));
        Query categoryFilter = Query.of(q -> q.term(t -> t.field("category").value(category)));
        Query priceFilter = Query.of(q -> q.range(r -> r.number(n -> n.field("price").lte((double) maxPrice))));
        Query excludeDiscontinued = Query.of(q -> q.term(t -> t.field("discontinued").value(true)));
        Query bestseller = Query.of(q -> q.term(t -> t.field("is_bestseller").value(true)));

        SearchResponse<Product> response = client.search(s -> s
                .index("products")
                .query(q -> q.bool(b -> b
                        .must(fullText)
                        .filter(categoryFilter, priceFilter)
                        .mustNot(excludeDiscontinued)
                        .should(bestseller)))
                .size(20),
            Product.class);

        return response.hits().hits().stream().map(h -> h.source()).toList();
    }
}
```

판매량과 신선도를 반영한 랭킹이다. ==`log1p`는 0 입력에도 0점을 만들지 않아 `multiply`와 함께 써도 안전하다.==

```java
import co.elastic.clients.elasticsearch._types.query_dsl.FieldValueFactorModifier;
import co.elastic.clients.elasticsearch._types.query_dsl.FunctionBoostMode;
import co.elastic.clients.elasticsearch._types.query_dsl.FunctionScoreMode;
import co.elastic.clients.json.JsonData;

public SearchResponse<Product> rankedSearch(String keyword) throws IOException {
    return client.search(s -> s
            .index("products")
            .query(q -> q.functionScore(fs -> fs
                    .query(inner -> inner.match(m -> m.field("name").query(keyword)))
                    .functions(
                        f -> f.fieldValueFactor(fv -> fv
                                .field("sales_count").modifier(FieldValueFactorModifier.Log1p).factor(0.1)),
                        f -> f.gauss(g -> g.date(d -> d
                                .field("released_at")
                                .placement(p -> p.origin(JsonData.of("now")).scale(JsonData.of("30d")).decay(0.5)))))
                    .scoreMode(FunctionScoreMode.Sum)
                    .boostMode(FunctionBoostMode.Multiply))),
        Product.class);
}
```

## 실무에서 걸리는 지점

- **`text` 필드에 `term`을 던져 0건.** 색인된 토큰은 쪼개져 있어 원문 전체와 일치하지 않는다. 정확 일치·집계·정렬은 `.keyword` multi-field로 간다. 대소문자 문제는 `case_insensitive: true`보다 색인 시점의 `normalizer: lowercase`가 빠르다.
- **정확 일치를 `must`에 넣어 캐시를 못 받음.** QPS가 오르면 점수 계산이 CPU를 먼저 소진한다. `term`·`range`·`exists`를 `filter`로 옮기면 캐시 히트율이 크게 오른다.
- **`should`만 있고 `minimum_should_match` 누락.** 키워드 5개 중 1개만 맞아도 통과해 결과가 수십만 건으로 튄다. ==퍼센트는 내림 계산이라 절이 1~2개일 때 의도보다 강한 제약이 걸리므로 조합식으로 명시한다.==
- **leading wildcard·복잡한 regexp·`fuzziness: 2` + `prefix_length: 0`.** 전체 토큰 스캔에 가까워 클러스터 load를 단번에 올린다. 사용자 입력은 게이트웨이에서 검증하고, 자동완성은 `search_as_you_type`으로 푼다.
- **`script_score`에 복잡한 로직.** 매 문서마다 스크립트가 돌아 응답이 수 초로 늘어난다. 간단한 수식만 허용하고 그 이상은 색인 시점에 계산해 필드로 저장한다. 점수 이상은 `_name`과 `explain`으로 추적한다.

## 관련 글

- [Search API와 Full-text 쿼리](/notes/elasticsearch/search-api-fulltext/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [검색 기능 — highlight·페이징·Suggester](/notes/elasticsearch/search-features-suggesters/)
