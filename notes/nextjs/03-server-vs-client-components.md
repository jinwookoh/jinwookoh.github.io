---
title: "Server Components와 Client Components"
series: nextjs
part: "기초"
order: 3
summary: "서버 전용 렌더링을 기본으로 두고, 상호작용이 필요한 최소 범위에만 'use client' 경계를 긋는 기준을 정리한다"
tags: [Next.js, React Server Components, use client, App Router, Composition]
sources: [https://nextjs.org/docs/app/building-your-application/rendering/server-components, https://nextjs.org/docs/app/building-your-application/rendering/client-components, https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns]
updated: 2026-08-30
---

전통적인 React SPA는 모든 컴포넌트 코드를 브라우저로 보내고, 데이터도 브라우저가 API를 호출해 받아온다. 한 번 그리고 끝나는 정적 본문과 그 파싱 라이브러리까지 번들에 포함된다. DB 접근 코드는 브라우저에 둘 수 없으니 API 계층이 필수이고, 렌더링 전에 네트워크 왕복이 한 번 더 생긴다. Next.js App Router는 컴포넌트를 실행 환경에 따라 두 종류로 나누어 이 비용을 줄인다.

## 핵심 개념

App Router의 모든 컴포넌트는 기본이 Server Component다. 서버에서 렌더링되어 결과가 RSC Payload라는 직렬화 형식으로 클라이언트에 전달되고, 그 자바스크립트 코드는 브라우저로 보내지 않는다. 따라서 파일 시스템, 데이터베이스 클라이언트, 비밀 키를 컴포넌트 안에서 바로 사용할 수 있다. `async` 함수로 선언하고 본문에서 `await`로 데이터를 받는 것도 허용된다. 반대로 `useState`, `useEffect` 같은 훅과 `onClick` 같은 이벤트 핸들러, `window` 접근은 쓸 수 없다.

Client Component는 파일 최상단에 `'use client'` 지시어를 선언한 모듈이다. 이 지시어는 모듈 그래프의 경계를 표시한다. 해당 파일과 그 파일이 import하는 모든 모듈은 클라이언트 번들에 포함된다. ==이름과 달리 클라이언트 컴포넌트도 첫 요청 시에는 서버에서 HTML로 프리렌더링되고, 브라우저에서 hydration 과정을 거쳐 이벤트 핸들러가 붙는다.==

서버는 Server Component를 실행해 RSC Payload를 만들고 그 안에 Client Component의 참조와 props를 기록한다. 초기 요청은 HTML과 함께 전달되고, 이후 페이지 이동에서는 RSC Payload만 받아 트리를 갱신한다.

두 종류의 경계를 넘나드는 데는 제약이 있다. Server Component에서 Client Component를 import하는 것은 자유롭지만, 그 반대는 불가능하다. 대신 Server Component를 `children`이나 다른 prop으로 넘기는 방식은 허용된다. 또한 경계를 넘어가는 props는 직렬화 가능해야 한다. 함수, 클래스 인스턴스, Date 같은 값은 그대로 넘길 수 없고, Server Action 함수만 예외로 전달된다.

| 구분 | Server Component | Client Component |
|---|---|---|
| 선언 | 기본값 | `'use client'` |
| 데이터 접근 | DB·파일·비밀 키 직접 사용 | fetch 또는 props |
| 훅·이벤트 | 불가 | 가능 |
| 번들 포함 | 안 됨 | 포함 |
| 렌더링 위치 | 서버만 | 서버 프리렌더 + 브라우저 |

Spring과 대응시키면 Server Component는 서비스 계층을 직접 호출하는 Thymeleaf 템플릿, Client Component는 그 위에 얹는 브라우저 스크립트에 해당한다. `server-only` 패키지는 모듈이 클라이언트 번들에 섞이면 빌드를 실패시키므로 계층 침범을 컴파일 시점에 막는 역할을 한다.

## 코드

데이터베이스에 직접 접근하는 Server Component다. 비밀 키와 쿼리 코드는 브라우저로 전달되지 않는다.

```tsx
// app/posts/page.tsx
import { db } from '@/lib/db';
import { LikeButton } from './like-button';

export default async function PostsPage() {
  const posts = await db.post.findMany({ orderBy: { createdAt: 'desc' } });

  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>
          <h2>{post.title}</h2>
          <LikeButton postId={post.id} initialCount={post.likes} />
        </li>
      ))}
    </ul>
  );
}
```

상호작용이 필요한 부분만 분리한 Client Component다. props는 직렬화 가능한 원시 값만 받는다.

```tsx
// app/posts/like-button.tsx
'use client';

import { useState } from 'react';

type Props = { postId: string; initialCount: number };

export function LikeButton({ postId, initialCount }: Props) {
  const [count, setCount] = useState(initialCount);

  async function handleClick() {
    setCount((c) => c + 1);
    await fetch(`/api/posts/${postId}/like`, { method: 'POST' });
  }

  return <button onClick={handleClick}>좋아요 {count}</button>;
}
```

Client Component 안에 Server Component를 배치해야 할 때는 `children`으로 넘긴다. `Modal`은 클라이언트에서 열림 상태를 관리하지만, 그 안의 내용은 서버에서 렌더링된다.

```tsx
// app/components/modal.tsx
'use client';

import { useState, type ReactNode } from 'react';

export function Modal({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      {open && <dialog open>{children}</dialog>}
    </>
  );
}

// app/page.tsx (Server Component)
import { Modal } from './components/modal';
import { ServerDetail } from './components/server-detail';

export default function Page() {
  return (
    <Modal>
      <ServerDetail />
    </Modal>
  );
}
```

## 실무에서 걸리는 지점

- **경계가 위로 올라가는 문제.** ==페이지 최상단 컴포넌트에 `'use client'`를 붙이면 그 아래 import 트리 전체가 클라이언트 번들이 된다.== 지시어는 상호작용이 필요한 말단 컴포넌트에만 붙이고, 데이터 페칭과 정적 마크업은 위쪽 Server Component에 남긴다.
- **서버 전용 코드의 유출.** 환경 변수를 읽는 유틸리티나 DB 클라이언트를 Client Component에서 실수로 import하면 코드가 번들에 섞인다. 그런 모듈 최상단에 `import 'server-only'`를 넣어 빌드 단계에서 차단한다.
- **직렬화 불가 props.** 서버에서 만든 `Date`, `Map`, 클래스 인스턴스, 콜백 함수를 Client Component에 넘기면 런타임 오류가 난다. ISO 문자열이나 일반 객체로 바꿔 넘기고, 서버 로직 호출이 필요하면 Server Action을 prop으로 전달한다.
- **서드파티 컴포넌트 래핑.** 훅을 사용하면서 `'use client'`를 선언하지 않은 라이브러리 컴포넌트는 Server Component에서 바로 쓰면 실패한다. 지시어를 붙인 얇은 래퍼 파일로 감싸 사용한다.
- **Context Provider 위치.** 테마나 인증 상태를 담는 Provider는 Client Component여야 하므로 루트 레이아웃 전체에 지시어를 붙이고 싶어진다. 대신 Provider만 별도 파일로 분리하고 레이아웃에서 `children`을 감싸는 형태로 두면 나머지 트리는 서버에 남는다.

## 관련 글

- [Next.js란 — App Router와 렌더링 모델 (SSR·SSG·ISR·CSR)](/notes/nextjs/what-is-nextjs-rendering/)
- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [성능·번들·스트리밍](/notes/nextjs/performance-bundling-streaming/)
