---
title: "하이브리드 검색과 리랭킹"
series: rag
part: "검색 파이프라인"
order: 5
summary: "BM25와 벡터 검색을 RRF로 합치고 cross-encoder 리랭커로 다시 정렬해 상위 k개의 정확도를 끌어올린다"
tags: [RAG, Hybrid Search, RRF, Reranking, Qdrant]
sources: [https://www.elastic.co/docs/solutions/search/hybrid-search, https://qdrant.tech/documentation/concepts/hybrid-queries/, https://docs.cohere.com/docs/rerank-overview]
updated: 2026-09-05
---

벡터 검색만으로 후보를 뽑으면 두 지점에서 무너진다. 하나는 문자열이 결정적인 질의다. 사번, 에러 코드, 제품 모델명, 사내 약어는 임베딩 공간에서 이웃이 촘촘해 dense 검색이 "의미가 비슷한 다른 것"을 함께 끌어온다. 사용자는 정확히 그 토큰을 입력했는데 결과는 인접 개념으로 채워진다. 다른 하나는 순서다. 임베딩 유사도는 질의와 문서를 각각 따로 벡터로 만든 뒤 거리만 재기 때문에, 상위 50개 안에 정답 청크가 들어 있어도 그것이 1위라는 보장이 없다. 컨텍스트에 5개만 넣는 파이프라인에서 46위의 정답은 존재하지 않는 것과 같다. 앞의 문제는 키워드 검색을 함께 돌려 결과를 합치는 하이브리드 검색으로, 뒤의 문제는 리랭킹으로 나눠 푼다.

## 핵심 개념

키워드 쪽 검색은 역색인 위에서 BM25로 점수를 매긴다. 질의 토큰이 문서에 몇 번 나오는지, 그 토큰이 코퍼스 전체에서 얼마나 희귀한지, 문서가 얼마나 긴지를 조합한 값이다. Java 진영에서 익숙한 Lucene의 BM25Similarity가 그대로 Elasticsearch의 기본 스코어러이고, 새로 배울 개념이 아니라 이미 쓰던 전문 검색을 벡터 옆에 다시 세우는 일이다. 최근에는 SPLADE·ELSER처럼 학습된 sparse 임베딩으로 토큰 가중치를 확장해 어휘 불일치를 줄이기도 한다. Qdrant는 이 표현을 `indices`와 `values` 쌍의 sparse 벡터로 받아 dense 벡터와 같은 컬렉션에 둔다.

두 결과를 합칠 때 걸리는 것이 점수 스케일이다. BM25는 0부터 수십까지 열려 있고 코사인 유사도는 0에서 1 사이라 그대로 더하면 한쪽이 다른 쪽을 삼킨다. 그래서 표준 해법은 점수 대신 순위를 쓰는 Reciprocal Rank Fusion이다. 각 결과 목록에서 문서의 순위 r에 `1/(k + r)`을 부여해 전부 더하고, 여러 목록에 공통으로 등장한 문서가 자연히 위로 올라온다. k는 낮은 순위 문서의 영향력을 조절하는 상수인데 ==구현마다 기본값이 달라서 Elasticsearch의 rank_constant는 60, Qdrant의 rrf k는 2다==. 점수의 크기 정보를 살리고 싶으면 Qdrant의 DBSF처럼 각 목록의 평균과 표준편차로 정규화한 뒤 합치는 방식을 쓴다. 다만 RRF는 순위만 보기 때문에 압도적으로 높은 점수를 받은 문서의 우위도 함께 버린다.

리랭킹은 모델 구조가 다르다. 임베딩 모델은 질의와 문서를 독립적으로 인코딩하는 bi-encoder라 문서 벡터를 미리 만들어 둘 수 있어 빠르다. 리랭커는 질의와 문서를 한 입력으로 붙여 넣고 토큰 사이 상호작용을 계산하는 cross-encoder라 정확도가 높은 대신 후보 하나마다 모델을 한 번씩 돌려야 한다. 미리 계산해 둘 수 있는 값이 없다. 그래서 검색은 항상 2단계가 된다. 하이브리드로 50~100개를 넓게 건지고, 리랭커로 상위 5~10개만 남긴다. Cohere Rerank는 이 단계를 API로 제공하며 3.5와 4.0 계열은 100개 이상의 언어를 하나의 다국어 모델로 처리한다. 호출 자체는 외부 동기 HTTP 의존이므로 Spring에서 결제 게이트웨이를 부를 때와 같은 취급이 필요하다. 타임아웃, 재시도 한도, 서킷브레이커를 붙이고 실패 시 융합 순위를 그대로 쓰는 폴백을 준비한다.

## 코드

Elasticsearch는 `rrf` retriever 안에 자식 retriever를 넣어 한 요청으로 두 검색을 돌리고 융합까지 끝낸다.

```json
GET /docs/_search
{
  "retriever": {
    "rrf": {
      "retrievers": [
        { "standard": { "query": { "match": { "text": "결제 실패 재시도 정책" } } } },
        { "knn": { "field": "vector", "query_vector": [0.12, -0.03, 0.55],
                   "k": 50, "num_candidates": 200 } }
      ],
      "rank_window_size": 50,
      "rank_constant": 60
    }
  },
  "size": 10
}
```

Qdrant는 `prefetch`로 sparse·dense 후보를 각각 뽑고 본 쿼리에서 융합한다.

```python
from qdrant_client import QdrantClient, models

client = QdrantClient(url="http://localhost:6333")

hits = client.query_points(
    collection_name="docs",
    prefetch=[
        models.Prefetch(
            query=models.SparseVector(indices=[12, 480], values=[0.9, 0.4]),
            using="sparse", limit=50,
        ),
        models.Prefetch(query=dense_vector, using="dense", limit=50),
    ],
    query=models.FusionQuery(fusion=models.Fusion.RRF),
    limit=20,
).points
```

융합 결과를 리랭커에 넘겨 최종 컨텍스트를 고른다. 응답의 `index`는 입력 배열의 위치이므로 원본 후보와 다시 매핑한다.

```python
import cohere

co = cohere.ClientV2()
docs = [h.payload["text"] for h in hits]

reranked = co.rerank(
    model="rerank-v3.5",
    query="결제 실패 시 재시도는 몇 번까지 하나",
    documents=docs,
    top_n=5,
)
context = [hits[r.index] for r in reranked.results if r.relevance_score >= 0.3]
```

## 실무에서 걸리는 지점

==Elasticsearch의 rank_window_size는 size보다 넉넉히 크게 잡지 않으면 각 검색기가 최종 개수만큼만 후보를 내놓아 융합할 여지가 사라진다.== Qdrant도 같은 이유로 prefetch의 limit이 본 쿼리의 limit과 offset 합보다 커야 한다. 설정을 빼먹어도 오류 없이 결과는 나오고 품질만 조용히 떨어진다.

RRF 점수는 문서 개수와 k에만 의존하는 작은 값이라 절대 임계로 무관 문서를 잘라내는 데 쓸 수 없다. 관련 없는 결과를 컨텍스트에서 제외하려면 리랭커의 relevance_score처럼 의미가 있는 척도로 컷오프를 걸어야 한다.

리랭커 지연은 후보 수에 거의 비례한다. 100개를 넘기면 수백 ms 단위로 늘고 과금 단위도 함께 커지므로, 후보 개수를 늘리는 결정은 반드시 Recall@k 개선폭과 함께 본다. 리랭커에는 문서당 토큰 상한이 있어 ==상한을 넘긴 긴 청크는 뒤쪽이 잘린 채 점수가 매겨지고, 잘린 부분에 정답이 있으면 그 문서는 영구히 하위로 밀린다==.

한국어에서는 분석기 설정이 하이브리드의 성패를 가른다. 형태소 분석기 없이 기본 토크나이저로 색인하면 BM25 쪽이 사실상 무력해져 융합해도 dense 단독과 결과가 거의 같아진다. 가중치를 손으로 조정하기 전에 분석기부터 확인한다.

융합 가중치와 k는 감으로 만지지 않는다. 질의와 정답 문서 쌍 100건 정도의 평가 셋을 만들어 두고 Recall@k와 NDCG로 비교해야 변경이 개선인지 판별된다.

## 관련 글

- [임베딩과 벡터 유사도 검색](/notes/rag/embeddings-vector-search/)
- [청킹과 인덱싱 전략](/notes/rag/chunking-indexing/)
- [쿼리 변환 — 멀티 쿼리·HyDE·라우팅](/notes/rag/query-transformation/)
