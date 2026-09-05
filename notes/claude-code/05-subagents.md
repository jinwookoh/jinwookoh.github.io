---
title: "서브에이전트 — 작업 분리와 병렬화"
series: claude-code
part: "확장"
order: 5
summary: "독립 컨텍스트와 도구 제한을 가진 서브에이전트로 탐색·검증 작업을 본 대화에서 떼어내는 방법을 정리한다."
tags: [Claude Code, subagent, context, agents, delegation]
sources: [https://code.claude.com/docs/en/sub-agents]
updated: 2026-09-05
---

서브에이전트가 없으면 모든 작업이 하나의 대화 안에서 벌어진다. 테스트 로그 수천 줄, 막다른 골목으로 끝난 탐색, 되돌린 편집 이력이 전부 같은 컨텍스트 창에 쌓인다. 정작 판단이 필요한 시점에는 처음 세운 계획이 요약 뒤로 밀려나 있다. 도구 권한도 대화 단위로만 걸리므로 "이 조사는 읽기만 하라"를 구조적으로 강제할 방법이 없다. 서브에이전트는 두 문제를 같은 수단으로 푼다. 작업을 별도 컨텍스트 창으로 밀어내고, 그 안에서만 통하는 도구·모델·권한 설정을 붙인다.

## 핵심 개념

서브에이전트는 YAML frontmatter가 붙은 마크다운 파일 하나다. 필수 필드는 `name`과 `description` 둘뿐이고 나머지는 선택이다. Spring에 대응시키면 `@Configuration` 클래스로 역할을 선언하는 것에 가깝다. 파일 자체가 정의이고 런타임이 이를 발견해 등록한다. `tools`·`disallowedTools`는 Spring Security의 인가 규칙, 컨텍스트 격리는 별도 트랜잭션 경계를 여는 것에 대응한다.

정의 위치는 우선순위를 가진다. 관리형 설정, `--agents` CLI 플래그, 프로젝트의 `.claude/agents/`, 사용자 홈의 `~/.claude/agents/`, 플러그인의 `agents/` 순이다. 같은 `name`이 여러 곳에 있으면 우선순위가 높은 쪽만 살아남으므로, 프로젝트 파일로 사용자 정의를 덮어쓰는 패턴이 성립한다.

호출은 두 갈래다. `description`을 근거로 모델이 알아서 위임하거나, `@agent-이름` 형태로 명시 호출한다. 세션 전체 기본값은 `claude --agent <이름>`이나 설정의 `agent` 키로 고정한다.

가장 중요한 성질은 무엇을 물려받고 무엇을 물려받지 않는가다. 서브에이전트는 CLAUDE.md 계층, git 상태 스냅숏, `skills`에 나열한 스킬 본문을 받는다. ==반대로 부모의 대화 기록은 전혀 받지 않으므로, 위임 프롬프트에 적지 않은 맥락은 서브에이전트에게 존재하지 않는다.== 예외는 fork로, `/subtask`로 만든 fork는 부모 대화 전체를 그대로 상속한다.

도구는 `tools`를 생략하면 부모 것을 상속한다. ==`disallowedTools`는 `tools` 목록보다 먼저 적용되므로 두 곳에 같은 도구를 적으면 항상 차단이 이긴다.== 모델은 `sonnet`·`opus`·`haiku`나 전체 ID, 또는 `inherit`을 쓴다. 지정이 없으면 호출 시 인자, 정의의 `model`, `CLAUDE_CODE_SUBAGENT_MODEL` 환경 변수, 본 대화 모델 순으로 결정된다.

## 코드

읽기 전용 조사 전용 에이전트를 프로젝트에 두는 정의다. 도구를 좁히고 값싼 모델로 내려 비용을 통제한다.

```markdown
<!-- .claude/agents/log-triage.md -->
---
name: log-triage
description: 테스트·빌드 로그를 훑어 실패 원인만 요약한다. 로그가 길어 본 대화를 오염시킬 때 사용한다.
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
model: haiku
permissionMode: plan
color: cyan
---

너는 로그 분류 담당이다. 전체 로그를 출력하지 말고
실패한 테스트 이름, 최초 원인 스택 프레임, 관련 파일 경로만 보고한다.
```

세션 한정으로 에이전트를 넘기려면 JSON을 CLI 인자로 준다. CI에서 파일을 두지 않고 쓰기 좋다.

```bash
claude --agents '{
  "log-triage": {
    "description": "테스트 로그에서 실패 원인만 추출",
    "prompt": "너는 로그 분류 담당이다. 실패 원인만 보고한다.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "haiku"
  }
}'
```

서브에이전트 모델을 조직 차원에서 고정하고 중첩 생성을 막는 설정이다.

```json
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1",
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
  }
}
```

## 실무에서 걸리는 지점

- 모든 서브에이전트의 `description`은 세션 시작 시 함께 로드되며 합계 15,000 토큰 한도를 가진다. 에이전트를 수십 개 쌓으면 한도 경고가 뜨고, 설명이 길수록 매 세션 고정 비용이 늘어난다.
- ==부모가 `bypassPermissions`나 `acceptEdits`로 돌고 있으면 서브에이전트의 `permissionMode`보다 부모 모드가 우선한다.== 읽기 전용으로 설계한 에이전트가 파일을 고칠 수 있다는 뜻이므로, 격리는 도구 목록으로 강제하는 편이 안전하다.
- 동시 실행은 기본 20개까지이고 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`로 조정한다. 중첩 생성은 기본 3단계까지 허용되므로, 각 층이 여러 자식을 띄우면 팬아웃이 빠르게 커진다.
- 내장 Explore와 Plan은 일회성이라 agent ID를 돌려주지 않고 재개할 수 없다. 이어서 물어야 하는 조사는 일반 에이전트로 만들고, `maxTurns`로 끊긴 경우 반환된 ID로 재개한다.
- 플러그인이 제공한 서브에이전트는 `hooks`, `mcpServers`, `permissionMode`를 무시한다. 플러그인 정의를 복사해 프로젝트로 옮길 때 이 필드가 조용히 사라진 것처럼 동작한다.
- 부모에게는 최종 보고만 돌아온다. 중간 산출물이 필요하면 서브에이전트가 파일로 남기도록 프롬프트에 명시해야 한다.

## 관련 글

- [스킬과 슬래시 커맨드](/notes/claude-code/skills-slash-commands/)
- [훅 — 도구 호출 전후 자동화](/notes/claude-code/hooks/)
- [설정과 권한 모델 — settings.json·permission mode](/notes/claude-code/settings-permissions/)
