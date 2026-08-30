---
title: "Route Handlers·미들웨어·인증"
series: nextjs
part: "기능"
order: 6
summary: "API 엔드포인트는 route.ts, 요청 전 분기는 middleware.ts, 실제 권한 검증은 데이터 접근 계층에 둔다."
tags: [Next.js, Route Handlers, Middleware, Authentication, JWT]
sources: [https://nextjs.org/docs/app/building-your-application/routing/route-handlers, https://nextjs.org/docs/app/building-your-application/routing/middleware, https://nextjs.org/docs/app/building-your-application/authentication]
updated: 2026-08-30
---

페이지와 Server Actions만으로는 외부 서비스가 호출하는 웹훅, 모바일 앱용 JSON API, RSS 같은 비UI 응답을 만들 수 없다. 로그인하지 않은 사용자를 렌더링 전에 돌려보내는 로직을 페이지마다 흩어 두면 누락이 생긴다. Next.js는 이 요구를 Route Handlers, 미들웨어, 데이터 접근 계층 중심의 인증 패턴으로 나누어 처리하며, 계층 경계를 잘못 잡으면 보안 구멍과 성능 저하가 함께 생긴다.

## 핵심 개념

**Route Handlers**는 `app` 안의 `route.ts` 파일로 정의하는 서버 엔드포인트다. `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`를 함수 이름으로 export하면 해당 메서드에 매핑된다. 요청은 Web 표준 `Request`를 확장한 `NextRequest`로 들어오고 응답은 `Response`나 `NextResponse`로 돌려준다. 같은 세그먼트에 `page.tsx`와 `route.ts`를 함께 둘 수 없다. Next.js 15부터 `GET`은 기본 동적 실행이며, 정적 캐시가 필요하면 `dynamic = 'force-static'`이나 `revalidate`를 명시한다. 동적 세그먼트의 `params`는 Promise이므로 `await`한다. Spring으로 보면 `@RestController` 메서드 하나에 해당하고 파일 경로가 `@RequestMapping` 역할을 한다.

**미들웨어**는 프로젝트 루트의 `middleware.ts` 한 파일에 정의하며, 라우트 렌더링 전에 매칭된 모든 요청에 실행된다. 할 수 있는 일은 리다이렉트, 리라이트, 헤더·쿠키 수정, 직접 응답 반환이다. `config.matcher`를 지정하지 않으면 `_next/static`과 `public` 자산까지 거치므로 부정 매칭으로 제외한다. 실행 순서는 `next.config`의 `headers` → `redirects` → 미들웨어 → 파일시스템 라우트다. 15.5부터 Node.js 런타임이 안정화되었고, 16에서는 `proxy.ts`로 개명되며 `middleware`는 deprecated가 되었다. Spring 대응 개념은 Security Filter Chain이나, 전역 상태에 의존하지 않고 CDN 엣지에 배포될 수 있다는 점이 다르다.

**인증**은 세 단계로 나뉜다. 자격 증명 확인은 Server Action에서 zod 같은 스키마로 입력을 검증한 뒤 DB나 인증 제공자를 호출한다. 세션은 `jose`로 서명한 JWT를 `httpOnly`, `secure`, `sameSite: 'lax'` 쿠키에 담는 무상태 방식과, 세션 ID만 암호화해 쿠키에 두고 실데이터는 DB에 두는 방식 중 택한다. 인가는 미들웨어에서 쿠키만 복호화하는 낙관적 검사와, 데이터 접근 계층(DAL)의 `verifySession()`에서 하는 안전한 검사로 나뉜다. `verifySession()`은 React `cache`로 감싸 렌더 패스당 한 번만 실행되게 하고, Route Handler, Server Action, Server Component가 모두 이 함수를 호출한다. Spring의 서비스 계층 `@PreAuthorize` 검사와 같은 취지다.

## 코드

동적 세그먼트와 쿼리 파라미터를 읽고 세션을 검증하는 Route Handler다. `params`는 Promise이므로 `await`가 필요하다.

```ts
// app/api/teams/[teamId]/members/route.ts
import { type NextRequest } from 'next/server'
import { verifySession } from '@/lib/dal'
import { db } from '@/lib/db'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const session = await verifySession()
  if (!session) return new Response(null, { status: 401 })

  const { teamId } = await params
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '20')

  const members = await db.members.findMany({
    where: { teamId, userId: session.userId },
    take: limit,
    select: { id: true, name: true, role: true },
  })
  return Response.json({ members })
}

export async function POST(request: NextRequest) {
  const session = await verifySession()
  if (session?.role !== 'admin') return new Response(null, { status: 403 })

  const body = await request.json()
  return Response.json({ created: body }, { status: 201 })
}
```

세션 쿠키만 복호화해 보호 경로를 걸러내는 미들웨어다. 정적 자산은 matcher에서 제외한다.

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server'
import { decrypt } from '@/lib/session'

const protectedPrefixes = ['/dashboard', '/settings']
const publicRoutes = ['/login', '/signup']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isProtected = protectedPrefixes.some((p) => pathname.startsWith(p))
  const isPublic = publicRoutes.includes(pathname)

  const session = await decrypt(request.cookies.get('session')?.value)

  if (isProtected && !session?.userId) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }
  if (isPublic && session?.userId) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-request-id', crypto.randomUUID())
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)'],
}
```

`jose`로 세션을 발급·검증하고, DAL에서 `cache`로 감싼 `verifySession()`을 제공하는 코드다. `server-only`를 import해 클라이언트 번들 유입을 빌드 단계에서 차단한다.

```ts
// lib/session.ts
import 'server-only'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { cookies } from 'next/headers'

