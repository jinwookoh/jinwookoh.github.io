---
title: "컬렉션·제네릭·Optional"
series: java-spring
part: "자바 기초·모던 자바"
order: 3
summary: "여러 객체를 담는 컬렉션, 담기는 타입을 컴파일 시점에 고정하는 제네릭, 없을 수 있는 반환값을 표현하는 Optional을 한 번에 정리한다."
tags: [Java, Collections, Generics, Optional, HashMap]
sources: [spring/2026-05-17-java-collections.md, spring/2026-05-17-java-generics.md, spring/2026-05-17-java-optional.md]
updated: 2026-08-29
---

백엔드 코드의 대부분은 객체 여러 개를 모아서 조회하고, 걸러내고, 키로 찾는 일이다. 배열만으로는 크기 조절·중복 제거·키 조회를 직접 구현해야 하고, 제네릭이 없던 자바 1.4 시절처럼 컬렉션에 아무 타입이나 들어가면 꺼낼 때마다 캐스팅이 필요하며 잘못된 타입은 런타임 `ClassCastException`으로 드러난다. 값의 부재를 `null`로만 표현하면 검사를 빠뜨리는 순간 `NullPointerException`이 발생한다. 컬렉션, 제네릭, Optional은 이 세 문제를 각각 해결한다.

## 핵심 개념

### 컬렉션 3대 인터페이스

| 인터페이스 | 특성 | 대표 구현체 |
|---|---|---|
| `List` | 순서 있음, 중복 허용, 인덱스 접근 | `ArrayList`, `LinkedList` |
| `Set` | 중복 불허 | `HashSet`, `LinkedHashSet`, `TreeSet` |
| `Map` | 키-값 쌍, 키 중복 불허 | `HashMap`, `LinkedHashMap`, `TreeMap` |

`ArrayList`는 동적 배열이라 인덱스 접근이 O(1)이고, 중간 삽입·삭제는 O(n)이지만 연속 메모리 덕분에 캐시 효율이 높아 실무에서는 거의 항상 `ArrayList`를 쓴다. `LinkedList`는 포인터 오버헤드와 O(n) 인덱스 접근 때문에 이론상 이점이 실제 성능으로 이어지는 경우가 드물다.

`HashSet`·`HashMap`은 평균 O(1) 조회를 제공하며 순서를 보장하지 않는다. `LinkedHashSet`·`LinkedHashMap`은 삽입 순서를, `TreeSet`·`TreeMap`은 정렬 순서를 O(log n)으로 유지한다. 정렬 순회가 명시적 요구일 때만 Tree 계열을 선택한다.

생성은 자바 9 이후 `List.of`·`Set.of`·`Map.of`가 표준이다. 불변이라 `add`·`put` 호출 시 `UnsupportedOperationException`이 발생하고 `null`을 허용하지 않는다. 가변이 필요하면 `new ArrayList<>(List.of(...))`처럼 복사한다.

### 제네릭

제네릭은 클래스나 메서드가 다루는 타입을 매개변수로 선언하는 기능이다. `List<String>`으로 선언하면 `Integer`를 넣는 코드는 컴파일 단계에서 거부되고 꺼낼 때 캐스팅이 필요 없다. 타입 매개변수 이름은 관례상 `T`, `E`, `K`·`V`를 쓴다.

- 제네릭 클래스 `class Box<T>`는 인스턴스 생성 시, 제네릭 메서드 `static <T> T first(List<T> list)`는 호출 인자로부터 타입이 정해진다.
- 바운드 `<T extends Number>`는 `T`를 `Number`의 하위 타입으로 제한하고 그 범위의 메서드를 호출할 수 있게 한다.
- 와일드카드 `List<?>`는 요소를 `Object`로만 읽고 `null` 외에는 추가할 수 없다. `? extends T`는 읽기, `? super T`는 쓰기에 쓴다는 것이 PECS 원칙이다.

제네릭 타입 정보는 컴파일 후 지워진다(타입 소거). 런타임에는 `List<String>`과 `List<Integer>`가 같은 `ArrayList.class`이므로 `new T[]`나 `T.class`를 쓸 수 없고, Jackson의 `TypeReference`나 Spring의 `ParameterizedTypeReference`처럼 익명 서브클래스로 타입을 보존하는 우회가 필요하다.

### Optional

`Optional<T>`는 값이 없을 수 있음을 반환 타입에 드러내는 컨테이너다. 값을 꺼내려면 `orElse`·`orElseThrow`·`map` 같은 API를 거쳐야 하므로 부재 처리가 강제된다.

