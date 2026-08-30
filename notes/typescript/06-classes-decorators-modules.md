---
title: "클래스·데코레이터·모듈"
series: typescript
part: "타입 시스템"
order: 6
summary: "TypeScript 클래스의 타입 규칙, 표준 데코레이터와 legacy 데코레이터의 차이, ESM 기반 모듈 타입 모델을 정리한다"
tags: [TypeScript, class, decorator, ESM, NestJS]
sources: [https://www.typescriptlang.org/docs/handbook/2/classes.html, https://www.typescriptlang.org/docs/handbook/decorators.html, https://www.typescriptlang.org/docs/handbook/2/modules.html]
updated: 2026-08-30
---

JavaScript 클래스는 필드 선언 없이 아무 프로퍼티나 붙일 수 있고 메서드 시그니처를 강제할 방법이 없다. 데코레이터 기반 프레임워크(NestJS, TypeORM)는 런타임 규약에만 의존하고, 모듈은 CommonJS인지 ESM인지에 따라 같은 `import` 문이 다르게 해석된다. ==TypeScript는 이 세 영역에 정적 규칙을 얹어 컴파일 시점에 오류를 잡는다.==

## 핵심 개념

### 클래스

`strictPropertyInitialization`이 켜져 있으면 생성자에서 초기화되지 않은 필드는 오류이며, 나중에 채우는 경우 `!` 확정 할당 단언을 쓴다. `readonly`는 생성자 밖의 대입을 막고, 생성자 매개변수에 `private`·`readonly`를 붙이면 선언과 초기화를 한 줄로 줄이는 매개변수 프로퍼티가 된다.

접근 제어자는 타입 검사에만 존재하고 컴파일 결과에 남지 않는다. 런타임까지 감춰야 하면 `#private` 필드를 쓴다. `implements`는 형태 검사만 할 뿐 멤버 타입을 주입하지 않으므로 구현 클래스에서 매개변수 타입을 다시 적는다. `abstract` 클래스는 Spring에서 템플릿 메서드 패턴으로 쓰는 추상 클래스와 역할이 같다.

클래스도 구조적 타이핑을 따르므로 멤버 구성이 같으면 호환되며, 명목적 구분이 필요하면 `private` 멤버를 하나 두어 호환을 끊는다.

### 데코레이터

TypeScript 5.0부터 ECMAScript 표준(stage 3) 데코레이터를 기본 지원한다. 표준 데코레이터는 `(value, context)`를 받으며 `context.kind`가 `class`·`method`·`field`·`accessor` 등 대상을 알려주고, `context.addInitializer`로 초기화 훅을 등록한다. 반환값이 있으면 원래 멤버를 대체한다.

`experimentalDecorators`를 켜면 이전 방식(legacy)으로 동작한다. legacy는 `(target, propertyKey, descriptor)` 시그니처를 쓰고, 매개변수 데코레이터와 `emitDecoratorMetadata`를 통한 타입 정보 방출(`design:paramtypes`)을 지원한다. 표준 데코레이터에는 둘 다 없다. ==NestJS 11은 `@Body()` 같은 매개변수 데코레이터와 생성자 타입 기반 DI를 위해 legacy 모드를 요구하며, 두 모드는 공존하지 못한다.==

Spring과 대응시키면 클래스 데코레이터는 `@Component` 같은 스테레오타입 애노테이션, 메서드 데코레이터는 `@Transactional` 같은 AOP 애노테이션에 해당한다. 다만 Java 애노테이션은 순수 메타데이터인 반면 TypeScript 데코레이터는 클래스 정의 시점에 실행되는 함수다.

### 모듈

`import`나 `export`가 하나라도 있는 파일은 모듈이고, 없으면 전역 스코프를 공유하는 스크립트다. 타입 전용 참조는 `import type`으로 표시하며, `verbatimModuleSyntax`를 켜면 타입만 가져오는 `import`가 런타임 코드에 남지 않도록 컴파일러가 강제한다.

소스는 ESM 문법으로 쓰고, `module`·`moduleResolution` 옵션이 출력 형식과 `package.json` `exports` 해석을 결정한다. `node16` 해석에서는 상대 경로 import에 `.js` 확장자를 붙여야 한다. NestJS Module은 이 언어 수준 모듈과 별개의 DI 컨테이너 단위로, Spring의 `@Configuration` 클래스에 가깝다.

## 코드

매개변수 프로퍼티, `readonly`, 추상 클래스, `implements`를 함께 쓰는 리포지토리 예제다.

```ts
interface Identifiable {
  readonly id: string;
}

abstract class Repository<T extends Identifiable> {
  private readonly store = new Map<string, T>();

  constructor(protected readonly name: string) {}

  save(entity: T): T {
    this.validate(entity);
    this.store.set(entity.id, entity);
    return entity;
  }

  findById(id: string): T | undefined {
    return this.store.get(id);
  }

  abstract validate(entity: T): void;
}

class User implements Identifiable {
  constructor(
    readonly id: string,
    public email: string,
  ) {}
}

class UserRepository extends Repository<User> {
  constructor() {
    super("users");
  }

  validate(user: User): void {
    if (!user.email.includes("@")) {
      throw new Error(`invalid email in ${this.name}: ${user.email}`);
    }
  }
}
```

TypeScript 5.x 표준 데코레이터로 메서드 실행 시간을 기록한다. `context.kind`로 대상을 검증하고 반환값으로 원래 메서드를 대체한다.

```ts
function measured<This, Args extends unknown[], Ret>(
  target: (this: This, ...args: Args) => Ret,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Ret>,
) {
  if (context.kind !== "method") {
    throw new Error("measured는 메서드에만 적용한다");
  }
  const name = String(context.name);

  return function (this: This, ...args: Args): Ret {
    const start = performance.now();
    try {
      return target.call(this, ...args);
    } finally {
      console.log(`${name}: ${(performance.now() - start).toFixed(2)}ms`);
    }
  };
}

class ReportService {
  @measured
  build(rows: number): string {
    return Array.from({ length: rows }, (_, i) => `row-${i}`).join("\n");
  }
}

new ReportService().build(10_000);
```

`verbatimModuleSyntax` 환경에서 타입과 값을 구분해 가져오는 예제다.

```ts
// user.ts
export interface UserDto {
  id: string;
  email: string;
}

export function toDto(user: { id: string; email: string }): UserDto {
  return { id: user.id, email: user.email };
}

// app/api/users/route.ts (Next.js 15 Route Handler)
import { NextResponse } from "next/server";
import { toDto, type UserDto } from "./user.js";

export async function GET(): Promise<NextResponse<UserDto[]>> {
  const users = [{ id: "u1", email: "a@example.com" }];
  return NextResponse.json(users.map(toDto));
}
```

## 실무에서 걸리는 지점

- ==**데코레이터 모드 불일치.** NestJS 프로젝트에서 `experimentalDecorators`를 빼면 `@Injectable()`이 타입 오류를 내고 DI가 동작하지 않는다.== 프레임워크가 요구하는 모드로 프로젝트 전체를 통일한다.
- **`emitDecoratorMetadata`와 타입 전용 import.** DI 컨테이너는 `design:paramtypes`로 생성자 매개변수의 클래스를 읽는다. 의존성을 `import type`으로 가져오거나 인터페이스로 선언하면 메타데이터가 `Object`가 되어 주입이 실패하므로 `@Inject(TOKEN)`으로 토큰을 명시한다.
- **`useDefineForClassFields`와 필드 초기화 순서.** `target`이 ES2022 이상이면 기본값이 `true`가 되어 필드가 `[[Define]]` 시맨틱으로 초기화된다. 부모 생성자에서 세팅한 값을 자식의 필드 선언이 `undefined`로 덮어쓰며, `declare` 필드 선언으로 회피한다.
- **`this` 바인딩 손실.** 메서드를 콜백으로 그대로 넘기면 `this`가 `undefined`가 된다. 화살표 함수 필드는 인스턴스마다 함수를 생성하므로 빈번히 생성되는 클래스에서는 명시적 바인딩을 택한다.
- **배럴 파일과 순환 의존.** `index.ts`로 재수출을 모으면 순환 의존이 생기기 쉽고, 데코레이터 평가 순서가 꼬여 `undefined` 클래스가 DI에 등록되는 원인이 된다.

## 관련 글

- [유틸리티 타입·조건부 타입·매핑 타입](/notes/typescript/utility-conditional-mapped-types/)
- [tsconfig·빌드·ESM과 CJS](/notes/typescript/tsconfig-build-esm-cjs/)
- [실무 패턴 — strict 모드·타입 가드·에러 처리](/notes/typescript/strict-mode-practical-patterns/)
