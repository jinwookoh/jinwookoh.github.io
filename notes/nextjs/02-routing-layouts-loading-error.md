---
title: "라우팅·레이아웃·로딩과 에러 UI"
series: nextjs
part: "기초"
order: 2
summary: "App Router는 폴더 규약만으로 중첩 레이아웃·스트리밍 로딩·구간별 에러 경계를 선언한다."
tags: [Next.js, App Router, layout, loading, error boundary]
sources: [https://nextjs.org/docs/app/building-your-application/routing/layouts-and-templates, https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming, https://nextjs.org/docs/app/building-your-application/routing/error-handling]
updated: 2026-08-30
---

라우팅 라이브러리를 직접 조합하면 공통 헤더를 페이지마다 다시 그리고, 데이터가 준비될 때까지 화면 전체가 비어 있으며, 한 컴포넌트의 예외가 페이지 전체를 백지로 만든다. 로딩·에러 상태를 페이지마다 `useState`로 관리하면 같은 코드가 수십 곳에 복제된다. Next.js App Router는 이 문제를 파일 시스템 규약으로 해결한다. 폴더가 URL 세그먼트가 되고, `layout.tsx`·`loading.tsx`·`error.tsx`라는 예약 파일이 각 세그먼트의 공통 UI·로딩 UI·에러 UI를 담당한다.

## 핵심 개념

App Router에서 `app/` 아래의 각 폴더는 하나의 라우트 세그먼트다. 폴더 안에 `page.tsx`가 있어야 그 경로가 공개 URL이 되고, `page.tsx`가 없는 폴더는 하위 경로의 구조만 담는다. 세그먼트마다 다음 예약 파일을 둘 수 있다.

| 파일 | 역할 | 렌더링 특성 |
|---|---|---|
| `layout.tsx` | 하위 세그먼트를 감싸는 공통 UI | 내비게이션 간 상태 유지, 리렌더링 없음 |
| `template.tsx` | 레이아웃과 같은 위치이나 매 내비게이션마다 새 인스턴스 | 상태 초기화, 효과 재실행 |
| `loading.tsx` | 세그먼트의 데이터 준비 중 대체 UI | 자동 `Suspense` 경계 |
| `error.tsx` | 세그먼트 렌더링 예외를 잡는 UI | 자동 Error Boundary, 클라이언트 컴포넌트 |
| `global-error.tsx` | 루트 레이아웃까지 포함한 최상위 예외 | `<html>`·`<body>`를 직접 렌더링 |

레이아웃은 중첩된다. `app/layout.tsx`(루트 레이아웃)는 필수이며 `<html>`과 `<body>`를 반드시 포함한다. `app/dashboard/layout.tsx`는 루트 레이아웃의 `children` 자리에 삽입되고, 다시 `app/dashboard/settings/page.tsx`를 자신의 `children`으로 받는다. 형제 경로 사이를 이동할 때 상위 레이아웃은 다시 마운트되지 않으므로 입력값이나 스크롤 위치가 유지된다. 진입마다 초기화가 필요하면 `template.tsx`를 쓴다.

`loading.tsx`는 같은 폴더의 `page.tsx`와 그 하위 트리를 `<Suspense fallback={<Loading />}>`으로 감싼 것과 동일하게 동작한다. 서버는 레이아웃과 로딩 UI를 먼저 HTML로 내려보내고, 데이터가 준비되는 대로 나머지 조각을 같은 응답 스트림에 이어 붙인다. 이것이 스트리밍 SSR이다. 더 세밀하게 나누려면 컴포넌트 안에 `<Suspense>`를 직접 배치한다.

`error.tsx`는 자신이 속한 세그먼트와 그 하위에서 발생한 렌더링 예외를 가로챈다. ==같은 폴더의 `layout.tsx`가 발생시킨 예외는 잡지 못하는데, 에러 경계가 레이아웃 안쪽에 배치되기 때문이다.== 레이아웃의 예외는 한 단계 위 세그먼트의 `error.tsx`가 처리하고, 루트 레이아웃의 예외는 `global-error.tsx`만 잡을 수 있다. 서버 컴포넌트의 에러는 프로덕션에서 메시지가 제거되고 `digest` 해시만 클라이언트로 전달되며, 서버 로그의 같은 digest와 대조한다.

Spring/Java와 대응시키면 중첩 `layout.tsx`는 Thymeleaf 레이아웃 데코레이터, `error.tsx`는 세그먼트 범위로 좁힌 `@ControllerAdvice`·`@ExceptionHandler`, `loading.tsx`의 스트리밍 응답은 `ResponseBodyEmitter`로 조각을 흘려보내는 모델에 해당한다.

## 코드

대시보드 세그먼트의 공통 레이아웃이다. Next.js 15부터 `params`는 Promise로 전달되므로 `await`로 풀어 쓴다.

```tsx
// app/dashboard/[team]/layout.tsx
import type { ReactNode } from "react";
import Link from "next/link";

type Props = {
  children: ReactNode;
  params: Promise<{ team: string }>;
};

export default async function TeamLayout({ children, params }: Props) {
  const { team } = await params;
  return (
    <section className="flex">
      <nav className="w-56">
        <Link href={`/dashboard/${team}`}>개요</Link>
        <Link href={`/dashboard/${team}/members`}>멤버</Link>
        <Link href={`/dashboard/${team}/settings`}>설정</Link>
      </nav>
      <main className="flex-1">{children}</main>
    </section>
  );
}
```

같은 세그먼트에 `loading.tsx`를 두면 `page.tsx`의 데이터 대기 중에 레이아웃과 함께 즉시 스트리밍된다. 페이지 안에서 느린 위젯만 별도 `Suspense`로 분리한 형태다.

```tsx
// app/dashboard/[team]/loading.tsx
export default function Loading() {
  return <div role="status" aria-busy="true">불러오는 중</div>;
}

// app/dashboard/[team]/page.tsx
import { Suspense } from "react";
import { getTeam, getActivity } from "@/lib/api";

async function Activity({ team }: { team: string }) {
  const rows = await getActivity(team); // 느린 호출
  return <ul>{rows.map((r) => <li key={r.id}>{r.message}</li>)}</ul>;
}

export default async function TeamPage({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team } = await params;
  const info = await getTeam(team);
  return (
    <>
      <h1>{info.name}</h1>
      <Suspense fallback={<p>활동 내역 로딩</p>}>
        <Activity team={team} />
      </Suspense>
    </>
  );
}
```

에러 경계는 클라이언트 컴포넌트여야 하며, `reset`을 호출하면 해당 세그먼트만 다시 렌더링을 시도한다.

```tsx
// app/dashboard/[team]/error.tsx
"use client";

import { useEffect } from "react";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function TeamError({ error, reset }: Props) {
  useEffect(() => {
    // 모니터링 SDK로 전송. digest로 서버 로그와 대조한다.
    console.error(error.digest ?? error.message);
  }, [error]);

  return (
    <div role="alert">
      <p>팀 정보를 표시하지 못했다.</p>
      <button type="button" onClick={() => reset()}>
        다시 시도
      </button>
    </div>
  );
}
```

## 실무에서 걸리는 지점

- 레이아웃은 부모에서 자식으로 데이터를 넘기지 못한다. 상위 레이아웃과 하위 페이지가 같은 사용자 정보를 필요로 하면 각자 `fetch`하고, 같은 요청 안에서의 중복은 `fetch` 메모이제이션이나 `React.cache`로 제거한다.
- ==`reset()`은 렌더링만 다시 시도하며 서버 데이터 캐시를 무효화하지 않는다.== 서버 컴포넌트 예외를 복구하려면 `useRouter().refresh()`를 함께 호출해 최신 서버 응답을 받아야 한다.
- `loading.tsx`는 세그먼트 전체를 하나의 경계로 묶으므로 페이지 안에서 가장 느린 호출이 전체 fallback을 좌우한다. 핵심 콘텐츠를 먼저 보이려면 컴포넌트 단위 `Suspense`로 쪼갠다.
- 스트리밍 응답은 HTTP 상태 코드가 이미 200으로 전송된 뒤에 에러가 발생할 수 있다. `error.tsx`가 화면을 대체해도 상태 코드는 바뀌지 않으므로 상태 코드 기반 헬스 체크에는 별도 메트릭이 필요하다.
- ==`notFound()`와 `redirect()`는 예외를 던지는 방식이므로 `try/catch` 안에서 호출하면 catch에 잡혀 무산된다.== 조회 블록 바깥에서 호출한다.

## 관련 글

- [Next.js란 — App Router와 렌더링 모델 (SSR·SSG·ISR·CSR)](/notes/nextjs/what-is-nextjs-rendering/)
- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [성능·번들·스트리밍](/notes/nextjs/performance-bundling-streaming/)
