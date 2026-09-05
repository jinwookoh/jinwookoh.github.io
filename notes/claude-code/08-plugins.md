---
title: "플러그인 — 마켓플레이스와 추천 플러그인"
series: claude-code
part: "확장"
order: 8
summary: "스킬·훅·MCP 묶음에 이름과 버전을 붙여 설치 가능한 단위로 만들고 팀에 배포하는 방법"
tags: [Claude Code, plugin, marketplace, plugin.json, settings.json]
sources: [https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugin-marketplaces]
updated: 2026-09-05
---

스킬 하나와 서브에이전트 둘, 커밋 전에 도는 훅 하나를 팀 전체가 같이 쓰려고 하면 결국 `.claude/` 디렉터리를 통째로 복사하게 된다. 복사한 순간부터 원본과 사본은 갈라진다. 누가 훅 스크립트를 고쳤는지, 어느 쪽이 최신인지 판단할 근거가 없다. 새로 합류한 사람에게는 "이 폴더를 받아 홈 디렉터리에 두라"는 구두 안내만 남는다. 플러그인은 이 묶음에 이름과 버전, 배포 경로를 붙여 설치와 제거가 되는 단위로 바꾼다.

## 핵심 개념

플러그인은 스킬·서브에이전트·훅·MCP 서버·LSP 서버·백그라운드 모니터를 담은 디렉터리 하나다. 플러그인 루트의 `.claude-plugin/plugin.json` 매니페스트가 `name`, `description`, `version`, `author` 로 정체성을 정하고, `name` 은 그대로 스킬 네임스페이스가 된다. `my-tool` 플러그인의 `skills/hello/SKILL.md` 는 `/my-tool:hello` 로 호출된다. 네임스페이스 덕분에 같은 이름의 스킬을 가진 플러그인을 여러 개 켜 둬도 충돌하지 않는다.

구성 요소 디렉터리는 전부 플러그인 루트에 놓는다. `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, 플러그인이 켜졌을 때 적용할 기본값인 `settings.json` 이 모두 여기 들어간다. ==`commands/`·`agents/`·`skills/`·`hooks/` 를 `.claude-plugin/` 안에 넣으면 매니페스트만 읽히고 나머지 구성 요소는 조용히 무시된다.==

배포는 마켓플레이스가 맡는다. 마켓플레이스는 `.claude-plugin/marketplace.json` 을 담은 저장소이고 `name`·`owner`·`plugins` 세 필드가 필수다. 각 항목의 `source` 는 상대 경로부터 `github`, `url`, `git-subdir`, `npm`, `archive`, `command` 까지 받는다. 쓰는 쪽은 마켓플레이스를 등록해 카탈로그를 받고 그중 필요한 플러그인만 설치한다. 스코프는 user, project, local 세 가지다.

Java/Spring 쪽 개념으로 옮기면 마켓플레이스는 Maven 저장소 설정, `plugin.json` 의 `name`·`version` 은 아티팩트 좌표, 프로젝트 `.claude/settings.json` 의 `enabledPlugins` 는 `dependencies` 블록에 해당한다. 관리 설정의 `strictKnownMarketplaces` 는 사내 미러 외의 원격 저장소를 막는 설정과 같은 자리다.

### 공식 마켓플레이스에서 골라 쓸 만한 것

`claude-plugins-official` 은 처음 대화형으로 실행할 때 자동으로 등록된다. 코드 인텔리전스 계열은 언어 서버를 붙여 편집 직후 타입 오류를 되돌려 받고 정의와 참조로 이동하게 해 준다. `typescript-lsp`, `pyright-lsp`, `rust-analyzer-lsp`, `gopls-lsp`, `jdtls-lsp`, `kotlin-lsp` 로 나뉘며 언어 서버 바이너리는 직접 설치해야 한다.

외부 연동 계열은 MCP 서버가 미리 구성돼 있다. `github`, `gitlab`, `atlassian`, `linear`, `notion`, `asana`, `figma`, `sentry`, `slack`, `vercel`, `firebase`, `supabase` 가 있다. 개발 워크플로 계열에는 커밋과 PR 생성을 다루는 `commit-commands`, PR 리뷰 전용 에이전트를 묶은 `pr-review-toolkit`, 플러그인 제작 도구인 `plugin-dev`, Agent SDK 개발용 `agent-sdk-dev` 가 있다. 변경마다 취약점을 훑는 `security-guidance` 도 있다. 서드파티 플러그인은 `anthropics/claude-plugins-community` 를 직접 등록한 뒤 `@claude-community` 이름으로 설치한다.

## 코드

세션 안에서는 `/plugin`, 스크립트에서는 `claude plugin` 을 쓴다.

```bash
# 마켓플레이스 등록 (GitHub owner/repo, git URL, 로컬 경로, marketplace.json URL)
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin marketplace add ./my-marketplace --scope project

