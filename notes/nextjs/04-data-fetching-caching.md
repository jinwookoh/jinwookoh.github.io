---
title: "데이터 페칭·캐싱·revalidate"
series: nextjs
part: "데이터"
order: 4
summary: "Next.js 15의 네 가지 캐시 계층과 fetch 옵션·revalidate·태그 무효화를 어떤 기준으로 조합하는지 정리한다"
tags: [Next.js, Data Cache, ISR, revalidateTag, unstable_cache]
sources: [https://nextjs.org/docs/app/building-your-application/data-fetching/fetching, https://nextjs.org/docs/app/building-your-application/caching, https://nextjs.org/docs/app/building-your-application/data-fetching/incremental-static-regeneration]
updated: 2026-08-30
---

Server Component는 서버에서 직접 데이터를 읽어 렌더링하므로, 캐시 전략을 정하지 않으면 페이지 요청마다 원격 API와 DB를 그대로 때린다. 반대로 캐시를 켜 두고 무효화 경로를 설계하지 않으면 데이터를 수정해도 화면이 바뀌지 않는다. Next.js는 이 문제를 요청 메모이제이션, Data Cache, Full Route Cache, Router Cache라는 네 계층으로 나누어 처리하며, 각 계층이 어디에 살고 언제 비워지는지 알아야 "왜 데이터가 안 바뀌는가"와 "왜 매번 느린가"를 구분할 수 있다.

## 핵심 개념

네 계층은 저장 위치와 수명이 다르다.

| 계층 | 위치 | 대상 | 수명 |
|---|---|---|---|
| Request Memoization | 서버, 렌더 1회 | 같은 URL·옵션의 `fetch` 반환값 | 한 번의 렌더 트리가 끝나면 소멸 |
| Data Cache | 서버, 배포 간 유지 | `fetch` 응답, `unstable_cache` 결과 | revalidate 시간 또는 on-demand 무효화까지 |
| Full Route Cache | 서버 | 프리렌더된 RSC payload + HTML | Data Cache 무효화·재배포까지 |
| Router Cache | 브라우저 메모리 | 방문한 세그먼트의 RSC payload | 세션 동안, 동적 세그먼트는 짧게 |

요청 메모이제이션은 React의 기능이다. 한 렌더 패스 안에서 동일한 `fetch(url, options)`가 여러 컴포넌트에서 호출되면 첫 호출만 네트워크로 나가고 나머지는 결과를 공유한다. `fetch`가 아닌 ORM 호출은 React의 `cache()`로 감싸야 같은 효과를 얻는다.

Data Cache는 Next.js가 서버에 두는 영속 캐시다. Next.js 15부터 `fetch`의 기본값은 캐시하지 않음이며, `cache: 'force-cache'`를 명시하거나 `next: { revalidate: n }`을 주어야 저장된다. 14까지는 기본이 캐시였으므로 마이그레이션 시 동작이 뒤집힌다. `next: { tags: [...] }`로 항목에 태그를 붙이면 `revalidateTag`로 묶어서 지울 수 있다. `fetch`를 쓰지 않는 DB 쿼리는 `unstable_cache(fn, keyParts, { revalidate, tags })`로 감싸 Data Cache에 넣는다.

Full Route Cache는 빌드 시점에 정적으로 렌더링된 라우트의 결과물이다. 라우트 안의 모든 데이터가 캐시 가능하고 `cookies()`, `headers()`, `searchParams` 같은 요청 시점 API를 쓰지 않으면 정적 라우트가 되어 여기에 저장된다. 하나라도 동적 요소가 있으면 라우트 전체가 요청마다 렌더링되지만, Data Cache는 별개로 계속 동작한다.

ISR은 Full Route Cache에 시간 조건을 붙인 것이다. 세그먼트에서 `export const revalidate = 60`을 내보내면 60초가 지난 뒤 들어온 첫 요청은 오래된 페이지를 즉시 받고, 백그라운드에서 재생성이 시작되며, 성공하면 다음 요청부터 새 페이지가 나간다. 재생성 중 예외가 나면 마지막 성공본이 계속 서빙된다. `revalidatePath`와 `revalidateTag`는 캐시를 지우기만 하고 다음 요청 때 재생성한다.

Spring과 견주면 Data Cache는 `@Cacheable` + TTL, `revalidateTag`는 `@CacheEvict(allEntries)`에 해당하며, 요청 메모이제이션은 요청 스코프 빈에 결과를 담아 두는 것과 같다.

## 코드

세그먼트 단위 ISR과 개별 `fetch`의 태그를 함께 쓴 목록 페이지다. `revalidate`는 정적으로 분석 가능한 리터럴이어야 한다.

```ts
// app/posts/page.tsx
export const revalidate = 3600

interface Post {
  id: number
  title: string
}

export default async function PostsPage() {
  const res = await fetch('https://api.example.com/posts', {
    next: { tags: ['posts'] },
  })
  const posts: Post[] = await res.json()

  return (
    <ul>
      {posts.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  )
}
```

DB를 직접 읽는 함수는 `unstable_cache`로 Data Cache에 넣고, 같은 렌더 안의 중복 호출은 React `cache`로 합친다.

```ts
// lib/posts.ts
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/db'

export const getPostsCached = unstable_cache(
  async () => db.post.findMany({ orderBy: { createdAt: 'desc' } }),
  ['posts-list'],
  { revalidate: 3600, tags: ['posts'] },
)

export const getPost = cache(async (id: number) => {
  return db.post.findUnique({ where: { id } })
})
```

쓰기 이후에는 Server Action에서 태그를 무효화한다. 경로 전체를 지우려면 `revalidatePath`를 쓴다.

```ts
// app/posts/actions.ts
'use server'

import { revalidateTag, revalidatePath } from 'next/cache'
import { db } from '@/lib/db'

export async function createPost(formData: FormData) {
  const title = String(formData.get('title') ?? '')
  await db.post.create({ data: { title } })
  revalidateTag('posts')
  revalidatePath('/posts')
}
```

## 실무에서 걸리는 지점

- 15 기본값 역전. 14에서 캐시에 기대던 `fetch`가 15에서는 매 요청 원격 호출로 바뀐다. 업그레이드 후 외부 API 호출량이 급증하면 이 지점부터 확인한다.
- 동적 요소 하나가 라우트 전체를 동적으로 만든다. layout에서 `cookies()`를 읽으면 그 아래 모든 page가 Full Route Cache에서 빠진다. 사용자별 정보는 Client Component나 별도 Suspense 경계로 분리한다.
- revalidate 값은 라우트에서 가장 짧은 값이 이긴다. ==한 `fetch`에 `revalidate: 0`이나 `no-store`가 있으면 라우트가 동적 렌더링으로 전환된다.== `revalidate = 60 * 10` 같은 계산식은 빌드가 거부한다.
- ==다중 인스턴스 배포에서 기본 캐시는 파일 시스템이라 인스턴스마다 따로 존재한다.== `revalidateTag`가 호출을 받은 인스턴스만 비우므로 Redis 등 공유 cacheHandler를 설정해야 한다.
- ==개발 서버에서는 페이지가 항상 즉시 렌더링되고 캐시되지 않는다.== ISR 검증은 `next build` 후 `next start`로 하고, `next.config`의 `logging.fetches.fullUrl`을 켜면 어떤 `fetch`가 캐시를 탔는지 로그로 드러난다.

## 관련 글

- [Next.js란 — App Router와 렌더링 모델 (SSR·SSG·ISR·CSR)](/notes/nextjs/what-is-nextjs-rendering/)
- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [Server Actions·폼·mutation](/notes/nextjs/server-actions-forms/)
