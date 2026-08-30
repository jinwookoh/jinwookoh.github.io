---
title: "Props·State·이벤트"
series: react
part: "기초"
order: 2
summary: "부모가 내려주는 읽기 전용 입력(props), 컴포넌트가 기억하는 값(state), 그리고 둘을 잇는 이벤트 핸들러의 역할 구분"
tags: [React, props, state, useState, event handler]
sources: [https://react.dev/learn/passing-props-to-a-component, https://react.dev/learn/state-a-components-memory, https://react.dev/learn/responding-to-events]
updated: 2026-08-30
---

컴포넌트가 화면을 그리려면 두 종류의 데이터가 필요하다. 바깥에서 주어지는 값과, 사용자의 조작에 따라 스스로 바뀌는 값이다. 이 둘을 구분하지 않고 지역 변수에 담아 처리하면 문제가 생긴다. 함수 컴포넌트는 렌더링마다 처음부터 다시 실행되므로 지역 변수는 매번 초기화되고, 변수를 바꿔도 React는 그 사실을 알지 못해 화면을 갱신하지 않는다. ==React는 이 문제를 props와 state라는 두 채널로 풀고, 사용자 입력은 이벤트 핸들러를 통해 state 변경으로 연결한다.==

## 핵심 개념

### Props — 부모가 내려주는 읽기 전용 입력

props는 JSX 태그에 적은 속성이 컴포넌트 함수의 첫 번째 인자로 묶여 전달되는 객체다. 문자열·숫자·객체·배열·함수는 물론 다른 JSX 요소도 넘길 수 있다. 태그 사이에 넣은 내용은 `children`이라는 이름으로 들어온다. 전달되지 않은 값에는 구조 분해 시 기본값을 지정하며, 기본값은 `undefined`일 때만 적용되고 `null`에는 적용되지 않는다.

==props는 불변이다.== 자식이 받은 props 객체를 직접 수정해서는 안 되고, 다른 값이 필요하면 부모에게 새 props를 내려 달라고 요청해야 한다. 이 요청은 보통 부모가 넘겨준 콜백 함수를 호출하는 방식으로 이루어진다. 즉 데이터는 위에서 아래로, 변경 요청은 아래에서 위로 흐른다.

Spring에 대응시키면 props는 생성자 주입으로 받은 final 필드에 가깝다. 외부에서 결정되고, 받은 쪽에서는 바꾸지 않는다.

### State — 컴포넌트가 기억하는 값

state는 렌더링 사이에서 살아남고, 바뀌면 React가 다시 렌더링하도록 만드는 값이다. `useState(초기값)`를 호출하면 현재 값과 setter 함수를 배열로 돌려준다. setter를 호출하면 값이 저장되고 해당 컴포넌트에 다음 렌더링이 예약된다. 다음 실행에서 `useState`는 저장된 값을 돌려주므로 컴포넌트는 이전 상태를 이어 간다.

state는 컴포넌트 인스턴스마다 독립적이다. 같은 컴포넌트를 두 번 렌더링하면 각각 별도의 state를 가지며, 부모도 자식의 state를 알지 못한다. 공유가 필요하면 state를 공통 부모로 끌어올리고 props로 내려준다.

==훅은 컴포넌트 최상위에서만 호출해야 한다.== React는 훅을 호출 순서로 식별하므로 조건문이나 반복문 안에서 호출하면 순서가 어긋난다.

| 구분 | props | state |
|---|---|---|
| 소유자 | 부모 | 컴포넌트 자신 |
| 변경 | 부모가 새 값을 내려줌 | setter 호출 |
| 성격 | 함수의 매개변수 | 함수 실행 사이의 메모리 |

### 이벤트 — 사용자 입력을 state 변경으로

이벤트 핸들러는 `onClick`, `onChange` 같은 prop으로 JSX 요소에 넘기는 함수다. 함수 자체를 넘겨야 하며 `onClick={handleClick()}`처럼 호출 결과를 넘기면 렌더링 시점에 실행된다. 핸들러는 컴포넌트 안에 정의되므로 props와 state에 접근할 수 있고, 자식 컴포넌트에 `onSelect` 같은 이름의 prop으로 핸들러를 내려 보내면 이벤트가 부모의 state를 바꾸는 구조가 된다.

이벤트는 DOM 트리를 따라 위로 전파된다. `e.stopPropagation()`으로 전파를 끊고, `e.preventDefault()`로 폼 제출 같은 기본 동작을 막는다. Spring MVC의 `@RestController` 메서드가 요청을 받아 서비스 상태를 바꾸듯, 핸들러는 사용자 입력을 받아 state를 바꾸는 진입점이다.

## 코드

부모가 props로 데이터와 콜백을 내리고, 자식은 받은 값을 그대로 표시한다.

```tsx
type UserCardProps = {
  name: string;
  role?: string;
  onSelect: (name: string) => void;
  children?: React.ReactNode;
};

function UserCard({ name, role = "member", onSelect, children }: UserCardProps) {
  return (
    <section>
      <h3>{name}</h3>
      <p>{role}</p>
      <button onClick={() => onSelect(name)}>선택</button>
      {children}
    </section>
  );
}
```

`useState`로 값을 기억하고, 이벤트 핸들러에서 setter를 호출한다. 두 개의 state는 서로 독립적으로 관리된다.

```tsx
import { useState } from "react";

const users = ["jinwoo", "minji", "sungho"];

export function UserList() {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  function handleNext() {
    setIndex((prev) => (prev + 1) % users.length);
  }

  return (
    <div>
      <UserCard name={users[index]} onSelect={setSelected}>
        <small>{selected ? `선택됨: ${selected}` : "미선택"}</small>
      </UserCard>
      <button onClick={handleNext}>다음</button>
    </div>
  );
}
```

전파 차단과 기본 동작 방지를 함께 처리하는 폼 예제다.

```tsx
export function SearchForm({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState("");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSearch(query.trim());
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <button type="submit" onClick={(e) => e.stopPropagation()}>검색</button>
    </form>
  );
}
```

## 실무에서 걸리는 지점

- ==**setter 호출 직후 값을 읽는 코드.** setter는 다음 렌더링을 예약할 뿐 현재 실행 중인 함수의 변수를 바꾸지 않는다.== 같은 핸들러 안에서 여러 번 갱신하려면 `setCount(prev => prev + 1)`처럼 이전 값을 받는 함수형 갱신을 쓴다.
- **객체·배열 state의 직접 변경.** `state.items.push(x)` 후 setter에 같은 참조를 넘기면 React는 변경을 감지하지 못한다. 스프레드나 `map`·`filter`로 새 객체를 만들어 넘겨야 한다.
- **props를 state의 초기값으로 복사하는 패턴.** `useState(props.value)`는 첫 렌더링에서만 초기값을 읽으므로 이후 부모가 다른 값을 내려도 반영되지 않는다. 파생 값은 렌더링 중에 계산하고, 진짜 편집 상태만 state로 둔다.
- **인라인 화살표 함수와 자식 리렌더링.** 렌더링마다 새 함수가 만들어져 `memo`로 감싼 자식도 다시 그려진다. 대부분은 문제되지 않지만 리스트 항목이 많다면 4편에서 다루는 `useCallback`을 검토한다.
- **`onClick={fn()}` 형태의 즉시 호출.** 렌더링마다 함수가 실행되고 setter가 들어 있으면 무한 렌더링에 빠진다. 인자가 필요하면 `onClick={() => fn(arg)}`로 감싼다.

## 관련 글

- [React란 — 컴포넌트·JSX·렌더링 모델](/notes/react/what-is-react-jsx-rendering/)
- [useState·useEffect — 상태와 부수 효과](/notes/react/usestate-useeffect/)
- [useRef·useMemo·useCallback과 렌더링 성능](/notes/react/useref-usememo-usecallback-performance/)
