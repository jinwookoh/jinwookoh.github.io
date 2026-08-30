---
title: "Bean Scope와 생명주기"
series: java-spring
part: "Spring 코어"
order: 15
summary: "Bean을 몇 개 만들고 언제 초기화·소멸시키는지 결정하는 Scope와 콜백의 동작 규칙"
tags: [Spring, Bean Scope, Singleton, Prototype, "@PostConstruct"]
sources: [spring/2026-05-16-bean-scope.md, spring/2026-05-16-bean-lifecycle.md]
updated: 2026-08-29
---

컨테이너가 Bean을 관리한다는 말에는 두 가지 결정이 포함된다. 같은 클래스의 객체를 몇 개 만들어 얼마나 오래 보관할 것인가, 그리고 생성 직후와 폐기 직전에 어떤 코드를 실행할 것인가다. 이 규칙을 모르면 서비스 객체의 인스턴스 변수가 요청 간에 섞이거나, 생성자에서 아직 주입되지 않은 필드를 건드려 NullPointerException이 나거나, 커넥션 풀이 열린 채 프로세스가 종료된다. Spring은 이를 Bean Scope와 생명주기 콜백으로 표준화한다.

## 핵심 개념

### Scope — 인스턴스 수와 보관 기간

Scope는 컨테이너가 하나의 Bean 정의로부터 인스턴스를 몇 개 만들고 언제까지 유지하는지에 대한 정책이다. `@Scope`로 지정하며, 생략하면 singleton이다.

| Scope | 인스턴스 단위 |
|---|---|
| singleton | 컨테이너당 1개 (기본값) |
| prototype | 요청(getBean·주입)마다 새 객체 |
| request | HTTP 요청당 1개 (웹 전용) |
| session | HTTP 세션당 1개 (웹 전용) |
| application | ServletContext당 1개 (웹 전용) |
| websocket | WebSocket 세션당 1개 (웹 전용) |

singleton이 기본인 이유는 비용이다. 서비스·리포지토리·컨트롤러는 상태를 갖지 않는 것이 원칙이므로 객체 하나를 재사용해도 정합성 문제가 없고 GC 부담도 줄어든다. 반대로 singleton Bean에 가변 인스턴스 필드를 두면 모든 스레드가 그 필드를 공유해 race condition이 발생한다. 대응은 우선순위 순으로 상태를 두지 않는다, 불가피하면 `AtomicInteger` 같은 스레드 안전 도구를 쓴다, 호출마다 독립된 상태가 필요하면 prototype으로 바꾼다.

prototype은 `getBean()`이나 주입이 일어날 때마다 새 인스턴스를 만든다. 컨테이너는 생성·주입·초기화 콜백까지만 책임지고 참조를 버리므로 `@PreDestroy`가 호출되지 않으며 자원 정리는 사용하는 쪽의 몫이다.

singleton이 prototype을 필드로 주입받으면 singleton 생성 시점에 prototype 인스턴스 하나가 고정되어 이후 모든 호출이 같은 객체를 쓴다. 매번 새 객체가 필요하면 `ObjectProvider<T>`, `@Lookup`, JSR-330 `Provider<T>`로 조회 시점을 늦춘다. request·session Scope를 singleton에 주입할 때도 같은 문제가 생기므로 `proxyMode = ScopedProxyMode.TARGET_CLASS`로 프록시를 주입받고 실제 대상은 호출 시점의 요청·세션에서 찾게 한다.

### 생명주기 — 생성부터 소멸까지

싱글턴 Bean 하나는 다음 순서로 처리된다.

1. 인스턴스화 — 생성자 호출. 생성자 주입 의존성은 이 시점에 전달된다.
2. 의존성 주입 — 필드·세터 주입이 완료된다.
3. 초기화 콜백 — `@PostConstruct` 등이 실행된다.
4. 사용 — 애플리케이션이 동작하는 동안 유지된다.
5. 소멸 콜백 — 컨테이너 종료 직전 `@PreDestroy` 등이 실행된다.

생성자 안에서는 필드 주입 대상이 아직 null이므로 의존성을 사용하는 초기 작업은 `@PostConstruct`에 둔다. 생성자 주입을 쓰면 이 경계가 사라져 생성자 안에서 바로 의존성을 쓸 수 있다.

콜백을 거는 방법은 세 가지다.

