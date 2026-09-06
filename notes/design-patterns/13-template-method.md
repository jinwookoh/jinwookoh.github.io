---
title: "템플릿 메서드 — 골격은 고정하고 단계만 바꾸기"
series: design-patterns
part: "행위"
order: 13
summary: "알고리즘 골격을 한곳에 고정하고 변하는 단계만 상속 또는 콜백으로 채우는 두 구현과 선택 기준"
tags: [Template Method, Template Callback, Hook, JdbcTemplate, TransactionTemplate]
sources: [https://jinwookoh.tistory.com/213]
updated: 2026-09-06
---

JSON·CSV·XML 파일을 각각 읽어 처리하는 클래스가 있다고 하자. 세 클래스 모두 파일을 열고, 내용을 해석하고, 결과를 저장하고, 자원을 닫는 순서가 같다. 다른 것은 "내용을 해석하는" 한 단계뿐이다. 클래스마다 전체 흐름을 복사해 두면 열기·닫기 코드가 세 벌 생기고, 예외 발생 시 자원을 닫는 로직을 고칠 때 한 곳을 빠뜨리면 그 처리기만 파일 핸들을 누수한다. 불변 흐름은 한곳에 두고 달라지는 단계만 바깥에서 채우도록 만드는 것이 템플릿 메서드 패턴이다.

## 핵심 개념

템플릿 메서드는 알고리즘의 골격을 하나의 메서드로 정의하고, 골격 안의 일부 단계를 하위 클래스가 재정의하도록 열어 두는 패턴이다. 골격을 정의한 메서드가 템플릿 메서드이고, 하위 클래스가 채우는 단계가 원시 연산(primitive operation)이다. 호출 순서·예외 처리·자원 해제 같은 불변 부분은 부모가 소유하므로 한곳에서만 관리된다.

단계는 두 종류로 나뉜다. 반드시 구현해야 하는 단계는 abstract 메서드로 선언한다. 기본 동작이 있으나 필요하면 바꿀 수 있는 단계는 빈 본문이나 기본 구현을 가진 protected 메서드로 두는데, 이를 훅(hook)이라 부른다. 훅은 "처리 전 검증", "처리 후 통계 기록"처럼 대부분의 하위 클래스가 신경 쓰지 않아도 되는 지점에 넣는다.

템플릿 메서드 자체는 final로 선언한다. 하위 클래스가 골격을 재정의하면 이 패턴을 쓰는 이유가 사라진다. 제어 흐름이 부모에서 자식으로 내려간다는 점에서 자식이 부모를 호출하는 일반적인 상속 사용과 방향이 반대다.

구현 방식은 두 가지다. 고전적 GoF 구현은 상속을 사용한다. 추상 클래스가 골격을 갖고, 변하는 단계마다 하위 클래스를 하나씩 만든다. HttpServlet의 service()가 요청 메서드에 따라 doGet·doPost를 호출하는 구조, Spring의 AbstractApplicationContext.refresh()가 이 방식이다.

템플릿 콜백은 상속 대신 합성을 사용한다. 골격을 가진 클래스는 일반 클래스이고, 변하는 단계를 함수형 인터페이스로 받아 메서드 파라미터로 주입한다. 호출자는 하위 클래스를 만들지 않고 람다로 단계를 넘긴다. Spring의 JdbcTemplate·TransactionTemplate·RedisTemplate이 이 방식이며, 전략 패턴과 템플릿 메서드를 결합한 형태다. HTTP 클라이언트는 과거 RestTemplate이 대표 사례였으나 현재는 유지보수 모드이므로 새 코드에는 RestClient를 쓴다.

| 구분 | 템플릿 메서드(상속) | 템플릿 콜백(합성) |
|---|---|---|
| 변하는 단계 전달 | abstract·protected 메서드 재정의 | 함수형 인터페이스를 파라미터로 주입 |
| 단계 하나당 필요한 것 | 하위 클래스 1개 | 람다 1개 |
| 골격 클래스 인스턴스 | 하위 클래스마다 별도 | 싱글톤 빈 하나를 공유 |
| 변하는 단계가 여럿일 때 | 메서드를 늘리면 된다 | 콜백 인터페이스가 늘어 복잡해진다 |
| 대표 사례 | HttpServlet, AbstractApplicationContext | JdbcTemplate, TransactionTemplate |

## 코드

상속 방식이다. 골격 process()는 final이고, parse()는 필수 단계, validate()와 afterParse()는 기본 구현이 있는 훅이다.

```java
public record Result(int rowCount) {}

public abstract class FileProcessor {

    public final Result process(Path path) throws IOException {
        validate(path);
        try (BufferedReader reader = Files.newBufferedReader(path)) {
            Result result = parse(reader);
            afterParse(result);
            return result;
        }
    }

    protected void validate(Path path) {
        if (!Files.isRegularFile(path)) {
            throw new IllegalArgumentException("not a regular file: " + path);
        }
    }

    protected abstract Result parse(BufferedReader reader) throws IOException;

    protected void afterParse(Result result) {
    }
}

public class CsvFileProcessor extends FileProcessor {

    @Override
    protected Result parse(BufferedReader reader) throws IOException {
        List<String[]> rows = reader.lines()
                .map(line -> line.split(","))
                .toList();
        return new Result(rows.size());
    }
}
```

같은 골격을 템플릿 콜백으로 바꾼 것이다. 하위 클래스 없이 람다로 단계를 넘기고, 템플릿은 싱글톤 빈으로 재사용한다.

```java
@FunctionalInterface
public interface ParseCallback<T> {
    T parse(BufferedReader reader) throws IOException;
}

@Component
public class FileTemplate {

    public <T> T process(Path path, ParseCallback<T> callback) {
        try (BufferedReader reader = Files.newBufferedReader(path)) {
            return callback.parse(reader);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

// 호출 측
long lines = fileTemplate.process(path, reader -> reader.lines().count());
List<String> headers = fileTemplate.process(path,
        reader -> List.of(reader.readLine().split(",")));
```

Spring의 TransactionTemplate도 같은 구조다. 트랜잭션 시작·커밋·롤백이 골격이고, 람다가 변하는 단계다.

```java
@Service
public class OrderService {

    private final TransactionTemplate tx;
    private final JdbcClient jdbc;

    public OrderService(PlatformTransactionManager tm, JdbcClient jdbc) {
        this.tx = new TransactionTemplate(tm);
        this.jdbc = jdbc;
    }

    public int place(long userId, long amount) {
        return tx.execute(status -> {
            jdbc.sql("UPDATE account SET balance = balance - ? WHERE id = ?")
                    .params(amount, userId).update();
            return jdbc.sql("INSERT INTO orders(user_id, amount) VALUES (?, ?)")
                    .params(userId, amount).update();
        });
    }
}
```

## 실무에서 걸리는 지점

- **final 메서드와 프록시 AOP.** ==골격 메서드를 final로 선언하면 CGLIB 프록시가 그 메서드를 가로채지 못하므로 @Transactional·@Cacheable 같은 프록시 기반 AOP가 적용되지 않는다.== 예외 없이 그냥 동작하지 않는 것이므로 눈에 띄지 않는다. 트랜잭션이 필요하면 상속 방식 대신 TransactionTemplate 콜백으로 묶거나 AOP를 다른 계층에 건다.
- **생성자에서 단계 메서드 호출.** ==부모 생성자에서 abstract 단계나 훅을 호출하면 하위 클래스 필드가 초기화되기 전에 실행되어 null을 읽는다.== 단계 메서드는 템플릿 메서드 안에서만 호출한다.
- **콜백 안에서 예외를 삼키는 경우.** ==TransactionTemplate 콜백 안에서 예외를 catch하고 로그만 남기면 템플릿은 정상 완료로 판단해 커밋한다.== 롤백이 필요하면 예외를 다시 던지거나 status.setRollbackOnly()를 호출한다.
- **콜백 실행 횟수.** 콜백이 몇 번 실행되는지는 템플릿이 정한다. RetryTemplate처럼 재시도하는 템플릿에 외부 카운터를 증가시키는 람다를 넘기면 실패 횟수만큼 중복 실행되므로, 재시도 템플릿에 넘기는 콜백은 멱등해야 한다.
- **훅 남발과 클래스 폭발.** 훅이 대여섯 개를 넘으면 호출 순서를 문서 없이 알 수 없고, 하위 클래스가 어느 훅을 재정의했는지 추적하기 어렵다. 변하는 축이 둘 이상이면 상속 하나로 표현하지 말고 전략이나 브리지로 축을 분리한다.

## 관련 글

- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
- [콜백 — 동기·비동기 콜백과 제어 흐름](/notes/design-patterns/callback/)
- [브리지 — 추상과 구현을 분리해 클래스 폭발 막기](/notes/design-patterns/bridge/)
