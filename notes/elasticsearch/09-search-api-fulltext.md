---
title: "Search API와 Full-text 쿼리"
series: elasticsearch
part: "검색"
order: 9
summary: "_search 요청의 공통 뼈대와 analyzer를 거쳐 BM25로 점수를 매기는 full-text 쿼리 패밀리를 정리한다"
tags: [Elasticsearch, Search API, match, multi_match, BM25]
sources: [elasticsearch/2026-05-19-elasticsearch-search-api-basic.md, elasticsearch/2026-05-19-elasticsearch-fulltext-queries.md, 2026-05-03-es-full-text-search.md]
updated: 2026-08-29
---

색인과 매핑을 갖춰도 검색 요청의 구조를 모르면 기본값 10건만 돌아오는 응답, 1만 건을 넘는 페이징 에러, `text` 필드 정렬 오류가 반복된다. `term` 쿼리로 자연어 문장을 검색하면 입력이 색인 토큰과 그대로 비교되어 아무것도 맞지 않는다. ==자연어 검색은 입력을 분석기에 통과시켜 토큰으로 비교하고 관련도로 정렬하는 full-text 쿼리가 맡는다.==

## 핵심 개념

### `_search` 요청의 뼈대

검색 요청은 `GET|POST /<index>/_search`로 보낸다. 인덱스 자리에는 `logs-*` 같은 와일드카드도 들어간다. URI 검색(`?q=field:value`)은 디버깅 용도이고, 실제 코드는 JSON body 검색을 쓴다. GET에 body를 싣지 못하는 클라이언트가 있으므로 POST로 통일한다.

body의 공통 키는 `query`(검색 조건, 기본 `match_all`), `size`/`from`(기본 10/0), `sort`(기본 `_score` 내림차순, `_doc`이 가장 싼 정렬 키), `_source`(반환 필드, `includes/excludes`·`false` 가능), `track_total_hits`(기본 10,000까지만 정확히 세며 `true`면 전체를 센다), `timeout`(초과 시 부분 결과와 `timed_out: true`)이다. 응답은 `took`, `hits.total`(`value`와 `eq`/`gte` 관계), `hits.max_score`, `hits.hits`로 구성된다.

==`from + size`는 `index.max_result_window`(10,000)를 넘을 수 없다.== 모든 샤드가 `from + size` 건을 coordinating 노드로 보내 다시 합쳐야 하므로 깊은 페이지일수록 비용이 비선형으로 는다. 깊은 페이징은 `search_after`와 PIT를 쓴다.

### Full-text 쿼리와 점수

full-text 쿼리는 입력을 필드의 search analyzer로 분석한 뒤 토큰끼리 비교하므로, 같은 쿼리라도 analyzer에 따라 결과가 달라진다. 색인·검색 analyzer는 `search_analyzer`로 의도적으로 분리하지 않는 한 동일해야 한다.

점수는 BM25로 계산한다. 단어 빈도(TF)가 높을수록, 희귀한 단어(IDF)일수록 점수가 오르고, 문서가 평균보다 길수록 내려간다. `explain: true`로 과정을 확인한다. 가중치는 쿼리 시점 boost(`title^3`)로만 조정하며 index-time boost는 폐기되었다.

- `match` — 단일 필드 자연어 검색. `operator`(기본 `or`), `minimum_should_match`(`"75%"`), `fuzziness`(`AUTO`는 글자 수에 따라 편집 거리 0·1·2)가 핵심 옵션이다.
- `match_phrase` — position 정보로 토큰 순서와 인접성을 검사한다. `slop`으로 허용 간격을 준다.
- `match_phrase_prefix` · `match_bool_prefix` — 마지막 토큰만 prefix 매칭. `max_expansions`(기본 50)가 후보 상한.
- `multi_match` — 여러 필드를 한 번에 검색하며 `type`이 본체다. `best_fields`(기본, 최고 점수 필드 채택, `tie_breaker`로 나머지 반영), `most_fields`(점수 합산, multi-field analyzer 검색), `cross_fields`(여러 필드를 하나로 취급), `phrase`, `phrase_prefix`, `bool_prefix`.
- `query_string` — Lucene 문법 전체를 노출한다. 문법 위반 시 400 에러가 나므로 내부 도구용이다.
- `simple_query_string` — `+`, `-`, `"..."`, `~N`만 허용하고 문법 오류를 무시한다. 사용자 노출이 가능하다.
- `intervals` — 순서·간격·조건부 토큰을 정밀하게 표현한다.

