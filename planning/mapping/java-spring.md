# java-spring 매핑 (40편)

S = spring/ 폴더, R = 루트(posts/study/ 바로 아래), 날짜 접두는 실제 파일명 그대로.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | java-overview-oop | 자바 백엔드 개관 — JVM·객체와 클래스·OOP 4기둥 | 자바 기초·모던 자바 | S/2026-05-16-java-as-backend-standard.md, S/2026-05-16-java-object-and-class.md, R/2026-05-03-oop-principles.md |
| 2 | interface-polymorphism-solid | 인터페이스·다형성·SOLID | 자바 기초·모던 자바 | S/2026-05-16-java-interface-and-polymorphism.md, R/2026-05-03-solid-principles.md |
| 3 | collections-generics-optional | 컬렉션·제네릭·Optional | 자바 기초·모던 자바 | S/2026-05-17-java-collections.md, S/2026-05-17-java-generics.md, S/2026-05-17-java-optional.md |
| 4 | exception-handling | 예외 처리 | 자바 기초·모던 자바 | S/2026-05-17-java-exception-handling.md |
| 5 | lambda-functional-stream | 람다·함수형 인터페이스·Stream | 자바 기초·모던 자바 | S/2026-05-17-java-stream-lambda.md, R/2026-05-03-java-fp-lambda.md, R/2026-05-03-java-fp-functional-interfaces.md, R/2026-05-03-java-fp-stream.md, R/2026-05-03-java-fp-basics.md |
| 6 | modern-java | Modern Java 9~21 핵심 | 자바 기초·모던 자바 | R/2026-05-03-java-fp-modern.md, R/2026-05-03-java-fp-virtual-threads.md |
| 7 | virtual-thread-basics | Virtual Thread — 원리·API·Pinning | 자바 기초·모던 자바 | R/2026-05-03-vt-concurrency-basics.md, R/2026-05-03-vt-virtual-thread.md, R/2026-05-03-vt-api.md, R/2026-05-03-vt-pinning.md |
| 8 | virtual-thread-practice | Virtual Thread — 실전·Spring Boot·Structured Concurrency | 자바 기초·모던 자바 | R/2026-05-03-vt-patterns.md, R/2026-05-03-vt-performance.md, R/2026-05-03-vt-spring-boot.md, R/2026-05-03-vt-structured-concurrency.md |
| 9 | design-patterns-creational-structural | 디자인 패턴 — 생성·구조 | 자바 기초·모던 자바 | R/2026-05-03-design-patterns-creational.md, R/2026-05-03-design-patterns-structural.md |
| 10 | design-patterns-behavioral | 디자인 패턴 — 행위·조합 | 자바 기초·모던 자바 | R/2026-05-03-design-patterns-behavioral.md, R/2026-05-03-design-patterns-combinations.md |
| 11 | build-and-project-setup | 빌드·프로젝트 구성 — Maven/Gradle·start.spring.io·Profiles | Spring 코어 | S/2026-05-16-java-maven-gradle.md, S/2026-05-16-spring-initializr-first-project.md, S/2026-05-17-application-yml-profiles.md |
| 12 | spring-framework-boot-autoconfig | Spring Framework와 Boot 자동 구성 | Spring 코어 | S/2026-05-16-spring-framework-intro.md, S/2026-05-26-spring-boot-auto-configuration.md, R/2026-05-02-spring-boot-basics.md |
| 13 | ioc-di-application-context | IoC/DI와 ApplicationContext — Bean이란 | Spring 코어 | S/2026-05-16-spring-first-bean-hello.md, S/2026-05-16-why-dependency-injection.md, S/2026-05-16-what-is-spring-bean.md, S/2026-05-16-spring-application-context.md |
| 14 | bean-registration-injection | Bean 등록과 주입 — 어노테이션·@Component·@Configuration | Spring 코어 | S/2026-05-16-java-annotation.md, S/2026-05-16-component-autowired.md, S/2026-05-16-java-config-bean-annotation.md |
| 15 | bean-scope-lifecycle | Bean Scope와 생명주기 | Spring 코어 | S/2026-05-16-bean-scope.md, S/2026-05-16-bean-lifecycle.md |
| 16 | aop-spel | AOP와 SpEL | Spring 코어 | S/2026-05-16-spring-expression-language.md, S/2026-05-16-aop-cross-cutting-concerns.md, S/2026-05-16-spring-aspect-first-aop.md |
| 17 | layered-architecture | 계층 설계 — 서비스 레이어 분리 | Spring 코어 | S/2026-05-26-layered-architecture-service-layer.md |
| 18 | dispatcher-servlet-filter-interceptor | 요청 처리 흐름 — DispatcherServlet·Filter·Interceptor | Web MVC | S/2026-05-16-dispatcher-servlet.md, S/2026-05-17-filter-vs-interceptor.md |
| 19 | controller-request-binding | Controller와 요청 바인딩 | Web MVC | S/2026-05-16-controller-requestmapping.md, S/2026-05-16-restcontroller-json-response.md, S/2026-05-16-request-parameters.md |
| 20 | argument-resolver-upload-paging | ArgumentResolver·파일 업로드·페이징 | Web MVC | S/2026-05-17-argument-resolver.md, S/2026-05-17-file-upload.md, R/2026-05-02-spring-mvc-features.md |
| 21 | exception-handling-validation | 예외 처리와 검증 — @ControllerAdvice·Bean Validation | Web MVC | S/2026-05-16-exception-handler-controlleradvice.md, S/2026-05-16-bean-validation.md, S/2026-05-16-custom-validator.md |
| 22 | cors-security-oauth2-jwt | CORS와 Spring Security — OAuth2·JWT | Web MVC | S/2026-05-17-cors-configuration.md, S/2026-05-17-spring-security-basics.md, R/2026-05-02-spring-security.md |
| 23 | openapi-docs | API 문서화 — Springdoc OpenAPI | Web MVC | S/2026-05-17-springdoc-openapi-swagger.md, R/2026-05-02-spring-openapi-ai.md |
| 24 | jdbc-jdbctemplate | JDBC·DataSource·JdbcTemplate | 데이터 | S/2026-05-16-jdbc-datasource.md, S/2026-05-16-jdbc-template.md |
| 25 | transactional-locking | @Transactional 원리와 낙관/비관 락 | 데이터 | S/2026-05-16-transactional-annotation.md, S/2026-05-26-jpa-optimistic-pessimistic-lock.md |
| 26 | jpa-hibernate-spring-data | JPA·Hibernate·Spring Data JPA — Entity와 Repository | 데이터 | S/2026-05-16-jpa-hibernate-spring-data.md, S/2026-05-16-entity-repository.md, R/2026-05-02-spring-data-jpa.md |
| 27 | jpa-relations-n-plus-1 | 연관관계·N+1·값 객체 | 데이터 | S/2026-05-17-jpa-relations.md, S/2026-05-17-jpa-embedded-embeddable.md, R/2026-05-02-spring-jpa-relationships.md |
| 28 | jpa-queries-querydsl-auditing | 쿼리 — 메서드 이름·@Query·QueryDSL·Auditing | 데이터 | S/2026-05-16-jpa-query-methods.md, S/2026-05-17-querydsl.md, S/2026-05-17-jpa-auditing.md |
| 29 | persistence-context-lazy-loading | 영속성 컨텍스트와 LazyLoading | 데이터 | S/2026-05-16-persistence-context-lazy-loading.md |
| 30 | caching-cacheable-redis | 캐싱 — @Cacheable과 Spring Data Redis | 데이터 | S/2026-05-16-cacheable-caching.md, R/2026-05-02-spring-caching-events.md, R/2026-05-02-redis-spring-data.md, data-infra/2026-05-17-redis-spring-integration.md |
| 31 | logging-logback-slf4j | 로깅 — Logback·SLF4J | 운영·통합 | S/2026-05-17-logback-slf4j-logging.md |
| 32 | events-async-scheduling | 이벤트·비동기·스케줄링 | 운영·통합 | S/2026-05-17-application-event-listener.md, S/2026-05-17-async-completable-future.md, S/2026-05-16-scheduled-task.md |
| 33 | http-client-restclient | HTTP 클라이언트 — RestClient | 운영·통합 | S/2026-05-17-webclient-restclient.md, R/2026-05-02-spring-rest-client.md |
| 34 | testing-mockmvc-testcontainers | 테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway | 운영·통합 | S/2026-05-16-springboottest-integration-test.md, S/2026-05-16-mockmvc-controller-test.md, S/2026-05-17-testcontainers.md, R/2026-05-02-spring-database-advanced.md, R/2026-05-02-spring-mvc-rest.md |
| 35 | actuator-micrometer | Actuator와 Micrometer | 운영·통합 | S/2026-05-17-spring-actuator.md, R/2026-05-02-spring-observability.md, micrometer/2026-05-25-micrometer-spring-boot-actuator.md |
| 36 | dto-mapping-mapstruct | DTO 매핑 — MapStruct | 운영·통합 | S/2026-05-17-mapstruct.md |
| 37 | deploy-docker-buildpack | 배포 — Docker·Buildpack | 운영·통합 | R/2026-05-02-spring-containers-deployment.md, R/2026-05-02-spring-cloud-gateway-build.md |
| 38 | msa-spring-kafka-gateway | MSA 입문 — Spring Kafka·Cloud Gateway | 운영·통합 | R/2026-05-02-spring-microservices-kafka.md, R/2026-05-02-spring-cloud-gateway-build.md, data-infra/2026-05-17-kafka-spring-kafka.md |
| 39 | spring-ai | Spring AI | 운영·통합 | R/2026-05-02-spring-openapi-ai.md |
| 40 | best-practices | 베스트 프랙티스 정리 | 운영·통합 | R/2026-05-02-spring-certification-best-practices.md |
