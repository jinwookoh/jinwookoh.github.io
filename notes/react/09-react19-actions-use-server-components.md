---
title: "React 19 — Actions·use·Server Components"
series: react
part: "최신과 운영"
order: 9
summary: "폼 제출·비동기 상태·서버 렌더링을 React 19가 Actions, use, Server Components로 어떻게 언어 차원에서 흡수했는지 정리한다"
tags: [React 19, Actions, use, Server Components, Server Actions]
sources: [https://react.dev/blog/2024/12/05/react-19, https://react.dev/reference/react/use, https://react.dev/reference/rsc/server-components, https://react.dev/reference/react/useTransition]
updated: 2026-08-30
---

React 18까지 폼 제출은 `isPending`·`error`·낙관적 값을 `useState`로 따로 들고 `try/catch/finally`로 정리해야 했다. 데이터 페칭은 `useEffect`에서 시작해 로딩 플래그를 세웠고, 렌더링에만 쓰는 라이브러리도 클라이언트 번들에 실려 갔다. React 19는 이를 Actions, `use`, Server Components로 프레임워크 안에 들여왔다. 서버에서 렌더링하고, 서버 함수를 폼에 연결하고, 그 결과 Promise를 컴포넌트가 직접 읽는 하나의 흐름이다.

## 핵심 개념

**Actions**는 트랜지션 안에서 실행되는 비동기 함수다. `useTransition`의 `startTransition`에 `async` 함수를 넘기면 React가 pending을 추적하고 완료 시점에 `isPending`을 내린다. 에러는 가장 가까운 Error Boundary로 가며, 완료 전까지 이전 UI를 유지한다. `<form action={fn}>`도 같은 메커니즘이며 성공하면 비제어 필드가 초기화된다.

폼과 짝을 이루는 훅이 셋 추가됐다.

| 훅 | 역할 |
|---|---|
| `useActionState(fn, initialState)` | Action의 반환값을 상태로 보관하고 `[state, formAction, isPending]`을 돌려준다. 이전 상태가 Action 첫 인자로 들어온다 |
| `useFormStatus()` | 부모 `<form>`의 `pending`·`data`·`method`를 자식에서 읽는다. props 드릴링 없이 제출 버튼을 비활성화할 때 쓴다 |
| `useOptimistic(state, updateFn)` | Action이 끝나기 전 UI에 먼저 반영할 값을 만든다. 실패하거나 완료되면 실제 상태로 되돌아간다 |

**`use`**는 Promise나 Context를 렌더링 중에 읽는 API다. 훅과 달리 조건문·반복문 안에서 호출할 수 있다. Promise를 넘기면 resolve까지 가장 가까운 `<Suspense>` fallback을 보여주고, reject되면 Error Boundary가 잡는다.

**Server Components**는 빌드 또는 요청 시점에 서버에서만 실행된다. 브라우저 번들에 포함되지 않고 파일 시스템·DB에 직접 접근할 수 있는 대신, 상태·이펙트·이벤트 핸들러를 쓸 수 없다. 상호작용이 필요한 지점만 `'use client'` 파일로 분리하면 그 아래가 클라이언트 경계가 된다. Server가 기본값이고 Client가 명시 대상이다.

**Server Functions**는 `'use server'`로 표시한 함수로, 클라이언트에서 호출하면 React가 네트워크 요청을 만들어 서버에서 실행한다. 폼 `action`에 넘기면 JavaScript 로드 전에도 제출이 동작한다. Spring 기준으로 Server Component는 Thymeleaf 템플릿이 컴포넌트 트리로 바뀐 것이고, Server Function은 `@PostMapping` 핸들러를 폼에 직접 바인딩한 형태다.

그 외 `ref`가 일반 prop이 되어 `forwardRef`가 불필요해진 점, `<Context>` 직접 렌더링, `<title>`·`<meta>`를 어디서 렌더링해도 `<head>`로 끌어올리는 기능, `preload`·`preinit` 리소스 API가 추가됐다.

## 코드

Server Function을 `useActionState`와 `useFormStatus`로 연결한 폼이다. 검증 실패 메시지는 Action의 반환값으로 돌아온다.

```tsx
// app/comments/actions.ts
'use server';

import { z } from 'zod';
import { db } from '@/lib/db';

const schema = z.object({ body: z.string().min(1).max(500) });

export type CommentState = { error?: string; savedId?: number };

export async function addComment(
  prev: CommentState,
  formData: FormData,
): Promise<CommentState> {
  const parsed = schema.safeParse({ body: formData.get('body') });
  if (!parsed.success) return { error: '1~500자로 입력해야 한다' };
  const row = await db.comment.create({ data: parsed.data });
  return { savedId: row.id };
}
```

```tsx
// app/comments/CommentForm.tsx
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { addComment, type CommentState } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>{pending ? '저장 중' : '등록'}</button>;
}

export function CommentForm() {
  const [state, formAction, isPending] = useActionState<CommentState, FormData>(
    addComment,
    {},
  );
  return (
    <form action={formAction}>
      <textarea name="body" disabled={isPending} />
      <SubmitButton />
      {state.error && <p role="alert">{state.error}</p>}
      {state.savedId && <p>#{state.savedId} 저장 완료</p>}
    </form>
  );
}
```

Server Component에서 fetch를 시작하고 Promise를 그대로 넘겨 Client Component가 `use`로 읽는다. 서버는 응답을 기다리지 않고 스트리밍을 시작한다.

```tsx
// app/products/[id]/page.tsx  (Server Component)
import { Suspense } from 'react';
import { Reviews } from './Reviews';
import { getProduct, getReviews } from '@/lib/catalog';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProduct(id);          // 핵심 데이터는 await
  const reviewsPromise = getReviews(id);         // 부가 데이터는 await 없이 전달
  return (
    <article>
      <h1>{product.name}</h1>
      <Suspense fallback={<p>리뷰 불러오는 중</p>}>
        <Reviews reviewsPromise={reviewsPromise} />
      </Suspense>
    </article>
  );
}
```

```tsx
// app/products/[id]/Reviews.tsx
'use client';

import { use } from 'react';
import type { Review } from '@/lib/catalog';

export function Reviews({ reviewsPromise }: { reviewsPromise: Promise<Review[]> }) {
  const reviews = use(reviewsPromise);
  if (reviews.length === 0) return <p>아직 리뷰가 없다</p>;
  return (
    <ul>
      {reviews.map((r) => <li key={r.id}>{r.body}</li>)}
    </ul>
  );
}
```

`useOptimistic`으로 좋아요 카운트를 즉시 반영하는 예다. Action이 실패하면 React가 낙관적 값을 버리고 props의 실제 값으로 돌아간다.

```tsx
'use client';

import { useOptimistic, startTransition } from 'react';
import { toggleLike } from './actions';

export function LikeButton({ postId, likes }: { postId: string; likes: number }) {
  const [optimisticLikes, addOptimistic] = useOptimistic(
    likes,
    (current, delta: number) => current + delta,
  );
  return (
    <button
      onClick={() =>
        startTransition(async () => {
          addOptimistic(1);
          await toggleLike(postId);
        })
      }
    >
      좋아요 {optimisticLikes}
    </button>
  );
}
```

## 실무에서 걸리는 지점

- **Server Function은 공개 HTTP 엔드포인트다.** `'use server'` 파일에서 export한 함수는 누구나 호출할 수 있다. Controller에서 하던 인증 확인과 입력 검증을 함수 안에서 그대로 수행해야 한다.
- **렌더 중 생성한 Promise를 `use`에 넘기면 무한 로딩에 빠진다.** 매 렌더마다 새 Promise가 만들어져 suspend가 반복된다. Server Component에서 만들어 props로 넘기거나 `cache`·TanStack Query를 거친 Promise만 전달한다.
- **Server에서 Client로 넘기는 props는 직렬화 가능해야 한다.** 함수·클래스 인스턴스·Symbol은 넘길 수 없고 Server Function만 참조로 전달된다. Prisma의 `Decimal` 같은 타입이 섞이면 경계에서 에러가 난다.
- **`useActionState`의 Action은 첫 인자로 이전 상태를 받는다.** 일반 폼 `action`과 시그니처가 달라 같은 함수를 두 곳에 재사용하면 인자가 어긋난다.
- **`'use client'`를 너무 위쪽에 두면 Server Components 이점이 사라진다.** 레이아웃 최상단에 붙이면 하위 트리 전부가 클라이언트 번들에 포함된다. 버튼·입력 같은 최소 단위만 분리한다.

## 관련 글

- [커스텀 훅과 데이터 페칭 (TanStack Query)](/notes/react/custom-hooks-data-fetching/)
- [폼 — 제어/비제어 컴포넌트와 검증](/notes/react/forms-validation/)
- [테스트(Testing Library)·TypeScript·배포](/notes/react/testing-typescript-deployment/)
