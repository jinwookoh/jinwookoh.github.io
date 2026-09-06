---
title: "빌더 — 선택 파라미터가 많은 불변 객체 생성"
series: design-patterns
part: "생성"
order: 3
summary: "필드가 많은 불변 객체를 점층적 생성자 없이 만드는 Simple Builder와 Director가 조립 순서를 쥐는 GoF Builder의 차이"
tags: [Builder, Lombok, Immutability, Director, Java]
sources: [https://jinwookoh.tistory.com/212]
updated: 2026-09-06
---

필드가 대여섯 개를 넘는 클래스를 생성자 하나로 만들면 호출부는 `new User("James", "Seoul", null, 0, "Developer")` 같은 형태가 된다. 세 번째 `null`과 네 번째 `0`이 무엇을 뜻하는지 정의를 열어 보지 않으면 알 수 없고, 같은 타입의 인자 두 개가 자리를 바꿔도 컴파일러는 잡아내지 못한다. 선택 필드마다 생성자를 하나씩 늘리는 점층적 생성자(telescoping constructor)는 조합 수만큼 오버로드가 불어나고, 대안으로 기본 생성자에 세터를 붙이면 객체가 완성되기 전 상태로 외부에 노출되며 불변성도 포기하게 된다. 빌더 패턴은 이 두 문제, 즉 가독성과 불변성을 동시에 해결하기 위한 생성 패턴이다.

## 핵심 개념

빌더라는 이름으로 불리는 구현은 목적이 다른 두 갈래로 나뉜다.

첫 번째는 Joshua Bloch가 Effective Java에서 정리한 Simple Builder다. 대상 클래스 안에 static 중첩 클래스 `Builder`를 두고, 각 필드 설정 메서드가 `this`를 반환해 메서드 체이닝을 만든다. 마지막 `build()`가 private 생성자를 호출해 불변 객체를 완성한다. 필수 필드는 `Builder` 생성자 인자로 강제하고 선택 필드만 체이닝으로 받는 것이 정석이다. Lombok의 `@Builder`가 생성하는 코드가 바로 이 형태다.

두 번째는 GoF가 정의한 Classic Builder다. 여기서 초점은 가독성이 아니라 생성 과정 자체의 분리다. 부품을 만드는 `Builder` 인터페이스, 그것을 구현하는 `ConcreteBuilder`, 그리고 어떤 순서로 부품을 조립할지 알고 있는 `Director`로 구성된다. Director는 조립 알고리즘을 소유하고, 어떤 ConcreteBuilder를 주입받느냐에 따라 같은 순서로 다른 결과물을 만든다. 생성 순서가 의미를 가지거나 같은 조립 절차를 여러 표현으로 재사용해야 할 때 쓴다.

| 구분 | Simple Builder | Classic Builder (GoF) |
|---|---|---|
| 목적 | 가독성, 불변 객체 생성 | 조립 순서의 캡슐화와 재사용 |
| Director | 없음, 호출부가 값을 직접 지정 | 있음, Director가 순서를 제어 |
| 호출 형태 | `User.builder().name(..).build()` | `director.construct()` |
| 적합한 대상 | DTO, 설정 객체, 엔티티 | 문서 변환기, 쿼리 생성기, 복잡한 조립 |

실무에서 마주치는 빌더의 대부분은 Simple Builder다. Classic Builder는 Markdown을 HTML과 PDF로 각각 변환하는 것처럼 절차는 같고 결과 표현만 다른 경우에 한해 구조가 정당화된다.

## 코드

필수 필드는 Builder 생성자로 받고 선택 필드는 체이닝으로 받는 Simple Builder다. `build()`에서 검증을 끝내므로 완성되지 않은 객체가 밖으로 나가지 않는다.

```java
public final class User {
    private final String name;
    private final String city;
    private final String email;
    private final int age;
    private final String role;

    private User(Builder b) {
        this.name = b.name;
        this.city = b.city;
        this.email = b.email;
        this.age = b.age;
        this.role = b.role;
    }

    public static Builder builder(String name, String city) {
        return new Builder(name, city);
    }

    public static final class Builder {
        private final String name;
        private final String city;
        private String email;
        private int age;
        private String role = "MEMBER";

        private Builder(String name, String city) {
            this.name = Objects.requireNonNull(name);
            this.city = Objects.requireNonNull(city);
        }

        public Builder email(String email) { this.email = email; return this; }
        public Builder age(int age)        { this.age = age;     return this; }
        public Builder role(String role)   { this.role = role;   return this; }

        public User build() {
            if (age < 0) throw new IllegalArgumentException("age must be >= 0");
            return new User(this);
        }
    }
}

User user = User.builder("James", "Seoul")
        .age(30)
        .role("DEVELOPER")
        .build();
```

Lombok을 쓰면 위 클래스 대부분이 어노테이션 하나로 줄어든다. `@Builder.Default`가 없으면 필드 초기화 식은 무시된다.

```java
@Getter
@Builder
public class UserRequest {
    private final String name;
    private final String city;
    private String email;
    @Builder.Default
    private String role = "MEMBER";
}
```

Classic Builder는 Director가 조립 순서를 쥐고, 어떤 ConcreteBuilder가 들어오느냐에 따라 결과가 달라진다. 같은 `Director`에 `PdfReportBuilder`를 넣으면 PDF가 나온다.

```java
public interface ReportBuilder {
    void header(String title);
    void body(String content);
    void footer(String note);
    String result();
}

public final class HtmlReportBuilder implements ReportBuilder {
    private final StringBuilder sb = new StringBuilder();
    public void header(String t) { sb.append("<h1>").append(t).append("</h1>"); }
    public void body(String c)   { sb.append("<p>").append(c).append("</p>"); }
    public void footer(String n) { sb.append("<footer>").append(n).append("</footer>"); }
    public String result()       { return sb.toString(); }
}

public final class ReportDirector {
    private final ReportBuilder builder;
    public ReportDirector(ReportBuilder builder) { this.builder = builder; }

    public String construct(String title, String content) {
        builder.header(title);
        builder.body(content);
        builder.footer("generated " + LocalDate.now());
        return builder.result();
    }
}

String html = new ReportDirector(new HtmlReportBuilder())
        .construct("월간 리포트", "본문");
```

## 실무에서 걸리는 지점

- Lombok `@Builder`를 필드 초기화 식과 함께 쓰면 초기값이 사라진다. ==필드 선언부에 기본값을 써 두어도 `@Builder.Default`가 없으면 빌더가 생성한 객체의 해당 필드는 null이다.== 컴파일 경고만 나오고 런타임에는 조용히 null이 흘러간다.
- JPA 엔티티에 `@Builder`를 클래스 레벨에 붙이면 모든 필드를 열어 두는 전체 인자 생성자가 생기고, `id`나 `createdAt`처럼 외부에서 지정하면 안 되는 필드까지 빌더로 노출된다. 필요한 필드만 받는 생성자에 `@Builder`를 붙이는 방식으로 범위를 좁힌다.
- 빌더는 필수 값 누락을 컴파일 시점에 잡지 못한다. ==필수 필드를 체이닝 메서드로만 받으면 빠뜨려도 `build()`가 그대로 통과하므로== 필수 값은 Builder 생성자 인자로 강제하거나 `build()`에서 명시적으로 검증해야 한다. 이 검증이 없으면 DB 제약 조건이 걸리는 시점에야 문제가 드러난다.
- 객체 하나당 Builder 인스턴스가 하나 더 생긴다. 일반적인 요청 처리에서는 무시해도 되지만, 초당 수십만 건을 만드는 배치나 직렬화 경로에서는 할당 비용이 프로파일에 잡힌다. 이런 경로는 Java 21의 record 정규 생성자나 정적 팩토리로 대체하는 편이 낫다.
- Builder 인스턴스는 가변 상태를 가지므로 스레드 간에 공유하면 안 된다. 하나의 Builder를 여러 스레드가 나눠 쓰며 `build()`를 호출하면 필드가 섞인 객체가 만들어진다. Builder는 생성 지점에서 만들고 즉시 버린다.

## 관련 글

- [팩토리 — Simple Factory·Factory Method·Abstract Factory](/notes/design-patterns/factory/)
- [프로토타입 — 복제로 생성하기와 깊은 복사 함정](/notes/design-patterns/prototype/)
- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
