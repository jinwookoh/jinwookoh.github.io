---
title: "설정과 권한 모델 — settings.json·permission mode"
series: claude-code
part: "기초"
order: 3
summary: "권한 규칙은 deny·ask·allow 순으로 첫 일치가 결과를 결정하며, 와일드카드 위치가 허용 범위를 좌우한다"
tags: [settings.json, permissions, permission mode, Claude Code, workspace trust]
sources: [https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/iam]
updated: 2026-09-05
---

에이전트에게 셸을 쥐여 주면 두 가지 실패가 번갈아 나타난다. 모든 동작을 승인하게 하면 열 번째 프롬프트부터는 읽지 않고 통과시키게 되고, 승인을 통째로 끄면 되돌릴 수 없는 명령이 조용히 실행된다. 그 사이를 메우는 것이 규칙 파일이다. 어떤 명령을 묻지 않고 허용할지, 어떤 경로는 읽는 것조차 막을지를 저장소에 커밋해 두면 팀 전원이 같은 경계를 공유하고, 각자는 자기 파일에서 예외만 더한다.

## 핵심 개념

설정은 JSON 파일 네 계층으로 나뉜다. 우선순위는 관리 설정, `--settings` 플래그, 프로젝트 로컬, 공유 프로젝트, 사용자 순이며 위쪽이 아래쪽을 덮는다.

| 범위 | 파일 | 적용 대상 |
|---|---|---|
| 관리 | `managed-settings.json`, MDM, 콘솔 | 조직이 배포한 모든 머신 |
| 프로젝트 로컬 | `.claude/settings.local.json` | 본인, 이 프로젝트만 |
| 공유 프로젝트 | `.claude/settings.json` | 저장소를 클론한 전원 |
| 사용자 | `~/.claude/settings.json` | 본인의 모든 프로젝트 |

같은 키를 여러 파일이 설정하면 스칼라 값은 우선순위대로 하나가 이기지만, `permissions.allow` 같은 리스트 키는 덮어쓰지 않고 합쳐진다. 조직이 깐 허용 규칙 위에 개인 규칙이 더해지는 구조다.

권한 규칙은 `Tool` 또는 `Tool(specifier)` 형태로 쓴다. 평가 순서는 deny, ask, allow로 고정돼 있고 그 순서에서 처음 일치한 규칙이 결과를 정한다. Spring Security의 요청 매처 체인이 선언 순서대로 첫 일치를 채택하는 것과 같은 방식이며, ==규칙이 더 구체적이라고 순서가 앞당겨지지 않기 때문에 `Bash(aws *)` 같은 넓은 deny에는 예외를 둘 수 없다.== 도구 이름만 쓴 deny는 그 도구를 컨텍스트에서 아예 제거하고, 괄호로 범위를 좁힌 deny는 도구는 남긴 채 매칭되는 호출만 막는다.

Bash 규칙은 명령 문자열 전체에 매칭되며 `*`가 임의 텍스트를 대신한다. 와일드카드를 어디에 두느냐가 곧 허용 범위다. `*` 앞의 단어들은 문자 그대로 매칭되므로 `Bash(git log *)`는 `git log` 계열만 허용하지만 `Bash(git *)`는 모든 git 하위 명령을 허용한다. 셸 연산자도 인식해서 `&&`, `||`, `;`, `|`로 이어 붙인 복합 명령은 각 하위 명령이 개별적으로 규칙에 걸려야 통과한다.

파일 경로 규칙에는 앵커가 세 종류 있다. `//path`는 파일시스템 루트 기준 절대 경로, `~/path`는 홈 디렉터리 기준, 앞의 `/`는 규칙이 적힌 설정 파일의 기준 디렉터리 상대 경로다. 사용자 설정에 적은 `Read(/secrets/**)`는 프로젝트의 `secrets`가 아니라 `~/.claude/secrets/**`를 막는다.

