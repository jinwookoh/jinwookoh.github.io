---
title: "검색 기능 — highlight·페이징·Suggester"
series: elasticsearch
part: "검색"
order: 11
summary: "깊은 페이지는 PIT + search_after, 자동완성은 completion 필드, 오타 교정은 term·phrase suggester로 분담한다"
tags: [Elasticsearch, Highlight, search_after, PIT, Suggester]
sources: [elasticsearch/2026-05-19-elasticsearch-search-features.md, elasticsearch/2026-05-19-elasticsearch-suggesters.md]
updated: 2026-08-29
---

쿼리는 어떤 문서가 매칭됐는지까지만 답한다. 화면에는 매칭 위치를 보여주는 highlight, 순서를 정하는 sort, 몇 건씩 넘길지 정하는 pagination, 그리고 입력 순간의 자동완성과 오타 교정이 더 필요하다. 이 계층을 잘못 짜면 `from + size`가 10,000을 넘는 순간 요청이 거부되거나, scroll 컨텍스트가 힙에 남아 누수되거나, 자동완성이 한국어 입력 중간 상태에 반응하지 않는다.

## 핵심 개념

### Highlight와 Sort

`highlight`를 붙이면 `hits[].highlight.<field>`에 매칭 구간을 `<em>`으로 감싼 조각이 담긴다. `pre_tags`·`post_tags`로 태그를 바꾸고 `fragment_size`(기본 100)와 `number_of_fragments`(기본 5)로 응답 크기를 제한한다. highlighter는 기본 `unified`, 큰 본문용 `fvh`가 있으며 `fvh`는 매핑에 `term_vector: with_positions_offsets`가 필요하다.

==`sort`를 지정하면 `_score`를 계산하지 않는다.== 동률은 배열 뒤쪽 기준으로 깨므로 마지막에 unique 필드를 두고, null 문서 위치는 `missing`으로 명시한다.

### Pagination

`from + size`는 모든 샤드가 `from + size`건을 정렬해 coordinator가 병합하므로 깊이에 비례해 비용이 커진다. `index.max_result_window`(기본 10,000)가 이를 차단하며, 이 값을 올리면 OOM으로 이어진다.

| 방식 | 일관성 | 서버 상태 | 용도 |
|---|---|---|---|
| `from + size` | 없음 | 없음 | 상위 수 페이지 |
| PIT + `search_after` | 스냅숏 | PIT 핸들(가벼움) | 무한 스크롤, 깊은 페이지 |
| scroll | 스냅숏 | scroll context(무거움) | 대량 전수 추출 |

`search_after`는 직전 페이지 마지막 hit의 `sort` 값을 커서로 넘긴다. 깊이와 무관하게 비용이 일정하지만 페이징 도중 색인된 문서가 결과를 흔들 수 있어, PIT(Point In Time)로 스냅숏 핸들을 열고 `pit.id`를 함께 보낸다. PIT 검색은 `POST /_search`로 호출하고 tiebreaker로 `_shard_doc`을 쓴다. scroll은 전수 추출에만 남아 있다. 둘 다 끝나면 반드시 닫는다.

### Suggester

입력 중인 prefix와 오타 교정은 일반 쿼리가 아닌 `suggest` 섹션이 담당한다.

| Suggester | 입력 | 결과 | 전제 |
|---|---|---|---|
| term | 단어 하나 | 편집 거리가 가까운 단어 | 없음 |
| phrase | 어구 | 언어 모델로 고른 어구 | shingle 분석 필드 |
| completion | prefix | 자동완성 후보 | `completion` 타입 필드 |
| context | prefix + 필터 | 카테고리·지역 한정 자동완성 | `contexts` 선언 |

term suggester는 Levenshtein 거리로 후보를 고르며 `suggest_mode`·`max_edits`(1~2)·`prefix_length`가 핵심 옵션이다. `min_word_length` 기본값 4는 한국어에서 2~3으로 낮춘다. 여러 단어가 동시에 틀린 어구는 phrase suggester가 n-gram 언어 모델로 조합을 고른다.

completion suggester는 `completion` 필드를 FST로 힙에 올려 prefix 매칭을 수 ms 안에 끝낸다. `input` 배열로 여러 시작어를 등록하고 `weight`로 우선순위를 준다. 일반 검색에는 쓸 수 없다. 대안인 `search_as_you_type` 필드 타입은 보조 필드를 자동 생성해 `multi_match`의 `bool_prefix`로 자동완성을 풀며, 느리지만 일반 검색과 필드를 공유한다. 한국어는 어느 쪽이든 자모 분리 분석기를 색인·쿼리 양쪽에 적용해야 "신ㅊ"이 "신촌"에 매칭된다.

