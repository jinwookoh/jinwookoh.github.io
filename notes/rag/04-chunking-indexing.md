---
title: "청킹과 인덱싱 전략"
series: rag
part: "검색 파이프라인"
order: 4
summary: "청크는 검색 단위이자 생성 단위이며, 둘을 분리하고 증분 인덱싱을 설계해야 운영이 굴러간다"
tags: [chunking, LangChain, LlamaIndex, indexing, metadata]
sources: [https://docs.llamaindex.ai/en/stable/module_guides/loading/node_parsers/, https://python.langchain.com/docs/concepts/text_splitters/]
updated: 2026-09-05
---

문서 한 편을 통째로 임베딩하면 여러 주제가 하나의 벡터로 평균화되어, 그 문서 안에 분명히 있는 한 문장을 질문해도 상위에 오르지 않는다. 반대로 문장 단위로 잘게 자르면 지시 대명사가 가리키는 대상이 사라지고, 표의 헤더와 값이 다른 조각으로 흩어져 검색된 내용만으로는 의미를 복원할 수 없다. 청킹은 이 사이에서 검색 단위를 정하는 작업이며, RAG 파이프라인에서 임베딩 모델 선택만큼이나 결과를 크게 흔든다.

## 핵심 개념

분할 전략은 무엇을 경계로 삼는지에 따라 나뉜다. 길이 기반은 문자 수나 토큰 수를 채우면 자르는 방식으로 가장 단순하고 예측 가능하다. 텍스트 구조 기반은 문단, 문장, 단어 순으로 큰 단위를 먼저 지키려 시도하고 초과할 때만 더 작은 단위로 내려간다. LangChain의 `RecursiveCharacterTextSplitter`가 이 방식이며 기본 선택으로 권장된다. 문서 구조 기반은 마크다운 헤더, HTML 태그, 코드의 함수 경계 같은 형식 자체의 계층을 이용한다. 의미 기반 분할은 인접 문장의 임베딩 거리가 벌어지는 지점을 경계로 삼는데, 분할 단계에서 임베딩 비용이 추가로 든다.

파라미터는 어디서나 `chunk_size`와 `chunk_overlap` 두 개다. 여기서 단위 혼동이 자주 발생한다. ==LangChain의 `chunk_size`는 기본적으로 문자 수를 세지만 LlamaIndex의 `SentenceSplitter`는 토큰 수를 세며 기본값이 1024라, 같은 숫자를 옮겨 적으면 청크 크기가 몇 배 차이 난다.== 관리형 쪽의 기준값도 알아 둘 만하다. OpenAI vector store의 기본 청크는 800토큰에 오버랩 400토큰이고, 오버랩은 청크 크기의 절반을 넘을 수 없다.

LlamaIndex는 분할 결과를 단순 문자열이 아니라 노드로 다룬다. 노드는 원본 문서의 메타데이터를 물려받고, 부모 문서와 앞뒤 노드에 대한 관계를 들고 있다. `SentenceSplitter`와 `TokenTextSplitter`가 길이 기반, `MarkdownNodeParser`와 `CodeSplitter`가 구조 기반, `SemanticSplitterNodeParser`가 의미 기반에 해당한다.

검색에 좋은 크기와 생성에 좋은 크기가 다르다는 점이 다음 갈래다. 짧은 조각은 벡터가 선명해 잘 검색되지만 답변 근거로는 문맥이 모자라다. `SentenceWindowNodeParser`는 문장 단위로 검색하되 앞뒤 문장을 함께 돌려주고, `HierarchicalNodeParser`는 크고 작은 청크를 함께 만들어 작은 청크가 많이 걸린 경우 부모 청크로 병합한다. 검색 단위와 전달 단위를 분리하는 것이 이 계열의 공통 아이디어다.

Spring 관점에서 인덱싱 파이프라인은 읽기·변환·쓰기가 분리된 배치 잡이고, 노드의 메타데이터는 엔티티 필드에, 재처리 안전성은 멱등 키 설계에 대응한다.

## 코드

마크다운 문서는 헤더로 먼저 나눈 뒤 길이 기준으로 다시 자른다. 헤더 경로를 메타데이터로 남겨 두면 나중에 필터와 출처 표기에 쓴다.

```python
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter

header_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3")]
)
sections = header_splitter.split_text(markdown_text)

body_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,      # 문자 수 기준
    chunk_overlap=150,
    separators=["\n\n", "\n", ". ", " ", ""],
)
chunks = body_splitter.split_documents(sections)
```

LlamaIndex에서 검색 단위와 전달 단위를 분리한다. 문장 단위로 색인하고 검색 후 앞뒤 세 문장을 함께 꺼낸다.

```python
from llama_index.core.node_parser import SentenceWindowNodeParser

parser = SentenceWindowNodeParser.from_defaults(
    window_size=3,
    window_metadata_key="window",
    original_text_metadata_key="original_text",
)
nodes = parser.get_nodes_from_documents(documents)
```

증분 인덱싱은 내용 해시로 판별한다. 문서 단위로 기존 청크를 지우고 새로 넣는 방식이 부분 갱신보다 안전하다.

```python
import hashlib

digest = hashlib.sha256(raw_text.encode()).hexdigest()
if store.get_digest(doc_id) != digest:
    store.delete_by_doc_id(doc_id)          # 이전 청크 전량 삭제
    store.insert(doc_id, chunks, digest)    # 새 청크 적재
```

## 실무에서 걸리는 지점

- **재인덱싱에서 유령 청크가 남는다.** ==문서가 짧아져 청크 수가 줄면 이전 실행이 만든 뒤쪽 청크가 그대로 남아 삭제된 내용이 계속 검색된다.== 청크 단위로 갱신하지 말고 문서 식별자로 전량 삭제 후 재적재하거나, 인덱싱 실행 식별자를 넣고 이전 실행분을 정리한다.
- **오버랩이 크면 상위 결과가 중복으로 채워진다.** 겹치는 부분이 많을수록 거의 같은 조각 여러 개가 나란히 검색되어 실제로 참고할 수 있는 문맥의 폭이 줄어든다. 오버랩은 청크 크기의 10에서 20퍼센트 선에서 시작해 조정한다.
- **표와 코드 블록은 길이 기준에서 잘린다.** 헤더와 값이 분리되거나 함수 중간이 끊기면 검색된 조각이 근거로 쓸모없어진다. 문서 유형별로 파서를 나누고, 표는 행 단위로 헤더를 복제해 넣는 전처리를 고려한다.
- **메타데이터가 임베딩 텍스트에 섞여 들어간다.** 프레임워크에 따라 노드 메타데이터가 임베딩 입력에 포함되므로, 파일 경로나 타임스탬프 같은 값이 벡터를 오염시킬 수 있다. 임베딩에 포함할 키와 제외할 키를 명시적으로 지정한다.
- **한국어는 토큰과 문자 비율이 다르다.** 영어 기준으로 잡은 문자 수 설정을 그대로 쓰면 임베딩 모델의 입력 한도나 프롬프트 예산 계산이 어긋난다. 실제 토크나이저로 표본 문서의 분포를 재고 값을 정한다.

## 관련 글

- [벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택](/notes/rag/vector-databases/)
- [하이브리드 검색과 리랭킹](/notes/rag/hybrid-search-rerank/)
- [RAG 평가 — 검색 품질과 생성 품질을 따로 잰다](/notes/rag/rag-evaluation/)
