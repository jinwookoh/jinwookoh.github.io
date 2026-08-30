---
title: "자바 백엔드 개관 — JVM·객체와 클래스·OOP 4기둥"
series: java-spring
part: "자바 기초·모던 자바"
order: 1
summary: "자바가 JVM 위에서 어떻게 실행되고, 클래스·객체와 OOP 4기둥이 Spring Bean 설계의 전제가 되는 이유를 정리한다."
tags: [Java, JVM, OOP, 캡슐화, 다형성]
sources: [spring/2026-05-16-java-as-backend-standard.md, spring/2026-05-16-java-object-and-class.md, 2026-05-03-oop-principles.md]
updated: 2026-08-29
---

C로 작성한 서버 프로그램은 OS와 CPU 아키텍처마다 따로 컴파일해야 하고, 메모리 해제를 개발자가 직접 책임진다. 해제 누락은 장기 실행 서버에서 메모리 누수로 이어진다. 또한 데이터와 그 데이터를 다루는 함수가 분리된 절차적 코드는 필드 하나가 바뀔 때 영향 범위를 추적하기 어렵다. 자바는 이 문제를 JVM, 가비지 컬렉터, 객체지향 모델로 해결했고, 그 위에 Spring 생태계가 쌓이면서 국내 백엔드의 사실상 표준이 됐다. Spring의 Bean, IoC, DI는 "클래스로 객체를 만들고 인터페이스로 의존을 끊는다"는 자바 기본 모델 위에 서 있으므로, 이 글의 개념이 이후 모든 글의 전제가 된다.

## 핵심 개념

### JVM과 실행 모델

자바 소스(`.java`)는 `javac`가 바이트코드(`.class`)로 컴파일하고, 바이트코드는 각 OS용 JVM이 실행한다. 바이트코드는 특정 OS나 CPU에 종속되지 않으므로 한 번 빌드한 산출물을 어느 플랫폼에서든 그대로 배포할 수 있다. 자바는 순수 인터프리터 언어가 아니라 컴파일과 인터프리트를 모두 거치는 혼합형이다. JVM은 처음에는 바이트코드를 인터프리트하다가 호출 빈도가 높은 메서드를 JIT 컴파일러로 기계어로 변환해 캐싱하므로, 장기 실행 서버에서는 기동 후 시간이 지날수록 처리 성능이 올라간다. 짧은 CLI 도구에서는 기동 비용 때문에 불리하다.

용어 구분은 다음과 같다.

| 이름 | 정체 |
|---|---|
| Java | 언어 명세 |
| JVM | 바이트코드를 실행하는 가상 머신. GC·JIT 포함 |
| JRE | JVM + 표준 라이브러리. 실행 전용 |
| JDK | JRE + `javac` 등 개발 도구 |

Java 11부터 JRE는 별도 배포되지 않으며, 실행 전용 환경은 `jlink`로 필요한 모듈만 묶어 만든다. 운영 환경에서는 LTS(8·11·17·21·25)만 쓴다. Spring Boot 3.x는 Java 17 이상을 요구한다.

### 클래스와 객체

클래스는 필드(상태)와 메서드(동작), 생성자(초기화)를 묶은 타입 정의이고, 객체(인스턴스)는 `new`로 클래스에서 생성한 실체다. 클래스 자체는 객체가 아니다. 메서드는 특정 객체에 묶여 호출되며, `static` 멤버만 객체 없이 클래스 이름으로 접근한다. 생성자는 클래스와 같은 이름을 가지며 `new` 시점에 한 번 실행되고, `this`는 현재 객체를 가리킨다.

Spring의 Bean은 컨테이너가 대신 생성하고 보관하는 객체다. `@Component`가 붙은 클래스는 기동 시 컨테이너가 인스턴스를 만들어 필요한 곳에 주입한다. `new`를 호출하는 주체가 개발자에서 컨테이너로 옮겨간 것이 IoC의 실체다.

### OOP 4기둥

| 기둥 | 목적 | 자바 수단 |
|---|---|---|
| 캡슐화 | 상태 보호, 무결성 | `private` 필드 + 검증이 있는 공개 메서드 |
| 상속 | 공통 구현 재사용 (IS-A) | `extends`, `super`, `protected` |
| 다형성 | 같은 호출이 실제 타입에 따라 다르게 동작 | 오버로딩(컴파일 시), 오버라이딩(런타임) |
| 추상화 | 구현을 가리고 계약만 노출 | `abstract class`, `interface` |

캡슐화는 인스턴스의 데이터 무결성을 지키는 것이고, 추상화는 설계 차원에서 사용자가 알아야 할 것을 시그니처로 줄이는 것이다. 접근 제어자는 `public`(어디서나), `protected`(같은 패키지 + 다른 패키지의 하위 클래스), 키워드 없는 package-private(같은 패키지), `private`(같은 클래스) 네 단계이며, 두 기둥을 코드로 강제하는 도구다.

