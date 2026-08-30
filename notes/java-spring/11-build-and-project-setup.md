---
title: "빌드·프로젝트 구성 — Maven/Gradle·start.spring.io·Profiles"
series: java-spring
part: "Spring 코어"
order: 11
summary: "빌드 도구가 의존성을 해석하고, Initializr가 표준 골격을 만들며, Profile과 외부 설정이 환경 차이를 코드 밖으로 밀어내는 구조를 정리한다."
tags: [Maven, Gradle, Spring Initializr, Spring Profiles, ConfigurationProperties]
sources: [spring/2026-05-16-java-maven-gradle.md, spring/2026-05-16-spring-initializr-first-project.md, spring/2026-05-17-application-yml-profiles.md]
updated: 2026-08-29
---

Spring 애플리케이션은 Spring MVC, Jackson, JDBC 드라이버 같은 외부 라이브러리에 의존하고, 그 라이브러리들은 다시 다른 라이브러리를 요구한다. `.jar`를 직접 내려받아 올리면 전이 의존성 누락과 버전 충돌이 발생한다. 골격을 손으로 만들면 자동 구성 규약에서 어긋나기 쉽고, 환경별 DB 주소·자격 증명을 코드에 박으면 환경 전환마다 재빌드가 필요하며 비밀이 저장소에 남는다. ==Maven/Gradle, Spring Initializr, Profiles가 이 세 문제를 각각 담당한다.==

## 핵심 개념

### 의존성 좌표와 BOM

라이브러리는 `groupId:artifactId:version` 좌표로 식별한다. 빌드 도구는 이 좌표를 Maven Central에서 해석하고, 그 아티팩트가 선언한 의존성까지 재귀적으로 가져온다. 버전이 충돌하면 Maven은 트리에서 가장 가까운 선언을, Gradle은 가장 높은 버전을 택한다. Spring Boot는 `spring-boot-dependencies` BOM으로 검증된 버전 조합을 관리하므로 스타터 선언에서 버전을 생략한다.

스코프는 라이브러리가 올라가는 클래스패스를 정한다.

| Maven | Gradle | 의미 |
|---|---|---|
| `compile` | `implementation` | 컴파일·실행 모두 |
| `runtime` | `runtimeOnly` | 실행 시에만 (JDBC 드라이버) |
| `test` | `testImplementation` | 테스트에만 |
| `provided` | `compileOnly` | 컴파일에만, 런타임이 제공 (Lombok) |

### Maven과 Gradle

Maven은 `pom.xml`의 XML 선언과 고정된 생명주기로 동작하며 규약이 강해 프로젝트 간 편차가 적다. Gradle은 `build.gradle(.kts)`를 Groovy/Kotlin DSL로 작성하고, 증분 빌드와 빌드 캐시로 반복 빌드가 빠르며 빌드 로직을 코드로 표현할 수 있다. 어느 쪽이든 Spring Boot 플러그인이 실행 가능한 jar 생성과 BOM 적용을 맡고, `mvnw`/`gradlew` 래퍼로 도구 버전을 저장소에 고정한다.

### Spring Initializr

start.spring.io는 빌드 도구, 언어, Boot 버전, Group·Artifact, 패키징, Java 버전, 의존성을 받아 골격 ZIP을 만든다. 핵심은 `src/main`·`src/test` 규약 구조, `@SpringBootApplication` 메인 클래스, Jar 패키징 셋이다. `@SpringBootApplication`은 `@SpringBootConfiguration`·`@EnableAutoConfiguration`·`@ComponentScan`의 합성이며 메인 클래스의 패키지가 스캔 루트가 된다. Jar는 내장 서블릿 컨테이너를 포함해 `java -jar` 하나로 서버가 뜬다.

### Profiles와 외부 설정

설정값은 명령줄 인자 > 환경 변수 > `application-{profile}.yml` > `application.yml` > 코드 기본값 순으로 병합된다. 환경 변수는 relaxed binding으로 `SPRING_DATASOURCE_URL`이 `spring.datasource.url`에 대응한다. `spring.profiles.active`로 켠 프로파일의 파일이 공통 파일을 덮어쓰고, `@Profile` Bean은 해당 프로파일에서만 등록된다. 단일 값은 `@Value("${key:default}")`, 묶음은 `@ConfigurationProperties`로 주입하며, Boot 3.x에서는 불변 record에 생성자 바인딩하는 형태가 표준이다.

