---
title: "람다·함수형 인터페이스·Stream"
series: java-spring
part: "자바 기초·모던 자바"
order: 5
summary: "람다는 함수형 인터페이스의 인스턴스이고, Stream은 그 람다를 받아 컬렉션을 선언적으로 처리하는 일회용 지연 파이프라인이다."
tags: [Lambda, Functional Interface, Stream API, Collectors, Method Reference]
sources: [spring/2026-05-17-java-stream-lambda.md, 2026-05-03-java-fp-lambda.md, 2026-05-03-java-fp-functional-interfaces.md, 2026-05-03-java-fp-stream.md, 2026-05-03-java-fp-basics.md]
updated: 2026-08-29
---

자바 8 이전에는 동작을 인자로 넘기려면 익명 내부 클래스가 필요했다. 정렬 기준 한 줄을 위해 `Comparator` 구현 6줄을 감싸야 했고, 필터 조건이 늘 때마다 메서드가 하나씩 늘어났다. 컬렉션 처리도 `for`와 `if`를 중첩해 순회 방법을 직접 적어야 했으므로 의도가 보일러플레이트에 묻혔다. ==람다는 함수를 값으로 다루게 하고, 함수형 인터페이스는 그 값의 표준 타입을 제공하며, Stream은 둘을 받아 컬렉션 처리를 선언형 파이프라인으로 바꾼다.==

## 핵심 개념

### 람다는 함수형 인터페이스의 인스턴스다

람다의 타입은 추상 메서드가 정확히 하나인 인터페이스이며 default·static 메서드는 몇 개든 무방하다. `@FunctionalInterface`는 이 조건을 컴파일 타임에 검증하므로 붙이는 것이 표준이다.

문법은 `(파라미터) -> { 본문 }`이며 타입 생략, 단일 표현식이면 `{}`와 `return` 생략, 파라미터가 하나일 때만 `()` 생략이 가능하다. 캡처하는 외부 지역 변수는 effectively final이어야 한다. 람다는 지역 변수의 복사본을 캡처하므로 재할당을 금지하며, 인스턴스 필드에는 이 규칙이 없다. 람다 안의 `this`는 둘러싼 클래스 인스턴스이고 익명 클래스의 `this`는 자기 자신이다. 람다는 `invokedynamic`으로 런타임에 생성되어 클래스 파일이 생기지 않는다.

메서드 참조는 정적 메서드(`Integer::parseInt`), 타입의 인스턴스 메서드(`String::toUpperCase`), 객체의 인스턴스 메서드(`list::add`), 생성자(`ArrayList::new`) 네 종류다.

### java.util.function 표준 인터페이스

입력과 출력 형태의 조합 네 가지가 기본이다. `Supplier<T>`는 `() -> T`, `Consumer<T>`는 `T -> void`, `Predicate<T>`는 `T -> boolean`, `Function<T,R>`은 `T -> R`이다. `Bi*`는 입력이 둘인 변형이고, `UnaryOperator`·`BinaryOperator`는 입출력 타입이 같은 특수화로 `reduce`가 `BinaryOperator`를 받는다. `Predicate`는 `and`·`or`·`negate`로, `Function`은 `andThen`·`compose`로 조합하며 `f.andThen(g)`는 `g(f(x))`, `f.compose(g)`는 `f(g(x))`다. `Runnable`과 `Callable<T>`도 함수형 인터페이스이며 `Callable`만 checked exception을 던질 수 있다. `IntPredicate` 같은 원시 특수화는 박싱을 피하기 위한 것이다.

### Stream은 컬렉션이 아니라 파이프라인이다

소스 → 중간 연산(0개 이상) → 종료 연산(1개) 구조다. 중간 연산(`filter`·`map`·`flatMap`·`mapToInt`·`sorted`·`distinct`·`limit`·`takeWhile`·`peek`)은 Stream을 반환해 체이닝되고, 종료 연산(`toList`·`collect`·`count`·`findFirst`·`anyMatch`·`reduce` 등)이 호출되기 전까지 아무것도 실행되지 않는다. 요소를 한 개씩 끌어오므로 무한 소스도 `limit`으로 끊어 쓸 수 있고, `findFirst`·`anyMatch`는 결과가 결정되면 즉시 멈춘다. 원본은 변경되지 않으며 종료 연산을 거친 Stream은 재사용할 수 없다.

`map`은 1:1 변환, `flatMap`은 요소를 Stream으로 펼쳐 이어 붙이는 평탄화다. `reduce`는 초기값을 주면 값을, 주지 않으면 `Optional`을 반환한다. `groupingBy`는 SQL GROUP BY에 해당하고 두 번째 인자로 `counting`·`summingInt`를 중첩한다. Java 16부터는 `stream.toList()`가 불변 리스트를 반환하므로 단순 수집에는 `collect(Collectors.toList())` 대신 이쪽을 쓴다.

