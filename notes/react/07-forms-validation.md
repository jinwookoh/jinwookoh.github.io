---
title: "폼 — 제어/비제어 컴포넌트와 검증"
series: react
part: "기능"
order: 7
summary: "입력값의 소유자를 React 상태로 둘지 DOM에 둘지 정하는 기준과, React 19 form action·useActionState로 검증·제출을 처리하는 방법"
tags: [React, controlled component, uncontrolled component, useActionState, form validation]
sources: [https://react.dev/reference/react-dom/components/input, https://react.dev/reference/react-dom/components/form, https://react.dev/reference/react/useActionState]
updated: 2026-08-30
---

`<input>`은 브라우저가 자체적으로 값을 들고 있는 요소이고, React 컴포넌트도 상태를 갖는다. 누가 값의 주인인지 정하지 않으면 타이핑해도 글자가 안 바뀌는 입력창, 초기값이 나중에 덮어써지는 버그가 생긴다. 제출 처리도 `preventDefault`·로딩 플래그·에러 상태·초기화 코드를 폼마다 반복하게 된다. ==React 19는 폼 제출을 프레임워크 차원의 개념으로 끌어올려 이 반복을 줄였다.==

## 핵심 개념

### 제어 컴포넌트와 비제어 컴포넌트

React는 `<input>`에 값을 넘기는 방식에 따라 두 모드를 구분한다.

| 구분 | 제어(controlled) | 비제어(uncontrolled) |
|---|---|---|
| 값의 소유자 | React 상태 | DOM 노드 |
| 사용 prop | `value` + `onChange` | `defaultValue` (필요 시 `ref`) |
| 읽는 시점 | 매 렌더마다 상태로 접근 | 제출 시 `ref.current.value` 또는 `FormData` |
| 적합한 경우 | 입력 즉시 반응(포맷팅·실시간 검증·연동 필드) | 단순 제출 폼, 파일 입력, 대형 폼 |

==`value`를 넘기는 순간 그 입력은 제어 컴포넌트가 된다.== `onChange`로 상태를 갱신하지 않으면 React가 같은 값을 다시 밀어 넣으므로 화면이 고정된다. `value`가 `undefined`였다가 문자열이 되면 비제어에서 제어로 바뀌는 셈이라 경고가 난다. `checkbox`·`radio`는 `checked`/`defaultChecked`로 같은 규칙을 따르고, `<input type="file">`은 값을 프로그램이 설정할 수 없으므로 항상 비제어다.

Spring MVC로 치면 제어 컴포넌트는 `@ModelAttribute` 바인딩 객체를 매 요청마다 뷰에 되돌리는 방식, 비제어 컴포넌트는 `getParameter`로 제출 시점에만 꺼내 쓰는 방식에 가깝다.

### `<form action>`과 Actions

React 19부터 `<form>`의 `action` prop에 URL 대신 함수를 넘길 수 있다. 제출 시 React가 기본 네비게이션을 막고 `FormData`를 그 함수에 전달하며, 완료되면 비제어 필드를 초기화한다. 이 함수가 Action이며 비동기여도 된다. `<button formAction={fn}>`으로 버튼마다 다른 Action을 붙일 수 있고, Server Components 환경에서는 `'use server'` 함수를 바로 넘긴다.

### `useActionState`

Action의 결과(검증 에러, 성공 메시지)를 보여 주려면 상태가 필요하다. `useActionState(action, initialState)`는 `[state, formAction, isPending]`을 돌려준다. 감싸진 `action`은 `(prevState, formData)`로 호출되고 반환값이 다음 `state`가 된다. `isPending`이 실행 중 여부를 알려 주므로 로딩 플래그가 따로 필요 없다. 하위 컴포넌트에서 제출 상태만 필요하면 `react-dom`의 `useFormStatus`를 쓴다. Spring의 `BindingResult`가 검증 결과를 뷰로 되돌리는 흐름과 대응된다.

### 검증의 층위

검증은 HTML 속성(`required`, `pattern`, `minLength`)으로 브라우저가 막는 층, 클라이언트 코드 층, 서버 층으로 나뉜다. ==첫째는 UI 통제가 어렵고, 둘째는 UX용이지 보안이 아니며, 셋째는 생략할 수 없다.== Action 안에서 검증하면 둘째·셋째 층이 코드 경로를 공유해 규칙이 갈라지는 문제가 줄어든다.

## 코드

제어 컴포넌트로 입력 즉시 포맷을 강제하는 예다. 숫자 외 문자를 걸러내는 로직이 `onChange`에 있어 상태와 화면이 항상 일치한다.

```tsx
import { useState } from 'react';

export function PhoneInput() {
  const [phone, setPhone] = useState('');

  return (
    <label>
      전화번호
      <input
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
        inputMode="numeric"
      />
    </label>
  );
}
```

비제어 필드를 `useActionState`와 결합한 회원가입 폼이다. 검증 실패 시 에러 객체를 반환하고, 성공하면 React가 필드를 비운다.

```tsx
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

type FormState = { errors: Record<string, string>; message?: string };

async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const errors: Record<string, string> = {};

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = '이메일 형식이 아니다';
  if (password.length < 8) errors.password = '8자 이상이어야 한다';
  if (Object.keys(errors).length) return { errors };

  const res = await fetch('/api/sign-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return { errors: { form: '가입에 실패했다' } };
  return { errors: {}, message: '가입 완료' };
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? '처리 중' : '가입'}</button>;
}

export function SignUpForm() {
  const [state, formAction, isPending] = useActionState(signUp, { errors: {} });

  return (
    <form action={formAction} aria-busy={isPending}>
      <input name="email" type="email" required defaultValue="" />
      {state.errors.email && <p role="alert">{state.errors.email}</p>}
      <input name="password" type="password" minLength={8} required />
      {state.errors.password && <p role="alert">{state.errors.password}</p>}
      {state.errors.form && <p role="alert">{state.errors.form}</p>}
      {state.message && <p>{state.message}</p>}
      <SubmitButton />
    </form>
  );
}
```

## 실무에서 걸리는 지점

- **제어 컴포넌트의 리렌더 비용.** 필드 30개가 하나의 객체 상태에 묶여 있으면 한 글자마다 폼 전체가 다시 그려진다. 필드별로 쪼개거나 즉시 반응이 필요 없는 필드는 비제어로 돌린다. React Hook Form이 기본을 비제어로 잡는 이유다.
- **제어와 비제어의 전환 경고.** 서버 데이터로 초기화할 때 `value={user?.name}`이 `undefined`가 되는 경우가 흔하다. `?? ''`로 막거나 데이터가 준비된 뒤 `key`로 폼을 다시 생성한다.
- ==**Action 실패 후 값 손실.** `<form action>`은 결과와 무관하게 제출이 끝나면 비제어 필드를 초기화한다.== 입력값을 유지하려면 반환 상태에 실어 `defaultValue`로 되돌리거나 해당 필드만 제어 컴포넌트로 둔다.
- **중복 제출.** `isPending` 동안 버튼을 비활성화해도 Enter 연타나 네트워크 재시도는 막지 못한다. 서버에서 멱등 키를 받는 편이 안전하다.
- **에러 표시 시점.** 타이핑 중 즉시 에러를 띄우면 화면 낭독기가 매 글자마다 알림을 읽는다. 검증은 `blur`나 제출 시점에 하고, 에러 문구는 `aria-describedby`로 입력과 연결한다.

## 관련 글

- [Props·State·이벤트](/notes/react/props-state-events/)
- [useRef·useMemo·useCallback과 렌더링 성능](/notes/react/useref-usememo-usecallback-performance/)
- [React 19 — Actions·use·Server Components](/notes/react/react19-actions-use-server-components/)
