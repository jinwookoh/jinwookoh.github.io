---
title: "싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현"
series: design-patterns
part: "생성"
order: 1
summary: "순수 Java 싱글톤은 Holder 관용구나 enum으로 구현하고, Spring에서는 직접 만들지 않고 컨테이너에 맡긴다."
tags: [Singleton, Holder Idiom, Double-Checked Locking, Enum, Spring Bean]
sources: [https://jinwookoh.tistory.com/206]
updated: 2026-09-06
---

설정 로더, 커넥션 풀, 캐시처럼 애플리케이션 전체가 공유해야 하는 객체가 있다. 이런 객체가 호출할 때마다 새로 만들어지면 커넥션 풀이 여러 개 생겨 DB 연결 수 상한을 넘기고, 캐시가 인스턴스마다 따로 쌓여 적중률이 떨어진다. 싱글톤 패턴은 클래스가 인스턴스를 하나만 만들도록 생성자를 막고, 그 하나에 접근하는 전역 진입점을 제공한다. 구조는 단순하지만 멀티스레드 환경에서 정말 하나만 만들어지는지를 보장하는 방법에 따라 구현이 갈린다.

## 핵심 개념

싱글톤의 뼈대는 세 가지다. private 생성자로 외부 생성을 막고, static 필드에 유일한 인스턴스를 보관하며, static 접근 메서드로 그 인스턴스를 돌려준다. 구현이 나뉘는 지점은 인스턴스를 언제 만드느냐, 그리고 여러 스레드가 동시에 접근 메서드를 호출했을 때 어떻게 하나임을 보장하느냐다.

이른 초기화(Eager)는 static final 필드에 클래스 로딩 시점에 인스턴스를 만든다. JVM이 클래스 초기화를 한 번만 수행하므로 동기화 없이 안전하지만, 쓰이지 않아도 클래스가 로드되는 순간 만들어진다.

게으른 초기화(Lazy)는 접근 메서드 안에서 null 검사 후 생성한다. 두 스레드가 동시에 null 검사를 통과하면 인스턴스가 두 개 생기고, 먼저 받아간 스레드는 버려진 객체를 계속 쥐게 된다. 메서드 전체에 synchronized를 걸면 해결되지만 매 호출마다 락을 잡아 처리량이 떨어진다.

이중 검사 잠금(DCL)은 null일 때만 락을 잡고 락 안에서 다시 검사한다. 이때 필드는 반드시 volatile이어야 한다. ==volatile이 없으면 JIT의 명령 재배치 때문에 생성자가 끝나기 전에 참조가 먼저 공개되어, 다른 스레드가 필드가 채워지지 않은 객체를 받을 수 있다.==

Holder 관용구(Bill Pugh)는 인스턴스를 정적 중첩 클래스의 static final 필드에 둔다. 바깥 클래스가 로드되어도 중첩 클래스는 처음 참조될 때 초기화되므로 지연 생성이 되고, 클래스 초기화는 JVM이 초기화 락으로 직렬화하므로 코드에 락을 쓰지 않아도 안전하다.

enum 싱글톤은 상수 하나짜리 enum이다. enum 상수는 클래스 초기화 시 한 번 생성되고, 리플렉션으로 생성자를 호출하면 IllegalArgumentException이 발생하며, 직렬화는 상수 이름만 기록했다가 valueOf로 복원하므로 역직렬화해도 같은 인스턴스가 나온다. 다른 클래스를 상속할 수 없고 생성 시점을 세밀하게 제어할 수 없다는 제약이 있다.

| 구현 | 생성 시점 | 스레드 안전 | 리플렉션·직렬화 방어 |
|---|---|---|---|
| Eager | 클래스 로딩 | O | X |
| Lazy | 첫 호출 | X | X |
| DCL | 첫 호출 | volatile 필수 | X |
| Holder | 첫 호출 | O | X |
| enum | 클래스 로딩 | O | O |

Spring의 기본 스코프 singleton은 자바 싱글톤과 범위가 다르다. 자바 싱글톤은 클래스 로더당 하나, Spring 빈은 ApplicationContext당 하나다. Spring을 쓴다면 getInstance()를 직접 만들 이유가 없다. @Component나 @Bean으로 등록하고 생성자 주입을 받으면 인스턴스 하나가 보장되고, static에 묶인 직접 구현과 달리 테스트에서 교체도 쉽다.

## 코드

Holder 관용구로 구현한 설정 로더다. 첫 getInstance() 호출 시점에 중첩 클래스가 초기화되면서 인스턴스가 만들어진다.

```java
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Properties;

public final class ConfigLoader {
    private final Properties props = new Properties();

    private ConfigLoader() {
        try (var in = ConfigLoader.class.getResourceAsStream("/app.properties")) {
            if (in != null) {
                props.load(in);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static class Holder {
        private static final ConfigLoader INSTANCE = new ConfigLoader();
    }

    public static ConfigLoader getInstance() {
        return Holder.INSTANCE;
    }

    public String get(String key) {
        return props.getProperty(key);
    }
}
```

enum으로 구현한 ID 생성기다. 리플렉션과 직렬화를 거쳐도 INSTANCE 하나만 존재한다.

```java
import java.util.concurrent.atomic.AtomicLong;

public enum IdGenerator {
    INSTANCE;

    private final AtomicLong seq = new AtomicLong();

    public long next() {
        return seq.incrementAndGet();
    }
}
```

Spring Boot 3.x에서는 빈으로 등록하고 주입받는다. 스코프를 지정하지 않으면 singleton이며, 공유 상태는 스레드 안전한 타입으로 둔다.

```java
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@Component
public class OrderCounter {
    private final AtomicLong count = new AtomicLong();

    public long increment() {
        return count.incrementAndGet();
    }
}

@Service
public class OrderService {
    private final OrderCounter counter;

    public OrderService(OrderCounter counter) {
        this.counter = counter;
    }

    public long place() {
        return counter.increment();
    }
}
```

## 실무에서 걸리는 지점

- 리플렉션과 직렬화. enum을 제외한 구현은 setAccessible(true)로 private 생성자를 호출하면 두 번째 인스턴스가 생긴다. ==Serializable을 구현한 싱글톤에 readResolve()를 빠뜨리면 역직렬화할 때마다 새 객체가 생겨 싱글톤이 조용히 깨진다.== readResolve()에서 기존 인스턴스를 돌려주거나 enum으로 바꾼다.
- 인스턴스 하나와 스레드 안전은 다른 문제다. 싱글톤 안의 HashMap이나 카운터 필드는 모든 스레드가 공유하므로 ConcurrentHashMap·AtomicLong을 쓰거나 상태를 두지 않는다. ==Spring 싱글톤 빈의 인스턴스 필드에 요청별 데이터를 저장하면 동시 요청 사이에 값이 섞인다.== 요청 단위 데이터는 메서드 파라미터나 request 스코프 빈으로 옮긴다.
- 초기화 실패. Holder와 Eager 방식에서 생성자가 예외를 던지면 ExceptionInInitializerError가 발생한다. ==클래스 초기화 중 예외가 나면 그 클래스는 JVM이 살아 있는 동안 다시 초기화되지 않아 이후 모든 getInstance() 호출이 NoClassDefFoundError로 실패한다.== 외부 리소스를 읽는 작업은 실패 시 재시도할 수 있도록 생성자 밖으로 뺀다.
- 테스트 격리. static에 고정된 인스턴스는 테스트 사이에 상태가 남아 실행 순서에 따라 결과가 달라진다. 순수 Java에서는 인터페이스로 추상화하고 사용처가 인스턴스를 주입받게 해 대체 구현을 넣을 수 있게 한다.
- 클래스 로더 경계. 한 JVM에 클래스 로더가 여러 개면 로더마다 별개의 static 필드가 존재해 인스턴스도 여러 개다. JVM 전체에 하나여야 한다면 공통 부모 로더에 둔다.

## 관련 글

- [팩토리 — Simple Factory·Factory Method·Abstract Factory](/notes/design-patterns/factory/)
- [프로토타입 — 복제로 생성하기와 깊은 복사 함정](/notes/design-patterns/prototype/)
- [의존성 주입 — 필드·생성자·세터 주입의 차이](/notes/design-patterns/dependency-injection/)
