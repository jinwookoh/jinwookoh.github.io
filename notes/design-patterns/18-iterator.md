---
title: "이터레이터 — 내부 구조를 감추고 순회하기"
series: design-patterns
part: "행위"
order: 18
summary: "컬렉션 내부 구조를 노출하지 않고 순회하는 외부 반복자와 내부 반복자의 차이, Java Iterator와 Stream의 선택 기준"
tags: [Iterator, Iterable, Stream, Spliterator, Java]
sources: [https://jinwookoh.tistory.com/215]
updated: 2026-09-06
---

컬렉션을 순회하는 코드가 저장 방식에 묶이면 호출부마다 자료구조별 지식이 흩어진다. 배열은 인덱스로, 연결 리스트는 다음 노드 참조로, 트리는 스택이나 재귀로 돌아야 하므로 저장 구조를 바꾸는 순간 모든 순회 코드가 함께 바뀐다. 내부 배열이나 노드를 getter로 노출하면 캡슐화가 깨진다. 이터레이터 패턴은 순회 책임을 별도 객체로 떼어내어, 컬렉션이 내부 구조를 감춘 채 "다음 요소가 있는가"와 "다음 요소는 무엇인가"라는 두 질문에만 답하게 한다.

## 핵심 개념

구조는 두 인터페이스로 이루어진다. Aggregate는 자신을 순회할 Iterator를 만들어 돌려주고, Iterator는 `hasNext()`와 `next()`로 순회를 진행한다. Java에서는 각각 `Iterable<T>`와 `Iterator<T>`에 대응하며, 확장 for 문은 컴파일 시 `iterator()` 호출과 `hasNext()`/`next()` 루프로 변환된다. 순회 위치(커서)는 컬렉션이 아니라 Iterator 객체가 갖는다. 그래서 같은 컬렉션에 대해 독립적인 순회를 여러 개 동시에 진행할 수 있고, 하나의 Iterator는 단방향 일회용이므로 다시 돌려면 `iterator()`를 새로 호출해야 한다.

순회의 제어권이 누구에게 있는지에 따라 두 방식으로 나뉜다.

외부 반복자(external iterator)는 클라이언트가 `next()`를 호출하며 진행을 직접 제어한다. 언제 멈출지, 어떤 요소를 건너뛸지, 두 컬렉션을 나란히 전진시킬지를 호출부가 결정한다.

내부 반복자(internal iterator)는 클라이언트가 요소에 적용할 동작만 넘기고 순회 자체는 컬렉션이 수행한다. `Iterable.forEach`와 Stream API가 여기에 속한다. 무엇을 할지만 선언하므로 코드가 짧고, 순회 방법이 라이브러리 안에 있어 `parallel()`처럼 실행 전략을 바꾸는 일도 라이브러리에 맡길 수 있다. 대신 `forEach` 람다 안에서는 `break`가 불가능하고 체크 예외를 밖으로 던질 수 없다. Stream에서 중간에 멈추는 수단은 `findFirst`, `anyMatch`, `takeWhile` 같은 단락(short-circuit) 연산뿐이다.

| 구분 | 외부 반복자 | 내부 반복자 |
|---|---|---|
| 제어 주체 | 호출부 | 컬렉션·라이브러리 |
| Java 대응 | `Iterator`, 확장 for 문 | `forEach`, `Stream` |
| 중간 중단 | `break`, `return` 자유 | 단락 연산으로만 가능 |
| 다중 컬렉션 동시 순회 | 직접 가능 | 어렵다 |
| 병렬 처리 | 직접 구현 | `parallel()`로 위임 |

Stream의 병렬화는 `Spliterator`가 담당한다. `trySplit()`으로 담당 구간을 나누어 다른 스레드에 넘기는 분할 가능한 반복자다. `ArrayList`처럼 크기를 알고 임의 접근이 되는 소스는 균등하게 쪼개지지만, `LinkedList`나 `Iterator`에서 만든 Stream은 분할 효율이 낮아 병렬화 이득이 거의 없다.

## 코드

정렬 이진 트리를 중위 순회하는 Iterator다. 재귀 대신 스택에 경로를 저장해 순회 상태를 Iterator 객체 안에 두고, 호출부는 트리 구조를 모른 채 확장 for 문으로 순회한다.

```java
import java.util.*;

public final class SortedTree<T extends Comparable<T>> implements Iterable<T> {

    private record Node<V>(V value, Node<V> left, Node<V> right) {}

    private Node<T> root;

    public void add(T value) {
        root = insert(root, value);
    }

    private Node<T> insert(Node<T> node, T value) {
        if (node == null) return new Node<>(value, null, null);
        return value.compareTo(node.value()) < 0
            ? new Node<>(node.value(), insert(node.left(), value), node.right())
            : new Node<>(node.value(), node.left(), insert(node.right(), value));
    }

    @Override
    public Iterator<T> iterator() {
        return new Iterator<>() {
            private final Deque<Node<T>> stack = new ArrayDeque<>();
            { pushLeft(root); }

            private void pushLeft(Node<T> node) {
                for (; node != null; node = node.left()) stack.push(node);
            }

            @Override
            public boolean hasNext() {
                return !stack.isEmpty();
            }

            @Override
            public T next() {
                if (stack.isEmpty()) throw new NoSuchElementException();
                Node<T> node = stack.pop();
                pushLeft(node.right());
                return node.value();
            }
        };
    }
}

// 사용
SortedTree<Integer> tree = new SortedTree<>();
List.of(5, 2, 8, 1).forEach(tree::add);
for (int v : tree) {
    System.out.println(v); // 1 2 5 8
}
```

외부 반복자가 필요한 두 경우다. 두 리스트를 나란히 전진시키며 첫 불일치 위치를 찾는 작업과, 순회 중 `Iterator.remove()`로 요소를 제거하는 작업은 `forEach`로 표현하기 어렵다.

```java
import java.time.Instant;
import java.util.Iterator;
import java.util.List;

record Session(String id, Instant expiresAt) {}

static int firstMismatch(List<String> expected, List<String> actual) {
    Iterator<String> a = expected.iterator();
    Iterator<String> b = actual.iterator();
    int index = 0;
    while (a.hasNext() && b.hasNext()) {
        if (!a.next().equals(b.next())) return index;
        index++;
    }
    return (a.hasNext() || b.hasNext()) ? index : -1;
}

static void expire(List<Session> sessions, Instant now) {
    Iterator<Session> it = sessions.iterator();
    while (it.hasNext()) {
        if (it.next().expiresAt().isBefore(now)) {
            it.remove(); // 순회 중 안전한 제거
        }
    }
}
```

내부 반복자다. 필터와 변환 파이프라인은 Stream이 간결하고, 조건부 중단은 `findFirst` 같은 단락 연산으로 표현한다.

```java
import java.time.Instant;
import java.util.List;
import java.util.Optional;

record User(String email, boolean active) {}
record Order(String id, Instant dueAt) {}

static List<String> activeEmails(List<User> users) {
    return users.stream()
        .filter(User::active)
        .map(User::email)
        .toList();
}

static Optional<Order> firstOverdue(List<Order> orders, Instant now) {
    return orders.stream()
        .filter(o -> o.dueAt().isBefore(now))
        .findFirst(); // 첫 일치 요소 이후 순회를 멈춘다
}
```

## 실무에서 걸리는 지점

**순회 중 컬렉션 직접 수정.** 확장 for 문 안에서 `list.remove(x)`를 호출하면 fail-fast 검사에 걸려 `ConcurrentModificationException`이 난다. 이 검사는 보장이 아니라 best-effort다. ==`ArrayList`에서 뒤에서 두 번째 요소를 제거하면 커서가 크기와 같아져 `hasNext()`가 false를 돌려주고, 마지막 요소를 건너뛴 채 예외 없이 끝난다==. 제거는 `Iterator.remove()`나 `removeIf`, 또는 새 컬렉션으로 수집하는 방식으로 한다.

**일회용 순회.** Stream은 종단 연산을 한 번 실행하면 재사용할 수 없고 두 번째 사용에서 `IllegalStateException`이 난다. 재순회가 필요하면 `Supplier<Stream<T>>`로 매번 새로 만들거나 리스트로 수집한다.

**`parallelStream`의 공용 풀.** 병렬 Stream은 JVM 전체가 공유하는 `ForkJoinPool.commonPool()`에서 실행된다. ==HTTP 호출이나 DB 조회 같은 블로킹 작업을 병렬 Stream에 넣으면 공용 풀 스레드가 점유되어 같은 풀을 쓰는 다른 `parallel()`, `CompletableFuture` 작업까지 지연된다==. 병렬화는 CPU 바운드 작업에 한정하고, 순서가 중요하면 `forEach` 대신 `forEachOrdered`를 쓴다.

**DB 커서 기반 Stream.** Spring Data JPA의 `Stream<T>` 반환 메서드나 JDBC 커서 위에 만든 Iterator는 커넥션을 열어 둔 채 지연 조회한다. ==트랜잭션 범위 밖에서 `next()`를 호출하면 커넥션이 이미 반환되어 실패하고, try-with-resources로 닫지 않으면 커넥션이 누수된다==. `@Transactional(readOnly = true)` 메서드 안에서 소비를 끝내야 한다.

## 관련 글

- [컴포지트 — 개별 객체와 트리를 같은 인터페이스로](/notes/design-patterns/composite/)
- [방문자 — 클래스 수정 없이 연산 추가하기](/notes/design-patterns/visitor/)
- [템플릿 메서드 — 골격은 고정하고 단계만 바꾸기](/notes/design-patterns/template-method/)