상속은 하위 클래스가 상위 클래스의 한 종류로 읽힐 때(IS-A)만 쓰고, 부품으로 갖는 관계(HAS-A)는 컴포지션으로 표현한다. 런타임 다형성은 상위 타입 변수에 하위 객체를 담았을 때 실제 객체의 메서드가 호출되는 메커니즘이며, 새 타입을 추가해도 호출 코드를 수정하지 않게 만드는 OCP의 기반이다. 인터페이스는 CAN-DO 계약이고 다중 구현이 가능하며, 추상 클래스는 IS-A 관계에서 공통 구현과 계약을 함께 제공하고 단일 상속만 허용한다. Java 8부터 인터페이스도 `default` 메서드로 구현을 가질 수 있다.

## 코드

`Player.java`를 컴파일하고 실행하는 기본 흐름이다.

```bash
javac Player.java        # Player.class 생성
java Player              # JVM이 바이트코드 실행
java Player.java         # 단일 파일은 컴파일 없이 바로 실행
```

캡슐화가 적용된 클래스다. 상태는 `private`, 변경은 검증이 있는 메서드로만, 불변 필드는 `final`로 고정한다.

```java
public class Player {
    private final String name;
    private int hp;

    public Player(String name, int hp) {
        if (hp < 0) throw new IllegalArgumentException("hp must be >= 0");
        this.name = name;
        this.hp = hp;
    }

    public String getName() { return name; }
    public int getHp() { return hp; }

    public void takeDamage(int amount) {
        if (amount <= 0) throw new IllegalArgumentException("amount must be > 0");
        this.hp = Math.max(0, this.hp - amount);
    }

    public static void main(String[] args) {
        Player alice = new Player("Alice", 100);
        alice.takeDamage(30);
        System.out.println(alice.getName() + " hp=" + alice.getHp());   // Alice hp=70
    }
}
```

상속·추상화·다형성을 보여주는 결제 예제다. `PaymentMethod`는 CAN-DO 계약, `Card`는 IS-A 공통 구현이며, 호출 측은 구체 타입을 모른 채 `pay()`만 호출한다.

```java
import java.math.BigDecimal;
import java.util.List;

public interface PaymentMethod {
    void pay(BigDecimal amount);
}

abstract class Card implements PaymentMethod {
    protected final String cardNumber;

    protected Card(String cardNumber) {
        this.cardNumber = cardNumber;
    }

    protected String masked() {
        return "****" + cardNumber.substring(cardNumber.length() - 4);
    }
}

class CreditCard extends Card {
    private final BigDecimal limit;

    CreditCard(String cardNumber, BigDecimal limit) {
        super(cardNumber);
        this.limit = limit;
    }

    @Override
    public void pay(BigDecimal amount) {
        if (amount.compareTo(limit) > 0) throw new IllegalStateException("limit exceeded");
        System.out.println("credit " + masked() + " " + amount);
    }
}

class MobilePay implements PaymentMethod {
    private final String accountId;

    MobilePay(String accountId) { this.accountId = accountId; }

    @Override
    public void pay(BigDecimal amount) {
        System.out.println("mobile " + accountId + " " + amount);
    }
}

class Checkout {
    public static void main(String[] args) {
        List<PaymentMethod> methods = List.of(
                new CreditCard("4111111111111111", new BigDecimal("5000")),
                new MobilePay("alice@bank"));
        for (PaymentMethod m : methods) {
            m.pay(new BigDecimal("120.50"));   // 실제 타입에 따라 다른 구현 실행
        }
    }
}
```

## 실무에서 걸리는 지점

- **getter/setter 자동 생성은 캡슐화가 아니다.** 모든 필드에 setter를 열면 `public` 필드와 같다. 상태 변경은 `takeDamage`처럼 의도가 드러나는 메서드로 제한한다. Lombok `@Data`를 엔티티에 붙이면 이 원칙이 무너지기 쉽다.
- **`instanceof` 분기가 늘면 다형성을 잃고 있다는 신호다.** 타입별 `if-else`는 새 타입마다 수정 지점이 생기므로 오버라이딩으로 옮긴다. 다만 Java 21의 sealed 타입 + 패턴 매칭 `switch`는 컴파일러가 누락을 검출하므로 예외다.
- **상속 계층이 3단계를 넘으면 컴포지션을 검토한다.** `Stack extends Vector`가 대표적인 표준 라이브러리의 실패 사례다. Spring에서도 공통 로직은 상속보다 위임·AOP로 풀리는 경우가 많다.
- **JIT 워밍업 전 성능으로 판단하지 않는다.** 기동 직후 응답 시간은 정상 상태보다 느리다. ==부하 테스트는 워밍업 이후를 측정하고, 롤링 배포 시 신규 인스턴스에 트래픽을 점진적으로 보낸다.==
- **개발과 운영의 JDK 배포판·버전을 맞춘다.** ==같은 LTS라도 패치에 따라 GC 기본값이나 TLS 동작이 달라진다.== Dockerfile에 정확한 태그를 고정한다.

## 관련 글

- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
- [Modern Java 9~21 핵심](/notes/java-spring/modern-java/)
- [IoC/DI와 ApplicationContext — Bean이란](/notes/java-spring/ioc-di-application-context/)
