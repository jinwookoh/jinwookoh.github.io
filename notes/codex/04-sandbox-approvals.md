---
title: "샌드박스와 승인 모드 — 안전한 자율 실행"
series: codex
part: "기초"
order: 4
summary: "샌드박스는 할 수 있는 범위를, 승인 정책은 멈춰 묻는 시점을 정하며 둘은 독립적으로 조합된다"
tags: [Codex, sandbox, approval policy, seatbelt, network access]
sources: [https://developers.openai.com/codex/security, https://developers.openai.com/codex/local-config]
updated: 2026-09-05
---

에이전트가 코드를 고치는 것보다 위험한 것은 명령을 실행하는 것이다. 테스트를 돌리려면 셸이 필요하고, 셸이 열리면 의존성 설치도 파일 삭제도 외부 전송도 같은 통로로 가능해진다. 매 명령을 사람이 승인하면 자율 실행의 이점이 사라지고, 전부 허용하면 되돌릴 수 없는 작업이 검토 없이 지나간다. Codex는 이 문제를 하나의 스위치로 풀지 않고 두 축으로 나눈다. 실행 자체를 OS 수준에서 가둬 두고, 그 경계를 넘으려 할 때만 사람에게 묻는다.

## 핵심 개념

첫 번째 축은 `sandbox_mode`다. 모델이 만들어 낸 명령이 기술적으로 무엇을 할 수 있는지를 정한다. `read-only`는 읽기만 허용하고, `workspace-write`는 현재 워크스페이스에 쓰기를 허용하되 네트워크는 막으며, `danger-full-access`는 아무것도 막지 않는다. 두 번째 축은 `approval_policy`이고 언제 멈춰 물어볼지를 정한다. `untrusted`는 안전한 읽기 작업만 자동으로 돌리고 상태를 바꾸는 명령마다 확인을 받으며, `on-request`는 샌드박스 경계를 넘어야 할 때만 묻고, `never`는 묻지 않는다. `granular` 형태로 승인 범주별로 나눠 일부는 대화형으로, 나머지는 자동 거부로 둘 수도 있다.

Spring에 대응시키면 `sandbox_mode`는 프로세스가 실제로 닿을 수 있는 자원을 제한하는 실행 경계이고, `approval_policy`는 요청이 그 경계를 넘으려 할 때 개입하는 인가 계층이다. 필터가 통과시켜도 컨테이너 권한이 없으면 실패하듯, 승인 정책이 느슨해도 샌드박스가 좁으면 명령은 실행되지 않는다.

두 축은 독립이라 조합으로 쓴다. 기본값에 해당하는 Auto 프리셋은 `--sandbox workspace-write --ask-for-approval on-request`이며, Codex는 실행 위치가 버전 관리되는 폴더인지 확인해 그렇지 않으면 `read-only`를 권한다. 워크스페이스에는 현재 디렉터리와 `/tmp` 같은 임시 디렉터리가 포함되고, 실제 범위는 `/status`로 확인한다. 세션 중에는 `/permissions`로 바꾼다.

샌드박스는 OS 기능으로 강제된다. macOS는 Seatbelt 프로파일을 붙여 `sandbox-exec`로, Linux는 `bwrap`과 `seccomp`로 명령을 감싼다. Windows는 WSL2에서 Linux 구현을 그대로 쓰거나 네이티브 Windows 샌드박스를 쓰며, 네이티브 모드는 `[windows]` 테이블의 `sandbox` 값으로 고른다.

네트워크는 `workspace-write`에서 기본으로 꺼져 있고 `sandbox_workspace_write.network_access = true`로만 열린다. 목적지를 제한하려면 `features.network_proxy`를 켜고 도메인 규칙을 준다. 규칙은 허용 목록 방식이라 `*.example.com`은 하위 도메인만, `**.example.com`은 apex까지 매칭하고, `deny`가 `allow`를 항상 이긴다.

## 코드

의도별 플래그 조합이다. 비대화형 실행에서도 같은 두 축을 그대로 쓴다.

```bash
# 기본값과 동일한 Auto 프리셋
codex --sandbox workspace-write --ask-for-approval on-request

# 읽기만 하며 질문에 답하게 한다
codex --sandbox read-only --ask-for-approval on-request

# CI: 읽기 전용에 승인 없음
codex exec --sandbox read-only --ask-for-approval never "이 변경의 위험 지점을 정리해 줘"

# 쓰기는 허용하되 신뢰할 수 없는 명령만 승인받는다
codex --sandbox workspace-write --ask-for-approval untrusted

# 쓰기 범위를 넓힐 때는 전체 개방 대신 디렉터리를 추가한다
codex --add-dir /Users/me/.pyenv/shims
```

정책을 파일로 고정한 예다. 네트워크를 여는 경우 프록시로 목적지를 함께 좁힌다.

```toml
# ~/.codex/config.toml
approval_policy = "on-request"
approvals_reviewer = "user"      # "auto_review" 로 두면 리뷰어 에이전트가 먼저 판단한다
sandbox_mode = "workspace-write"
allow_login_shell = false        # 셸 도구의 로그인 셸 사용을 막는다

[sandbox_workspace_write]
network_access = true
writable_roots = ["/tmp/build-cache"]

[features.network_proxy]
enabled = true
domains = { "**.npmjs.org" = "allow", "api.openai.com" = "allow" }
```

정책이 실제로 어떻게 걸리는지는 실행해 보고 확인한다. 샌드박스 헬퍼는 Codex가 내부에서 쓰는 것과 같은 정책으로 임의 명령을 돌려 준다.

```bash
# macOS / Linux 에서 샌드박스 안의 동작을 재현한다
codex sandbox macos --log-denials -- curl -sS https://example.com
codex sandbox linux -- ./gradlew test

# 샌드박스 밖 실행 규칙이 의도대로 판정되는지 검사한다
codex execpolicy check --pretty \
  --rules ~/.codex/rules/default.rules \
  -- gh pr view 7888 --json title,body
```

## 실무에서 걸리는 지점

- **프록시를 켜도 네트워크가 열리지는 않는다.** ==`features.network_proxy`는 이미 허용된 트래픽을 정책으로 좁히는 기능이라, 도메인 규칙만 추가하고 프록시를 켜지 않으면 명령은 아무 제한 없이 외부로 나간다.== 네트워크 허용과 목적지 제한은 항상 함께 설정한다.
- **워크스페이스 안에도 읽기 전용 경로가 있다.** `workspace-write`에서 `<writable_root>` 아래의 `.git`, `.agents`, `.codex`는 재귀적으로 보호된다. `git commit`이 매번 승인을 요구하는 이유가 이것이며, 특정 명령을 아예 막고 싶다면 `prefix_rule`로 처리한다.
- **전체 개방은 웹 검색 동작까지 바꾼다.** ==`--dangerously-bypass-approvals-and-sandbox`를 쓰면 웹 검색이 캐시 대신 라이브 조회로 기본 전환되어, 프롬프트 인젝션에 노출되는 표면이 함께 넓어진다.==
- **프록시가 걸러 주지 않는 통로가 있다.** 네트워크 정책은 샌드박스 안에서 실행되는 명령과 자식 프로세스에만 적용된다. 웹 검색, MCP 서버 연결, 브라우저 도구, 클라우드 작업, 모델 요청 자체는 별도 경로라 도메인 규칙으로 통제되지 않는다.
- **컨테이너 안에서는 샌드박스가 실패할 수 있다.** Docker나 Dev Container가 네임스페이스나 `seccomp` 사용을 막으면 Codex는 내부 샌드박스를 만들지 못한다. 이 경우 컨테이너 자체를 경계로 삼고 그 안에서 `--sandbox danger-full-access`로 돌리되, 신뢰하는 저장소에서만 쓴다.

## 관련 글

- [설치와 config.toml 설정](/notes/codex/install-config/)
- [AGENTS.md — 프로젝트 규칙을 에이전트에게 전달](/notes/codex/agents-md/)
- [Codex란 무엇인가 — CLI·IDE·클라우드](/notes/codex/what-is-codex/)