## 코드

Java API Client로 상품 목록을 검색한다. `multi_match`에 boost를 주고 `_source`·정렬·timeout·페이징 상한을 명시한다.

```java
package com.example.search;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.SortOrder;
import co.elastic.clients.elasticsearch._types.query_dsl.TextQueryType;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;

@Service
public class ProductSearchService {

    private static final int MAX_RESULT_WINDOW = 10_000;

    private final ElasticsearchClient client;

    public ProductSearchService(ElasticsearchClient client) {
        this.client = client;
    }

    public SearchResponse<ProductSummary> search(String keyword, int page, int size) throws IOException {
        int from = page * size;
        if (from + size > MAX_RESULT_WINDOW) {
            throw new IllegalArgumentException("page window exceeds " + MAX_RESULT_WINDOW);
        }
        return client.search(s -> s
                .index("products")
                .query(q -> q.multiMatch(m -> m
                        .query(keyword)
                        .fields("title^3", "brand^2", "description")
                        .type(TextQueryType.BestFields)
                        .tieBreaker(0.3)
                        .minimumShouldMatch("75%")))
                .from(from)
                .size(size)
                .sort(so -> so.score(sc -> sc.order(SortOrder.Desc)))
                .sort(so -> so.field(f -> f.field("created_at").order(SortOrder.Desc)))
                .source(src -> src.filter(f -> f.includes(List.of("title", "price", "thumbnail"))))
                .timeout("1s"),
            ProductSummary.class);
    }
}
```

어구 검색은 nori 환경에서 slop을 1~2로 두고, 전체 건수를 표시할 때만 `trackTotalHits`를 켠다.

```java
public SearchResponse<ProductSummary> searchPhrase(String phrase) throws IOException {
    return client.search(s -> s
            .index("products")
            .query(q -> q.matchPhrase(m -> m
                    .field("title")
                    .query(phrase)
                    .slop(2)))
            .trackTotalHits(t -> t.enabled(true))
            .size(20),
        ProductSummary.class);
}
```

## 실무에서 걸리는 지점

- ==**`text` 필드 정렬은 fielddata 오류로 실패한다.** fielddata는 힙을 크게 먹어 기본으로 막혀 있다.== `title.keyword` multi-field를 두고 keyword로 정렬한다.
- **`_source` 전체 반환은 대역폭을 잠식한다.** 목록용과 상세용 검색을 분리해 목록은 필요한 필드만 받는다.
- **`operator` 기본값 `or`는 정밀도를 떨어뜨린다.** 카테고리 내 검색은 `and`, 전체 검색은 `minimum_should_match` 75~80%처럼 화면별로 정한다.
- **`fuzziness`와 prefix 매칭은 비싸다.** 후보 토큰을 확장하므로 대형 인덱스에서 응답이 수십 배 느려진다. fuzziness는 자유 입력에만 쓰고, 짧은 prefix 자동완성은 completion suggester로 옮긴다.
- **`query_string`에 사용자 입력을 직접 넣지 않는다.** `:`나 `(`가 섞이면 파싱 에러가 난다. 사용자 입력은 `match`·`multi_match`, 연산자가 필요하면 `simple_query_string`을 쓴다.

## 관련 글

- [Analyzer와 한국어 분석 (Nori)](/notes/elasticsearch/analyzer-korean/)
- [Term-level·Compound 쿼리](/notes/elasticsearch/term-compound-queries/)
- [검색 기능 — highlight·페이징·Suggester](/notes/elasticsearch/search-features-suggesters/)
