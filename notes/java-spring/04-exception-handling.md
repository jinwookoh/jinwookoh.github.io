---
title: "예외 처리"
series: java-spring
part: "자바 기초·모던 자바"
order: 4
summary: "체크드와 언체크드 예외의 경계를 정확히 긋고, try-with-resources와 예외 체이닝으로 자원 누수와 원인 소실을 막는 방법을 정리한다."
tags: [Java, Exception, try-with-resources, RuntimeException, Spring]
sources: [spring/2026-05-17-java-exception-handling.md]
updated: 2026-08-29
---

예외 처리 체계가 없으면 비정상 상황을 반환값으로 표현해야 한다. 실패를 `-1`이나 `null`로 돌려주는 방식은 호출자가 검사를 빠뜨려도 컴파일러가 알려주지 않고, 실패 지점과 실제 오류가 드러나는 지점이 멀어져 원인 추적이 어렵다. 자원 정리도 문제다. 파일이나 DB 커넥션을 연 뒤 중간에 실패하면 닫는 코드까지 도달하지 못해 핸들과 커넥션이 누수된다. 자바 예외는 실패를 일반 흐름과 분리된 별도 경로로 전파하고, 스택 트레이스로 발생 지점을 보존하며, `finally`와 try-with-resources로 자원 해제를 보장하는 장치다.

## 핵심 개념

예외는 `Throwable`을 상속한 객체다. `Throwable` 아래에 `Error`와 `Exception`이 있고, `Exception` 아래에 다시 `RuntimeException`이 있다. `Error`는 `OutOfMemoryError`처럼 애플리케이션이 복구할 수 없는 JVM 수준 문제이므로 잡지 않는다. 실제 설계 판단이 갈리는 지점은 `Exception`의 두 갈래다.

| 구분 | 체크드 예외 | 언체크드 예외 |
|---|---|---|
| 상속 | `Exception` 직접 상속 (`RuntimeException` 제외) | `RuntimeException` 상속 |
| 대표 | `IOException`, `SQLException`, `InterruptedException` | `NullPointerException`, `IllegalArgumentException`, `IllegalStateException` |
| 컴파일러 | `throws` 선언 또는 `try-catch` 강제 | 강제 없음 |
| 의도 | 호출자가 복구 가능한 외부 요인 | 프로그래밍 오류 또는 복구 불가한 상태 |

체크드 예외는 호출자가 반드시 인지하도록 컴파일 단계에서 강제한다는 취지로 설계됐으나, 실제로는 호출 계층마다 `throws` 목록이 늘어나고 복구 의미 없는 `catch`가 반복되는 부작용이 컸다. 이 때문에 Spring은 `SQLException`을 `DataAccessException` 계층으로 변환하는 등 프레임워크 전반을 언체크드 예외로 설계했고, 현대 자바 코드도 도메인 예외를 `RuntimeException` 기반으로 정의하는 것이 표준이다. 체크드 예외를 만나면 그 자리에서 의미 있는 언체크드 예외로 감싸 던진다.

`try-catch`는 위에서 아래로 첫 매칭 블록만 실행하므로 구체 타입을 먼저, 상위 타입을 나중에 둔다. `Exception`을 첫 번째에 두면 그 아래 블록은 도달 불가 코드가 되어 컴파일 에러가 난다. 처리 로직이 같은 예외는 `catch (A | B e)` 멀티 캐치로 합친다.

`finally`는 예외 발생 여부와 무관하게 실행되지만 자원 해제 용도로는 try-with-resources가 우선이다. `AutoCloseable`을 구현한 객체를 `try (...)` 괄호에 선언하면 블록 종료 시 선언 역순으로 `close()`가 호출된다. `close()` 중 예외가 나더라도 본문 예외가 우선 전파되고 `close()` 예외는 suppressed로 첨부되므로 원인이 소실되지 않는다. `finally`에서 직접 `close()`를 부르는 방식은 이 두 가지를 보장하지 못한다.

예외를 변환할 때는 원인 예외를 생성자 두 번째 인자로 넘긴다. `getCause()`로 원인이 연결되고 스택 트레이스에 `Caused by:`로 출력된다. 원인을 빼고 메시지만 옮기면 실제 실패 지점이 사라진다.

