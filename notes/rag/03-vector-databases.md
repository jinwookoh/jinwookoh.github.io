---
title: "벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택"
series: rag
part: "기초"
order: 3
summary: "벡터 저장소 선택은 규모보다 필터 요구와 운영 부담이 가르며, ANN 인덱스 파라미터가 재현율을 결정한다"
tags: [pgvector, Qdrant, Elasticsearch, HNSW, ANN]
sources: [https://github.com/pgvector/pgvector, https://qdrant.tech/documentation/overview/, https://www.elastic.co/docs/solutions/search/vector]
updated: 2026-09-05
---

문서 수가 수천 건일 때는 벡터를 메모리 배열에 올려 두고 전수 비교해도 충분하다. 문제는 그다음이다. 수백만 건이 되면 한 번의 질의가 초 단위로 늘어지고, 프로세스를 재시작할 때마다 전체를 다시 임베딩해야 하며, 문서 갱신과 삭제를 반영할 방법이 없다. 여기에 팀별 접근 제어와 기간 필터가 붙으면 직접 만든 배열은 더 버티지 못한다. 벡터 저장소는 근사 최근접 이웃 검색, 메타데이터 필터, 갱신과 백업을 한 덩어리로 제공하는 컴포넌트다.

## 핵심 개념

핵심 기술은 근사 최근접 이웃(ANN) 탐색이다. 모든 벡터를 비교하는 대신 미리 만든 자료구조를 따라 후보를 좁히고, 약간의 재현율을 내주고 속도를 얻는다. 가장 널리 쓰이는 HNSW는 계층형 근접 그래프를 만들어 상위 층에서 대략적인 위치를 잡고 하위 층으로 내려가며 이웃을 정밀화한다. IVFFlat은 벡터를 군집으로 나눠 두고 질의와 가까운 군집만 열어 본다.

PostgreSQL을 이미 쓰고 있다면 pgvector가 가장 적은 운영 추가로 시작하는 방법이다. `vector`(단정밀도), `halfvec`(반정밀도), `bit`, `sparsevec` 타입을 제공하고 저장은 16,000차원까지 가능하다. ==그러나 ANN 인덱스를 만들 수 있는 차원은 `vector` 2,000, `halfvec` 4,000으로 제한되므로 3072차원 임베딩은 `halfvec`으로 캐스팅하거나 차원을 줄여야 인덱싱된다.== 거리 연산자는 L2 `<->`, 코사인 `<=>`, 음수 내적 `<#>`, L1 `<+>`이며 이진 벡터용 해밍 `<~>`과 자카드 `<%>`도 있다. HNSW는 `m`(기본 16)과 `ef_construction`(기본 64)으로 만들고 질의 시 `hnsw.ef_search`(기본 40)로 탐색 폭을 조정한다. IVFFlat은 `lists`로 군집 수를 정하고 `ivfflat.probes`(기본 1)로 열어 볼 군집 수를 조정한다.

전용 스토어는 필터와 벡터를 함께 다루는 능력에서 앞선다. Qdrant는 컬렉션 안에 64비트 정수나 UUID로 식별되는 포인트를 두고, 각 포인트에 벡터와 페이로드를 함께 저장한다. 페이로드 인덱스가 HNSW 그래프에 결합되어 있어 필터 조건을 그래프 순회 도중에 적용하며, 사전 필터링이나 사후 필터링에서 생기는 후보 부족 문제를 줄인다. 하나의 포인트에 밀집 벡터와 희소 벡터를 함께 둘 수 있어 하이브리드 검색의 기반이 된다.

Elasticsearch는 기존 검색 인프라 위에 벡터를 얹는 쪽이다. `dense_vector` 필드에 `element_type`과 `similarity`(cosine·dot_product·l2_norm)를 지정하고, `index_options`로 `hnsw`·`int8_hnsw`·`bbq_hnsw` 같은 양자화 변형을 고른다. `knn` 질의의 `num_candidates`가 각 샤드에서 평가할 후보 수를 정한다. 임베딩 생성과 모델 관리를 맡기는 `semantic_text`, ELSER가 만드는 희소 벡터도 함께 제공한다.

Spring 관점의 선택 기준은 단순하다. pgvector는 기존 DataSource, 마이그레이션 도구, 백업 정책, 트랜잭션을 그대로 쓴다. 전용 스토어는 별도 클러스터이므로 스키마 관리와 장애 대응, 원본과의 정합성 유지가 새 운영 업무로 추가된다.

## 코드

pgvector 테이블과 HNSW 인덱스를 만들고 메타데이터 조건과 함께 검색한다. 코사인 거리로 정렬하므로 인덱스도 같은 연산자 클래스로 만든다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE doc_chunk (
  id        bigserial PRIMARY KEY,
  doc_id    text NOT NULL,
  team      text NOT NULL,
  content   text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX ON doc_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

SET hnsw.ef_search = 100;

SELECT id, doc_id, content, 1 - (embedding <=> $1) AS score
FROM doc_chunk
WHERE team = 'people'
ORDER BY embedding <=> $1
LIMIT 10;
```

Qdrant는 컬렉션을 만들 때 거리 함수를 정하고, 필터에 쓸 페이로드 필드에 인덱스를 따로 건다.

```ts
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: 'http://localhost:6333' });

