---
title: "라우팅(React Router)과 코드 분할"
series: react
part: "기능"
order: 8
summary: "React Router로 URL과 컴포넌트 트리를 대응시키고, lazy·Suspense·route.lazy로 번들을 라우트 단위로 쪼개는 방법을 정리한다"
tags: [React Router, code splitting, lazy, Suspense, SPA]
sources: [https://reactrouter.com/start/library/routing, https://reactrouter.com/start/data/route-object, https://react.dev/reference/react/lazy, https://react.dev/reference/react/Suspense]
updated: 2026-08-30
---

SPA는 HTML 한 장을 받아 화면 전환을 브라우저 안에서 처리한다. 라우터가 없으면 URL과 화면이 분리되어 새로고침·뒤로가기·링크 공유가 깨진다. 조건문으로 흉내내다 보면 중첩 레이아웃·경로 파라미터·404까지 라우터를 재구현하게 된다. 한편 화면이 늘어나면 모든 페이지 코드가 하나의 번들에 묶여 첫 로딩이 느려진다. 라우팅과 코드 분할은 이 두 문제를 라우트라는 같은 단위로 해결한다.

## 핵심 개념

### 라우트 트리와 Outlet

React Router 7은 `react-router` 패키지 하나에서 `BrowserRouter`, `Routes`, `Route`, `Outlet`, `Link`, `useParams`를 제공한다. 라우트는 트리로 선언하고, 부모 컴포넌트가 `<Outlet />`을 그리는 자리에 매칭된 자식 라우트가 들어간다. 경로는 자동으로 합쳐져 `dashboard` 아래 `settings`는 `/dashboard/settings`가 된다.

| 종류 | 선언 | 역할 |
|---|---|---|
| index 라우트 | `<Route index />` | 부모 경로 그대로일 때 기본으로 보여줄 자식 |
| layout 라우트 | `path` 없는 `<Route element={...}>` | URL 세그먼트를 추가하지 않고 레이아웃만 공유 |
| 동적 세그먼트 | `teams/:teamId` | `useParams()`로 값을 읽는다 |
| 선택 세그먼트 | `:lang?/categories` | 있어도 되고 없어도 되는 세그먼트 |
| splat | `files/*` | 나머지 경로 전체를 `params["*"]`로 받는다 |

Spring MVC로 보면 `<Route path>`는 `@RequestMapping` 경로 패턴, `:teamId`는 `@PathVariable`이다. 다만 서버는 핸들러 하나를 고르는 반면 React Router는 매칭된 라우트 체인 전체를 중첩 렌더링한다.

### Declarative 모드와 Data 모드

`BrowserRouter`·`Routes`·`Route` 조합은 JSX로 라우트를 선언하는 declarative 모드다. 별개로 `createBrowserRouter`에 라우트 객체 배열을 넘기고 `RouterProvider`로 렌더링하는 data 모드가 있다. 라우트 객체에는 `Component` 외에 `loader`(렌더링 전 데이터 준비), `action`(폼 제출 등 변경 처리), `ErrorBoundary`, `shouldRevalidate`, `middleware`, 코드 분할용 `lazy`를 붙일 수 있다. action이 정상 종료되면 loader가 자동으로 재실행되어 화면이 동기화된다. `middleware`는 Spring의 HandlerInterceptor와 같은 자리다.

### lazy와 Suspense

`React.lazy(load)`는 `import()`를 감싼 함수를 받아 처음 렌더링될 때까지 모듈 로딩을 미루는 컴포넌트를 반환한다. 로딩 중에는 suspend되어 가장 가까운 `<Suspense fallback>`이 대신 그려진다. 번들러는 동적 `import()`를 별도 청크로 분리하므로 라우트 컴포넌트를 `lazy`로 감싸는 것만으로 라우트 단위 코드 분할이 된다.

Suspense는 경계 안의 자식들을 한 번에 드러내며, 경계를 중첩하면 점진적 로딩이 된다. 이미 보이는 화면을 fallback으로 덮지 않으려면 `startTransition` 안에서 상태를 바꾼다.

Data 모드의 `route.lazy`는 컴포넌트와 loader·action을 한 청크로 묶어 라우트가 매칭될 때 가져온다. 렌더링 시점이 아니라 매칭 시점에 로딩을 시작하므로 폭포수(waterfall)가 줄어든다.

## 코드

Declarative 모드로 레이아웃·index·동적 세그먼트·splat을 한 트리에 선언한 예제다.

```tsx
import { BrowserRouter, Routes, Route, Outlet, Link, useParams } from "react-router";
import { createRoot } from "react-dom/client";

function AppLayout() {
  return (
    <>
      <nav><Link to="/">Home</Link> <Link to="/teams/42">Team 42</Link></nav>
      <Outlet />
    </>
  );
}

function Team() {
  const { teamId } = useParams<{ teamId: string }>();
  return <h1>Team {teamId}</h1>;
}

function NotFound() {
  const { "*": rest } = useParams();
  return <p>No route for /{rest}</p>;
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<h1>Home</h1>} />
        <Route path="teams/:teamId" element={<Team />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  </BrowserRouter>,
);
```

`React.lazy`와 `Suspense`로 무거운 페이지를 별도 청크로 분리한 예제다. `lazy` 호출은 모듈 최상위에 두고, 대상 모듈은 default export여야 한다.

```tsx
import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router";

const Reports = lazy(() => import("./pages/Reports")); // export default function Reports()
const Settings = lazy(() => import("./pages/Settings"));

export function App() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Routes>
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
      </Routes>
    </Suspense>
  );
}
```

Data 모드에서 `route.lazy`로 컴포넌트와 loader를 함께 분할하고, 라우트 단위 에러 경계를 두는 예제다.

```tsx
import { createBrowserRouter, RouterProvider, useLoaderData, useRouteError } from "react-router";

// pages/orders.tsx
export async function loader({ params }: { params: { orderId?: string } }) {
  const res = await fetch(`/api/orders/${params.orderId}`);
  if (!res.ok) throw new Response("Not Found", { status: 404 });
  return res.json() as Promise<{ id: string; total: number }>;
}
export function Component() {
  const order = useLoaderData<typeof loader>();
  return <p>Order {order.id}: {order.total}</p>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <p>Failed: {String(error)}</p>;
}

// router.tsx
const router = createBrowserRouter([
  {
    path: "/",
    Component: AppLayout,
    children: [
      { index: true, Component: Home },
      { path: "orders/:orderId", lazy: () => import("./pages/orders") },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

## 실무에서 걸리는 지점

- **서버 fallback 설정.** `BrowserRouter`는 History API를 쓰므로 `/teams/42`를 새로고침하면 서버가 그 경로를 받는다. ==Nginx·S3·Spring 정적 핸들러가 없는 경로를 `index.html`로 돌려주지 않으면 배포 후 404가 난다.==
- **lazy를 컴포넌트 안에서 선언.** ==렌더링마다 새 lazy 컴포넌트가 만들어져 재마운트되고 상태가 초기화된다.== 모듈 최상위에서 한 번만 호출한다.
- **Suspense 경계 위치.** 최상위에 경계 하나만 두면 라우트 전환 때 화면 전체가 스피너로 바뀐다. 레이아웃 아래 `Outlet` 주변에 경계를 두어 내비게이션은 유지하고 콘텐츠 영역만 교체되게 한다.- **suspend된 트리의 상태 손실.** ==처음 마운트되기 전에 suspend된 컴포넌트는 그동안의 상태 변경이 버려지고 데이터 도착 후 처음부터 다시 렌더링된다.== 로딩 중 입력을 받는 UI는 경계 바깥에 둔다.
- **배포 후 청크 로딩 실패.** ==새 버전을 배포하면 이전 해시의 청크가 사라져 열어둔 탭에서 라우트 이동 시 `import()`가 실패한다.== 이 오류는 가장 가까운 Error Boundary로 전달되므로 청크 오류를 감지하면 전체 새로고침을 유도한다.

## 관련 글

- [커스텀 훅과 데이터 페칭 (TanStack Query)](/notes/react/custom-hooks-data-fetching/)
- [React 19 — Actions·use·Server Components](/notes/react/react19-actions-use-server-components/)
- [테스트(Testing Library)·TypeScript·배포](/notes/react/testing-typescript-deployment/)