## 코드

도메인 예외는 `RuntimeException`을 상속하고, 핸들러가 응답을 만들 때 필요한 값을 필드로 보존한다.

```java
public class InsufficientBalanceException extends RuntimeException {

    private final long currentBalance;
    private final long requested;

    public InsufficientBalanceException(long currentBalance, long requested) {
        super("잔액 부족: 현재 %d, 요청 %d".formatted(currentBalance, requested));
        this.currentBalance = currentBalance;
        this.requested = requested;
    }

    public long currentBalance() { return currentBalance; }
    public long requested() { return requested; }
}

public class Account {

    private long balance;

    public void withdraw(long amount) {
        if (amount <= 0) {
            throw new IllegalArgumentException("금액은 양수여야 한다: " + amount);
        }
        if (amount > balance) {
            throw new InsufficientBalanceException(balance, amount);
        }
        balance -= amount;
    }
}
```

체크드 예외를 경계에서 언체크드로 변환하면서 원인을 보존하고, try-with-resources로 자원을 닫는다.

```java
public class ConfigLoader {

    public Properties load(Path path) {
        try (var reader = Files.newBufferedReader(path)) {
            var props = new Properties();
            props.load(reader);
            return props;
        } catch (NoSuchFileException e) {
            throw new ConfigNotFoundException(path, e);
        } catch (IOException e) {
            throw new UncheckedIOException("설정 파일 읽기 실패: " + path, e);
        }
    }
}
```

Spring Boot 3.x에서는 `@RestControllerAdvice`와 RFC 9457 표준 응답인 `ProblemDetail`로 도메인 예외를 HTTP 응답으로 변환한다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(InsufficientBalanceException.class)
    public ProblemDetail handle(InsufficientBalanceException e) {
        var problem = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage());
        problem.setTitle("Insufficient balance");
        problem.setProperty("currentBalance", e.currentBalance());
        problem.setProperty("requested", e.requested());
        return problem;
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ProblemDetail handleBadRequest(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }
}
```

## 실무에서 걸리는 지점

- **빈 catch와 원인 없는 재던지기.** `catch (Exception e) {}`는 장애를 묵살하고, `throw new XxxException(e.getMessage())`는 스택 트레이스를 버린다. 잡았으면 로그를 남기거나 원인을 붙여 다시 던지는 둘 중 하나를 반드시 한다. 로그와 재던지기를 동시에 하면 상위 계층에서 같은 예외가 중복 기록되므로 한 계층에서만 로그를 남긴다.
- **예외로 흐름 제어.** 예외 생성 시 `fillInStackTrace()`가 스택을 캡처하므로 정상 흐름에서 초당 수천 번 던지면 비용이 눈에 띈다. 존재 여부 확인 같은 예상 가능한 분기는 `Optional`이나 boolean 반환으로 처리한다. 스택이 불필요한 예외라면 `writableStackTrace=false` 생성자를 쓴다.
- **`InterruptedException` 삼키기.** 잡은 뒤 아무 처리도 하지 않으면 스레드의 인터럽트 플래그가 지워져 종료 신호가 사라진다. `Thread.currentThread().interrupt()`로 플래그를 복원한 뒤 종료하거나 언체크드 예외로 감싼다. Virtual Thread 환경에서도 동일하다.
- **`@Transactional` 롤백 규칙.** 기본 설정은 `RuntimeException`과 `Error`에서만 롤백하고 체크드 예외는 커밋한다. 체크드 예외를 그대로 전파하는 서비스 메서드는 실패했는데 커밋되는 상황을 만든다. 도메인 예외를 언체크드로 통일하면 이 문제가 사라진다.
- **`finally`에서의 `return`.** `finally` 블록에 `return`이 있으면 `try`에서 던진 예외가 무시된다. `finally`는 정리 작업만 두고 제어 흐름을 바꾸지 않는다.

## 관련 글

- [컬렉션·제네릭·Optional](/notes/java-spring/collections-generics-optional/)
- [예외 처리와 검증 — @ControllerAdvice·Bean Validation](/notes/java-spring/exception-handling-validation/)
- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
