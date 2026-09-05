---
title: "GraphRAG — 지식 그래프 기반 검색 증강"
series: rag
part: "그래프와 온톨로지"
order: 7
summary: "여러 문서에 흩어진 사실과 코퍼스 전역 요약 질의를 지식 그래프와 커뮤니티 요약으로 답하는 구조를 정리한다"
tags: [GraphRAG, Knowledge Graph, Neo4j, Cypher, RAG]
sources: [https://microsoft.github.io/graphrag/, https://neo4j.com/docs/neo4j-graphrag-python/current/]
updated: 2026-09-05
---

청크 단위 벡터 검색은 답이 어느 한 청크 안에 통째로 들어 있을 때만 동작한다. 그런데 실제 질문은 그렇게 생기지 않았다. "작년에 지연된 프로젝트들에서 공통으로 언급된 리스크가 뭔가"라는 질의에 답하려면 프로젝트 문서 여러 개를 각각 읽고 교집합을 만들어야 하는데, 어떤 단일 청크도 그 교집합을 담고 있지 않다. "이 자료 전체를 관통하는 주제 다섯 개"처럼 코퍼스 전역을 요약해야 하는 질의는 더 분명하다. 유사도 상위 k개를 아무리 늘려도 전체를 대표하지 못한다. 정답이 인덱스 안에 문장으로 존재하지 않고 문서 사이의 관계로만 존재하기 때문이다. GraphRAG는 색인 단계에서 그 관계를 미리 뽑아 그래프와 요약으로 만들어 두는 접근이다.

## 핵심 개념

Microsoft GraphRAG의 색인 파이프라인은 네 단계다. 먼저 원문을 TextUnit이라 부르는 분석 단위로 쪼갠다. 각 TextUnit에서 LLM이 엔티티와 엔티티 사이의 관계, 그리고 주장을 추출해 그래프를 만든다. 그다음 Leiden 알고리즘으로 그래프를 계층적으로 군집화해 커뮤니티를 만든다. 마지막으로 각 커뮤니티를 아래에서 위로 요약해 커뮤니티 리포트를 생성한다. 검색 시점이 아니라 색인 시점에 LLM을 대량으로 쓰는 구조라는 점이 일반 RAG와 결정적으로 다르다.

질의 모드는 이 산출물의 어느 층을 쓰느냐로 갈린다. global search는 커뮤니티 리포트 전체를 대상으로 map-reduce를 돌린다. map 단계에서 리포트 묶음마다 중간 답변과 중요도 점수를 만들고, reduce 단계에서 점수가 높은 항목만 모아 최종 답을 구성한다. 전역 요약형 질의를 위한 모드다. local search는 질의에서 엔티티를 벡터로 찾아 그래프 진입점을 잡고, 거기서 이웃 엔티티·관계·속성·원본 TextUnit·해당 커뮤니티 리포트를 끌어와 하나의 컨텍스트 윈도에 채운다. `text_unit_prop`과 `community_prop`은 그 윈도를 어떤 비율로 나눌지 정하는 값이다. 특정 대상에 대한 상세 질의는 local, 전체 경향은 global로 보낸다. 그 사이에 커뮤니티 맥락을 섞는 DRIFT search와 그래프를 쓰지 않는 basic search도 있다.

그래프를 직접 운영할 때는 Neo4j 계열 구성이 흔하다. `neo4j-graphrag` 패키지의 `VectorRetriever`는 벡터 인덱스만 쓰고, `VectorCypherRetriever`는 벡터로 찾은 노드를 시작점으로 `retrieval_query`에 적은 Cypher를 실행해 이웃을 붙여 온다. 벡터 검색과 그래프 순회를 한 번의 검색으로 묶는 것이 핵심이다. `Text2CypherRetriever`는 자연어 질의를 Cypher로 번역해 실행한다. Java 백엔드 관점에서 노드와 관계 모델링은 JPA 엔티티와 연관관계 매핑에 대응하고, Text2Cypher는 LLM이 JPQL을 대신 작성하는 것과 같아서 스키마 노출과 권한 문제도 똑같이 따라온다.

## 코드

GraphRAG는 CLI로 색인하고 질의한다. `init`이 설정 파일과 프롬프트 템플릿을 만들고, `index`가 추출과 커뮤니티 요약까지 수행한다.

```bash
graphrag init --root ./rag
# ./rag/settings.yaml 과 프롬프트 템플릿을 도메인에 맞게 수정한 뒤
graphrag index --root ./rag
graphrag query --root ./rag --method global --query "문서 전반의 주요 리스크 다섯 가지"
graphrag query --root ./rag --method local  --query "결제 모듈 담당자가 보고한 이슈"
```

Neo4j로 직접 구성하면 벡터 히트에서 Cypher로 이웃을 확장한 결과를 컨텍스트로 넘긴다.

```python
from neo4j import GraphDatabase
from neo4j_graphrag.embeddings import OpenAIEmbeddings
from neo4j_graphrag.retrievers import VectorCypherRetriever
from neo4j_graphrag.llm import OpenAILLM
from neo4j_graphrag.generation import GraphRAG

driver = GraphDatabase.driver("neo4j://localhost:7687", auth=("reader", "***"))

retrieval_query = """
RETURN node.text AS chunk,
       collect { MATCH (node)-[:MENTIONS]->(e:Entity)-[:RELATED_TO]->(o:Entity)
                 RETURN e.name + ' -> ' + o.name } AS facts
"""

retriever = VectorCypherRetriever(
    driver,
    index_name="chunk-embeddings",
    embedder=OpenAIEmbeddings(model="text-embedding-3-large"),
    retrieval_query=retrieval_query,
)

rag = GraphRAG(retriever=retriever, llm=OpenAILLM(model_name="gpt-4o"))
answer = rag.search(query_text="결제 지연의 원인", retriever_config={"top_k": 5})
```

## 실무에서 걸리는 지점

==색인 비용이 코퍼스 크기에 비례해 LLM 호출로 발생하고, 추출 프롬프트나 엔티티 타입 정의를 바꾸면 전체를 다시 돌려야 한다.== 수천 문서 규모에서도 색인 한 번이 수 시간과 상당한 토큰을 소모하므로, 작은 표본으로 프롬프트를 먼저 튜닝한 뒤 전체를 색인한다.

global search는 질의 한 건마다 다수의 커뮤니티 리포트에 대해 map 호출을 돌린다. 응답 시간과 비용이 벡터 검색 기반 RAG와 비교가 안 될 만큼 크고, ==커뮤니티 레벨을 낮게 잡을수록 상세해지지만 처리해야 할 리포트 수가 늘어 지연과 토큰이 함께 뛴다==. 사용자 대면 경로에 그대로 붙이기 전에 예산 한도부터 정한다.

엔티티 해상도는 그래프 품질을 좌우한다. 같은 대상이 표기 차이로 별개 노드가 되면 관계가 흩어져 다중 홉 질의가 답을 못 찾는다. 동의어 사전과 정규화 규칙을 색인 파이프라인 안에 넣어야 한다.

Text2Cypher는 생성된 쿼리를 그대로 실행하므로 ==쓰기 권한이 없는 읽기 전용 계정으로만 연결하고 실행 쿼리를 로깅한다==. 프롬프트에 스키마를 넣는 순간 라벨과 속성명이 모델에 노출된다는 점도 감안한다.

모든 질의를 그래프로 보낼 필요는 없다. 단일 사실 조회는 여전히 하이브리드 검색이 더 빠르고 싸므로, 전역 요약과 다중 홉 질의만 그래프 경로로 라우팅하는 구성이 현실적이다.

## 관련 글

- [온톨로지와 지식 그래프 모델링 — RDF·OWL·프로퍼티 그래프](/notes/rag/ontology-knowledge-graph/)
- [쿼리 변환 — 멀티 쿼리·HyDE·라우팅](/notes/rag/query-transformation/)
- [프로덕션 RAG — 캐싱·비용·보안·에이전틱 패턴](/notes/rag/production-rag/)
