---
title: "Server Actions·폼·mutation"
series: nextjs
part: "데이터"
order: 5
summary: "폼 제출과 데이터 변경을 API 라우트 없이 서버 함수 하나로 처리하고 캐시까지 갱신하는 방법"
tags: [Next.js, Server Actions, useActionState, revalidatePath, FormData]
sources: [https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations]
updated: 2026-08-30
---

전통적인 React 앱에서 데이터 하나를 바꾸려면 손이 많이 간다. 서버에 POST 엔드포인트를 만들고, 클라이언트에서 `fetch`를 호출하는 핸들러를 쓰고, 로딩·에러 상태를 `useState`로 관리하고, 성공하면 다시 목록을 불러오는 코드를 붙인다. 요청 바디의 타입은 양쪽에서 각자 유지해야 하고, JavaScript가 로드되기 전에는 폼이 동작하지 않는다. Server Actions는 이 왕복 구조를 함수 호출 하나로 접는다. 서버에서 실행되는 async 함수를 폼의 `action`에 직접 넘기면 Next.js가 직렬화·전송·실행·UI 갱신을 한 번의 요청으로 처리한다.

## 핵심 개념

Server Action은 `'use server'` 지시어가 붙은 비동기 함수다. 함수 본문 첫 줄에 붙이면 그 함수만, 파일 첫 줄에 붙이면 그 파일의 모든 export가 서버 함수가 된다. Server Component 안에 인라인으로 정의할 수 있고, Client Component에서는 정의할 수 없으므로 별도 파일에서 import하거나 props로 받아 사용한다.

호출 방식은 두 가지다. 첫째는 `<form action={fn}>` 또는 `<button formAction={fn}>`으로, 이 경우 함수는 `FormData`를 인자로 받는다. Server Component의 폼은 점진적 향상을 지원해서 하이드레이션 전이나 JavaScript가 꺼진 환경에서도 일반 HTML 폼처럼 제출된다. 둘째는 Client Component의 이벤트 핸들러나 `useEffect`에서 일반 함수처럼 호출하는 방식으로, 인자와 반환값은 직렬화 가능한 값이어야 한다.

내부적으로 모든 Server Action은 POST 요청으로 전달되며 다른 HTTP 메서드로는 호출되지 않는다. 빌드 시 각 액션에는 암호화된 ID가 부여되어 클라이언트는 이 ID로만 함수를 참조한다. 클로저로 캡처한 변수는 암호화되어 클라이언트를 거쳐 돌아오고, 사용되지 않는 액션은 빌드에서 제거된다. 액션이 완료되면 서버는 갱신된 RSC 페이로드를 같은 응답에 실어 보내므로, `revalidatePath`·`revalidateTag`·`redirect`·`cookies().set`을 액션 안에서 호출하면 별도 요청 없이 화면이 새 데이터로 바뀐다.

상태 관리는 React 19 훅에 맡긴다. `useActionState(action, initialState)`는 `[state, formAction, pending]`을 반환하며, 액션의 첫 인자로 이전 상태가 주입된다. `useFormStatus`는 부모 `<form>`의 제출 상태를 자식 컴포넌트에서 읽고, `useOptimistic`은 서버 응답 전에 UI를 먼저 바꾼다.

Spring 관점에서 보면 Server Action은 `@PostMapping` 컨트롤러 메서드와 서비스 호출을 합친 것에 가깝다. 다만 URL과 DTO를 개발자가 설계하지 않고 프레임워크가 함수 참조를 엔드포인트로 승격시킨다는 점이 다르다. `revalidatePath`는 `@CacheEvict`에 대응한다.

## 코드

파일 단위로 `'use server'`를 선언한 액션 모듈이다. 인증 확인, 입력 검증, 변경, 캐시 무효화, 리다이렉트가 한 함수 안에 순서대로 들어간다.

```ts
// app/lib/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

const PostSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1),
})

export type PostFormState = {
  errors?: Record<string, string[]>
  message?: string
}

export async function createPost(
  _prev: PostFormState,
  formData: FormData,
): Promise<PostFormState> {
  const session = await auth()
  if (!session?.user) {
    return { message: '로그인이 필요하다.' }
  }

  const parsed = PostSchema.safeParse({
    title: formData.get('title'),
    content: formData.get('content'),
  })
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  await db.post.create({
    data: { ...parsed.data, authorId: session.user.id },
  })

  revalidatePath('/posts')
  redirect('/posts')
}
```

