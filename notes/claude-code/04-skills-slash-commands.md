---
title: "스킬과 슬래시 커맨드"
series: claude-code
part: "확장"
order: 4
summary: "스킬은 필요할 때만 컨텍스트에 들어오는 절차 묶음이며, 프런트매터가 호출 주체와 도구 권한을 결정한다"
tags: [Agent Skills, SKILL.md, slash commands, Claude Code, frontmatter]
sources: [https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/slash-commands]
updated: 2026-09-05
---

프로젝트 지식을 전부 `CLAUDE.md`에 몰아넣으면 매 세션 그 전부가 컨텍스트를 차지한다. 배포 절차 여덟 단계, 릴리스 노트 양식, 장애 대응 체크리스트는 한 달에 몇 번만 필요한데도 매번 로드되고, 파일이 길어질수록 정작 항상 지켜야 할 규칙이 묻힌다. 반대로 그 절차를 문서로만 두면 필요할 때마다 사람이 찾아 붙여 넣어야 한다. 스킬은 이 둘 사이를 메운다. 설명 한 줄만 상시 노출하고 본문은 실제로 필요할 때 읽어 들인다.

## 핵심 개념

스킬은 디렉터리 하나와 그 안의 `SKILL.md` 파일로 이뤄진다. 개인 스킬은 `~/.claude/skills/<이름>/SKILL.md`, 프로젝트 스킬은 `.claude/skills/<이름>/SKILL.md`에 둔다. 슬래시 커맨드 이름은 프런트매터의 `name`이 아니라 디렉터리 이름에서 나온다. 예전의 `.claude/commands/deploy.md` 형식도 그대로 동작하지만 지금은 스킬 체계로 통합됐고, 보조 파일과 프런트매터를 쓸 수 있는 쪽이 스킬이다.

동작의 핵심은 단계적 노출이다. 세션 시작 시 컨텍스트에 들어가는 것은 각 스킬의 `description`뿐이다. 대화 내용이 그 설명과 맞아떨어지면 모델이 스스로 본문을 읽어 오고, 사람이 `/스킬이름`을 입력해 직접 부를 수도 있다. Spring 개념으로 옮기면 `CLAUDE.md`가 모든 요청에 걸리는 공통 설정이라면 스킬은 조건이 맞을 때만 등록되는 `@Conditional` 빈에 가깝고, `allowed-tools`는 메서드 단위로 권한을 여는 `@PreAuthorize`에 대응한다.

프런트매터가 호출 방식을 결정한다. 자주 쓰는 필드는 다음과 같다.

| 필드 | 역할 |
|---|---|
| `description` | 언제 쓰는 스킬인지. 자동 호출 판단의 근거 |
| `disable-model-invocation` | `true`면 사람만 호출. 모델 컨텍스트에서 감춰진다 |
| `user-invocable` | `false`면 모델만 호출. `/` 메뉴에서 감춰진다 |
| `allowed-tools` | 이 스킬이 도는 동안 승인 없이 쓸 도구 |
| `arguments` | 이름 있는 위치 인자. 본문에서 `$이름`으로 참조 |
| `context: fork` | 별도 서브에이전트 컨텍스트에서 실행 |

인자는 `$ARGUMENTS`로 전부 받거나 `$0`, `$1` 같은 위치 지정자로 받는다. 본문에 백틱과 느낌표를 조합한 형태로 셸 명령을 적어 두면 스킬이 호출되는 시점에 한 번 실행되고 그 출력이 자리를 대신한다. 모델은 명령 자체를 보지 못하고 결과만 본다.

## 코드

지식형 스킬은 프런트매터 두 줄과 규칙 목록이면 충분하다. 대화가 API 작업으로 흘러가면 자동으로 들어온다.

```markdown
---
name: api-conventions
description: 이 저장소의 REST API 설계 규칙. 엔드포인트를 추가하거나 고칠 때 적용한다
---

# API 규칙
- URL 경로는 kebab-case, JSON 속성은 camelCase
- 목록 응답에는 반드시 페이지네이션을 붙인다
- 버전은 경로에 넣는다 (/v1/, /v2/)
```

절차형 스킬은 사람이 직접 부르게 막아 두고 필요한 도구만 사전 승인한다. `context: fork`를 주면 본 대화 컨텍스트를 오염시키지 않고 별도 컨텍스트에서 돈다.

```markdown
---
name: fix-issue
description: GitHub 이슈 번호를 받아 원인을 찾고 수정한 뒤 PR을 연다
arguments: [issue]
disable-model-invocation: true
allowed-tools: Bash(gh *) Bash(git add *) Bash(git commit *)
context: fork
---

이슈 $issue 를 수정한다.

1. `gh issue view $issue` 로 내용을 확인한다
2. 관련 파일을 찾아 원인을 특정한다
3. 실패를 재현하는 테스트를 먼저 쓴다
4. 수정하고 테스트와 타입 체크를 통과시킨다
5. 커밋 후 PR을 연다
```

`/fix-issue 1234`처럼 호출한다. 저비용으로 감출 스킬은 설정에서 상태를 낮춘다.

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  },
  "disableSkillShellExecution": true
}
```

## 실무에서 걸리는 지점

- **설명 예산에는 상한이 있다.** ==`description`과 `when_to_use`를 합쳐 스킬당 1,536자를 넘으면 잘린다.== 전체 스킬 목록은 모델 컨텍스트의 1퍼센트를 예산으로 쓰고, 넘치면 사용 빈도가 낮은 스킬부터 설명이 통째로 빠져 자동 호출이 조용히 멈춘다.
- **본문은 세션 안에서 다시 읽히지 않는다.** ==한 번 호출된 스킬 내용은 메시지로 컨텍스트에 남고 이후 턴에서 파일을 다시 읽지 않으므로, 같은 세션에서 `SKILL.md`를 고쳐도 반영되지 않는다.== 편집했다면 새 세션에서 확인한다.
- **도구 사전 승인은 곧 풀린다.** `allowed-tools`로 준 권한은 그 턴 동안만 유효하고 ==사용자가 다음 메시지를 보내는 순간 해제된다.== 여러 턴에 걸친 자동화를 기대하면 중간에 승인 프롬프트를 만난다.
- **동적 주입 실패는 호출 전체를 죽인다.** 본문에 넣은 셸 명령이 실패하면 스킬 호출 자체가 중단된다. `gh`처럼 인증에 의존하는 명령을 쓸 때는 실패 가능성을 감안하고, 설정에서 `disableSkillShellExecution`으로 기능을 끌 수 있다는 점도 알아 둔다.
- **부수 효과가 있는 절차는 자동 호출을 막는다.** 배포, 커밋, 메시지 전송처럼 되돌리기 어려운 작업에는 `disable-model-invocation: true`를 붙여 사람이 명시적으로 부를 때만 돌게 한다.
- **분량은 500줄 아래로 유지한다.** 긴 참조 자료는 같은 디렉터리의 별도 파일로 내리고 `SKILL.md`에서 링크만 걸어 두면 모델이 필요할 때만 읽는다. 현재 인식되는 스킬 목록은 `/skills`로, 비용과 사용 현황은 `/skill-doctor`로 확인한다.

## 관련 글

- [CLAUDE.md와 메모리 — 프로젝트 컨텍스트 관리](/notes/claude-code/claude-md-memory/)
- [서브에이전트 — 작업 분리와 병렬화](/notes/claude-code/subagents/)
- [플러그인 — 마켓플레이스와 추천 플러그인](/notes/claude-code/plugins/)
