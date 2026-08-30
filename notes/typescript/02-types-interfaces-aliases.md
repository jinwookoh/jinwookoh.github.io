---
title: "기본 타입·인터페이스·타입 별칭"
series: typescript
part: "기초"
order: 2
summary: "원시 타입·객체 타입을 어떻게 선언하고, interface와 type alias를 언제 골라 쓰는지 정리한다"
tags: [TypeScript, interface, type alias, structural typing, readonly]
sources: [https://www.typescriptlang.org/docs/handbook/2/everyday-types.html, https://www.typescriptlang.org/docs/handbook/2/objects.html]
updated: 2026-08-30
---

JavaScript는 함수가 어떤 모양의 객체를 받는지 실행해 보기 전에는 알 수 없다. 필드 오타 하나가 `undefined`로 흘러가 깊숙한 곳에서 터지고, 필드 이름을 바꾸면 호출부를 grep으로 찾아다녀야 한다. ==TypeScript는 값의 형태를 타입으로 선언해 이 문제를 컴파일 시점으로 끌어올린다.== 그 출발점이 원시 타입, 객체 타입, 그리고 객체 타입에 이름을 붙이는 인터페이스와 타입 별칭이다.

## 핵심 개념

### 원시 타입과 배열·함수

기본 원시 타입은 `string`, `number`, `boolean`이며 JavaScript의 `typeof` 결과와 일치한다. 대문자 `String`, `Number`는 래퍼 객체를 뜻하므로 타입 표기에 쓰지 않는다. 이 밖에 `bigint`, `symbol`, `null`, `undefined`가 있고, 배열은 `number[]` 또는 `Array<number>`로 적는다. 함수는 매개변수와 반환값에 타입을 붙이는데, 반환 타입은 대부분 추론되므로 생략해도 된다.

`any`는 타입 검사를 끄는 탈출구다. `noImplicitAny`가 켜져 있으면 추론이 불가능한 위치에서 `any`가 되는 것을 오류로 잡는다. 타입을 모르는 값에는 `any` 대신 `unknown`을 쓰는 편이 안전하다.

### 객체 타입

객체 타입은 프로퍼티 이름과 타입을 나열해 정의한다. `?`를 붙이면 선택 프로퍼티가 되고, 읽을 때 타입은 `T | undefined`가 된다. `readonly`를 붙이면 할당이 막히지만 얕은 수준에서만 적용되어 내부 객체의 필드는 여전히 바뀔 수 있다. 키 이름을 미리 알 수 없을 때는 인덱스 시그니처 `[key: string]: T`를 쓴다.

TypeScript의 객체 타입은 구조적(structural)이다. 이름이 다르더라도 필요한 프로퍼티를 모두 갖추면 호환된다. Java의 명목적 타입 시스템에서 같은 필드를 가진 두 클래스가 서로 대입 불가능한 것과 정반대다. 다만 객체 리터럴을 직접 넘길 때는 초과 프로퍼티 검사(excess property check)가 동작해 선언에 없는 키를 오류로 잡는다. 변수에 먼저 담아 넘기면 이 검사는 건너뛴다.

### 인터페이스와 타입 별칭

객체 타입에 이름을 붙이는 방법은 두 가지다. `interface`는 객체의 형태를 선언하고, `extends`로 다른 인터페이스를 확장한다. `type`은 어떤 타입에든 별칭을 붙일 수 있어 유니온, 튜플, 원시 타입, 함수 타입에도 쓸 수 있다. 객체 형태를 확장할 때는 교차 타입 `&`를 사용한다.

| 항목 | interface | type |
|---|---|---|
| 확장 | `extends` | `&` 교차 타입 |
| 선언 병합 | 같은 이름 재선언 시 합쳐짐 | 재선언 불가(오류) |
| 표현 범위 | 객체·함수·클래스 형태 | 모든 타입(유니온·튜플·원시 포함) |
| 성능 | 확장 시 캐시되어 빠름 | 교차 타입은 매번 재계산 |

==공식 문서는 객체 형태에는 `interface`를 우선 쓰고 유니온이나 별칭이 필요할 때 `type`을 쓰라고 안내한다.== NestJS DTO나 Next.js Route Handler 응답처럼 확장 가능성이 있는 계약은 `interface`로, 상태 문자열 유니온이나 함수 시그니처는 `type`으로 잡는 관행이 일반적이다.

Spring 관점에서 `interface`는 Java의 interface보다 record의 필드 명세에 가깝다. 구현 키워드 없이 형태만 맞으면 통과하며, 런타임에는 남지 않으므로 Bean Validation 같은 실행 시 검증을 대신하지 않는다.

### 튜플·enum·리터럴

길이와 위치별 타입이 고정된 배열은 튜플 `[string, number]`로 선언한다. `enum`은 런타임 객체를 생성하는 유일한 타입 구문이며, 문자열 리터럴 유니온이 더 가볍고 tree-shaking에 유리해 실무에서는 후자를 더 많이 쓴다. `as const`를 붙이면 객체 리터럴의 값이 리터럴 타입으로 고정되고 `readonly`가 된다.

## 코드

기본 타입, 선택 프로퍼티, 읽기 전용, 인덱스 시그니처를 한 인터페이스에 담은 예다.

```ts
interface User {
  readonly id: number;
  name: string;
  email?: string;
  roles: string[];
  [meta: `x-${string}`]: string | undefined;
}

const u: User = { id: 1, name: "kim", roles: ["admin"], "x-tenant": "a" };
u.name = "lee";        // OK
// u.id = 2;           // 오류: readonly
const mail = u.email?.toLowerCase(); // string | undefined
```

`interface`의 선언 병합과 `type`의 유니온·교차를 대비한 예다.

```ts
interface Point { x: number }
interface Point { y: number }        // 병합되어 { x; y }
const p: Point = { x: 1, y: 2 };

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; w: number; h: number };

type Named = { name: string };
type NamedShape = Shape & Named;     // 교차로 확장

function area(s: NamedShape): number {
  return s.kind === "circle" ? Math.PI * s.radius ** 2 : s.w * s.h;
}
```

구조적 타이핑과 초과 프로퍼티 검사의 차이를 보여 주는 예다.

```ts
interface Config { host: string; port: number }

const raw = { host: "db", port: 5432, pool: 10 };
const c1: Config = raw;                       // OK: 구조가 포함됨
// const c2: Config = { host: "db", port: 5432, pool: 10 }; // 오류: 초과 프로퍼티

const STATUS = { ACTIVE: "active", INACTIVE: "inactive" } as const;
type Status = (typeof STATUS)[keyof typeof STATUS]; // "active" | "inactive"
```

## 실무에서 걸리는 지점

- ==**런타임 검증은 별개다.** 인터페이스는 컴파일 후 사라지므로 NestJS 요청 본문이 선언과 다르게 들어와도 오류가 나지 않는다.== `class-validator` DTO나 `zod` 스키마 같은 실행 시 검증 수단을 따로 둔다.
- **`readonly`는 얕다.** `readonly items: Item[]`은 `items` 재할당만 막고 `items.push()`는 허용한다. 배열까지 막으려면 `readonly Item[]` 또는 `ReadonlyArray<Item>`을 써야 한다.
- **선택 프로퍼티와 `undefined` 명시는 다르다.** `exactOptionalPropertyTypes`를 켜면 `email?: string`에 `undefined`를 직접 대입하는 것이 오류가 된다.
- **초과 프로퍼티 검사는 리터럴에만 동작한다.** 변수를 거쳐 넘기면 통과하므로 오타 방어를 이 검사에 기대면 안 된다.
- **교차 타입 남용은 검사 속도를 떨어뜨린다.** 대형 타입을 `&`로 겹겹이 합치면 오류 메시지가 길어지고 tsc 시간이 늘어난다. 확장 계층이 깊으면 `interface extends`로 바꾼다.
- **선언 병합은 양날이다.** 라이브러리 타입 보강에는 유용하지만, 같은 이름의 `interface`가 우연히 병합되면 추적이 어렵다.

## 관련 글

- [왜 TypeScript인가 — 타입 시스템과 컴파일 파이프라인](/notes/typescript/why-typescript/)
- [유니온·교차·리터럴 타입과 Narrowing](/notes/typescript/unions-narrowing/)
- [유틸리티 타입·조건부 타입·매핑 타입](/notes/typescript/utility-conditional-mapped-types/)
