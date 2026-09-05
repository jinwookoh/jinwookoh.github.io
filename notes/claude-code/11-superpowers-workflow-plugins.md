---
title: "Superpowers — 워크플로 스킬 플러그인과 비슷한 도구들"
series: claude-code
part: "확장"
order: 11
summary: "설계·계획·TDD·검증 순서를 사람의 말 대신 자동 트리거 스킬로 고정하는 플러그인의 동작 원리와 대가"
tags: [Claude Code, Superpowers, plugin, skills, TDD]
sources: [https://github.com/obra/superpowers, https://blog.fsck.com/2025/10/09/superpowers/, https://code.claude.com/docs/en/plugins]
updated: 2026-09-05
---

기능 하나를 요청하면 코딩 에이전트는 대개 곧장 파일을 열고 코드를 쓴다. 요구사항은 대화 몇 줄로만 오가서 설계 문서가 남지 않고, 테스트는 구현이 끝난 뒤에 붙고, 다 됐다는 보고는 실행 결과가 아니라 추측 위에 선다. 그래서 사람이 매번 설계부터 정리하라고, 테스트를 먼저 쓰라고, 실제로 돌려 보라고 말로 통제하게 된다. 이 통제는 세션이 바뀌거나 컨텍스트가 압축되는 순간 사라진다. Superpowers는 그 통제를 반복 지시 대신 플러그인이 주입하는 규칙으로 고정하려는 시도다.

## 핵심 개념

Superpowers는 Jesse Vincent와 Prime Radiant가 만들어 MIT 라이선스로 공개한 Claude Code 플러그인이다. 특정 작업을 대신 해 주는 도구 묶음이 아니라 개발 방법론 자체를 스킬 라이브러리로 포장해 배포한다. 담긴 스킬은 열네 개다. 테스트 계열에 `test-driven-development`, 디버깅 계열에 `systematic-debugging`과 `verification-before-completion`, 메타 계열에 `writing-skills`와 `using-superpowers`가 있고, 나머지 아홉 개가 `brainstorming`부터 `finishing-a-development-branch`까지의 협업 계열이다.

주입 경로는 플러그인 루트의 `hooks/hooks.json`에 정의된 SessionStart 훅 하나다. matcher가 `startup|clear|compact`라서 세션 시작뿐 아니라 대화를 비웠을 때와 컨텍스트가 압축된 뒤에도 다시 돈다. 이 훅이 `using-superpowers` 부트스트랩을 대화 맨 앞에 얹고, 그 스킬이 작업 전에 관련 스킬을 먼저 호출하라는 규칙을 세운다. 개별 스킬은 슬래시 커맨드가 아니라 `SKILL.md` frontmatter의 `description` 문장을 모델이 읽고 스스로 고르는 방식으로 걸린다.

Java/Spring으로 옮기면 SessionStart 부트스트랩은 매 요청 앞단에 공통 정책을 끼우는 서블릿 `Filter`, description으로 스킬이 선택되는 구조는 `@Conditional`에 가깝다. 스킬 라이브러리 전체는 위키의 코딩 컨벤션을 ArchUnit 규칙처럼 강제 가능한 형태로 바꿔 놓은 것에 해당한다.

문서화된 기본 워크플로는 일곱 단계다. `brainstorming`이 질문으로 요구사항을 좁혀 설계 문서를 남기고, `using-git-worktrees`가 별도 브랜치에 격리된 작업 공간을 만들어 테스트 기준선을 확인한다. `writing-plans`는 2~5분짜리 작업으로 쪼갠 계획을 쓰고, `subagent-driven-development` 또는 `executing-plans`가 작업마다 새 서브에이전트를 붙여 실행한다. 구현 중에는 `test-driven-development`가 RED-GREEN-REFACTOR를 강제하고, `requesting-code-review`가 계획 대비 결과를 심각도별로 보고하며, `finishing-a-development-branch`가 병합·PR·폐기 중 선택을 받아 정리한다.

### 비슷한 도구와의 경계

공식 마켓플레이스에도 워크플로 계열 플러그인이 있지만 성격이 다르다. `commit-commands`는 커밋과 PR 생성, `pr-review-toolkit`은 PR 리뷰 전용 에이전트, `security-guidance`는 변경마다 취약점 검토, `plugin-dev`는 플러그인 제작 도구를 제공한다. 이쪽은 작업을 수행하는 도구이고 호출 시점도 대체로 사용자가 정한다. Superpowers는 그 앞단에서 작업 순서 자체를 정하는 프로세스 계층이라 둘이 경쟁 관계는 아니다. 저자가 릴리스 글에서 인접 사례로 든 Microsoft Amplifier도 같은 방향의 실험이다.

## 코드

Claude Code 설치 경로는 두 가지다. 공식 마켓플레이스는 처음 실행 시 자동 등록되므로 설치 명령 한 줄이면 되고, 저자가 운영하는 마켓플레이스를 쓰면 관련 플러그인을 함께 받는다.

```bash
# 공식 마켓플레이스
/plugin install superpowers@claude-plugins-official

# Superpowers 마켓플레이스
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

주입은 플러그인이 들고 있는 훅 정의 하나로 끝난다. 직접 만든 플러그인에 같은 방식을 쓰려면 이 형태를 그대로 따라가면 된다.

```json
// hooks/hooks.json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "shell": "bash",
            "async": false
          }
        ]
      }
    ]
  }
}
```

자동 트리거의 실체는 frontmatter의 `description` 한 문장이다. 언제 써야 하는지를 조건문처럼 적어 두면 모델이 그 문장을 근거로 스킬을 고른다.

```markdown
---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development

