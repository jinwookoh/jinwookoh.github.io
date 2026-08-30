---
title: "useRef·useMemo·useCallback과 렌더링 성능"
series: react
part: "Hooks와 상태"
order: 4
summary: "리렌더링 사이에 값·계산·함수를 어떻게 유지하고, 언제 메모이제이션이 실제 성능 이득이 되는지 정리한다."
tags: [React, useRef, useMemo, useCallback, memo]
sources: [https://react.dev/reference/react/useRef, https://react.dev/reference/react/useMemo, https://react.dev/reference/react/useCallback, https://react.dev/reference/react/memo]
updated: 2026-08-30
---

React 함수 컴포넌트는 렌더링마다 함수 본문 전체를 다시 실행한다. 지역 변수와 본문 안에서 정의한 함수·객체는 매번 새 참조가 된다. 그래서 세 가지 문제가 생긴다. 렌더링과 무관하게 유지해야 하는 값(타이머 ID, DOM 노드)을 둘 곳이 없고, 입력이 같아도 비싼 계산을 반복하며, 자식에게 넘기는 콜백과 객체가 매번 새 참조라서 `memo`로 감싼 자식이 불필요하게 다시 렌더링되고 `useEffect` 의존성이 매번 바뀐 것으로 판정된다. `useRef`, `useMemo`, `useCallback`은 각각 이 세 문제를 다루는 도구다.

## 핵심 개념

`useRef(initialValue)`는 `{ current: initialValue }` 객체 하나를 반환하며, 마운트된 동안 같은 객체를 계속 돌려준다. `current`를 바꿔도 리렌더링은 일어나지 않는다. state는 화면에 반영되어야 하는 값이고, ref는 화면과 무관하게 기억만 하면 되는 값이다. JSX의 `ref` 속성에 넘기면 커밋 단계에서 DOM 노드가 `current`에 채워진다. 렌더링은 순수해야 하므로 렌더링 중에 `ref.current`를 읽거나 쓰지 않고, 이벤트 핸들러나 effect 안에서 다룬다.

`useMemo(calculateValue, dependencies)`는 첫 렌더링에 계산 함수를 호출해 결과를 저장하고, 이후에는 의존성 배열 요소를 `Object.is`로 비교해 하나라도 달라졌을 때만 다시 계산한다. 계산 함수는 렌더링 중에 실행되므로 순수해야 한다.

`useCallback(fn, dependencies)`는 `useMemo(() => fn, dependencies)`와 같다. 함수 실행 결과가 아니라 함수 정의 자체를 캐시해 자식에 넘길 때 참조가 유지되게 한다.

`memo(Component, arePropsEqual?)`는 훅이 아니라 컴포넌트 래퍼다. 부모가 리렌더링될 때 각 prop을 `Object.is`로 비교해 모두 같으면 자식 렌더링을 건너뛴다. 인라인 객체나 함수가 하나라도 있으면 항상 다르다고 판정되어 무력화되며, `useMemo`·`useCallback`이 의미를 갖는 지점이 여기다. 반대로 `memo` 자식이나 effect 의존성으로 가지 않는 함수를 `useCallback`으로 감싸는 것은 비교 비용만 더한다.

| 훅 | 유지 대상 | 변경 시 리렌더링 | 주 용도 |
|---|---|---|---|
| useRef | 임의의 값(객체 1개) | 없음 | DOM 노드, 타이머, 이전 값 |
| useMemo | 계산 결과 | 의존성 변경 시 재계산 | 비싼 필터·정렬, 참조 안정화 |
| useCallback | 함수 참조 | 의존성 변경 시 새 함수 | memo 자식·effect에 넘기는 콜백 |

Spring/Java와 대응시키면, `useRef`는 스코프 밖에 두는 인스턴스 필드에 가깝고, `useMemo`는 `@Cacheable`이 붙은 순수 메서드처럼 인자(의존성)가 같으면 결과를 재사용한다. `memo`는 입력이 같으면 뷰 템플릿 렌더링을 건너뛰는 캐시 레이어로 볼 수 있다.

React 19와 함께 공개된 React Compiler는 이 메모이제이션을 빌드 시 자동으로 삽입한다. 적용 프로젝트에서는 수동 `useMemo`·`useCallback`이 대부분 불필요해지지만, 언제 참조가 바뀌는지 이해하는 것은 여전히 필요하다.

## 코드

타이머 ID를 ref에 두어 리렌더링과 무관하게 유지하고, DOM 노드 ref로 포커스를 제어한다.

```tsx
import { useRef, useState } from "react";

export function Stopwatch() {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function start() {
    if (intervalRef.current !== null) return;
    intervalRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
  }

  function stop() {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    inputRef.current?.focus();
  }

  return (
    <div>
      <p>{elapsed}s</p>
      <button onClick={start}>Start</button>
      <button onClick={stop}>Stop</button>
      <input ref={inputRef} placeholder="lap note" />
    </div>
  );
}
```

비싼 필터·정렬을 `useMemo`로 감싸고, `memo` 자식에 넘기는 콜백을 `useCallback`으로 고정한다. `theme`만 바뀌는 리렌더링에서는 정렬이 다시 실행되지 않고 `TodoList`도 다시 렌더링되지 않는다.

```tsx
import { memo, useCallback, useMemo, useState } from "react";

type Todo = { id: number; text: string; done: boolean };

const TodoList = memo(function TodoList({
  items,
  onToggle,
}: {
  items: Todo[];
  onToggle: (id: number) => void;
}) {
  return (
    <ul>
      {items.map((t) => (
        <li key={t.id} onClick={() => onToggle(t.id)}>
          {t.done ? "✔ " : ""}{t.text}
        </li>
      ))}
    </ul>
  );
});

export function TodoApp({ theme }: { theme: "light" | "dark" }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () =>
      todos
        .filter((t) => t.text.includes(query))
        .sort((a, b) => a.text.localeCompare(b.text)),
    [todos, query],
  );

  const toggle = useCallback((id: number) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
  }, []);

  return (
    <section data-theme={theme}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <TodoList items={visible} onToggle={toggle} />
    </section>
  );
}
```

`toggle`은 setter의 함수형 업데이트를 사용하므로 `todos`를 의존성에 넣지 않아도 되고, 결과적으로 마운트 후 참조가 한 번도 바뀌지 않는다.

## 실무에서 걸리는 지점

- 측정 없이 감싸지 않는다. 두 훅은 의존성 비교와 클로저 생성 비용이 있으므로, 계산이 실제로 무겁거나 결과가 `memo` 자식·effect 의존성으로 흘러갈 때만 이득이다. React DevTools Profiler로 원인을 확인한 뒤 적용한다.
- `memo`는 prop 하나만 새 참조여도 무효가 된다. 콜백은 고정했는데 `style={{ ... }}` 같은 인라인 객체를 같이 넘기면 매번 리렌더링된다. props 전체를 안정화하거나 `memo`를 걷어낸다.
- 화면에 보여야 할 값을 ref에 두면 갱신되지 않는다. ref 변경은 리렌더링을 유발하지 않으므로, 화면에 반영할 값은 state로, 그렇지 않은 값만 ref로 둔다.
- 의존성을 빼는 방식으로 참조를 고정하지 않는다. `react-hooks/exhaustive-deps`를 끄고 `[]`로 두면 이전 state를 붙든 stale closure 버그가 생긴다. setter의 함수형 업데이트나 상태 위치 변경으로 의존성을 줄인다.
- `useMemo`는 의미적 보장이 아니다. React는 필요하면 캐시를 버리고 다시 계산할 수 있다. "한 번만 실행"을 보장해야 하는 초기화는 ref나 state 초기화 함수로 처리한다.
- React Compiler를 도입했다면 규칙 위반(렌더링 중 변이 등)이 있는 컴포넌트는 최적화에서 제외된다. lint 플러그인이 알려 주는 위반부터 정리한다.

## 관련 글

- [useState·useEffect — 상태와 부수 효과](/notes/react/usestate-useeffect/)
- [Context·useReducer·상태 설계](/notes/react/context-usereducer-state-design/)
- [React 19 — Actions·use·Server Components](/notes/react/react19-actions-use-server-components/)
