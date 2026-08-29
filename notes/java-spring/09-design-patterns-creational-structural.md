---
title: "디자인 패턴 — 생성·구조"
series: java-spring
part: "자바 기초·모던 자바"
order: 9
summary: "객체를 어떻게 만들고(생성) 어떻게 조합하는지(구조)를 GoF 11개 패턴의 적용 신호와 함정 중심으로 정리한다."
tags: [Design Pattern, GoF, Singleton, Builder, Decorator, Proxy]
sources: [2026-05-03-design-patterns-creational.md, 2026-05-03-design-patterns-structural.md]
updated: 2026-08-29
---

객체 하나를 만드는 데는 `new` 한 줄이면 충분하다. 문제는 옵션 조합이 많거나, 생성 비용이 크거나, 하나만 존재해야 하거나, 짝이 맞는 부품 묶음으로 만들어야 할 때 생긴다. 조합 단계에서도 문제가 반복된다. 기능 조합을 상속으로 풀면 클래스가 2^N으로 폭발하고, 외부 라이브러리 시그니처가 맞지 않아 호출부 전체를 고치며, 같은 모양의 객체 10만 개가 각자 이미지를 들고 있어 힙이 바닥난다. GoF 생성 패턴 5개와 구조 패턴 6개는 이런 상황의 처방이며, 핵심은 어떤 코드 신호에 어떤 패턴을 꺼내는지 아는 것이다.

## 핵심 개념

생성 패턴은 "어떤 클래스의 인스턴스를 어떻게 만드는가"를 클라이언트로부터 분리한다.

| 패턴 | 해결하는 문제 | 적용 신호 |
|:---|:---|:---|
| Singleton | 인스턴스가 하나만 존재 | 설정·커넥션 풀·캐시 관리자 |
| Factory Method | 구현체 선택을 클라이언트에서 분리 | `new ConcreteClass()` 산재, 런타임 타입 결정 |
| Abstract Factory | 어울리는 객체 군을 한 세트로 생성 | 플랫폼·벤더별 부품 일관성 |
| Builder | 선택 파라미터가 많은 불변 객체 | 생성자 4개 이상, boolean·int 연속 |
| Prototype | 비용 큰 객체를 복제로 생성 | 체크포인트·Undo·템플릿 변형 |

Singleton의 단순 lazy 초기화는 멀티스레드에서 인스턴스가 두 개 생길 수 있고, Double-Checked Locking은 `volatile` 없이는 명령어 재배치로 초기화가 끝나지 않은 참조가 노출된다. 클래스 로딩이 원자성을 보장하는 holder idiom이나 enum이 가장 안전하다.

Factory Method는 static 메서드 안에서 switch로 분기하는 Simple Factory와, 팩토리를 인터페이스로 추상화해 서브클래스가 생성 대상을 정하는 GoF 정통 형태로 나뉜다. 전자는 타입 추가마다 분기가 늘어 OCP를 위반한다. Abstract Factory는 Factory Method 여러 개를 하나의 인터페이스로 묶은 것으로, 새 플랫폼 추가는 쉽지만 새 제품 타입 추가는 모든 팩토리를 수정해야 한다.

Builder는 필수 값을 빌더 생성자로 받고 선택 값을 체이닝하며, `build()`에서 검증한 뒤 private 생성자로 final 필드를 채운다. Prototype에서 `Object.clone()`은 얕은 복사이고 `Cloneable`은 설계 결함이 많아 복사 생성자로 대체한다.

구조 패턴은 객체를 조합해 더 큰 구조를 만든다. Adapter·Decorator·Proxy는 모두 객체를 감싸지만 목적이 다르다.

| 패턴 | 감싸는 목적 | 인터페이스 | 중첩 |
|:---|:---|:---|:---|
| Adapter | 호환되지 않는 인터페이스 변환 | 대상 인터페이스로 바꿈 | 드묾 |
| Decorator | 기능을 런타임에 추가 | 동일 유지 | 여러 겹 |
| Proxy | 접근 제어(지연 로딩·캐싱·권한·로깅) | 동일 유지 | 보통 한 겹 |

Adapter는 Target을 구현하면서 내부에서 Adaptee를 호출해 시그니처를 변환한다. Decorator는 같은 인터페이스를 구현한 클래스가 같은 타입을 필드로 가지며 한 가지 책임만 더한다. Java I/O의 `BufferedInputStream`이 대표 사례다. Proxy는 Virtual·Protection·Remote·Logging으로 나뉘며, Spring AOP의 `@Transactional`이 JDK 동적 프록시 또는 CGLIB 프록시로 동작한다.

Composite는 Leaf와 Composite가 같은 인터페이스를 구현해 트리를 재귀적으로 처리한다. Facade는 여러 서브시스템 호출을 단일 진입점으로 묶으며 API Gateway가 이 모양이다. Flyweight는 공유 가능한 내재적 상태와 객체마다 고유한 외재적 상태를 분리하고, 내재적 상태를 팩토리에서 한 번만 만들어 공유한다. 공유 상태는 반드시 불변이어야 한다.

## 코드

Builder와 holder idiom 싱글톤을 결합한 설정 객체.

