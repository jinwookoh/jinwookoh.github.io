---
title: "왜 TypeScript인가 — 타입 시스템과 컴파일 파이프라인"
series: typescript
part: "기초"
order: 1
summary: "TypeScript는 JavaScript에 정적 타입 검사를 얹어 실행 전에 오류를 잡고, 컴파일 시 타입을 지워 순수 JS를 내보낸다."
tags: [TypeScript, JavaScript, 타입 시스템, tsc, 구조적 타이핑]
sources: [https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html, https://www.typescriptlang.org/docs/handbook/2/basic-types.html]
updated: 2026-08-30
---

JavaScript는 값의 타입을 실행 시점에만 확인한다. 함수에 잘못된 인자를 넘기거나 존재하지 않는 프로퍼티를 읽어도 코드가 실제로 그 줄에 도달하기 전까지는 아무 경고가 없다. 프로퍼티 오타는 `undefined`가 되어 조용히 다음 연산으로 흘러가고, 함수 호출에 괄호를 빼먹으면 함수 객체 자체가 반환값으로 쓰인다. 코드베이스가 수만 줄로 커지고 여러 팀이 같은 객체 구조를 주고받기 시작하면 이런 오류는 테스트나 운영 로그에서야 드러난다. Next.js 15 App Router나 NestJS 11처럼 서버와 클라이언트, 컨트롤러와 서비스 사이에서 같은 데이터 형태를 반복해서 넘기는 구조에서는 문제가 더 커진다. ==TypeScript는 이 간극을 실행 전에 메우기 위해 만들어졌다.==

## 핵심 개념

TypeScript는 JavaScript의 상위 집합이다. 유효한 JavaScript 파일은 확장자만 `.ts`로 바꿔도 그대로 TypeScript 코드가 되며, 여기에 타입 주석과 타입 전용 구문이 더해진다. 핵심 역할은 두 가지로 나뉜다. 정적 타입 검사기와 컴파일러다.

정적 타입 검사는 코드를 실행하지 않고 값의 형태를 추론해 오류를 찾는다. `const msg = "hello"`라고 쓰면 검사기는 `msg`를 `string`으로 추론하고, 이후 `msg()`처럼 호출하려는 시도를 즉시 오류로 보고한다. 명시적 주석이 없어도 초기화 값과 문맥에서 타입을 유추하는 것이 기본 동작이며, 함수 매개변수처럼 추론할 근거가 없는 곳에만 주석을 붙이는 것이 권장 방식이다.

타입 비교 방식은 구조적 타이핑이다. ==두 타입이 호환되는지는 이름이 아니라 가진 프로퍼티의 형태로 결정된다.== `{ x: number; y: number }` 형태를 요구하는 함수에는 이름이 다른 클래스의 인스턴스든 객체 리터럴이든 같은 프로퍼티를 갖추기만 하면 넘길 수 있다. Java의 명목적 타이핑, 즉 `implements`를 선언해야 인터페이스 구현으로 인정되는 방식과 가장 크게 갈리는 지점이다. Spring에서 DTO 클래스를 별도로 정의해 형식을 맞추던 작업이 TypeScript에서는 형태만 일치하면 통과한다.

기본 타입은 JavaScript 원시값에 대응하는 `string`, `number`, `boolean`과 배열(`number[]`), 그리고 검사를 끄는 탈출구인 `any`가 있다. `any`는 어떤 연산도 허용하므로 편하지만 타입 시스템의 보호를 포기하는 선택이다. `noImplicitAny` 옵션을 켜면 추론에 실패해 `any`로 떨어지는 경우를 오류로 승격시킨다. `null`과 `undefined`는 `strictNullChecks`가 켜져야 별개의 타입으로 취급되어, 값이 없을 수 있는 변수를 검사 없이 쓰는 코드를 막는다. 두 옵션 모두 `strict` 플래그에 포함된다.

컴파일러 `tsc`는 `.ts`를 읽어 타입 검사를 수행한 뒤 타입 구문을 모두 지운 `.js`를 내보낸다. 이를 타입 소거라고 한다. 타입은 런타임에 존재하지 않으므로 실행 성능에 영향을 주지 않고, 출력 코드에는 검사 로직이 전혀 남지 않는다. 타입 오류가 있어도 기본적으로는 JavaScript를 내보내며, `noEmitOnError`를 켜야 오류 시 출력이 중단된다. `target` 옵션으로 출력 문법 수준을 정할 수 있어 최신 문법을 오래된 런타임용으로 내릴 수도 있지만, Node 22 기준으로는 `ES2022` 이상을 그대로 쓰는 것이 일반적이다.

실무 파이프라인에서는 검사와 변환을 분리하는 경우가 많다. Next.js는 SWC로, NestJS는 기본 설정에서 `tsc`로 변환하되 빌드 단계 또는 CI에서 `tsc --noEmit`으로 검사만 따로 돌린다. Java에서 `javac`가 검사와 바이트코드 생성을 한 번에 하는 것과 달리, TypeScript는 검사기와 변환기를 별도 도구로 조합할 수 있다.

## 코드

타입 주석 없이도 추론이 동작하며, 잘못된 사용을 컴파일 시점에 잡는다.

```ts
const message = "hello, world";
// message는 string으로 추론된다

message.toUpperCase(); // 정상
message();             // 오류: This expression is not callable.
```

구조적 타이핑에 따라 이름이 다른 객체라도 형태가 맞으면 호환된다.

```ts
interface Point {
  x: number;
  y: number;
}

class Vector {
  constructor(public x: number, public y: number, public z: number) {}
}

function distanceFromOrigin(p: Point): number {
  return Math.hypot(p.x, p.y);
}

distanceFromOrigin({ x: 3, y: 4 });      // 5
distanceFromOrigin(new Vector(3, 4, 5)); // 초과 프로퍼티는 무시된다
```

`strictNullChecks` 아래에서는 값이 없을 가능성을 검사기가 강제한다.

```ts
function findUser(id: string): { name: string } | undefined {
  return id === "1" ? { name: "jinwoo" } : undefined;
}

const user = findUser("2");
console.log(user.name);  // 오류: 'user' is possibly 'undefined'.
console.log(user?.name); // 정상: undefined 출력
```

## 실무에서 걸리는 지점

- ==**타입은 런타임 보증이 아니다.** 타입 소거 때문에 HTTP 요청 본문이나 외부 API 응답의 형태는 검사기가 확인할 수 없다.== NestJS의 `ValidationPipe`와 class-validator, 또는 zod 같은 스키마 검증기로 경계에서 별도로 검증해야 한다. Spring에서 `@Valid`를 붙이는 것과 같은 자리다.
- **`any`가 전파된다.** 한 곳에서 `any`를 쓰면 그 값을 거친 모든 연산 결과가 `any`가 되어 검사 범위가 조용히 줄어든다. 형태를 모르는 값에는 `unknown`을 쓰고 좁혀서 사용해야 한다.
- **`strict`를 나중에 켜면 비용이 크다.** 기존 JavaScript 프로젝트를 옮길 때 `strict: false`로 시작하면 이후 켜는 순간 수백 건의 오류가 한꺼번에 나온다. 새 프로젝트는 처음부터 `strict: true`가 기본이며, Next.js와 NestJS 스캐폴딩도 이 설정을 생성한다.
- **검사 시간이 빌드 시간을 지배한다.** 변환은 SWC나 esbuild로 수 초 안에 끝나지만 `tsc --noEmit`은 프로젝트 규모에 비례해 늘어난다. `incremental` 옵션과 프로젝트 참조로 캐시를 활용하고, CI에서 검사를 별도 잡으로 분리하는 편이 낫다.
- **타입 정의가 없는 라이브러리.** `@types/*` 패키지나 자체 `.d.ts`가 없는 의존성은 암묵적으로 `any`가 된다. 도입 전에 타입 정의 제공 여부를 확인하고, 없으면 최소한의 선언 파일을 직접 작성해야 한다.

## 관련 글

- [기본 타입·인터페이스·타입 별칭](/notes/typescript/types-interfaces-aliases/)
- [tsconfig·빌드·ESM과 CJS](/notes/typescript/tsconfig-build-esm-cjs/)
- [실무 패턴 — strict 모드·타입 가드·에러 처리](/notes/typescript/strict-mode-practical-patterns/)
