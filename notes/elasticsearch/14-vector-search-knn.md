---
title: "Vector Search·kNN"
series: elasticsearch
part: "집계와 고급 검색"
order: 14
summary: "dense_vector·HNSW·kNN 절로 별도 벡터 DB 없이 의미 검색을 구성하고 RRF로 BM25와 결합한다"
tags: [Elasticsearch, kNN, HNSW, dense_vector, RRF]
sources: [elasticsearch/2026-05-19-elasticsearch-vector-search-knn.md]
updated: 2026-08-29
---

BM25 풀텍스트 검색은 질의어와 문서의 토큰이 겹칠 때만 점수를 낸다. "환불 절차"로 검색하면 "반품 방법"을 다룬 문서는 잡히지 않는다. RAG처럼 질문과 의미적으로 가까운 문서 k개를 LLM 프롬프트에 넣어야 하는 구조에서는 이 한계가 치명적이다. 벡터 전용 DB를 따로 두면 도구가 둘로 나뉘고 키워드 검색과 벡터 검색을 한 쿼리로 묶기 어렵다. Elasticsearch 8.x는 dense_vector 필드, kNN 절, HNSW 인덱스로 벡터 검색을 자체 처리하고 BM25와 결합하는 hybrid retrieval까지 한 요청에서 지원한다.

## 핵심 개념

### dense_vector 필드

임베딩 모델이 출력한 고정 차원 부동소수점 배열을 저장하는 필드 타입이다. 매핑 파라미터 네 개가 동작을 결정한다.

- `dims` — 벡터 차원. 임베딩 모델 출력과 정확히 일치해야 하며 재색인 없이 바꿀 수 없다. text-embedding-3-small은 1,536, BGE-M3는 1,024이다.
- `index` — HNSW 그래프 생성 여부. `true`면 ANN(근사 최근접) 검색, `false`면 전수 계산하는 exact kNN만 가능하다.
- `similarity` — 거리 함수. `cosine`은 방향만 비교하며 주요 텍스트 임베딩의 표준이다. `dot_product`는 L2 정규화된 벡터에서 cosine과 같은 결과를 더 빠르게 내지만 정규화되지 않은 벡터에서는 크기에 좌우된다. `l2_norm`은 유클리드 거리다.
- `element_type` — `float` 외에 `byte`(int8), `bit`(1-bit)를 지원한다. 메모리를 각각 4배·32배 절약하는 대신 recall이 소폭 떨어진다.

### HNSW

`index: true`이면 Lucene이 HNSW(Hierarchical Navigable Small World) 그래프를 만든다. 노드가 듬성한 상위 층에서 진입해 가까운 이웃으로 이동하며 하위 층으로 내려가고, 최하위 층에서 후보를 추린다. 전수 계산 대비 수십~수백 배 빠르며 recall 95% 이상을 유지한다.

| 파라미터 | 의미 | 기본값 | 효과 |
|---|---|---|---|
| `m` | 노드당 이웃 수 | 16 | 크면 recall 상승, 메모리·색인 비용 증가 |
| `ef_construction` | 색인 시 탐색 후보 수 | 100 | 크면 그래프 품질 상승, 색인 시간 증가 |

두 값 모두 색인 후 변경할 수 없다. 검색 시점의 탐색 폭은 쿼리의 `num_candidates`가 담당한다. `type`에는 `hnsw` 외에 `int8_hnsw`(스칼라 양자화), `flat`, `int8_flat`이 있으며 대규모 인덱스에는 `int8_hnsw`가 권장된다.

### kNN 절

`_search`의 `knn` 절이 벡터 검색의 진입점이다. `k`는 최종 반환 수, `num_candidates`는 샤드별로 HNSW가 추릴 후보 수이며 k보다 충분히 커야 근사 오차가 줄어든다. `filter`는 벡터 탐색 전에 후보를 좁히는 pre-filter로, post-filter 방식의 벡터 DB와 달리 정확히 k개를 보장한다.

### Hybrid Retrieval과 RRF

