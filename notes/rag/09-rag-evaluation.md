---
title: "RAG 평가 — 검색 품질과 생성 품질을 따로 잰다"
series: rag
part: "운영"
order: 9
summary: "검색 단계와 생성 단계를 분리해 지표를 세우고 회귀를 잡는 RAG 평가 파이프라인을 정리한다"
tags: [RAG, Ragas, LlamaIndex, Evaluation, LLM-as-judge]
sources: [https://docs.ragas.io/en/stable/concepts/metrics/, https://docs.llamaindex.ai/en/stable/module_guides/evaluating/]
updated: 2026-09-05
---

RAG 파이프라인은 손댈 곳이 너무 많다. 청크 크기, 임베딩 모델, top-k, 리랭커, 프롬프트 문구까지 어느 하나만 바꿔도 답이 달라지는데, 확인하는 방법이 질문 대여섯 개를 눈으로 읽고 "좋아진 것 같다"고 판단하는 수준에 머무는 경우가 많다. 이러면 두 가지가 동시에 무너진다. 답이 틀렸을 때 검색이 문서를 못 찾은 것인지 모델이 찾은 문서를 무시한 것인지 구분할 수 없고, 다음 배포에서 조용히 나빠진 부분을 아무도 감지하지 못한다. 평가를 검색 층과 생성 층으로 갈라 두면 두 문제가 같이 풀린다.

## 핵심 개념

검색 층은 정답 청크를 아는 라벨이 있으면 LLM 없이 잰다. 질의마다 관련 문서 집합을 미리 정해 두고 hit rate, 평균 역순위(MRR), recall@k, precision@k를 계산한다. LlamaIndex의 `RetrieverEvaluator`가 이 계열이고, 순수 계산이라 빠르고 결정적이며 CI에서 매 커밋 돌릴 만하다.

라벨을 청크 단위로 붙이기 어려우면 LLM 판정자를 쓴다. Ragas의 context precision은 검색된 청크 가운데 질문에 실제로 쓸모 있는 것이 상위에 왔는지를, context recall은 정답을 구성하는 데 필요한 정보가 검색 결과 안에 들어왔는지를 본다. context entities recall은 정답에 등장하는 개체가 컨텍스트에 얼마나 잡혔는지 재고, noise sensitivity는 무관한 청크가 섞였을 때 답이 흔들리는 정도를 본다.

생성 층은 검색 결과를 고정한 채 잰다. faithfulness는 응답의 각 주장이 주어진 컨텍스트로 뒷받침되는지 확인하고, response relevancy는 답이 질문에 대응하는지 본다. 정답 문장이 있으면 factual correctness와 semantic similarity로 비교하고, 톤이나 금칙 같은 프로젝트 고유 기준은 aspect critic이나 rubrics 기반 채점으로 정의한다.

지표마다 요구하는 입력 필드가 다르다는 점이 설계를 좌우한다. Ragas는 샘플 하나를 `user_input`, `retrieved_contexts`, `response`, `reference`로 표현하는데 ==`reference`를 요구하는 지표는 라벨 없는 프로덕션 트래픽에 적용할 수 없어서 온라인 대시보드에 넣으면 값이 채워지지 않는다.== 오프라인 회귀 세트와 온라인 모니터링에 쓸 지표를 처음부터 나눠 정해야 한다.

Spring 쪽 감각으로 보면 검색 지표는 JUnit 단위 테스트에 가깝다. 입력과 기대값이 고정이고 실패 임계값을 assert로 건다. 생성 지표는 골든 파일 회귀 테스트에 가깝고, 데이터셋 전체를 한 번에 도는 `evaluate()` 호출은 Spring Batch 잡처럼 별도 스케줄로 돌린다.

## 코드

Ragas로 검색·생성 지표를 한 번에 돌린다. 판정용 LLM은 래퍼로 감싸 지표에 주입한다.

```python
from ragas import EvaluationDataset, evaluate
from ragas.dataset_schema import SingleTurnSample
from ragas.llms import LangchainLLMWrapper
from ragas.metrics import (
    Faithfulness, ResponseRelevancy,
    LLMContextPrecisionWithoutReference, LLMContextRecall,
)
from langchain_openai import ChatOpenAI

judge = LangchainLLMWrapper(ChatOpenAI(model="gpt-4.1-mini", temperature=0))

samples = [
    SingleTurnSample(
        user_input="환불 요청 기한은 며칠인가",
        retrieved_contexts=["환불은 수령일로부터 7일 이내에 신청한다.", "배송비는 ..."],
        response="수령일로부터 7일 이내에 신청한다.",
        reference="수령일로부터 7일 이내",
    ),
]

result = evaluate(
    dataset=EvaluationDataset(samples=samples),
    metrics=[
        Faithfulness(llm=judge),
        ResponseRelevancy(llm=judge),
        LLMContextPrecisionWithoutReference(llm=judge),
        LLMContextRecall(llm=judge),
    ],
)
print(result)
```

검색 층만 보는 회귀 게이트는 LLM 없이 TypeScript로 짜서 CI에 붙인다. 라벨은 청크 ID 집합으로 관리한다.

```typescript
type Case = { query: string; relevant: Set<string> };

function evaluateRetrieval(
  cases: Case[],
  retrieve: (q: string) => Promise<string[]>,
  k = 5,
) {
  return Promise.all(
    cases.map(async ({ query, relevant }) => {
      const ids = (await retrieve(query)).slice(0, k);
      const hitIndex = ids.findIndex((id) => relevant.has(id));
      const found = ids.filter((id) => relevant.has(id)).length;
      return {
        hit: hitIndex >= 0 ? 1 : 0,
        rr: hitIndex >= 0 ? 1 / (hitIndex + 1) : 0,
        recall: found / relevant.size,
      };
    }),
  ).then((rows) => ({
    hitRate: avg(rows.map((r) => r.hit)),
    mrr: avg(rows.map((r) => r.rr)),
    recall: avg(rows.map((r) => r.recall)),
  }));
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
```

## 실무에서 걸리는 지점

두 층을 합쳐 보면 원인 진단이 불가능해진다. ==검색이 엉뚱한 문서를 가져와도 모델이 그 문서에 충실하게 답하면 faithfulness는 만점인데 답은 틀린다.== faithfulness는 컨텍스트 대비 일관성만 재는 지표이므로 반드시 context recall 계열과 같이 읽는다.

평가용 질문을 문서에서 자동 생성할 때 편향이 들어간다. ==청크 하나를 보고 만든 질문은 그 청크의 표현을 그대로 물려받아 원본을 되찾기 쉬우므로 recall이 실제 사용자 질문보다 과대평가된다.== 실제 로그에서 뽑은 질문을 일정 비율 섞어야 한다.

LLM 판정자 자체가 노이즈다. ==같은 입력에도 점수가 흔들리므로 소수점 둘째 자리 차이를 근거로 배포를 결정하면 안 되고, 판정 온도를 0으로 두고 여러 번 돌려 분산까지 봐야 한다.== 판정 모델을 교체하면 과거 점수와 비교 자체가 무의미해진다.

비용과 시간이 빠르게 커진다. 지표 하나가 샘플당 LLM 호출을 여러 번 하므로 샘플 수 곱하기 지표 수만큼 요금이 붙는다. 커밋마다 도는 스모크 세트는 라벨 기반 검색 지표 위주로 수십 건만 두고, LLM 판정 지표가 들어간 전체 세트는 야간 배치로 분리한다.

임계값은 절대값이 아니라 직전 릴리스 대비 변화폭으로 건다. 도메인마다 달성 가능한 수준이 달라 0.8 같은 숫자를 고정하면 통과만 시키는 방향으로 데이터셋이 왜곡된다.

## 관련 글

- [하이브리드 검색과 리랭킹](/notes/rag/hybrid-search-rerank/)
- [청킹과 인덱싱 전략](/notes/rag/chunking-indexing/)
- [프로덕션 RAG — 캐싱·비용·보안·에이전틱 패턴](/notes/rag/production-rag/)
