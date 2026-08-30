---
title: "Next.js란 — App Router와 렌더링 모델 (SSR·SSG·ISR·CSR)"
series: nextjs
part: "기초"
order: 1
summary: "Next.js App Router는 라우트 단위로 정적·동적 렌더링을 자동 결정하며, 선택 기준은 데이터의 요청 의존성이다"
tags: [Next.js, App Router, SSR, SSG, ISR, React Server Components]
sources: [https://nextjs.org/docs/app/building-your-application/rendering, https://nextjs.org/docs/app/building-your-application/routing]
updated: 2026-08-30
---

React만으로 화면을 만들면 브라우저는 빈 HTML과 번들 JavaScript를 받은 뒤에야 화면을 그린다. 첫 화면이 늦고, 크롤러는 데이터가 채워지기 전의 빈 문서를 본다. 이를 피하려고 서버에서 HTML을 먼저 만들려 하면 라우팅, 데이터 로딩 시점, 번들 분리, 캐시 무효화를 직접 조립해야 한다. Next.js는 이 조립을 프레임워크 규약으로 흡수한다. 파일 시스템이 라우팅을 정의하고, 각 라우트가 어떤 방식으로 렌더링될지를 코드의 데이터 접근 패턴에서 추론한다.

## 핵심 개념

Next.js 15의 기본 라우터는 App Router다. `app/` 디렉터리 아래의 폴더 구조가 URL 경로가 되고, 폴더 안의 예약 파일이 역할을 나눈다. `page.tsx`는 해당 경로의 UI, `layout.tsx`는 하위 경로가 공유하는 껍데기, `loading.tsx`와 `error.tsx`는 각각 Suspense 경계와 에러 경계로 변환된다. `[id]` 같은 대괄호 폴더는 동적 세그먼트다. Spring으로 치면 `@RequestMapping("/posts/{id}")`에 해당하는 선언이 폴더 이름으로 옮겨진 셈이며, `layout.tsx`는 중첩 가능한 뷰 템플릿에 가깝다.

App Router의 컴포넌트는 기본적으로 React Server Component다. 서버에서만 실행되고 그 결과가 직렬화된 RSC 페이로드로 브라우저에 전달되며, 컴포넌트 코드 자체는 클라이언트 번들에 포함되지 않는다. 브라우저 API나 이벤트 핸들러가 필요한 부분만 파일 상단에 `'use client'`를 선언해 Client Component로 분리한다. 이 경계 덕분에 DB 접근 코드가 페이지 컴포넌트 안에 바로 들어간다. Spring MVC의 컨트롤러와 템플릿 렌더링이 한 함수에 합쳐진 형태다.

렌더링 전략은 네 가지로 나뉜다.

| 전략 | 렌더링 시점 | HTML 생성 주체 | App Router에서의 조건 |
|---|---|---|---|
| SSG (정적) | 빌드 시 | 서버(빌드 서버) | 요청 시 정보에 의존하지 않을 때 기본값 |
| ISR (증분 정적 재생성) | 빌드 시 + 주기적 재생성 | 서버 | `revalidate` 설정 또는 태그 기반 무효화 |
| SSR (동적) | 요청마다 | 서버 | `cookies()`, `headers()`, `searchParams` 등 사용 시 |
| CSR | 브라우저 | 클라이언트 | Client Component에서 마운트 후 fetch |

App Router는 이 전략을 페이지 단위 설정으로 고르게 하지 않는다. 라우트 세그먼트를 렌더링하면서 요청 시점 정보를 읽는 동적 API가 호출되는지를 관찰하고, 호출이 없으면 정적으로, 있으면 동적으로 분류한다. 개발자는 `export const dynamic = 'force-dynamic'`이나 `export const revalidate = 60` 같은 세그먼트 설정으로 판단을 덮어쓸 수 있다.

동적 라우트에서 `loading.tsx`나 `<Suspense>`로 경계를 두면 준비된 부분부터 HTML을 스트리밍하고, 느린 부분은 나중에 채운다.

Next.js 15에서 주의할 기본값 변경이 있다. `fetch`의 응답과 GET Route Handler는 더 이상 기본 캐시 대상이 아니며, 캐시하려면 `fetch(url, { cache: 'force-cache' })` 또는 `next: { revalidate }` 옵션을 명시해야 한다. 또한 `params`, `searchParams`, `cookies()`, `headers()`가 모두 Promise를 반환하므로 `await`로 풀어야 한다.

## 코드

정적 렌더링 라우트. 요청 시점 정보를 읽지 않으므로 빌드 시 HTML이 생성되고, `generateStaticParams`로 미리 만들 경로를 알려 준다.

```tsx
// app/posts/[slug]/page.tsx
type Post = { slug: string; title: string; body: string };

export async function generateStaticParams() {
  const posts: Post[] = await fetch('https://api.example.com/posts', {
    cache: 'force-cache',
  }).then((r) => r.json());
  return posts.map((p) => ({ slug: p.slug }));
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post: Post = await fetch(`https://api.example.com/posts/${slug}`, {
    next: { revalidate: 300 }, // 300초마다 재생성 → ISR
  }).then((r) => r.json());

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
```

동적 렌더링 라우트. `cookies()`를 읽는 순간 해당 세그먼트는 요청마다 렌더링되며, 느린 부분은 Suspense로 감싸 스트리밍한다.

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';
import { cookies } from 'next/headers';

async function RecentOrders({ userId }: { userId: string }) {
  const orders = await fetch(`https://api.example.com/users/${userId}/orders`, {
    cache: 'no-store',
  }).then((r) => r.json() as Promise<{ id: string; total: number }[]>);
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>{o.id}: {o.total}</li>
      ))}
    </ul>
  );
}

