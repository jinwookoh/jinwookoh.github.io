---
title: "임베딩과 벡터 유사도 검색"
series: rag
part: "기초"
order: 2
summary: "임베딩은 텍스트를 의미 좌표로 바꾸며, 검색 품질은 모델 선택과 질의·문서 처리의 대칭에서 갈린다"
tags: [embeddings, cosine similarity, OpenAI, Voyage AI, quantization]
sources: [https://platform.openai.com/docs/guides/embeddings, https://docs.claude.com/en/docs/build-with-claude/embeddings]
updated: 2026-09-05
---

키워드 검색은 질문과 문서가 같은 단어를 쓸 때만 동작한다. "환불 규정"으로 검색하면 "반품 시 대금 반환"이라고 쓰인 문서는 걸리지 않는다. 동의어 사전과 형태소 분석 규칙을 계속 늘려 이 간극을 메울 수는 있지만, 사전은 도메인마다 다시 만들어야 하고 표현이 바뀔 때마다 유지 비용이 붙는다. 임베딩은 이 문제를 사전 대신 모델로 푼다. 문장을 의미가 반영된 좌표로 바꿔 두면, 단어가 하나도 겹치지 않아도 가까운 좌표에 있는 문서를 찾을 수 있다.

## 핵심 개념

임베딩 모델은 텍스트를 받아 고정 길이의 실수 벡터를 돌려준다. 학습 과정에서 의미가 비슷한 문장이 서로 가까운 좌표에 놓이도록 조정됐기 때문에, 벡터 사이의 거리가 곧 의미의 유사도 대용치가 된다. OpenAI의 `text-embedding-3-small`은 기본 1536차원, `text-embedding-3-large`는 3072차원이며 입력은 최대 8,192토큰이다. Voyage의 `voyage-4` 계열은 컨텍스트 32,000토큰에 기본 1024차원이고 256·512·2048차원도 고른다.

차원 수는 저장 비용과 검색 속도, 정확도의 교환이다. 두 계열 모두 앞쪽 차원에 더 굵은 정보를 담는 방식으로 학습되어 있어 뒤쪽을 잘라도 성능이 급격히 떨어지지 않는다. OpenAI는 `dimensions` 파라미터로 이 축소를 API 단계에서 처리하며, 문서상 `text-embedding-3-large`를 256차원으로 줄여도 이전 세대인 `text-embedding-ada-002`의 1536차원보다 나은 검색 성능을 낸다. ==벡터를 받아 애플리케이션에서 직접 잘랐다면 길이가 1이 아니게 되므로 다시 정규화해야 하며, 그러지 않으면 코사인 랭킹이 조용히 어긋난다.==

유사도 함수는 코사인, 내적, 유클리드 거리 중에 고른다. OpenAI와 Voyage의 임베딩은 길이 1로 정규화되어 나오므로 코사인 유사도와 내적이 같은 값이 되고, 내적이 더 빠르다. 유클리드 거리도 순위는 동일하다. 즉 정규화된 벡터를 쓰는 한 함수 선택은 성능 문제이지 품질 문제가 아니다.

검색용 임베딩에는 비대칭성이 있다. 질문은 짧은 의문문이고 문서는 긴 서술문이라 같은 방식으로 인코딩하면 손해를 본다. Voyage는 `input_type`으로 이를 구분해 `query`와 `document`에 각각 다른 지시문을 앞에 붙인 뒤 임베딩한다. ==`input_type`을 생략하면 오류 없이 품질만 떨어지므로 검색 용도라면 문서 적재와 질의 양쪽에서 반드시 지정한다.==

Spring 관점에서 임베딩 호출은 `RestClient`로 감싼 외부 API 클라이언트에 해당하고, 대량 적재는 청크 단위로 커밋하는 배치 스텝에 가깝다. 다만 벡터 컬럼은 JPA 표준 타입으로 다루기 어려워 네이티브 쿼리나 전용 클라이언트를 쓰게 된다.

저장 비용이 문제라면 양자화가 있다. Voyage는 `output_dtype`으로 `float`(기본), `int8`·`uint8`, `binary`·`ubinary`를 지원하며 각각 4배와 32배까지 저장 공간을 줄인다.

## 코드

문서와 질의를 같은 모델로 임베딩하되 축소 차원을 명시한다. 배열을 한 번에 넘겨 왕복 횟수를 줄인다.

```ts
import OpenAI from 'openai';

const client = new OpenAI();

async function embed(texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: 512,
  });
  return res.data.map((d) => d.embedding);
}
```

정규화된 벡터에서는 내적만으로 코사인 유사도가 나온다. 상위 k개를 고르는 최소 구현이다.

```ts
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

function topK(query: number[], docs: { id: string; vec: number[] }[], k: number) {
  return docs
    .map((d) => ({ id: d.id, score: dot(query, d.vec) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}
```

Voyage를 쓸 때는 문서와 질의의 `input_type`을 나눈다.

```python
import voyageai

vo = voyageai.Client()

doc_vecs = vo.embed(documents, model="voyage-4", input_type="document").embeddings
query_vec = vo.embed([question], model="voyage-4", input_type="query").embeddings[0]
```

## 실무에서 걸리는 지점

- **문서와 질의의 모델이 어긋나면 검색이 무너진다.** 모델이나 차원 수가 다른 벡터는 같은 공간에 있지 않아 비교 자체가 무의미한데, 오류는 나지 않고 순위만 엉망이 된다. 인덱스 메타데이터에 모델 이름과 차원을 기록하고 질의 시 대조한다.
- **유사도 점수의 절대값은 이식되지 않는다.** ==0.8 같은 임계값은 모델과 데이터 분포마다 의미가 달라 다른 코퍼스에 그대로 옮기면 결과가 전부 잘리거나 전혀 걸러지지 않는다.== 임계값은 실제 질의 집합으로 분포를 그려 본 뒤 정한다.
- **입력 토큰 한도 초과는 조용히 처리된다.** 클라이언트나 라이브러리 설정에 따라 초과분이 잘린 채 임베딩되면 문서 뒷부분이 검색에서 사라진다. 적재 전에 토큰 수를 세고 한도를 넘는 문서는 청킹 단계로 되돌린다.
- **배치 크기와 재시도를 설계한다.** 수십만 건 적재는 레이트 리밋과 일시적 오류를 반드시 만난다. 실패한 배치만 다시 처리할 수 있도록 문서 식별자 기준의 멱등 적재로 만든다.
- **양자화는 재현율을 깎는다.** `int8`이나 `binary`로 저장 비용을 줄이면 상위 후보 순서가 바뀔 수 있다. 양자화된 인덱스로 후보를 넓게 뽑고 원본 정밀도로 재계산하는 2단계 구성을 검토한다.

## 관련 글

- [RAG란 무엇인가 — LLM의 한계와 검색 증강 생성](/notes/rag/what-is-rag/)
- [벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택](/notes/rag/vector-databases/)
- [청킹과 인덱싱 전략](/notes/rag/chunking-indexing/)
