---
title: "Lucene 내부 — Segment·역색인·Posting List"
series: elasticsearch
part: "기초"
order: 2
summary: "샤드 안의 Lucene이 Segment·역색인·Posting List·Doc Values를 어떻게 쌓고 읽는지, refresh·flush·merge가 왜 갈리는지 정리한다."
tags: [Elasticsearch, Lucene, Inverted Index, Segment, Doc Values]
sources: [elasticsearch/2026-05-19-elasticsearch-lucene-internals.md]
updated: 2026-08-29
---

색인한 문서가 곧바로 검색에 잡히지 않는 이유, refresh 간격을 줄였더니 디스크 IO가 치솟는 이유, text 필드 정렬이 heap을 터뜨리는 이유는 모두 Elasticsearch 아래의 Apache Lucene 저장 구조에서 나온다. ==샤드 하나는 Lucene 인덱스 하나이며, 그 저장 구조를 모르면 위 증상을 설정값 조정으로만 돌려막게 된다.==

## 핵심 개념

### Segment — 불변 단위

Lucene이 디스크에 쓰는 기본 단위는 Segment로, 역색인·Doc Values·stored fields를 한 세트로 갖는 독립된 작은 인덱스다. 한 번 쓰인 Segment는 수정되지 않고, 새 문서는 새 Segment에 들어가며, 기존 문서 수정은 삭제 표시 후 새 버전을 쓰는 append-only 방식이다. 덕분에 검색은 잠금 없이 진행된다.

색인 요청은 먼저 메모리 버퍼에 쌓인다. 기본 1초 간격의 **refresh**가 버퍼를 새 Segment로 닫으면 검색 가능해진다. 이것이 near real-time 검색의 실체다. **flush**는 별개로, Segment를 fsync로 영구화하고 translog를 비운다. ==refresh는 가시성, flush는 내구성을 담당한다.==

모든 쿼리가 Segment 수만큼 순회하므로 Lucene은 백그라운드 **merge**로 작은 Segment를 합치고, 이때 삭제 문서가 실제로 제거된다. `_forcemerge`는 이를 수동으로 강제하며 쓰기가 끝난 인덱스에서만 의미가 있다.

### 역색인 — Term Dictionary와 Posting List

역색인은 "term → 등장 문서 ID 목록" 매핑이다. **Term Dictionary**는 고유 term의 정렬 사전으로 FST로 압축되고, **Posting List**는 각 term에 매달린 정렬된 문서 ID 목록이다. AND 쿼리는 교집합, OR 쿼리는 합집합으로 풀린다. Posting List에 frequency·position·offset을 어디까지 기록할지는 `index_options`가 정한다.

| index_options | 기록 항목 | 가능한 기능 |
|---|---|---|
| `docs` | doc id | 존재 여부. keyword 기본값 |
| `freqs` | + frequency | BM25 스코어링 |
| `positions` | + position | match_phrase. text 기본값 |
| `offsets` | + offset | 빠른 highlighting |

문서 ID는 delta 인코딩 후 블록 단위 비트 패킹(FOR·PFOR-Delta)으로 저장된다. text 필드는 analyzer를 거쳐 토큰 단위로, keyword 필드는 값 전체가 하나의 term으로 색인되므로 text는 부분 일치에, keyword는 정확 일치·정렬·집계에 맞다. 스코어링은 Lucene 6.0부터 BM25가 기본이다.

### Analyzer — 세 단계 파이프라인

text 필드의 토큰은 Analyzer가 결정한다. **Character filter**(`html_strip`)가 문자열을 전처리하고, 정확히 하나의 **Tokenizer**(`standard`, `nori_tokenizer`)가 토큰으로 나누며, **Token filter**(`lowercase`, `stop`, `synonym`)가 순서대로 가공한다. 색인과 검색 양쪽에 같은 파이프라인이 적용되어야 term이 일치하며, edge n-gram 자동완성처럼 의도적으로 다르게 둘 때만 `search_analyzer`를 분리한다.

### Doc Values — 문서 → 필드 값

