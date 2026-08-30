---
title: "Bean 등록과 주입 — 어노테이션·@Component·@Configuration"
series: java-spring
part: "Spring 코어"
order: 14
summary: "어노테이션이 리플렉션으로 읽히는 원리부터 @Component 스캔·@Bean 팩토리·생성자 주입·@Primary/@Qualifier 분기까지 정리한다"
tags: [Spring, Annotation, "@Component", "@Autowired", "@Configuration"]
sources: [spring/2026-05-16-java-annotation.md, spring/2026-05-16-component-autowired.md, spring/2026-05-16-java-config-bean-annotation.md]
updated: 2026-08-29
---

컨테이너가 객체를 만들고 조립하려면 어떤 클래스를 Bean으로 만들고 어디에 무엇을 끼울지 알아야 한다. 이 정보를 XML에 따로 적던 시절에는 클래스를 추가할 때마다 설정 파일을 같이 고쳐야 했고, 둘이 어긋나면 런타임에야 실패가 드러났다. 어노테이션은 등록·주입 정보를 클래스·메서드·매개변수 옆에 붙이는 메타데이터이고, Spring은 이를 읽어 Bean 등록과 주입을 수행한다.

## 핵심 개념

어노테이션은 코드의 동작을 바꾸지 않고 부가 정보만 붙이며, 누가 읽느냐에 따라 세 부류로 나뉜다. `@Override`·`@Deprecated`는 컴파일러가 읽어 검사·경고를 낸다. `@Component`·`@Autowired`·`@Transactional`은 `.class` 파일에 남아 런타임에 프레임워크가 리플렉션으로 읽는다. `@Target`·`@Retention`은 다른 어노테이션의 적용 위치와 보존 범위를 정하는 메타 어노테이션이다. Spring이 읽는 어노테이션은 모두 `RetentionPolicy.RUNTIME`이다.

Bean 등록 경로는 두 가지다. 첫째는 컴포넌트 스캔이다. `@Component`가 붙은 클래스를 클래스패스에서 찾아 Bean 정의로 만든다. `@Service`·`@Repository`·`@Controller`·`@RestController`는 `@Component`를 메타 어노테이션으로 가진 스테레오타입이며 등록 동작은 같고, 계층 역할을 드러내는 용도다. 동작이 다른 것은 `@Repository`뿐으로, `PersistenceExceptionTranslationPostProcessor`가 프록시를 만들어 JDBC·JPA 예외를 `DataAccessException` 계층으로 변환한다. 스캔 범위는 `@SpringBootApplication`에 포함된 `@ComponentScan`이 정하며 기본값은 메인 클래스의 패키지와 그 하위다.

둘째는 Java Config다. `@Configuration` 클래스의 `@Bean` 메서드가 반환한 객체를 Bean으로 등록하며, 이름은 기본적으로 메서드 이름이다. `@Component`는 클래스 선언에 붙이므로 소스를 고칠 수 없는 외부 라이브러리 타입에는 쓸 수 없고, 이 경우 `@Bean` 메서드에서 직접 생성해 반환한다. 같은 타입을 여러 개 만들거나 생성에 조건 분기가 필요할 때도 `@Bean`이 맞다. `@Configuration`은 그 자체가 `@Component`라 스캔으로 발견되고, `@Import`로 다른 설정 클래스를 합칠 수도 있다.

주입은 생성자·세터·필드에서 가능하다. Spring 4.3부터 생성자가 하나면 `@Autowired` 없이 그 생성자로 주입되므로 현재 표준은 어노테이션 없는 생성자 주입이다. `final`로 불변성을 확보하고, 누락이 기동 시점에 드러나며, 테스트에서 `new`로 조립할 수 있다. `@Bean` 메서드의 매개변수도 같은 규칙으로 주입된다. 같은 타입 Bean이 둘 이상이면 `NoUniqueBeanDefinitionException`이 나며, `@Primary`로 기본 후보를 두거나 주입 지점에 `@Qualifier`로 이름을 지정한다. `@Qualifier`가 `@Primary`보다 우선한다. `jakarta.inject.Inject`는 `@Autowired`와 거의 같고 `jakarta.annotation.Resource`는 이름 매칭이 우선이다.

