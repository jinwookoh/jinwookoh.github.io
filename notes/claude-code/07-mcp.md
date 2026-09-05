---
title: "MCP 서버 연동 — 외부 도구와 데이터 연결"
series: claude-code
part: "확장"
order: 7
summary: "이슈 트래커·DB·사내 API를 표준 프로토콜로 붙이는 MCP의 전송·스코프·네이밍 규약과 운영상 한도를 정리한다."
tags: [Claude Code, MCP, stdio, OAuth, .mcp.json]
sources: [https://code.claude.com/docs/en/mcp, https://modelcontextprotocol.io/docs/getting-started/intro]
updated: 2026-09-05
---

에이전트가 리포지터리 밖을 못 보면 할 수 있는 일이 좁아진다. 이슈 번호를 주면서 내용은 복사해 붙여 넣어야 하고, 스키마를 물으면 덤프를 떠서 넘겨야 한다. 각 연동을 직접 만들면 클라이언트마다 어댑터를 새로 쓰게 되고, 인증·타임아웃·출력 크기 제한 같은 문제를 매번 다시 푼다. MCP는 이 연결부를 표준화한다. 도구를 한 번 서버로 구현해 두면 이를 지원하는 클라이언트 어디서든 같은 방식으로 붙는다.

## 핵심 개념

MCP는 JSON-RPC 기반의 개방형 프로토콜이고 구조는 클라이언트와 서버로 나뉜다. 서버는 세 가지를 노출한다. 모델이 호출하는 tools, 참조 대상인 resources, 재사용 가능한 prompts다. Spring 감각으로 보면 서버는 도구를 노출하는 원격 서비스이고, `.mcp.json`은 외부 연동을 선언하는 `application.yml`에 해당한다. stdio와 HTTP 중 어느 전송을 고르는지는 라이브러리를 임베드할지 REST로 호출할지 정하는 문제와 같다.

전송은 네 가지다. 로컬 프로세스를 띄우는 `stdio`, 원격에 권장되는 `http`, 폐기 경로에 들어간 `sse`, 그리고 JSON 등록으로만 쓰는 `ws`다. 원격 서비스는 `http`, 로컬 CLI 래퍼는 `stdio`가 기본 선택이다.

스코프가 설정 위치와 공유 범위를 정한다. 기본값인 `local`은 `~/.claude.json`에 프로젝트별로 저장되어 공유되지 않는다. `project`는 저장소 루트의 `.mcp.json`에 들어가 버전 관리로 팀과 공유된다. `user`는 모든 프로젝트에서 보인다. 같은 이름이 겹치면 local, project, user, 플러그인 제공 서버, claude.ai 커넥터 순으로 우선한다.

이름 규칙은 고정되어 있다. 도구는 `mcp__<서버>__<도구>`로 노출되므로 권한 규칙이나 훅 matcher에서 이 형태로 지정한다. 리소스는 `@<서버>:<프로토콜>://<경로>`로 참조하고, 서버가 제공하는 프롬프트는 `/mcp__<서버>__<프롬프트>` 슬래시 커맨드가 된다.

인증은 OAuth가 1차 경로다. 세션 안에서 `/mcp`로 서버를 골라 브라우저 로그인을 하거나 `claude mcp login <이름>`을 쓰고, SSH 환경에서는 `--no-browser`를 붙인다. 고정 토큰은 `--header`로, 동적으로 발급받는 토큰은 JSON을 stdout에 뱉는 `headersHelper` 스크립트로 넘긴다.

## 코드

원격 HTTP 서버와 로컬 stdio 서버를 등록하는 명령이다. stdio는 `--` 뒤부터가 서버 실행 명령이다.

```bash
# 원격 HTTP 서버 + 고정 토큰, 팀 공유용 project 스코프
claude mcp add --transport http --scope project github \
  https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer $GITHUB_PAT"

# 로컬 stdio 서버 — `--` 뒤부터가 서버 실행 명령
claude mcp add --transport stdio db -- npx -y @bytebase/dbhub \
  --dsn "postgresql://readonly:pass@analytics.internal:5432/app"

claude mcp list
claude mcp get github
```

저장소에 커밋하는 `.mcp.json`이다. 자격 증명은 값을 박지 않고 환경 변수 확장으로 넘긴다.

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.internal.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" },
      "timeout": 60000
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

쓰지 않는 서버를 끄고 출력 상한을 올리는 설정이다. 도구 정의도 컨텍스트를 먹으므로 안 쓰는 서버는 꺼 두는 편이 낫다.

```json
{
  "disabledMcpServers": ["playwright"],
  "env": { "MAX_MCP_OUTPUT_TOKENS": "50000" }
}
```

## 실무에서 걸리는 지점

- ==프로젝트나 플러그인이 제공한 서버는 이름에 TOKEN·SECRET·PASSWORD·KEY·AUTH가 들어간 환경 변수가 제거된 채 기동한다.== 자격 증명을 `env`로 흘려 넣는 설정은 로컬에서만 되고 공유 설정에서는 조용히 인증 실패로 끝나므로, 파일이나 자격 증명 저장소에서 읽게 만든다.
- stdio 등록에서 `--`를 빠뜨리면 서버 인자를 CLI 자체 옵션으로 파싱하려다 실패한다. `--port`나 `--dsn` 같은 인자가 있으면 반드시 구분자를 넣는다.
- ==도구 결과는 기본 25,000 토큰에서 잘리고 10,000 토큰에서 경고가 뜬다.== 전체 스키마 조회처럼 큰 응답이 필요하면 `MAX_MCP_OUTPUT_TOKENS`를 올리거나, 서버 쪽 `tools/list` 응답에 `_meta`의 `anthropic/maxResultSizeChars`를 도구별로 지정한다. 도구당 상한은 500,000자다.
- ==외부 콘텐츠를 가져오는 서버는 그 콘텐츠가 그대로 프롬프트 인젝션 경로가 된다.== 서드파티 서버는 붙이기 전에 신뢰 여부를 판단하고, `.mcp.json`의 프로젝트 서버는 최초 사용 시 승인 절차를 거친다. 비대화형 실행에서는 `--strict-mcp-config`나 워크스페이스 신뢰 설정이 필요하다.
- `timeout`은 밀리초 단위이고 1000 미만 값은 무시된다. 기동 자체가 느린 서버는 `MCP_TIMEOUT`으로 시작 대기 시간을 따로 늘린다.

## 관련 글

- [훅 — 도구 호출 전후 자동화](/notes/claude-code/hooks/)
- [플러그인 — 마켓플레이스와 추천 플러그인](/notes/claude-code/plugins/)
- [설정과 권한 모델 — settings.json·permission mode](/notes/claude-code/settings-permissions/)
