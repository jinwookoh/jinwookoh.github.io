---
title: "RAG란 무엇인가 — LLM의 한계와 검색 증강 생성"
series: rag
part: "기초"
order: 1
summary: "RAG는 질문 시점에 관련 문서를 찾아 프롬프트에 붙이는 구조이며, 품질은 검색 단계가 결정한다"
tags: [RAG, LLM, retrieval, vector store, grounding]
sources: [https://platform.openai.com/docs/guides/retrieval, https://docs.claude.com/en/docs/build-with-claude/embeddings]
updated: 2026-09-05
---

LLM은 학습이 끝난 시점의 가중치 안에만 지식을 담고 있다. 사내 위키, 어제 배포된 릴리스 노트, 이번 분기에 바뀐 약관은 그 안에 없다. 모르는 내용을 모른다고 말하는 대신 형식만 그럴듯한 문장을 만들어 내는 성질이 겹치면, 근거를 확인할 수 없는 답변이 그대로 사용자에게 전달된다. 대안으로 먼저 떠오르는 파인튜닝은 문서가 매일 바뀌는 환경에서 재학습 주기와 비용이 맞지 않고, 어떤 문서를 근거로 답했는지 추적할 수도 없다. 반대로 전체 문서를 프롬프트에 밀어 넣는 방식은 컨텍스트 한계와 토큰 비용에 먼저 부딪힌다. 질문이 들어온 그 시점에 관련된 조각만 골라 프롬프트에 붙이는 방식이 검색 증강 생성, 즉 RAG다.

## 핵심 개념

RAG 시스템은 실행 시점이 다른 두 개의 파이프라인으로 구성된다. 인덱싱 파이프라인은 오프라인에서 돌며 원본 문서를 읽고, 검색 단위로 자르고, 각 조각을 임베딩 벡터로 바꿔 저장소에 적재한다. 질의 파이프라인은 요청마다 돌며 질문을 같은 방식으로 임베딩하고, 저장소에서 유사한 조각 상위 k개를 꺼내고, 그 조각을 지시문과 함께 프롬프트로 조립해 모델에 넘긴다.

Spring 경험에 대응시키면 인덱싱 파이프라인은 ItemReader·ItemProcessor·ItemWriter로 구성한 Spring Batch 잡에 가깝고, 벡터 저장소 접근 계층은 Repository, 질의 파이프라인은 요청 스코프의 `@Service`에 해당한다. 중요한 것은 이 둘이 서로 다른 배포 주기와 실패 모드를 가진 별개의 시스템이라는 점이다. 답변 품질 문제가 생기면 검색이 잘못 물어 온 것인지 생성이 잘못 요약한 것인지부터 갈라야 한다.

RAG는 모델 가중치를 건드리지 않는다. 그래서 문서를 지우면 다음 질의부터 즉시 반영되고, 사용자 권한에 따라 검색 범위를 다르게 줄 수 있으며, 답변에 어떤 문서의 어느 조각을 썼는지 출처를 붙일 수 있다. 파인튜닝으로는 어느 것도 쉽게 얻지 못한다.

직접 조립하는 대신 관리형 검색을 쓰는 선택지도 있다. OpenAI의 Retrieval API는 vector store에 파일을 올리면 청킹·임베딩·인덱싱을 대신 처리하고, 자연어 질의로 검색한다. 청킹은 `chunking_strategy`의 `max_chunk_size_tokens`(기본 800)와 `chunk_overlap_tokens`(기본 400)로 조정하며, 오버랩은 청크 크기의 절반을 넘을 수 없다. 검색 결과는 기본 10건이고 `max_num_results`로 최대 50건까지 늘린다. `ranking_options`의 `score_threshold`로 점수가 낮은 조각을 걸러 내고, 파일마다 최대 16개까지 붙일 수 있는 속성으로 검색 범위를 좁힌다.

여기서 자주 오해가 생긴다. ==RAG는 환각을 제거하는 장치가 아니라 근거를 주입하는 장치이며, 검색이 엉뚱한 문서를 물어 오면 모델은 그 문서를 충실히 요약해 틀린 답을 만든다.== 검색이 정답을 포함하지 못한 상태에서 프롬프트만 다듬는 작업은 아무것도 고치지 못한다.

## 코드

관리형 vector store에 문서를 적재하고 검색하는 최소 흐름이다. 검색 단계에서 결과 수와 점수 하한, 메타데이터 필터를 함께 지정한다.

```ts
import fs from 'node:fs';
import OpenAI from 'openai';

const client = new OpenAI();

const store = await client.vectorStores.create({ name: 'internal-handbook' });

await client.vectorStores.files.uploadAndPoll(store.id, fs.createReadStream('handbook.md'), {
  chunking_strategy: {
    type: 'static',
    static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 },
  },
});

const found = await client.vectorStores.search(store.id, {
  query: '연차는 언제까지 소진해야 하나',
  max_num_results: 8,
  ranking_options: { score_threshold: 0.4 },
  filters: { type: 'eq', key: 'team', value: 'people' },
});
```

검색 결과를 프롬프트로 조립하는 부분이다. 조각마다 식별자를 함께 넣어 답변이 출처를 인용하도록 강제하고, 근거가 없으면 답하지 말라는 조건을 지시문에 명시한다.

```ts
const context = found.data
  .map((r, i) => `[${i + 1}] ${r.filename}\n${r.content.map((c) => c.text).join('\n')}`)
  .join('\n\n');

const answer = await client.responses.create({
  model: 'gpt-5',
  input: [
    {
      role: 'system',
      content:
        '아래 자료에 있는 내용만으로 답한다. 근거가 없으면 자료에 없다고 답한다. ' +
        '문장 끝에 사용한 자료 번호를 [1] 형식으로 표기한다.',
    },
    { role: 'user', content: `자료:\n${context}\n\n질문: 연차는 언제까지 소진해야 하나` },
  ],
});
```

## 실무에서 걸리는 지점

- **검색 실패가 생성 실패로 위장된다.** 답변이 틀렸을 때 어떤 조각이 검색됐는지 남아 있지 않으면 원인을 가를 수 없다. 질의별로 검색된 조각의 식별자와 점수를 로그에 남기고, 정답이 포함됐는지를 먼저 확인하는 순서를 고정한다.
- **k를 키우는 것이 항상 이득은 아니다.** 조각을 많이 넣을수록 노이즈와 토큰 비용, 지연이 함께 늘고 정작 필요한 문장이 긴 컨텍스트 가운데 묻힌다. 개수를 늘리기보다 점수 하한과 리랭킹으로 상위 조각의 질을 올리는 편이 낫다.
- **권한 필터는 검색 질의 안에 넣는다.** ==검색 결과를 받아 애플리케이션에서 걸러 내면 이미 상위 k개가 볼 수 없는 문서로 채워진 뒤라 사용자에게 보여 줄 근거가 사라진다.== 저장 시점에 소유 팀과 공개 범위를 메타데이터로 붙이고 질의 조건으로 넘긴다.
- **임베딩 모델 교체는 되돌리기 어려운 결정이다.** ==모델이 다르면 벡터가 같은 공간에 있지 않으므로 기존 인덱스와 섞어 쓸 수 없고 전체 문서를 다시 임베딩해야 한다.== 재적재 시간과 비용을 미리 계산하고, 인덱스에 모델 이름과 차원을 기록해 둔다.
- **출처 표기는 나중에 붙이기 어렵다.** 조각 단위로 문서 식별자와 위치를 저장해 두지 않으면 인용을 붙이려는 순간 인덱스를 다시 만들어야 한다. 첫 적재부터 원본 경로와 오프셋을 함께 저장한다.

## 관련 글

- [임베딩과 벡터 유사도 검색](/notes/rag/embeddings-vector-search/)
- [벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택](/notes/rag/vector-databases/)
- [RAG 평가 — 검색 품질과 생성 품질을 따로 잰다](/notes/rag/rag-evaluation/)