```java
public final class HttpClientConfig {
    private final String baseUrl;
    private final Duration connectTimeout;
    private final Duration readTimeout;
    private final int maxRetries;

    private HttpClientConfig(Builder b) {
        this.baseUrl = b.baseUrl;
        this.connectTimeout = b.connectTimeout;
        this.readTimeout = b.readTimeout;
        this.maxRetries = b.maxRetries;
    }

    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    public static final class Builder {
        private final String baseUrl;
        private Duration connectTimeout = Duration.ofSeconds(3);
        private Duration readTimeout = Duration.ofSeconds(10);
        private int maxRetries = 0;

        private Builder(String baseUrl) {
            this.baseUrl = Objects.requireNonNull(baseUrl);
        }
        public Builder connectTimeout(Duration d) { this.connectTimeout = d; return this; }
        public Builder readTimeout(Duration d) { this.readTimeout = d; return this; }
        public Builder maxRetries(int n) { this.maxRetries = n; return this; }

        public HttpClientConfig build() {
            if (maxRetries < 0 || maxRetries > 10) {
                throw new IllegalStateException("maxRetries out of range: " + maxRetries);
            }
            return new HttpClientConfig(this);
        }
    }
}

// holder idiom — 클래스 로딩이 초기화의 원자성과 가시성을 보장한다
public final class DefaultConfigHolder {
    private DefaultConfigHolder() {}
    private static class Holder {
        static final HttpClientConfig INSTANCE =
            HttpClientConfig.builder("https://api.example.com").maxRetries(3).build();
    }
    public static HttpClientConfig get() { return Holder.INSTANCE; }
}
```

같은 인터페이스 위에서 Adapter는 시그니처를 변환하고 Decorator는 재시도를 한 겹 더한다.

```java
public interface NotificationSender {
    void send(String to, String subject, String body);
}

// Adaptee — 외부 SDK, 메서드명·파라미터가 다르다
public class VendorMailSdk {
    public void deliver(String recipient, String title, String content) { /* ... */ }
}

// Adapter — Target 구현 + Adaptee 위임
public class VendorMailAdapter implements NotificationSender {
    private final VendorMailSdk sdk;
    public VendorMailAdapter(VendorMailSdk sdk) { this.sdk = sdk; }

    @Override
    public void send(String to, String subject, String body) {
        sdk.deliver(to, subject, body);
    }
}

// Decorator — 같은 인터페이스를 유지하며 재시도를 추가
public class RetryingSender implements NotificationSender {
    private final NotificationSender delegate;
    private final int maxAttempts;

    public RetryingSender(NotificationSender delegate, int maxAttempts) {
        this.delegate = delegate;
        this.maxAttempts = maxAttempts;
    }

    @Override
    public void send(String to, String subject, String body) {
        RuntimeException last = null;
        for (int i = 0; i < maxAttempts; i++) {
            try {
                delegate.send(to, subject, body);
                return;
            } catch (RuntimeException e) {
                last = e;
            }
        }
        throw new IllegalStateException("send failed after " + maxAttempts + " attempts", last);
    }
}

// Spring Boot 구성 — 조합은 한 곳에서
@Configuration
public class NotificationConfig {
    @Bean
    NotificationSender notificationSender(VendorMailSdk sdk) {
        return new RetryingSender(new VendorMailAdapter(sdk), 3);
    }
}
```

Flyweight 팩토리. record로 불변을 보장하고 `computeIfAbsent`로 중복 생성과 경쟁 조건을 막는다.

```java
public record GlyphStyle(String fontFamily, int size, boolean bold) {}

public final class GlyphStyleFactory {
    private static final Map<String, GlyphStyle> CACHE = new ConcurrentHashMap<>();

    public static GlyphStyle of(String fontFamily, int size, boolean bold) {
        String key = fontFamily + "/" + size + "/" + bold;
        return CACHE.computeIfAbsent(key, k -> new GlyphStyle(fontFamily, size, bold));
    }

    public static int cachedCount() { return CACHE.size(); }
}

// 외재적 상태(위치)만 개별 객체가 들고, 스타일은 공유 참조
public record Glyph(char ch, int x, int y, GlyphStyle style) {}
```

## 실무에서 걸리는 지점

- **Singleton 직접 구현은 대부분 불필요하다.** Spring Bean이 기본 singleton scope이고, static 접근점은 DI를 우회해 테스트에서 mock 교체를 막는다.
- **Lazy 초기화는 Singleton이 아니어도 같은 경쟁 조건을 갖는다.** Virtual Proxy의 `if (real == null)` 역시 두 스레드가 동시에 통과한다. `volatile` + DCL이나 `computeIfAbsent`를 쓰고, Virtual Thread 환경에서는 `synchronized` 안의 블로킹 I/O가 pinning을 유발하므로 `ReentrantLock`을 검토한다.
- **Lombok `@Builder`는 필수 값을 강제하지 못한다.** `@NonNull`이나 `build()` 검증을 별도로 둔다. 필드 2~3개짜리 객체에 Builder는 과설계다.
- **Spring 프록시는 self-invocation을 가로채지 못한다.** `@Transactional`은 프록시를 통한 호출에만 적용되므로 같은 클래스 안의 `this.method()`에는 어드바이스가 빠진다. 대상 클래스가 `final`이면 CGLIB 서브클래싱도 실패한다.
- **Facade가 비즈니스 로직을 흡수하면 God Object가 된다.** Composite의 재귀 순회는 깊이가 예측 불가능하면 스택 오버플로를 일으키므로 반복 순회로 바꾼다.

## 관련 글

- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
- [디자인 패턴 — 행위·조합](/notes/java-spring/design-patterns-behavioral/)
- [AOP와 SpEL](/notes/java-spring/aop-spel/)
