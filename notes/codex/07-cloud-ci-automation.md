---
title: "Codex Cloud와 CI 자동화 — exec·GitHub 연동"
series: codex
part: "운영"
order: 7
summary: "대화형 세션 밖에서 Codex를 돌리는 두 경로인 codex exec와 Codex Cloud를, 출력 처리와 권한 통제 중심으로 정리한다"
tags: [Codex, codex exec, GitHub Actions, Codex Cloud, CI]
sources: [https://developers.openai.com/codex/cloud, https://developers.openai.com/codex/exec]
updated: 2026-09-05
---

에이전트를 대화형으로만 쓰면 사람이 터미널 앞에 앉아 있는 동안에만 일이 진행된다. PR이 열릴 때마다 같은 관점으로 리뷰를 붙이거나, 야간에 의존성 업데이트로 깨진 테스트를 고치거나, 릴리스 노트를 자동으로 뽑는 작업은 사람이 매번 세션을 열어 프롬프트를 붙여 넣어야 한다. 게다가 로컬에서 오래 걸리는 작업을 돌리면 그동안 그 저장소로 다른 일을 하기 어렵다. Codex는 이 두 문제를 서로 다른 경로로 나눠 푼다. 스크립트와 CI에 끼워 넣는 비대화형 실행이 `codex exec`이고, 격리된 원격 환경에서 작업을 병렬로 돌리는 것이 Codex Cloud다.

## 핵심 개념

`codex exec "<프롬프트>"`는 TUI 없이 한 턴을 끝까지 실행하고 종료한다. 진행 상황은 표준 에러로 흐르고 에이전트의 최종 메시지만 표준 출력으로 나가므로, 결과를 그대로 파이프에 태울 수 있다. 기계가 읽어야 하면 `--json`으로 JSON Lines 스트림을 받는다. `thread.started`, `turn.started`와 `turn.completed`, `item.*`, `error` 같은 이벤트가 한 줄씩 나온다. 최종 메시지만 따로 파일로 남기려면 `-o` 또는 `--output-last-message`를, 응답 형태를 고정하려면 JSON Schema 파일을 가리키는 `--output-schema`를 쓴다.

권한은 `--sandbox`로 정한다. 값은 `read-only`, `workspace-write`, `danger-full-access`다. 예전에 쓰이던 `--full-auto`는 폐기 표시가 붙었다. 세션을 이어 가려면 `codex exec resume <SESSION_ID>`나 `codex exec resume --last`를 쓰고, 세션 파일을 디스크에 남기고 싶지 않으면 `--ephemeral`을 붙인다. CI처럼 사용자 설정을 신뢰할 수 없는 환경에서는 `--ignore-user-config`로 `config.toml` 로딩을 건너뛰고, Git 저장소가 아닌 경로에서 실행할 때는 `--skip-git-repo-check`가 필요하다. 프롬프트를 표준 입력으로 넘기려면 `codex exec -` 형태를 쓴다.

GitHub 워크플로에서는 `openai/codex-action@v1`이 이 실행을 감싼다. `prompt` 또는 `prompt-file`로 지시를 주고 `model`, `effort`, `sandbox`로 실행 조건을, `allow-users`와 `allow-bots`로 누가 트리거할 수 있는지를 정한다. 권한 강등 방식은 `safety-strategy`가 맡고 기본값은 `drop-sudo`다. 실행 결과는 `final-message` 출력으로 나와 다음 스텝에 넘길 수 있다.

Codex Cloud는 저장소별로 의존성·도구·환경 변수·셋업 스텝을 정의한 격리 환경에서 작업을 병렬로 돌린다. 에이전트의 인터넷 접근 여부도 환경 설정에서 정한다. 시작 지점은 웹뿐 아니라 GitHub·GitLab·Linear·Slack이고, CLI에서는 `codex cloud`로 진행 중이거나 끝난 작업을 훑어 결과를 로컬 저장소에 반영한다. Spring 쪽에 대응시키면 `codex exec`는 잡 하나를 실행하고 종료 코드를 남기는 배치 러너에, Codex Cloud는 그 잡을 별도 워커 환경에서 큐에 태워 돌리는 구조에 가깝다.

## 코드

비대화형 실행은 셸 파이프라인의 한 단계로 다룬다. 표준 출력에는 최종 메시지만 담기므로 그대로 받아 쓴다.

```bash
codex exec --sandbox read-only \
  "스테이징된 변경분을 읽고 커밋 메시지 한 줄을 출력한다" > msg.txt

git log --oneline v1.4.0..HEAD | codex exec - --sandbox read-only

codex exec --json --sandbox workspace-write \
  -o result.md "실패한 테스트를 고친다" | tee events.jsonl
```

GitHub Actions에서는 액션에 권한과 트리거 조건을 명시한다.

```yaml
name: codex-review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - id: codex
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt-file: .github/codex/review.md
          sandbox: read-only
          effort: medium
          allow-bots: false
          output-file: review.md
```

원격에서 끝난 작업은 CLI로 확인하고 로컬 브랜치에 반영한다.

```bash
codex cloud
codex apply
```

## 실무에서 걸리는 지점

출력 스트림이 나뉘어 있다는 점을 놓치기 쉽다. ==진행 로그는 표준 에러, 최종 메시지는 표준 출력으로 나가므로 `2>&1`로 합쳐 파이프에 태우면 파싱이 깨진다==. 로그를 남기려면 에러 스트림만 따로 파일로 돌린다.

`--full-auto`는 폐기 표시가 붙었다. ==권한은 `--sandbox workspace-write`처럼 명시하는 편이 안전하고, `danger-full-access`는 되돌릴 수 있는 격리 환경에서만 쓴다==. CI 러너는 일회용이라 안전해 보이지만 러너에 주입된 시크릿에는 그대로 접근할 수 있다.

트리거 통제를 비워 두면 위험하다. ==`allow-users`와 `allow-bots`를 지정하지 않고 이슈나 코멘트 이벤트로 워크플로를 걸면 저장소 외부인이 에이전트 실행을 유발할 수 있다==. 리뷰 목적이라면 샌드박스를 읽기 전용으로 고정하는 조합을 함께 건다.

Codex Cloud 환경의 인터넷 접근은 설정으로 켜고 끄는 항목이다. 꺼 둔 상태에서 셋업 스텝 이후 패키지를 받아야 하는 테스트를 돌리면 원인이 드러나지 않는 실패로 이어지므로, 필요한 의존성은 셋업 단계에서 미리 설치해 둔다.

CI 인증은 로컬 로그인 정보가 아니라 `CODEX_API_KEY` 같은 시크릿으로 주입한다. 개인 계정 인증에 기대면 토큰이 만료되는 순간 파이프라인 전체가 멈추고, 사용량도 개인 한도에서 빠져나간다.

## 관련 글

- [샌드박스와 승인 모드 — 안전한 자율 실행](/notes/codex/sandbox-approvals/)
- [AGENTS.md — 프로젝트 규칙을 에이전트에게 전달](/notes/codex/agents-md/)
- [운영 팁 — 모델 선택·비용·팀 도입](/notes/codex/operations-best-practices/)