정확한 키워드·고유명사는 BM25가, 의미 유사성은 벡터가 잘 잡는다. `query`와 `knn`을 함께 보내면 두 점수가 `boost`로 합산되지만 BM25(0~∞)와 cosine(-1~1)의 스케일이 달라 튜닝이 불안정하다. 8.8부터 지원하는 RRF(Reciprocal Rank Fusion)는 점수 대신 순위를 합친다. 각 검색기에서 문서가 r위이면 `1 / (rank_constant + r)`을 부여해 합산하며 `rank_constant` 기본값 60은 거의 조정하지 않는다.

### Inference API

8.11부터 OpenAI·Cohere·ELSER 등을 inference endpoint로 등록해 ES가 직접 호출한다. ingest pipeline의 `inference` 프로세서로 색인 시점에 임베딩을 생성하고, 쿼리에서는 `query_vector_builder`로 질의 텍스트를 벡터로 바꾼다. 편리한 대신 임베딩 비용 가시성이 떨어진다.

## 코드

HNSW 파라미터와 int8 양자화를 지정한 dense_vector 매핑이다.

```json
PUT articles
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "nori" },
      "category": { "type": "keyword" },
      "published_at": { "type": "date" },
      "embedding": {
        "type": "dense_vector",
        "dims": 1536,
        "index": true,
        "similarity": "cosine",
        "index_options": {
          "type": "int8_hnsw",
          "m": 16,
          "ef_construction": 200
        }
      }
    }
  }
}
```

BM25와 kNN을 RRF로 결합하는 retriever 쿼리이며, kNN 쪽에는 pre-filter를 건다.

```json
POST articles/_search
{
  "retriever": {
    "rrf": {
      "retrievers": [
        { "standard": { "query": { "match": { "title": "환불 절차" } } } },
        {
          "knn": {
            "field": "embedding",
            "query_vector_builder": {
              "text_embedding": {
                "model_id": "openai-small",
                "model_text": "환불 절차"
              }
            },
            "k": 50,
            "num_candidates": 200,
            "filter": [
              { "term": { "category": "cs" } },
              { "range": { "published_at": { "gte": "2025-01-01" } } }
            ]
          }
        }
      ],
      "rank_window_size": 50,
      "rank_constant": 60
    }
  },
  "size": 10
}
```

Java 클라이언트로 kNN 검색을 실행하는 Spring 서비스다.

```java
@Service
public class ArticleVectorSearchService {

    private final ElasticsearchClient client;

    public ArticleVectorSearchService(ElasticsearchClient client) {
        this.client = client;
    }

    public List<Article> search(List<Float> queryVector, String category) throws IOException {
        SearchResponse<Article> response = client.search(s -> s
                .index("articles")
                .knn(k -> k
                        .field("embedding")
                        .queryVector(queryVector)
                        .k(10)
                        .numCandidates(100)
                        .filter(f -> f.term(t -> t.field("category").value(category))))
                .size(10),
            Article.class);

        return response.hits().hits().stream()
                .map(Hit::source)
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- **dims 불일치** — 매핑을 1,536으로 잡고 768차원 모델 출력을 색인하면 모든 문서가 실패한다. 임베딩 모델 교체는 새 인덱스에 reindex하고 alias를 전환하는 절차로만 가능하다.
- **num_candidates 부족** — k와 같은 값이면 탐색 폭이 좁아 같은 질의의 결과가 요청마다 달라진다. k의 10~20배 또는 최소 100 이상으로 둔다.
- **메모리 폭증** — 1억 건 × 1,536차원 × 4byte는 벡터만 약 614GB다. 처음부터 `int8_hnsw`를 적용하면 recall 손실 2~3%p로 메모리를 4배 줄인다.
- **filter 위치 오류** — `query` 절에 필터를 넣고 `knn`을 분리하면 벡터 검색이 전체 인덱스에서 k개를 뽑은 뒤 필터가 적용되어 결과가 k보다 훨씬 적거나 0건이 된다. 필터는 `knn.filter`에 둔다.
- **Inference API rate limit** — ingest pipeline이 문서마다 외부 API를 호출하면 bulk 색인이 rate limit에 걸려 정지한다. 클라이언트에서 배치 임베딩 후 벡터를 포함해 색인한다.

## 관련 글

- [RAG·Hybrid Search](/notes/elasticsearch/rag-hybrid-search/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [Ingest Pipeline과 수집기 (Logstash·Beats·Fluentd)](/notes/elasticsearch/ingest-pipeline-collectors/)
