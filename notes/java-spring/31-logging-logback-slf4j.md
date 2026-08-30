---
title: "로깅 — Logback·SLF4J"
series: java-spring
part: "운영·통합"
order: 31
summary: "코드는 SLF4J 파사드만 의존하고 Logback이 출력을 맡는 구조에서 레벨·롤링·MDC 추적 ID를 어떻게 잡는가"
tags: [SLF4J, Logback, MDC, Spring Boot, 로깅]
sources: [spring/2026-05-17-logback-slf4j-logging.md]
updated: 2026-08-29
---

`System.out.println` 출력은 레벨이 없어 운영에서 끌 수 없고, 어느 클래스가 어떤 스레드에서 남겼는지 알 수 없으며, 파일 분리나 오래된 기록 삭제도 되지 않는다. 동시 요청이 많은 서버에서는 줄이 뒤섞여 한 요청의 흐름을 복원하기도 어렵다. 로깅 프레임워크는 레벨·출력 대상·포맷·롤링·요청별 컨텍스트를 표준화해 이 문제를 해결한다.

## 핵심 개념

**SLF4J(Simple Logging Facade for Java)** 는 로깅 API의 파사드다. 코드는 `org.slf4j.Logger`만 호출하고 실제 출력은 클래스패스의 구현체가 담당한다. **Logback**은 기본 구현체이며 `spring-boot-starter`에 포함된 `spring-boot-starter-logging`이 가져오므로 별도 의존성이 없다. Log4j2로 바꾸려면 스타터만 교체하면 되고 코드는 그대로다.

로거는 이름 기준 계층을 이룬다. `com.example.shop.order.OrderService` 로거는 `com.example.shop.order` → `com.example.shop` → root 순으로 부모를 갖고, 레벨이 없는 로거는 가장 가까운 부모의 레벨을 상속한다. 패키지 단위 레벨 분기가 가능한 이유다.

레벨은 TRACE < DEBUG < INFO < WARN < ERROR 다섯 단계다. 로거 레벨이 INFO이면 INFO 이상만 통과하고 DEBUG·TRACE는 버려진다. 운영은 INFO, 개발은 애플리케이션 패키지만 DEBUG로 두는 구성이 일반적이다.

| 레벨 | 용도 |
|---|---|
| ERROR | 예외·복구 불가 상황. 알림 대상 |
| WARN | 실패는 아니지만 확인이 필요한 상태 (재시도·폴백) |
| INFO | 주요 비즈니스 이벤트·기동 정보 |
| DEBUG | 변수 값·분기 흐름. 개발 환경 전용 |
| TRACE | 프레임워크 내부 수준의 상세 추적 |

Logback 설정은 **Appender**(출력 대상), **Encoder**(포맷), **Logger/root**(로거-레벨-appender 연결) 세 요소로 구성된다. Spring Boot는 `application.yml`의 `logging.*` 속성으로 흔한 설정을 처리하고, 그 이상은 `logback-spring.xml`로 넘어간다. `logback.xml`이 아니라 `logback-spring.xml`이어야 `<springProfile>` 같은 Boot 확장을 쓸 수 있다.

**MDC(Mapped Diagnostic Context)** 는 스레드에 붙는 키-값 저장소다. 요청 진입 시 추적 ID를 넣어 두면 그 스레드의 모든 로그에 `%X{traceId}`로 찍힌다. Micrometer Tracing을 쓰면 traceId·spanId가 같은 방식으로 자동 주입된다.

## 코드

Lombok `@Slf4j`는 `LoggerFactory.getLogger(OrderService.class)` 필드를 생성한다. 인자는 `{}`로 넘기고, 예외를 마지막 인자로 넘기면 스택 트레이스가 함께 출력된다.

```java
@Service
@Slf4j
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;

    public Order placeOrder(OrderRequest req) {
        log.info("order.create.start userId={}", req.userId());
        try {
            Order order = orderRepository.save(Order.from(req));
            log.info("order.create.done id={} amount={}", order.getId(), order.getAmount());
            return order;
        } catch (DataAccessException e) {
            log.error("order.create.failed userId={}", req.userId(), e);
            throw e;
        }
    }
}
```

