---
title: "방문자 — 클래스 수정 없이 연산 추가하기"
series: design-patterns
part: "행위"
order: 21
summary: "요소 타입은 고정되고 연산만 늘어날 때 더블 디스패치로 분기를 한곳에 모으는 방법과 sealed·switch 패턴 매칭 대체"
tags: [Visitor, Double Dispatch, sealed, Pattern Matching, Java 21]
sources: [https://jinwookoh.tistory.com/223]
updated: 2026-09-06
---

주문 항목 클래스 `Book`, `Fruit`가 이미 완성된 상태에서 배송비 계산이 추가되고, 다음에는 JSON 직렬화가, 그다음에는 할인 적용이 추가된다. 연산이 생길 때마다 각 클래스에 메서드를 넣으면 도메인 모델이 배송·직렬화·할인 정책까지 떠안게 되고, 연산 하나를 이해하려면 모든 클래스를 열어봐야 한다. 반대로 서비스 쪽에서 `instanceof`로 분기하면 같은 분기문이 연산 수만큼 복제되고, 새 타입이 추가됐을 때 어느 분기를 빠뜨렸는지 컴파일러가 알려주지 않는다. 방문자 패턴은 타입별 처리 로직을 요소 클래스 밖의 방문자 객체로 옮기고, 요소는 방문자를 받아들이는 메서드 하나만 갖도록 하는 기법이다.

## 핵심 개념

구조는 두 인터페이스로 이루어진다. **Element**는 `accept(Visitor)` 하나를 선언하고, 각 구체 요소는 그 안에서 `visitor.visit(this)`를 호출한다. **Visitor**는 요소 타입마다 `visit(Book)`, `visit(Fruit)` 오버로드를 선언하고, 구체 방문자가 연산 하나를 담당한다. 새 연산은 방문자 구현체를 하나 추가하는 것으로 끝나며 요소 클래스는 건드리지 않는다.

`accept`가 필요한 이유는 자바의 오버로딩 해석 방식에 있다. 오버로드는 인자의 정적 타입으로 컴파일 시점에 결정되므로, `Item item` 변수를 들고 `visitor.visit(item)`을 호출하면 `visit(Item)` 오버로드가 있어야 하고 구체 타입별 메서드는 선택되지 않는다. 요소가 `accept` 안에서 `this`를 넘기면 `this`의 정적 타입이 `Book`이므로 `visit(Book)`이 선택된다. 첫 번째 디스패치는 `accept`의 가상 호출로 요소 타입을, 두 번째 디스패치는 오버로드 해석으로 방문자 메서드를 고른다. 이 두 단계를 더블 디스패치라 부른다.

이 구조의 대가는 확장 축이 한쪽으로 고정된다는 점이다. 연산 추가는 쉽지만 요소 타입 추가는 모든 방문자 인터페이스와 구현체를 수정해야 한다. 따라서 요소 집합이 안정적이고 연산이 계속 늘어나는 경우에만 맞는다. 컴파일러의 AST 처리, 파일 트리에 대한 용량 계산·압축·검색, 문서 모델의 다양한 출력 포맷이 대표적이다.

Java 21부터 정식이 된 `sealed` 타입과 `switch` 패턴 매칭은 같은 문제를 `accept` 없이 푼다. 요소 계층을 `sealed`로 봉인하면 `switch`가 모든 하위 타입을 다뤘는지 컴파일러가 검사하므로, 클래식 방문자의 타입 안전성을 유지하면서 도메인 클래스에 아무것도 추가하지 않는다.

| 구분 | 클래식 방문자 | sealed + switch |
|---|---|---|
| 요소 클래스 | `accept` 구현 필요 | 수정 없음 |
| 분기 누락 검출 | 인터페이스 메서드 미구현으로 검출 | exhaustiveness 검사로 검출 |
| 요소 타입 추가 | 모든 방문자 수정 | 모든 `switch` 수정 |
| 외부 라이브러리 타입 | 적용 불가 | 봉인 불가하면 `default` 필요 |

## 코드

제네릭 반환 타입을 가진 클래식 방문자. 방문자가 값을 반환하도록 하면 결과를 필드에 누적할 필요가 없어 인스턴스를 재사용해도 안전하다.

```java
public interface ItemVisitor<R> {
    R visit(Book book);
    R visit(Fruit fruit);
}

public sealed interface Item permits Book, Fruit {
    <R> R accept(ItemVisitor<R> visitor);
}

public record Book(String title, int price) implements Item {
    @Override
    public <R> R accept(ItemVisitor<R> visitor) {
        return visitor.visit(this);
    }
}

public record Fruit(String name, int weightGram) implements Item {
    @Override
    public <R> R accept(ItemVisitor<R> visitor) {
        return visitor.visit(this);
    }
}

public final class ShippingFeeVisitor implements ItemVisitor<Integer> {
    @Override public Integer visit(Book book) { return 2_500; }
    @Override public Integer visit(Fruit fruit) {
        return fruit.weightGram() > 2_000 ? 6_000 : 4_000;
    }
}

public final class JsonVisitor implements ItemVisitor<String> {
    @Override public String visit(Book book) {
        return "{\"type\":\"book\",\"title\":\"%s\"}".formatted(book.title());
    }
    @Override public String visit(Fruit fruit) {
        return "{\"type\":\"fruit\",\"name\":\"%s\"}".formatted(fruit.name());
    }
}
```

같은 연산을 `switch` 패턴 매칭으로 옮긴 서비스. `Item`이 봉인되어 있으므로 `default` 없이도 컴파일되며, 새 타입을 `permits`에 추가하면 이 메서드가 컴파일 오류로 드러난다. 레코드 패턴을 쓰면 접근자 호출 없이 컴포넌트를 바로 꺼낼 수 있다.

```java
@Service
public class ShippingService {

    public int fee(Item item) {
        return switch (item) {
            case Book b -> 2_500;
            case Fruit(String name, int weightGram) when weightGram > 2_000 -> 6_000;
            case Fruit f -> 4_000;
        };
    }

    public int total(List<Item> items) {
        return items.stream().mapToInt(this::fee).sum();
    }
}
```

## 실무에서 걸리는 지점

- 방문자 인터페이스를 `visit(Item)` 하나로 축약하면 더블 디스패치가 깨진다. ==오버로드는 인자의 정적 타입으로 결정되므로 `visit(Item)`만 두면 `accept`를 거쳐도 항상 같은 메서드가 호출되고, 내부에서 다시 `instanceof` 분기를 하게 된다.==
- `switch`에 `default`를 넣는 순간 exhaustiveness 검사가 꺼진다. ==봉인된 타입에 `default`를 두면 새 하위 타입이 추가돼도 컴파일 오류 없이 `default`로 흘러가므로, 배송비 0원 같은 기본값이 조용히 적용된다.== 외부 타입이라 봉인이 불가능한 경우가 아니면 `default`를 쓰지 않는다.
- 결과를 방문자 필드에 누적하는 방식은 스프링 빈과 맞지 않는다. ==싱글톤 빈으로 등록된 방문자가 `totalCost` 같은 가변 필드를 가지면 요청 간에 값이 섞이므로==, 반환값으로 결과를 돌려주거나 호출마다 새 인스턴스를 만든다.
- JPA 엔티티에 패턴 매칭을 적용하면 지연 로딩 프록시에서 실패한다. ==Hibernate 프록시는 부모 타입을 상속한 별도 클래스라 `case Book b`에 매칭되지 않으며==, `Hibernate.unproxy()`로 실제 인스턴스를 꺼낸 뒤 분기해야 한다. 엔티티에 `sealed`를 붙일 수도 없으므로 도메인 모델을 레코드로 분리하는 편이 낫다.
- 트리 구조를 방문할 때 자식 순회를 `accept`에 둘지 방문자에 둘지 먼저 정한다. 양쪽에 모두 두면 노드가 두 번 처리되고, 깊은 트리에서 재귀 방문은 스택 깊이를 소모하므로 깊이 제한이나 명시적 스택이 필요하다.

## 관련 글

- [컴포지트 — 개별 객체와 트리를 같은 인터페이스로](/notes/design-patterns/composite/)
- [인터프리터 — 작은 DSL을 AST로 해석하기](/notes/design-patterns/interpreter/)
- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
