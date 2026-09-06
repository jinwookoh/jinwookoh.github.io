---
title: "어댑터 — 맞지 않는 인터페이스를 감싸서 연결"
series: design-patterns
part: "구조"
order: 5
summary: "기존 클래스를 수정하지 않고 새 인터페이스에 맞추는 두 가지 어댑터 구현과 객체 어댑터를 기본으로 택하는 이유"
tags: [Adapter, 객체 어댑터, 클래스 어댑터, 합성, Spring MVC]
sources: [https://jinwookoh.tistory.com/210]
updated: 2026-09-06
---

새로 정의한 인터페이스를 기준으로 코드를 작성하다 보면, 이미 검증된 기존 클래스를 그대로 재사용하고 싶은데 메서드 시그니처가 맞지 않는 상황이 생긴다. 기존 클래스는 외부 라이브러리이거나 다른 팀의 산출물이어서 수정할 수 없고, 호출부를 기존 클래스에 맞춰 고치면 새 인터페이스를 도입한 의미가 사라진다. 호출부 곳곳에 분기와 변환 코드를 흩어 놓으면 기존 클래스가 교체될 때 수정 범위가 전체로 번진다. 어댑터 패턴은 이 변환 책임을 클래스 하나에 모아, 호출부는 새 인터페이스만 알고 기존 클래스는 손대지 않은 채 두 쪽을 연결한다.

## 핵심 개념

어댑터 패턴에는 세 역할이 있다. Target은 호출부가 사용하는 인터페이스, Adaptee는 재사용하려는 기존 클래스, Adapter는 Target을 구현하면서 내부적으로 Adaptee를 호출해 두 인터페이스의 차이를 메우는 클래스다. 호출부는 Target 타입만 의존하므로 Adaptee의 존재를 알지 못한다.

연결 방식에 따라 두 가지 구현이 있다. 클래스 어댑터는 Adaptee를 상속하면서 동시에 Target을 구현한다. Java는 클래스 다중 상속이 없으므로 `extends Adaptee implements Target` 형태로만 가능하다. 객체 어댑터는 Adaptee 인스턴스를 필드로 보유하고 Target 메서드 안에서 그 인스턴스에 위임한다.

| 구분 | 클래스 어댑터 | 객체 어댑터 |
|---|---|---|
| 연결 방식 | `extends Adaptee` | `private final Adaptee` 필드 |
| 결합도 | 높음, 상위 클래스 구현에 종속 | 낮음, Adaptee의 공개 API에만 의존 |
| Adaptee 하위 클래스 지원 | 불가, 상속한 클래스 하나만 | 가능, 하위 타입 인스턴스를 주입하면 된다 |
| Adaptee 교체 | 컴파일 시점에 고정 | 런타임에 다른 인스턴스로 교체 가능 |
| protected 멤버 접근 | 가능 | 불가 |
| 사용 조건 | Adaptee가 final이 아니고 다른 클래스를 상속하지 않을 때 | 제한 없음 |

클래스 어댑터는 Adaptee의 protected 메서드를 재정의해야 하는 경우에만 의미가 있다. 그 외에는 객체 어댑터가 기본이다. 상속 방식은 Adaptee의 모든 공개 메서드가 어댑터 타입에도 노출되어 호출부가 Target을 우회해 Adaptee 메서드를 직접 부를 수 있고, ==Adaptee가 final이거나 이미 다른 클래스를 상속하고 있으면 클래스 어댑터는 아예 컴파일되지 않는다==. 합성 방식은 어댑터가 Target 메서드만 노출하므로 캡슐화가 유지된다.

## 코드

재생 인터페이스 `MediaPlayer`를 새로 정의했고, 메서드 이름이 다른 기존 클래스 `OldAudioPlayer`를 재사용하려는 상황이다.

```java
public interface MediaPlayer {
    void play(String file);
}

public class OldAudioPlayer {
    public void playMusic(String file) {
        System.out.println("legacy player: " + file);
    }
}
```

클래스 어댑터는 Adaptee를 상속하고 Target을 구현한다. `playMusic`이 어댑터의 공개 메서드로도 노출된다.

```java
public class ClassAdapter extends OldAudioPlayer implements MediaPlayer {
    @Override
    public void play(String file) {
        playMusic(file);
    }
}
```

객체 어댑터는 Adaptee를 생성자로 주입받아 위임한다. Spring Boot 3.x에서는 `@Component`로 등록하면 `OldAudioPlayer` 빈이 생성자 주입된다.

```java
import org.springframework.stereotype.Component;

@Component
public class ObjectAdapter implements MediaPlayer {
    private final OldAudioPlayer oldPlayer;

    public ObjectAdapter(OldAudioPlayer oldPlayer) {
        this.oldPlayer = oldPlayer;
    }

    @Override
    public void play(String file) {
        oldPlayer.playMusic(file);
    }
}
```

JDK 표준 라이브러리의 `InputStreamReader`가 객체 어댑터의 사례다. 바이트 스트림 `InputStream`을 문자 스트림 `Reader` 인터페이스로 맞춘다.

```java
try (var reader = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
    String line = reader.readLine();
}
```

Spring MVC의 `HandlerAdapter`도 같은 구조다. `DispatcherServlet`은 `@RequestMapping` 메서드, `HttpRequestHandler`, 함수형 `HandlerFunction` 등 서로 다른 형태의 핸들러를 `HandlerAdapter.handle()` 하나로 실행한다. 핸들러 유형마다 `RequestMappingHandlerAdapter`, `HttpRequestHandlerAdapter` 같은 어댑터가 등록되어 있고, `supports()`로 처리 가능한 핸들러를 판별한다.

## 실무에서 걸리는 지점

- 어댑터에 변환 이상의 로직이 들어가기 시작하면 경계가 무너진다. 캐싱, 재시도, 유효성 검사가 어댑터 안에 쌓이면 Adaptee를 교체할 때 그 로직까지 다시 검증해야 한다. 어댑터는 시그니처와 데이터 형식 변환만 담당하고 나머지는 데코레이터나 별도 계층으로 분리한다.
- 예외 변환을 누락하면 호출부가 Adaptee의 예외 타입에 의존하게 된다. ==어댑터가 Adaptee의 검사 예외나 라이브러리 고유 예외를 그대로 흘려보내면 호출부는 Target 인터페이스만 알면서도 Adaptee의 예외를 잡게 되어 교체 시 catch 블록이 전부 깨진다.== Target이 정의한 예외로 감싸서 던진다.
- 인터페이스 의미가 다르면 이름만 맞춘 어댑터는 조용히 잘못 동작한다. Adaptee의 `playMusic`이 동기 블로킹인데 Target의 `play`가 비동기 반환을 기대한다면, 컴파일은 통과하지만 호출 스레드가 멈춘다. 스레드 모델, null 반환 여부, 인덱스 기준 같은 계약 차이를 어댑터가 흡수해야 한다.
- 클래스 어댑터는 Adaptee의 버전 업그레이드에 취약하다. Adaptee에 Target과 같은 이름의 메서드가 추가되면 의도하지 않은 재정의가 발생하거나 시그니처 충돌로 컴파일이 실패한다. 객체 어댑터는 Adaptee의 공개 API만 사용하므로 이 문제가 없다.
- 양쪽 인터페이스가 모두 살아 있는 전환기에는 어댑터가 두 방향으로 필요할 수 있다. 이때 어댑터가 서로를 감싸는 구조가 되면 호출 깊이가 늘어나고 디버깅 시 스택이 어댑터 계층으로 채워진다. 전환 완료 시점을 정하고 옛 인터페이스 쪽 어댑터를 제거하는 일정을 함께 잡는다.

## 관련 글

- [브리지 — 추상과 구현을 분리해 클래스 폭발 막기](/notes/design-patterns/bridge/)
- [데코레이터 — 상속 없이 기능을 겹겹이 추가](/notes/design-patterns/decorator/)
- [퍼사드 — 복잡한 서브시스템에 단일 진입점](/notes/design-patterns/facade/)