생성은 `Optional.of`, `Optional.ofNullable`, `Optional.empty` 세 가지이며 `Optional.of(null)`은 즉시 NPE를 던진다. 값을 다루는 API는 `map`(변환), `flatMap`(중첩 제거), `filter`(불일치 시 빈 `Optional`), `ifPresent`, `orElse`(즉시 평가), `orElseGet`(지연 평가), `orElseThrow`(예외)다. `isPresent()` 뒤에 `get()`을 부르는 방식은 `null` 검사와 다를 게 없으므로 체이닝으로 대체한다.

## 코드

컬렉션 선택과 불변·가변 초기화를 비교한다.

```java
import java.util.*;

public class CollectionBasics {
    public static void main(String[] args) {
        List<String> names = new ArrayList<>(List.of("Alice", "Bob"));
        names.add("Alice");                          // 중복 허용
        System.out.println(names.get(0) + " / " + names.size()); // Alice / 3

        Set<String> tags = new HashSet<>(Set.of("java", "spring"));
        tags.add("java");                            // 무시됨
        System.out.println(tags.size());             // 2

        Map<Long, String> users = new HashMap<>();
        users.put(1L, "Alice");
        users.put(1L, "Alice v2");                   // 같은 키는 덮어쓴다
        for (Map.Entry<Long, String> e : users.entrySet()) {
            System.out.println(e.getKey() + " = " + e.getValue());
        }

        Map<String, Integer> sorted = new TreeMap<>(Map.of("b", 2, "a", 1));
        System.out.println(sorted);                  // {a=1, b=2}

        List<String> fixed = List.of("x");
        // fixed.add("y");  -> UnsupportedOperationException
    }
}
```

제네릭 클래스·바운드·와일드카드와 타입 소거를 확인한다.

```java
import java.util.List;

public class GenericsDemo {

    record Box<T>(T value) {}

    static <T extends Comparable<T>> T max(List<? extends T> items) {
        T best = items.get(0);
        for (T item : items) {
            if (item.compareTo(best) > 0) best = item;
        }
        return best;
    }

    static double sum(List<? extends Number> numbers) {
        double total = 0;
        for (Number n : numbers) total += n.doubleValue();
        return total;
    }

    static void fillDefaults(List<? super Integer> target) {
        target.add(0);                                // Integer 상위 타입 리스트에 쓰기
    }

    public static void main(String[] args) {
        Box<String> box = new Box<>("hello");
        String s = box.value();                       // 캐스팅 불필요

        System.out.println(max(List.of(3, 9, 4)));    // 9
        System.out.println(sum(List.of(1, 2.5)));     // 3.5

        List<Number> sink = new java.util.ArrayList<>();
        fillDefaults(sink);

        System.out.println(List.of("a").getClass() == List.of(1).getClass()); // true, 타입 소거
    }
}
```

리포지토리가 반환한 `Optional`을 서비스에서 체이닝으로 처리한다.

```java
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Service;

interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
}

@Service
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public User getActiveUser(String email) {
        return userRepository.findByEmail(email)
                .filter(User::isActive)
                .orElseThrow(() -> new UserNotFoundException(email));
    }

    public String greeting(String email) {
        return userRepository.findByEmail(email)
                .map(User::getName)
                .map(name -> "안녕하세요, " + name)
                .orElseGet(() -> "게스트");
    }

    public Optional<Order> latestOrder(String email) {
        return userRepository.findByEmail(email)
                .flatMap(User::latestOrder);          // User -> Optional<Order>
    }
}
```

## 실무에서 걸리는 지점

- ==**`HashMap`을 여러 스레드가 동시에 수정하면 예외 없이 데이터가 손상될 수 있다.**== 공유 상태에는 `ConcurrentHashMap`을 쓴다.
- ==**`orElse`의 인자는 값이 있어도 평가된다.**== DB 조회처럼 비용이 있는 기본값은 `orElseGet`으로 지연시킨다.
- **`Optional`은 반환 타입 전용이다.** 필드에 두면 직렬화와 JPA 매핑이 깨지고, 빈 컬렉션이 부재를 표현하므로 `Optional<List<T>>`로 감싸지 않는다.
- **타입 소거 때문에 제네릭 타입 역직렬화는 힌트가 필요하다.** ==`RestClient`에서 `.body(List.class)`로 받으면 `List<LinkedHashMap>`이 되므로 `ParameterizedTypeReference<List<User>>`를 넘긴다.==

## 관련 글

- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
- [람다·함수형 인터페이스·Stream](/notes/java-spring/lambda-functional-stream/)
- [JPA·Hibernate·Spring Data JPA — Entity와 Repository](/notes/java-spring/jpa-hibernate-spring-data/)