권한 모드는 규칙 위의 기본선이다. 세션 중에는 `Shift+Tab`으로 순환하고, 시작 모드는 `--permission-mode` 플래그나 `permissions.defaultMode`로 정한다. Manual 모드의 설정값은 `default`이며 `manual`이 별칭이다.

## 코드

린트와 테스트, 커밋은 묻지 않고 실행하되 푸시는 확인을 받고 비밀 파일은 읽지 못하게 하는 팀 공유 설정이다.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(pnpm run lint)",
      "Bash(pnpm run test *)",
      "Bash(git commit *)",
      "Read(src/**)"
    ],
    "ask": ["Bash(git push *)"],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Edit(//etc/**)",
      "Bash(rm -rf *)"
    ],
    "additionalDirectories": ["../shared-types"]
  }
}
```

조직 관리 설정에서 위험한 모드를 아예 제거한다. 개인 파일에서 되돌릴 수 없다.

```json
{
  "permissions": {
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "disableAutoMode": "disable"
  }
}
```

CI에서는 사전 승인 목록만 허용하는 모드로 고정한다. 목록 밖 도구는 프롬프트 없이 거부된다.

```bash
claude -p "테스트 스위트를 실행하고 실패를 요약해" \
  --permission-mode dontAsk \
  --allowedTools "Bash(pnpm test)" "Read"

# 파일을 저장하지 않고 한 세션에만 키를 적용
claude --settings '{"permissions":{"defaultMode":"plan"}}'
```

## 실무에서 걸리는 지점

- **와일드카드 위치를 잘못 두면 규칙이 무력해진다.** `Bash(git * main)`은 `*`가 하위 명령 자리를 대신하므로 `git push origin main`까지 허용한다. 끝의 `*` 앞 공백도 의미가 있어서 ==`Bash(ls *)`는 `lsof`에 매칭되지 않지만 공백 없는 `Bash(ls*)`는 `lsof`까지 허용한다.==
- **경로 규칙은 Read와 Edit로만 검사한다.** ==`Write(docs/**)`나 `Glob(docs/**)` 같은 규칙은 저장은 되지만 권한 검사에 쓰이지 않는다.== 쓰기는 `Edit(docs/**)`, 탐색은 `Read(docs/**)`로 적어야 실제로 걸린다.
- **프로젝트 allow 규칙은 신뢰 수락 전까지 놀고 있다.** ==`.claude/settings.json`의 `permissions.allow`와 `additionalDirectories`는 해당 폴더의 워크스페이스 신뢰 대화를 수락한 뒤에야 적용된다.== deny와 ask는 제한만 하므로 즉시 적용된다. 팀원이 클론한 뒤 여전히 프롬프트를 본다면 대개 이 단계가 남아 있다.
- **프로젝트 파일이 설정하지 못하는 값이 있다.** `permissions.defaultMode`의 `auto`와 `bypassPermissions`는 프로젝트나 로컬 설정에서 적용되지 않는다. 사용자 설정이나 관리 설정에 두거나 플래그로 한 세션만 지정한다.
- **설정 파일은 엄격한 JSON이다.** `//` 주석이나 후행 쉼표는 문법 오류이고, 파일이 깨지면 그 파일은 통째로 건너뛴다. `-p` 실행은 오류 대화를 띄우지 않으므로 무시된 항목은 `claude doctor`로 확인한다.
- **어떤 파일이 읽혔는지 먼저 확인한다.** 값이 안 먹으면 `/status`의 설정 소스 줄로 로드된 파일을 확인하고, 규칙 목록과 출처 파일은 `/permissions`에서 본다.

## 관련 글

- [Claude Code란 무엇인가 — 설치와 기본 사용법](/notes/claude-code/what-is-claude-code/)
- [CLAUDE.md와 메모리 — 프로젝트 컨텍스트 관리](/notes/claude-code/claude-md-memory/)
- [훅 — 도구 호출 전후 자동화](/notes/claude-code/hooks/)
