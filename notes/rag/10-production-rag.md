---
title: "프로덕션 RAG — 캐싱·비용·보안·에이전틱 패턴"
series: rag
part: "운영"
order: 10
summary: "프롬프트 캐싱과 검색 파라미터로 비용을 잡고 권한·인젝션을 막으며 에이전틱 검색을 예산 안에 가두는 방법을 정리한다"
tags: [RAG, Prompt Caching, GraphRAG, Cost, Security]
sources: [https://platform.openai.com/docs/guides/retrieval, https://docs.claude.com/en/docs/build-with-claude/prompt-caching, https://microsoft.github.io/graphrag/]
updated: 2026-09-05
---

프로토타입에서 잘 돌던 RAG가 운영에 올라가면 성격이 달라진다. 요청마다 시스템 프롬프트와 문서 수만 토큰을 새로 밀어 넣어 청구서가 예상의 몇 배로 나오고, 검색과 생성이 직렬로 붙어 p95 지연이 초 단위로 늘어난다. 더 심각한 쪽은 조용히 새는 문제다. 사내 문서 인덱스에 권한 개념이 없어 다른 팀 문서가 답변에 인용되거나, 크롤링한 문서에 박힌 문장이 시스템 지시를 덮어써도 로그만 봐서는 알아채지 못한다. 프로덕션 RAG의 작업 목록은 정확도 개선이 아니라 캐싱·비용·보안·제어 흐름 쪽에 있다.

## 핵심 개념

캐싱은 세 층으로 나뉜다. 가장 효과가 큰 것은 프롬프트 캐싱이다. Anthropic API는 `cache_control`을 `ephemeral`로 표시한 블록까지의 프리픽스를 캐시하고, 이후 요청이 같은 프리픽스로 시작하면 그 구간을 읽기 요금으로 처리한다. 프리픽스 순서는 `tools`, `system`, `messages`이며 앞 단계가 바뀌면 뒤도 함께 무효화된다. TTL은 기본 5분이고 1시간을 선택할 수 있는데, 쓰기 요금이 각각 기본 입력의 1.25배와 2배, 읽기는 0.1배 수준이다. 명시적 중단점은 요청당 최대 4개다. 아래 두 층은 애플리케이션이 직접 만든다. 질의 텍스트를 정규화해 해시로 임베딩 결과를 재사용하는 임베딩 캐시, 유사한 질의에 지난 응답을 그대로 돌려주는 의미 캐시다.

비용은 검색 파라미터에서 결정된다. OpenAI 벡터 스토어의 기본 청킹은 800 토큰 청크에 400 토큰 겹침이고, file search는 기본 10건, 최대 50건까지 돌려준다. 반환 건수를 늘리면 컨텍스트 토큰이 선형으로 늘고 생성 지연도 같이 오른다. `score_threshold`로 점수가 낮은 청크를 잘라 내고 속성 필터로 후보를 먼저 좁히는 편이 top-k를 키우는 것보다 싸다.

보안의 핵심은 필터를 어디에 거느냐다. 접근 제어는 검색 쿼리 자체에 들어가야 한다. 문서마다 테넌트·부서·기밀 등급을 메타데이터로 붙이고 벡터 검색 조건에 결합한다. Spring 감각으로는 `@PreAuthorize` 같은 메서드 단위 검사보다 Hibernate 필터나 행 수준 보안에 가깝다. 프롬프트 캐싱은 `@Cacheable`이 아니라 프리픽스가 고정된 구간에만 걸리는 캐시라고 보면 된다.

에이전틱 패턴은 한 번 검색하고 한 번 답하는 구조를 넘어선다. GraphRAG는 커뮤니티 요약을 훑는 global search, 특정 개체와 이웃을 파고드는 local search, 둘을 섞은 DRIFT search를 나눠 두고 질문 성격에 따라 경로를 고른다. 라우팅이든 도구 호출 루프든 공통 요구는 같다. 반복 횟수와 토큰 예산에 상한을 두고, 매 단계 근거를 남긴다.

## 코드

문서와 지시를 시스템 프롬프트에 고정하고 마지막 정적 블록에 중단점을 건다. 질문은 중단점 뒤에 둔다.

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function ask(corpus: string, question: string) {
  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: '너는 사내 문서만 근거로 답한다.' },
      {
        type: 'text',
        text: corpus,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: question }],
  });

  const u = res.usage;
  console.log({
    write: u.cache_creation_input_tokens,
    read: u.cache_read_input_tokens,
    fresh: u.input_tokens,
  });
  return res;
}
```

pgvector 검색에서 권한 조건을 SQL 술어로 직접 결합한다. 인덱스를 타도록 필터 컬럼에 별도 인덱스를 둔다.

```sql
SELECT id, content, 1 - (embedding <=> $1) AS score
FROM chunks
WHERE tenant_id = $2
  AND acl_group = ANY($3)
  AND classification <= $4
