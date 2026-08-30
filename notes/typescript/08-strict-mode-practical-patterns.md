---
title: "실무 패턴 — strict 모드·타입 가드·에러 처리"
series: typescript
part: "빌드와 실무"
order: 8
summary: "strict 옵션을 켜고, 타입 가드로 좁히고, unknown 기반으로 에러를 다루는 실무 규칙을 정리한다"
tags: [TypeScript, strict, type guard, narrowing, error handling]
sources: [https://www.typescriptlang.org/tsconfig/#strict, https://www.typescriptlang.org/docs/handbook/2/narrowing.html, https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html]
updated: 2026-08-30
---

`strict`를 끄고 시작한 프로젝트는 타입 검사가 통과해도 런타임에서 `Cannot read properties of undefined`가 터진다. `null`이 모든 타입에 암묵적으로 포함되고, 타입을 적지 않은 매개변수는 `any`가 되어 검사를 빠져나가며, `catch`에서 받은 값의 `err.message`가 그대로 컴파일된다. 컴파일러가 잡을 수 있는 오류를 런타임으로 미루는 구조다. strict 모드와 그 위에서 동작하는 좁히기(narrowing)·에러 처리 패턴이 기본값이어야 하는 이유다.

## 핵심 개념

### strict 옵션군

`strict: true`는 여러 검사를 한 번에 켜는 묶음이다. 개별 옵션을 뒤에 명시하면 그 항목만 끌 수 있다.

| 옵션 | 켜지면 달라지는 것 |
|---|---|
| `strictNullChecks` | `null`·`undefined`가 별도 타입이 되어, 값이 있음을 확인하기 전에는 프로퍼티 접근이 오류 |
| `noImplicitAny` | 타입 추론이 불가능한 곳에 `any`를 암묵적으로 넣지 않고 오류로 보고 |
| `strictFunctionTypes` | 함수 매개변수를 반공변으로 검사해 잘못된 콜백 대입을 차단 |
| `strictPropertyInitialization` | 클래스 필드가 생성자에서 초기화되지 않으면 오류 |
| `useUnknownInCatchVariables` | `catch (e)`의 `e`가 `any`가 아니라 `unknown` |

새 프로젝트는 `strict: true`로 시작하고, 기존 프로젝트는 옵션을 하나씩 켜면서 오류를 줄여 나간다.

### 좁히기와 타입 가드

TypeScript는 코드 흐름을 따라가며 변수의 타입을 구체화한다. `typeof`, `instanceof`, `in`, 진릿값 검사, 판별 속성(discriminant)이 좁히기의 재료다. 유니온 멤버가 공통 리터럴 필드(`kind` 등)를 가지면 `switch`만으로 분기별 타입이 확정되고, `never` 대입으로 분기 누락을 컴파일 시점에 잡는다.

내장 연산자로 표현하기 어려운 조건은 반환 타입이 `x is T`인 사용자 정의 타입 가드로 만든다. ==5.5부터는 단순 술어 함수라면 명시하지 않아도 타입 가드로 추론된다.== `asserts x is T`로 쓰면 정상 반환 이후 타입이 좁혀지는 단언 함수가 된다.

Java 기준으로 판별 유니온 + `switch`는 sealed 클래스 패턴 매칭에 해당하고, `strictNullChecks`는 `Optional`을 언어 차원에서 강제하는 것과 같다.

### unknown 기반 에러 처리

JavaScript는 `throw`에 아무 값이나 던질 수 있으므로 strict 모드에서 `catch` 변수는 `unknown`이 되고, `instanceof Error`나 별도 가드를 통과해야 `message`에 접근할 수 있다. 예상 가능한 실패는 판별 유니온 결과 타입으로 반환해 호출자가 반드시 분기하게 하고, 예상 밖 실패만 `throw`로 올린다.

### 선언 파일 작성 규칙

`.d.ts`를 직접 쓸 때의 원칙이다. `Number`·`String` 같은 래퍼 대신 원시 타입을 쓰고, 반환 타입에 `any` 대신 `unknown`을 쓴다. 콜백 반환 타입은 `void`로 두고 콜백 매개변수를 옵셔널로 만들지 않는다. 오버로드는 구체적인 시그니처를 앞에 두고, 매개변수 타입이나 옵셔널 여부만 다른 오버로드는 하나로 합친다.

## 코드

판별 유니온으로 결과를 표현하고 `never` 대입으로 분기 누락을 잡는 예제다.

```ts
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "empty" | "invalid" };

function parsePort(input: string): ParseResult<number> {
  if (input.trim() === "") return { ok: false, reason: "empty" };
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, value: n };
}

function describe(r: ParseResult<number>): string {
  if (r.ok) return `port ${r.value}`;
  switch (r.reason) {
    case "empty":
      return "input is empty";
    case "invalid":
      return "not a valid port";
    default: {
      const exhaustive: never = r.reason;
      return exhaustive;
    }
  }
}
```

외부 입력을 `unknown`으로 받고 사용자 정의 타입 가드와 단언 함수로 좁히는 예제다. 5.5 이후에는 `isRecord`처럼 반환 타입을 적지 않아도 술어로 추론된다.

```ts
interface CreateUserDto {
  email: string;
  age?: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function assertCreateUserDto(x: unknown): asserts x is CreateUserDto {
  if (!isRecord(x)) throw new TypeError("body must be an object");
  if (typeof x.email !== "string") throw new TypeError("email is required");
  if ("age" in x && x.age !== undefined && typeof x.age !== "number") {
    throw new TypeError("age must be a number");
  }
}

// Next.js 15 App Router Route Handler
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json();
  assertCreateUserDto(body);
  // 이 지점부터 body는 CreateUserDto
  return Response.json({ email: body.email, age: body.age ?? null }, { status: 201 });
}
```

`catch`의 `unknown`을 안전하게 다루는 공용 헬퍼다. `Error`가 아닌 값이 던져져도 메시지를 뽑아낸다.

```ts
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (isRecord(e) && typeof e.message === "string") {
    return new Error(e.message, { cause: e });
  }
  return new Error(String(e), { cause: e });
}

async function loadConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    const err = toError(e);
    throw new Error(`failed to load config at ${path}: ${err.message}`, { cause: err });
  }
}
```

## 실무에서 걸리는 지점

- **non-null 단언(`!`)의 남용.** `strictNullChecks` 오류를 `x!.foo`로 눌러 버리면 검사를 끈 것과 같다. 실제로 값이 보장되는 곳(초기화 직후, 방금 검사한 맵 조회)에만 제한하고, 그 외에는 조기 반환이나 옵셔널 체이닝으로 흐름을 바꾼다.
- **콜백 안에서 좁히기가 풀린다.** ==`if (user) { list.forEach(() => user.name) }`에서 `user`가 `let`이면 콜백 안에서는 다시 `undefined`가 포함된다.== 콜백 실행 시점에 값이 바뀔 수 있기 때문이다. 좁힌 값을 `const`에 담아 넘기면 해결된다.
- **가드의 조건과 반환 타입이 어긋난다.** `typeof x === "object"`는 `null`도 통과시킨다. 가드가 틀리면 컴파일러가 잘못된 타입을 믿게 되므로 가드 자체에 단위 테스트를 둔다.
- **`strictPropertyInitialization`과 DI.** NestJS 11의 프로퍼티 주입이나 ORM 엔티티 필드는 생성자에서 초기화하지 않아 오류가 난다. 생성자 주입으로 바꾸는 것이 우선이고, 프레임워크가 반드시 채우는 필드에만 `!` 확정 할당 단언을 쓴다.
- **점진 도입 시 오류 폭증.** `strictNullChecks`를 켜면 대형 코드베이스는 수천 건의 오류가 나온다. `// @ts-expect-error`로 기록한 뒤 줄여 나가고, 오류가 사라져도 남는 `@ts-ignore`는 쓰지 않는다.

## 관련 글

- [유니온·교차·리터럴 타입과 Narrowing](/notes/typescript/unions-narrowing/)
- [tsconfig·빌드·ESM과 CJS](/notes/typescript/tsconfig-build-esm-cjs/)
- [클래스·데코레이터·모듈](/notes/typescript/classes-decorators-modules/)