## 코드

Gradle Kotlin DSL 빌드 스크립트. 스타터 버전은 BOM이 채운다.

```kotlin
plugins {
    java
    id("org.springframework.boot") version "3.5.0"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.example"
version = "0.0.1-SNAPSHOT"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

repositories { mavenCentral() }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    runtimeOnly("org.postgresql:postgresql")
    compileOnly("org.projectlombok:lombok")
    annotationProcessor("org.projectlombok:lombok")
    annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")
    developmentOnly("org.springframework.boot:spring-boot-devtools")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.withType<Test> { useJUnitPlatform() }
```

공통 설정과 프로파일별 설정. 비밀은 환경 변수로 참조한다.

```yaml
# application.yml
spring:
  application:
    name: myshop
  jpa:
    open-in-view: false
server:
  port: 8080
app:
  upload:
    dir: /var/uploads
    max-file-size: 10485760
    allowed-types: [image/jpeg, image/png]
---
# application-dev.yml
spring:
  datasource:
    url: jdbc:h2:mem:devdb
  jpa:
    hibernate:
      ddl-auto: create-drop
logging:
  level:
    com.example.myshop: DEBUG
---
# application-prod.yml
spring:
  datasource:
    url: jdbc:postgresql://prod-db.internal:5432/myshop
    username: ${DB_USERNAME:myshop}
    password: ${DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
logging:
  level:
    com.example.myshop: INFO
```

record 기반 `@ConfigurationProperties`와 검증, 프로파일별 Bean 분기.

```java
package com.example.myshop.config;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "app.upload")
public record UploadProperties(
        @NotBlank String dir,
        @Min(1) long maxFileSize,
        List<String> allowedTypes) {
}
```

```java
package com.example.myshop;

import com.example.myshop.config.UploadProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Profile;

@SpringBootApplication
@EnableConfigurationProperties(UploadProperties.class)
public class MyShopApplication {

    public static void main(String[] args) {
        SpringApplication.run(MyShopApplication.class, args);
    }

    @Bean
    @Profile("prod")
    EmailSender smtpEmailSender() {
        return new SmtpEmailSender();
    }

    @Bean
    @Profile("!prod")
    EmailSender consoleEmailSender() {
        return message -> System.out.println("[email] " + message);
    }
}
```

프로파일 전환은 재빌드 없이 명령줄 또는 환경 변수로 한다.

```bash
./gradlew bootJar
java -jar build/libs/myshop-0.0.1-SNAPSHOT.jar --spring.profiles.active=prod
SPRING_PROFILES_ACTIVE=prod DB_PASSWORD=... java -jar build/libs/myshop-0.0.1-SNAPSHOT.jar
```

## 실무에서 걸리는 지점

- **BOM을 우회한 버전 지정.** Jackson·Hibernate 같은 관리 대상에 임의 버전을 적으면 검증된 조합이 깨진다. BOM 프로퍼티 오버라이드로 처리하고 `./gradlew dependencies`로 확인한다.
- ==**`application.yml`에 기본 프로파일 고정.** `spring.profiles.active: dev`가 남은 채 운영 jar를 실행하면 H2와 `create-drop`이 운영에서 동작한다.== 기본값을 두지 않고 배포 스크립트가 프로파일을 주입하도록 강제한다.
- ==**비밀의 저장소 유출.** `application-prod.yml`에 실제 값을 쓰면 git 이력에 남는다.== `${ENV}` 참조만 두고 값은 Secret·Vault로 주입하며, 비밀번호에는 기본값을 두지 않아 미주입 시 기동에 실패하게 한다.
- **컴포넌트 스캔 루트 이탈.** 메인 클래스 패키지 밖에 Bean을 두면 `NoSuchBeanDefinitionException`이 난다. 메인 클래스는 최상위 패키지에 둔다.
- **DevTools 스코프.** `implementation`으로 넣으면 운영 jar에 포함되므로 `developmentOnly`를 쓴다.

## 관련 글

- [Spring Framework와 Boot 자동 구성](/notes/java-spring/spring-framework-boot-autoconfig/)
- [Bean 등록과 주입 — 어노테이션·@Component·@Configuration](/notes/java-spring/bean-registration-injection/)
- [배포 — Docker·Buildpack](/notes/java-spring/deploy-docker-buildpack/)
