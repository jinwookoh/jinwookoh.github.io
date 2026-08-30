---
title: "인터페이스·다형성·SOLID"
series: java-spring
part: "자바 기초·모던 자바"
order: 2
summary: "인터페이스와 다형성이 구현체 교체를 가능하게 하고, SOLID 5원칙이 그 교체를 안전하게 만드는 규칙임을 정리한다."
tags: [Java, Interface, Polymorphism, SOLID, DI]
sources: [spring/2026-05-16-java-interface-and-polymorphism.md, 2026-05-03-solid-principles.md]
updated: 2026-08-29
---

구체 클래스에 직접 의존하는 코드는 변경에 취약하다. 결제 방식을 문자열로 분기하는 `if-else`는 새 방식이 추가될 때마다 검증된 메서드를 다시 수정해야 하고, 알림 서비스가 `new EmailService()`를 직접 생성하면 SMS 채널을 붙이는 순간 상위 로직까지 손대야 한다. 테스트에서 게이트웨이를 가짜 구현으로 바꾸는 것도 불가능하다. 인터페이스와 다형성은 이런 결합을 끊는 언어 차원의 수단이고, SOLID는 그 수단을 어느 방향으로 써야 변경 비용이 줄어드는지 정리한 원칙이다.

## 핵심 개념

**인터페이스**는 메서드 시그니처만 정의한 계약이다. 메서드는 기본적으로 `public abstract`, 필드는 `public static final`이다. Java 8부터 `default`·`static` 메서드로 본문을 가질 수 있고, Java 9부터 `private` 메서드도 허용되므로 "인터페이스에는 본문이 없다"는 설명은 Java 7 이전에만 맞다. 클래스는 `implements`로 여러 인터페이스를 구현할 수 있지만 `extends`는 하나만 가능하다. 두 부모의 같은 메서드 중 어느 쪽을 따를지 모호해지는 다이아몬드 문제 때문이다. 두 인터페이스의 `default` 메서드가 충돌하면 컴파일 오류가 나고 구현 클래스가 오버라이드해서 해소해야 한다.

**다형성**은 상위 타입 변수 하나가 서로 다른 구현체를 담고, 호출 시점에 실제 객체의 메서드가 실행되는 성질이다. 매개변수 타입을 인터페이스로 잡으면 새 구현체를 추가해도 호출부는 바뀌지 않는다. `@Override`는 시그니처 일치를 컴파일러가 검증하게 해 오타로 인한 오버로딩 실수를 막는다.

**추상 클래스**는 공통 상태와 구현을 공유하면서 일부를 하위 클래스에 위임할 때 쓴다. 공유할 필드나 구현이 없다면 인터페이스가 우선이다.

**SOLID**는 위 수단을 사용하는 다섯 가지 규칙이다. 관통하는 목표는 하나다. 변경 한 번이 무관한 코드를 깨뜨리지 않게 하는 것이다.

| 원칙 | 핵심 질문 | 위반 신호 | 처방 |
|:---|:---|:---|:---|
| SRP 단일 책임 | 변경 이유가 하나인가 | 클래스 설명에 "그리고"가 들어간다 | 변경 이유별로 클래스 분리 |
| OCP 개방-폐쇄 | 새 타입 추가 시 기존 코드를 고치는가 | 타입 문자열로 `if-else`·`switch` 증가 | 인터페이스 + 다형성 |
| LSP 리스코프 치환 | 자식을 부모 자리에 넣어도 안전한가 | 오버라이드에서 `UnsupportedOperationException` | 상속 관계 재검토, 인터페이스 분리 |
| ISP 인터페이스 분리 | 안 쓰는 메서드에 의존하는가 | 빈 구현, 예외만 던지는 메서드 | 작은 인터페이스 여러 개 |
| DIP 의존성 역전 | 상위 모듈이 구체 클래스를 직접 생성하는가 | 필드에서 `new ConcreteClass()` | 추상화에 의존 + 외부 주입 |

SRP의 "책임"은 메서드 개수가 아니라 변경 이유다. 같은 이유로 함께 바뀌는 코드는 한 클래스에 둔다. ISP는 같은 기준을 인터페이스에 적용한 것이다. LSP는 하위 타입이 상위 타입보다 엄격한 사전 조건을 요구하거나 약한 사후 조건을 보장해서는 안 된다는 뜻이다. 직사각형을 상속한 정사각형이 `setWidth` 호출 시 높이까지 바꾸는 사례가 고전적이며, 여기서 상속보다 컴포지션을 선호하라는 지침이 나온다. DIP는 원칙이고 의존성 주입(DI)은 구현 기법이다. Spring은 인터페이스 타입 생성자 매개변수에 등록된 구현체를 주입해 주지만, 인터페이스 설계가 잘못되면 프레임워크가 있어도 결합은 그대로다.