| 방식 | 초기화 | 소멸 | 용도 |
|---|---|---|---|
| 어노테이션 | `@PostConstruct` | `@PreDestroy` | 기본 선택. `jakarta.annotation` 패키지 |
| 인터페이스 | `InitializingBean.afterPropertiesSet()` | `DisposableBean.destroy()` | Spring API 결합. 권장하지 않음 |
| `@Bean` 속성 | `initMethod` | `destroyMethod` | 수정할 수 없는 외부 라이브러리 클래스 |

여러 방식이 함께 있으면 어노테이션, 인터페이스, `@Bean` 속성 순으로 호출되지만 한 방식만 쓴다. `@Bean` 객체가 `AutoCloseable`을 구현하면 `destroyMethod` 없이도 `close()`가 추론되어 호출된다.

## 코드

singleton 서비스가 prototype Bean을 호출마다 새로 받아 쓰는 `ObjectProvider` 패턴이다.

```java
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Scope;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Component
@Scope("prototype")
class ImportJob {
    private final Instant startedAt = Instant.now();
    private final List<String> errors = new ArrayList<>();

    void run(String file) { /* 파일 처리, 실패 시 errors에 기록 */ }
    List<String> errors() { return errors; }
}

@Service
public class ImportService {
    private final ObjectProvider<ImportJob> jobProvider;

    public ImportService(ObjectProvider<ImportJob> jobProvider) {
        this.jobProvider = jobProvider;
    }

    public List<String> importFile(String file) {
        ImportJob job = jobProvider.getObject();   // 호출마다 새 인스턴스
        job.run(file);
        return job.errors();
    }
}
```

request Scope Bean을 singleton 컨트롤러에 프록시로 주입해 요청별 상태를 담는 예다.

```java
import org.springframework.context.annotation.Scope;
import org.springframework.context.annotation.ScopedProxyMode;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@Component
@Scope(value = "request", proxyMode = ScopedProxyMode.TARGET_CLASS)
class RequestTrace {
    private final String traceId = java.util.UUID.randomUUID().toString();
    String traceId() { return traceId; }
}

@RestController
public class TraceController {
    private final RequestTrace trace;   // 실제로는 프록시가 주입됨

    public TraceController(RequestTrace trace) {
        this.trace = trace;
    }

    @GetMapping("/trace")
    public String trace() {
        return trace.traceId();   // 호출 시점의 요청에 묶인 인스턴스로 위임
    }
}
```

초기화 시 필수 설정을 검증하고 종료 시 버퍼를 비우는 콜백 구성이다. 외부 라이브러리 클라이언트는 `@Bean`의 `destroyMethod`로 정리한다.

```java
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;

@Service
public class MetricsBuffer {
    private final MetricsClient client;

    public MetricsBuffer(MetricsClient client) {
        this.client = client;
    }

    @PostConstruct
    void verify() {
        if (!client.isConfigured()) {
            throw new IllegalStateException("metrics endpoint not configured");
        }
    }

    @PreDestroy
    void flush() {
        client.flush();   // 종료 직전 잔여 데이터 전송
    }
}

@Configuration
class ClientConfig {
    @Bean(destroyMethod = "shutdown")   // 라이브러리 클래스의 종료 메서드 이름을 직접 지정
    MetricsClient metricsClient() {
        return MetricsClient.create(System.getenv("METRICS_URL"));
    }
}
```

## 실무에서 걸리는 지점

- singleton 서비스의 가변 필드는 동시 요청 사이에서 값이 섞인다. 요청 단위 데이터는 파라미터와 지역 변수로 흘려보내고, 공유가 필요한 상태만 스레드 안전 자료구조에 둔다.
- prototype Bean은 `@PreDestroy`가 호출되지 않는다. 커넥션이나 파일 핸들을 여는 prototype Bean은 사용하는 쪽이 직접 닫는다.
- `@PostConstruct`에서 외부 시스템을 호출하면 기동 시간이 늘고, 그 시스템이 내려가 있으면 기동이 실패한다. 의도된 검증인지 지연 초기화로 넘길 워밍업인지 구분한다.
- `@PreDestroy`는 SIGTERM 이후 종료 과정에서 실행되며 오래 걸리면 종료가 지연된다. 종료 유예 시간 안에 끝나도록 짧게 유지하고, 진행 중 요청의 완료 대기는 Graceful Shutdown 설정에 맡긴다.
## 관련 글

- [IoC/DI와 ApplicationContext — Bean이란](/notes/java-spring/ioc-di-application-context/)
- [Bean 등록과 주입 — 어노테이션·@Component·@Configuration](/notes/java-spring/bean-registration-injection/)
- [AOP와 SpEL](/notes/java-spring/aop-spel/)