역색인은 "term → 문서" 방향에만 빠르다. 정렬·집계·스크립트처럼 "문서 → 필드 값"을 읽기 위해 Lucene은 필드 값을 문서 ID 순으로 나열한 컬럼 지향 파일인 Doc Values를 둔다. keyword·numeric·date·boolean·geo_point는 기본으로 켜져 있고 text는 꺼져 있다. text 필드를 정렬·집계에 쓰면 fielddata가 JVM heap에 역색인을 뒤집어 올려 OOM의 원인이 된다.

## 코드

Spring Boot 3.x에서 Elasticsearch Java API Client를 빈으로 등록한다.

```java
@Configuration
public class ElasticsearchConfig {

    @Bean
    public ElasticsearchClient elasticsearchClient() {
        RestClient restClient = RestClient.builder(
                new HttpHost("localhost", 9200, "http")).build();
        RestClientTransport transport =
                new RestClientTransport(restClient, new JacksonJsonpMapper());
        return new ElasticsearchClient(transport);
    }
}
```

Posting List 기록 범위를 매핑에서 명시하고, 정렬용 keyword sub-field를 함께 둔다.

```java
@Service
public class ProductIndexService {

    private final ElasticsearchClient client;

    public ProductIndexService(ElasticsearchClient client) {
        this.client = client;
    }

    public void createIndex() throws IOException {
        client.indices().create(c -> c
            .index("products")
            .settings(s -> s.refreshInterval(t -> t.time("30s")))
            .mappings(m -> m
                .properties("title", p -> p.text(t -> t
                    .analyzer("standard")
                    .indexOptions(IndexOptions.Positions)
                    .fields("raw", f -> f.keyword(k -> k))))
                .properties("body", p -> p.text(t -> t
                    .indexOptions(IndexOptions.Offsets)))
                .properties("sku", p -> p.keyword(k -> k
                    .indexOptions(IndexOptions.Docs)))
                .properties("price", p -> p.long_(l -> l))));
    }
}
```

대량 색인 동안 refresh를 끄고 끝나면 복원하며, Segment 수를 확인한다.

```java
public void bulkWithRefreshDisabled(Runnable bulkJob) throws IOException {
    client.indices().putSettings(s -> s.index("products")
        .settings(x -> x.refreshInterval(t -> t.time("-1"))));
    try {
        bulkJob.run();
    } finally {
        client.indices().putSettings(s -> s.index("products")
            .settings(x -> x.refreshInterval(t -> t.time("30s"))));
        client.indices().refresh(r -> r.index("products"));
    }
}

public long segmentCount() throws IOException {
    return client.indices().segments(s -> s.index("products"))
        .indices().get("products").shards().values().stream()
        .flatMap(List::stream)
        .mapToLong(sh -> sh.segments().size())
        .sum();
}
```

## 실무에서 걸리는 지점

- **refresh_interval 단축.** 100ms 단위로 내리면 작은 Segment가 폭증해 merge 부하와 검색 지연이 함께 오른다. 로그성 인덱스는 30s~60s가 표준이고, 대량 bulk 중에는 `-1`로 껐다가 복원한다.
- ==**쓰기가 살아 있는 인덱스에 force merge.** 대용량 IO가 노드를 장시간 점유하고, 합쳐진 거대 Segment는 자동 merge 후보에서 빠져 삭제 문서가 회수되지 않는다.== ILM warm 단계처럼 읽기 전용이 보장된 시점에 자동화한다.
- **Segment 수천 개 누적.** `ulimit -n` 한도에 걸리거나 P99 지연이 급등한다. 시간 데이터는 인덱스를 기간별로 나눈다.
- **text 필드 정렬·집계.** `title.raw` 같은 keyword sub-field로 보낸다. `doc_values: false`는 정렬·집계가 없다고 확신하는 필드에만 적용하며, 되돌리려면 재색인이 필요하다.
- **색인·검색 analyzer 불일치.** 색인에만 lowercase가 있으면 결과가 0건이 된다. 매핑에 `analyzer` 하나만 지정해 통일한다.

## 관련 글

- [Elasticsearch란 — Index·Document·Shard·Replica](/notes/elasticsearch/what-is-elasticsearch/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [Analyzer와 한국어 분석 (Nori)](/notes/elasticsearch/analyzer-korean/)
