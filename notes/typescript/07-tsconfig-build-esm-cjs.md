---
title: "tsconfig·빌드·ESM과 CJS"
series: typescript
part: "빌드와 실무"
order: 7
summary: "module·moduleResolution·verbatimModuleSyntax가 ESM/CJS 출력을 어떻게 결정하는지 정리한다"
tags: [TypeScript, tsconfig, ESM, CommonJS, Node.js]
sources: [https://www.typescriptlang.org/tsconfig/, https://www.typescriptlang.org/docs/handbook/modules/theory.html, https://www.typescriptlang.org/docs/handbook/modules/reference.html]
updated: 2026-08-30
---

로컬에서는 잘 돌던 TypeScript 코드가 배포 환경에서 `ERR_REQUIRE_ESM`이나 `Cannot use import statement outside a module`로 죽는 경우가 있다. 원인은 대부분 코드가 아니라 tsconfig에 있다. 컴파일러는 `module`과 `moduleResolution`에 따라 같은 `import` 문을 ESM으로 남기기도 하고 `require()`로 바꾸기도 하며, 어떤 파일에서 타입을 읽을지도 다르게 판단한다. ==이 설정이 실제 런타임의 동작과 어긋나면 타입 검사는 통과하고 실행만 실패한다.==

## 핵심 개념

모듈 관련 옵션은 두 질문에 답한다. 출력 파일의 모듈 형식은 무엇인가(`module`), 그리고 `import "x"`를 어떤 파일로 해석할 것인가(`moduleResolution`). 컴파일러가 임의로 정하는 것이 아니라 실제 실행 환경이 하는 일을 그대로 따라야 한다.

Node 런타임을 대상으로 할 때는 `module: "nodenext"`를 쓴다. ==이 모드에서 파일의 형식은 tsconfig가 아니라 가장 가까운 `package.json`의 `"type"` 필드와 파일 확장자로 결정된다.== `"type": "module"`이면 `.ts`가 ESM으로, 없으면 CJS로 출력되고, `.mts`/`.cts`는 각각 강제로 ESM/CJS가 된다. 상대 경로 import에는 출력 확장자(`./util.js`)가 필수이며, `package.json`의 `exports`와 `import`/`require` 조건을 읽는다. TypeScript 5.9부터는 `module: "node20"`도 제공된다.

번들러(Vite, esbuild, Next.js)가 출력을 처리하면 `module: "esnext"` 또는 `"preserve"`와 `moduleResolution: "bundler"` 조합을 쓴다. `bundler`는 `exports` 조건을 읽으면서도 확장자 생략을 허용하고, `preserve`는 import/require 구문을 손대지 않는다.

`verbatimModuleSyntax`는 `import type`으로 표시한 것만 지우고 나머지 import는 그대로 출력에 남긴다. 이전의 `importsNotUsedAsValues`·`preserveValueImports`를 대체하며, ESM 파일에 CJS 문법이 섞이는 것도 오류로 잡는다. `isolatedModules`는 파일 단위 변환 도구(esbuild, swc)가 처리할 수 없는 문법을 금지한다.

빌드는 `outDir`·`rootDir`로 출력 위치를 정하고, 라이브러리라면 `declaration`으로 `.d.ts`를 만든다. 모노레포는 `composite`와 `references`를 켜고 `tsc --build`로 증분 빌드한다.

Spring/Java와 대응시키면 tsconfig는 Maven compiler plugin의 `release` 설정, `moduleResolution`은 클래스패스 탐색 규칙, ESM/CJS 공존은 JPMS 모듈과 classpath jar가 섞일 때의 호환성 문제에 해당한다.

| 대상 환경 | module | moduleResolution | 특징 |
|---|---|---|---|
| Node 직접 실행 | nodenext | nodenext | 확장자 필수, exports 지원 |
| 번들러 | esnext/preserve | bundler | 확장자 생략 가능 |
| 레거시 CJS | commonjs | node10 | exports 미지원, 비권장 |

## 코드

Node 22에서 ESM으로 실행하는 서비스용 tsconfig다. 형식은 `package.json`의 `"type": "module"`이 결정한다.

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`verbatimModuleSyntax` 아래에서 `Order` import는 출력에서 제거되고 `calcTotal`만 남는다.

```ts
// src/order/service.ts
import { calcTotal } from "./pricing.js";
import type { Order } from "./types.js";

export function summarize(order: Order): string {
  return `${order.id}: ${calcTotal(order.items)}`;
}
```

ESM과 CJS 소비자를 모두 지원하는 라이브러리는 `exports`에 조건별 진입점과 형식별 `.d.ts`를 둔다.

```json
{
  "name": "@acme/pricing",
  "type": "module",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  }
}
```

## 실무에서 걸리는 지점

- ==**확장자 없는 상대 import.** `bundler`에서 잘 되던 `import "./util"`은 `nodenext`로 옮기는 순간 오류가 된다.== 컴파일러는 출력 파일 기준으로 해석하므로 소스가 `.ts`여도 `./util.js`가 맞는 표기다.
- **CJS에서 ESM 전용 패키지 require.** CJS 프로젝트가 ESM 전용 패키지를 import하면 tsc는 통과해도 Node에서 `ERR_REQUIRE_ESM`이 난다. 프로젝트 전체를 ESM으로 옮기거나 동적 `import()`를 쓰는 편이 안전하다.
- **라이브러리 배포 시 `types` 조건.** `exports`에서 `types`는 `default`보다 앞에 와야 하며, ESM용 `.d.ts`를 CJS 소비자에게 주면 타입 오류가 난다. `.d.mts`/`.d.cts`를 형식별로 분리한다.
- **NestJS와 데코레이터 메타데이터.** NestJS 11은 CJS 출력과 `emitDecoratorMetadata`를 기본으로 하며 `experimentalDecorators`를 전제한다. ESM으로 전환할 때는 메타데이터 방출과 `__dirname` 부재를 함께 점검한다.
- **`tsc --build`의 캐시.** `.tsbuildinfo` 기준으로 증분 빌드하므로 tsconfig를 바꾼 뒤 오류가 남는다면 `tsc --build --clean` 후 다시 빌드한다.

## 관련 글

- [클래스·데코레이터·모듈](/notes/typescript/classes-decorators-modules/)
- [왜 TypeScript인가 — 타입 시스템과 컴파일 파이프라인](/notes/typescript/why-typescript/)
- [실무 패턴 — strict 모드·타입 가드·에러 처리](/notes/typescript/strict-mode-practical-patterns/)
