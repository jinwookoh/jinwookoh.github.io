---
title: "인터프리터 — 작은 DSL을 AST로 해석하기"
series: design-patterns
part: "행위"
order: 22
summary: "문법 규칙을 객체 트리로 만들어 문자열 규칙을 해석하는 방법과, 직접 만들 때와 SpEL을 쓸 때의 경계"
tags: [Interpreter, AST, DSL, SpEL, recursive descent]
sources: [https://jinwookoh.tistory.com/226]
updated: 2026-09-06
---

할인 조건, 알림 발송 조건, 검색 필터처럼 운영 중에 바뀌는 규칙을 코드에 if-else로 박아 두면 규칙 하나가 바뀔 때마다 배포가 필요하다. 그래서 규칙을 `amount > 10000 and grade == 'VIP'` 같은 문자열로 DB에 저장하고 실행 시점에 해석하려는 요구가 생긴다. `split`과 `indexOf`로 문자열을 잘라 처리하면 괄호 중첩과 연산자 우선순위에서 바로 무너진다. 인터프리터 패턴은 문법 규칙 하나하나를 객체로 정의하고, 입력 문자열을 그 객체들의 트리(AST)로 바꾼 뒤 트리를 재귀적으로 실행한다.

## 핵심 개념

패턴의 구성 요소는 네 가지다. `Expression`은 모든 구문이 구현하는 공통 인터페이스로 `interpret(context)` 하나를 가진다. 종단 표현식(Terminal)은 더 쪼개지지 않는 단위로 숫자 리터럴이나 변수 참조가 해당한다. 비종단 표현식(Non-terminal)은 다른 표현식을 자식으로 가지며 덧셈·비교·논리곱처럼 자식의 결과를 조합한다. `Context`는 변수 값처럼 해석에 필요한 정보를 담아 트리 전체에 전달된다. 구조적으로는 컴포지트 위에 `interpret` 연산을 얹은 형태다.

GoF의 정의는 트리를 실행하는 부분만 다룬다. 문자열을 트리로 조립하는 파서는 패턴 밖이므로 별도로 작성해야 하며, 문법이 작을 때는 규칙마다 메서드 하나를 대응시키는 재귀 하강 파서가 가장 단순하다. 우선순위는 파서 구조로 표현한다. `expr := term (('+'|'-') term)*`, `term := factor (('*'|'/') factor)*`처럼 낮은 우선순위 규칙이 높은 우선순위 규칙을 호출하게 만들면 `1 + 2 * 3`에서 곱셈이 먼저 묶인다.

구현 방식은 크게 둘로 나뉜다. 규칙마다 클래스를 두는 GoF 방식은 트리 구조가 코드에 드러나고 새 연산을 클래스 하나로 추가할 수 있지만 규칙 수만큼 클래스가 늘어난다. 연산자를 `Map<String, IntBinaryOperator>`에 람다로 등록하는 함수형 방식은 짧지만 트리 없이 즉시 계산하므로 중첩과 우선순위를 처리하려면 결국 스택이나 재귀가 다시 필요하다. Java 21에서는 `sealed interface`와 `record`로 노드를 정의하면 한 파일에 문법 전체를 담을 수 있어 두 방식의 간극이 줄었다. 우선순위·중첩·변수가 있는 자체 문법이면 클래스 기반 AST, 일반적인 산술·비교·논리 규칙이면 SpEL이나 JEXL 같은 표현식 엔진을 택한다.

이미 쓰고 있는 것들이 대부분 이 패턴이다. SpEL은 `@Value("#{...}")`와 `@PreAuthorize` 문자열을 AST로 파싱해 실행하고, Hibernate 6은 JPQL을 SQM이라는 트리로 변환한 뒤 방언별 SQL로 렌더링하며, `Pattern.compile`은 정규식 문자열을 노드 체인으로 컴파일해 `Matcher`가 실행한다.

## 코드

숫자·변수·이항 연산 세 종류의 노드를 `sealed interface`와 `record`로 정의한다. `Context`는 변수 이름과 값의 맵이다.

```java
import java.util.Map;

sealed interface Expr permits Num, Var, Bin {
    int interpret(Map<String, Integer> ctx);
}

record Num(int value) implements Expr {
    public int interpret(Map<String, Integer> ctx) { return value; }
}

record Var(String name) implements Expr {
    public int interpret(Map<String, Integer> ctx) {
        Integer v = ctx.get(name);
        if (v == null) throw new IllegalStateException("undefined variable: " + name);
        return v;
    }
}

record Bin(char op, Expr left, Expr right) implements Expr {
    public int interpret(Map<String, Integer> ctx) {
        int l = left.interpret(ctx);
        int r = right.interpret(ctx);
        return switch (op) {
            case '+' -> l + r;
            case '-' -> l - r;
            case '*' -> l * r;
            case '/' -> l / r;
            default -> throw new IllegalArgumentException("unknown operator: " + op);
        };
    }
}
```

문자열을 위 노드 트리로 바꾸는 재귀 하강 파서다. 메서드 호출 순서가 곧 우선순위이며, 괄호는 `factor`에서 `expr`로 되돌아가 처리한다.

```java
final class Parser {
    private final String src;
    private int pos;

    Parser(String src) { this.src = src.replace(" ", ""); }

    Expr parse() {
        Expr e = expr();
        if (pos != src.length()) throw new IllegalArgumentException("trailing input at " + pos);
        return e;
    }

    // expr := term (('+'|'-') term)*
    private Expr expr() {
        Expr e = term();
        while (peek('+') || peek('-')) e = new Bin(next(), e, term());
        return e;
    }

    // term := factor (('*'|'/') factor)*
    private Expr term() {
        Expr e = factor();
        while (peek('*') || peek('/')) e = new Bin(next(), e, factor());
        return e;
    }

    // factor := number | identifier | '(' expr ')'
    private Expr factor() {
        if (peek('(')) { next(); Expr e = expr(); expect(')'); return e; }
        int start = pos;
        if (Character.isDigit(cur())) {
            while (pos < src.length() && Character.isDigit(cur())) pos++;
            return new Num(Integer.parseInt(src.substring(start, pos)));
        }
        while (pos < src.length() && Character.isLetter(cur())) pos++;
        if (start == pos) throw new IllegalArgumentException("unexpected input at " + pos);
        return new Var(src.substring(start, pos));
    }

    private char cur() { return src.charAt(pos); }
    private boolean peek(char c) { return pos < src.length() && cur() == c; }
    private char next() { return src.charAt(pos++); }
    private void expect(char c) {
        if (!peek(c)) throw new IllegalArgumentException("expected '" + c + "' at " + pos);
        pos++;
    }
}
```

파싱은 한 번만 하고 트리를 재사용한다. 같은 규칙을 다른 변수 값으로 여러 번 평가하는 것이 이 패턴의 일반적인 사용 형태다.

```java
Expr ast = new Parser("price * qty - (discount + 500)").parse();

int a = ast.interpret(Map.of("price", 1200, "qty", 3, "discount", 300)); // 2800
int b = ast.interpret(Map.of("price", 900, "qty", 2, "discount", 0));    // 1300
```

자체 문법이 필요 없는 산술·비교·논리 규칙이면 Spring Boot에 포함된 SpEL을 쓴다. 파싱된 `Expression`은 스레드 안전하므로 규칙 문자열을 키로 캐시하고, 외부 입력을 평가할 때는 `SimpleEvaluationContext`로 기능을 제한한다. `Order`는 `getAmount()`·`getGrade()`를 가진 클래스다.

```java
import org.springframework.expression.Expression;
import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.expression.spel.support.SimpleEvaluationContext;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class DiscountRuleEvaluator {

    private final ExpressionParser parser = new SpelExpressionParser();
    private final Map<String, Expression> cache = new ConcurrentHashMap<>();

    public boolean matches(String rule, Order order) {
        Expression expr = cache.computeIfAbsent(rule, parser::parseExpression);
        var ctx = SimpleEvaluationContext.forReadOnlyDataBinding().build();
        return Boolean.TRUE.equals(expr.getValue(ctx, order, Boolean.class));
    }
}

// evaluator.matches("amount > 10000 and grade == 'VIP'", order)
```

## 실무에서 걸리는 지점

- **파싱 비용이 실행 비용을 압도한다.** ==같은 규칙 문자열인데 요청마다 `parseExpression`이나 `new Parser().parse()`를 다시 호출하면 GC 압력과 지연이 규칙 수에 비례해 늘어나므로 파싱된 트리를 캐시해야 한다.== 파싱된 트리는 불변이라 스레드 간 공유가 안전하다.
- **표현식 엔진에 외부 입력을 넣는 것은 코드 실행 권한을 주는 것이다.** ==사용자가 작성한 문자열을 `StandardEvaluationContext`로 평가하면 `T(java.lang.Runtime).getRuntime().exec(...)` 같은 타입 참조로 임의 코드가 실행된다.== 외부 입력에는 타입 참조·생성자·빈 참조를 막은 `SimpleEvaluationContext`를 쓴다.
- **재귀 깊이에 상한이 없다.** 재귀 하강 파서와 `interpret`는 모두 중첩 깊이만큼 스택을 쓰므로 괄호를 수천 번 중첩한 입력 하나로 `StackOverflowError`를 낼 수 있다. 입력 길이와 중첩 깊이를 파서에서 제한하고, SpEL도 최대 표현식 길이 설정을 기본값에 의존하지 말고 서비스에 맞게 낮춘다.
- **의미 규칙이 조용히 다르게 동작한다.** 위 예제의 `/`는 정수 나눗셈이라 `7 / 2`가 3이 되고, 미정의 변수를 0으로 볼지 예외로 볼지도 명세가 없으면 구현마다 달라진다. 규칙 작성자가 참조할 문법 명세를 먼저 쓰고 테스트로 고정한다.
- **저장된 규칙은 문법과 함께 버전 관리 대상이다.** ==규칙을 DB에 저장하는 시점에 파싱해 검증하지 않으면 오타 하나가 며칠 뒤 실제 주문 평가에서 예외로 터진다.== 저장 API에서 파싱을 강제하고, 연산자를 추가하거나 의미를 바꿀 때는 저장된 규칙 전체를 새 파서로 다시 파싱해 호환성을 확인한 뒤 배포한다.

## 관련 글

- [컴포지트 — 개별 객체와 트리를 같은 인터페이스로](/notes/design-patterns/composite/)
- [방문자 — 클래스 수정 없이 연산 추가하기](/notes/design-patterns/visitor/)
- [전략 — if-else 분기를 교체 가능한 알고리즘으로](/notes/design-patterns/strategy/)
