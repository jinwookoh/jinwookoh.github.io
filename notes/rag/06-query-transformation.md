---
title: "쿼리 변환 — 멀티 쿼리·HyDE·라우팅"
series: rag
part: "검색 파이프라인"
order: 6
summary: "사용자 질의를 그대로 검색하지 않고 재작성·확장·분해·라우팅해 검색 단계의 recall을 끌어올린다"
tags: [RAG, Query Transformation, HyDE, LangChain, LlamaIndex]
sources: [https://docs.llamaindex.ai/en/stable/optimizing/advanced_retrieval/query_transformations/, https://python.langchain.com/docs/how_to/MultiQueryRetriever/]
updated: 2026-09-05
---

인덱싱과 검색 알고리즘을 아무리 손봐도 질의 자체가 나쁘면 회수되는 문서가 달라지지 않는다. 사용자는 "작년에 왜 배포가 자꾸 밀렸어"라고 묻는데 문서에는 "릴리스 일정 지연의 주요 원인"이라고 적혀 있다. 두 문장은 뜻이 같아도 임베딩 거리가 생각만큼 가깝지 않다. 질의가 짧으면 벡터가 담는 정보 자체가 빈약하고, 반대로 "A와 B 중 어느 쪽이 더 싸고 언제부터 적용되나"처럼 조건이 여럿 섞이면 하나의 벡터가 여러 의도를 평균 내버려 어느 쪽도 제대로 못 찾는다. 인덱스가 제품 문서·사내 위키·이슈 트래커로 나뉘어 있다면 어디를 뒤질지도 정해야 한다. 이 문제들은 검색기가 아니라 검색 앞단에서, 질의를 고쳐서 푼다.

## 핵심 개념

멀티 쿼리는 하나의 질의를 LLM으로 서로 다른 관점의 여러 문장으로 다시 쓴 뒤 각각 검색하고 결과를 합집합으로 모으는 방식이다. 어휘가 조금씩 다른 질의가 서로 다른 문서를 건지므로 재현율이 올라간다. LangChain의 MultiQueryRetriever가 이 패턴을 그대로 구현해, 생성된 질의마다 하위 retriever를 호출하고 문서를 unique union으로 중복 제거해 돌려준다.

HyDE는 방향이 반대다. 질의를 다듬는 대신 그 질의에 대한 가상의 답변 문서를 LLM에게 쓰게 하고, 그 가짜 문서를 임베딩해 검색한다. 인덱스에 저장된 것은 질문이 아니라 서술문이므로 질문 벡터보다 답변 형태의 벡터가 더 가깝다는 관찰에서 나온 방법이다. LlamaIndex는 `HyDEQueryTransform`으로 제공하며 `include_original=True`로 원래 질의도 함께 임베딩에 반영할 수 있다.

분해는 한 질의를 답하기 위해 여러 번 검색해야 할 때 쓴다. 단일 단계 분해는 복합 질의를 독립적인 하위 질문으로 쪼개 병렬 검색하고, 다단계 분해는 앞 단계의 답을 보고 다음 하위 질문을 만든다. LlamaIndex의 `StepDecomposeQueryTransform`과 `MultiStepQueryEngine` 조합이 후자다. 다단계는 순차 LLM 호출이라 지연이 단계 수만큼 쌓인다.

라우팅은 변환된 질의를 어느 인덱스, 어느 도구로 보낼지 고르는 단계다. Spring MVC에서 요청 URL과 메서드로 핸들러를 고르는 HandlerMapping이 있던 자리에, 경로 대신 질의의 의미로 대상을 고르는 분류기가 들어간다고 보면 된다. 변환 체인 전체도 검색 요청 앞에 끼어드는 전처리라 HandlerInterceptor 체인과 위치가 같고, 따라서 순서·실패 처리·우회 조건을 명시적으로 설계해야 한다.

## 코드

멀티 쿼리는 기존 retriever를 감싸는 형태다. 로거를 올리면 실제로 생성된 질의를 확인할 수 있어 튜닝할 때 반드시 켜 둔다.

```python
import logging
from langchain_classic.retrievers.multi_query import MultiQueryRetriever
from langchain_openai import ChatOpenAI

logging.getLogger("langchain.retrievers.multi_query").setLevel(logging.INFO)

retriever = MultiQueryRetriever.from_llm(
    retriever=vectorstore.as_retriever(search_kwargs={"k": 5}),
    llm=ChatOpenAI(model="gpt-4o-mini", temperature=0),
)
docs = retriever.invoke("작년에 배포 일정이 밀린 이유가 뭐였나")
```

HyDE는 질의 변환기를 만들어 기존 query engine을 감싼다.

```python
from llama_index.core import VectorStoreIndex
from llama_index.core.indices.query.query_transform.base import HyDEQueryTransform
from llama_index.core.query_engine import TransformQueryEngine

index = VectorStoreIndex.from_documents(documents)
base_engine = index.as_query_engine(similarity_top_k=10)

hyde = HyDEQueryTransform(include_original=True)
engine = TransformQueryEngine(base_engine, query_transform=hyde)
response = engine.query("결제 실패 재시도 정책이 어떻게 되나")
```

라우팅은 프레임워크 없이도 충분하다. 라벨 집합을 닫아 두고, 모르는 값이 오면 기본 인덱스로 떨어뜨린다.

```python
RETRIEVERS = {"product": product_engine, "wiki": wiki_engine, "issue": issue_engine}

ROUTER_PROMPT = (
    "질문을 product, wiki, issue 중 하나로 분류한다. 라벨만 출력한다.\n질문: {q}"
)

def route(question: str, llm) -> str:
    label = llm.complete(ROUTER_PROMPT.format(q=question)).text.strip().lower()
    return label if label in RETRIEVERS else "wiki"
```

## 실무에서 걸리는 지점

변환은 검색 앞에 LLM 호출을 하나 더 붙이는 일이라 지연이 그대로 사용자 대기 시간에 더해진다. 멀티 쿼리는 여기에 더해 검색 호출과 리랭커 입력 문서 수가 생성된 질의 개수만큼 곱해진다. 질의 3개면 벡터 검색도 3배, 리랭킹 비용도 대략 3배다.

HyDE는 모델이 모르는 도메인에서 가장 위험하다. ==사내 용어나 최신 정책을 모르면 그럴듯하지만 틀린 가상 문서를 만들고, 검색은 그 허구를 기준으로 엉뚱한 영역을 뒤진다.== 원 질의를 함께 유지하는 설정을 기본으로 두고, 도메인 특수성이 큰 인덱스에서는 도입 전후를 반드시 측정한다.

합집합 중복 제거의 기준을 문서 식별자로 잡지 않으면 같은 청크가 여러 번 들어가 컨텍스트를 잡아먹는다. 청크에 안정적인 id가 없다면 본문 해시라도 붙여 둔다.

==라우팅 오분류는 예외를 던지지 않고 잘못된 인덱스에서 문서를 가져와 성공으로 끝나며, LLM은 그 문서로 그럴듯한 오답을 만든다.== 분류 결과와 최종 답변을 함께 로깅하고, 확신이 낮으면 전체 인덱스를 검색하는 폴백을 둔다.

같은 질문이 반복되는 서비스라면 변환 결과를 질의 문자열 기준으로 캐싱한다. 변환 프롬프트나 모델을 바꾸면 캐시 키에 버전을 포함시켜야 옛 결과가 남지 않는다.

## 관련 글

- [하이브리드 검색과 리랭킹](/notes/rag/hybrid-search-rerank/)
- [RAG 평가 — 검색 품질과 생성 품질을 따로 잰다](/notes/rag/rag-evaluation/)
- [프로덕션 RAG — 캐싱·비용·보안·에이전틱 패턴](/notes/rag/production-rag/)