Client Component에서 `useActionState`로 액션을 감싸 검증 오류와 pending 상태를 표시한다. 제출 버튼은 `useFormStatus`로 부모 폼의 상태를 읽는다.

```tsx
// app/posts/new/form.tsx
'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { createPost, type PostFormState } from '@/app/lib/actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending}>
      {pending ? '저장 중' : '저장'}
    </button>
  )
}

export function PostForm() {
  const [state, formAction] = useActionState<PostFormState, FormData>(
    createPost,
    {},
  )

  return (
    <form action={formAction}>
      <input name="title" />
      {state.errors?.title && <p>{state.errors.title[0]}</p>}
      <textarea name="content" />
      {state.errors?.content && <p>{state.errors.content[0]}</p>}
      {state.message && <p>{state.message}</p>}
      <SubmitButton />
    </form>
  )
}
```

폼 없이 이벤트 핸들러에서 호출하면서 `useOptimistic`으로 응답 전에 UI를 먼저 반영하는 예다. 액션이 실패하면 React가 낙관적 값을 자동으로 되돌린다.

```tsx
// app/posts/[id]/like-button.tsx
'use client'

import { useOptimistic, useTransition } from 'react'
import { incrementLike } from '@/app/lib/actions'

export function LikeButton({ postId, likes }: { postId: string; likes: number }) {
  const [optimisticLikes, addOptimistic] = useOptimistic(
    likes,
    (current, delta: number) => current + delta,
  )
  const [isPending, startTransition] = useTransition()

  return (
    <button
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          addOptimistic(1)
          await incrementLike(postId)
        })
      }
    >
      좋아요 {optimisticLikes}
    </button>
  )
}
```

## 실무에서 걸리는 지점

- **액션은 공개 엔드포인트다.** ==UI를 거치지 않고 직접 POST로 호출할 수 있으므로 모든 액션 안에서 인증과 소유권 확인을 다시 한다.== 페이지에서 이미 검사했다는 이유로 액션에서 생략하면 권한 우회 경로가 된다.
- **`redirect`는 throw다.** 내부적으로 예외를 던져 제어 흐름을 끊으므로 `try/catch` 안에서 호출하면 catch가 리다이렉트를 삼킨다. `redirect`와 `revalidatePath`는 try 블록 밖에서 호출하고, 캐시 무효화는 `redirect`보다 먼저 실행한다.
- **예외를 UI에 그대로 노출하지 않는다.** 액션에서 throw한 에러는 가장 가까운 `error.tsx`로 전달되고 프로덕션에서는 메시지가 가려진다. 검증 실패처럼 사용자가 고쳐야 하는 오류는 throw 대신 상태 객체로 반환해서 `useActionState`로 렌더링하는 편이 낫다.
- **직렬 실행과 응답 크기.** ==클라이언트는 액션을 한 번에 하나씩 순서대로 전송하고 응답을 기다린다.== 버튼 연타나 목록 항목별 액션이 병렬 처리를 기대하면 지연이 누적된다. 또 응답에는 갱신된 트리의 RSC 페이로드가 함께 실리므로 큰 페이지에서 잦은 mutation은 전송량이 커진다. 조회 목적이라면 액션 대신 Server Component의 데이터 페칭을 쓴다.
- **클로저 변수와 페이로드 한도.** 인라인 액션이 캡처한 변수는 암호화되어 클라이언트를 왕복하므로 큰 객체를 캡처하면 폼 크기가 늘어난다. ==기본 바디 제한은 1MB이며 파일 업로드 등에서 초과하면 `serverActions.bodySizeLimit`을 조정한다.== 리버스 프록시 뒤에서는 `serverActions.allowedOrigins`를 설정하지 않으면 origin 불일치로 요청이 거부된다.

## 관련 글

- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [Route Handlers·미들웨어·인증](/notes/nextjs/route-handlers-middleware-auth/)