ORDER BY embedding <=> $1
LIMIT 20;
```

에이전틱 검색 루프는 반복과 토큰 예산을 하드 리밋으로 감싼다.

```typescript
type Budget = { maxSteps: number; maxTokens: number };

export async function agenticSearch(
  question: string,
  step: (q: string) => Promise<{ done: boolean; next: string; tokens: number }>,
  budget: Budget,
) {
  let used = 0;
  let query = question;
  for (let i = 0; i < budget.maxSteps; i++) {
    const r = await step(query);
    used += r.tokens;
    if (r.done) return { answer: r.next, steps: i + 1, used };
    if (used >= budget.maxTokens) break;
    query = r.next;
  }
  throw new Error(`budget exhausted: steps or ${used} tokens`);
}
```

## 실무에서 걸리는 지점

캐시 중단점 위치가 절반이다. ==타임스탬프나 검색 결과처럼 요청마다 달라지는 블록에 `cache_control`을 걸면 프리픽스 해시가 매번 달라져 히트가 한 번도 나지 않고 1.25배 쓰기 요금만 계속 낸다.== 중단점은 요청 사이에 동일하게 유지되는 마지막 블록에 둔다.

캐시가 안 걸려도 오류가 나지 않는다. ==모델별 최소 캐시 토큰 수에 못 미치면 캐싱이 조용히 생략되므로 `cache_read_input_tokens` 값을 로그로 남겨 실제 적중을 확인해야 한다.== 도구 정의를 하나만 수정해도 그 뒤 시스템과 메시지까지 전부 무효화된다는 점도 배포 단위 설계에 반영한다.

권한 필터를 검색 뒤에 거는 구현은 이미 늦다. ==모델이 본 문서는 인용하지 않아도 요약과 추론에 스며들므로, 후처리 필터링은 응답 유출을 막지 못한다.== 필터는 반드시 벡터 검색 쿼리 안에서 평가한다.

검색된 문서는 신뢰할 수 없는 입력이다. 문서 본문에 삽입된 지시문이 시스템 프롬프트를 무시하도록 유도할 수 있으므로 컨텍스트는 데이터 영역으로 명확히 구분해 넣고, 출력 쪽에서도 도구 호출과 외부 링크를 검증한다.

의미 캐시의 유사도 임계값은 낮게 잡으면 사고가 된다. 질문 두 개가 임베딩 공간에서 가까워도 조건 한 단어가 다르면 답이 완전히 달라지는데, 캐시는 그 차이를 구분하지 못한 채 지난 답을 돌려준다. 캐시 키에 테넌트와 권한 범위를 반드시 포함한다.

## 관련 글

- [RAG 평가 — 검색 품질과 생성 품질을 따로 잰다](/notes/rag/rag-evaluation/)
- [GraphRAG — 지식 그래프 기반 검색 증강](/notes/rag/graph-rag/)
- [벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택](/notes/rag/vector-databases/)
