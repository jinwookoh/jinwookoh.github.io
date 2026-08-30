---
title: "이미지·폰트·메타데이터·SEO"
series: nextjs
part: "기능"
order: 7
summary: "next/image·next/font·Metadata API로 레이아웃 시프트 없이 이미지·폰트를 서빙하고 SEO 태그를 코드로 관리하는 법"
tags: [Next.js, next/image, next/font, Metadata API, SEO]
sources: [https://nextjs.org/docs/app/building-your-application/optimizing/images, https://nextjs.org/docs/app/building-your-application/optimizing/fonts, https://nextjs.org/docs/app/building-your-application/optimizing/metadata]
updated: 2026-08-30
---

`<img>` 태그에 원본 이미지를 그대로 걸면 모바일에서도 데스크톱용 파일을 받고, 크기를 미리 알 수 없어 로딩 중 레이아웃이 밀린다. 폰트를 외부 CDN에서 가져오면 추가 네트워크 왕복이 생기고 폴백 폰트가 웹폰트로 바뀌는 순간 글자가 흔들린다. `<head>`의 title·OG 태그를 페이지마다 손으로 쓰면 누락과 중복이 쌓인다. ==Next.js는 이 세 가지를 각각 `next/image`, `next/font`, Metadata API로 빌드 또는 서버 렌더링 시점에 해결한다.==

## 핵심 개념

### next/image

`<Image>`는 HTML `<img>`를 감싸는 컴포넌트다. ==기기 폭에 맞춰 리사이즈하고 WebP로 변환해 서빙하며, `width`·`height`(또는 `fill`)를 강제해 CLS를 막는다.== 뷰포트 밖 이미지는 기본적으로 지연 로딩된다.

프로젝트 안의 파일을 `import`하면 빌드 시점에 크기와 `blurDataURL`이 자동으로 채워진다. 원격 URL은 빌드 시 접근할 수 없으므로 `width`·`height`를 직접 넘기고, `next.config.ts`의 `images.remotePatterns`에 허용 호스트를 등록해야 한다. 파일명이 런타임에 정해지면 Server Component에서 `await import()`로 불러와 같은 메타데이터를 얻을 수 있다.

### next/font

`next/font`는 폰트를 셀프 호스팅한다. Google Fonts도 빌드 시 파일을 내려받아 배포 도메인에서 서빙하므로 브라우저가 Google에 요청을 보내지 않는다. `size-adjust`를 적용한 폴백 폰트를 자동 생성해 폰트 교체 시 레이아웃 흔들림을 줄인다. `next/font/google`의 폰트 함수나 `next/font/local`의 `localFont`를 호출하고, 반환된 `className` 또는 `variable`을 요소에 붙인다. 전역 적용은 Root Layout의 `<html>`에 붙인다.

### Metadata API

`layout.tsx`·`page.tsx`에서 `metadata` 객체를 export하면 정적, `generateMetadata` 함수를 export하면 데이터 의존 메타데이터가 된다. 둘 다 Server Component 전용이고, 중첩 레이아웃의 값은 상위에서 하위로 병합된다. 파일 규칙도 있다. `app/` 아래 `favicon.ico`, `opengraph-image.jpg`, `robots.ts`, `sitemap.ts`는 라우트로 노출되고 `<head>` 태그가 자동 생성된다. `opengraph-image.tsx`에서 `next/og`의 `ImageResponse`를 반환하면 JSX로 OG 이미지를 동적 렌더링한다.

Spring 대응으로 보면 `generateMetadata`는 뷰에 `<head>` 모델을 주입하는 `@ControllerAdvice`, `sitemap.ts`·`robots.ts`는 XML·텍스트를 반환하는 `@RestController` 엔드포인트에 해당한다.

## 코드

Root Layout에서 Google 폰트를 CSS 변수로 등록하고, 정적 메타데이터의 `title.template`과 `metadataBase`를 잡는다.

```tsx
// app/layout.tsx
import type { Metadata } from 'next'
import { Noto_Sans_KR } from 'next/font/google'
import './globals.css'

const notoSansKr = Noto_Sans_KR({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://example.com'),
  title: { default: 'Tech Notes', template: '%s | Tech Notes' },
  description: '백엔드 개발자의 기술 노트',
  openGraph: { type: 'website', locale: 'ko_KR', siteName: 'Tech Notes' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={notoSansKr.variable}>
      <body className="font-sans">{children}</body>
    </html>
  )
}
```

동적 라우트에서 `generateMetadata`와 페이지가 같은 데이터를 쓰도록 `react`의 `cache`로 조회를 메모이즈하고, 본문 이미지는 `remotePatterns`에 등록된 원격 소스를 `fill`과 `sizes`로 렌더링한다. Next.js 15에서 `params`는 Promise이므로 `await`해야 한다.

```tsx
// app/lib/posts.ts
import { cache } from 'react'

export type Post = { slug: string; title: string; summary: string; cover: string }

export const getPost = cache(async (slug: string): Promise<Post> => {
  const res = await fetch(`https://api.example.com/posts/${slug}`, {
    next: { revalidate: 3600 },
  })
  if (!res.ok) throw new Error('post not found')
  return res.json()
})