## 코드

PIT를 열고 `search_after`로 순회한 뒤 finally에서 닫는 Java API Client 예제다.

```java
@Service
@RequiredArgsConstructor
public class ArticlePager {

    private final ElasticsearchClient client;

    public List<Article> fetchAll(String keyword) throws IOException {
        String pitId = client.openPointInTime(o -> o
                .index("articles").keepAlive(k -> k.time("2m"))).id();
        List<Article> result = new ArrayList<>();
        List<FieldValue> cursor = null;
        try {
            while (true) {
                final List<FieldValue> after = cursor;
                final String pit = pitId;
                SearchResponse<Article> res = client.search(s -> {
                    s.size(500)
                     .pit(p -> p.id(pit).keepAlive(k -> k.time("2m")))
                     .query(q -> q.match(m -> m.field("content").query(keyword)))
                     .sort(so -> so.field(f -> f.field("created_at").order(SortOrder.Desc)))
                     .sort(so -> so.field(f -> f.field("_shard_doc").order(SortOrder.Asc)));
                    if (after != null) s.searchAfter(after);
                    return s;
                }, Article.class);
                List<Hit<Article>> hits = res.hits().hits();
                if (hits.isEmpty()) break;
                hits.forEach(h -> result.add(h.source()));
                cursor = hits.get(hits.size() - 1).sort();
                pitId = res.pitId();
            }
        } finally {
            final String pit = pitId;
            client.closePointInTime(c -> c.id(pit));
        }
        return result;
    }
}
```

highlight를 첫 페이지에만 붙이는 검색 요청이다.

```java
public SearchResponse<Article> firstPage(String keyword) throws IOException {
    return client.search(s -> s
            .index("articles")
            .size(10)
            .query(q -> q.match(m -> m.field("content").query(keyword)))
            .highlight(h -> h
                    .preTags("<mark class=\"hit\">").postTags("</mark>")
                    .fields("content", f -> f.fragmentSize(150).numberOfFragments(3))),
            Article.class);
}
```

completion suggester를 `size: 0`으로 단독 호출하는 자동완성 엔드포인트다.

```java
@RestController
@RequestMapping("/api/suggest")
@RequiredArgsConstructor
public class SuggestController {

    private final ElasticsearchClient client;

    @GetMapping
    public List<String> suggest(@RequestParam String q) throws IOException {
        SearchResponse<Void> res = client.search(s -> s
                .index("products")
                .size(0)
                .suggest(sg -> sg.suggesters("product_complete", su -> su
                        .prefix(q)
                        .completion(c -> c.field("name_suggest").size(10)
                                .skipDuplicates(true)
                                .fuzzy(f -> f.fuzziness("1"))))),
                Void.class);
        return res.suggest().get("product_complete").stream()
                .flatMap(s -> s.completion().options().stream())
                .map(CompletionSuggestOption::text)
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- **tiebreaker 누락.** ==`created_at` 하나로 `search_after`를 돌리면 같은 시각 문서가 구분되지 않아 페이지 사이에 중복·누락이 생긴다.== sort 마지막에 항상 `_shard_doc`이나 unique 필드를 둔다.
- **PIT·scroll 미해제.** 예외로 끊겨도 keep_alive 만료 전까지 힙을 점유한다. try/finally로 닫고 keep_alive는 1~5분으로 짧게 잡는다.
- **highlight 비용.** 수 MB 본문에 기본 옵션으로 걸면 전체 텍스트를 다시 분석해 응답이 수 초로 늘어난다. fragment 수와 크기를 명시하고 두 번째 페이지부터는 끈다.
- **completion FST 힙 폭증.** ==후보 수백만 건이면 FST만 수 GB가 되어 노드가 OOM에 이른다.== 자동완성 인덱스를 분리하고 `completion.size_in_bytes`를 추적한다.
- **Suggester 전제 누락.** `text` 필드에 completion을 던지면 매핑 에러, `contexts`를 선언하고 쿼리에서 빠뜨리면 0건, phrase suggester가 standard 분석 필드를 가리키면 후보가 비어 있다.

## 관련 글

- [Search API와 Full-text 쿼리](/notes/elasticsearch/search-api-fulltext/)
- [Analyzer와 한국어 분석 (Nori)](/notes/elasticsearch/analyzer-korean/)
- [Spring Data Elasticsearch](/notes/elasticsearch/spring-data-elasticsearch/)
