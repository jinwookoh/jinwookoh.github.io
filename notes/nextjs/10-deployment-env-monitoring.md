---
title: "배포(Vercel·Docker)·환경변수·모니터링"
series: nextjs
part: "운영"
order: 10
summary: "Next.js를 Vercel과 Docker 중 어디에 올리든 환경변수의 빌드·런타임 경계와 instrumentation 훅을 알아야 운영이 된다"
tags: [Next.js, Vercel, Docker, Environment Variables, Instrumentation]
sources: [https://nextjs.org/docs/app/building-your-application/deploying, https://nextjs.org/docs/app/building-your-application/configuring/environment-variables, https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation]
updated: 2026-08-30
---

`next dev`에서 잘 돌던 애플리케이션이 운영에서 무너지는 원인은 대체로 세 가지다. 배포 형태를 정하지 않아 ISR·이미지 최적화·미들웨어가 절반만 동작하거나, 환경변수가 빌드 시점에 굳어 스테이징 값이 운영 번들에 박히거나, 서버 예외가 어디에도 기록되지 않아 사용자 신고로 장애를 알게 된다. 배포 방식, 환경변수 경계, 관측 훅을 함께 설계해야 한다.

## 핵심 개념

### 배포 형태 네 가지

실행 환경에 따라 지원 범위가 달라진다.

| 형태 | 기능 지원 | 비고 |
| --- | --- | --- |
| Node.js 서버 (`next start`) | 전부 | 가장 단순한 자체 호스팅 |
| Docker 컨테이너 | 전부 | `output: 'standalone'`으로 최소 이미지 생성 |
| 정적 내보내기 (`output: 'export'`) | 제한 | 서버가 필요한 기능(Route Handler 동적 처리·ISR·미들웨어) 불가 |
| 어댑터 (Vercel 등) | 플랫폼별 | Vercel과 Bun은 검증된 어댑터, 그 외는 자체 통합 |

Vercel에서는 ISR 캐시·이미지 최적화·Edge 미들웨어가 별도 설정 없이 연결되지만 자체 호스팅에서는 직접 채워야 한다. `output: 'standalone'`을 켜면 `.next/standalone` 아래에 `server.js`와 필요한 `node_modules`만 추려진 결과물이 생긴다. ==`public`과 `.next/static`은 포함되지 않으므로 Dockerfile에서 직접 옮긴다.==

Spring으로 치면 `next start`는 내장 Tomcat으로 fat jar를 띄우는 것이고, standalone은 jlink로 런타임을 최소화한 이미지에 해당한다.

### 환경변수의 두 경계

환경변수는 `.env*` 파일에서 `process.env`로 로드된다. 조회 순서는 `process.env` → `.env.$(NODE_ENV).local` → `.env.local` → `.env.$(NODE_ENV)` → `.env`이며, 먼저 발견된 값에서 멈춘다. `test` 환경에서는 `.env.local`을 읽지 않고, `$VAR`로 다른 변수를 참조할 수 있으며, `src` 폴더를 써도 `.env`는 루트에 둔다.

접두사 없는 변수는 서버 런타임에서만 읽힌다. `NEXT_PUBLIC_` 접두사가 붙은 변수는 `next build` 시점에 값이 문자열 상수로 번들에 인라인된다. 빌드 이후 변경할 수 없고, `process.env[name]`처럼 동적으로 접근하면 인라인되지 않는다. ==서버 변수도 정적 렌더링 페이지에서는 빌드 시점 값으로 고정될 수 있으므로, 런타임 값이 필요하면 `connection()`으로 동적 렌더링에 들어간 뒤 읽는다.== Spring과 비교하면 `NEXT_PUBLIC_`은 Maven 리소스 필터링처럼 산출물에 박히는 값이고, 서버 변수만이 `application.yml` 프로파일 오버라이드에 가깝다.

### instrumentation 훅

프로젝트 루트(또는 `src`)의 `instrumentation.ts`는 서버 인스턴스 기동 시 한 번 호출되는 `register()`와, 서버 렌더링·Route Handler·미들웨어의 미처리 예외마다 호출되는 `onRequestError()`를 내보낸다. `register`는 요청 처리 전에 완료되어야 하며 OpenTelemetry 초기화를 여기서 한다. Node.js와 Edge 양쪽에서 호출되므로 `process.env.NEXT_RUNTIME`으로 분기해 동적 import한다. Spring의 `ApplicationRunner`와 `@ControllerAdvice` 전역 예외 핸들러를 한 파일에 모은 형태다.

## 코드

standalone 출력을 켜고 ISR 캐시를 외부 저장소로 돌리는 설정이다. 여러 컨테이너가 캐시를 공유하려면 `cacheHandler`가 필요하다.

```ts
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  cacheHandler: process.env.NODE_ENV === 'production'
    ? require.resolve('./cache-handler.mjs')
    : undefined,
  cacheMaxMemorySize: 0, // 인메모리 캐시 비활성화, 외부 핸들러만 사용
}

export default nextConfig
```

standalone 산출물을 멀티 스테이지로 담는 Dockerfile이다. `public`과 `.next/static`은 별도로 복사한다.

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
```

OpenTelemetry 초기화와 서버 예외 보고를 한 파일에 둔 instrumentation이다. `onRequestError`의 두 번째·세 번째 인자로 요청 정보와 라우트 종류가 전달된다.

```ts
// instrumentation.ts
import type { Instrumentation } from 'next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerOTel } = await import('@vercel/otel')
    registerOTel({ serviceName: 'shop-web' })
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  await fetch(process.env.ERROR_SINK_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: (err as Error).message,
      digest: (err as { digest?: string }).digest,
      path: request.path,
      method: request.method,
      routerKind: context.routerKind,   // 'App Router' | 'Pages Router'
      routeType: context.routeType,     // 'render' | 'route' | 'action' | 'middleware'
      renderSource: context.renderSource,
    }),
  })
}
```

## 실무에서 걸리는 지점

- **하나의 이미지를 여러 환경으로 승격할 때 `NEXT_PUBLIC_` 값이 고정된다.** ==스테이징에서 빌드한 이미지를 운영에 올리면 브라우저 번들의 API 주소가 스테이징을 가리킨다.== 환경마다 빌드하거나, 서버 컴포넌트에서 런타임에 읽어 props로 내려보낸다.
- **standalone 이미지에 `sharp`가 빠지면 이미지 최적화가 느려진다.** 멀티 스테이지 빌드에서 네이티브 바이너리가 runner 스테이지 플랫폼과 맞지 않으면 최적화가 실패하므로 builder와 runner의 베이스 이미지 아키텍처를 맞춘다.
- **컨테이너를 여러 개 띄우면 ISR 캐시가 인스턴스마다 갈라진다.** 기본 파일 시스템 캐시는 로컬 디스크에 쓰이므로 재검증 결과가 전파되지 않는다. Redis 같은 공유 저장소를 `cacheHandler`로 연결한다.
- **`register()`가 오래 걸리면 서버 준비가 지연된다.** 첫 요청 전에 끝나야 하므로 외부 서비스 연결을 여기서 기다리면 컨테이너 헬스체크가 실패한다. 무거운 초기화는 lazy 연결로 미룬다.
- **`onRequestError`는 클라이언트 예외를 잡지 않는다.** 브라우저 오류는 `error.tsx` 경계와 별도의 클라이언트 리포팅으로 수집하고, `digest`를 기준으로 서버 로그와 대조한다.

## 관련 글

- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [Route Handlers·미들웨어·인증](/notes/nextjs/route-handlers-middleware-auth/)
- [성능·번들·스트리밍](/notes/nextjs/performance-bundling-streaming/)
