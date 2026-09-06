---
title: "메멘토 — 캡슐화를 지키며 상태 저장·복원"
series: design-patterns
part: "행위"
order: 20
summary: "private 상태를 getter로 열지 않고 스냅샷을 찍어 되돌리는 방법과 화이트박스·블랙박스 메멘토의 차이"
tags: [Memento, Undo, Encapsulation, Snapshot, Java]
sources: [https://jinwookoh.tistory.com/225]
updated: 2026-09-06
---

편집기의 실행 취소, 폼 입력 도중의 임시 저장, 설정 변경 실패 시 이전 값 복귀는 모두 객체의 어느 시점 상태를 보관했다가 되돌리는 기능이다. 이를 구현하려면 객체의 private 필드값을 밖으로 꺼내 어딘가에 저장해야 하는데, 그 목적으로 모든 필드에 getter와 setter를 추가하면 캡슐화가 무너진다. 상태를 보관하는 쪽이 값을 읽을 수 있으니 값에 의존하는 코드가 생기고, 값을 쓸 수 있으니 원본 객체가 모르는 사이에 상태가 바뀐다. 결국 객체 내부 구조가 바뀔 때마다 저장 코드와 복원 코드를 함께 고쳐야 한다. 메멘토 패턴은 상태를 저장하되 그 내용을 원본 객체 외에는 아무도 해석하지 못하게 만들어 이 문제를 푼다.

## 핵심 개념

참여자는 셋이다. Originator는 상태를 가진 원본 객체로, 자신의 상태를 담은 Memento를 만들고(`save`) Memento를 받아 상태를 되돌린다(`restore`). Memento는 특정 시점의 상태 복사본이다. Caretaker는 Memento를 보관하고 꺼내 주기만 하는 관리자로, 스택이나 리스트로 이력을 유지하지만 Memento의 내용은 알지 못한다.

핵심은 Memento가 두 종류의 인터페이스를 갖는다는 점이다. Originator에게는 필드 전체가 보이는 넓은 인터페이스를, Caretaker에게는 아무 메서드도 없는 좁은 인터페이스만 노출한다. 이 구분을 어떻게 구현하느냐에 따라 두 방식으로 나뉜다.

| 구분 | 화이트박스 메멘토 | 블랙박스 메멘토 |
|---|---|---|
| Memento 형태 | 별도 public 클래스, getter 보유 | Originator 안의 private 중첩 클래스 |
| Caretaker의 접근 | 값을 읽고 조작할 수 있음 | 마커 인터페이스만 보여 내용 접근 불가 |
| 결합도 | Caretaker가 상태 구조에 의존 | Caretaker는 타입만 알고 구조를 모름 |
| 적합한 경우 | 일회성 스크립트, 테스트 픽스처 | 비즈니스 상태의 Undo·롤백 |

화이트박스는 Memento를 일반 DTO처럼 만드는 방식이다. 구현은 쉽지만 getter가 있는 이상 Caretaker든 다른 누구든 값을 읽을 수 있어, 패턴을 도입한 이유였던 캡슐화가 지켜지지 않는다.

블랙박스는 Java의 중첩 클래스 접근 규칙을 이용한다. Memento 구현체를 Originator 안에 private 중첩 클래스로 두면 외부에는 마커 인터페이스 타입으로만 보이고, 실제 필드는 Originator만 읽을 수 있다. 이것이 GoF가 의도한 형태이며, Java 21에서는 sealed 인터페이스와 record를 조합하면 캐스팅 검사와 불변성까지 컴파일러가 보장한다. record의 접근자는 public이지만 record 자체가 private이므로 Originator 밖에서는 호출할 방법이 없다.

Memento는 상태의 복사본이어야 한다. ==Memento가 컬렉션이나 가변 객체의 참조를 그대로 보관하면 이후 원본이 바뀔 때 스냅샷도 함께 바뀌어, 복원해도 현재 상태와 같은 값이 돌아오는 상황이 예외 없이 조용히 발생한다.== 문자열·숫자 같은 불변 값은 그대로 담아도 되지만 `List`·`Map`·날짜 가변 객체는 `List.copyOf` 같은 방어적 복사로 잘라내야 한다.

## 코드

Originator가 sealed 마커 인터페이스와 private record로 블랙박스 Memento를 만든다. `restore`는 패턴 매칭으로 자기 타입인지 검사하고, 다른 Originator가 만든 Memento가 들어오면 거부한다.

```java
public final class Editor {

    public sealed interface Memento permits Snapshot {}

    private record Snapshot(String content, int cursor, List<String> tags)
            implements Memento {
        Snapshot {
            tags = List.copyOf(tags);   // 방어적 복사, 불변 리스트
        }
    }

    private String content = "";
    private int cursor = 0;
    private final List<String> tags = new ArrayList<>();

    public void type(String text) {
        content = content.substring(0, cursor) + text + content.substring(cursor);
        cursor += text.length();
    }

    public void tag(String tag) { tags.add(tag); }

    public Memento save() {
        return new Snapshot(content, cursor, tags);
    }

    public void restore(Memento memento) {
        if (!(memento instanceof Snapshot s)) {
            throw new IllegalArgumentException("unknown memento: " + memento);
        }
        this.content = s.content();
        this.cursor = s.cursor();
        this.tags.clear();
        this.tags.addAll(s.tags());
    }

    public String content() { return content; }
}
```

Caretaker는 Undo와 Redo 스택 두 개를 관리한다. 내용은 모른 채 `Editor.Memento` 타입만 다루고, 상한을 넘으면 가장 오래된 스냅샷을 버린다.

```java
public final class History {
    private final Editor editor;
    private final int limit;
    private final Deque<Editor.Memento> undo = new ArrayDeque<>();
    private final Deque<Editor.Memento> redo = new ArrayDeque<>();

    public History(Editor editor, int limit) {
        this.editor = editor;
        this.limit = limit;
    }

    // 변경 직전에 호출해 현재 상태를 기록한다
    public void checkpoint() {
        undo.push(editor.save());
        if (undo.size() > limit) undo.removeLast();
        redo.clear();
    }

    public boolean undo() {
        if (undo.isEmpty()) return false;
        redo.push(editor.save());
        editor.restore(undo.pop());
        return true;
    }

    public boolean redo() {
        if (redo.isEmpty()) return false;
        undo.push(editor.save());
        editor.restore(redo.pop());
        return true;
    }
}
```

사용 흐름이다. `checkpoint`는 상태를 바꾸기 전에 호출해야 되돌릴 지점이 남는다.

```java
Editor editor = new Editor();
History history = new History(editor, 50);

history.checkpoint();
editor.type("hello");
history.checkpoint();
editor.type(" world");

history.undo();                 // "hello"
history.undo();                 // ""
history.redo();                 // "hello"
```

## 실무에서 걸리는 지점

- 얕은 복사. 위 코드에서 `List.copyOf`를 빼면 `tags`는 스냅샷과 원본이 같은 리스트를 가리킨다. 테스트에서 문자열 필드만 검증하면 통과하므로 컬렉션·중첩 객체 필드가 있는 Originator는 복원 후 원본을 수정했을 때 스냅샷이 유지되는지를 별도로 검증해야 한다.
- 메모리. 스냅샷마다 상태 전체를 복사하므로 상태가 크고 변경이 잦으면 이력이 힙을 잠식한다. ==Undo 스택에 상한을 두지 않으면 장시간 켜 둔 세션에서 OutOfMemoryError가 나며, 서버 측 세션에 보관할 때는 사용자 수만큼 곱해진다.== 상태가 크면 전체 스냅샷 대신 커맨드 패턴으로 변경 연산과 역연산을 기록하는 편이 낫다.
- 영속화. Memento를 파일이나 DB에 직렬화하면 Originator의 필드가 추가·삭제될 때 옛 스냅샷을 복원할 수 없다. 저장 형식에 버전 번호를 넣고 마이그레이션 경로를 두거나, 영속 스냅샷은 애초에 애플리케이션 객체가 아닌 별도 스키마로 설계한다.
- JPA 엔티티. 영속 상태 엔티티에 `restore`로 필드를 되돌리면 더티 체킹이 그 변경을 감지해 트랜잭션 커밋 시 UPDATE가 나간다. 의도한 동작이면 문제없지만 화면용 임시 Undo였다면 DB까지 되돌아간다. 트랜잭션 안의 롤백은 DB 언두 로그가 담당하므로 그 범위를 메멘토로 흉내 낼 필요는 없다.
- 동시성. Originator를 여러 스레드가 수정한다면 `save` 도중 필드가 바뀌어 일관되지 않은 스냅샷이 만들어진다. 상태 전체를 하나의 불변 객체로 들고 원자적으로 교체하는 구조로 바꾸면 스냅샷은 그 참조를 담는 것으로 끝난다.

## 관련 글

- [커맨드 — 요청을 객체로 캡슐화하고 Undo 구현](/notes/design-patterns/command/)
- [프로토타입 — 복제로 생성하기와 깊은 복사 함정](/notes/design-patterns/prototype/)
- [상태 — 상태별 분기를 객체로 옮기기](/notes/design-patterns/state/)
