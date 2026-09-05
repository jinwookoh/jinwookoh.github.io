---
title: "운영 팁 — 모델 선택·비용·팀 도입"
series: codex
part: "운영"
order: 8
summary: "모델과 추론 강도를 작업 성격에 맞춰 나누고, 5시간 한도와 조직 설정 계층을 기준으로 팀 도입을 설계하는 방법을 정리한다"
tags: [Codex, config.toml, Rate Limits, Model Selection, Team Adoption]
sources: [https://developers.openai.com/codex/overview, https://github.com/openai/codex]
updated: 2026-09-05
---

에이전트 도구는 개인이 혼자 쓸 때는 설정이 문제가 되지 않는다. 팀으로 넓히는 순간 사정이 달라진다. 누군가는 가장 무거운 모델로 로그를 요약하다 오후에 한도를 소진하고, 누군가는 저장소 규칙을 모르는 상태로 리팩터링을 돌려 컨벤션이 깨진 PR을 올린다. 승인 정책도 사람마다 달라서 같은 작업이 누구 화면에서는 멈추고 누구 화면에서는 그냥 실행된다. 결과의 편차가 커지면 도구를 믿을 수 없게 되고, 결국 아무도 자동화 경로를 쓰지 않는 상태로 되돌아간다. 이 편차를 줄이는 축이 모델 선택, 사용량 관리, 설정 계층 셋이다.

## 핵심 개념

모델은 능력과 속도, 비용이 다른 계열로 나뉜다. 문서 기준으로 가장 무거운 축이 Astra이고, GPT-5.6 계열은 복잡한 코딩을 맡는 Sol, 일상 작업에 맞춘 균형형 Terra, 가장 저렴하고 빠른 Luna로 갈린다. 즉각적인 반복 편집에 맞춘 5.3 Codex Spark도 따로 있다. 5.5나 5.4 계열은 유지되지만 단계적으로 정리되는 중이므로 새 설정에 굳혀 두지 않는 편이 좋다.

같은 모델이라도 추론 강도로 소모와 품질이 크게 달라진다. 낮은 단계는 범위가 분명한 작업에, medium은 기본값으로 속도와 깊이의 균형에, high 이상은 여러 단계를 거치는 문제에 쓴다. 가장 위 단계는 서브에이전트를 병렬로 굴려 작업을 나누는 방식이라 성격이 다르다. 선택은 `config.toml`의 `model`과 `model_reasoning_effort`로 고정하거나, 실행할 때 `--model`, 세션 중에는 `/model`로 바꾼다.

사용량은 5시간 롤링 윈도로 계산된다. 세션 중에는 `/status`로 남은 한도를 확인한다. 요금제는 무료부터 Go, Plus, Pro가 있고 Pro는 Plus 대비 5배와 20배 한도를 고른다. 팀은 사용자당 과금되는 Business, 그 위에 Enterprise가 있다. 포함된 한도를 넘기면 크레딧을 추가로 구매하는 구조이고, API 키로 인증하면 플랜 한도가 아니라 표준 API 요금이 그대로 적용된다.

설정은 여러 층이 겹친다. CLI 플래그가 가장 강하고, 프로젝트의 `.codex/config.toml`, 프로필, 사용자 `~/.codex/config.toml`, 시스템 `/etc/codex/config.toml`, 내장 기본값 순으로 내려간다. 조직 표준은 가장 아래층인 시스템 설정과 `/etc/codex/skills`에 두고, 저장소 고유 규칙은 AGENTS.md와 `.agents/skills`로 커밋해 공유한다. Spring으로 옮기면 시스템 설정은 조직 공통 부모 POM으로 버전을 고정하는 일에, AGENTS.md는 코드 컨벤션을 문서가 아니라 빌드가 읽는 규칙으로 못 박는 일에 가깝다.

## 코드

설치와 상태 확인은 도입 첫날 팀에 그대로 전달할 수 있는 수준으로 짧다.

```bash
npm install -g @openai/codex
# 또는
brew install --cask codex

codex login
codex          # 세션 안에서 /status 로 남은 한도, /model 로 모델 확인
```

개인 설정은 기본값을 저렴한 쪽에 두고, 무거운 작업만 프로필로 꺼내 쓰는 형태가 소모를 줄인다.

```toml
# ~/.codex/config.toml
model = "gpt-5.6"
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
review_model = "gpt-5.6-luna"

[profiles.quick]
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
sandbox_mode = "read-only"

[profiles.deep]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
```

조직 표준은 시스템 설정에 두어 개인 설정이 없어도 같은 기준에서 시작하게 만든다.

```toml
# /etc/codex/config.toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_reasoning_effort = "medium"
```

## 실무에서 걸리는 지점

모델별 한도 차이가 크다. ==Plus 기준 5시간 창에서 Sol 계열은 수십 건 수준인 반면 Luna 계열은 그 열 배 이상을 쓸 수 있으므로, 기본 모델을 무거운 쪽으로 고정하면 오전에 한도를 태우게 된다==. 탐색과 요약은 가벼운 모델로 돌리고 설계 변경만 무거운 모델에 맡기는 분리가 실질적인 절감 수단이다.

가장 높은 추론 단계는 성격이 다르다. ==서브에이전트를 병렬로 굴리는 방식이라 한 번의 실행이 여러 건의 소모로 잡히므로, 기본값으로 올려 두면 한도가 예상보다 훨씬 빨리 줄어든다==. 어려운 문제에 한정해 그때만 올린다.

인증 방식에 따라 과금 체계가 갈린다. ==API 키로 붙으면 요금제 한도가 아니라 종량제 API 요금이 적용되므로, 한도에 막히지 않는 대신 상한선 없이 청구된다==. CI에서 API 키를 쓴다면 예산 알림을 함께 걸어 둔다.

저장소 설정은 무조건 적용되지 않는다. ==프로젝트의 `.codex/config.toml`은 신뢰한 프로젝트에서만 로드되므로, 새로 클론한 저장소에서는 팀 표준이 아니라 개인 설정으로 실행될 수 있다==. 팀 규칙 중 반드시 지켜져야 하는 항목은 시스템 설정 층에도 함께 둔다.

도입 순서를 뒤집지 않는 편이 좋다. 자동화부터 붙이면 규칙 없는 결과물이 대량으로 쏟아지므로, AGENTS.md로 저장소 규칙을 먼저 세우고 스킬로 반복 작업을 표준화한 다음 CI 연동으로 넘어가는 순서가 안정적이다.

## 관련 글

- [Codex란 무엇인가 — CLI·IDE·클라우드](/notes/codex/what-is-codex/)
- [설치와 config.toml 설정](/notes/codex/install-config/)
- [Codex Cloud와 CI 자동화 — exec·GitHub 연동](/notes/codex/cloud-ci-automation/)
