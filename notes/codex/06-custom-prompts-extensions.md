---
title: "커스텀 프롬프트와 확장 — 슬래시 커맨드·프로필"
series: codex
part: "확장"
order: 6
summary: "반복 지시를 슬래시 커맨드와 스킬로 묶고 실행 설정을 프로필로 분리하는 방법, 그리고 우선순위 함정을 정리한다"
tags: [Codex, Skills, Custom Prompts, Profiles, config.toml]
sources: [https://developers.openai.com/codex/custom-prompts, https://developers.openai.com/codex/local-config]
updated: 2026-09-05
---

에이전트를 쓰다 보면 같은 지시를 매번 다시 적게 된다. PR 설명 초안을 만드는 지시, 변경분을 컨벤션에 맞춰 커밋 메시지로 바꾸는 지시, 릴리스 노트를 뽑는 지시가 그런 것들이다. 사람이 기억으로 재구성하면 문장이 조금씩 달라지고 결과 품질도 같이 흔들린다. 실행 조건도 마찬가지다. 탐색용 질의는 저렴한 모델에 읽기 전용으로 돌리고 싶고, 리팩터링은 무거운 모델에 쓰기 권한을 주고 싶은데, 그때마다 플래그를 손으로 조합하면 실수로 위험한 조합을 넣게 된다. Codex는 반복 지시를 파일로, 실행 조건을 프로필로 떼어 낸다.

## 핵심 개념

반복 지시를 담는 수단은 커스텀 프롬프트와 스킬 두 가지다. 커스텀 프롬프트는 `~/.codex/prompts/` 아래 마크다운 파일 하나가 슬래시 커맨드 하나가 되는 구조로, `/prompts:파일명` 형태로 호출한다. 프런트매터에 `description`과 `argument-hint`를 적고, 본문에서 `$1`부터 `$9`까지의 위치 인자나 전체를 받는 `$ARGUMENTS`를 쓴다. 대문자 식별자를 쓰면 `KEY=value` 형태의 이름 붙은 인자가 되고, 리터럴 달러 기호는 `$$`로 적는다. 다만 커스텀 프롬프트는 폐기 예정으로 표시돼 있고, 공식 문서는 스킬을 권한다.

스킬은 `SKILL.md`를 담은 디렉터리다. 프런트매터에 `name`과 `description` 두 필드가 필요하고, 필요하면 `scripts/`·`references/`·`assets/`를 같은 디렉터리에 둔다. Codex는 현재 작업 디렉터리부터 저장소 루트까지 올라가며 `.agents/skills`를 훑고, 개인 스킬은 `$HOME/.agents/skills`, 조직 표준은 `/etc/codex/skills`에서 읽는다. 호출은 CLI에서 `$스킬명`으로 명시하거나, 프롬프트가 `description`과 맞으면 Codex가 알아서 고른다.

프로필은 실행 설정 묶음이다. `config.toml`에 `[profiles.<이름>]` 테이블로 `model`, `model_reasoning_effort`, `approval_policy`, `sandbox_mode` 조합을 저장해 두고 `codex --profile <이름>`으로 꺼내 쓴다. `approval_policy`는 `untrusted`·`on-request`·`never` 중 하나를 받는다. 설정은 여러 층에서 합쳐지며 우선순위는 CLI 플래그와 `--config`가 가장 높고, 그다음이 프로젝트 설정, 그다음이 프로필, 사용자 설정, 시스템 설정, 내장 기본값 순이다.

Spring에 대응시키면 프로필은 `application-{profile}.yml`과 활성 프로필 지정에 가깝고, 스킬은 클래스패스를 훑어 조건에 맞을 때 자동으로 올라오는 컴포넌트 스캔에 가깝다. `description`이 그 조건식 역할을 한다.

## 코드

커스텀 프롬프트는 인자 자리를 비워 둔 마크다운 한 장이다.

```markdown
---
description: 스테이징된 변경분으로 PR 설명 초안을 만든다
argument-hint: PR_TITLE=<제목>
---

`git diff --staged`를 읽고 PR 설명을 작성한다.
제목은 $PR_TITLE 을 그대로 쓴다.
본문은 변경 요약, 리뷰 포인트, 테스트 방법 세 절로 나눈다.
```

스킬은 언제 켜져야 하는지를 `description`에 적는 것이 핵심이다.

```markdown
---
name: db-migration-review
description: Flyway 마이그레이션 SQL이 추가·수정됐을 때 무중단 배포 관점으로 검토한다. 애플리케이션 코드 리뷰에는 쓰지 않는다.
---

`src/main/resources/db/migration` 아래 변경된 파일만 본다.
컬럼 삭제, NOT NULL 추가, 대상 테이블 잠금이 필요한 DDL을 찾아 단계 분리안을 제시한다.
```

프로필은 목적별로 나눠 두고 실행할 때 이름으로 고른다.

```toml
# ~/.codex/config.toml
model = "gpt-5.6"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.scan]
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
approval_policy = "untrusted"
sandbox_mode = "read-only"

[profiles.deep]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
```

## 실무에서 걸리는 지점

프롬프트 디렉터리는 ==최상위 파일만 스캔하므로 하위 폴더로 정리해 넣은 프롬프트는 슬래시 메뉴에 아예 뜨지 않는다==. 개수가 늘어도 한 층에 두고 파일명으로 구분해야 한다.

커스텀 프롬프트는 폐기 예정이다. ==새로 만드는 반복 지시는 스킬로 작성하는 편이 낫고, 스킬은 저장소에 커밋해 팀이 공유하고 암시적 호출도 받을 수 있다==. 이미 쌓인 프롬프트가 많다면 옮기는 비용이 커지므로 결정을 미루지 않는 편이 좋다.

스킬의 `description`은 문서용 설명이 아니라 선택 기준이다. 무엇을 하는지만 적고 언제 쓰지 말아야 하는지를 빼면, 관련 없는 작업에서 스킬이 끼어들어 엉뚱한 규칙을 적용한다.

프로필과 프로젝트 설정이 겹칠 때 ==프로젝트의 `.codex/config.toml`이 프로필보다 우선하므로, `--profile scan`으로 읽기 전용을 지정해도 프로젝트 설정의 `sandbox_mode`가 그대로 이긴다==. 안전 쪽으로 확실히 묶으려면 CLI 플래그를 쓴다.

프로필에 적지 않은 키는 사라지지 않고 하위 층에서 채워진다. 최소 권한 프로필을 만들 때는 `approval_policy`와 `sandbox_mode`를 둘 다 명시해야 상위 기본값이 새어 들어오지 않는다.

## 관련 글

- [설치와 config.toml 설정](/notes/codex/install-config/)
- [AGENTS.md — 프로젝트 규칙을 에이전트에게 전달](/notes/codex/agents-md/)
- [MCP 서버 연동](/notes/codex/mcp/)
