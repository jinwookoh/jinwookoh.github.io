---
title: "커맨드 — 요청을 객체로 캡슐화하고 Undo 구현"
series: design-patterns
part: "행위"
order: 16
summary: "요청을 execute·undo를 가진 객체로 만들면 호출자는 수신자를 몰라도 되고, 실행 이력을 스택에 쌓아 되돌릴 수 있다"
tags: [Command, Undo, Runnable, ExecutorService, CQRS]
sources: [https://jinwookoh.tistory.com/217]
updated: 2026-09-06
---

버튼 하나는 조명을 켜고 다른 버튼은 TV를 켜는 리모컨 클래스를 만든다고 하자. 호출하는 쪽(버튼)이 `Light`, `Tv` 같은 구체 클래스의 메서드를 직접 부르면 버튼과 기기가 강하게 결합된다. 버튼 배치를 바꾸거나 기기를 추가할 때마다 호출자 코드를 수정해야 하고, 방금 한 동작을 취소하거나 실행 내역을 남겨 두었다가 재생하는 기능은 호출자 곳곳에 if 분기와 임시 변수로 흩어진다. 요청 자체가 값으로 존재하지 않기 때문에 큐에 넣거나 나중에 실행하거나 로그로 남기는 일도 자연스럽지 않다.

## 핵심 개념

커맨드 패턴은 요청을 하나의 객체로 캡슐화한다. 구성 요소는 넷이다. `Command`는 `execute()`를 선언한 인터페이스, `ConcreteCommand`는 수신자 참조와 필요한 인자를 들고 있다가 `execute()`에서 수신자의 메서드를 호출하는 구현체, `Receiver`는 실제 일을 하는 객체, `Invoker`는 커맨드를 받아 두었다가 적절한 시점에 `execute()`만 부르는 쪽이다. 호출자는 커맨드 인터페이스만 알고 수신자의 존재를 모른다. 이 분리 덕에 같은 호출자에 어떤 커맨드든 꽂을 수 있고, 커맨드를 컬렉션에 담아 큐잉·지연 실행·일괄 실행·로깅으로 확장할 수 있다.

Undo는 `Command`에 `undo()`를 추가하고, 호출자가 실행한 커맨드를 스택에 쌓아 두는 것으로 구현한다. 취소 요청이 오면 스택에서 꺼내 `undo()`를 부른다. 이때 ==커맨드는 실행 전 상태를 자기 필드에 저장해야 정확히 되돌릴 수 있다==. 조명을 켜는 커맨드의 undo가 단순히 `off()`라면 원래 꺼져 있던 조명에는 맞지만, 이미 켜져 있던 조명에 대해 실행했다면 취소 후 상태가 원래와 달라진다. Redo는 undo한 커맨드를 별도 스택으로 옮기고, 새 커맨드가 실행되면 그 스택을 비우는 식으로 구현한다.

Undo나 이력이 필요 없다면 클래스를 만들 이유가 없다. `Command`는 메서드 하나뿐인 인터페이스이므로 `Runnable`이나 람다로 대체한다. `ExecutorService.submit(Runnable)`이 바로 이 구조다. 작업을 객체로 만들어 큐에 넣고, 워커 스레드가 꺼내 실행한다. 두 방식은 다음처럼 갈린다.

| 구분 | 클래식 커맨드 | 함수형 커맨드 |
|---|---|---|
| 형태 | `Command` 구현 클래스 | `Runnable`·람다 |
| 기능 | execute + undo, 이력 저장 | 실행만 |
| 상태 | 실행 전 값을 필드에 보관 | 없음 |
| 용도 | 에디터, 그리기 도구, 트랜잭션 보상 | 비동기 작업, 이벤트 핸들러 |

CQRS는 이 아이디어를 아키텍처 수준으로 올린 것이다. 상태를 바꾸는 요청(Command)과 조회(Query)를 모델과 경로부터 분리해 각각 따로 최적화한다. 다만 CQRS의 Command는 의도를 담은 DTO에 가깝고, GoF의 Command처럼 스스로 실행되지 않는다는 점이 다르다.

## 코드

Undo가 가능한 클래식 구현. 커맨드가 실행 전 상태를 기억한다.

```java
interface Command {
    void execute();
    void undo();
}

class Light {
    private boolean on;
    boolean isOn() { return on; }
    void set(boolean on) { this.on = on; }
}

class LightOnCommand implements Command {
    private final Light light;
    private boolean previous;

    LightOnCommand(Light light) { this.light = light; }

    @Override public void execute() {
        previous = light.isOn();
        light.set(true);
    }

    @Override public void undo() {
        light.set(previous);
    }
}
```

호출자는 커맨드를 실행하고 스택에 쌓는다. Redo 스택은 새 명령이 들어오면 비운다.

```java
import java.util.ArrayDeque;
import java.util.Deque;

class RemoteControl {
    private final Deque<Command> history = new ArrayDeque<>();
    private final Deque<Command> redo = new ArrayDeque<>();

    void press(Command command) {
        command.execute();
        history.push(command);
        redo.clear();
    }

    void undo() {
        if (history.isEmpty()) return;
        Command c = history.pop();
        c.undo();
        redo.push(c);
    }

    void redo() {
        if (redo.isEmpty()) return;
        Command c = redo.pop();
        c.execute();
        history.push(c);
    }
}
```

Undo가 필요 없으면 람다로 끝낸다. `ExecutorService`가 같은 구조로 동작한다.

```java
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class Main {
    public static void main(String[] args) {
        Light light = new Light();
        RemoteControl remote = new RemoteControl();
        remote.press(new LightOnCommand(light));
        remote.undo();

        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            pool.submit(() -> light.set(true));
            pool.submit(() -> System.out.println("TV on"));
        }
    }
}
```

## 실무에서 걸리는 지점

- Undo가 부작용을 되돌리지 못하는 경우가 있다. 메일 발송, 외부 결제 API 호출처럼 취소 불가능한 수신자를 커맨드로 감쌌다면 `undo()`는 보상 트랜잭션(환불 요청, 정정 메일)이 되고 원래 상태로의 복귀를 보장하지 않는다. ==undo가 역연산인지 보상인지 커맨드마다 명시하지 않으면 사용자가 되돌렸다고 믿는 작업이 실제로는 남아 있다==.
- 이력 스택은 메모리를 계속 차지한다. 커맨드가 큰 이전 상태(문서 전체 스냅샷 등)를 들고 있으면 편집 몇백 번에 힙이 찬다. 스택 크기 상한을 두거나 상태를 차이(diff)로 보관한다. 상태 스냅샷을 커맨드 밖으로 빼는 쪽은 메멘토가 담당한다.
- 이력을 DB에 남겨 재생하려면 커맨드가 직렬화 가능해야 한다. 람다·익명 클래스는 직렬화가 불안정하고 클래스 버전이 바뀌면 옛 이력이 깨진다. 재생 목적이면 커맨드 타입과 인자를 명시적 레코드로 저장한다.
- `ExecutorService`에 던진 람다가 예외를 던지면 ==`submit()`은 예외를 `Future`에 담아 둘 뿐이므로 `get()`을 호출하지 않으면 실패를 알 수 없다==. 로그가 필요하면 `execute()`를 쓰거나 `Future`를 확인한다.
- 매크로 커맨드(여러 커맨드를 순서대로 실행)는 중간에 실패했을 때 앞서 실행한 것을 역순으로 undo해야 원자성이 유지된다. 이 처리를 빠뜨리면 절반만 적용된 상태가 남는다.

## 관련 글

- [메멘토 — 캡슐화를 지키며 상태 저장·복원](/notes/design-patterns/memento/)
- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
- [책임 연쇄 — 핸들러를 사슬로 엮어 순차 처리](/notes/design-patterns/chain-of-responsibility/)
