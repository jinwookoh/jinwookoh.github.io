---
title: "CLAUDE.md와 메모리 — 프로젝트 컨텍스트 관리"
series: claude-code
part: "기초"
order: 2
summary: "CLAUDE.md는 매 세션 로딩되는 컨텍스트일 뿐 강제 설정이 아니므로, 분량과 배치가 준수율을 결정한다"
tags: [CLAUDE.md, auto memory, context window, Claude Code, rules]
sources: [https://code.claude.com/docs/en/memory, https://www.anthropic.com/engineering/claude-code-best-practices]
updated: 2026-09-05
---

에이전트 세션은 매번 빈 컨텍스트에서 시작한다. 어제 "이 저장소는 pnpm을 쓴다", "마이그레이션 파일은 손대지 마라"라고 알려 줬어도 오늘 세션은 그 사실을 모른다. 그래서 같은 교정을 매번 다시 타이핑하게 되고, 교정이 늦으면 잘못된 방향으로 이미 파일 열 개가 고쳐진 뒤다. Claude Code는 이 문제를 두 갈래로 나눠 푼다. 사람이 직접 쓰는 `CLAUDE.md`와, 모델이 스스로 적어 두는 auto memory다.

## 핵심 개념

`CLAUDE.md`는 세션 시작 시 컨텍스트에 주입되는 마크다운 파일이다. 놓이는 위치에 따라 적용 범위가 다르고, 아래 순서로 로드된다.

| 범위 | 위치 | 공유 대상 |
|---|---|---|
| 관리 정책 | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`, Linux `/etc/claude-code/CLAUDE.md` | 조직 전체 |
| 사용자 | `~/.claude/CLAUDE.md` | 본인의 모든 프로젝트 |
| 프로젝트 | `./CLAUDE.md` 또는 `./.claude/CLAUDE.md` | 버전 관리로 팀 전체 |
| 로컬 | `./CLAUDE.local.md` | 본인, 이 프로젝트만 |

여러 파일이 발견되면 서로를 덮어쓰는 대신 전부 이어 붙는다. 파일시스템 루트 쪽 내용이 먼저 오고 실행 디렉터리에 가까운 내용이 뒤에 온다. Spring Boot로 치면 `application.yml`과 프로필별 설정이 키 단위로 병합되는 구조와 자리는 같지만, 여기서는 병합이 아니라 연결이라서 서로 모순되는 지시가 남아 있으면 둘 다 컨텍스트에 들어간다. ==모순된 지시가 두 파일에 남아 있으면 어느 쪽이 선택될지 정해져 있지 않다.==

대형 저장소에서는 `.claude/rules/` 디렉터리로 지시를 쪼갠다. 각 `.md` 파일이 한 주제를 맡고, YAML 프런트매터의 `paths`에 글롭 패턴을 적으면 해당 파일을 읽을 때만 컨텍스트에 들어온다. `paths`가 없는 규칙은 매 세션 무조건 로드된다.

auto memory는 성격이 다르다. 대화 중 받은 교정과 선호를 모델이 스스로 `~/.claude/projects/<project>/memory/` 아래에 저장한다. 색인 파일 `MEMORY.md`만 세션 시작에 읽히고 개별 주제 파일은 필요할 때 읽는다. 저장 위치는 git 저장소 기준으로 정해지므로 같은 저장소의 모든 워크트리가 하나의 메모리 디렉터리를 공유하지만, 머신 밖으로는 나가지 않는다.

두 체계 모두 컨텍스트이지 강제 설정이 아니다. ==반드시 특정 시점에 실행돼야 하는 규칙은 CLAUDE.md가 아니라 PreToolUse 훅으로 써야 모델의 판단과 무관하게 적용된다.==

## 코드

프로젝트 `CLAUDE.md`는 짧게 유지한다. 코드를 읽어 알 수 있는 내용은 빼고, 추론할 수 없는 명령과 관례만 남긴다.

```markdown
# 빌드와 테스트
- 패키지 매니저는 pnpm 고정. npm 명령을 쓰지 않는다
- 변경 후 `pnpm typecheck` 를 돌린다
- 테스트는 전체 스위트 대신 단일 파일 단위로 실행한다

# 코드 스타일
- ES 모듈만 사용한다. CommonJS require 금지
- API 핸들러는 `src/api/handlers/` 아래에 둔다

# 저장소 관례
- 브랜치는 `feat/`, `fix/` 접두사를 붙인다
```

경로 한정 규칙은 매칭되는 파일을 읽을 때만 로드되므로 상시 컨텍스트를 늘리지 않는다.

```markdown
---
paths:
  - "src/api/**/*.{ts,tsx}"
  - "tests/**/*.test.ts"
---

# API 작성 규칙
- 모든 엔드포인트에 입력 검증을 붙인다
- 오류 응답은 공용 포맷 헬퍼를 거친다
```

모노레포에서 다른 팀의 상위 `CLAUDE.md`가 딸려 들어오면 `claudeMdExcludes`로 제외한다. 절대 경로에 글롭으로 매칭하며, 개인 설정 파일에 두는 편이 안전하다.

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/user/monorepo/other-team/.claude/rules/**"
  ],
  "autoMemoryEnabled": false
}
```

## 실무에서 걸리는 지점

- **길이가 준수율을 깎는다.** 한 파일당 200줄 아래를 목표로 삼는다. 지시가 길어질수록 토큰을 더 쓰면서 개별 규칙이 묻힌다. ==4 MiB를 넘는 CLAUDE.md는 잘려서 로드되는 것이 아니라 통째로 무시된다.==
- **import는 정리 수단이지 절약 수단이 아니다.** `@path/to/file` 구문으로 파일을 끌어올 수 있고 최대 네 단계까지 중첩되지만, ==임포트된 파일도 세션 시작에 전부 펼쳐져 컨텍스트에 들어가므로 분량은 줄지 않는다.== 백틱으로 감싼 경로는 임포트되지 않는다.
- **하위 디렉터리 파일은 지연 로드된다.** 실행 디렉터리 위쪽의 파일만 시작 시 로드되고, 아래쪽 파일은 그 디렉터리의 파일을 읽을 때 들어온다. `/compact` 이후 지시가 사라진 것처럼 보이면 대개 아직 다시 로드되지 않은 하위 파일이거나 경로 한정 규칙이다.
- **auto memory 색인에는 상한이 있다.** `MEMORY.md`는 앞의 200줄 또는 25KB까지만 세션 시작에 읽힌다. 그 뒤 내용은 로드되지 않으므로 항목당 한 줄로 유지하고 상세는 주제 파일로 내린다.
- **외부 임포트 승인은 한 번뿐이다.** 프로젝트 파일이 작업 디렉터리 밖 경로를 임포트하면 최초 1회 승인 대화가 뜬다. 여기서 거절하면 해당 임포트는 비활성 상태로 남고 대화창이 다시 나타나지 않는다.
- **로드 여부는 추측하지 않는다.** 현재 세션에 실제로 들어온 파일 목록은 `/context`의 메모리 파일 항목에서 확인하고, 파일 열기와 auto memory 토글은 `/memory`로 한다.

## 관련 글

- [Claude Code란 무엇인가 — 설치와 기본 사용법](/notes/claude-code/what-is-claude-code/)
- [설정과 권한 모델 — settings.json·permission mode](/notes/claude-code/settings-permissions/)
- [스킬과 슬래시 커맨드](/notes/claude-code/skills-slash-commands/)
