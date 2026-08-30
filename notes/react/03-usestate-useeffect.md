---
title: "useState·useEffect — 상태와 부수 효과"
series: react
part: "Hooks와 상태"
order: 3
summary: "useState는 렌더링 사이에 값을 보존하고, useEffect는 React 밖의 시스템과 동기화할 때만 쓴다."
tags: [React, useState, useEffect, Hooks, 부수 효과]
sources: [https://react.dev/reference/react/useState, https://react.dev/reference/react/useEffect, https://react.dev/learn/synchronizing-with-effects, https://react.dev/learn/you-might-not-need-an-effect]
updated: 2026-08-30
---

함수 컴포넌트는 렌더링마다 처음부터 다시 실행된다. 지역 변수는 실행이 끝나면 사라지고, 값을 바꿔도 React는 다시 그릴 이유를 알지 못한다. 반대로 렌더링 함수 안에서 네트워크 요청이나 구독 등록 같은 일을 직접 하면, 렌더링이 반복될 때마다 요청이 중복 발생하고 정리 시점도 없다. 렌더링 사이에 살아남는 값과, 렌더링 결과를 외부 시스템에 반영하는 통로가 각각 필요하다. 전자가 `useState`, 후자가 `useEffect`다.

## 핵심 개념

`useState(initial)`는 `[state, setState]` 쌍을 반환한다. 첫 렌더링에서만 `initial`을 사용하고, 이후 렌더링에서는 저장된 값을 돌려준다. `setState(next)`를 호출하면 React는 다음 렌더링을 예약하고, 그 렌더링에서 새 값을 돌려준다. 호출 직후에 `state`를 읽어도 값은 바뀌지 않는다. 상태는 렌더링마다 찍힌 스냅샷이며, 한 렌더링의 모든 코드는 같은 값을 본다.

몇 가지 규칙이 동작을 결정한다. 여러 `setState` 호출은 이벤트 핸들러가 끝날 때까지 배치되어 한 번의 렌더링으로 합쳐진다. 이전 값에 의존하는 갱신은 `setState(prev => prev + 1)` 형태의 갱신 함수를 넘겨야 순서가 보장된다. 새 값이 이전 값과 `Object.is`로 같으면 React는 렌더링을 건너뛴다. 객체와 배열은 직접 변경하지 말고 새 객체를 만들어 넘겨야 이 비교가 의미를 가진다. 초기값 계산이 비싸면 `useState(() => compute())`처럼 함수를 넘겨 첫 렌더링에서만 실행되게 한다.

`useEffect(setup, deps)`는 렌더링 결과가 화면에 반영된 뒤 `setup`을 실행한다. `setup`이 함수를 반환하면 그것이 정리(cleanup) 함수가 된다. 의존성 배열의 값이 이전 렌더링과 달라지면 React는 먼저 이전 정리 함수를 실행하고, 새 값으로 `setup`을 다시 실행한다. 컴포넌트가 언마운트될 때도 정리 함수가 호출된다. 의존성 배열을 생략하면 매 렌더링마다, 빈 배열이면 마운트 시 한 번만(개발 모드 Strict Mode에서는 마운트·정리·재마운트로 두 번) 실행된다.

핵심은 Effect가 "이벤트에 대한 반응"이 아니라 "동기화"라는 점이다. Effect는 특정 렌더링 결과를 외부 시스템(DOM API, 브라우저 구독, 서버 연결, 타이머)과 맞추는 코드이며, 사용자 행동에 대한 응답은 이벤트 핸들러에 둔다. 공식 문서가 강조하는 대로, 상태로부터 계산할 수 있는 값이나 부모에게 알리는 로직에는 Effect가 필요 없다.

Spring/Java와 대응시키면 `useState`는 요청 스코프 빈에 보관된 필드와 비슷하지만 수정이 아니라 교체로만 갱신되고, `useEffect`의 setup/cleanup 쌍은 `@PostConstruct`/`@PreDestroy` 또는 `InitializingBean`/`DisposableBean`에 가깝다. 다만 라이프사이클이 빈 생성 한 번이 아니라 의존성이 바뀔 때마다 반복된다는 점이 다르다.

## 코드

카운터에서 갱신 함수 사용 여부에 따라 결과가 달라지는 예제다. 첫 버튼은 같은 스냅샷을 세 번 읽어 1만 증가하고, 두 번째 버튼은 큐에 쌓인 갱신을 순서대로 적용해 3 증가한다.

```tsx
import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>{count}</p>
      <button
        onClick={() => {
          setCount(count + 1);
          setCount(count + 1);
          setCount(count + 1); // 결과: +1
        }}
      >
        +1 (snapshot)
      </button>
      <button
        onClick={() => {
          setCount((c) => c + 1);
          setCount((c) => c + 1);
          setCount((c) => c + 1); // 결과: +3
        }}
      >
        +3 (updater)
      </button>
    </div>
  );
}
```

`roomId`가 바뀔 때마다 이전 연결을 끊고 새 연결을 여는 동기화 Effect다. 정리 함수가 없으면 방을 옮길 때마다 연결이 누적된다.

```tsx
import { useEffect, useState } from "react";
import { createConnection } from "./chat";

type Props = { roomId: string };

export function ChatRoom({ roomId }: Props) {
  const [status, setStatus] = useState<"connecting" | "connected">("connecting");

  useEffect(() => {
    const connection = createConnection(roomId);
    connection.on("connected", () => setStatus("connected"));
    connection.connect();

    return () => {
      connection.disconnect();
      setStatus("connecting");
    };
  }, [roomId]);

  return <p>{roomId}: {status}</p>;
}
```

데이터 페칭을 Effect로 직접 구현할 때는 응답 순서가 뒤바뀌는 경쟁 상태를 정리 함수로 막는다.

```tsx
import { useEffect, useState } from "react";

type User = { id: string; name: string };

export function UserName({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let ignore = false;

    fetch(`/api/users/${userId}`)
      .then((res) => res.json() as Promise<User>)
      .then((data) => {
        if (!ignore) setUser(data);
      });

    return () => {
      ignore = true;
    };
  }, [userId]);

  return <span>{user?.name ?? "..."}</span>;
}
```

## 실무에서 걸리는 지점

- **파생 상태를 Effect로 만드는 패턴.** `fullName`을 `firstName`·`lastName`에서 Effect로 계산해 `setState`하면 렌더링이 두 번 일어나고 한 프레임 동안 불일치 상태가 노출된다. 렌더링 중에 계산하거나, 비용이 크면 `useMemo`로 감싼다.
- **의존성 배열 조작.** 린트 경고를 피하려고 의존성을 빼면 Effect가 오래된 값(stale closure)을 참조한다. 의존성이 너무 많다면 Effect가 하는 일을 쪼개거나, 객체·함수를 Effect 안에서 만들거나, 이벤트 로직을 핸들러로 옮겨 근본 원인을 없앤다.
- **Strict Mode의 이중 실행.** 개발 환경에서 마운트 Effect가 두 번 실행되는 것은 버그가 아니라 정리 함수의 누락을 드러내는 장치다. "한 번만 실행"을 위해 ref 플래그를 두기보다 setup과 cleanup이 대칭이 되도록 고친다. 앱 전체에서 한 번만 실행할 초기화는 모듈 최상위로 뺀다.
- **객체·배열 직접 변경.** `state.items.push(x)` 후 `setState(state)`는 `Object.is` 비교를 통과하지 못해 렌더링이 생략된다. 스프레드나 `map`·`filter`로 새 값을 만들어 넘긴다.
- **Effect 기반 페칭의 한계.** 위 예제의 `ignore` 플래그는 경쟁 상태만 막을 뿐 캐시·중복 제거·재시도는 해결하지 못하고, SSR 환경에서는 클라이언트 워터폴을 만든다. 프레임워크의 데이터 페칭 계층이나 TanStack Query 같은 라이브러리로 올리는 것이 일반적인 선택이다.

## 관련 글

- [Props·State·이벤트](/notes/react/props-state-events/)
- [useRef·useMemo·useCallback과 렌더링 성능](/notes/react/useref-usememo-usecallback-performance/)
- [커스텀 훅과 데이터 페칭 (TanStack Query)](/notes/react/custom-hooks-data-fetching/)
