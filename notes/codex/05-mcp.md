---
title: "MCP 서버 연동"
series: codex
part: "확장"
order: 5
summary: "Codex가 저장소 밖 시스템을 도구로 끌어오는 통로인 MCP를 config.toml 설정과 승인·타임아웃 기준으로 정리한다"
tags: [Codex, MCP, config.toml, JSON-RPC, stdio]
sources: [https://developers.openai.com/codex/mcp, https://modelcontextprotocol.io/docs/getting-started/intro]
updated: 2026-09-05
---

에이전트가 기본으로 닿을 수 있는 범위는 셸과 작업 디렉터리의 파일뿐이다. 이슈 트래커의 티켓 본문, 디자인 도구의 컴포넌트 스펙, 스테이징 DB의 실제 스키마처럼 저장소 밖에 있는 맥락은 사람이 매번 복사해 프롬프트에 붙여야 한다. 붙여넣기를 줄이려고 래퍼 스크립트를 만들면 인증 처리와 출력 포맷을 도구마다 다시 설계하게 되고, 그 스크립트를 언제 어떤 인자로 불러야 하는지까지 프롬프트로 다시 설명해야 한다. MCP는 이 연결을 프로토콜 하나로 규격화해, 서버를 등록해 두면 Codex가 사용 가능한 도구 목록과 각 도구의 입력 스키마를 스스로 읽어 가게 만든다.

## 핵심 개념

MCP(Model Context Protocol)는 AI 애플리케이션과 외부 시스템을 잇는 개방형 표준이고, 메시지 규약으로 JSON-RPC 2.0을 쓴다. 참여자는 셋으로 나뉜다. 호스트는 AI 애플리케이션 자체이고, 호스트는 연결할 서버마다 클라이언트를 하나씩 만들며, 서버는 맥락과 실행 능력을 제공하는 프로그램이다. Codex는 호스트에 해당하고 설정에 적힌 서버 수만큼 클라이언트가 생긴다.

프로토콜은 데이터 계층과 전송 계층으로 갈린다. 데이터 계층은 서버가 무엇을 제공하는지를 정의하며, 서버가 노출하는 핵심 프리미티브는 도구·리소스·프롬프트 셋이다. 도구는 에이전트가 호출해 실제 동작을 일으키는 함수, 리소스는 읽어서 맥락으로 쓰는 데이터, 프롬프트는 재사용 가능한 지시 템플릿이다. 클라이언트는 `tools/list` 같은 목록 조회로 사용 가능한 것을 발견하고 `tools/call`로 실행한다. 목록 조회가 런타임에 일어나므로 서버 쪽에서 도구를 늘리면 설정을 고치지 않아도 반영된다.

전송 계층은 두 가지다. stdio는 서버를 로컬 프로세스로 띄워 표준 입출력으로 주고받고, Streamable HTTP는 원격 주소에 붙어 베어러 토큰이나 OAuth로 인증한다. Spring에 대응시키면 서버 등록은 외부 시스템 어댑터를 빈으로 올리는 일에 가깝고, `tools/list`는 호출 가능한 오퍼레이션 목록을 컴파일 타임 인터페이스가 아니라 런타임 레지스트리에서 읽어 오는 구조에 해당한다. 인터페이스가 실행 시점에 정해지므로, 어떤 도구까지 노출할지를 설정으로 좁히는 일이 그만큼 중요해진다.

Codex는 이 설정을 `~/.codex/config.toml`의 `[mcp_servers.<이름>]` 테이블로 받는다. 프로젝트 단위로 묶으려면 저장소의 `.codex/config.toml`에 둔다. `codex mcp add`, `codex mcp list`, `codex mcp login` 명령으로도 등록·조회·인증을 처리할 수 있고 결과는 같은 파일에 반영된다. 노출 범위는 `enabled_tools` 허용 목록과 `disabled_tools` 차단 목록으로 자르고, 실행 승인 방식은 서버 단위 `default_tools_approval_mode`와 도구 단위 `tools.<도구>.approval_mode`로 나눠 지정한다.

## 코드

로컬 프로세스로 띄우는 stdio 서버는 실행 명령과 인자, 프로세스에 넘길 환경 변수를 적는다.

```toml
# ~/.codex/config.toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 30

[mcp_servers.context7.env]
LOG_LEVEL = "warn"
```

원격 서버는 주소와 인증 정보를 적고, 쓰기 계열 도구만 승인을 받도록 정책을 좁힌다.

```toml
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
disabled_tools = ["delete_file"]
```

등록과 확인은 CLI로도 한다. 원격 서버가 OAuth를 요구하면 로그인 단계를 따로 거친다.

```bash
codex mcp add context7
codex mcp list
codex mcp login figma
codex mcp --help
```

## 실무에서 걸리는 지점

서버 기동 대기 시간은 `startup_timeout_sec`로 정하고 ==기본값이 10초라서, 첫 실행에 패키지 다운로드가 끼는 stdio 서버는 시간을 넘겨 조용히 목록에서 빠진다==. 에러 없이 도구만 안 보이는 형태로 나타나므로 값을 늘려 두는 편이 낫다.

허용 목록과 차단 목록을 함께 쓸 때 ==`disabled_tools`는 `enabled_tools` 뒤에 적용되므로 같은 도구가 양쪽에 있으면 차단이 이긴다==. 목록을 자동 생성하는 스크립트를 쓰면 의도치 않게 전부 막히는 상황이 생긴다.

원격 서버 인증은 ==`bearer_token_env_var`에 토큰 값이 아니라 토큰이 담긴 환경 변수 이름을 적는 방식==이다. 값을 직접 써 넣으면 설정 파일에 자격 증명이 평문으로 남고, 그 파일이 저장소에 커밋될 위험도 같이 생긴다.

샌드박스와 MCP는 통제 범위가 다르다. ==샌드박스는 Codex가 로컬에서 실행하는 명령과 파일 쓰기를 제한할 뿐, 원격 MCP 서버가 자기 인프라에서 수행하는 작업까지 막지 못한다==. 외부 시스템을 바꾸는 도구는 승인 모드로 따로 통제해야 한다.

연결한 서버 수만큼 도구 정의가 매 턴 컨텍스트에 실린다. 도구 설명이 긴 서버를 여러 개 붙이면 실제 작업에 쓸 컨텍스트가 줄고 모델이 비슷한 이름의 도구를 혼동하기 시작하므로, 프로젝트별로 필요한 서버만 남기는 편이 안정적이다.

## 관련 글

- [설치와 config.toml 설정](/notes/codex/install-config/)
- [샌드박스와 승인 모드 — 안전한 자율 실행](/notes/codex/sandbox-approvals/)
- [커스텀 프롬프트와 확장 — 슬래시 커맨드·프로필](/notes/codex/custom-prompts-extensions/)
