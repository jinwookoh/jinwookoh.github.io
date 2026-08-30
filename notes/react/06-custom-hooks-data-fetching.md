---
title: "커스텀 훅과 데이터 페칭 (TanStack Query)"
series: react
part: "기능"
order: 6
summary: "반복되는 훅 로직은 커스텀 훅으로 추출하고, 서버 데이터는 TanStack Query에 맡겨 캐시·재요청·상태 관리를 컴포넌트 밖으로 뺀다."
tags: [React, Custom Hooks, TanStack Query, Data Fetching, Caching]
sources: [https://react.dev/learn/reusing-logic-with-custom-hooks, https://tanstack.com/query/latest/docs/framework/react/overview, https://tanstack.com/query/latest/docs/framework/react/guides/queries]
updated: 2026-08-30
---

useEffect 안에서 fetch를 호출하고 useState로 데이터·로딩·에러를 따로 들고 있는 코드는 화면이 몇 개만 늘어나도 같은 패턴이 복제된다. 그 과정에서 언마운트 뒤 setState, 요청 순서 뒤바뀜(race), 같은 API를 컴포넌트마다 다시 호출하는 중복 요청, 화면을 다시 열었을 때 오래된 데이터가 남는 문제가 각자 다른 방식으로 처리된다. 로직 재사용 단위가 없고, 서버 데이터의 수명 주기를 관리하는 주체가 없기 때문이다. ==전자는 커스텀 훅이, 후자는 TanStack Query가 맡는다.==

## 핵심 개념

커스텀 훅은 `use`로 시작하는 이름을 가진 일반 함수다. 내부에서 다른 훅을 호출할 수 있고, 컴포넌트는 그 훅을 호출해 상태와 함수만 받는다. ==중요한 점은 공유되는 것이 상태 자체가 아니라 상태를 다루는 로직이라는 것이다.== 같은 커스텀 훅을 두 컴포넌트에서 호출하면 각각 독립된 상태가 만들어진다. 상태를 공유하려면 Context로 끌어올려야 한다. 이름 규칙은 관습이 아니라 계약에 가깝다. 린터가 `use` 접두어를 보고 훅 호출 규칙(최상위에서만, 조건문 밖에서만)을 검사하기 때문이다. 훅을 호출하지 않는 함수에는 `use`를 붙이지 않는다.

TanStack Query는 서버 상태를 다루는 라이브러리다. 서버 상태는 클라이언트가 소유하지 않고, 비동기로 읽어 오며, 다른 사용자가 바꿀 수 있어 언제든 오래된 값이 될 수 있다는 점에서 UI 상태와 성격이 다르다. 핵심 단위는 쿼리이며, 쿼리는 `queryKey`와 `queryFn`으로 정의한다. 키는 직렬화 가능한 배열이고 캐시의 식별자다. 같은 키를 쓰는 컴포넌트가 여러 개여도 요청은 중복 제거되고 캐시 한 곳을 바라본다. `queryFn`은 Promise를 반환하고 실패 시 throw해야 한다. fetch API는 HTTP 오류에서 reject하지 않으므로 응답 상태를 확인해 직접 던져야 한다.

쿼리 결과는 두 축으로 표현된다. `status`(`pending`·`error`·`success`)는 데이터 존재 여부를, `fetchStatus`(`fetching`·`paused`·`idle`)는 네트워크 활동 여부를 나타낸다. v5에서 `isLoading`은 "데이터가 없고 지금 가져오는 중"이라는 파생값이고, 최초 데이터 없음은 `isPending`이다. 캐시된 데이터는 `staleTime`이 지나면 stale로 표시되고, 마운트·창 포커스·네트워크 복구 시점에 백그라운드에서 다시 가져온다. 화면에서는 기존 데이터가 그대로 보이고 새 데이터로 교체되는 stale-while-revalidate 방식이다. 사용되지 않는 캐시는 `gcTime`이 지나면 수거된다.

Spring/Java에 빗대면 커스텀 훅은 재사용 가능한 로직을 묶은 컴포넌트 클래스 없는 서비스 메서드에 가깝고, TanStack Query는 Spring Cache의 `@Cacheable`과 TTL 기반 캐시 무효화를 클라이언트에 옮겨 놓은 것에 해당한다. `queryKey`가 캐시 키, `staleTime`이 TTL 역할을 한다.

## 코드

localStorage와 동기화되는 상태를 커스텀 훅으로 추출한 예다. 컴포넌트는 `useState`와 동일한 형태로 사용한다.

```tsx
import { useState, useEffect } from 'react';

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : initial;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}
```

TanStack Query v5 기본 사용이다. `QueryClientProvider`를 루트에 두고, 컴포넌트에서 `useQuery`를 객체 인자로 호출한다.

```tsx
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

type User = { id: number; name: string };

async function fetchUser(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function UserCard({ id }: { id: number }) {
  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: ['user', id],
    queryFn: () => fetchUser(id),
    staleTime: 60_000,
  });

  if (isPending) return <p>불러오는 중</p>;
  if (isError) return <p>오류: {error.message}</p>;
  return (
    <p>
      {data.name} {isFetching && '(갱신 중)'}
    </p>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 5 * 60_000 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <UserCard id={1} />
    </QueryClientProvider>
  );
}
```

쿼리 정의 자체를 커스텀 훅으로 감싸면 키와 fetch 함수가 한 곳에 모이고, 호출부는 도메인 API처럼 읽힌다. `enabled`로 인자가 준비되기 전 요청을 막는다.

```tsx
import { useQuery } from '@tanstack/react-query';

export function useUser(id: number | undefined) {
  return useQuery({
    queryKey: ['user', id],
    queryFn: () => fetchUser(id!),
    enabled: id !== undefined,
  });
}
```

## 실무에서 걸리는 지점

- ==**queryKey에 모든 의존 값을 넣어야 한다.** 페이지 번호나 필터가 `queryFn`에는 쓰이는데 키에 빠져 있으면 다른 조건의 결과가 같은 캐시로 섞인다.== 키는 함수 인자의 전부를 담는다는 원칙으로 설계한다.
- **staleTime 기본값은 0이다.** 기본 설정에서는 마운트·포커스마다 재요청이 일어나 API 호출량이 예상보다 커진다. 도메인별로 허용 가능한 최신성에 맞춰 `staleTime`을 명시하고, `refetchOnWindowFocus`를 전역에서 조정한다.
- **커스텀 훅은 상태를 공유하지 않는다.** 같은 훅을 두 곳에서 부르면 두 개의 상태가 생긴다. TanStack Query는 키 기준으로 캐시를 공유하므로 이 문제가 없지만, 순수 `useState` 기반 커스텀 훅을 전역 상태처럼 오해해 버그가 생긴다.
- **Effect 기반 fetch를 그대로 훅에 옮기기만 하면 문제는 남는다.** race와 언마운트 후 setState는 추출로 해결되지 않는다. 직접 구현한다면 취소 플래그나 AbortController를 넣어야 하고, 대개는 라이브러리에 위임하는 쪽이 비용이 낮다.
- **v5에서 `isLoading`의 의미가 바뀌었다.** v4의 `isLoading`은 v5의 `isPending`에 해당한다. 마이그레이션 시 로딩 분기 조건을 확인하지 않으면 데이터 없는 상태에서 빈 화면이 렌더된다. `useQuery`는 객체 인자 시그니처만 지원한다.

## 관련 글

- [useState·useEffect — 상태와 부수 효과](/notes/react/usestate-useeffect/)
- [Context·useReducer·상태 설계](/notes/react/context-usereducer-state-design/)
- [React 19 — Actions·use·Server Components](/notes/react/react19-actions-use-server-components/)