const key = new TextEncoder().encode(process.env.SESSION_SECRET)

export interface SessionPayload extends JWTPayload {
  userId: string
  role: 'admin' | 'user'
}

export async function encrypt(payload: SessionPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key)
}

export async function decrypt(token = ''): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify<SessionPayload>(token, key, { algorithms: ['HS256'] })
    return payload
  } catch {
    return null
  }
}

export async function createSession(userId: string, role: SessionPayload['role']) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const token = await encrypt({ userId, role })
  const store = await cookies()
  store.set('session', token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires,
  })
}

// lib/dal.ts
import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { decrypt } from '@/lib/session'

export const verifySession = cache(async () => {
  const token = (await cookies()).get('session')?.value
  const session = await decrypt(token)
  if (!session?.userId) return null
  return { userId: session.userId, role: session.role }
})
```

## 실무에서 걸리는 지점

- **미들웨어를 유일한 방어선으로 삼는 실수.** Server Action은 별도 라우트가 아니라 사용된 페이지 경로로 들어오는 POST이므로, matcher에서 그 경로를 제외하면 액션 호출도 미들웨어를 건너뛴다. 모든 Server Action과 Route Handler는 자체적으로 `verifySession()`을 호출해야 한다.
- **미들웨어에서 DB 조회.** 미들웨어는 프리페치 요청까지 포함해 매칭된 모든 요청마다 실행되므로, 세션 테이블을 조회하면 링크에 마우스를 올릴 때마다 쿼리가 나간다. 쿠키 복호화까지만 하고 DB 검증은 DAL로 미룬다.
- **레이아웃에서 인증 검사.** 레이아웃은 클라이언트 내비게이션 시 다시 렌더링되지 않아 경로 이동마다 세션이 재검사되지 않는다. 레이아웃이 `null`을 반환해도 하위 세그먼트와 병렬 라우트 슬롯은 따로 렌더링되어 RSC 페이로드에 데이터가 노출될 수 있다.
- **GET 핸들러 캐싱 기본값.** 14까지 정적 캐시였던 `GET`이 15부터 동적이 기본이다. RSS, sitemap 같은 정적 응답은 `dynamic = 'force-static'`을 명시하지 않으면 매 요청마다 실행된다.
- **`NextResponse.next()`의 헤더 옵션 혼동.** `next({ request: { headers } })`는 렌더링으로 전달되는 요청 헤더를 바꾸고, `next({ headers })`는 브라우저로 나가는 응답 헤더를 바꾼다. 인증 정보를 페이지로 넘기려다 클라이언트에 노출하는 사고가 이 차이에서 생긴다.
- **Next.js 16의 `proxy` 개명.** 코드모드 `middleware-to-proxy`로 이름을 바꾸고, 기본 런타임이 Node.js가 되었으므로 `runtime` 설정은 제거한다.

## 관련 글

- [Server Actions·폼·mutation](/notes/nextjs/server-actions-forms/)
- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [배포(Vercel·Docker)·환경변수·모니터링](/notes/nextjs/deployment-env-monitoring/)
