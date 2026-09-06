---
title: "전략 — if-else 분기를 교체 가능한 알고리즘으로"
series: design-patterns
part: "행위"
order: 12
summary: "알고리즘 분기를 인터페이스 뒤로 옮기고, 서버가 전략을 고르는 세 가지 방식의 차이를 정리한다"
tags: [Strategy, OCP, Spring, EnumMap, supports]
sources: [https://jinwookoh.tistory.com/205]
updated: 2026-09-06
---

결제 수단, 할인 정책, 배송비 계산처럼 입력 종류에 따라 알고리즘이 달라지는 로직은 대개 if-else나 switch로 시작한다. 분기가 셋을 넘기면 한 메서드에 서로 무관한 알고리즘이 섞이고, 결제 수단 하나를 추가할 때마다 검증이 끝난 기존 코드를 열어 수정해야 한다. 같은 분기 조건이 여러 메서드에 복제되면 한 곳만 고쳐지는 사고가 따라온다. 전략 패턴은 각 알고리즘을 같은 인터페이스를 구현한 별도 객체로 분리하고, 사용하는 쪽은 인터페이스에만 의존하게 해 새 알고리즘 추가가 기존 코드 수정 없이 끝나도록 만든다.

## 핵심 개념

구성 요소는 넷이다. 공통 인터페이스인 **Strategy**, 알고리즘을 담은 **Concrete Strategy**, 전략을 보관하고 호출을 위임하는 **Context**, 어떤 전략을 쓸지 결정하는 **Client**다. Context는 전략의 구체 타입을 모르고, 전략은 Context의 내부를 모른다. 상속 대신 합성으로 행동을 갈아 끼우므로 런타임에 교체할 수 있고, 각 전략을 독립적으로 단위 테스트할 수 있다.

GoF 원형은 Client가 전략을 직접 골라 Context에 주입한다. 그러나 웹 애플리케이션에서는 클라이언트가 `paymentType=KAKAO` 같은 데이터만 보내고 서버가 전략을 찾아야 하는 경우가 대부분이다. 이 선택 단계를 어디에 두느냐에 따라 구현이 갈린다.

| 방식 | 선택 주체 | 조회 비용 | 적합한 상황 |
|:---|:---|:---|:---|
| 직접 주입 | Client | 없음 | 상태에 따라 행동이 바뀌는 객체 |
| supports 판별 | 전략 자신 | O(n) 순회 | 금액 범위·시간대 등 조건이 복합적일 때 |
| Map 레지스트리 | 키 매칭 | O(1) | 문자열·enum 키가 명확할 때 |
| Enum 상수 | 상수 자체 | 없음 | 로직이 짧고 외부 의존이 없을 때 |

supports 방식은 Spring Security의 `AuthenticationProvider.supports(Class)`가 쓰는 구조다. 선택 규칙이 각 전략 안에 있으므로 새 전략을 추가할 때 Context를 건드리지 않는다. Map 방식은 Spring이 `Map<String, PaymentStrategy>`를 주입할 때 빈 이름을 키로 채워 주는 점을 이용하면 등록 코드 없이도 레지스트리가 만들어지지만, 빈 이름과 도메인 키가 결합되므로 enum 키로 직접 만드는 편이 안전하다. 전략 인터페이스가 메서드 하나면 별도 클래스 없이 람다나 메서드 참조로 전략을 만들 수 있으며, `Comparator`를 받는 `List.sort`가 표준 라이브러리에 있는 전략 패턴이다.

## 코드

GoF 원형이다. Context가 전략을 합성으로 보관하고 호출을 위임하며, 인터페이스가 메서드 하나이므로 람다로 전략을 만든다.

```java
public interface MoveStrategy {
    void move();
}

public final class Robot {
    private MoveStrategy moveStrategy;

    public Robot(MoveStrategy moveStrategy) {
        this.moveStrategy = moveStrategy;
    }

    public void changeStrategy(MoveStrategy moveStrategy) {
        this.moveStrategy = moveStrategy;
    }

    public void move() {
        moveStrategy.move();
    }
}

Robot robot = new Robot(() -> System.out.println("walk"));
robot.move();
robot.changeStrategy(() -> System.out.println("fly"));
robot.move();
```

Spring Boot에서 전략을 빈으로 등록하고 supports로 고르는 형태다. 같은 타입의 빈을 `List`로 주입받으면 구현체 전부가 담긴다.

```java
public interface PaymentStrategy {
    PaymentType type();
    boolean supports(PaymentType type);
    PaymentResult pay(long amount);
}

@Component
public class KakaoPayStrategy implements PaymentStrategy {
    @Override
    public PaymentType type() { return PaymentType.KAKAO; }

    @Override
    public boolean supports(PaymentType type) { return type == PaymentType.KAKAO; }

    @Override
    public PaymentResult pay(long amount) {
        // 카카오페이 API 호출
        return PaymentResult.ok();
    }
}

@Service
public class PaymentService {
    private final List<PaymentStrategy> strategies;

    public PaymentService(List<PaymentStrategy> strategies) {
        this.strategies = List.copyOf(strategies);
    }

    public PaymentResult process(PaymentType type, long amount) {
        return strategies.stream()
                .filter(s -> s.supports(type))
                .findFirst()
                .orElseThrow(() -> new UnsupportedPaymentException(type))
                .pay(amount);
    }
}
```

키가 명확할 때는 생성자에서 `EnumMap`을 한 번 만들어 O(1)로 조회한다. 중복 등록과 누락을 기동 시점에 잡는다.

```java
@Service
public class PaymentService {
    private final Map<PaymentType, PaymentStrategy> registry;

    public PaymentService(List<PaymentStrategy> strategies) {
        Map<PaymentType, PaymentStrategy> map = new EnumMap<>(PaymentType.class);
        for (PaymentStrategy s : strategies) {
            if (map.putIfAbsent(s.type(), s) != null) {
                throw new IllegalStateException("duplicate strategy: " + s.type());
            }
        }
        for (PaymentType t : PaymentType.values()) {
            if (!map.containsKey(t)) {
                throw new IllegalStateException("missing strategy: " + t);
            }
        }
        this.registry = Collections.unmodifiableMap(map);
    }

    public PaymentResult process(PaymentType type, long amount) {
        return registry.get(type).pay(amount);
    }
}
```

Enum 방식은 상수마다 추상 메서드를 구현한다. 파일이 늘지 않지만 전략이 외부 빈을 주입받을 수 없다.

```java
public enum Calculator {
    PLUS {
        @Override
        int calculate(int a, int b) { return a + b; }
    },
    MINUS {
        @Override
        int calculate(int a, int b) { return a - b; }
    };

    abstract int calculate(int a, int b);
}
```

## 실무에서 걸리는 지점

- **누락된 전략이 첫 요청에서야 드러난다.** ==`Map.get`의 null을 검사하지 않으면 enum에 상수만 추가하고 구현체를 빠뜨린 배포가 기동에는 성공하고 첫 결제 요청에서 NullPointerException으로 실패한다.== 조회 실패는 도메인 예외로 바꾸고, 위 코드처럼 기동 시점에 상수 전부의 등록 여부를 검증한다.
- **supports가 둘 이상 참이면 결과가 빈 순서에 좌우된다.** `findFirst`는 `List` 주입 순서를 따르고, 그 순서는 명시하지 않으면 클래스패스 스캔 순서에 의존한다. ==우선순위가 의미 있는 전략 목록은 `@Order`로 순서를 고정하고, 조건이 겹치지 않도록 supports를 상호 배타적으로 설계한다.==
- **전략 빈에 요청 데이터를 저장하면 동시 요청 간에 섞인다.** ==전략은 싱글톤 빈이므로 필드에 금액이나 사용자 식별자를 두면 다른 스레드의 값이 읽힌다.== 필요한 데이터는 전부 메서드 파라미터로 넘기고 전략은 무상태로 유지한다.
- **Setter 교체는 공유 객체에서 안전하지 않다.** GoF 원형처럼 Context의 전략을 런타임에 바꾸는 설계는 단일 스레드에서만 성립한다. 여러 스레드가 쓰는 객체라면 전략을 생성자로 고정하거나 요청마다 전략을 인자로 받는 형태로 바꾼다.
- **전략 안에서 분기가 다시 자라면 선택 축이 잘못 잡힌 것이다.** 구현체 내부에 금액과 등급을 조합한 if문이 늘어나면 축이 둘 이상이라는 신호다. 전략을 조합하거나 책임 연쇄로 나눈다.

## 관련 글

- [상태 — 상태별 분기를 객체로 옮기기](/notes/design-patterns/state/)
- [템플릿 메서드 — 골격은 고정하고 단계만 바꾸기](/notes/design-patterns/template-method/)
- [책임 연쇄 — 핸들러를 사슬로 엮어 순차 처리](/notes/design-patterns/chain-of-responsibility/)
