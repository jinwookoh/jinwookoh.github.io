---
title: "Modern Java 9~21 핵심"
series: java-spring
part: "자바 기초·모던 자바"
order: 6
summary: "Java 9~21에서 실무 코드를 바꾼 언어·API 변화를 LTS 기준으로 묶어 정리한다"
tags: [Java 21, Record, Sealed Classes, Pattern Matching, var]
sources: [2026-05-03-java-fp-modern.md, 2026-05-03-java-fp-virtual-threads.md]
updated: 2026-08-29
---

Java 8 문법에 머문 코드는 불변 데이터 클래스 하나에 생성자·getter·equals·hashCode·toString을 손으로 쓰고, `instanceof` 뒤에 같은 타입으로 다시 캐스팅하고, `switch`에서 `break`를 빠뜨려 fall-through 버그를 만든다. 상속 계층에 새 타입이 추가됐을 때 누락된 분기를 컴파일러가 잡지 못하는 것도 같은 문제다. ==Java 9~21의 언어 변화는 이 보일러플레이트와 런타임 실수를 컴파일 시점으로 끌어오는 방향이다.==

## 핵심 개념

버전은 LTS 단위로 묶는다. 9~10은 11(LTS)에, 12~16은 17(LTS)에, 18~20은 21(LTS)에 정착했다. 미리보기 기능은 정식 버전 기준으로 기억한다. Switch 표현식 14, 텍스트 블록 15, Record·instanceof 패턴 16, Sealed 17, Record Patterns·Switch 패턴 매칭·Virtual Thread 21이다.

**Java 9~11 — API 정비.** `List.of`·`Set.of`·`Map.of`는 불변 컬렉션을 만들며 요소·키·값 어디에도 `null`을 허용하지 않는다. `Stream.iterate`에 종료 조건 오버로드가 추가됐고 `takeWhile`·`dropWhile`은 정렬된 스트림을 조건으로 자른다. Java 10의 `var`는 지역 변수·for 변수·try-with-resources에서만 타입을 추론하며, 초기화 없이 선언하거나 `null`로만 초기화하면 컴파일 오류다. Java 11은 `String.isBlank`·`strip`·`repeat`·`lines`, `Files.readString`·`writeString`, `Optional.isEmpty`를 추가했다. `strip`은 Unicode 공백을, `trim`은 ASCII 공백만 제거한다.

**Java 15~17 — 데이터 모델링 문법.** 텍스트 블록은 `"""`로 여닫는 여러 줄 문자열이며 가장 적게 들여쓴 줄 기준으로 공통 들여쓰기를 제거한다. Switch 표현식은 `->` 문법으로 fall-through를 없애고 값을 반환하며, 블록 분기에서는 `yield`를 쓴다. `instanceof` 패턴 매칭은 타입 검사와 캐스팅을 합쳐 패턴 변수를 바인딩하고 `&&`로 조건을 이어 쓸 수 있다.

Record는 불변 데이터 운반체다. 헤더의 컴포넌트가 `private final` 필드가 되고 정규 생성자·accessor(`x()`, `getX()`가 아님)·`equals`·`hashCode`·`toString`이 생성된다. 암묵적으로 `final`이며 상속과 인스턴스 필드 추가가 불가능하다. 컴팩트 생성자로 검증을 넣을 수 있고 인터페이스 구현·static 멤버·추가 메서드는 허용된다. Sealed 타입은 `permits`로 하위 타입을 열거하고, 각 하위 타입은 `final`·`sealed`·`non-sealed` 중 하나를 선언해야 한다.

**Java 21 — 패턴 매칭 완성.** Switch 패턴 매칭은 `case Integer i ->` 타입 패턴, `when` 절 가드 패턴, `case null`을 지원한다. Record Pattern은 `obj instanceof Point(int x, int y)`처럼 레코드를 컴포넌트로 분해하며 중첩도 가능하다. Sealed 타입을 switch에 넣으면 컴파일러가 모든 하위 타입을 알기 때문에 `default` 없이 exhaustive 검사를 받고, 하위 타입이 추가되면 누락된 switch가 컴파일 오류가 된다. 세 기능이 합쳐지면 대수적 데이터 타입(ADT) 방식으로 도메인을 모델링할 수 있다. 같은 버전의 Virtual Thread는 별도 글에서 다룬다.

