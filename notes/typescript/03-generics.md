---
title: "제네릭"
series: typescript
part: "타입 시스템"
order: 3
summary: "제네릭은 타입을 매개변수로 받아 입력과 출력의 관계를 보존하는 장치이며 제약·추론·기본값이 핵심이다"
tags: [TypeScript, Generics, Type Parameter, Constraint, Type Inference]
sources: [https://www.typescriptlang.org/docs/handbook/2/generics.html]
updated: 2026-08-30
---

값을 받아 그대로 돌려주는 함수를 `any`로 작성하면 인자가 무엇이었든 반환 타입은 `any`가 된다. 호출부는 입력이 `number`였다는 정보를 잃고, 이후 모든 연산이 타입 검사 밖으로 빠져나간다. 반대로 `number`, `string`마다 별도 함수를 만들면 같은 로직이 타입 수만큼 복제된다. 제네릭은 이 두 선택지 사이의 공백을 메운다. ==타입 자체를 매개변수로 받아 함수·클래스·인터페이스를 한 번만 정의하고, 호출 시점에 결정된 타입을 입력에서 출력까지 끊김 없이 전달한다.==

## 핵심 개념

제네릭의 본질은 타입 변수다. `function identity<Type>(arg: Type): Type`에서 `Type`은 값이 아니라 타입을 담는 자리이며, 호출 때 확정된다. 명시적으로 `identity<string>("x")`처럼 넘길 수도 있지만 대부분은 인자로부터 컴파일러가 추론한다. 추론은 인자 위치에서만 일어나며, 반환 타입만으로는 타입 인자를 결정하지 못한다.

타입 변수는 그 자체로는 어떤 구조도 보장하지 않는다. `arg.length`에 접근하려 하면 `Type`에 `length`가 있다는 근거가 없으므로 오류가 난다. 이때 `extends` 절로 제약(constraint)을 건다. `<Type extends { length: number }>`로 선언하면 `length`를 가진 타입만 들어올 수 있고, 함수 본문에서 해당 속성을 안전하게 사용한다. ==제약은 상한을 정하는 것이지 타입을 그 상한으로 바꾸는 것이 아니다.== `string`을 넘기면 `Type`은 여전히 `string`이다.

타입 변수끼리 제약을 걸 수도 있다. `<Type, Key extends keyof Type>`은 두 번째 타입 인자가 첫 번째 객체 타입의 키여야 한다는 관계를 표현한다. 이 형태가 `getProperty(obj, "name")` 같은 API에서 오타를 컴파일 단계에서 걸러내는 기반이 된다.

제네릭은 함수 외에도 인터페이스와 클래스에 적용된다. 클래스의 타입 매개변수는 인스턴스 멤버에만 유효하고 static 멤버에서는 참조할 수 없다. 인터페이스는 호출 시그니처 전체를 제네릭으로 만들거나, 인터페이스 자체를 매개변수화해 `GenericIdentityFn<number>`처럼 특정 타입으로 고정한 뒤 사용하는 두 가지 방식이 있다.

타입 매개변수에는 기본값을 줄 수 있다. `<T = HTMLElement>`처럼 선언하면 인자 없이 호출해도 추론이 실패하는 대신 기본 타입이 적용된다. 기본값이 있는 매개변수는 필수 매개변수 뒤에 와야 하며, 제약이 있다면 기본값은 그 제약을 만족해야 한다.

클래스 타입 자체를 값으로 다룰 때는 생성자 시그니처 `new () => Type`을 타입으로 쓴다. 팩토리 함수에 `c: new () => Type`을 넘기면 반환 타입이 실제 생성되는 클래스로 추론된다. 여기에 제약을 결합하면 `Animal`의 하위 클래스만 받는 팩토리를 만들 수 있다.

Java/Spring과 비교하면, TypeScript 제네릭은 Java 제네릭과 문법이 비슷하지만 두 가지가 다르다. 첫째, Java와 마찬가지로 런타임에 타입이 지워지지만, TypeScript는 구조적 타입 시스템이므로 `extends` 제약이 클래스 상속이 아니라 형태 일치로 판정된다. 둘째, `keyof`나 리터럴 타입과 결합해 Java에서는 불가능한 키 이름 수준의 제약이 가능하다. Spring Data의 `Repository<T, ID>` 인터페이스가 하는 역할을 TypeScript에서는 `Repository<Entity, Key extends keyof Entity>`처럼 더 세밀하게 표현한다.

| 구분 | 타입 인자 명시 | 추론 |
|---|---|---|
| 방식 | `fn<string>(x)` | `fn(x)` |
| 사용 시점 | 추론이 모호하거나 반환 타입만으로 결정해야 할 때 | 인자에서 타입이 드러나는 대부분의 경우 |
| 위험 | 인자와 불일치 시 즉시 오류 | 리터럴이 넓은 타입으로 확장될 수 있음 |

## 코드

객체와 키를 받아 해당 속성 값을 반환하며, 존재하지 않는 키는 컴파일 단계에서 거부한다.

```ts
function getProperty<Type, Key extends keyof Type>(obj: Type, key: Key): Type[Key] {
  return obj[key];
}

const user = { id: 1, name: "kim", active: true };

const name = getProperty(user, "name");   // string
const active = getProperty(user, "active"); // boolean
// getProperty(user, "email");            // 오류: "email"은 keyof typeof user가 아니다
```

제약과 기본값을 가진 제네릭 클래스로, 같은 로직을 엔티티 타입마다 다시 쓰지 않는다.

```ts
interface Entity {
  id: number;
}

class InMemoryRepository<T extends Entity, K extends keyof T = "id"> {
  private readonly items = new Map<T[K], T>();

  constructor(private readonly key: K) {}

  save(item: T): T {
    this.items.set(item[this.key], item);
    return item;
  }

  findBy(value: T[K]): T | undefined {
    return this.items.get(value);
  }
}

interface Order extends Entity {
  code: string;
  amount: number;
}

const orders = new InMemoryRepository<Order>("id");
orders.save({ id: 10, code: "A-1", amount: 3000 });
const found = orders.findBy(10); // Order | undefined
```

생성자 시그니처를 제약으로 사용해 특정 계층의 하위 클래스만 생성하는 팩토리다.

```ts
class Animal {
  legs = 4;
}
class Dog extends Animal {
  bark() {
    return "woof";
  }
}

function create<T extends Animal>(ctor: new () => T): T {
  return new ctor();
}

const dog = create(Dog); // Dog
dog.bark();
// create(Date);          // 오류: Date에는 legs가 없다
```

## 실무에서 걸리는 지점

- 리터럴 인자가 넓은 타입으로 추론된다. `wrap("GET")`을 호출하면 `T`는 `"GET"`이 아니라 `string`으로 확장되는 경우가 있다. 리터럴을 보존해야 하면 `T extends string`처럼 원시 타입 제약을 두거나, TypeScript 5.0에서 추가된 `const` 타입 매개변수(`<const T>`)를 사용한다.
- 반환 타입만 제네릭인 함수는 추론 근거가 없어 `unknown`으로 결정된다. ==`fetchJson<T>(url): Promise<T>` 같은 시그니처는 호출부가 타입 인자를 명시하는 것 외에는 어떤 검증도 하지 않으므로, 사실상 `as T` 단언과 같다.== 런타임 스키마 검증과 함께 써야 한다.
- 제약 없는 타입 변수에서 속성을 읽으면 오류이지만, 이를 피하려고 `T extends any`나 `T extends object`로 얼버무리면 제약이 무의미해진다. 실제로 사용하는 속성만 담은 최소 인터페이스로 상한을 정한다.
- 제네릭은 컴파일 시 지워지므로 `instanceof T`나 `typeof T` 같은 런타임 분기는 불가능하다. 런타임 판별이 필요하면 생성자나 판별 함수를 값으로 함께 전달한다.
- 타입 매개변수가 서너 개를 넘어가면 호출부에서 순서를 맞추기 어렵고 오류 메시지도 길어진다. 옵션 객체 타입 하나로 묶거나, 중간 타입 별칭으로 단계를 나누어 추론 부담을 줄인다.

## 관련 글

- [기본 타입·인터페이스·타입 별칭](/notes/typescript/types-interfaces-aliases/)
- [유니온·교차·리터럴 타입과 Narrowing](/notes/typescript/unions-narrowing/)
- [유틸리티 타입·조건부 타입·매핑 타입](/notes/typescript/utility-conditional-mapped-types/)
