---
title: "RAG·Hybrid Search"
series: elasticsearch
part: "집계와 고급 검색"
order: 15
summary: "BM25와 kNN을 RRF로 결합하고 reranker로 다시 정렬해 LLM에 넘기는 RAG 검색 단계를 Elasticsearch 한 쿼리로 구성한다"
tags: [Elasticsearch, RAG, Hybrid Search, RRF, Reranking, ELSER]
sources: [elasticsearch/2026-05-19-elasticsearch-rag-hybrid-search.md]
updated: 2026-08-29
---

kNN만으로 RAG의 retrieval을 구성하면 두 곳에서 구멍이 난다. 고유명사·약어·모델명처럼 문자 매칭이 결정적인 질의에서 벡터는 의미가 비슷한 이웃 문서까지 끌어온다. "GPT-4 Turbo"를 찾는데 "GPT-4o"가 섞이는 식이다. 또 kNN 상위 N개가 답을 담은 청크를 앞 순위에 두었다는 보장이 없어, 그대로 LLM에 넣으면 컨텍스트 낭비와 오답이 늘어난다. 전자는 BM25를 결합한 Hybrid Search로, 후자는 cross-encoder Reranking으로 메우며, Elasticsearch 8.x는 둘을 `retriever` API와 inference endpoint로 서버 안에서 처리한다.

## 핵심 개념

RAG(Retrieval-Augmented Generation)는 세 단계로 나뉜다. 인덱싱은 오프라인 배치로 문서를 chunking하고 임베딩해 텍스트와 벡터를 함께 저장한다. Retrieval은 질의를 같은 임베딩 모델로 변환해 상위 N개 청크를 수십 ms 안에 가져온다. Generation은 그 청크를 컨텍스트로 LLM을 호출하며 지연의 대부분을 차지한다. Elasticsearch의 범위는 두 번째 단계다.

Chunking은 임베딩 모델의 입력 길이 한도와 retrieval 정밀도 때문에 필요하다. 고정 길이로 자르면 문장이 끊기므로 문장 단위로 분리한 뒤 목표 길이까지 모으고 청크 사이에 50~100자 overlap을 둔다. 한국어는 종결어미 변형이 많고 문장이 길어 kss 같은 문장 분리기를 쓴다. 표와 코드 블록은 한 덩어리로 유지하고 한 청크는 한 주제만 다루도록 300~800자로 잡는다.

Hybrid Search는 BM25와 kNN 결과를 Reciprocal Rank Fusion으로 합친다. RRF는 점수가 아니라 순위를 써서 각 목록의 문서에 `1/(k + rank)`를 부여하고 합산하며 k는 보통 60이다. BM25 점수는 0에서 수십, cosine은 0에서 1이라 그대로 더하면 한쪽이 묻히지만 순위만 보면 정규화가 필요 없다. `rrf` retriever의 `rank_constant`가 이 k다.

Reranking은 bi-encoder와 cross-encoder의 역할 분담이다. 임베딩 모델은 질의와 문서를 따로 벡터화하는 bi-encoder라 빠르지만 정밀도에 한계가 있고, reranker는 둘을 함께 입력해 관련도를 직접 산출하는 cross-encoder라 정확하지만 느리다. 그래서 50개를 retrieve한 뒤 상위 5개를 rerank하며, `text_similarity_reranker` retriever가 이 단계를 검색 요청 안에 포함시킨다.

Inference endpoint는 임베딩과 reranker 호출을 Elasticsearch 안으로 옮긴다. ingest pipeline의 `inference` processor가 색인 시 벡터를 채우고, 검색 시에는 `query_vector_builder`가 질의를 벡터로 바꾼다. 외부 API의 재시도·rate limit·오류 처리를 앱에서 짤 필요가 없어진다.

ELSER는 Elastic의 sparse 임베딩 모델로, 문서를 의미 있는 수십~수백 토큰만 값을 가지는 토큰-점수 맵으로 표현하고 역색인으로 검색한다. 라벨 데이터 없이 바로 쓸 수 있지만 한국어 품질은 약하다. 한국어 RAG는 다국어 dense 모델(Cohere embed-v3, bge-m3)이 1순위이고, 영어 RAG는 ELSER와 dense의 hybrid가 표준이다.

튜닝 효과는 질의 100~500개와 정답 목록으로 만든 평가 셋을 `_rank_eval` API에 돌려 Recall@k·MRR·NDCG로 확인한다. RAG는 정답 청크가 top k 안에 드는지가 핵심이라 Recall@k를 우선 본다. boost와 `function_score`로 부족하면 8.12+의 `learning_to_rank` rescorer를 얹는다.

## 코드

임베딩과 reranker를 inference endpoint로 등록한다. API 키는 시크릿 관리 도구에서 주입한다.

```json
PUT _inference/text_embedding/openai-emb
{
  "service": "openai",
  "service_settings": {
    "api_key": "${OPENAI_API_KEY}",
    "model_id": "text-embedding-3-small"
  }
}

PUT _inference/rerank/cohere-rerank
{
  "service": "cohere",
  "service_settings": {
    "api_key": "${COHERE_API_KEY}",
    "model_id": "rerank-multilingual-v3.0"
  }
}
```

