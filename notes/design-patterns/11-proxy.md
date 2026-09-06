---
title: "프록시 — 접근 제어·지연 로딩·Spring 동적 프록시"
series: design-patterns
part: "구조"
order: 11
summary: "실제 객체와 같은 인터페이스를 가진 대리 객체로 생성 시점과 접근을 제어하며, Spring은 이를 런타임에 자동 생성해 AOP를 구현한다"
tags: [Proxy, Dynamic Proxy, Spring AOP, CGLIB, JPA]
sources: [https://jinwookoh.tistory.com/209]
updated: 2026-09-06
---

객체를 직접 참조하면 호출자가 생성 시점, 접근 권한, 부가 처리를 모두 떠안는다. 생성 비용이 큰 객체는 실제로 쓰이기 전부터 메모리를 점유하고, 권한 검사나 로깅은 호출하는 쪽마다 반복되며, 원격 서비스 호출 코드가 비즈니스 로직에 섞인다. 호출자가 인터페이스만 보고 나머지를 잊게 하려면 대상과 같은 인터페이스를 구현한 대리 객체를 사이에 두고, 생성·검사·전달을 그 객체에 맡겨야 한다. 이것이 프록시 패턴이다.

## 핵심 개념

프록시는 실제 객체(Subject)와 같은 인터페이스를 구현하고 내부에 실제 객체 참조를 보유한다. 클라이언트는 인터페이스 타입으로만 호출하므로 상대가 프록시인지 실제 객체인지 구분하지 못한다. 데코레이터와 클래스 구조가 같지만 목적이 다르다. 데코레이터는 기능을 덧붙이는 것이 목적이고 여러 겹의 조합을 클라이언트가 결정하지만, 프록시는 접근을 제어하는 것이 목적이고 실제 객체의 생성과 수명을 프록시가 결정한다.

목적에 따라 다음과 같이 나뉜다.

| 종류 | 목적 | 대표 사례 |
|---|---|---|
| 가상 프록시 | 생성 비용이 큰 객체를 첫 사용 시점까지 미룸 | JPA `FetchType.LAZY`, 이미지 미리보기 |
| 보호 프록시 | 호출자의 권한을 검사한 뒤 위임 | 인가 검사, Spring Security 메서드 보안 |
| 원격 프록시 | 로컬 객체처럼 보이지만 실제로는 네트워크 호출 | gRPC 스텁, Spring HTTP Interface 클라이언트 |
| 동적 프록시 | 프록시 클래스를 런타임에 자동 생성 | Spring AOP, `@Transactional`, Mockito |

정적 프록시는 인터페이스의 모든 메서드를 손으로 위임해야 한다. 메서드가 추가되면 프록시도 고쳐야 하고, 횡단 관심사 하나마다 프록시 클래스가 하나씩 생긴다. 동적 프록시는 이 문제를 없앤다. JDK는 `java.lang.reflect.Proxy`로 인터페이스 기반 프록시 클래스를 런타임에 만들고, 모든 호출을 `InvocationHandler.invoke` 한 곳으로 모은다. 인터페이스가 없는 클래스는 CGLIB이 대상 클래스를 상속한 서브클래스를 바이트코드로 생성한다. Spring Boot는 기본값 `proxyTargetClass=true`로 인터페이스 유무와 관계없이 CGLIB 방식을 쓴다. ==CGLIB 프록시는 대상 클래스를 상속하므로 클래스가 final이면 프록시 생성 자체가 실패하고, 메서드가 final이면 그 메서드에만 AOP가 적용되지 않은 채 경고 로그 한 줄로 넘어간다.==

## 코드

가상 프록시. 실제 이미지 로딩을 `display()` 첫 호출까지 미룬다.

```java
public interface Image {
    void display();
}

public final class RealImage implements Image {
    private final String fileName;

    public RealImage(String fileName) {
        this.fileName = fileName;
        System.out.println("loading " + fileName);
    }

    @Override
    public void display() {
        System.out.println("display " + fileName);
    }
}

public final class ProxyImage implements Image {
    private final String fileName;
    private RealImage realImage;

    public ProxyImage(String fileName) {
        this.fileName = fileName;
    }

    @Override
    public void display() {
        if (realImage == null) {
            realImage = new RealImage(fileName);
        }
        realImage.display();
    }
}
```

보호 프록시. 역할을 검사하고 통과한 호출만 실제 서비스에 위임한다.

```java
public interface EmployeeService {
    String find(long id);
    void modify(long id, String name);
}

public final class EmployeeServiceProxy implements EmployeeService {
    private final EmployeeService target;
    private final Set<String> roles;

    public EmployeeServiceProxy(EmployeeService target, Set<String> roles) {
        this.target = target;
        this.roles = Set.copyOf(roles);
    }

    @Override
    public String find(long id) {
        return target.find(id);
    }

    @Override
    public void modify(long id, String name) {
        if (!roles.contains("ADMIN")) {
            throw new AccessDeniedException("ADMIN role required");
        }
        target.modify(id, name);
    }
}
```

JDK 동적 프록시. 인터페이스만 주면 호출 시간을 기록하는 프록시 인스턴스를 런타임에 만든다.

```java
public final class TimingHandler implements InvocationHandler {
    private final Object target;

    public TimingHandler(Object target) {
        this.target = target;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        long start = System.nanoTime();
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        } finally {
            System.out.printf("%s %dus%n", method.getName(), (System.nanoTime() - start) / 1_000);
        }
    }
}

EmployeeService service = (EmployeeService) Proxy.newProxyInstance(
        EmployeeService.class.getClassLoader(),
        new Class<?>[] { EmployeeService.class },
        new TimingHandler(new JpaEmployeeService()));
service.find(1L);
```

Spring에서는 `@Transactional`이 붙은 빈이 같은 원리로 프록시에 감싸여 컨테이너에 등록되고, 프록시가 메서드 앞뒤에서 트랜잭션을 시작·커밋·롤백한다. 주입받는 쪽이 받는 참조는 원본이 아니라 이 프록시다.

## 실무에서 걸리는 지점

- **자기 호출에는 프록시가 개입하지 않는다.** 같은 클래스 안에서 `this.method()`로 `@Transactional`·`@Cacheable`·`@Async` 메서드를 부르면 프록시를 거치지 않고 대상 객체를 직접 호출한다. ==내부 호출된 `@Transactional` 메서드는 트랜잭션 없이 실행되며 예외도 경고도 없이 조용히 넘어간다.== 해당 로직을 별도 빈으로 분리하거나 자기 자신을 주입받아 호출한다.
- **JPA 지연 로딩 프록시는 영속성 컨텍스트가 닫히면 초기화할 수 없다.** 트랜잭션 밖에서 LAZY 연관 필드에 접근하면 `LazyInitializationException`이 발생한다. `open-in-view`를 켜서 넘기면 컨트롤러 계층까지 DB 커넥션이 잡혀 있어 커넥션 풀 고갈로 이어진다. 필요한 연관은 fetch join이나 `@EntityGraph`로 명시적으로 가져온다.
- **프록시 객체는 `getClass()` 결과가 원본과 다르다.** CGLIB 프록시의 클래스는 `$$SpringCGLIB$$` 접미사가 붙은 서브클래스이고, JDK 프록시는 인터페이스만 구현하므로 구현 클래스 타입으로 캐스팅하면 `ClassCastException`이 난다. 원본 타입은 `AopUtils.getTargetClass`나 `Hibernate.getClass`로 얻는다. ==엔티티의 `equals`를 `getClass()` 비교로 구현하면 Hibernate 프록시와 실제 엔티티가 같은 행을 가리켜도 다르다고 판정된다.==
- **JDK 프록시는 대상의 예외를 `InvocationTargetException`으로 감싼다.** `invoke` 안에서 이를 풀지 않고 전파하면 호출자는 원래 예외 대신 `UndeclaredThrowableException`을 받고, 예외 타입으로 분기하는 `@Transactional(rollbackFor)` 같은 설정이 의도와 다르게 동작한다. `getCause()`로 풀어서 다시 던진다.
- **프록시 생성 비용과 스택 깊이.** 프록시 클래스 생성은 기동 시 한 번이지만, 빈 수천 개 대부분에 AOP가 걸리면 기동 시간이 눈에 띄게 늘어난다. 호출 시점 오버헤드는 JIT 이후 무시할 수준이나, 트랜잭션·캐시·보안 프록시가 여러 겹 쌓인 빈은 스택 트레이스가 수십 프레임씩 길어져 장애 분석이 느려진다.

## 관련 글

- [데코레이터 — 상속 없이 기능을 겹겹이 추가](/notes/design-patterns/decorator/)
- [의존성 주입 — 필드·생성자·세터 주입의 차이](/notes/design-patterns/dependency-injection/)
- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
