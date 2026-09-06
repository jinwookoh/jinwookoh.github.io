---
title: "팩토리 — Simple Factory·Factory Method·Abstract Factory"
series: design-patterns
part: "생성"
order: 2
summary: "생성 로직을 호출자에서 분리하는 세 단계 팩토리와, 스프링 빈 컨테이너와 만났을 때 생기는 프록시·주입 함정"
tags: [Factory Method, Abstract Factory, Simple Factory, Java 21, Spring]
sources: [https://jinwookoh.tistory.com/207]
updated: 2026-09-06
---

`new Sonata()`처럼 호출자가 구체 클래스를 직접 생성하면 호출자는 인터페이스가 아니라 구현에 결합된다. 구현을 바꾸려면 생성하는 모든 지점을 찾아 고쳐야 하고, 테스트에서 가짜 구현으로 바꿔 끼울 수도 없다. 생성 전에 필요한 검증·설정 조회·의존 객체 조립 같은 부수 로직도 호출자마다 복제된다. 팩토리 패턴은 생성 책임을 전담 객체로 옮겨 호출자가 인터페이스만 알도록 만드는 기법이며, 구현 복잡도에 따라 Simple Factory·Factory Method·Abstract Factory 세 단계로 나뉜다.

## 핵심 개념

**Simple Factory**는 GoF 패턴이 아니라 관용구다. 입력값을 받아 분기하고 알맞은 구현을 반환하는 정적 메서드 하나로 끝난다. 호출자는 팩토리 클래스 하나만 알면 되지만, 새 구현이 추가될 때마다 분기문을 수정해야 하므로 확장에 닫혀 있다. Java 21에서는 `sealed` 인터페이스와 `switch` 식을 조합해 이 약점을 줄일 수 있다. 분기 대상이 봉인된 타입이면 컴파일러가 누락된 케이스를 잡아내므로, 새 구현을 추가하고 팩토리 수정을 잊는 실수가 컴파일 단계에서 드러난다.

**Factory Method**는 GoF가 정의한 패턴으로, 생성 메서드를 추상으로 선언하고 어떤 구현을 만들지는 서브클래스가 결정한다. 부모 클래스는 생성된 객체를 사용하는 공통 흐름을 갖고, 생성 단계만 서브클래스에 위임하므로 템플릿 메서드와 자주 결합된다. 새 구현은 새 서브클래스로 추가되며 기존 코드는 수정하지 않는다. 대신 구현 하나당 팩토리 클래스가 하나씩 늘어난다.

**Abstract Factory**는 객체 하나가 아니라 서로 짝이 맞아야 하는 객체 집합을 생성한다. Windows 스타일 버튼과 Mac 스타일 스크롤바가 섞이면 안 되는 경우처럼, 제품군 단위로 일관성을 강제해야 할 때 쓴다. 팩토리 인터페이스가 제품별 생성 메서드를 모두 선언하고, 구현체마다 한 제품군을 담당한다. 제품군 교체는 팩토리 구현체 하나를 바꾸는 것으로 끝나지만, 제품 종류가 추가되면 인터페이스와 모든 구현체를 함께 수정해야 한다.

| 구분 | 확장 단위 | 새 구현 추가 시 | 적합한 상황 |
|---|---|---|---|
| Simple Factory | 분기문 | 팩토리 수정 | 구현 종류가 적고 변경이 드물 때 |
| Factory Method | 서브클래스 | 클래스 추가 | 생성 로직을 수정 없이 확장할 때 |
| Abstract Factory | 제품군 | 모든 팩토리 수정 | 짝이 맞아야 하는 객체 집합을 통째로 교체할 때 |

스프링의 `BeanFactory`와 `ApplicationContext`는 이 패턴의 대규모 구현체다. 빈 이름이나 타입을 받아 인스턴스를 반환하고, 생성 과정에서 의존성 주입·프록시 적용·생명주기 콜백까지 처리한다. 직접 팩토리를 만들기 전에 `Map<String, Car>` 주입이나 `ObjectProvider<Car>`로 같은 목적을 달성할 수 있는지 먼저 확인한다.

## 코드

`sealed` 인터페이스와 `switch` 식으로 구현한 Simple Factory. `CarType`에 상수를 추가하면 `switch`가 컴파일 오류를 내므로 분기 누락이 발생하지 않는다.

```java
public sealed interface Car permits Sonata, Grandeur {
    void drive();
}

public final class Sonata implements Car {
    @Override public void drive() { System.out.println("Sonata"); }
}

public final class Grandeur implements Car {
    @Override public void drive() { System.out.println("Grandeur"); }
}

public enum CarType { SONATA, GRANDEUR }

public final class CarFactory {
    private CarFactory() {}

    public static Car create(CarType type) {
        return switch (type) {
            case SONATA -> new Sonata();
            case GRANDEUR -> new Grandeur();
        };
    }
}
```

Factory Method. 부모는 생성 후 공통 흐름을 갖고, 생성 자체는 서브클래스가 결정한다.

```java
public abstract class CarDealer {
    protected abstract Car createCar();

    public final void deliver() {
        Car car = createCar();
        inspect(car);
        car.drive();
    }

    private void inspect(Car car) { /* 공통 검수 */ }
}

public final class SonataDealer extends CarDealer {
    @Override protected Car createCar() { return new Sonata(); }
}

public final class GrandeurDealer extends CarDealer {
    @Override protected Car createCar() { return new Grandeur(); }
}
```

Abstract Factory를 스프링 빈으로 등록하고 설정값으로 제품군을 선택하는 예제. 제품군 구현체를 빈으로 두면 `Map` 주입으로 별도 팩토리 선택 코드 없이 교체할 수 있다.

```java
public interface GuiFactory {
    Button createButton();
    Scrollbar createScrollbar();
}

@Component("windows")
public class WindowsGuiFactory implements GuiFactory {
    @Override public Button createButton() { return new WinButton(); }
    @Override public Scrollbar createScrollbar() { return new WinScrollbar(); }
}

@Component("mac")
public class MacGuiFactory implements GuiFactory {
    @Override public Button createButton() { return new MacButton(); }
    @Override public Scrollbar createScrollbar() { return new MacScrollbar(); }
}

@Service
public class ScreenBuilder {
    private final GuiFactory factory;

    public ScreenBuilder(Map<String, GuiFactory> factories,
                         @Value("${app.ui.theme}") String theme) {
        this.factory = Objects.requireNonNull(factories.get(theme),
                () -> "unknown theme: " + theme);
    }

    public Screen build() {
        return new Screen(factory.createButton(), factory.createScrollbar());
    }
}
```

## 실무에서 걸리는 지점

- **문자열 키 분기**: `"SONATA"` 같은 문자열로 분기하는 Simple Factory는 오타가 컴파일을 통과하고 런타임 예외로 나타난다. `enum`이나 `sealed` 타입으로 입력을 제한하면 잘못된 키가 코드에 들어올 수 없다.
- **팩토리 산출물과 스프링 프록시**: ==팩토리가 `new`로 만든 객체는 스프링 빈이 아니므로 `@Transactional`·`@Async`·`@Cacheable` 같은 프록시 기반 애너테이션이 붙어 있어도 동작하지 않는다.== 트랜잭션이 필요한 객체는 빈으로 등록하고 `ObjectProvider`나 `Map` 주입으로 선택한다.
- **반환 인스턴스의 공유 여부**: 팩토리가 매번 새 인스턴스를 만드는지 캐시된 인스턴스를 돌려주는지가 메서드 시그니처에 드러나지 않는다. ==캐시된 가변 객체를 반환하면 한 호출자의 상태 변경이 다른 호출자에게 전파되고, 멀티스레드 환경에서는 재현이 어려운 경쟁 상태로 이어진다.== 공유 인스턴스를 반환한다면 불변으로 만들거나 이름에 `getInstance` 계열을 써서 계약을 드러낸다.
- **Abstract Factory에 제품 추가**: 새 제품 메서드를 인터페이스 `default`로 추가하고 `UnsupportedOperationException`을 던지게 두면 ==구현하지 않은 팩토리가 컴파일은 통과하고 실제 호출 시점에야 실패한다.== 제품 추가는 모든 구현체를 함께 고치는 작업으로 계획하고, 봉인된 인터페이스로 구현체 목록을 고정해 누락을 컴파일 단계에서 잡는다.
- **과도한 계층화**: 구현이 두 개뿐인데 Abstract Factory를 도입하면 클래스 수만 늘고 얻는 것이 없다. Simple Factory로 시작해 분기가 늘어나면 Factory Method로, 짝이 맞아야 하는 객체 집합이 생기면 Abstract Factory로 올리는 순서가 적절하다.

## 관련 글

- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
- [빌더 — 선택 파라미터가 많은 불변 객체 생성](/notes/design-patterns/builder/)
- [의존성 주입 — 필드·생성자·세터 주입의 차이](/notes/design-patterns/dependency-injection/)