## 코드

Sealed 인터페이스와 Record로 도메인을 닫고 Switch 패턴 매칭으로 `default` 없이 분기한다.

```java
sealed interface Shape permits Circle, Square, Triangle {}
record Circle(double r) implements Shape {}
record Square(double s) implements Shape {}
record Triangle(double a, double b, double c) implements Shape {
    Triangle {
        if (a + b <= c || a + c <= b || b + c <= a)
            throw new IllegalArgumentException("invalid triangle");
    }
}

double area(Shape shape) {
    return switch (shape) {
        case Circle(double r) -> Math.PI * r * r;
        case Square(double s) -> s * s;
        case Triangle(double a, double b, double c) -> {
            double p = (a + b + c) / 2;
            yield Math.sqrt(p * (p - a) * (p - b) * (p - c));
        }
    };
}
```

가드 패턴과 `case null`을 포함한 타입 분기. `null`을 명시하지 않으면 `NullPointerException`이 발생한다.

```java
String describe(Object obj) {
    return switch (obj) {
        case null -> "null";
        case Integer i when i > 0 -> "positive int " + i;
        case Integer i -> "non-positive int " + i;
        case String s when s.isBlank() -> "blank string";
        case String s -> "string " + s.strip();
        case List<?> list -> "list of " + list.size();
        default -> "unknown";
    };
}
```

Spring Boot 3.x 컨트롤러에서 Record를 요청·응답 DTO로 쓰고 텍스트 블록으로 테스트 페이로드를 만든다.

```java
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.*;

record CreateOrderRequest(@NotBlank String productId, int quantity) {
    CreateOrderRequest {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
    }
}
record OrderResponse(long id, String productId, int quantity) {}

@RestController
@RequestMapping("/orders")
class OrderController {
    @PostMapping
    OrderResponse create(@RequestBody @jakarta.validation.Valid CreateOrderRequest req) {
        var saved = orderService.create(req.productId(), req.quantity());
        return new OrderResponse(saved.id(), saved.productId(), saved.quantity());
    }
}

String payload = """
    {
      "productId": "P-100",
      "quantity": 2
    }
    """;
```

## 실무에서 걸리는 지점

- ==**불변 컬렉션과 null.** `List.of`·`Stream.toList()` 반환값에 `add`를 호출하면 런타임 예외다.== 가변 리스트가 필요하면 `Collectors.toCollection(ArrayList::new)`를 쓴다. `Stream.toList()`는 `null` 요소를 허용하지만 `List.of`는 허용하지 않는다.
- ==**Record와 JPA.** JPA 엔티티는 기본 생성자와 가변 필드가 필요해 Record로 만들 수 없다.== DTO·값 객체·프로젝션에 한정한다. 컬렉션 컴포넌트는 컴팩트 생성자에서 방어적 복사를 하지 않으면 외부에서 변경된다.
- **`var` 추론 함정.** `var list = new ArrayList<>();`는 `ArrayList<Object>`로 추론된다. 우변에서 타입이 드러나지 않는 메서드 호출 결과에는 쓰지 않는다.
- **Sealed 계층의 모듈 경계.** permits의 하위 타입은 같은 모듈(무명 모듈이면 같은 패키지)에 있어야 한다. 멀티모듈로 계층을 나누면 컴파일이 실패한다.
- **Switch 패턴의 지배(dominance)와 null.** 상위 타입 case나 가드 없는 case가 하위 타입 case·가드 case보다 앞에 오면 컴파일 오류다. `default`가 있어도 `null`은 처리되지 않으므로 `case null`을 명시한다.

## 관련 글

- [람다·함수형 인터페이스·Stream](/notes/java-spring/lambda-functional-stream/)
- [Virtual Thread — 원리·API·Pinning](/notes/java-spring/virtual-thread-basics/)
- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
