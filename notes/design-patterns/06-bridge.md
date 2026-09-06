---
title: "브리지 — 추상과 구현을 분리해 클래스 폭발 막기"
series: design-patterns
part: "구조"
order: 6
summary: "변화 축이 둘 이상일 때 상속 대신 합성으로 계층을 나눠 M×N 클래스 폭발을 M+N으로 줄인다"
tags: [Bridge, 합성, 클래스 폭발, JDBC, Spring]
sources: [https://jinwookoh.tistory.com/222]
updated: 2026-09-06
---

알림 기능에 "메시지 종류"와 "전송 채널"이라는 두 축이 있다고 하자. 종류가 일반·긴급 두 가지, 채널이 이메일·슬랙 두 가지일 때 상속만으로 조합하면 UrgentEmailNotification, UrgentSlackNotification처럼 클래스 4개가 생긴다. 여기에 종류 하나, 채널 하나를 더하면 9개, 일반화하면 M종류 × N채널 개수로 늘어난다. 이런 클래스 폭발은 개수 자체보다 변경 비용이 문제다. 채널의 인증 방식이 바뀌면 그 채널을 쓰는 모든 종류의 클래스를 손봐야 하고, 전송 로직이 여러 클래스에 복사돼 있으므로 한 곳만 고치고 나머지에 버그가 남는 일이 생긴다. 브리지 패턴은 이 두 축을 별개의 계층으로 분리하고 합성으로 연결해, 클래스 수를 M + N으로 줄이고 각 축을 독립적으로 확장하게 한다.

## 핵심 개념

브리지는 네 가지 역할로 구성된다.

- Abstraction: 기능 계층의 최상위. 클라이언트가 호출하는 고수준 API를 정의하고, 내부에 Implementor 참조를 필드로 가진다. 이 필드가 두 계층을 잇는 다리다.
- Refined Abstraction: Abstraction을 확장해 기능을 변형한 클래스.
- Implementor: 구현 계층의 인터페이스. 저수준 원시 연산을 정의하며, Abstraction의 API와 형태가 같을 필요는 없다.
- Concrete Implementor: Implementor의 실제 구현.

핵심은 Abstraction이 Implementor를 상속하지 않고 소유한다는 점이다. 상속은 컴파일 시점에 부모와 자식을 고정하지만, 합성은 생성자나 세터로 구현체를 런타임에 바꿔 끼울 수 있다. 상속 계층이 하나만 있을 때는 그 계층에 "무엇을 하는가"와 "어떻게 하는가"가 섞여 있다. 브리지는 이 둘을 각각의 계층으로 나눈 뒤, 기능 쪽 클래스가 구현 쪽 인터페이스에만 의존하게 만든다.

어댑터와 자주 혼동된다. 둘 다 인터페이스 사이를 잇지만 목적과 적용 시점이 다르다.

| 구분 | 어댑터 | 브리지 |
|---|---|---|
| 목적 | 이미 있는 클래스를 기존 인터페이스에 맞춘다 | 추상과 구현을 처음부터 독립적으로 변경하게 한다 |
| 적용 시점 | 코드가 만들어진 뒤 | 설계 단계 |
| 감싸는 대상 | 호환되지 않는 하나의 클래스 | 교체 가능한 구현 계층 전체 |

JDBC가 대표적인 사례다. `java.sql.Connection`, `Statement` 같은 표준 인터페이스가 기능 계층이고, MySQL·PostgreSQL 벤더가 제공하는 `Driver` 구현체가 구현 계층이다. 애플리케이션 코드는 표준 인터페이스만 호출하고, 어떤 드라이버가 연결되는지는 `DriverManager`나 `DataSource` 설정이 결정한다. DB를 바꿔도 SQL 호출 코드는 그대로다.

## 코드

구현 계층. 전송 채널 인터페이스와 두 구현체다.

```java
public interface MessageSender {
    void send(String to, String title, String body);
}

public class EmailSender implements MessageSender {
    @Override
    public void send(String to, String title, String body) {
        System.out.printf("[email] to=%s title=%s%n", to, title);
    }
}

public class SlackSender implements MessageSender {
    @Override
    public void send(String to, String title, String body) {
        System.out.printf("[slack] channel=%s text=%s%n", to, title + "\n" + body);
    }
}
```

기능 계층. `Notification`이 `MessageSender`를 필드로 소유하고, 하위 클래스는 채널을 모른 채 메시지 조립 방식만 바꾼다.

```java
public abstract class Notification {
    protected final MessageSender sender;

    protected Notification(MessageSender sender) {
        this.sender = sender;
    }

    public abstract void notify(String to, String content);
}

public class PlainNotification extends Notification {
    public PlainNotification(MessageSender sender) { super(sender); }

    @Override
    public void notify(String to, String content) {
        sender.send(to, "알림", content);
    }
}

public class UrgentNotification extends Notification {
    public UrgentNotification(MessageSender sender) { super(sender); }

    @Override
    public void notify(String to, String content) {
        sender.send(to, "[긴급] 즉시 확인 필요", content);
        sender.send(to, "[긴급] 재전송", content);
    }
}
```

사용. 종류와 채널을 조합해 객체를 만든다. 채널 추가는 `MessageSender` 구현 하나, 종류 추가는 `Notification` 하위 클래스 하나로 끝난다.

```java
Notification n1 = new PlainNotification(new EmailSender());
n1.notify("dev@example.com", "배포가 완료되었다.");

Notification n2 = new UrgentNotification(new SlackSender());
n2.notify("#ops", "결제 API 오류율 5% 초과");
```

Spring Boot에서는 구현 계층을 빈으로 등록하고 기능 계층이 이를 주입받는다. 채널을 설정값으로 고르려면 `Map<String, MessageSender>`로 모든 구현체를 받아 빈 이름으로 선택한다.

```java
@Service
public class NotificationService {
    private final Map<String, MessageSender> senders;

    public NotificationService(Map<String, MessageSender> senders) {
        this.senders = senders; // 빈 이름 -> 구현체
    }

    public void sendUrgent(String channel, String to, String content) {
        MessageSender sender = senders.get(channel);
        if (sender == null) {
            throw new IllegalArgumentException("unknown channel: " + channel);
        }
        new UrgentNotification(sender).notify(to, content);
    }
}
```

## 실무에서 걸리는 지점

- 변화 축이 하나뿐이면 브리지는 과설계다. 인터페이스와 클래스가 두 배로 늘어나므로, 두 번째 축이 실제로 독립적으로 늘어난다는 근거가 있을 때만 도입한다. 축이 하나면 전략 패턴이나 단순 인터페이스 주입으로 충분하다.
- ==Implementor 인터페이스에 특정 구현체만 지원하는 메서드를 추가하기 시작하면 브리지는 무너진다.== 슬랙 전용 `addReaction`을 `MessageSender`에 넣으면 이메일 구현체는 빈 메서드나 예외를 던져야 하고, 기능 계층이 구현체 종류를 분기하게 된다. 구현별 차이는 Implementor 안에서 흡수하거나 별도 인터페이스로 분리한다.
- Implementor를 세터로 바꿔 끼우게 만들면 스레드 안전성 문제가 생긴다. ==싱글톤 빈인 Abstraction의 구현체 필드를 요청마다 세터로 교체하면 동시 요청이 서로의 구현체를 덮어쓴다.== 구현체는 생성자로 고정하거나, 요청별로 Abstraction 인스턴스를 새로 만든다.
- 구현체가 외부 시스템(SMTP, HTTP API)을 감싸는 경우 실패 처리 정책을 어느 계층에 둘지 정해야 한다. 재시도·타임아웃을 Implementor 안에 넣으면 모든 기능 계층이 같은 정책을 강제받고, 기능 계층에 두면 구현체마다 실패 유형이 달라 처리가 어긋난다. 보통 전송 수준 재시도는 Implementor에, 업무 수준의 대체 채널 선택은 Abstraction에 둔다.
- 브리지가 API를 통일해도 구현체 간 동작 차이는 남는다. ==같은 `Connection` 인터페이스라도 드라이버마다 fetch size 기본값과 커서 처리 방식이 달라, 대량 조회 시 한쪽은 스트리밍하고 다른 쪽은 전체 결과를 메모리에 올린다.== 추상 인터페이스만 믿고 구현체를 테스트 없이 바꾸면 성능이나 결과가 달라질 수 있다.

## 관련 글

- [어댑터 — 맞지 않는 인터페이스를 감싸서 연결](/notes/design-patterns/adapter/)
- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
- [의존성 주입 — 필드·생성자·세터 주입의 차이](/notes/design-patterns/dependency-injection/)
