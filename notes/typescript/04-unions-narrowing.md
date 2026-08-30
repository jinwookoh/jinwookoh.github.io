---
title: "유니온·교차·리터럴 타입과 Narrowing"
series: typescript
part: "타입 시스템"
order: 4
summary: "유니온으로 가능한 값의 집합을 선언하고, 제어 흐름 분석으로 각 분기에서 타입을 좁혀 캐스팅 없이 안전하게 다룬다."
tags: [TypeScript, union, narrowing, discriminated union, type guard]
sources: [https://www.typescriptlang.org/docs/handbook/2/narrowing.html, https://www.typescriptlang.org/docs/handbook/2/everyday-types.html]
updated: 2026-08-30
---

API 응답 하나가 성공 시에는 데이터를, 실패 시에는 에러 코드를 담는 경우는 흔하다. 이를 하나의 넓은 타입으로 선언하면 성공 분기에서도 에러 필드가 접근 가능하고, 실패 분기에서도 데이터 필드가 `undefined`일 뿐 컴파일은 통과한다. 결국 런타임 null 체크에 의존하게 되고, 새로운 응답 종류가 추가되어도 컴파일러가 누락된 분기를 알려주지 못한다. TypeScript는 이 문제를 유니온 타입과 narrowing으로 푼다. 값이 될 수 있는 형태를 집합으로 선언하고, 조건문을 통과할 때마다 그 집합을 줄여 나가는 방식이다.

## 핵심 개념

**유니온 타입** `A | B`는 A이거나 B인 값을 뜻한다. 유니온 값에 대해서는 모든 멤버에 공통으로 존재하는 멤버만 바로 접근할 수 있다. `string | number`에 `toUpperCase()`를 호출하면 `number`에는 그 메서드가 없으므로 컴파일 에러가 난다. 유니온은 값의 집합을 합치는 연산이므로 타입은 넓어지고, 안전하게 쓸 수 있는 연산은 오히려 교집합으로 줄어든다.

**교차 타입** `A & B`는 A의 요구 사항과 B의 요구 사항을 모두 만족하는 값이다. 객체 타입을 합칠 때 주로 쓰며, 결과는 두 타입의 속성을 모두 가진 타입이 된다. 서로 모순되는 원시 타입을 교차하면 `never`가 된다.

**리터럴 타입**은 `"GET"`, `42`, `true`처럼 특정 값 하나만 허용하는 타입이다. 단독으로는 쓸모가 적지만 유니온으로 묶으면 열거형처럼 동작한다. `let`으로 선언한 변수는 `string`으로 넓혀지고 `const`는 리터럴 타입이 유지되므로, 객체 속성을 리터럴로 고정하려면 `as const`를 붙인다.

**Narrowing**은 컴파일러가 제어 흐름을 따라가며 변수의 타입을 좁히는 과정이다. `typeof`, `instanceof`, `in`, 동등 비교, truthiness 검사가 모두 narrowing의 근거가 된다. 조건문 안에서 타입이 좁혀지면 그 블록에서는 좁혀진 타입의 멤버를 캐스팅 없이 사용할 수 있고, 함수가 `return`이나 `throw`로 끝나는 분기가 있으면 그 이후 코드에서도 좁혀진 타입이 유지된다.

**판별 유니온**은 각 멤버가 같은 이름의 리터럴 속성(보통 `kind`나 `type`)을 갖는 유니온이다. 이 속성으로 분기하면 컴파일러가 해당 멤버 하나로 타입을 확정한다. 모든 멤버를 처리한 뒤 남는 타입은 `never`가 되므로, `default` 분기에서 `never`에 대입하는 방식으로 누락 검사를 강제할 수 있다.

Spring/Java와 견주면 판별 유니온은 sealed interface와 record를 `switch` 패턴 매칭으로 분기하는 것에 가깝다. 다만 TypeScript는 런타임 클래스 없이 구조만으로 판별하며, `instanceof`가 아니라 속성 값을 읽어 구분한다. `typeof` narrowing은 Java의 패턴 매칭 `instanceof`와 대응된다.

## 코드

판별 유니온으로 응답 타입을 선언하고, `switch`에서 좁혀진 타입을 사용하며, `never` 대입으로 누락을 검사한다.

```ts
type ApiResponse<T> =
  | { status: "ok"; data: T }
  | { status: "error"; code: number; message: string }
  | { status: "pending" };

function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

function render<T>(res: ApiResponse<T>): string {
  switch (res.status) {
    case "ok":
      return `data=${JSON.stringify(res.data)}`;
    case "error":
      return `error ${res.code}: ${res.message}`;
    case "pending":
      return "loading";
    default:
      return assertNever(res);
  }
}
```

사용자 정의 타입 가드는 반환 타입에 `param is Type` 술어를 써서 선언한다. 외부 JSON처럼 타입을 알 수 없는 값을 `unknown`으로 받아 좁힐 때 유용하다.

```ts
interface User {
  id: number;
  name: string;
}

function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "number" &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string"
  );
}

const raw: unknown = JSON.parse('{"id":1,"name":"kim"}');
if (isUser(raw)) {
  console.log(raw.name.toUpperCase());
}
```

`as const`로 리터럴 유니온을 값에서 파생하면 배열과 타입을 한 곳에서 관리할 수 있다.

```ts
const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number]; // "GET" | "POST" | "PUT" | "DELETE"

function isMethod(v: string): v is Method {
  return (METHODS as readonly string[]).includes(v);
}
```

## 실무에서 걸리는 지점

- `typeof null`은 `"object"`다. `typeof x === "object"`만으로 좁히면 `null`이 남아 있으므로 `x !== null` 검사를 함께 넣어야 한다. 반대로 truthiness 검사는 `0`과 `""`까지 걸러 버리므로 숫자·문자열 유니온에서는 의도치 않은 분기 누락이 생긴다.
- narrowing은 지역 변수와 `const`, 그리고 참조 경로가 바뀌지 않는 속성 접근에만 적용된다. 콜백 안에서는 좁혀진 타입이 초기화되고, 검사 뒤에 함수를 호출하면 그 사이에 값이 바뀌었을 수 있다고 보아 `let` 변수는 다시 넓어진다. 검사 결과를 `const`에 담아 넘기는 편이 안전하다.
- ==사용자 정의 타입 가드는 컴파일러가 본문을 검증하지 않는다.== `return true`만 적어도 타입은 통과하므로, 외부 입력 검증에는 스키마 검증 라이브러리에서 타입 술어를 파생시키는 편이 오류가 적다.
- ==판별 유니온의 판별 속성이 옵셔널이거나 `string`으로 넓혀져 있으면 narrowing이 동작하지 않는다.== 객체 리터럴을 변수에 담을 때 속성 타입이 넓혀지는 경우가 특히 흔하며, `as const`나 명시적 타입 주석으로 리터럴을 유지해야 한다.
- ==유니온 멤버 수가 늘어나면 `switch` 누락은 `never` 대입으로 잡히지만, `if` 체인은 기본적으로 검사되지 않는다.== 함수 반환 타입을 명시하고 `noImplicitReturns`를 켜면 처리되지 않은 분기가 반환 누락으로 드러난다.

## 관련 글

- [기본 타입·인터페이스·타입 별칭](/notes/typescript/types-interfaces-aliases/)
- [유틸리티 타입·조건부 타입·매핑 타입](/notes/typescript/utility-conditional-mapped-types/)
- [실무 패턴 — strict 모드·타입 가드·에러 처리](/notes/typescript/strict-mode-practical-patterns/)