export default async function DashboardPage() {
  const store = await cookies();
  const userId = store.get('uid')?.value ?? 'anonymous';
  return (
    <main>
      <h1>{userId}의 대시보드</h1>
      <Suspense fallback={<p>주문 불러오는 중</p>}>
        <RecentOrders userId={userId} />
      </Suspense>
    </main>
  );
}
```

클라이언트 렌더링. 브라우저 이벤트가 필요한 부분만 `'use client'`로 분리하고, 데이터는 마운트 이후에 가져온다.

```tsx
// app/dashboard/LiveCounter.tsx
'use client';
import { useEffect, useState } from 'react';

export function LiveCounter() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(async () => {
      const res = await fetch('/api/visitors');
      setCount((await res.json()).count as number);
    }, 5000);
    return () => clearInterval(id);
  }, []);
  return <span>{count ?? '-'}명 접속 중</span>;
}
```

## 실무에서 걸리는 지점

- **의도치 않은 동적 전환.** ==공통 레이아웃에서 `cookies()`나 `headers()`를 한 번 읽으면 그 아래 모든 페이지가 동적 렌더링으로 바뀐다.== 빌드 로그에서 라우트 옆의 기호(정적 `○`, 동적 `ƒ`)를 확인해 의도와 맞는지 점검해야 한다.
- **Next.js 15 캐시 기본값.** ==14에서 15로 올리면 `fetch` 결과가 캐시되지 않아 백엔드 호출량이 급증할 수 있다.== 캐시가 필요한 호출마다 `cache` 또는 `next.revalidate`를 명시하고, 세그먼트 단위로 묶고 싶다면 `export const fetchCache = 'default-cache'`를 검토한다.
- **Promise 기반 params.** `params`와 `searchParams`를 동기 객체로 다루던 코드는 15에서 경고를 거쳐 오류가 된다. 타입을 `Promise<...>`로 바꾸고 `await`를 붙이는 마이그레이션이 필요하다.
- **직렬화 경계.** Server Component에서 Client Component로 넘기는 props는 직렬화 가능해야 한다. Map, 클래스 인스턴스, 일반 함수는 넘길 수 없고, 함수는 Server Action으로만 전달된다.
- **ISR 재생성 타이밍.** `revalidate`는 지정한 시간이 지난 후 들어온 첫 요청에 이전 버전을 응답하고 백그라운드에서 재생성한다. 재생성 직후 요청이 없으면 갱신되지 않으므로 즉시 반영이 필요하면 `revalidatePath`나 `revalidateTag`로 명시적으로 무효화한다.

## 관련 글

- [라우팅·레이아웃·로딩과 에러 UI](/notes/nextjs/routing-layouts-loading-error/)
- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
