---
title: "설치와 config.toml 설정"
series: codex
part: "기초"
order: 2
summary: "Codex 설정은 CLI 플래그부터 내장 기본값까지 6단계로 겹쳐지며, 계층을 알아야 값이 왜 안 먹는지 설명된다"
tags: [Codex, config.toml, CLI, profiles, CODEX_HOME]
sources: [https://developers.openai.com/codex/local-config, https://github.com/openai/codex]
updated: 2026-09-05
---

설치 직후의 Codex는 모든 저장소를 같은 방식으로 대한다. 그래서 실험용 저장소에서는 승인 프롬프트가 성가시고, 운영 코드가 있는 저장소에서는 반대로 너무 헐겁다. 매번 플래그를 붙여 보정하면 명령이 길어지고 팀원마다 다른 조합을 쓰게 된다. 저장소마다 다른 값을 쓰되 공통 기본값은 한 곳에서 관리하려면 설정이 계층으로 겹쳐져야 하고, 그 계층이 어떤 순서로 합쳐지는지 알아야 값이 무시될 때 원인을 짚을 수 있다.

## 핵심 개념

설치 경로는 네 가지다. macOS와 Linux는 공식 셸 설치 스크립트를, Windows는 PowerShell 설치 스크립트를 쓴다. 패키지 관리자를 선호하면 `npm install -g @openai/codex`나 `brew install --cask codex`도 지원한다. 설치 스크립트로 넣었다면 업데이트도 같은 명령을 다시 실행하면 되고, 릴리스 빌드라면 `codex update`로도 갱신된다.

로컬 상태는 `CODEX_HOME`이 가리키는 디렉터리에 모인다. 기본값은 `~/.codex`이고 그 아래에 사용자 설정 `config.toml`, 자격 증명, 세션 기록 `history.jsonl`, 로그가 놓인다. 환경 변수를 바꿔 다른 프로필로 실행할 수 있어서, 자동화 계정과 개인 계정을 한 머신에서 분리할 때 쓴다.

설정은 여섯 계층이 겹쳐서 최종값이 된다. 위에서부터 CLI 플래그와 `-c` 오버라이드, 프로젝트의 `.codex/config.toml`, `--profile`로 고른 프로파일 파일, 사용자 설정 `~/.codex/config.toml`, 시스템 설정 `/etc/codex/config.toml`, 내장 기본값 순이다. Spring Boot의 PropertySource 우선순위와 같은 구조이고, 프로젝트 설정은 저장소 루트에서 현재 작업 디렉터리까지 내려오며 발견한 파일을 모두 읽되 가까운 파일이 이긴다.

프로파일은 Spring의 `spring.profiles.active`와 역할이 같지만 파일 배치가 다르다. `codex --profile deep-review`를 실행하면 사용자 설정 위에 `~/.codex/deep-review.config.toml`이 얹힌다. 프로파일 파일 안에는 최상위 키를 그대로 쓰고 별도 테이블로 감싸지 않는다. ==Codex 0.134.0부터 `config.toml` 안의 `[profiles.<name>]` 테이블과 최상위 `profile` 선택자는 더 이상 읽히지 않으므로, 예전 방식으로 적어 둔 프로파일은 조용히 적용되지 않는다.==

자주 바꾸는 키는 많지 않다. `model`과 `model_reasoning_effort`가 모델과 추론 강도를, `approval_policy`와 `sandbox_mode`가 승인과 실행 범위를 정한다. `web_search`는 `cached`, `indexed`, `live`, `disabled` 중 하나로 웹 검색 동작을 고르고 기본값은 캐시된 색인이다. 그 밖에 `personality`로 응답 톤을, `log_dir`로 로그 위치를, `[features]` 테이블로 실험적 기능 토글을, `[history]`로 세션 기록 보존을 조정한다.

## 코드

사용자 기본값을 정하는 `~/.codex/config.toml`이다. 여기 적은 값이 CLI와 IDE 확장 양쪽에 적용된다.

```toml
# ~/.codex/config.toml
model = "gpt-5.6"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "cached"
file_opener = "vscode"

[sandbox_workspace_write]
network_access = false

[history]
persistence = "none"   # 세션 기록을 남기지 않는다

[shell_environment_policy]
ignore_default_excludes = false   # KEY/SECRET/TOKEN 자동 필터를 켠다
```

저장소 안에 두는 프로젝트 설정이다. 신뢰한 프로젝트에서만 로드되며, 팀이 공유해야 하는 값만 최소로 적는다.

```toml
# <repo>/.codex/config.toml
approval_policy = "untrusted"
sandbox_mode = "workspace-write"
project_doc_max_bytes = 65536

[sandbox_workspace_write]
writable_roots = ["/tmp/build-cache"]
```

프로파일 파일과 일회성 오버라이드다. `-c` 값은 JSON이 아니라 TOML로 파싱되므로 문자열에는 따옴표가 한 겹 더 필요하다.

```bash
# ~/.codex/deep-review.config.toml 을 사용자 설정 위에 얹는다
codex --profile deep-review
codex exec --profile deep-review "이 변경을 리뷰해 줘"

# 전용 플래그가 있으면 그쪽이 낫다
codex --model gpt-5.6-terra

# 임의 키는 -c 로 덮어쓴다
codex -c 'model="gpt-5.6-terra"'
codex -c sandbox_workspace_write.network_access=true
codex -c 'shell_environment_policy.filters={ "PATH" = "include" }'

codex doctor   # 설치·설정·인증 상태를 한 번에 점검한다
```

## 실무에서 걸리는 지점

- **환경 변수 필터의 기본값이 반대다.** ==`shell_environment_policy.ignore_default_excludes`는 기본값이 `true`여서, 이름에 `KEY`·`SECRET`·`TOKEN`이 들어간 변수를 걸러 내는 자동 필터가 꺼진 상태로 동작한다.== 자격 증명을 셸에 export 해 두고 쓰는 환경이라면 `false`로 명시해야 한다.
- **프로젝트 설정이 못 쓰는 키가 있다.** `openai_base_url`, `model_provider`, `model_providers`, `notify`, `otel`, `profile`, `profiles` 같은 키는 저장소의 `.codex/config.toml`에서 무시되고 시작 시 경고만 뜬다. 자격 증명 경로와 텔레메트리를 저장소가 바꾸지 못하게 막는 설계이므로 사용자 설정에 적어야 한다.
- **신뢰하지 않은 프로젝트는 계층 하나가 통째로 빠진다.** 프로젝트를 신뢰하지 않으면 `.codex/` 계층 전체, 즉 프로젝트 설정과 프로젝트 로컬 훅·룰이 로드되지 않는다. 사용자와 시스템 계층만 남으므로 동작이 달라진다.
- **세션 기록은 기본으로 남는다.** 전사 기록이 `CODEX_HOME` 아래에 쌓이므로 보존 정책이 있는 조직이라면 `history.persistence`나 `history.max_bytes`를 명시해야 한다.
- **`-c` 파싱 실패는 오류가 아니다.** TOML로 해석되지 않는 값은 문자열로 처리된다. 따옴표를 빠뜨린 오타가 오류 없이 엉뚱한 문자열로 들어갈 수 있다.

## 관련 글

- [Codex란 무엇인가 — CLI·IDE·클라우드](/notes/codex/what-is-codex/)
- [AGENTS.md — 프로젝트 규칙을 에이전트에게 전달](/notes/codex/agents-md/)
- [샌드박스와 승인 모드 — 안전한 자율 실행](/notes/codex/sandbox-approvals/)