// app/blog/[slug]/page.tsx
import type { Metadata } from 'next'
import Image from 'next/image'
import { getPost } from '@/app/lib/posts'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await getPost(slug)
  return {
    title: post.title,
    description: post.summary,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: { title: post.title, description: post.summary, images: [post.cover] },
  }
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  const post = await getPost(slug)
  return (
    <article>
      <div style={{ position: 'relative', aspectRatio: '16 / 9' }}>
        <Image
          src={post.cover}
          alt={post.title}
          fill
          priority
          sizes="(max-width: 768px) 100vw, 768px"
          style={{ objectFit: 'cover' }}
        />
      </div>
      <h1>{post.title}</h1>
    </article>
  )
}
```

```ts
// next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.example.com', pathname: '/posts/**' },
    ],
  },
}

export default config
```

사이트맵과 robots를 코드로 생성한다. 각각 `/sitemap.xml`, `/robots.txt`로 서빙된다.

```ts
// app/sitemap.ts
import type { MetadataRoute } from 'next'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts: { slug: string; updatedAt: string }[] = await fetch(
    'https://api.example.com/posts',
  ).then((r) => r.json())

  return [
    { url: 'https://example.com', lastModified: new Date(), changeFrequency: 'weekly' },
    ...posts.map((p) => ({
      url: `https://example.com/blog/${p.slug}`,
      lastModified: new Date(p.updatedAt),
    })),
  ]
}

// app/robots.ts
import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/admin/'] },
    sitemap: 'https://example.com/sitemap.xml',
  }
}
```

## 실무에서 걸리는 지점

- ==**`sizes`를 빼먹으면 최적화 효과가 반감된다.** `fill`이나 반응형 이미지에 `sizes`가 없으면 브라우저는 100vw 기준으로 후보를 고르므로 작은 썸네일에도 큰 파일이 내려온다.== 실제 렌더링 폭에 맞춰 적어야 srcset이 의미를 가진다.
- **LCP 이미지에는 `priority`를 붙인다.** 기본값이 지연 로딩이라 첫 화면 히어로 이미지도 늦게 요청된다. `priority`는 preload 힌트를 넣으므로 화면당 한두 장에만 쓴다.
- **셀프 호스팅에서는 이미지 최적화가 서버 CPU를 쓴다.** `sharp`가 요청 시점에 리사이즈하고 캐시한다. 트래픽이 크면 `images.loader`로 외부 CDN에 위임하는 편이 안전하다. `remotePatterns`를 와일드카드로 열어 두면 최적화 엔드포인트가 임의 URL 프록시로 악용될 수 있다.
- **`next/font` 호출은 모듈 최상위여야 한다.** 컴포넌트 함수 안에서 호출하면 빌드 에러가 나고, 여러 파일에서 같은 폰트를 각각 호출하면 인스턴스가 중복 생성된다. 한 모듈에서 export해 재사용한다.
- **`metadataBase`가 없으면 상대 경로 OG 이미지가 깨진다.** `openGraph.images`의 상대 경로는 절대 URL로 바꿀 기준이 필요하다. 로컬에서는 경고만 내지만 배포 환경에서는 잘못된 도메인이 박힐 수 있으니 Root Layout에 명시한다.
- **스트리밍 메타데이터와 크롤러.** 동적 페이지의 `generateMetadata`는 UI 렌더링을 막지 않고 별도로 스트리밍된다. HTML만 읽는 봇은 User-Agent로 감지해 블로킹 방식으로 되돌리므로, 미등록 봇이 있다면 `htmlLimitedBots`에 추가해야 OG 미리보기가 비지 않는다.

## 관련 글

- [데이터 페칭·캐싱·revalidate](/notes/nextjs/data-fetching-caching/)
- [Server Components와 Client Components](/notes/nextjs/server-vs-client-components/)
- [성능·번들·스트리밍](/notes/nextjs/performance-bundling-streaming/)