# 설치와 관리
claude plugin install typescript-lsp@claude-plugins-official
claude plugin install formatter@my-marketplace --scope project
claude plugin marketplace update my-marketplace

# 개발 중인 플러그인을 설치 없이 세션에 로드
claude --plugin-dir ./my-plugin
```

최소 플러그인의 매니페스트와 디렉터리 배치다.

```json
// my-plugin/.claude-plugin/plugin.json
{
  "name": "my-plugin",
  "description": "팀 공용 리뷰 스킬과 lint 훅",
  "version": "1.2.0",
  "author": { "name": "Platform Team" }
}
```

```text
my-plugin/
├── .claude-plugin/plugin.json
├── skills/code-review/SKILL.md
├── agents/security-reviewer.md
├── hooks/hooks.json
└── .mcp.json
```

팀 전원에게 같은 구성을 적용하려면 저장소의 `.claude/settings.json` 에 마켓플레이스와 활성화 목록을 함께 커밋한다. 폴더를 신뢰하면 마켓플레이스가 등록된다.

```json
{
  "extraKnownMarketplaces": {
    "company-tools": {
      "source": { "source": "github", "repo": "acme-corp/claude-plugins" }
    }
  },
  "enabledPlugins": {
    "code-formatter@company-tools": true,
    "deployment-tools@company-tools": true
  }
}
```

## 실무에서 걸리는 지점

- 플러그인이 붙이는 스킬과 에이전트 설명은 매 턴 컨텍스트를 차지한다. Discover 탭의 Context cost 로 설치 전 비용을 확인하고, Installed 탭의 "Not used recently" 로 안 쓰는 것을 걷어낸다.
- 세션 도중의 설치와 활성화는 `/reload-plugins` 로 반영된다. 프롬프트 캐시를 무효화하는 변경이면 경고와 함께 건너뛰고, `--force` 로 다시 실행하면 다음 요청이 대화 전체를 재처리한다.
- ==`plugin.json` 과 마켓플레이스 항목 양쪽에 `version` 을 선언하면 경고 없이 `plugin.json` 쪽이 이긴다.== `version` 을 생략하면 커밋 SHA 나 아카이브 해시가 버전이 된다.
- ==마켓플레이스를 제거하면 거기서 설치한 플러그인도 함께 사라진다.== 잠시 끄고 싶을 뿐이라면 `claude plugin disable` 을 쓴다.
- 플러그인은 사용자 권한으로 임의 코드를 실행하므로 검증하지 않은 저장소는 등록하지 않는다. 배포 전에는 `claude plugin validate .` 로 매니페스트와 경로를 점검한다.

## 관련 글

- [스킬과 슬래시 커맨드](/notes/claude-code/skills-slash-commands/)
- [훅 — 도구 호출 전후 자동화](/notes/claude-code/hooks/)
- [MCP 서버 연동 — 외부 도구와 데이터 연결](/notes/claude-code/mcp/)
