---
title: "데코레이터 — 상속 없이 기능을 겹겹이 추가"
series: design-patterns
part: "구조"
order: 8
summary: "같은 인터페이스로 객체를 감싸 실행 시점에 기능을 조합하며, 상태가 필요하면 클래스로, 순수 변환이면 함수 합성으로 쓴다"
tags: [Decorator, Function.andThen, InputStream, BeanPostProcessor, Java 21]
sources: [https://jinwookoh.tistory.com/219]
updated: 2026-09-06
---

기본 커피에 우유·시럽·휘핑을 얹는 조합을 상속으로 표현하면 조합 하나마다 하위 클래스가 생긴다. 옵션이 n개면 클래스는 최대 2ⁿ개까지 늘어나고, 옵션을 하나 추가할 때마다 기존 클래스 전부를 다시 조합해야 한다. 상속은 컴파일 시점에 고정되므로 실행 중에 "이 주문에만 시럽을 두 번"과 같은 요구를 만족시킬 수도 없다. 데코레이터는 기능을 클래스 계층이 아니라 객체를 감싸는 층으로 표현해 이 두 문제를 동시에 없앤다.

## 핵심 개념

데코레이터는 원본 객체와 같은 인터페이스를 구현하고, 그 인터페이스 타입의 필드로 원본을 보유한다. 요청이 들어오면 자신의 처리를 앞이나 뒤에 붙인 뒤 보유한 객체에 위임한다. 데코레이터 역시 같은 인터페이스이므로 데코레이터를 다른 데코레이터로 다시 감쌀 수 있고, 클라이언트는 자신이 잡고 있는 참조가 원본인지 몇 겹으로 감싸인 것인지 구분하지 못한다. 이 투명성 덕분에 조합은 실행 시점에 `new`의 순서만으로 결정된다.

구성 요소는 넷이다. 공통 인터페이스(Component), 실제 일을 하는 구현체(ConcreteComponent), 인터페이스를 구현하면서 대상을 보유하는 추상 데코레이터, 그리고 기능 하나씩을 맡는 구체 데코레이터. 추상 데코레이터는 모든 메서드를 그대로 위임하도록 만들어 두고, 구체 데코레이터는 바꿀 메서드만 오버라이드한다.

프록시와 클래스 구조가 같지만 목적이 다르다. 프록시는 접근 제어·지연 로딩처럼 원본과의 관계를 한 겹으로 관리하고 클라이언트가 조립하지 않는다. 데코레이터는 기능 추가가 목적이며 여러 겹을 클라이언트가 조립한다. `@Transactional`을 처리하는 Spring AOP 프록시는 구조상 동적 데코레이터에 해당한다.

Java 8 이후에는 상태가 없는 데코레이터를 클래스 대신 함수 합성으로 대체할 수 있다. `Function.andThen`, `UnaryOperator`, `Predicate.and` 같은 합성 메서드가 감싸기의 역할을 한다. 두 방식의 선택 기준은 다음과 같다.

| 구분 | 클래스 데코레이터 | 함수 합성 |
|---|---|---|
| 상태 보유 | 필드로 가능 (버퍼, 카운터) | 어렵다 |
| 코드량 | 기능마다 클래스 1개 | 람다 한 줄 |
| 적합한 경우 | I/O 스트림처럼 상태와 기능이 함께 붙을 때 | 가격 계산·문자열 변환 같은 순수 로직 |

## 코드

추상 데코레이터가 위임을 담당하고, 구체 데코레이터는 필요한 메서드만 덧붙인다. 조합 순서는 클라이언트가 결정한다.

```java
public interface Coffee {
    String description();
    int cost();
}

public final class Espresso implements Coffee {
    public String description() { return "에스프레소"; }
    public int cost() { return 3000; }
}

public abstract class CoffeeDecorator implements Coffee {
    protected final Coffee inner;
    protected CoffeeDecorator(Coffee inner) { this.inner = inner; }
    public String description() { return inner.description(); }
    public int cost() { return inner.cost(); }
}

public final class Milk extends CoffeeDecorator {
    public Milk(Coffee inner) { super(inner); }
    @Override public String description() { return inner.description() + ", 우유"; }
    @Override public int cost() { return inner.cost() + 700; }
}

public final class Syrup extends CoffeeDecorator {
    public Syrup(Coffee inner) { super(inner); }
    @Override public String description() { return inner.description() + ", 시럽"; }
    @Override public int cost() { return inner.cost() + 500; }
}

Coffee order = new Syrup(new Milk(new Espresso()));
System.out.println(order.description() + " = " + order.cost()); // 에스프레소, 우유, 시럽 = 4200
```

상태가 없는 가격 계산은 클래스 없이 `UnaryOperator`를 합성해 같은 결과를 낸다. 원본 글의 raw `Function` 사용은 제네릭 타입을 붙여 바로잡았다.

```java
import java.util.function.UnaryOperator;

UnaryOperator<Integer> base  = cost -> cost + 3000;
UnaryOperator<Integer> milk  = cost -> cost + 700;
UnaryOperator<Integer> syrup = cost -> cost + 500;

var latte = base.andThen(milk).andThen(syrup);
System.out.println(latte.apply(0)); // 4200
```

Spring에서는 `BeanPostProcessor`로 빈을 데코레이터로 교체할 수 있다. 원본 빈과 같은 인터페이스를 구현한 래퍼를 반환하면 주입받는 쪽은 변경을 알지 못한다.

```java
@Component
public class TimingDecoratorPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof PaymentGateway gateway) {
            return new TimedPaymentGateway(gateway);
        }
        return bean;
    }
}

record TimedPaymentGateway(PaymentGateway inner) implements PaymentGateway {
    @Override
    public Receipt pay(Order order) {
        long start = System.nanoTime();
        try {
            return inner.pay(order);
        } finally {
            System.out.printf("pay took %d ms%n", (System.nanoTime() - start) / 1_000_000);
        }
    }
}
```

## 실무에서 걸리는 지점

- Java I/O에서 `ObjectInputStream(BufferedInputStream(FileInputStream))`처럼 쌓을 때 ==close()는 가장 바깥 스트림에만 호출해야 하며, 안쪽 스트림을 직접 닫으면 바깥 데코레이터의 버퍼에 남은 데이터가 유실된다==. try-with-resources에는 바깥 객체 하나만 선언한다.
- 데코레이터가 인터페이스의 메서드 일부만 오버라이드하면 나머지는 그대로 통과한다. `equals`·`hashCode`·`toString`은 인터페이스에 없으므로 위임되지 않고, ==감싼 객체를 컬렉션 키나 `Set`에 넣으면 원본과 다른 객체로 취급된다==.
- 겹이 많아지면 스택 트레이스가 길어지고 어느 층에서 실패했는지 찾기 어렵다. 층마다 이름을 가지는 클래스로 두고 `toString`에 안쪽 객체를 포함시키면 로그로 조합을 확인할 수 있다.
- Spring AOP 프록시는 인터페이스 기반이든 CGLIB이든 외부 호출만 가로챈다. ==같은 클래스 안에서 `this.method()`로 부르는 내부 호출은 데코레이터 층을 거치지 않으므로 `@Transactional`·`@Cacheable`이 적용되지 않는다==.
- 데코레이터 순서는 의미를 바꾼다. 압축 후 암호화와 암호화 후 압축은 결과 크기와 보안 특성이 다르고, 로깅을 재시도 안쪽에 두면 시도마다 기록되고 바깥에 두면 한 번만 기록된다. 순서를 코드 리뷰 대상으로 다룬다.

## 관련 글

- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
- [어댑터 — 맞지 않는 인터페이스를 감싸서 연결](/notes/design-patterns/adapter/)
- [책임 연쇄 — 핸들러를 사슬로 엮어 순차 처리](/notes/design-patterns/chain-of-responsibility/)