다섯 원칙은 한 흐름이다. DIP가 인터페이스를 도입하게 하고, ISP가 그것을 작게 나누고, OCP가 구현체 추가로 확장하게 하며, LSP가 새 구현체의 계약 준수를 강제하고, 그 결과 SRP가 지켜진다.

## 코드

결제 수단을 인터페이스로 추상화하고, `sealed`로 허용 구현체를 명시하며, `default` 메서드로 공통 검증을 공유한다.

```java
public sealed interface PaymentMethod permits CardPayment, BankTransferPayment {

    void pay(long amount);

    default void validate(long amount) {
        if (amount <= 0) {
            throw new IllegalArgumentException("amount must be positive: " + amount);
        }
    }
}

public final class CardPayment implements PaymentMethod {
    @Override
    public void pay(long amount) {
        validate(amount);
        System.out.println("card: " + amount);
    }
}

public final class BankTransferPayment implements PaymentMethod {
    @Override
    public void pay(long amount) {
        validate(amount);
        System.out.println("bank transfer: " + amount);
    }
}
```

Spring 서비스는 인터페이스에만 의존하고 생성자 주입을 받는다. 구현체가 바뀌어도 이 클래스는 수정되지 않는다.

```java
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final PaymentMethod paymentMethod;

    public OrderService(PaymentMethod paymentMethod) {
        this.paymentMethod = paymentMethod;
    }

    public void placeOrder(long amount) {
        paymentMethod.pay(amount);
    }
}
```

LSP·ISP를 함께 적용한 예다. 읽기와 쓰기를 별도 계약으로 나누면 읽기 전용 구현체가 `write()`를 예외로 막을 필요가 없어진다.

```java
public interface ReadableStore {
    String read(String key);
}

public interface WritableStore {
    void write(String key, String value);
}

public final class ReadOnlyStore implements ReadableStore {
    private final java.util.Map<String, String> data;

    public ReadOnlyStore(java.util.Map<String, String> data) {
        this.data = java.util.Map.copyOf(data);
    }

    @Override
    public String read(String key) {
        return data.get(key);
    }
}

public final class InMemoryStore implements ReadableStore, WritableStore {
    private final java.util.Map<String, String> data = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public String read(String key) {
        return data.get(key);
    }

    @Override
    public void write(String key, String value) {
        data.put(key, value);
    }
}
```

## 실무에서 걸리는 지점

- **구현체가 둘 이상이면 주입이 실패한다.** 단일 타입으로 주입하면 `NoUniqueBeanDefinitionException`이 발생한다. `@Primary`, `@Qualifier`, 또는 `Map<String, PaymentMethod>`로 전부 받아 런타임에 선택하는 방식 중 하나를 명시한다.
- **구현체가 하나뿐인 인터페이스는 비용만 남긴다.** ==Mockito는 구체 클래스도 모킹하므로 테스트가 인터페이스를 강제하지 않는다.== 교체 지점이 실제로 존재할 때 추출한다.
- **`default` 메서드는 상태를 가질 수 없다.** 필드가 필요한 공통 구현을 억지로 넣으면 각 구현체에 getter를 강요하게 된다. 그 시점에는 추상 클래스나 컴포지션으로 옮긴다.
- **필드 주입은 순환 참조와 테스트 문제를 숨긴다.** `@Autowired` 필드 주입은 단위 테스트에서 의존성을 넣기 어렵고, ==Spring Boot 2.6부터 순환 참조가 기본 금지된다==. 생성자 주입으로 통일하고 `final`을 붙인다.
- **모든 분기를 다형성으로 바꾸면 과도한 추상화가 된다.** 새 타입이 실제로 추가되는 분기만 OCP 대상이다. 상속 계층이 세 단계를 넘으면 LSP 위반이 늘어나므로 그 전에 컴포지션으로 전환한다.

## 관련 글

- [자바 백엔드 개관 — JVM·객체와 클래스·OOP 4기둥](/notes/java-spring/java-overview-oop/)
- [Bean 등록과 주입 — 어노테이션·@Component·@Configuration](/notes/java-spring/bean-registration-injection/)
- [디자인 패턴 — 생성·구조](/notes/java-spring/design-patterns-creational-structural/)
