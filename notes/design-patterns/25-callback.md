---
title: "콜백 — 동기·비동기 콜백과 제어 흐름"
series: design-patterns
part: "확장"
order: 25
summary: "콜백은 호출 대상에게 실행할 코드를 넘기는 기법이며, 동기와 비동기의 차이는 제어권이 언제 어느 스레드에서 돌아오는가에 있다."
tags: [Callback, CompletableFuture, Template Callback, Asynchronous, Java]
sources: [https://jinwookoh.tistory.com/230]
updated: 2026-09-06
---

메서드는 보통 호출한 쪽이 결과를 반환값으로 받는 구조다. 이 구조만으로는 두 가지 요구를 처리하기 어렵다. 하나는 트랜잭션 시작과 종료, 자원 열기와 닫기처럼 골격은 같고 가운데 한 단계만 다른 코드가 여러 곳에 반복되는 경우다. 골격을 메서드로 추출하려 해도 가운데 단계를 외부에서 채울 방법이 없어 복사가 이어진다. 다른 하나는 네트워크 응답이나 파일 읽기처럼 언제 끝날지 모르는 작업이다. 반환값을 기다리면 호출 스레드가 그 시간 동안 아무것도 못 한다. 콜백은 "끝나면 이 코드를 실행하라"는 형태로 실행할 코드 자체를 인자로 넘겨, 골격의 빈칸을 채우고 완료 시점의 처리를 호출자 대신 피호출자가 결정하게 한다.

## 핵심 개념

콜백은 함수를 값으로 전달하는 기법이다. Java에서는 메서드 하나짜리 인터페이스, 즉 함수형 인터페이스가 콜백 타입이 되고 람다나 메서드 참조가 그 구현이 된다. 호출자가 피호출자를 부르고 결과를 받는 일반 호출과 달리, 콜백에서는 피호출자가 적절한 시점에 호출자가 넘긴 코드를 되돌려 부른다. 제어의 역전이라 부르는 이 방향 전환이 콜백의 핵심이며, 프레임워크가 애플리케이션 코드를 호출하는 구조도 같은 원리다.

콜백은 실행 시점과 스레드에 따라 두 종류로 나뉜다. 동기 콜백은 피호출자가 자기 실행 흐름 안에서 콜백을 호출하고, 콜백이 끝나야 다음 줄로 넘어간다. `List.forEach`에 넘기는 람다, `Comparator`, Spring의 `JdbcTemplate`과 `TransactionTemplate`이 받는 콜백이 여기에 속한다. 코드 순서와 실행 순서가 일치하고 예외가 호출 스택을 따라 그대로 올라오므로 디버깅이 쉽다. 대신 콜백이 오래 걸리면 호출자도 그만큼 멈춘다.

비동기 콜백은 피호출자가 작업을 다른 스레드나 이벤트 루프에 넘기고 즉시 반환한다. 콜백은 작업이 끝난 뒤 호출자와 다른 스레드에서 실행된다. `CompletableFuture`의 `thenAccept`, 이벤트 리스너, 타이머가 이 방식이다. 호출 스레드가 대기하지 않아 처리량과 반응성이 좋아지지만, 실행 순서를 코드만 보고 알 수 없고 예외가 호출자에게 전파되지 않는다.

| 구분 | 동기 콜백 | 비동기 콜백 |
|---|---|---|
| 반환 시점 | 콜백 실행이 끝난 뒤 | 작업 등록 직후 |
| 실행 스레드 | 호출자와 같음 | 별도 스레드 또는 이벤트 루프 |
| 예외 전파 | 호출 스택으로 올라옴 | 호출자에게 오지 않음 |
| 용도 | 템플릿 콜백, 순회, 정렬 | I/O, 타이머, 이벤트 처리 |

비동기 콜백을 중첩하면 결과를 받아 다음 요청을 보내고 그 결과로 또 요청하는 코드가 들여쓰기 단계로 쌓인다. Java 8 이후의 `CompletableFuture`는 콜백을 체인으로 연결하고 실패 경로를 `exceptionally`나 `handle`로 한곳에 모아 이 문제를 줄인다. Java 21의 가상 스레드는 다른 접근을 택한다. 블로킹 호출을 그대로 쓰되 스레드를 가볍게 만들어, 동기 코드 형태를 유지하면서 비동기 수준의 처리량을 얻는다.

## 코드

동기 콜백. 골격은 실행기가 갖고 가운데 단계만 호출자가 채운다. 콜백이 끝나야 "작업 종료"가 찍힌다.

```java
@FunctionalInterface
interface Task<T> {
    T run();
}

class TaskExecutor {
    <T> T execute(Task<T> task) {
        System.out.println("1. 작업 시작");
        T result = task.run();
        System.out.println("3. 작업 종료");
        return result;
    }
}

public class SyncMain {
    public static void main(String[] args) {
        var executor = new TaskExecutor();
        String result = executor.execute(() -> {
            System.out.println("2. 콜백 실행");
            return "done";
        });
        System.out.println("4. 결과: " + result);
    }
}
```

비동기 콜백. 작업을 실행기에 넘기고 곧바로 반환하므로 "다음 작업 진행"이 콜백보다 먼저 찍힌다. `Executors.newVirtualThreadPerTaskExecutor()`는 Java 21의 가상 스레드 실행기다.

```java
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

class AsyncTaskExecutor {
    private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();

    void executeAsync(Consumer<String> onComplete) {
        System.out.println("1. 작업 요청");
        pool.submit(() -> {
            try {
                Thread.sleep(500);
                onComplete.accept("payload");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        System.out.println("3. 다음 작업 진행");
    }
}

public class AsyncMain {
    public static void main(String[] args) throws InterruptedException {
        new AsyncTaskExecutor().executeAsync(
            data -> System.out.println("2. 콜백 실행: " + data));
        System.out.println("4. main 종료 직전");
        Thread.sleep(1000);
    }
}
```

`CompletableFuture` 체인. 조회, 변환, 소비를 단계별로 연결하고 어느 단계에서 실패하든 `exceptionally` 한곳에서 받는다.

```java
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

public class ChainMain {
    static CompletableFuture<Void> load(String id, Executor executor) {
        return CompletableFuture
            .supplyAsync(() -> repository(id), executor)
            .thenApply(String::toUpperCase)
            .thenAccept(v -> System.out.println("처리 완료: " + v))
            .exceptionally(ex -> {
                System.out.println("실패: " + ex.getCause().getMessage());
                return null;
            });
    }

    static String repository(String id) {
        if (id.isBlank()) throw new IllegalArgumentException("empty id");
        return "row-" + id;
    }

    public static void main(String[] args) {
        Executor executor = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
        load("42", executor).join();
        load("", executor).join();
    }
}
```

## 실무에서 걸리는 지점

- `supplyAsync`와 `runAsync`에 실행기를 넘기지 않으면 `ForkJoinPool.commonPool()`을 쓴다. ==공용 풀은 CPU 코어 수 - 1개의 스레드만 가지므로 여기서 DB나 HTTP 같은 블로킹 I/O를 하면 병렬 스트림과 다른 비동기 작업까지 함께 멈춘다.== I/O 작업은 전용 실행기나 가상 스레드 실행기를 명시한다.
- 비동기 콜백 안에서 던진 예외는 호출 스레드로 오지 않는다. ==`thenAccept`로 끝나는 체인에 `exceptionally`나 `handle`을 붙이지 않으면 실패가 로그 한 줄 없이 사라진다.== `join`을 호출하는 곳이 있으면 그때 `CompletionException`으로 드러나지만, 결과를 기다리지 않는 fire-and-forget 체인은 반드시 실패 경로를 끝에 붙인다.
- 콜백이 실행되는 스레드는 호출자와 다르다. `ThreadLocal`에 의존하는 `SecurityContextHolder`, `RequestContextHolder`, MDC의 값은 콜백에서 비어 있다. Spring 6.1 이상은 `TaskDecorator`나 Micrometer의 `ContextSnapshot`으로 값을 옮길 수 있고, 트랜잭션 경계도 콜백까지 이어지지 않으므로 콜백 안의 DB 쓰기는 별도 트랜잭션으로 취급해야 한다.
- 동기 콜백에 무거운 작업을 넣으면 템플릿이 잡고 있는 자원의 점유 시간이 늘어난다. `TransactionTemplate` 콜백 안에서 외부 API를 호출하면 응답을 기다리는 동안 DB 커넥션과 락을 유지하게 되어 커넥션 풀 고갈로 번진다. 외부 호출은 트랜잭션 밖으로 빼거나 트랜잭션 커밋 이후로 미룬다.
- 콜백에 넘긴 람다가 바깥 객체의 상태를 캡처하면 비동기 실행 시 그 상태가 다른 스레드에서 읽히고 쓰인다. 가변 필드를 캡처한 콜백은 경쟁 조건의 원인이 되므로 필요한 값을 불변으로 복사해 넘기고, 완료 순서에 의존하는 로직은 `thenCombine`이나 `allOf`로 명시적으로 합류시킨다.

## 관련 글

- [템플릿 메서드 — 골격은 고정하고 단계만 바꾸기](/notes/design-patterns/template-method/)
- [옵저버와 Pub/Sub — 직접 구독과 브로커 경유의 차이](/notes/design-patterns/observer-pubsub/)
- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