먼저 실패하는 테스트를 쓰고, 실패를 눈으로 확인하고,
통과시킬 최소 구현만 쓴다. 실패를 보지 않았다면
그 테스트가 옳은 것을 검사하는지 알 수 없다.
```

## 실무에서 걸리는 지점

`using-superpowers`는 명확화 질문을 던지기 전에도 스킬 확인을 먼저 하라고 요구한다. 규모가 있는 작업에서는 흐름이 안정되지만, 한 줄짜리 수정에도 설계 단계가 먼저 붙어 체감 반응이 느려질 수 있다. 짧은 작업이 잦은 저장소라면 켜 둘 범위를 스코프로 나누는 편이 낫다고 본다.

==`test-driven-development` 스킬은 테스트보다 먼저 작성된 구현 코드를 삭제하도록 지시한다.== 문서에 명시된 동작이므로, 이미 손으로 짜 둔 초안이 있는 상태에서 이 흐름에 진입하면 그 초안이 사라질 수 있다. 커밋되지 않은 작업이 있다면 먼저 커밋하거나 별도 브랜치로 빼 두고 시작한다.

==컨텍스트가 압축될 때 부트스트랩을 다시 넣어 주는 것은 SessionStart 훅의 `compact` matcher이므로, 이 이벤트가 없는 실행 환경에서는 긴 세션 도중 스킬이 조용히 멈춘다.== 저자도 특정 하니스에서는 압축 이후 부트스트랩이 유실되니 새 세션을 시작하라고 안내한다. 스킬 호출이 갑자기 사라지면 이 지점을 먼저 의심한다.

스킬 설명 문장은 매 턴 컨텍스트에 올라간다. `/plugin` 화면의 Discover 탭이 설치 전 컨텍스트 비용 추정치를, Stats 탭이 스킬별 사용 빈도를 보여 주므로 쓰지 않는 스킬이 비용만 먹고 있는지 확인할 근거는 있다.

==플러그인 자동 업데이트는 세션 시작 후 최대 10분의 임의 지연을 두고 백그라운드에서 돌며, 실행 중인 세션은 시작 시점에 로드한 버전을 계속 쓴다.== 갱신 알림을 받으면 `/reload-plugins`를 돌려야 그 세션에 반영된다. 프로젝트 `CLAUDE.md`에 자체 개발 절차를 적어 둔 경우 스킬 지침과 어긋날 수 있으니, 중복되는 절차 규칙은 한쪽으로 정리해 두는 편이 안전하다고 판단한다.

## 관련 글

- [플러그인 — 마켓플레이스와 추천 플러그인](/notes/claude-code/plugins/)
- [스킬과 슬래시 커맨드](/notes/claude-code/skills-slash-commands/)
- [훅 — 도구 호출 전후 자동화](/notes/claude-code/hooks/)