BM25와 kNN을 RRF로 묶고 그 결과를 reranker로 재정렬하는 단일 검색 요청이다.

```json
GET /docs/_search
{
  "retriever": {
    "text_similarity_reranker": {
      "retriever": {
        "rrf": {
          "retrievers": [
            {
              "standard": {
                "query": {
                  "multi_match": {
                    "query": "Elasticsearch RAG 구성",
                    "fields": ["title^3", "text"]
                  }
                }
              }
            },
            {
              "knn": {
                "field": "vector",
                "query_vector_builder": {
                  "text_embedding": {
                    "model_id": "openai-emb",
                    "model_text": "Elasticsearch RAG 구성"
                  }
                },
                "k": 50,
                "num_candidates": 100
              }
            }
          ],
          "rank_window_size": 50,
          "rank_constant": 60
        }
      },
      "field": "text",
      "rank_window_size": 50,
      "inference_id": "cohere-rerank",
      "inference_text": "Elasticsearch RAG 구성"
    }
  },
  "size": 5,
  "_source": ["doc_id", "title", "text"]
}
```

Spring Boot 3.x에서 Java API Client로 같은 요청을 보내고 결과를 출처 번호와 함께 프롬프트 컨텍스트로 조립한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import co.elastic.clients.elasticsearch.core.search.Hit;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;
import java.util.stream.IntStream;

@Service
public class RagRetriever {

    private final ElasticsearchClient client;

    public RagRetriever(ElasticsearchClient client) {
        this.client = client;
    }

    public record Chunk(String docId, String title, String text) {}

    public List<Chunk> retrieve(String question) throws IOException {
        SearchResponse<Chunk> res = client.search(s -> s
                .index("docs")
                .size(5)
                .source(src -> src.filter(f -> f.includes("doc_id", "title", "text")))
                .retriever(r -> r.textSimilarityReranker(tr -> tr
                        .field("text")
                        .rankWindowSize(50)
                        .inferenceId("cohere-rerank")
                        .inferenceText(question)
                        .retriever(inner -> inner.rrf(rrf -> rrf
                                .rankWindowSize(50)
                                .rankConstant(60)
                                .retrievers(
                                        std -> std.standard(st -> st.query(q -> q
                                                .multiMatch(mm -> mm
                                                        .query(question)
                                                        .fields("title^3", "text")))),
                                        knn -> knn.knn(k -> k
                                                .field("vector")
                                                .k(50)
                                                .numCandidates(100)
                                                .queryVectorBuilder(qb -> qb
                                                        .textEmbedding(te -> te
                                                                .modelId("openai-emb")
                                                                .modelText(question))))
                                ))))),
                Chunk.class);
        return res.hits().hits().stream().map(Hit::source).toList();
    }

    public String buildContext(List<Chunk> chunks) {
        return IntStream.range(0, chunks.size())
                .mapToObj(i -> "[%d] %s\n%s".formatted(i + 1, chunks.get(i).title(), chunks.get(i).text()))
                .reduce((a, b) -> a + "\n\n" + b)
                .orElse("");
    }
}
```

## 실무에서 걸리는 지점

- ==문서 임베딩과 질의 임베딩의 모델이 다르면 차원이 같아도 벡터 공간이 달라 검색이 무너진다.== 모델 교체는 전체 재색인이며, `dense_vector.dims`를 고정하면 차원 불일치는 색인 시 오류로 잡힌다.
- ==한국어를 standard analyzer로 색인하면 BM25가 어절 단위로만 매칭되어 hybrid의 BM25 기여가 거의 0이 되고 결과가 순수 kNN과 같아진다.== `nori_tokenizer`와 사용자 사전을 먼저 적용한다.
- ==`rank_constant` 60을 그대로 쓰면 BM25와 kNN의 영향력이 동등해서 법률·의료처럼 용어가 결정적인 도메인에서 키워드 매칭이 묻힌다.== BM25 retriever에 boost를 주거나 8.13+의 `linear` retriever로 가중 합산을 명시한다.
- Retrieval 상위 10개를 그대로 LLM에 넣으면 수만 토큰이 되어 context window를 넘긴다. Reranker로 5개 내외로 압축하고, 응답에 청크 번호를 인용하게 해 원본으로 역추적할 수 있게 한다.
- 평가 셋 없이 체감으로 튜닝하면 회귀를 잡을 수 없다. analyzer·임베딩 모델·reranker·boost 값이 바뀔 때마다 `_rank_eval`을 CI에서 돌려 NDCG 변동을 확인한다.

## 관련 글

- [Vector Search·kNN](/notes/elasticsearch/vector-search-knn/)
- [Analyzer와 한국어 분석 (Nori)](/notes/elasticsearch/analyzer-korean/)
- [Ingest Pipeline과 수집기 (Logstash·Beats·Fluentd)](/notes/elasticsearch/ingest-pipeline-collectors/)
