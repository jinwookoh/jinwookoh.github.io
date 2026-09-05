---
title: "훅 — 도구 호출 전후 자동화"
series: claude-code
part: "확장"
order: 6
summary: "모델의 판단에 맡기지 않고 포맷·차단·감사를 결정론적으로 강제하는 훅의 이벤트·입출력 규약을 정리한다."
tags: [Claude Code, hooks, PreToolUse, settings.json, automation]
sources: [https://code.claude.com/docs/en/hooks-guide, https://code.claude.com/docs/en/hooks]
updated: 2026-09-05
---

CLAUDE.md에 "편집 후에는 포맷터를 돌려라"라고 적어도 그것은 지시일 뿐이다. 모델이 대부분 따르지만 항상은 아니고, 대화가 길어질수록 누락 확률이 오른다. `.env`를 건드리지 말라는 규칙도 마찬가지다. 규칙을 어겼는지 사람이 diff를 보고 확인하는 구조에서는 CI가 잡아 주기 전까지 아무도 모른다. 훅은 이 지점을 프롬프트에서 런타임으로 옮긴다. 특정 시점에 반드시 실행되는 핸들러를 걸고, 그 결과로 도구 호출을 막거나 입력을 고쳐 쓴다.

## 핵심 개념

훅은 설정 파일의 `hooks` 블록에 선언하는 3단 중첩 구조다. 이벤트 이름이 키이고, 그 아래 `matcher`와 실제 핸들러 배열이 온다. Spring에 대응시키면 `PreToolUse`는 `HandlerInterceptor.preHandle` 또는 시큐리티 필터체인의 인가 필터, `PostToolUse`는 `@AfterReturning` 어드바이스, `SessionStart`는 `ApplicationReadyEvent` 리스너에 해당한다. 차이는 대상이 HTTP 요청이 아니라 에이전트의 도구 호출이라는 점이다.

이벤트는 세 가지 주기로 발화한다. 세션당 한 번인 `SessionStart`·`SessionEnd`, 턴당 한 번인 `UserPromptSubmit`·`Stop`, 도구 호출마다 발화하는 `PreToolUse`·`PostToolUse`·`PostToolUseFailure`다. 이 밖에 `PreCompact`, `SubagentStart`, `SubagentStop`, `ConfigChange`, `FileChanged` 등 상황별 이벤트가 있다.

`matcher`는 이벤트마다 거르는 대상이 다르다. 도구 이벤트에서는 도구 이름이고, `SessionStart`에서는 `startup`·`resume`·`clear`·`compact` 같은 세션 유형이다. 영숫자만 있으면 정확히 일치, 특수 문자가 섞이면 앵커 없는 정규식으로 취급한다. MCP 도구는 `mcp__<서버>__<도구>` 형태라 `mcp__memory__.*` 같은 패턴으로 묶는다.

핸들러 타입은 다섯 가지다. 셸을 실행하는 `command`, 이벤트를 POST하는 `http`, 연결된 MCP 서버 도구를 호출하는 `mcp_tool`, 그리고 판단이 필요한 경우를 위한 `prompt`와 `agent`다. `prompt`는 단발 모델 평가로 기본 Haiku를 쓰고, `agent`는 도구를 가진 다중 턴 검증이다.

입출력 규약은 단순하다. 훅은 stdin으로 이벤트 JSON을 받고 종료 코드로 결과를 알린다. ==0은 성공이며 이때만 stdout이 JSON으로 파싱되고, 2는 차단, 그 외 코드는 동작을 그대로 진행시키는 비차단 오류다.== 더 세밀한 제어는 stdout JSON의 `hookSpecificOutput.permissionDecision`, `additionalContext`, `systemMessage`, `updatedInput`으로 한다.

## 코드

편집이 끝날 때마다 Prettier를 돌리는 프로젝트 설정이다. `jq`로 편집된 경로만 뽑아 넘긴다.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      }
    ]
  }
}
```

보호 대상 파일 편집을 막는 스크립트다. 종료 코드 2로 차단하고 stderr 메시지가 모델에게 피드백으로 전달된다.

```bash
#!/bin/bash
# .claude/hooks/protect-files.sh
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
FILE_PATH="${FILE_PATH//\\//}"

PROTECTED=(".env" "package-lock.json" ".git/")
for pattern in "${PROTECTED[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo "Blocked: $FILE_PATH matches protected pattern '$pattern'" >&2
    exit 2
  fi
done
exit 0
```

같은 스크립트를 `PreToolUse`에 등록하고, 판단이 필요한 Bash 명령은 프롬프트 훅으로 넘기는 설정이다.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "이 명령이 운영 데이터에 되돌릴 수 없는 변경을 가하는지 판단한다: $ARGUMENTS",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## 실무에서 걸리는 지점

- ==`PreToolUse`는 권한 모드 검사보다 먼저 발화하므로 `bypassPermissions`에서도 `deny`가 유효하다.== 반대 방향은 성립하지 않아서, 훅이 `allow`를 반환해도 설정의 deny 규칙은 뚫지 못한다. 훅으로는 조일 수만 있고 풀 수는 없다.
- 같은 이벤트에 걸린 훅은 병렬로 실행되고 전부 끝까지 돈다. ==한 훅이 `deny`를 반환해도 형제 훅의 부작용은 이미 일어난 뒤다.== 로깅 훅과 차단 훅을 함께 걸면 차단된 명령도 로그에 남는다.
- `updatedInput`으로 도구 인자를 고쳐 쓰는 훅이 둘 이상이면 마지막에 끝난 것이 이기고, 병렬 실행이라 순서는 비결정적이다. 같은 도구의 입력을 두 훅이 건드리게 두지 않는다.
- ==셸 프로필의 무조건적인 `echo` 출력이 훅 stdout 앞에 붙으면 JSON 전체가 평문으로 취급되고, 종료 코드 0에서는 경고조차 뜨지 않는다.== 프로필의 출력은 대화형 셸 조건으로 감싼다.
- `Stop` 훅이 연속 8회 차단하면 무시된다. `stop_hook_active` 필드를 확인해 조기 종료하지 않으면 턴이 경고와 함께 끝난다.
- 타임아웃 기본값은 `command`·`http`·`mcp_tool`이 10분, `prompt`가 30초, `agent`가 60초다. `UserPromptSubmit`은 30초로 낮춰 잡히고 `SessionEnd`는 전체 1.5초 예산을 공유하므로 무거운 정리 작업을 넣으면 잘린다.

## 관련 글

- [설정과 권한 모델 — settings.json·permission mode](/notes/claude-code/settings-permissions/)
- [서브에이전트 — 작업 분리와 병렬화](/notes/claude-code/subagents/)
- [MCP 서버 연동 — 외부 도구와 데이터 연결](/notes/claude-code/mcp/)
