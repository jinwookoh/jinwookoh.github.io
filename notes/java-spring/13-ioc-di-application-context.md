---
title: "IoC/DI와 ApplicationContext — Bean이란"
series: java-spring
part: "Spring 코어"
order: 13
summary: "객체 생성과 연결의 책임을 컨테이너로 넘기는 IoC/DI의 원리와, ApplicationContext가 Bean을 다루는 방식을 정리한다."
tags: [Spring, IoC, DI, ApplicationContext, Bean]
sources: [spring/2026-05-16-spring-first-bean-hello.md, spring/2026-05-16-why-dependency-injection.md, spring/2026-05-16-what-is-spring-bean.md, spring/2026-05-16-spring-application-context.md]
updated: 2026-08-29
---

객체가 사용할 다른 객체를 직접 `new`로 만들면 세 가지 문제가 생긴다. `OrderService`가 `new KakaoPayGateway()`를 들고 있으면 결제사를 바꿀 때 `OrderService`를 고쳐야 하고, 가짜 게이트웨이를 끼울 지점이 없어 단위 테스트가 실제 API를 호출하며, 구체 타입을 알아야 하므로 변경이 전파된다. 객체의 생성과 연결을 코드 밖으로 빼낸 것이 IoC이고, Spring에서 그 역할을 맡는 것이 ApplicationContext다.

## 핵심 개념

**IoC(Inversion of Control)** 는 객체의 생성·연결·생명주기를 애플리케이션 코드가 아닌 컨테이너가 관리한다는 원칙이다. **DI(Dependency Injection)** 는 IoC를 구현하는 기법으로, 객체가 의존성을 직접 만들지 않고 외부에서 받도록 한다. IoC는 원칙, DI는 그 실현 방식 중 하나다. DI는 인터페이스와 함께 써야 효과가 난다. `OrderService`가 `PaymentGateway` 인터페이스만 알고 구현체를 생성자로 받으면 교체는 조립하는 쪽에서 결정되고, 테스트에서는 가짜 구현체를 넘기면 된다.

주입 방식은 생성자·세터·필드 세 가지이고 Spring은 생성자 주입을 권장한다. 필드를 `final`로 둘 수 있고, 의존성 누락이 생성 시점에 드러나며, 컨테이너 없이 테스트할 수 있다. 세터 주입은 선택적 의존성에만 쓰고 필드 주입은 피한다. 생성자가 하나면 `@Autowired`를 생략해도 된다.

**Bean**은 컨테이너가 생성하고 관리하는 객체다. 일반 객체와 다를 것은 없고 생명주기의 책임이 컨테이너에 있다는 점만 다르다. 컨테이너는 Bean을 **BeanDefinition** 메타데이터(클래스, 이름, 스코프, 생성자 인자, 프로퍼티, 지연 초기화 여부, 초기화·소멸 메서드)와 함께 보관하며 `@Component` 하나로 시작 시 채운다.

Bean 이름은 기본적으로 클래스명의 첫 글자를 소문자로 바꾼 값이다(`HelloController` → `helloController`). 앞 두 글자가 대문자인 `URLParser`는 그대로 유지된다. `@Component("customName")`으로 지정할 수 있고, 별칭은 `@Bean(name = {"primary", "alias"})`처럼 `@Bean` 메서드에서만 여러 개 줄 수 있다.

기본 스코프는 singleton이다. `getBean`을 여러 번 호출해도 같은 인스턴스가 나오며, `@Scope("prototype")`으로 매번 새 객체를 만들 수도 있다. 생명주기는 인스턴스화 → 의존성 주입 → `@PostConstruct` → 사용 → `@PreDestroy` 순이고, 두 어노테이션은 `jakarta.annotation` 패키지에 있다.

