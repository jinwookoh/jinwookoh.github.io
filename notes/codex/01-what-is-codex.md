---
title: "Codex란 무엇인가 — CLI·IDE·클라우드"
series: codex
part: "기초"
order: 1
summary: "Codex는 터미널·에디터·클라우드라는 세 표면이 같은 설정과 권한 모델을 공유하는 코딩 에이전트다"
tags: [Codex, OpenAI, AI Agent, CLI, AGENTS.md]
sources: [https://developers.openai.com/codex/overview, https://developers.openai.com/codex/quickstart]
updated: 2026-09-05
---

모델에게 코드 작업을 맡기려면 세 가지를 따로 풀어야 한다. 저장소의 어떤 파일을 읽힐지, 모델이 만들어 낸 명령을 어디까지 실행하게 둘지, 결과를 어떻게 검토하고 되돌릴지다. 편집기 자동완성은 첫 번째만 다루고 나머지는 사람이 전부 떠안는다. 직접 스크립트를 붙여 자동화하면 파일 접근 범위와 셸 실행 권한을 프로젝트마다 새로 설계하게 되고, 로컬에서 통하던 방식이 CI에서는 그대로 깨진다. Codex는 이 세 가지를 하나의 규약으로 묶은 코딩 에이전트다. 실행 위치가 터미널이든 에디터든 클라우드든 같은 설정 파일, 같은 지시문 파일, 같은 샌드박스·승인 정책을 공유한다.

## 핵심 개념

Codex는 세 개의 표면으로 제공된다. Codex CLI는 터미널에서 `codex`를 실행해 대화형 TUI를 띄우고, 현재 저장소의 파일을 읽고 고치고 로컬에 설치된 도구를 직접 실행한다. `codex exec`는 같은 엔진을 사람 개입 없이 돌리는 비대화형 모드로 스크립트와 파이프라인에 넣는 용도다. IDE 확장은 VS Code·Cursor·Windsurf에서 `openai.chatgpt` 확장으로 설치하고, Xcode와 JetBrains는 각자의 통합 경로를 쓴다. 편집기에 이미 열려 있는 파일과 선택 영역이 프롬프트 컨텍스트로 들어가는 것이 CLI와의 차이다. Codex cloud는 OpenAI가 관리하는 격리 컨테이너에서 작업을 돌리고, GitHub·GitLab·Linear·Slack에서 작업을 시작해 결과를 풀 리퀘스트로 받는다.

세 표면을 하나로 묶는 것은 설정 계층이다. 개인 기본값은 `~/.codex/config.toml`에, 저장소별 재정의는 `.codex/config.toml`에 둔다. Spring Boot로 치면 `application.yml`과 프로파일별 오버라이드가 겹쳐 최종 값이 결정되는 구조와 같고, 우선순위는 CLI 플래그, 프로젝트 설정, 프로파일 파일, 사용자 설정, 시스템 설정, 내장 기본값 순이다. 프로젝트에 전달할 규칙은 `AGENTS.md`에 적는다. 빌드·테스트 명령이나 코드 스타일 같은 팀 컨벤션을 사람이 아니라 에이전트가 읽는 형태로 고정하는 파일이다.

권한 모델도 공유된다. `sandbox_mode`가 기술적으로 할 수 있는 범위를, `approval_policy`가 멈춰서 물어보는 시점을 정한다. 로컬 기본값은 워크스페이스 안에서만 쓰기가 가능하고 네트워크는 꺼져 있는 상태다. 클라우드는 setup 단계와 agent 단계로 런타임을 나눠, 의존성 설치가 필요한 setup에서만 네트워크를 열고 agent 단계는 기본적으로 오프라인으로 돈다.

로그인은 ChatGPT 계정과 API 키 두 가지를 지원한다. 어느 쪽으로 로그인했는지에 따라 적용되는 관리자 통제와 데이터 보존 정책이 달라지며, ==Codex cloud는 ChatGPT 계정 로그인만 지원하므로 API 키로만 인증한 환경에서는 클라우드 위임 자체가 불가능하다.==

## 코드

설치하고 저장소 안에서 첫 세션을 여는 흐름이다. 설치 스크립트는 업데이트에도 같은 명령을 그대로 쓴다.

```bash
# macOS / Linux
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# 대안: npm 또는 Homebrew
npm install -g @openai/codex
brew install --cask codex

cd ~/work/my-service
codex            # 대화형 TUI. 첫 실행에서 로그인 방식을 고른다
codex resume     # 이 디렉터리의 최근 세션을 이어서 연다
```

CI에서 쓰는 비대화형 실행이다. `--json`으로 상태 변화를 줄 단위 JSON으로 받고, 마지막 요약문은 파일로 따로 떨어뜨린다.

```bash
codex exec \
  --sandbox read-only \
  --ask-for-approval never \
  --json \
  --output-last-message /tmp/codex-summary.txt \
  "변경된 파일의 테스트 커버리지 공백을 정리해 줘"
```

최소한의 사용자 설정이다. 모델과 추론 강도, 승인 정책과 샌드박스를 한 번 정해 두면 CLI와 IDE 확장이 같은 값을 읽는다.

```toml
# ~/.codex/config.toml
model = "gpt-5.6"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

## 실무에서 걸리는 지점

- **프로젝트 설정은 신뢰해야 로드된다.** ==저장소를 신뢰하지 않은 상태에서는 `.codex/config.toml`과 프로젝트 로컬 훅·룰이 통째로 무시되고 사용자·시스템 계층만 적용된다.== 팀에 배포한 설정이 사람마다 다르게 동작한다면 신뢰 여부부터 확인해야 한다.
- **클라우드 시크릿의 수명.** 클라우드 환경에 등록한 시크릿은 setup 단계에서만 노출되고 agent 단계가 시작되기 전에 제거된다. 에이전트 실행 중에 토큰을 읽는 스크립트는 로컬에서 통과하고 클라우드에서만 조용히 실패한다.
- **비대화형 모드의 구형 플래그.** `codex exec --full-auto`는 호환용으로만 남아 있고 경고를 출력한다. 새 파이프라인은 `codex exec --sandbox workspace-write`처럼 샌드박스를 직접 지정한다.
- **버전 관리가 사실상 전제다.** Codex는 작업 전후로 커밋 체크포인트를 두는 흐름을 전제로 설계됐다. `git status`가 지저분한 상태에서 위임하면 에이전트 변경분과 기존 변경분이 섞여 되돌리기 어려워진다.
- **표면마다 맞는 작업 크기가 다르다.** 짧은 편집은 IDE 확장, 저장소 전반을 훑는 탐색은 CLI, 오래 걸리고 병렬로 돌릴 작업은 클라우드가 맞다. 하나의 표면으로 전부 처리하려 들면 대기 시간이나 컨텍스트 손실 중 하나를 감수하게 된다.

## 관련 글

- [설치와 config.toml 설정](/notes/codex/install-config/)
- [AGENTS.md — 프로젝트 규칙을 에이전트에게 전달](/notes/codex/agents-md/)
- [샌드박스와 승인 모드 — 안전한 자율 실행](/notes/codex/sandbox-approvals/)