await qdrant.createCollection('doc_chunk', {
  vectors: { size: 1536, distance: 'Cosine' },
});

await qdrant.createPayloadIndex('doc_chunk', { field_name: 'team', field_schema: 'keyword' });

const hits = await qdrant.search('doc_chunk', {
  vector: queryVector,
  limit: 10,
  filter: { must: [{ key: 'team', match: { value: 'people' } }] },
});
```

## 실무에서 걸리는 지점

- **탐색 폭이 결과 수보다 작으면 결과가 모자란다.** ==`hnsw.ef_search`나 `num_candidates`가 요청한 개수보다 작으면 조건에 맞는 문서가 있어도 적게 반환되며, 오류 없이 재현율만 떨어진다.== 최소한 요청 개수보다 크게 잡고 지연과 재현율을 함께 측정해 정한다.
- **필터가 강할수록 ANN이 불리해진다.** 상위 후보 대부분이 필터에서 탈락하면 남는 결과가 거의 없다. pgvector는 `hnsw.iterative_scan`을 켜서 부족분을 더 훑게 하고, 카테고리가 고정적이라면 부분 인덱스를 검토한다.
- **IVFFlat은 데이터가 채워진 뒤에 만든다.** 군집 중심을 기존 데이터로 학습하므로 빈 테이블에 만든 인덱스는 품질이 나쁘고, 데이터가 크게 늘면 재생성이 필요하다. 갱신이 잦은 인덱스라면 HNSW가 관리하기 쉽다.
- **인덱스 생성은 메모리에 좌우된다.** 그래프가 `maintenance_work_mem`에 들어가지 않으면 빌드가 급격히 느려진다. 대량 적재 전에 이 값과 `max_parallel_maintenance_workers`를 올리고, 적재를 끝낸 뒤 인덱스를 만든다.
- **원본과 벡터의 정합성은 스스로 지켜야 한다.** 전용 스토어를 쓰면 문서 삭제가 벡터 삭제로 이어지지 않아 유령 결과가 남는다. 삭제와 갱신을 같은 트랜잭션 경계에 둘 수 없으므로 문서 버전을 페이로드에 넣고 주기적으로 대조하는 작업을 만든다.

## 관련 글

- [임베딩과 벡터 유사도 검색](/notes/rag/embeddings-vector-search/)
- [청킹과 인덱싱 전략](/notes/rag/chunking-indexing/)
- [하이브리드 검색과 리랭킹](/notes/rag/hybrid-search-rerank/)
