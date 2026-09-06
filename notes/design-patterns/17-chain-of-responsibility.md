---
title: "책임 연쇄 — 핸들러를 사슬로 엮어 순차 처리"
series: design-patterns
part: "행위"
order: 17
summary: "하나만 처리하고 멈추는 GoF 체인과 모두 거쳐 가는 필터 체인은 같은 이름의 다른 패턴이며, 흐름 제어권이 핸들러에 있다"
tags: [Chain of Responsibility, Filter Chain, Servlet Filter, Spring Security, OncePerRequestFilter]
sources: [https://jinwookoh.tistory.com/216]
updated: 2026-09-06
---

요청 하나를 처리하는 데 인증 확인, 권한 검사, 로깅, 인코딩 변환 같은 단계가 여러 개 붙는다. 이 단계를 요청을 받는 쪽 메서드 안에 순서대로 적으면 단계가 늘 때마다 그 메서드가 길어지고, 순서를 바꾸거나 특정 단계만 빼는 일이 코드 수정이 된다. 결재처럼 금액에 따라 처리자가 달라지는 경우도 마찬가지다. 요청을 보내는 쪽이 누가 처리할지 판단하면 결재 규정이 바뀔 때 보내는 쪽 코드가 바뀐다. 책임 연쇄는 처리자를 사슬로 엮고 요청을 첫 처리자에게 넘긴 뒤, 다음으로 넘길지 여기서 끝낼지를 각 처리자가 결정하게 한다. 보내는 쪽은 사슬의 구성과 길이를 모른다.

## 핵심 개념

같은 이름으로 불리지만 실제로는 동작이 다른 두 형태가 있다.

GoF가 정의한 원형은 처리자 중 하나만 요청을 처리한다. 각 처리자는 자기가 처리할 수 있는지 판단해 처리하면 사슬을 멈추고, 못 하면 다음 처리자에게 넘긴다. 처리자는 다음 처리자 참조만 갖고 그 뒤에 누가 있는지 모른다. 결재선, GUI 이벤트 버블링, 예외 처리의 catch 탐색이 이 형태다. 어느 처리자도 맡지 않으면 요청은 사슬 끝에서 사라지므로 끝에 기본 처리자를 두거나 미처리를 명시적으로 알려야 한다.

웹 프레임워크가 쓰는 필터 체인은 모든 처리자가 요청을 거쳐 가는 파이프라인이다. 각 필터는 다음 필터를 호출하기 전에 전처리를 하고, 호출이 돌아온 뒤 후처리를 한다. 호출 스택이 사슬 끝까지 쌓였다가 되돌아오는 구조라서 전처리는 등록 순서대로, 후처리는 역순으로 실행된다. 다음 필터를 호출하지 않으면 흐름이 거기서 끊기므로 인증 실패 시 401을 쓰고 체인을 중단하는 식의 제어가 가능하다.

| 구분 | GoF 체인 | 필터 체인 |
|---|---|---|
| 실행되는 처리자 | 하나 | 원칙적으로 전부 |
| 종료 시점 | 처리 가능한 처리자를 만나는 즉시 | 마지막까지 갔다가 되돌아온 뒤 |
| 후처리 | 없음 | 다음 호출이 반환된 뒤 가능 |
| 대표 사례 | 결재선, 이벤트 버블링 | Servlet Filter, HandlerInterceptor, Spring Security |

Spring Security는 필터 체인을 두 겹으로 쓴다. 서블릿 컨테이너에는 `DelegatingFilterProxy` 하나만 등록되고, 이것이 `FilterChainProxy`에 위임하며, `FilterChainProxy`가 요청 경로에 맞는 `SecurityFilterChain`을 골라 그 안의 `CsrfFilter`, `UsernamePasswordAuthenticationFilter`, `AuthorizationFilter` 같은 필터를 순서대로 실행한다. 서블릿 필터 체인 안에 보안 필터 체인이 중첩된 구조다.

## 코드

GoF 형태의 결재선이다. 각 결재자는 한도 안이면 처리하고 끝내며, 넘으면 다음 결재자에게 넘긴다. 사슬 끝까지 아무도 맡지 못하면 `false`를 돌려 호출자가 미처리를 알 수 있게 한다.

```java
abstract class Approver {
    private final String name;
    private final long limit;
    private Approver next;

    protected Approver(String name, long limit) {
        this.name = name;
        this.limit = limit;
    }

    Approver next(Approver next) {
        this.next = next;
        return next;
    }

    boolean approve(long amount) {
        if (amount <= limit) {
            System.out.printf("%s 전결 %,d원%n", name, amount);
            return true;
        }
        return next != null && next.approve(amount);
    }
}

final class TeamLead extends Approver { TeamLead() { super("팀장", 100_000); } }
final class Director extends Approver { Director() { super("본부장", 1_000_000); } }
final class Ceo extends Approver { Ceo() { super("사장", Long.MAX_VALUE); } }

void main() {
    Approver head = new TeamLead();
    head.next(new Director()).next(new Ceo());
    head.approve(500_000);   // 본부장 전결 500,000원
}
```

필터 체인의 원리를 드러낸 최소 구현이다. 체인이 인덱스로 현재 위치를 들고 있고, 각 필터는 받은 `chain`을 호출해야 다음으로 넘어간다. 호출을 생략하면 그 자리에서 끝난다.

```java
interface Filter {
    void doFilter(Request req, Response res, Chain chain);
}

final class Chain {
    private final List<Filter> filters;
    private int index = 0;

    Chain(List<Filter> filters) { this.filters = List.copyOf(filters); }

    void doFilter(Request req, Response res) {
        if (index < filters.size()) {
            filters.get(index++).doFilter(req, res, this);
        }
    }
}

record LoggingFilter() implements Filter {
    public void doFilter(Request req, Response res, Chain chain) {
        long start = System.nanoTime();
        chain.doFilter(req, res);                       // 전처리 뒤 다음 필터로
        System.out.println(req.path() + " " + (System.nanoTime() - start) / 1_000_000 + "ms");
    }
}

record AuthFilter(Set<String> validTokens) implements Filter {
    public void doFilter(Request req, Response res, Chain chain) {
        if (!validTokens.contains(req.header("Authorization"))) {
            res.status(401);
            return;                                     // 체인 중단
        }
        chain.doFilter(req, res);
    }
}
```

Spring Boot에서 요청 ID를 MDC에 넣는 필터다. `OncePerRequestFilter`를 상속하면 forward나 error 디스패치로 같은 요청이 다시 들어와도 한 번만 실행되고, `FilterRegistrationBean`으로 등록하면 순서와 URL 패턴을 명시할 수 있다.

```java
public class RequestIdFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String requestId = Optional.ofNullable(request.getHeader("X-Request-Id"))
                .orElseGet(() -> UUID.randomUUID().toString());
        MDC.put("requestId", requestId);
        try {
            response.setHeader("X-Request-Id", requestId);
            chain.doFilter(request, response);
        } finally {
            MDC.remove("requestId");
        }
    }
}

@Configuration
class FilterConfig {
    @Bean
    FilterRegistrationBean<RequestIdFilter> requestIdFilter() {
        var registration = new FilterRegistrationBean<>(new RequestIdFilter());
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.addUrlPatterns("/api/*");
        return registration;
    }
}
```

## 실무에서 걸리는 지점

- ==필터에서 `chain.doFilter()` 호출을 빼먹으면 예외 없이 뒤 필터와 컨트롤러가 실행되지 않고 빈 200 응답이 나간다.== 조건 분기마다 호출 여부를 확인해야 하고, 중단할 때는 상태 코드와 본문을 직접 써야 한다.
- 서블릿 필터에서 던진 예외는 `DispatcherServlet` 바깥에서 발생하므로 `@ControllerAdvice`와 `@ExceptionHandler`가 잡지 못한다. 필터 안에서 직접 응답을 쓰거나, `HandlerExceptionResolver`를 주입해 위임하는 방식으로 처리한다.
- ==`Filter` 구현체를 `@Bean`으로 등록하면서 `SecurityFilterChain`의 `addFilterBefore`에도 넣으면 서블릿 컨테이너와 보안 체인에서 각각 실행돼 같은 요청에 두 번 동작한다.== 보안 체인 안에서만 쓰려면 빈으로 등록하지 않거나, `FilterRegistrationBean`으로 감싸 `setEnabled(false)`를 준다.
- 순서는 동작의 일부다. 서블릿 필터는 `FilterRegistrationBean.setOrder`나 `@Order`로, 보안 필터는 `addFilterBefore`·`addFilterAfter`로 기준 필터에 상대적으로 지정한다. 인증 필터가 인가 필터 뒤에 오면 인가가 익명 사용자 기준으로 판단된 뒤 인증이 실행된다.
- GoF 체인은 사슬 끝에 도달한 요청을 조용히 버린다. 반환값이나 예외로 미처리를 드러내지 않으면 결재 한도 규정이 바뀌어 사슬이 비는 순간 요청이 사라진 사실을 로그로도 알 수 없다.
- 필터와 인터셉터는 싱글톤이므로 인스턴스 필드에 요청별 값을 두면 동시 요청 간에 섞인다. 요청 단위 값은 `HttpServletRequest` 속성이나 `MDC`, `ThreadLocal`에 두고 `finally`에서 정리한다.

## 관련 글

- [커맨드 — 요청을 객체로 캡슐화하고 Undo 구현](/notes/design-patterns/command/)
- [데코레이터 — 상속 없이 기능을 겹겹이 추가](/notes/design-patterns/decorator/)
- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
