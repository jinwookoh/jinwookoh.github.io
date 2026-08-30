---
title: "유틸리티 타입·조건부 타입·매핑 타입"
series: typescript
part: "타입 시스템"
order: 5
summary: "기존 타입에서 새 타입을 파생하는 세 가지 도구의 동작 원리와 실무 함정을 정리한다."
tags: [TypeScript, Utility Types, Conditional Types, Mapped Types, infer]
sources: [https://www.typescriptlang.org/docs/handbook/utility-types.html, https://www.typescriptlang.org/docs/handbook/2/conditional-types.html, https://www.typescriptlang.org/docs/handbook/2/mapped-types.html]
updated: 2026-08-30
---

엔티티 하나를 두고 생성 요청, 수정 요청, 응답 DTO를 각각 손으로 선언하면 필드 하나가 바뀔 때마다 여러 곳을 고쳐야 하고, 한 곳이 빠지면 컴파일은 통과한 채 런타임에서 `undefined`가 흘러 다닌다. ==TypeScript는 기존 타입을 재료로 새 타입을 계산하는 수단으로 이 중복을 없앤다.== 표준 라이브러리의 유틸리티 타입, 타입 수준 분기인 조건부 타입, 키를 순회하며 속성을 변환하는 매핑 타입이며, 유틸리티 타입 대부분은 나머지 둘로 구현되어 있다.

## 핵심 개념

### 유틸리티 타입

`lib.d.ts`에 전역으로 선언된 제네릭 타입이며 import 없이 쓴다.

| 분류 | 타입 | 역할 |
|---|---|---|
| 속성 수식자 변경 | `Partial<T>`, `Required<T>`, `Readonly<T>` | 모든 속성을 선택·필수·읽기 전용으로 바꾼다 |
| 키 선택 | `Pick<T, K>`, `Omit<T, K>` | 일부 키만 남기거나 제거한다 |
| 유니온 연산 | `Exclude<T, U>`, `Extract<T, U>`, `NonNullable<T>` | 유니온 멤버를 걸러 낸다 |
| 객체 생성 | `Record<K, T>` | 키 집합과 값 타입으로 객체 타입을 만든다 |
| 함수·클래스 추출 | `ReturnType<T>`, `Parameters<T>`, `ConstructorParameters<T>`, `InstanceType<T>` | 시그니처에서 일부를 꺼낸다 |
| Promise | `Awaited<T>` | 중첩된 `Promise`를 재귀적으로 풀어 최종 값 타입을 얻는다 |
| 문자열 | `Uppercase`, `Lowercase`, `Capitalize`, `Uncapitalize` | 템플릿 리터럴 타입과 함께 키 이름을 변환한다 |

Java/Spring에는 직접 대응하는 개념이 없다. MapStruct·Lombok이 소스 생성으로 DTO 변형을 만드는 효과를 컴파일러가 타입 수준에서 즉시 계산한다고 보면 된다. NestJS의 `@nestjs/mapped-types`가 제공하는 `PartialType`, `PickType`, `OmitType`은 런타임 데코레이터 메타데이터까지 복사한다는 점에서 구분된다.

### 조건부 타입

`T extends U ? X : Y` 형태로, `T`가 `U`에 할당 가능하면 `X`, 아니면 `Y`로 평가된다. 타입 인자가 확정되는 시점에 지연 평가되며, 두 가지 성질이 중요하다.

첫째, 분배(distributive) 법칙이다. ==검사 대상이 벗은(naked) 타입 매개변수이고 유니온이 들어오면 각 멤버에 조건을 따로 적용한 뒤 결과를 다시 유니온으로 합친다.== 분배를 막으려면 `[T] extends [U]`처럼 튜플로 감싼다.

둘째, `infer` 키워드다. `extends` 절 안에서 타입의 일부를 새 타입 변수로 포착한다. `ReturnType<T>`는 `T extends (...args: any) => infer R ? R : any`로 정의되어 있고, `Awaited`는 `infer`를 재귀 적용해 `then` 콜백의 인자 타입을 뽑아낸다. `infer U extends string`처럼 포착 변수에 제약도 걸 수 있다.

### 매핑 타입

`{ [K in Keys]: Type }` 문법으로 키 유니온을 순회하며 속성을 만든다. `keyof T`와 인덱스 접근 `T[K]`를 조합하면 원본 구조를 복제하면서 값 타입만 바꿀 수 있다.

`+`/`-` 접두어로 `readonly`와 `?` 수식자를 추가·제거한다. `keyof T`를 순회하는 동형(homomorphic) 매핑은 원본 수식자를 보존하지만, `Record`처럼 임의 키 집합을 순회하면 보존하지 않는다.

`as` 절은 키 리매핑을 담당한다. 템플릿 리터럴 타입으로 키 이름을 바꾸거나, 결과를 `never`로 평가해 특정 키를 제거한다.

## 코드

엔티티 하나에서 생성·수정·응답 타입을 파생한다.

```ts
interface Order {
  id: string;
  userId: string;
  items: { sku: string; qty: number }[];
  status: "pending" | "paid" | "shipped" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

type AuditKeys = "id" | "createdAt" | "updatedAt";

type CreateOrderInput = Omit<Order, AuditKeys | "status">;
type UpdateOrderInput = Partial<Omit<Order, AuditKeys | "userId">>;
type OrderResponse = Readonly<Omit<Order, "userId">> & { ownerName: string };
type OrderStatusCount = Record<Order["status"], number>;

const counts: OrderStatusCount = { pending: 3, paid: 12, shipped: 7, cancelled: 1 };
```

조건부 타입과 `infer`로 Next.js Route Handler의 반환 타입에서 응답 본문 타입을 추출한다.

```ts
type JsonOf<T> = T extends { json(): Promise<infer B> } ? B : never;

type HandlerBody<H extends (...args: any[]) => any> =
  JsonOf<Awaited<ReturnType<H>>>;

declare function GET(
  req: Request,
): Promise<Response & { json(): Promise<{ orders: Order[]; total: number }> }>;

type OrdersPayload = HandlerBody<typeof GET>;
// { orders: Order[]; total: number }

// 분배 조건부 타입: 유니온 각 멤버에 따로 적용된다
type ToArray<T> = T extends unknown ? T[] : never;
type A = ToArray<string | number>;            // string[] | number[]
type NonDistributed<T> = [T] extends [unknown] ? T[] : never;
type B = NonDistributed<string | number>;     // (string | number)[]
```

키 리매핑으로 이벤트 타입에서 핸들러 맵을 만들고, `as` 절에서 `never`를 돌려 함수 속성을 걸러낸다.

```ts
type Events = {
  orderPaid: { orderId: string; amount: number };
  orderShipped: { orderId: string; carrier: string };
};

type Handlers = {
  [E in keyof Events as `on${Capitalize<E>}`]: (payload: Events[E]) => Promise<void>;
};
// { onOrderPaid: (p: {...}) => Promise<void>; onOrderShipped: ... }

type DataOnly<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: T[K];
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Frozen = Readonly<{ a: number; b?: string }>;
type Thawed = Mutable<Frozen>; // { a: number; b?: string } — 선택 수식자는 유지된다
```

## 실무에서 걸리는 지점

- ==`Omit<T, K>`의 `K`는 `keyof any`로 제약되어 `T`에 없는 키를 넘겨도 오류가 없다.== `K extends keyof T`로 제약한 `StrictOmit`을 두면 리팩터링 누락을 잡는다. 또 `Omit`은 유니온에 분배되지 않아 판별 유니온에 적용하면 공통 속성만 남은 객체로 뭉개진다.
- `Partial`은 `undefined` 할당을 막지 못한다. `exactOptionalPropertyTypes`를 켜지 않으면 `{ status: undefined }`가 PATCH 입력으로 통과해 컬럼이 null로 덮이므로, `undefined` 키를 걸러내는 처리가 함께 있어야 한다.
- 조건부 타입에 `any`가 들어오면 분기 양쪽의 유니온이 되고, `never`가 벗은 매개변수로 들어오면 분배 결과가 `never`가 된다. 예상과 다른 결과가 나오면 이 두 경우부터 의심한다.
- 재귀 매핑 타입(`DeepPartial` 등)은 `Date`, `Map`, 클래스 인스턴스까지 속성 단위로 풀어 버리므로 내장 객체를 먼저 걸러내는 분기가 앞에 있어야 한다. 인스턴스화 깊이 한도가 있어 넓은 스키마에서는 tsc와 에디터 응답이 느려진다.
- 복잡한 파생 타입은 오류 메시지에서 원본 이름이 사라지고 전개된 구조만 보인다. 공개 API 경계에서는 한 번 평탄화하거나 명시적 인터페이스로 다시 선언하는 편이 가독성에 유리하다.

## 관련 글

- [제네릭](/notes/typescript/generics/)
- [유니온·교차·리터럴 타입과 Narrowing](/notes/typescript/unions-narrowing/)
- [실무 패턴 — strict 모드·타입 가드·에러 처리](/notes/typescript/strict-mode-practical-patterns/)