## 코드

같은 정렬 기준을 익명 클래스, 람다, 메서드 참조로 표현한 예다.

```java
import java.util.Comparator;
import java.util.List;

public class ComparatorForms {
    public static void main(String[] args) {
        Comparator<String> anonymous = new Comparator<>() {
            @Override
            public int compare(String a, String b) {
                return Integer.compare(a.length(), b.length());
            }
        };
        Comparator<String> lambda = (a, b) -> Integer.compare(a.length(), b.length());
        Comparator<String> reference = Comparator.comparingInt(String::length);

        List<String> words = List.of("kafka", "jvm", "spring", "io");
        System.out.println(words.stream().sorted(reference).toList());
        // [io, jvm, kafka, spring]
    }
}
```

`Predicate`를 합성해 동적 필터를 만드는 예다.

```java
import java.util.List;
import java.util.function.Predicate;

record Member(String name, int age, String city, boolean active) {}

public class MemberCriteria {
    static Predicate<Member> ageOver(int age) { return m -> m.age() > age; }
    static Predicate<Member> livesIn(String city) { return m -> m.city().equals(city); }
    static Predicate<Member> active() { return Member::active; }

    public static void main(String[] args) {
        List<Member> members = List.of(
                new Member("Alice", 34, "Seoul", true),
                new Member("Bob", 19, "Seoul", true),
                new Member("Chris", 41, "Busan", false));

        Predicate<Member> criteria = ageOver(20).and(livesIn("Seoul")).and(active());

        List<String> names = members.stream()
                .filter(criteria)
                .map(Member::name)
                .toList();
        System.out.println(names); // [Alice]
    }
}
```

서비스 계층에서 흔한 집계 파이프라인이다. `groupingBy`·`mapToInt`·`flatMap`을 한 번에 본다.

```java
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

record Item(String sku, int quantity) {}
record Order(long id, String status, int amount, List<Item> items) {}

public class OrderStats {
    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order(1L, "PAID", 12000, List.of(new Item("A", 2), new Item("B", 1))),
                new Order(2L, "PAID", 8000, List.of(new Item("A", 1))),
                new Order(3L, "CANCELLED", 5000, List.of(new Item("C", 3))));

        Map<String, Long> countByStatus = orders.stream()
                .collect(Collectors.groupingBy(Order::status, Collectors.counting()));

        int paidTotal = orders.stream()
                .filter(o -> o.status().equals("PAID"))
                .mapToInt(Order::amount)
                .sum();

        Map<String, Integer> quantityBySku = orders.stream()
                .flatMap(o -> o.items().stream())
                .collect(Collectors.groupingBy(Item::sku, Collectors.summingInt(Item::quantity)));

        System.out.println(countByStatus);  // {PAID=2, CANCELLED=1}
        System.out.println(paidTotal);      // 20000
        System.out.println(quantityBySku);  // {A=3, B=1, C=3}
    }
}
```

## 실무에서 걸리는 지점

- ==**`parallelStream`은 기본 선택지가 아니다.**== 공용 `ForkJoinPool.commonPool`을 다른 작업과 나눠 쓰고, 데이터가 수만 건 미만이면 분할·병합 오버헤드가 이득을 상회하며, I/O가 섞인 람다는 공용 풀을 블로킹한다. CPU 집약적이고 순서 무관하며 부작용 없는 작업에 한해 측정 후 적용한다.
- **`forEach` 안에서 외부 컬렉션을 수정하지 않는다.** `ArrayList`에 `add`하는 부작용은 병렬 전환 시 race condition이 된다. 결과는 `toList`나 `collect`로 수집한다. 단순 순회만 있다면 for-each가 더 읽기 쉽다.
- ==**`Collectors.toMap`은 키 중복 시 `IllegalStateException`을 던진다.**== 중복 가능한 키에는 세 번째 인자로 병합 함수를 넘긴다.
- **박싱 비용과 `Optional` 위치.** 합계·평균은 `mapToInt`로 원시 스트림에서 계산한다. `Optional`은 반환 타입에서만 쓰고 필드나 파라미터에는 쓰지 않으며, 기본값이 비싼 계산이면 `orElse` 대신 `orElseGet`을 쓴다.

## 관련 글

- [컬렉션·제네릭·Optional](/notes/java-spring/collections-generics-optional/)
- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
- [Modern Java 9~21 핵심](/notes/java-spring/modern-java/)
