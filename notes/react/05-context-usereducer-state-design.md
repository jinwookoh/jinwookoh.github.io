---
title: "Context·useReducer·상태 설계"
series: react
part: "Hooks와 상태"
order: 5
summary: "prop drilling은 Context로, 흩어진 setState는 reducer로 모으고, 상태 구조는 중복·모순이 없게 설계한다"
tags: [React, Context, useReducer, 상태 설계, prop drilling]
sources: [https://react.dev/learn/passing-data-deeply-with-context, https://react.dev/learn/extracting-state-logic-into-a-reducer, https://react.dev/learn/scaling-up-with-reducer-and-context, https://react.dev/learn/choosing-the-state-structure]
updated: 2026-08-30
---

컴포넌트 트리가 깊어지면 두 가지 문제가 동시에 나타난다. 첫째, 최상위에서 결정된 값(로그인 사용자, 테마, 현재 언어)을 말단 컴포넌트가 쓰려면 중간 컴포넌트들이 쓰지도 않는 prop을 계속 넘겨야 한다. 이른바 prop drilling이며, 중간 계층의 시그니처가 하위 요구사항에 끌려다니게 된다. 둘째, 하나의 상태를 바꾸는 이벤트 핸들러가 여러 곳에 흩어지면 "이 상태가 어떤 경로로 바뀌는지"를 한눈에 추적할 수 없다. React는 전자를 Context로, 후자를 reducer로 해결하며, 두 도구를 어떻게 쓰든 근본은 상태 구조 자체를 잘 잡는 데 있다.

## 핵심 개념

**Context**는 트리의 한 지점에서 값을 "제공"하면 그 아래 어느 깊이의 컴포넌트든 중간을 거치지 않고 "구독"할 수 있게 하는 통로다. `createContext(defaultValue)`로 만들고, 상위에서 `<MyContext value={...}>`로 감싸며, 하위에서 `useContext(MyContext)`로 읽는다. React 19부터는 `<MyContext.Provider>` 대신 Context 객체 자체를 JSX 태그로 써서 제공할 수 있고, 읽기 쪽에서는 조건문 안에서도 호출 가능한 `use(MyContext)`가 추가됐다. 값을 읽는 컴포넌트는 가장 가까운 상위 provider의 값을 받으며, provider가 없으면 `createContext`에 준 기본값을 받는다. 공식 문서는 Context를 꺼내기 전에 먼저 두 가지를 시도하라고 권한다. 하나는 그냥 prop을 넘기는 것이고, 다른 하나는 컴포넌트를 `children`으로 합성해서 중간 계층이 데이터를 몰라도 되게 만드는 것이다. 이 둘로 해결되지 않을 때 Context가 적절하다.

**useReducer**는 상태 갱신 로직을 컴포넌트 밖의 순수 함수 `reducer(state, action)`으로 분리한다. 이벤트 핸들러는 "무슨 일이 일어났는지"를 action 객체로 `dispatch`하고, 새 상태를 계산하는 책임은 reducer가 진다. `useState`와 같은 역할이지만 상태 전이가 여러 종류이고 서로 얽힐 때 읽기 쉽고 테스트하기 쉽다. reducer는 순수해야 하며 기존 상태를 직접 수정하지 않고 새 객체를 돌려준다. action 하나는 사용자 관점의 한 행위를 나타내야 한다.

두 도구를 합치면 reducer의 `state`와 `dispatch`를 각각 Context에 실어 트리 전체에 공급할 수 있다. ==상태와 dispatch를 별도 Context로 나누는 이유는, dispatch만 쓰는 컴포넌트가 상태 변경마다 다시 렌더링되는 것을 막기 위해서다.==

**상태 구조 설계** 원칙은 네 가지로 압축된다. 항상 같이 바뀌는 값은 하나로 묶고, 서로 모순될 수 있는 상태(예: `isSending`과 `isSent`를 따로 두는 것)는 하나의 `status`로 대체하며, 다른 상태나 prop에서 계산할 수 있는 값은 상태로 두지 않고 렌더링 중에 계산하고, 같은 데이터를 두 곳에 복제하지 않는다. 특히 선택된 항목 자체를 상태에 넣지 말고 id만 저장한 뒤 목록에서 찾는 방식이 복제를 피하는 대표 사례다.

Spring/Java와 대응하면 Context는 특정 스코프에 바인딩된 빈을 하위에서 주입받는 것과 비슷하고, reducer는 커맨드 객체를 받아 상태를 전이시키는 도메인 서비스, 정규화된 상태는 JPA 엔티티 그래프 대신 id 참조로 풀어낸 DTO에 가깝다.

## 코드

reducer 하나로 할 일 목록의 상태 전이를 정의한다. action의 `type`으로 분기하며 항상 새 배열을 반환한다.

```ts
// tasksReducer.ts
export type Task = { id: number; text: string; done: boolean };

export type TaskAction =
  | { type: "added"; id: number; text: string }
  | { type: "changed"; task: Task }
  | { type: "deleted"; id: number };

export function tasksReducer(tasks: Task[], action: TaskAction): Task[] {
  switch (action.type) {
    case "added":
      return [...tasks, { id: action.id, text: action.text, done: false }];
    case "changed":
      return tasks.map((t) => (t.id === action.task.id ? action.task : t));
    case "deleted":
      return tasks.filter((t) => t.id !== action.id);
  }
}
```

상태와 dispatch를 별도 Context로 나누고, 둘을 한 번에 공급하는 provider 컴포넌트와 읽기용 훅을 함께 내보낸다.

```tsx
// TasksContext.tsx
import { createContext, use, useReducer, type ReactNode, type Dispatch } from "react";
import { tasksReducer, type Task, type TaskAction } from "./tasksReducer";

const TasksContext = createContext<Task[]>([]);
const TasksDispatchContext = createContext<Dispatch<TaskAction>>(() => {});

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, dispatch] = useReducer(tasksReducer, []);
  return (
    <TasksContext value={tasks}>
      <TasksDispatchContext value={dispatch}>{children}</TasksDispatchContext>
    </TasksContext>
  );
}

export function useTasks() {
  return use(TasksContext);
}

export function useTasksDispatch() {
  return use(TasksDispatchContext);
}
```

소비 측은 provider 아래 어디에 있든 prop 없이 상태와 dispatch를 가져온다.

```tsx
// AddTask.tsx
import { useState } from "react";
import { useTasksDispatch } from "./TasksContext";

let nextId = 0;

export function AddTask() {
  const [text, setText] = useState("");
  const dispatch = useTasksDispatch();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        dispatch({ type: "added", id: nextId++, text });
        setText("");
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit">추가</button>
    </form>
  );
}
```

## 실무에서 걸리는 지점

- **Context 값이 바뀌면 구독자 전체가 다시 렌더링된다.** ==`value={{ user, theme }}`처럼 렌더링마다 새 객체를 만들면 내용이 같아도 매번 갱신으로 간주된다.== 객체는 `useMemo`로 묶고, 자주 바뀌는 값과 거의 안 바뀌는 값은 Context를 분리한다.
- **reducer 안에서 부수 효과를 일으키면 안 된다.** 네트워크 호출, 타이머, `Date.now()` 같은 비결정적 값을 reducer에 넣으면 StrictMode의 이중 호출에서 곧바로 드러난다. 부수 효과는 이벤트 핸들러나 `useEffect`에 두고 reducer에는 결과만 전달한다.
- **Context는 전역 상태 저장소가 아니다.** 서버 데이터 캐시, 낙관적 갱신, 셀렉터 기반 부분 구독이 필요하면 Context만으로 감당하기 어렵다. 그 경우 TanStack Query나 Zustand 같은 라이브러리를 쓰는 편이 낫고, Context는 의존성 주입 통로로만 남긴다.
- **기본값에 의존하는 설계는 버그를 숨긴다.** ==provider 없이도 동작하게 기본값을 그럴듯하게 주면 provider를 빠뜨려도 조용히 지나간다.== 기본값을 `null`로 두고 커스텀 훅에서 `null`이면 예외를 던지게 하면 배선 실수를 즉시 잡을 수 있다.
- **Server Components 경계를 넘지 못한다.** Context와 `useReducer`는 클라이언트 전용이므로 Next.js App Router에서는 provider 파일 상단에 `"use client"`가 필요하고, 서버 컴포넌트는 provider로 감싸는 역할만 할 수 있다.

## 관련 글

- [useState·useEffect — 상태와 부수 효과](/notes/react/usestate-useeffect/)
- [useRef·useMemo·useCallback과 렌더링 성능](/notes/react/useref-usememo-usecallback-performance/)
- [커스텀 훅과 데이터 페칭 (TanStack Query)](/notes/react/custom-hooks-data-fetching/)