**ApplicationContext**는 IoC 컨테이너의 본체다. `BeanFactory`가 Bean 생성·조회·의존성 해결의 최소 기능을 정의한 부모 인터페이스이고, `ApplicationContext`는 이를 상속해 AOP 통합, 메시지 소스, 이벤트 발행, `Environment`, `Resource` 추상화를 더한다.

| 구분 | BeanFactory | ApplicationContext |
|---|---|---|
| 관계 | 부모 인터페이스 | BeanFactory 상속·확장 |
| singleton 생성 시점 | 첫 조회 시 지연 생성 | 시작 시 사전 생성 |
| AOP·이벤트·국제화·Environment | 없음 | 포함 |
| 실무 사용 | 거의 없음 | 사실상 전부 |

구현체는 Java Config면 `AnnotationConfigApplicationContext`, XML이면 `ClassPathXmlApplicationContext`, 웹 앱이면 Spring Boot가 `WebApplicationContext` 구현체를 자동으로 띄우고 `SpringApplication.run()`이 이를 반환한다. 시작 흐름은 컨텍스트 생성 → `@Configuration` 로드 → 컴포넌트 스캔 → BeanDefinition 등록 → singleton 생성·주입·`@PostConstruct` → refresh 완료 → 내장 서버 기동 순이다.

## 코드

인터페이스에 의존하고 생성자로 구현체를 받는 DI 형태.

```java
package com.example.shop.order;

import org.springframework.stereotype.Service;

public interface PaymentGateway {
    void pay(long amount);
}

@Service
public class OrderService {

    private final PaymentGateway paymentGateway;

    public OrderService(PaymentGateway paymentGateway) {
        this.paymentGateway = paymentGateway;
    }

    public void placeOrder(long amount) {
        paymentGateway.pay(amount);
    }
}
```

HTTP 요청을 받는 컨트롤러 Bean. `@RestController`는 `@Controller`와 `@ResponseBody`를 합친 것이다.

```java
package com.example.shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {

    @GetMapping("/hello")
    public String hello() {
        return "Hello, Spring";
    }
}
```

컨텍스트에서 Bean을 꺼내 singleton 동작을 확인하는 예제.

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ApplicationContext;

@SpringBootApplication
public class ShopApplication {

    public static void main(String[] args) {
        ApplicationContext context = SpringApplication.run(ShopApplication.class, args);

        HelloController byType = context.getBean(HelloController.class);
        HelloController byName = context.getBean("helloController", HelloController.class);
        System.out.println(byType == byName);                       // true
        System.out.println(context.getBeanDefinitionNames().length); // 등록된 Bean 수
    }
}
```

## 실무에서 걸리는 지점

- **singleton Bean의 인스턴스 필드는 공유 상태다.** 요청별 값을 필드로 두면 모든 스레드가 같은 객체를 쓰므로 데이터가 섞인다. 요청 단위 상태는 지역 변수로 다룬다.
- **순환 참조는 구조 문제다.** 생성자 주입은 순환 의존성을 기동 시점에 드러내며, Spring Boot 2.6부터 기본 금지다. `@Lazy`로 우회하기보다 의존 방향을 고친다.
- **같은 타입의 Bean이 둘 이상이면 주입이 모호해진다.** `NoUniqueBeanDefinitionException`이 나면 `@Primary`나 `@Qualifier`로 대상을 지정한다.
- **`getBean` 직접 호출은 IoC를 되돌린다.** 실행 시점에 구현체를 골라야 하면 `Map<String, PaymentGateway>` 주입을 쓴다.
- **스캔 범위 밖의 클래스는 조용히 빠진다.** 스캔 시작점은 `@SpringBootApplication` 클래스의 패키지이므로, 상위나 형제 패키지의 `@Service`는 주입 시점의 `NoSuchBeanDefinitionException`으로만 드러난다.

## 관련 글

- /notes/java-spring/spring-framework-boot-autoconfig/
- /notes/java-spring/bean-registration-injection/
- /notes/java-spring/bean-scope-lifecycle/
