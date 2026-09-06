---
title: "의존성 주입 — 필드·생성자·세터 주입의 차이"
series: design-patterns
part: "확장"
order: 24
summary: "생성자 주입은 불변성·컴파일 시점 검증·순환 참조 조기 감지를 보장하고, 필드 주입은 컨테이너 없이는 객체를 완성할 수 없다."
tags: [Dependency Injection, Constructor Injection, Autowired, Spring, Lombok]
sources: [https://jinwookoh.tistory.com/228]
updated: 2026-09-06
---

객체 A가 객체 B를 사용하려면 누군가 B의 인스턴스를 만들어 A에 건네야 한다. A가 직접 `new B()`를 호출하면 A는 B의 구체 클래스와 생성 방법까지 알게 되고, B를 다른 구현으로 바꾸거나 테스트에서 가짜 객체로 대체하려면 A의 코드를 고쳐야 한다. B가 DB 커넥션이나 외부 API 클라이언트를 필요로 하면 A는 그 설정까지 떠안는다. 의존성 주입은 이 생성 책임을 외부로 옮겨, A는 B의 인터페이스만 알고 인스턴스는 밖에서 받도록 만든다. Spring 같은 컨테이너는 이 "밖"의 역할을 맡아 빈을 생성하고 연결하는데, 어느 지점에서 주입받느냐에 따라 객체의 불변성·테스트 방법·오류가 드러나는 시점이 달라진다.

## 핵심 개념

의존성 주입 방식은 세 가지다. 필드 주입은 멤버 변수에 `@Autowired`를 붙이고 컨테이너가 리플렉션으로 값을 넣는다. 세터 주입은 `setXxx` 메서드에 `@Autowired`를 붙여 객체 생성 후 메서드 호출로 넣는다. 생성자 주입은 생성자 파라미터로 받으며, Spring 4.3부터 생성자가 하나면 `@Autowired`를 생략할 수 있다.

세 방식의 차이는 객체가 완성되는 시점에 있다. 생성자 주입은 생성자가 끝나는 순간 모든 의존성이 채워져 있고, 필드를 `final`로 선언할 수 있다. 필드 주입과 세터 주입은 기본 생성자로 객체를 먼저 만든 뒤 나중에 값을 채우므로, 그 사이에는 의존성이 `null`인 상태가 존재한다. 컨테이너 안에서는 이 간격이 문제되지 않지만, 컨테이너 없이 `new`로 만든 객체는 의존성이 영원히 `null`이다. `@Autowired` 필드는 `final`로 선언할 수 없으므로 언어 차원의 불변성 보장도 포기하게 된다.

| 구분 | 필드 주입 | 세터 주입 | 생성자 주입 |
|---|---|---|---|
| 불변성 | 불가 | 불가 | `final` 가능 |
| 의존성 누락 | 실행 시 `NullPointerException` | 실행 시 `NullPointerException` | 컴파일 오류 |
| 컨테이너 없는 테스트 | 리플렉션 필요 | 세터 호출 | `new`로 직접 생성 |
| 선택적 의존성 | `required = false` | `required = false` | `Optional<T>`, `ObjectProvider<T>` |
| 순환 참조 | 기동 시 실패 | 기동 시 실패 | 기동 시 실패 |

순환 참조 항목은 원래 방식마다 달랐다. Spring Boot 2.5까지는 필드·세터 주입으로 연결된 싱글톤 사이의 순환 참조를 미완성 빈 참조로 허용했고, 생성자 주입만 `BeanCurrentlyInCreationException`으로 기동 시 실패했다. Spring Boot 2.6부터 `spring.main.allow-circular-references` 기본값이 `false`가 되어 방식에 관계없이 기동 시 실패한다. 생성자 주입은 이 설정과 무관하게 항상 실패하므로, 설계상의 순환을 가장 이른 시점에 드러낸다.

세터 주입이 여전히 의미 있는 경우는 의존성이 선택적이고 실행 중 교체가 필요할 때뿐이다. 그 밖의 경우 public 세터는 외부에서 언제든 의존성을 바꿔치기할 수 있는 통로가 된다.

## 코드

생성자 주입. 생성자가 하나이므로 `@Autowired`가 없어도 Spring이 이 생성자를 사용한다.

```java
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final MemberRepository memberRepository;
    private final PaymentClient paymentClient;

    public OrderService(MemberRepository memberRepository, PaymentClient paymentClient) {
        this.memberRepository = memberRepository;
        this.paymentClient = paymentClient;
    }

    public void createOrder(Long memberId, long amount) {
        var member = memberRepository.findById(memberId).orElseThrow();
        paymentClient.charge(member, amount);
    }
}
```

Lombok의 `@RequiredArgsConstructor`는 `final` 필드만 골라 위와 같은 생성자를 생성한다. 선택적 의존성은 `ObjectProvider`로 받아 빈이 없을 때의 동작을 코드 안에서 결정한다.

```java
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class OrderService {

    private final MemberRepository memberRepository;
    private final ObjectProvider<AuditLogger> auditLogger;

    public void createOrder(Long memberId, long amount) {
        var member = memberRepository.findById(memberId).orElseThrow();
        auditLogger.ifAvailable(logger -> logger.record("order", memberId));
    }
}
```

컨테이너 없이 단위 테스트를 작성하는 예. 생성자에 Mockito 목을 직접 넣으므로 Spring 컨텍스트가 필요 없다.

```java
import static org.mockito.Mockito.*;

import java.util.Optional;
import org.junit.jupiter.api.Test;

class OrderServiceTest {

    @Test
    void createOrder_chargesMember() {
        MemberRepository repo = mock(MemberRepository.class);
        PaymentClient client = mock(PaymentClient.class);
        when(repo.findById(1L)).thenReturn(Optional.of(new Member(1L)));

        var service = new OrderService(repo, client);
        service.createOrder(1L, 10_000);

        verify(client).charge(any(Member.class), eq(10_000L));
    }
}
```

## 실무에서 걸리는 지점

- 필드 주입 클래스를 `new`로 만들어 테스트하면 컴파일은 통과하고 실행 시점에 `NullPointerException`이 난다. Mockito의 `@InjectMocks`나 `ReflectionTestUtils.setField`로 우회할 수 있지만 필드 이름에 묶인 테스트가 되어 리팩터링에 취약하다. ==`@SpringBootTest` 테스트 클래스에서만 필드 주입을 허용하고 프로덕션 코드에서는 생성자 주입으로 통일한다.==
- 생성자 파라미터가 6~7개를 넘기면 그 클래스가 여러 책임을 지고 있다는 신호다. 필드 주입은 이 신호를 숨기고, 생성자 주입은 생성자 시그니처로 드러낸다. 파라미터를 줄이려고 필드 주입으로 돌아가는 대신 클래스를 분리한다.
- 순환 참조를 `@Lazy`로 끊으면 기동은 성공하지만 프록시가 실제 빈을 처음 호출하는 시점으로 문제가 미뤄진다. ==`@Lazy`로 가린 순환은 프로덕션에서 첫 요청이 들어올 때 터지므로, 순환이 발견되면 이벤트 발행이나 공통 의존성 추출로 구조를 고친다.== `allow-circular-references=true`로 되돌리는 것은 같은 문제를 전역으로 확장하는 선택이다.
- `@Autowired` 필드나 세터로 받은 의존성은 `final`이 아니므로 다른 스레드가 값을 바꿀 수 있고, 생성자 완료 이후 값이 채워지므로 Java 메모리 모델의 `final` 필드 초기화 보장을 받지 못한다. 싱글톤 빈이 여러 스레드에서 쓰인다는 점을 고려하면 생성자 주입이 안전하다.
- JUnit 5 테스트 클래스에서 생성자 주입을 쓰려면 `@TestConstructor(autowireMode = ALL)`을 붙이거나 `spring.test.constructor.autowire.mode=all` 속성을 설정해야 한다. ==이 설정 없이 테스트 클래스에 생성자를 선언하면 `ParameterResolutionException`으로 테스트가 시작조차 되지 않는다.==

## 관련 글

- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
- [팩토리 — Simple Factory·Factory Method·Abstract Factory](/notes/design-patterns/factory/)
- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
