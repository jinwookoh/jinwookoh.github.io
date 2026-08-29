---
title: "Spring Framework와 Boot 자동 구성"
series: java-spring
part: "Spring 코어"
order: 12
summary: "Spring Boot는 Framework를 대체하지 않으며, 클래스패스와 조건 어노테이션으로 인프라 Bean을 채우는 래퍼다"
tags: [Spring Framework, Spring Boot, AutoConfiguration, ConditionalOnMissingBean, Starter]
sources: [spring/2026-05-16-spring-framework-intro.md, spring/2026-05-26-spring-boot-auto-configuration.md, 2026-05-02-spring-boot-basics.md]
updated: 2026-08-29
---

2000년대 초 자바 백엔드 표준이던 EJB는 비즈니스 클래스 하나에 Home·Remote·Bean 인터페이스 구현, 수십 줄의 XML, 전용 컨테이너 배포를 요구했고 컨테이너 없이는 단위 테스트가 불가능했다. 2004년 Spring Framework는 일반 자바 객체(POJO)를 그대로 두고 객체 생성·주입·트랜잭션·웹 요청 처리 같은 인프라만 프레임워크가 맡는 구조로 이 문제를 풀었다. 다만 Framework만으로는 web.xml, DispatcherServlet, DataSource 등록을 여전히 직접 적어야 했다. 2014년 Spring Boot는 이 부담을 자동 구성(Auto-configuration)으로 없앴다. 이 메커니즘을 모르면 내가 만들지 않은 Bean이 어디서 왔는지 설명할 수 없다.

## 핵심 개념

Spring Framework는 Core(IoC 컨테이너)·AOP·SpEL·Web MVC·Data Access·Testing·Integration 모듈로 구성된 도구 모음이며, 나머지 모듈은 Core 컨테이너가 관리하는 Bean 위에서 동작한다. Spring Boot는 Framework를 대체하지 않는다. "Convention over Configuration" 원칙으로 기본값과 내장 서버를 얹은 편의 계층이고, 실제로 실행되는 코드 대부분은 Framework 코드다. Spring Boot 3.x는 Java 17 이상과 Jakarta EE 10을 요구하며 `javax.*` 네임스페이스는 `jakarta.*`로 바뀌었다.

자동 구성의 출발점은 `@SpringBootApplication`이다. `@SpringBootConfiguration`(설정 클래스 선언), `@ComponentScan`(메인 클래스 패키지 이하의 컴포넌트 등록), `@EnableAutoConfiguration`(인프라 Bean 자동 등록)의 합성이다. 내 코드는 `@ComponentScan`이, 나머지는 `@EnableAutoConfiguration`이 등록한다.

`@EnableAutoConfiguration`이 활성화되면 Boot는 클래스패스의 모든 jar에서 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`를 읽어 후보 자동 구성 클래스 목록을 모은다. Boot 2.6 이하에서 `META-INF/spring.factories`가 하던 역할이다. 후보는 수백 개지만 적용되는 것은 `@Conditional` 계열 조건을 통과한 클래스뿐이다. `@ConditionalOnClass`는 특정 클래스가 클래스패스에 있을 때만 구성을 켜고, `@ConditionalOnMissingBean`은 같은 타입의 Bean을 사용자가 정의하지 않았을 때만 Bean을 만든다. 후자가 "사용자 정의가 항상 우선한다"는 규칙의 실체다.

조건을 충족시키는 수단이 스타터(starter)다. 스타터는 코드가 아니라 의존성 묶음이며, `spring-boot-starter-web` 하나를 추가하면 톰캣·Spring MVC·Jackson이 클래스패스에 들어와 관련 `@ConditionalOnClass` 조건이 연쇄적으로 만족된다. `starter-data-jpa`는 DataSource·EntityManager·트랜잭션 매니저 구성을, `starter-security`는 기본 필터 체인을 켠다.

## 코드

메인 클래스 하나로 내장 서버가 기동한다. 스캔 범위가 이 클래스의 패키지부터 시작하므로 최상위 패키지에 둔다.

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopApplication.class, args);
    }
}
```

자동 구성 클래스를 단순화한 예다. 클래스패스 조건과 Bean 부재 조건이 겹쳐야 기본 DataSource가 만들어진다.

```java
package com.example.shop.infra;

import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import com.zaxxer.hikari.HikariDataSource;

@AutoConfiguration
@ConditionalOnClass(DataSource.class)
public class DefaultDataSourceAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DataSource.class)
    public DataSource dataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:h2:mem:shop");
        return ds;
    }
}
```

사용자 정의 Bean이 자동 구성을 밀어내는 모습이다. 이 설정 클래스가 있으면 위의 `dataSource()`는 조건 불충족으로 실행되지 않는다.

```java
package com.example.shop.config;

import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import com.zaxxer.hikari.HikariDataSource;

@Configuration
public class DataSourceConfig {

    @Bean
    @Primary
    public DataSource mainDataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:postgresql://localhost:5432/shop");
        ds.setUsername("shop");
        ds.setPassword("secret");
        ds.setMaximumPoolSize(20);
        return ds;
    }
}
```

## 실무에서 걸리는 지점

- 컴포넌트가 등록되지 않는 문제의 대부분은 스캔 범위다. `@ComponentScan`은 메인 클래스 패키지 이하만 훑으므로 `com.example.controller`에 둔 컨트롤러는 `com.example.app.Main`이 찾지 못한다.
- 켜진 구성은 리포트로 확인한다. `debug: true` 또는 `--debug`로 실행하면 ConditionEvaluationReport가 Positive/Negative matches와 불발 이유를 출력하고, Actuator가 있으면 `/actuator/conditions`에서 같은 정보를 JSON으로 받는다.
- 특정 자동 구성을 완전히 배제하려면 `@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)`를 쓴다. 클래스 자체가 후보에서 빠지므로 관련 프로퍼티 바인딩도 함께 사라진다.
- 같은 타입 Bean을 여러 개 정의하면 주입 지점에서 모호성 예외가 난다. 하나에 `@Primary`를 붙이거나 주입부에 `@Qualifier`를 지정한다.
- Boot 2에서 3으로 올릴 때 가장 먼저 깨지는 것은 `javax.servlet`·`javax.persistence` import다. Jakarta로 치환하고, 직접 만든 라이브러리의 `spring.factories` 등록도 `AutoConfiguration.imports`로 옮긴다.

## 관련 글

- [빌드·프로젝트 구성 — Maven/Gradle·start.spring.io·Profiles](/notes/java-spring/build-and-project-setup/)
- [IoC/DI와 ApplicationContext — Bean이란](/notes/java-spring/ioc-di-application-context/)
- [Bean 등록과 주입 — 어노테이션·@Component·@Configuration](/notes/java-spring/bean-registration-injection/)
