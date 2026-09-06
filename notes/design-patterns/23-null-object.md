---
title: "널 객체 — null 검사 대신 아무것도 안 하는 객체"
series: design-patterns
part: "확장"
order: 23
summary: "없는 값을 null 대신 기본 행동을 가진 객체로 돌려주면 호출부의 null 검사가 사라지고, 단순 조회는 Optional로 충분하다."
tags: [Null Object, Optional, NullPointerException, Polymorphism, Spring Security]
sources: [https://jinwookoh.tistory.com/227]
updated: 2026-09-06
---

조회 메서드가 결과가 없을 때 null을 돌려주면, 그 값을 쓰는 모든 호출부가 null 검사를 떠안는다. 고객 등급을 읽는 코드가 100곳이면 `if (customer != null)`도 100번 반복되고, 그중 한 곳만 빠져도 NullPointerException이 운영 중에 발생한다. 검사가 있더라도 else 분기의 처리 방식이 호출부마다 달라져 없는 고객을 어떻게 다룰지가 코드 곳곳에 흩어진다. 널 객체 패턴은 값을 돌려주는 쪽이 null 대신 아무것도 하지 않거나 기본값을 돌려주는 객체를 반환해, 부재 시의 행동을 한곳에 모으고 호출부에서 분기를 없앤다.

## 핵심 개념

널 객체는 실제 객체와 같은 인터페이스를 구현하는 클래스다. 메서드는 부수 효과 없이 끝나거나, 빈 컬렉션·0·기본 문자열 같은 중립값을 돌려준다. 호출부는 받은 객체가 실제인지 널 객체인지 구분하지 않고 같은 메서드를 호출하며, 다형성이 분기를 대신한다. null 대신 널 객체를 돌려주는 책임은 팩토리나 리포지토리처럼 객체를 만들어 내는 쪽이 진다. 호출부가 직접 널 객체를 만들어 대입하는 구조라면 패턴의 이점이 거의 없다.

널 객체는 상태를 갖지 않으므로 인스턴스 하나를 고정해 공유하는 편이 맞다. 매번 new로 만들면 동일성 비교가 깨지고 불필요한 할당이 생긴다. `isNull()` 같은 식별 메서드를 인터페이스에 두는 설계도 있으나, 호출부가 그 메서드로 분기하기 시작하면 null 검사가 이름만 바뀐 채 되돌아온다. 식별이 반복해서 필요하다면 그 자리에는 널 객체가 아니라 명시적인 부재 표현이 맞다.

표준 라이브러리와 프레임워크에는 이미 널 객체가 여럿 들어 있다. `Collections.emptyList()`는 원소가 없는 불변 리스트로 순회 코드가 빈 경우를 따로 다루지 않게 하고, SLF4J의 NOPLogger는 바인딩이 없을 때 모든 로그 호출을 무시한다. Spring Security의 익명 인증(AnonymousAuthenticationToken)은 로그인하지 않은 요청에도 Authentication 객체를 채워, 권한 검사 코드가 인증 객체의 null 여부를 보지 않아도 되게 한다. Spring Cache의 NoOpCacheManager는 캐시를 끈 환경에서 @Cacheable이 붙은 코드를 수정 없이 그대로 돌게 한다.

Java 8 이후의 Optional은 같은 문제를 다른 방향에서 푼다. 널 객체가 없어도 있는 것처럼 행동하라는 쪽이라면, Optional은 없을 수 있으니 꺼낼 때 처리하라를 반환 타입으로 강제한다. 별도 클래스를 만들지 않고 `map`·`orElse`·`orElseThrow`로 부재를 처리하므로 값 하나를 조회해 넘기는 경우에는 Optional이 간결하다. 반대로 부재 시에도 여러 메서드가 일관된 행동을 해야 하는 도메인 객체(비로그인 사용자, 미설정 알림 채널)는 Optional을 호출부마다 풀어 쓰는 것보다 널 객체 하나가 낫다. 둘은 배타적이지 않다. 리포지토리는 Optional을 돌려주고 서비스 경계에서 `orElse(NullCustomer.INSTANCE)`로 널 객체로 바꾸는 조합이 흔하다.

| 구분 | 널 객체 | Optional |
|---|---|---|
| 형태 | 인터페이스 구현 클래스 | 제네릭 래퍼 |
| 부재 처리 위치 | 객체 내부(기본 행동) | 호출부(체이닝) |
| 적합한 경우 | 부재 시 행동이 정해진 도메인 객체 | 단순 조회 반환값 |
| 비용 | 클래스 추가, 인터페이스 변경 시 동반 수정 | 래퍼 할당, 반환 타입 외 사용 부적합 |

## 코드

고객 인터페이스와 널 객체다. 널 객체는 상태가 없으므로 enum 상수 하나로 만들어 인스턴스를 고정한다.

```java
public interface Customer {
    String name();
    String grade();
    int discountRate();
    void notify(String message);
}

public record RealCustomer(String name, String grade, int discountRate,
                           Notifier notifier) implements Customer {
    @Override
    public void notify(String message) {
        notifier.send(name, message);
    }
}

public enum NullCustomer implements Customer {
    INSTANCE;

    @Override public String name() { return "guest"; }
    @Override public String grade() { return "BASIC"; }
    @Override public int discountRate() { return 0; }
    @Override public void notify(String message) { }
}
```

리포지토리는 Optional을 돌려주고, 서비스 경계에서 널 객체로 바꾼다. 가격 계산 로직은 null도 Optional도 보지 않는다.

```java
@Service
public class CustomerService {
    private final CustomerRepository repository;
    private final Notifier notifier;

    public CustomerService(CustomerRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }

    public Customer find(String name) {
        return repository.findByName(name)
                .<Customer>map(e -> new RealCustomer(
                        e.getName(), e.getGrade(), e.getDiscountRate(), notifier))
                .orElse(NullCustomer.INSTANCE);
    }

    public long finalPrice(String name, long price) {
        Customer customer = find(name);
        customer.notify("가격 조회");
        return price * (100 - customer.discountRate()) / 100;
    }
}
```

프레임워크가 제공하는 널 객체를 프로필로 갈아 끼우는 예다. 로컬에서는 NoOpCacheManager가 모든 캐시 호출을 무시하므로 @Cacheable이 붙은 서비스 코드를 바꿀 필요가 없다.

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    @Profile("local")
    CacheManager noOpCacheManager() {
        return new NoOpCacheManager();
    }

    @Bean
    @Profile("!local")
    CacheManager caffeineCacheManager() {
        return new CaffeineCacheManager("customer");
    }
}
```

## 실무에서 걸리는 지점

- 오류를 삼킨다. 데이터 부재가 버그이거나 정합성 문제인 상황에서 널 객체를 돌려주면 예외 대신 기본값이 조용히 흘러간다. ==결제·정산처럼 없음이 곧 오류인 경로에서 널 객체를 쓰면 할인율 0·잔액 0이 정상 결과처럼 저장되어 사후에 찾기 어렵다.== 이런 경로는 orElseThrow로 즉시 실패시킨다.
- 영속 계층으로 흘러간다. ==NullCustomer를 그대로 저장하거나 연관 관계에 대입하면 guest 고객이 실제 레코드로 생성된다.== 널 객체는 조회·표현 계층에서만 쓰고, 저장 경계 한 곳에서 실제 객체인지 확인한다.
- 인터페이스가 커진다. 인터페이스에 메서드가 추가될 때마다 널 객체도 같이 수정해야 하고, 인터페이스가 넓어질수록 아무것도 하지 않는 동작이 무엇인지 애매한 메서드가 늘어난다. 기본 동작이 자명하지 않으면 널 객체 대신 명시적 예외를 택한다.
- Optional 오용. ==Optional을 필드·생성자 파라미터·컬렉션 원소로 쓰면 직렬화 실패와 Optional 자체가 null인 이중 부재가 생긴다.== 반환 타입에만 쓴다. `isPresent()` 뒤 `get()`은 null 검사와 다를 바 없으므로 map·orElse 체인으로 바꾼다.
- JPA 프록시와 혼동. `findById`는 Optional을 돌려주지만 `getReferenceById`는 지연 로딩 프록시를 돌려주며, 존재하지 않는 id면 필드에 처음 접근하는 시점에 EntityNotFoundException이 난다. 프록시를 널 객체처럼 다루면 트랜잭션 밖 엉뚱한 위치에서 예외가 나타난다.

## 관련 글

- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
- [상태 — 상태별 분기를 객체로 옮기기](/notes/design-patterns/state/)
