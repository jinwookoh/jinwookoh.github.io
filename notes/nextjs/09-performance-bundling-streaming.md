---
title: "성능·번들·스트리밍"
series: nextjs
part: "운영"
order: 9
summary: "Suspense 스트리밍으로 TTFB를 줄이고, 번들 분석기와 optimizePackageImports·dynamic으로 클라이언트 JS를 깎는 방법"
tags: [Next.js, Streaming, Suspense, Bundle Analyzer, Code Splitting]
sources: [https://nextjs.org/docs/app/building-your-application/optimizing, https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming, https://nextjs.org/docs/app/building-your-application/optimizing/bundle-analyzer]
updated: 2026-08-30
---

서버 컴포넌트에서 `await`를 여러 번 하는 페이지는 가장 느린 데이터 소스가 끝날 때까지 HTML 한 바이트도 내보내지 못한다. 페이지 상단의 제목과 내비게이션은 이미 준비됐는데도 하단 추천 목록을 기다리느라 TTFB가 밀린다. 클라이언트 쪽도 마찬가지다. 아이콘 라이브러리 하나를 named import 했을 뿐인데 수백 개 모듈이 클라이언트 번들에 딸려 들어가고, 차트·마크다운 파서처럼 결과가 정적 HTML인 라이브러리가 브라우저에서 실행된다. 두 문제를 다루는 도구가 스트리밍과 번들 최적화다.

## 핵심 개념

**스트리밍**은 서버가 HTML을 청크 단위로 순차 전송하는 방식이다. App Router는 React Suspense 경계를 기준으로 동작한다. 경계 안쪽 컴포넌트가 데이터를 기다리며 suspend 되면 fallback이 먼저 내려가고, 준비된 시점에 실제 내용이 뒤따라 전송되어 자리를 바꾼다. Spring으로 치면 `ResponseBodyEmitter`/`StreamingResponseBody`로 응답을 나눠 흘려보내는 것과 같은 계층의 기법이며, 그 위에 React가 부분 하이드레이션까지 맡는다.

`loading.tsx`는 이 Suspense 경계를 파일 규칙으로 만든 것이다. 같은 폴더의 `page.tsx`와 하위 세그먼트를 자동으로 `<Suspense>`로 감싸며, 같은 세그먼트의 `layout.tsx`·`template.tsx`·`error.tsx`는 감싸지 않는다. 클라이언트 내비게이션 시 fallback은 prefetch 대상이라 즉시 표시되고, 이동 중에도 공유 레이아웃은 계속 상호작용 가능하다. 더 세밀한 제어가 필요하면 페이지 안에서 `<Suspense>`를 직접 배치한다. 독립적인 데이터 소스마다 경계를 나누면 각 영역이 자기 속도로 채워진다.

스트리밍의 제약은 HTTP 상태 코드다. 헤더가 이미 나간 뒤에는 상태를 바꿀 수 없으므로 응답은 항상 200으로 시작한다. 스트리밍 도중 `notFound()`가 호출되면 Next.js가 `<meta name="robots" content="noindex">`를 심어 색인은 막지만 상태는 200으로 남는다.

**번들 최적화**는 두 단계다. 먼저 측정한다. Webpack 빌드에서는 `@next/bundle-analyzer` 플러그인이 서버·클라이언트 번들의 treemap을 생성하고, Turbopack에서는 `next experimental-analyze` 명령이 모듈 그래프 기반으로 import 체인까지 추적한다. 다음으로 원인별로 처방한다.

| 원인 | 처방 |
|---|---|
| export가 수백 개인 패키지(아이콘·유틸) | `experimental.optimizePackageImports`로 실제 사용 모듈만 로드 |
| 결과가 정적 HTML인 무거운 클라이언트 작업(하이라이터·차트) | 서버 컴포넌트로 옮겨 마크업만 전송 |
| 첫 화면에 불필요한 클라이언트 컴포넌트 | `next/dynamic`으로 지연 로드 |
| 서버 번들에 포함되면 깨지는 네이티브 의존성 | `serverExternalPackages`로 번들링 제외 |

## 코드

독립적인 두 데이터 영역을 각각 Suspense로 감싸 서로의 지연에 영향받지 않게 한다.

```tsx
// app/dashboard/page.tsx
import { Suspense } from "react";
import { OrderFeed } from "./order-feed";
import { RevenueChart } from "./revenue-chart";

export default function DashboardPage() {
  return (
    <section>
      <h1>대시보드</h1>
      <Suspense fallback={<p>주문 목록을 불러오는 중</p>}>
        <OrderFeed />
      </Suspense>
      <Suspense fallback={<div className="h-64 animate-pulse" />}>
        <RevenueChart />
      </Suspense>
    </section>
  );
}
```

```tsx
// app/dashboard/order-feed.tsx (Server Component)
type Order = { id: string; total: number };

export async function OrderFeed() {
  const res = await fetch("https://api.example.com/orders", {
    next: { revalidate: 30 },
  });
  const orders: Order[] = await res.json();
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>{o.id} — {o.total.toLocaleString()}원</li>
      ))}
    </ul>
  );
}
```

번들 분석기를 환경변수로 켜고, 대형 패키지 import 최적화와 서버 번들 제외 목록을 함께 설정한다.

```ts
// next.config.ts
import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["lucide-react", "@mui/material"],
  },
  serverExternalPackages: ["sharp", "pino"],
};

export default withBundleAnalyzer(nextConfig);
```

```bash
ANALYZE=true npm run build        # Webpack: 브라우저에 treemap 3개 오픈
npx next experimental-analyze     # Turbopack: 인터랙티브 모듈 그래프
npx next experimental-analyze --output   # .next/diagnostics/analyze 에 저장
```

초기 화면에 필요 없는 클라이언트 전용 컴포넌트는 `next/dynamic`으로 분리해 별도 청크로 미룬다.

```tsx
// app/editor/page.tsx
"use client";
import dynamic from "next/dynamic";

const RichEditor = dynamic(() => import("@/components/rich-editor"), {
  ssr: false,
  loading: () => <p>에디터 준비 중</p>,
});

export default function EditorPage() {
  return <RichEditor />;
}
```

## 실무에서 걸리는 지점

- **레이아웃의 비캐시 데이터가 fallback을 막는다.** ==`layout.tsx`에서 `cookies()`·`headers()`나 캐시되지 않은 fetch를 호출하면 `loading.tsx`가 있어도 레이아웃 렌더가 끝날 때까지 내비게이션이 멈춘다.== 그런 호출은 `page.tsx`로 내리거나 레이아웃 안에서 별도 `<Suspense>`로 감싼다.
- **404 상태 코드가 필요하면 스트리밍 전에 판단한다.** ==`notFound()`는 첫 Suspense fallback이 렌더되기 전, suspend 가능한 `await`보다 앞에 두어야 실제 404가 나간다.== 규정 준수나 분석 목적으로 상태 코드가 중요하면 proxy 단계에서 slug 존재 여부를 가볍게 확인한다.
- **Suspense를 너무 잘게 쪼개면 레이아웃 시프트가 늘어난다.** fallback과 실제 콘텐츠의 크기를 맞추지 않으면 CLS가 악화된다. 사용자가 함께 기대하는 정보는 하나의 경계로 묶는다.
- **`ssr: false`는 서버 컴포넌트에서 쓸 수 없다.** `next/dynamic`의 `ssr: false`는 클라이언트 컴포넌트 안에서만 허용된다. 서버 컴포넌트에서 지연 로드가 필요하면 `ssr` 옵션 없이 `dynamic`을 쓰거나, 클라이언트 래퍼를 한 겹 둔다.
- **스트리밍은 정적 export에서 동작하지 않는다.** `output: "export"`로 정적 사이트를 뽑는 경우 Suspense fallback은 빌드 시점에 해소된다. ==자체 호스팅 시에는 프록시(Nginx 등)의 응답 버퍼링을 꺼야 청크가 즉시 전달된다.==

## 관련 글

- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [라우팅·레이아웃·로딩과 에러 UI](/notes/nextjs/routing-layouts-loading-error/)
- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
