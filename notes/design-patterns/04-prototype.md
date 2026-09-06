---
title: "프로토타입 — 복제로 생성하기와 깊은 복사 함정"
series: design-patterns
part: "생성"
order: 4
summary: "생성 비용이 큰 객체는 원본을 복제해 만들되, Java clone() 대신 복사 생성자로 깊은 복사를 직접 구현해야 참조 공유 버그를 피한다."
tags: [Prototype, Cloneable, Deep Copy, Copy Constructor, Java]
sources: [https://jinwookoh.tistory.com/218]
updated: 2026-09-06
---

객체 하나를 만드는 데 DB 조회, 원격 호출, 설정 파일 파싱 같은 비용이 든다면 같은 종류의 객체가 100개 필요할 때 생성 과정을 100번 반복하게 된다. 초기화가 끝난 객체와 거의 같은 상태의 객체를 하나 더 원할 때도 생성자에 모든 값을 다시 넘겨야 한다. 호출하는 쪽이 구체 클래스를 모르는 상황이라면 `new` 자체가 불가능하다. 프로토타입 패턴은 이미 만들어진 인스턴스를 원본으로 두고 그것을 복제해 새 객체를 얻는 방식으로 이 문제를 해결한다. 다만 Java가 언어 차원에서 제공하는 `clone()`은 기본이 얕은 복사라서, 복제 방식을 잘못 고르면 원본과 복제본이 내부 상태를 공유하는 버그가 조용히 발생한다.

## 핵심 개념

프로토타입 패턴의 구조는 단순하다. 복제 메서드를 가진 인터페이스를 정의하고, 각 구체 클래스가 자기 자신을 복제해 반환하도록 구현한다. 클라이언트는 원본 인스턴스의 복제 메서드만 호출하므로 구체 타입을 알 필요가 없고, 생성 비용은 원본을 만들 때 한 번만 지불한다. 자주 쓰는 원본을 이름으로 등록해 두는 레지스트리를 두면 "설정이 끝난 템플릿에서 꺼내 쓰는" 형태로 확장된다.

복제에는 두 수준이 있다. 얕은 복사는 객체의 필드 값을 그대로 새 객체에 옮긴다. 기본 타입과 불변 객체는 값이 복사되므로 문제가 없지만, 참조 타입 필드는 주소만 복사되어 원본과 복제본이 같은 하위 객체를 가리킨다. 깊은 복사는 참조 타입 필드가 가리키는 객체까지 재귀적으로 새로 만들어 두 객체를 완전히 분리한다.

Java의 `Cloneable`은 메서드가 없는 마커 인터페이스이고, 실제 복제는 `Object.clone()`이 수행한다. ==`Cloneable`을 구현해도 `Object.clone()`은 필드 단위 얕은 복사만 하므로 `List`나 다른 객체를 담은 필드는 원본과 복제본이 같은 인스턴스를 공유한다.== 여기에 더해 `clone()`은 생성자를 거치지 않아 불변식 검증이 생략되고, `final` 참조 필드는 복제 후 새 값으로 바꿀 수 없어 깊은 복사가 막히며, 하위 클래스가 `super.clone()`을 호출하지 않으면 타입이 어긋난다. `CloneNotSupportedException`이 검사 예외라는 점도 호출부를 번거롭게 한다. 이런 이유로 Effective Java는 `Cloneable` 대신 복사 생성자나 복사 팩토리를 권한다.

| 구분 | `Cloneable` + `clone()` | 복사 생성자 / 복사 팩토리 |
|---|---|---|
| 복사 깊이 | 기본 얕은 복사, 깊은 복사는 직접 오버라이드 | 개발자가 필드별로 결정 |
| 생성자 호출 | 우회함 | 정상 호출, `final` 필드 초기화 가능 |
| 예외 | 검사 예외 처리 필요 | 없음 |
| 인터페이스 타입 복제 | 가능(다형성) | 인터페이스에 `copy()`를 두면 가능 |

복사 생성자는 같은 타입의 인스턴스를 인자로 받아 필드를 옮기는 생성자다. 참조 타입 필드는 그 자리에서 새 컬렉션이나 새 객체로 만들어 담으면 깊은 복사가 된다. 다형적으로 복제해야 하면 `Prototype<T>` 같은 인터페이스에 `T copy()`를 선언하고 각 구현이 자신의 복사 생성자를 호출하게 한다.

## 코드

`Cloneable`로 구현했을 때 참조 필드가 공유되는 상황이다. 복제본의 리스트를 비우면 원본도 비워진다.

```java
public class Monster implements Cloneable {
    private String name;
    private List<String> items;

    public Monster(String name, List<String> items) {
        this.name = name;
        this.items = items;
    }

    @Override
    public Monster clone() {
        try {
            return (Monster) super.clone();   // 필드 값만 복사, items는 같은 리스트
        } catch (CloneNotSupportedException e) {
            throw new AssertionError(e);
        }
    }

    public List<String> items() { return items; }
}

Monster original = new Monster("Orc", new ArrayList<>(List.of("Sword")));
Monster copy = original.clone();
copy.items().clear();
System.out.println(original.items());   // [] — 원본까지 비워짐
```

복사 생성자와 `copy()` 메서드로 깊은 복사를 구현한 버전이다. 중첩 객체(`Stats`)도 자기 복사 생성자를 가지며, 인터페이스를 통해 구체 타입을 몰라도 복제할 수 있다.

```java
public interface Prototype<T> {
    T copy();
}

public final class Stats {
    private int hp;
    private int attack;

    public Stats(int hp, int attack) { this.hp = hp; this.attack = attack; }
    public Stats(Stats source) { this(source.hp, source.attack); }
    public void damage(int amount) { hp -= amount; }
    public int hp() { return hp; }
}

public class Monster implements Prototype<Monster> {
    private final String name;
    private final List<String> items;
    private final Stats stats;

    public Monster(String name, List<String> items, Stats stats) {
        this.name = name;
        this.items = new ArrayList<>(items);
        this.stats = stats;
    }

    public Monster(Monster source) {
        this.name = source.name;                       // String은 불변, 그대로 공유
        this.items = new ArrayList<>(source.items);    // 새 리스트
        this.stats = new Stats(source.stats);          // 새 객체
    }

    @Override
    public Monster copy() { return new Monster(this); }

    public List<String> items() { return items; }
    public Stats stats() { return stats; }
}

Monster original = new Monster("Orc", List.of("Sword"), new Stats(100, 12));
Monster copy = original.copy();
copy.items().clear();
copy.stats().damage(30);
System.out.println(original.items());      // [Sword]
System.out.println(original.stats().hp()); // 100
```

원본을 이름으로 등록하고 꺼낼 때마다 복제해 주는 레지스트리다. 초기화 비용이 큰 객체를 한 번만 만들고 호출부에는 항상 독립된 인스턴스를 넘긴다.

```java
public class MonsterRegistry {
    private final Map<String, Monster> prototypes = new ConcurrentHashMap<>();

    public void register(String key, Monster prototype) {
        prototypes.put(key, prototype.copy());   // 등록 시점에도 분리
    }

    public Monster spawn(String key) {
        Monster prototype = prototypes.get(key);
        if (prototype == null) {
            throw new IllegalArgumentException("unknown prototype: " + key);
        }
        return prototype.copy();
    }
}
```

## 실무에서 걸리는 지점

- **컬렉션 복사 생성자는 한 단계만 복사한다.** ==`new ArrayList<>(source)`와 `List.copyOf(source)`는 리스트 객체만 새로 만들고 요소는 그대로 공유하므로, 요소가 가변 객체이면 복제본에서 요소를 수정할 때 원본도 바뀐다.== 요소까지 분리하려면 `stream().map(Item::new).toList()`처럼 요소별 복사 생성자를 호출해야 한다.
- **Lombok `toBuilder`는 얕은 복사다.** `@Builder(toBuilder = true)`로 만든 `original.toBuilder().build()`는 필드 참조를 그대로 옮긴다. 값 몇 개를 바꾼 새 객체를 만들 때는 유용하지만, 컬렉션 필드가 있으면 깊은 복사를 대신하지 못한다. `record`도 `with`류 메서드가 없으므로 같은 주의가 필요하다.
- **직렬화 기반 깊은 복사는 느리다.** `SerializationUtils.clone()` 같은 유틸은 객체 그래프 전체를 바이트로 썼다가 다시 읽는다. 모든 클래스가 `Serializable`이어야 하고 반사적으로 생성되며, 복사 생성자보다 수십 배 느린 경우가 흔하다. 대량 생성 경로에서는 쓰지 않는다.
- **JPA 엔티티 복제는 식별자를 빼야 한다.** ==엔티티를 복사하면서 `id`까지 옮기면 `persist`는 detached 예외를 내고 `merge`는 원본 행을 덮어쓴다.== 새 행을 원한다면 복사 생성자에서 `id`와 버전 필드는 `null`로 두고, 연관 엔티티는 참조만 공유할지 함께 복제할지 명시적으로 결정한다.
- **Spring의 prototype 스코프는 복제가 아니다.** `@Scope("prototype")`은 `getBean()` 호출마다 생성자를 새로 실행하는 것이지 원본 빈을 복제하는 것이 아니다. 싱글톤 빈에 주입하면 주입 시점에 한 번만 만들어져 이후 재사용되므로, 매번 새 인스턴스가 필요하면 `ObjectProvider<T>`로 꺼낸다.

## 관련 글

- [빌더 — 선택 파라미터가 많은 불변 객체 생성](/notes/design-patterns/builder/)
- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
- [메멘토 — 캡슐화를 지키며 상태 저장·복원](/notes/design-patterns/memento/)