`application.yml`만으로 패키지별 레벨·파일 출력·롤링을 지정한다. `logging.file.name`과 `logging.file.path`는 하나만 쓴다.

```yaml
logging:
  level:
    root: INFO
    com.example.shop: DEBUG
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
  file:
    name: logs/shop.log
  logback:
    rollingpolicy:
      file-name-pattern: logs/shop.%d{yyyy-MM-dd}.%i.log.gz
      max-file-size: 50MB
      max-history: 30
      total-size-cap: 3GB
```

요청마다 추적 ID를 MDC에 넣는 필터와, 그 값을 패턴에 반영하고 프로파일별로 appender를 나누는 `logback-spring.xml`이다.

```java
@Component
public class TraceIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String traceId = Optional.ofNullable(request.getHeader("X-Trace-Id"))
                .orElseGet(() -> UUID.randomUUID().toString().substring(0, 8));
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

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} %-5level [%X{traceId:-}] %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>

    <appender name="FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>logs/shop.log</file>
        <rollingPolicy class="ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy">
            <fileNamePattern>logs/shop.%d{yyyy-MM-dd}.%i.log.gz</fileNamePattern>
            <maxFileSize>50MB</maxFileSize>
            <maxHistory>30</maxHistory>
            <totalSizeCap>3GB</totalSizeCap>
        </rollingPolicy>
        <encoder>
            <pattern>%d %-5level [%X{traceId:-}] %logger - %msg%n</pattern>
        </encoder>
    </appender>

    <springProfile name="local">
        <root level="INFO">
            <appender-ref ref="CONSOLE"/>
        </root>
        <logger name="com.example.shop" level="DEBUG"/>
    </springProfile>

    <springProfile name="prod">
        <root level="INFO">
            <appender-ref ref="FILE"/>
        </root>
    </springProfile>
</configuration>
```

## 실무에서 걸리는 지점

**문자열 연결과 무거운 인자.** `log.debug("user " + id)`는 DEBUG가 꺼져 있어도 연결이 먼저 일어난다. `{}` 플레이스홀더는 레벨 검사 후에만 포맷하지만, 인자 자체가 직렬화처럼 무거우면 `log.isDebugEnabled()` 가드나 SLF4J 2.x fluent API의 `addArgument(() -> heavy())`로 지연시킨다.

**MDC 누수.** MDC는 ThreadLocal 기반이라 정리하지 않으면 풀에서 재사용된 스레드가 이전 요청의 traceId를 달고 나온다. `finally`에서 반드시 제거한다. `@Async`로 넘어가면 전파되지 않으므로 `TaskDecorator`로 복사한다.

**민감 정보.** 비밀번호·카드번호·주민등록번호·API 키·JWT는 한 줄이라도 남기면 보관 기간 내내 유출 대상이 된다. DTO의 `toString()`에 딸려 나오는 경우가 흔하므로 객체를 통째로 넘기지 않고 필요한 필드만 마스킹해서 찍는다.

**동기 쓰기와 디스크.** 기본 appender는 호출 스레드에서 동기적으로 쓴다. 로그량이 많으면 `AsyncAppender`로 감싸되, 큐가 차면 DEBUG 이하를 버리는 기본 동작을 알고 써야 한다. `totalSizeCap`을 빼먹으면 디스크가 가득 차 애플리케이션이 멈춘다.

**컨테이너 환경의 포맷.** Kubernetes에서는 파일 대신 stdout으로 내보내고 수집기가 가져가는 구조가 표준이며, 필드 검색을 위해 JSON 출력이 필요하다. Spring Boot 3.4부터는 `logging.structured.format.console=ecs` 한 줄로 지원한다. `spring.jpa.show-sql=true`는 `System.out`으로 출력되어 이 체계를 전부 우회하므로 SQL은 `org.hibernate.SQL` 로거로 잡는다.

## 관련 글

- [빌드·프로젝트 구성 — Maven/Gradle·start.spring.io·Profiles](/notes/java-spring/build-and-project-setup/)
- [요청 처리 흐름 — DispatcherServlet·Filter·Interceptor](/notes/java-spring/dispatcher-servlet-filter-interceptor/)
- [Actuator와 Micrometer](/notes/java-spring/actuator-micrometer/)
