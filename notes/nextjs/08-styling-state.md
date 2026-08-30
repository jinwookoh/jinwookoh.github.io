---
title: "스타일링과 상태 관리"
series: nextjs
part: "기능"
order: 8
summary: "CSS는 import 순서가 곧 적용 순서이고, 상태는 서버 데이터·URL·클라이언트 UI 상태로 나눠 두어야 번들과 캐시가 무너지지 않는다"
tags: [Next.js, Tailwind CSS, CSS Modules, React Context, Zustand]
sources: [https://nextjs.org/docs/app/building-your-application/styling, https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns]
updated: 2026-08-30
---

SPA의 습관을 App Router에 그대로 옮기면 두 가지 문제가 생긴다. 전역 CSS를 여러 곳에서 import하면 프로덕션 빌드에서 스타일시트가 병합·분할되며 개발 환경과 다른 순서로 적용된다. 전역 상태를 위해 루트 레이아웃 전체에 `'use client'`를 붙이면 그 아래 모든 컴포넌트가 클라이언트 번들로 내려가고, 서버에서 가져온 데이터를 클라이언트 스토어에 다시 복사하는 이중 상태가 생긴다. ==두 주제 모두 무엇을 서버에 두고 무엇을 클라이언트에 둘 것인가라는 같은 질문으로 귀결된다.==

## 핵심 개념

Next.js는 Tailwind CSS, CSS Modules, 전역 CSS, 외부 스타일시트, Sass, CSS-in-JS를 지원한다. 공식 권장은 Tailwind를 기본으로 쓰고, 부족한 컴포넌트 전용 스타일만 CSS Modules로 보완하며, 전역 CSS는 리셋처럼 정말 전역인 것에만 쓰는 조합이다. Tailwind v4는 설정 파일 없이 `@tailwindcss/postcss` 플러그인을 등록하고 전역 CSS에 `@import 'tailwindcss'` 한 줄로 시작한다. CSS Modules는 클래스명을 빌드 시 고유 이름으로 바꾸어 충돌을 막고 Server Component에서도 import할 수 있다.

==CSS 적용 순서는 import 순서를 따른다.== `BaseButton`을 먼저 import하고 `page.module.css`를 나중에 import하면 버튼 스타일이 앞에 놓인다. 프로덕션 빌드는 스타일시트를 라우트별로 병합·분할하므로 개발 환경의 순서가 빌드 후 달라질 수 있다. 전역 스타일은 한 번 로드되면 라우트 이동 시 제거되지 않으므로, 페이지마다 다른 전역 CSS를 import하면 한 화면에 쌓여 충돌한다.

CSS-in-JS는 런타임에 스타일을 만들기 때문에 Server Component에서 쓸 수 없다. styled-components나 emotion은 `'use client'` 컴포넌트에서만 동작하며, 서버 렌더링 결과에 스타일을 넣으려면 `useServerInsertedHTML`을 쓰는 레지스트리 컴포넌트가 별도로 필요하다. 이 비용 때문에 빌드 타임에 CSS를 추출하는 방식이 기본 선택이 된다.

상태는 출처에 따라 세 층으로 나눈다. 서버 데이터는 Server Component에서 조회해 props로 내려보내고 갱신은 Server Action과 `revalidatePath`로 처리하며, 클라이언트 스토어로 복사하지 않는다. 필터·정렬처럼 공유 가능해야 하는 상태는 URL 검색 파라미터에 두고 `useSearchParams`로 읽는다. 모달 열림, 탭 선택 같은 순수 UI 상태만 `useState`, Context, Zustand 같은 클라이언트 스토어에 둔다.

React Context는 Server Component에서 쓸 수 없다. Provider를 `'use client'` 파일로 분리해 `children`을 받게 하고 레이아웃에서 감싸면 Provider만 클라이언트로 가고 그 안의 서버 트리는 유지된다. Provider는 `<html>` 전체가 아니라 필요한 최소 범위에 두어야 정적 부분의 최적화를 방해하지 않는다. ==클라이언트 스토어를 모듈 스코프 싱글턴으로 만들면 서버에서 요청 간에 상태가 공유되므로 Provider 안에서 요청마다 생성한다.==

Spring과 대응시키면, Server Component가 데이터를 조회해 props로 넘기는 흐름은 `@Controller`가 Model에 값을 담아 템플릿에 전달하는 것에 가깝고, 요청마다 스토어를 생성하는 규칙은 `@RequestScope` 빈과 싱글턴 빈을 구분하는 원칙과 같다.

## 코드

Tailwind v4와 CSS Modules를 함께 쓰는 Server Component다. 전역 CSS는 루트 레이아웃에서 한 번만 import한다.

```tsx
// app/layout.tsx
import './globals.css'; // @import 'tailwindcss'; 한 줄이 들어 있다
import styles from './layout.module.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className={`min-h-screen antialiased ${styles.shell}`}>{children}</body>
    </html>
  );
}
```

React Context Provider를 클라이언트 경계로 분리하고, 서버에서 읽은 초기값을 props로 주입하는 패턴이다. 스토어는 `useState` 초기화 함수 안에서 만들어 요청마다 새 인스턴스가 된다.

```tsx
// app/providers/cart-provider.tsx
'use client';
import { createContext, useContext, useState } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';

type CartState = { items: string[]; add: (id: string) => void };
const CartContext = createContext<StoreApi<CartState> | null>(null);

export function CartProvider({ initial, children }: { initial: string[]; children: React.ReactNode }) {
  const [store] = useState(() =>
    createStore<CartState>((set) => ({
      items: initial,
      add: (id) => set((s) => ({ items: [...s.items, id] })),
    })),
  );
  return <CartContext.Provider value={store}>{children}</CartContext.Provider>;
}

export function useCart<T>(selector: (s: CartState) => T): T {
  const store = useContext(CartContext);
  if (!store) throw new Error('CartProvider가 없다');
  return useStore(store, selector);
}
```

```tsx
// app/(shop)/layout.tsx  — Server Component
import 'server-only';
import { CartProvider } from '@/app/providers/cart-provider';
import { getCartItems } from '@/lib/cart';

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const items = await getCartItems();
  return <CartProvider initial={items}>{children}</CartProvider>;
}
```

공유 가능한 상태를 URL에 두고 읽는 Client Component다. 새로고침과 링크 공유에도 상태가 유지된다.

```tsx
// app/products/sort-select.tsx
'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export function SortSelect() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = new URLSearchParams(params);
    next.set('sort', e.target.value);
    router.replace(`${pathname}?${next.toString()}`);
  };
  return (
    <select value={params.get('sort') ?? 'recent'} onChange={onChange}>
      <option value="recent">최신순</option>
      <option value="price">가격순</option>
    </select>
  );
}
```

## 실무에서 걸리는 지점

- **CSS 순서가 빌드 후 바뀐다.** ESLint `sort-imports` 같은 자동 정렬이 스타일 우선순위를 뒤집는다. CSS import는 한 진입 파일에 모으고 최종 순서는 `next build` 결과로 확인한다. 필요하면 `cssChunking` 옵션으로 병합 방식을 조정한다.
- ==**싱글턴 스토어의 서버 상태 누수.** `create()`로 모듈 최상위에 만든 Zustand 스토어를 서버 렌더링에서 쓰면 여러 요청이 같은 인스턴스를 공유한다.== 사용자별 데이터는 반드시 Provider 안에서 요청마다 생성한다.
- **hydration 불일치.** `localStorage`나 `window.matchMedia`로 초기 테마를 결정하면 서버 HTML과 클라이언트 첫 렌더가 달라 경고가 난다. 초기값은 쿠키로 서버에서 읽거나, `useEffect` 이후에 반영한다.
- **서버 데이터의 이중 관리.** 서버에서 받은 목록을 클라이언트 스토어에 넣고 수정하면 `revalidatePath` 이후 두 값이 어긋난다. 스토어에는 낙관적 UI용 임시 값만 둔다.
- **환경 오염.** `process.env.API_KEY`를 쓰는 모듈이 Client Component에 import되면 값이 빈 문자열로 바뀌어 조용히 실패한다. 서버 전용 모듈에 `import 'server-only'`를 선언해 빌드 단계에서 잡는다.

## 관련 글

- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [성능·번들·스트리밍](/notes/nextjs/performance-bundling-streaming/)
