---
title: "Agent SDK와 headless 모드 — CI 자동화"
series: claude-code
part: "운영"
order: 9
summary: "claude -p 와 Agent SDK로 사람이 지켜보지 않는 파이프라인 안에 에이전트를 넣는 방법"
tags: [Claude Code, Agent SDK, headless, GitHub Actions, CI]
sources: [https://code.claude.com/docs/en/sdk, https://code.claude.com/docs/en/github-actions]
updated: 2026-09-05
---

대화형 세션은 사람이 화면 앞에 있다는 전제 위에서 돈다. 파일을 쓰기 전에 물어보고, 결과는 사람이 읽으라고 만든 텍스트로 나온다. 같은 판단을 PR마다 반복하고 싶으면 이 전제가 그대로 걸림돌이 된다. 아무도 승인 프롬프트에 답하지 않으니 실행이 멈추고, 답이 나와도 스크립트가 읽을 형식이 아니다. 비대화형 모드와 Agent SDK는 권한 결정을 실행 전에 확정하고 출력을 기계가 읽을 형태로 바꾼다.

## 핵심 개념

`claude -p "프롬프트"` 는 세션 UI 없이 한 번 실행하고 결과를 표준 출력으로 내보낸다. `--output-format` 은 `text`, `json`, `stream-json` 세 가지를 받는다. `json` 은 본문이 `result` 필드에 담긴 객체 하나를 돌려주고 `session_id`, `total_cost_usd` 같은 메타데이터가 함께 온다. 응답 모양까지 고정하려면 `--json-schema` 로 JSON Schema를 넘긴다. 결과는 `structured_output` 에 들어간다. 성공하면 종료 코드 0, 실패하면 0이 아니므로 셸에서 분기할 수 있다.

권한은 실행 전에 정한다. `--allowedTools` 는 도구 이름이나 `Bash(git diff *)` 같은 규칙을 받고, 별표 앞의 공백까지 포함해야 접두 일치가 의도대로 걸린다. 세션 전체의 기준선을 바꾸려면 `--permission-mode` 에 `auto`, `acceptEdits`, `dontAsk` 중 하나를 준다. 답할 사람이 아예 없는 스케줄 작업이면 `--permission-prompts none` 을 붙여 승인 대기 자체를 없앤다.

`--bare` 는 훅·스킬·커스텀 커맨드·서브에이전트·플러그인·MCP 서버·CLAUDE.md 의 자동 탐색을 건너뛴다. 어느 머신에서 돌려도 같은 입력이 들어가야 하는 CI에서는 이쪽이 권장 모드다. 대신 bare 모드는 OAuth 자격증명과 키체인을 읽지 않으므로 `ANTHROPIC_API_KEY` 를 환경 변수로 넣어야 한다.

Agent SDK는 같은 에이전트 루프를 라이브러리로 제공한다. TypeScript는 `@anthropic-ai/claude-agent-sdk`, Python도 별도 패키지가 있다. `query({ prompt, options })` 가 비동기 이터레이터를 돌려주고, `options` 로 `allowedTools`, `permissionMode`, `maxTurns`, `cwd`, `model`, `mcpServers`, `hooks`, `agents`, `resume`, `forkSession`, `settingSources`, `canUseTool` 을 넘긴다. 다른 언어에서 쓰려면 CLI를 서브프로세스로 띄우고 `-p` 와 `--output-format json` 을 붙인다. Java/Spring 감각으로 보면 Agent SDK는 애플리케이션에 임베드하는 라이브러리, `claude -p` 는 `ProcessBuilder` 로 부르는 외부 프로세스에 가깝다. 도구 호출마다 실행 여부를 결정하는 `canUseTool` 콜백은 요청 단위로 인가를 판단하는 시큐리티 필터, 어떤 설정 파일을 읽을지 고르는 `settingSources` 는 프로파일별 프로퍼티 소스 선택에 대응한다.

GitHub에서는 `anthropics/claude-code-action@v1` 이 이 CLI를 감싼다. `/install-github-app` 이 앱 설치와 시크릿 등록, 워크플로 PR 생성까지 처리한다. `prompt` 입력이 없으면 `@claude` 멘션을 기다리는 대화형 모드로, 있으면 이벤트가 오는 즉시 도는 자동 모드로 동작한다. CLI 인자는 `claude_args` 로 그대로 전달된다.

## 코드

빌드 로그를 파이프로 넣고 결과를 JSON으로 받아 `jq` 로 꺼낸다. 파일을 만지지 않으므로 `Read` 만 허용한다.

```bash
cat build-error.txt | claude --bare -p "이 빌드 실패의 근본 원인만 요약해라" \
  --allowedTools "Read" \
  --output-format json | jq -r '.result'

# 세션 ID를 잡아 두면 이어서 물어볼 수 있다
session_id=$(claude -p "리뷰를 시작해라" --output-format json | jq -r '.session_id')
claude -p "데이터베이스 쿼리에 집중해라" --resume "$session_id"
```

같은 루프를 라이브러리로 부르는 쪽이다. `query()` 는 메시지를 순서대로 흘려보내고 마지막에 `result` 타입 메시지가 온다.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "src/auth 의 테스트를 돌리고 실패를 고쳐라",
  options: {
    cwd: process.cwd(),
    maxTurns: 8,
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
  },
})) {
  if (message.type === "result") {
    console.log(message);
  }
}
```

PR이 열릴 때마다 리뷰 스킬을 돌리는 워크플로다. `id-token: write` 는 액션의 기본 GitHub App 인증에 필요하다.

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      id-token: write
    steps:
      - uses: actions/checkout@v6
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: "변경된 diff를 리뷰하고 정확성 문제만 보고해라"
          claude_args: "--max-turns 8 --allowedTools Read,Grep"
```

## 실무에서 걸리는 지점

- ==`--bare` 없이 `-p` 를 돌리면 그 디렉터리의 `.claude/settings.json` 훅과 `.mcp.json` 서버가 신뢰 대화상자 없이 실행된다.== 포크에서 온 코드를 체크아웃한 러너에서는 이 경로가 그대로 공격면이 되므로 CI에서는 `--bare` 를 기본으로 두고 필요한 것만 플래그로 명시한다.
- `-p` 의 시작 권한 모드는 어느 플랜에서도 Manual이다. `--allowedTools` 나 `--permission-mode` 를 주지 않으면 편집과 명령이 조용히 거부된 채 "하지 못했다"는 요약만 돌아온다.
- ==워크플로에 `github_token: ${{ secrets.GITHUB_TOKEN }}` 을 넘기면 그 토큰으로 만든 커밋이 다른 워크플로를 트리거하지 않는다.== 이 입력을 생략해 Claude GitHub App으로 인증하게 두면 CI가 정상적으로 돈다.
- 한 실행이 GitHub Actions 분과 토큰을 동시에 태운다. `claude_args` 의 `--max-turns`, 잡 단위 `timeout-minutes`, `concurrency` 를 함께 걸어 폭주를 막는다.
- 표준 입력 파이프는 10MB에서 잘린다. 그보다 큰 입력은 파일로 두고 경로만 프롬프트에 넣는다.

## 관련 글

- [설정과 권한 모델 — settings.json·permission mode](/notes/claude-code/settings-permissions/)
- [서브에이전트 — 작업 분리와 병렬화](/notes/claude-code/subagents/)
- [실무 워크플로 — 계획·TDD·비용 관리](/notes/claude-code/workflows-best-practices/)
