---
title: "요청 처리 흐름 — DispatcherServlet·Filter·Interceptor"
series: java-spring
part: "Web MVC"
order: 18
summary: "HTTP 요청이 Tomcat에서 컨트롤러까지 거치는 단계와 Filter·Interceptor가 갈리는 지점을 정리한다."
tags: [DispatcherServlet, HandlerMapping, Filter, HandlerInterceptor, Spring MVC]
sources: [spring/2026-05-16-dispatcher-servlet.md, spring/2026-05-17-filter-vs-interceptor.md]
updated: 2026-08-29
---

`@RestController`에 메서드를 두면 URL 요청이 그 메서드로 도착한다. 이 과정을 모르면 인증·로깅·Trace ID 부여 같은 공통 처리를 어디에 둘지 판단할 수 없어 컨트롤러마다 같은 코드가 복제되고, 예외가 `@ControllerAdvice`에 잡히지 않는 현상의 원인을 찾지 못한다. ==요청이 거치는 단계와 각 단계가 Spring 안인지 밖인지 알면 두 문제가 함께 풀린다.==

## 핵심 개념

### DispatcherServlet — 단일 진입점

DispatcherServlet은 Spring MVC의 프런트 컨트롤러다. `jakarta.servlet.http.HttpServlet`의 서브클래스이며 Spring Boot가 기동 시 자동 생성해 `/` 전체에 매핑한다. 내장 Tomcat이 받은 요청은 Servlet Filter 체인을 지나 이 서블릿으로 들어오고, 이후 흐름은 다음 순서다.

1. HandlerMapping이 URL·HTTP 메서드 조합으로 핸들러(컨트롤러 메서드)를 찾는다. 핸들러에 연결된 Interceptor 목록도 이때 결정된다.
2. Interceptor의 `preHandle`이 순서대로 실행된다.
3. HandlerAdapter가 `@PathVariable`·`@RequestParam`·`@RequestBody` 등을 해석해 매개변수를 채우고 메서드를 호출한다.
4. 반환값을 HttpMessageConverter(기본 JSON 구현은 Jackson)가 직렬화하거나, 뷰 이름이면 ViewResolver가 템플릿을 찾아 렌더링한다.
5. `postHandle`·`afterCompletion`이 역순으로 실행되고, Filter 체인의 후처리를 거쳐 Tomcat이 응답을 보낸다.

개발자가 작성하는 것은 3단계의 컨트롤러 메서드뿐이다. `@RestController`는 `@Controller`에 `@ResponseBody`가 결합된 것으로 반환값이 항상 응답 본문이 되고, `@Controller`의 문자열 반환값은 뷰 이름으로 해석된다. 같은 URL·메서드 조합이 두 핸들러에 매핑되면 HandlerMapping이 테이블을 만드는 기동 시점에 실패한다.

### Filter와 Interceptor의 경계

둘 다 요청 전후에 공통 처리를 끼워 넣지만 위치가 다르다. Filter는 Servlet 명세(`jakarta.servlet.Filter`)의 일부로 DispatcherServlet 바깥, 서블릿 컨테이너 단계에서 실행된다. HandlerInterceptor는 Spring MVC 전용으로 DispatcherServlet 안에서 핸들러가 결정된 뒤 실행된다. 나머지 차이는 이 위치에서 파생된다.

| 구분 | Filter | HandlerInterceptor |
|---|---|---|
| 적용 범위 | 모든 요청. 정적 자원 포함 | 핸들러가 매핑된 요청 |
| 접근 정보 | `ServletRequest`·`ServletResponse` | 위에 더해 `HandlerMethod`·`ModelAndView` |
| 본문 가공 | Wrapper로 가능 | 어렵다 |
| 예외 처리 | `@ControllerAdvice`가 잡지 못한다 | `@ControllerAdvice`가 잡는다 |
| 등록 | `@Component` 또는 `FilterRegistrationBean` | `WebMvcConfigurer.addInterceptors` |

본문을 다루거나 정적 자원까지 포함해야 하면 Filter, 어느 컨트롤러가 호출되는지에 따라 분기해야 하면 Interceptor, HTTP와 무관한 메서드 단위 처리는 AOP다. Spring Security는 Filter 체인 위에 구축되어 있고, CORS Preflight 응답과 Trace ID 부여도 모든 요청에 걸려야 하므로 Filter가 맡는다.

## 코드

요청마다 Trace ID를 발급해 MDC와 응답 헤더에 넣는 Filter다. `OncePerRequestFilter`를 상속하면 forward·error 디스패치에서 중복 실행되지 않고 캐스팅도 필요 없다.

```java
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

@Component
@Order(1)
public class TraceIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String traceId = UUID.randomUUID().toString();
        MDC.put("traceId", traceId);
        response.setHeader("X-Trace-Id", traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove("traceId");
        }
    }
}
```

핸들러 메서드의 커스텀 어노테이션을 읽어 권한을 검사하는 Interceptor다. `handler`가 `HandlerMethod`인지 확인해야 정적 자원 핸들러에서 `ClassCastException`이 나지 않는다.

```java
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class AdminOnlyInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) {
        if (!(handler instanceof HandlerMethod method)
                || !method.hasMethodAnnotation(AdminOnly.class)) {
            return true;
        }
        if (!"admin".equals(request.getHeader("X-Role"))) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            return false;
        }
        return true;
    }
}
```

Interceptor는 `WebMvcConfigurer`로 경로 패턴과 함께 등록한다.

```java
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final AdminOnlyInterceptor adminOnlyInterceptor;

    public WebConfig(AdminOnlyInterceptor adminOnlyInterceptor) {
        this.adminOnlyInterceptor = adminOnlyInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(adminOnlyInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/**", "/api/public/**");
    }
}
```

## 실무에서 걸리는 지점

- ==**Filter에서 던진 예외는 `@ControllerAdvice`에 도달하지 않는다.**== 서블릿 컨테이너의 에러 처리로 넘어가 응답 형식이 API 규약과 달라진다. Filter 안에서 직접 JSON을 쓰거나 `HandlerExceptionResolver`를 주입해 위임한다.
- **`@Component` Filter를 `FilterRegistrationBean`으로 다시 등록하면 두 번 실행된다.** 경로나 순서를 제어하려면 `@Component`를 떼고 `FilterRegistrationBean`만 남긴다.
- ==**요청 본문을 Filter에서 읽으면 컨트롤러는 빈 본문을 받는다.** `InputStream`은 한 번만 소비된다.== `ContentCachingRequestWrapper`·`ContentCachingResponseWrapper`로 감싸 체인에 넘기고, 응답은 `copyBodyToResponse()`를 호출해야 클라이언트에 전달된다.
- **Spring Boot 3부터 경로 매칭 기본값이 `PathPatternParser`다.** `/**`는 패턴 끝에서만 허용되어 중간에 `/**/`가 들어간 패턴은 기동 시 실패한다.

## 관련 글

- [Controller와 요청 바인딩](/notes/java-spring/controller-request-binding/)
- [예외 처리와 검증 — @ControllerAdvice·Bean Validation](/notes/java-spring/exception-handling-validation/)
- [AOP와 SpEL](/notes/java-spring/aop-spel/)