## 코드

스테레오타입 등록과 생성자 주입, 같은 타입 두 개를 `@Primary`·`@Qualifier`로 분기하는 예다.

```java
package com.example.shop.payment;

import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;

public interface PaymentGateway {
    String pay(long amount);
}

@Service
@Primary
class KakaoPayGateway implements PaymentGateway {
    public String pay(long amount) { return "kakao:" + amount; }
}

@Service
class TossPayGateway implements PaymentGateway {
    public String pay(long amount) { return "toss:" + amount; }
}

@Service
public class OrderService {
    private final PaymentGateway gateway;

    // 생성자가 하나이므로 @Autowired 생략. @Qualifier가 @Primary보다 우선한다.
    public OrderService(@Qualifier("tossPayGateway") PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public String order(long amount) {
        return gateway.pay(amount);
    }
}
```

외부 라이브러리 타입을 `@Bean`으로 등록하고, 메서드 매개변수로 다른 Bean을 받는 예다.

```java
package com.example.shop.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestClient;

import javax.sql.DataSource;

@Configuration
public class AppConfig {

    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper().registerModule(new JavaTimeModule());
    }

    @Bean
    public RestClient paymentClient(RestClient.Builder builder) {
        return builder.baseUrl("https://pay.example.com").build();
    }

    @Bean(destroyMethod = "close")
    public DataSource dataSource() {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl("jdbc:postgresql://localhost:5432/shop");
        return new HikariDataSource(cfg);
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }
}
```

런타임에 읽히는 커스텀 어노테이션을 정의하는 예다. `RUNTIME` 보존이 아니면 Spring이 읽을 수 없다.

```java
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface LogExecutionTime {
    String value() default "";
}
```

## 실무에서 걸리는 지점

- 스캔 범위 밖의 클래스는 등록되지 않는다. 메인 클래스가 `com.example.shop`에 있으면 `com.example.common`의 `@Service`는 발견되지 않고 주입 지점에서 `NoSuchBeanDefinitionException`이 난다. 메인 클래스를 루트 패키지에 두거나 `scanBasePackages`를 명시한다.
- `@Configuration` 클래스는 CGLIB 서브클래스로 감싸이므로 내부에서 `@Bean` 메서드를 직접 호출해도 싱글턴이 반환된다. `@Component`에 `@Bean`을 두거나 `proxyBeanMethods = false`면 호출마다 새 객체가 생긴다. 다른 Bean은 매개변수로 받는 편이 두 모드 모두 안전하다.
- 필드 주입은 `final`을 쓸 수 없고 순환 참조를 숨긴다. 생성자 주입은 순환이 있으면 기동 단계에서 실패하므로 설계 문제가 일찍 드러난다. Spring Boot 2.6부터 순환 참조는 기본 금지다.
- 구현체를 하나 추가한 순간 잘 돌던 주입이 `NoUniqueBeanDefinitionException`으로 깨진다. `@Qualifier` 이름은 문자열이라 리네임에 취약하므로 커스텀 qualifier 어노테이션으로 감싸는 방법도 있다.
- `AutoCloseable` 구현체는 `destroyMethod`를 생략해도 `close()`가 추론되지만, 커넥션 풀처럼 종료 순서가 중요한 객체는 명시해 의도를 드러낸다.

## 관련 글

- [IoC/DI와 ApplicationContext — Bean이란](/notes/java-spring/ioc-di-application-context/)
- [Bean Scope와 생명주기](/notes/java-spring/bean-scope-lifecycle/)
- [Spring Framework와 Boot 자동 구성](/notes/java-spring/spring-framework-boot-autoconfig/)
