---
title: "첫 Job — Infrastructure 설정과 v5/v6 변경 사항"
series: spring-batch
part: "개념"
order: 2
summary: "Spring Boot 위에서 첫 Job을 띄우는 최소 설정과 v4→v5→v6에서 @EnableBatchProcessing·Builder·JobRepository가 바뀐 지점을 정리한다."
tags: [Spring Batch, "@EnableBatchProcessing", JobRepository, Spring Boot, Migration]
sources: [batch/2026-05-17-batch-whats-new-v6.md, batch/2026-05-17-batch-infrastructure.md, 2026-05-03-spring-batch-5-migration.md]
updated: 2026-08-29
---

Job 하나를 돌리려면 JobRepository·PlatformTransactionManager·JobOperator 같은 인프라 빈이 먼저 있어야 한다. ==이 빈들의 출처와 기본값을 모르면 버전에 따라 의미가 뒤집힌 `@EnableBatchProcessing` 때문에 Boot 자동 구성이 꺼지거나 빌더 빈을 찾지 못하고, 메모리 전용 저장소로 운영에 나가 재시작이 불가능해진다.==

## 핵심 개념

### 인프라 빈

- **JobRepository** — 실행 메타데이터를 저장한다. 재시작과 중복 실행 방지의 근거다.
- **PlatformTransactionManager** — chunk 단위 commit/rollback의 기반. v5부터 `chunk(size, txManager)`·`tasklet(tasklet, txManager)`로 명시 전달한다.
- **JobLauncher / JobOperator** — Job을 시작한다. v6는 JobOperator가 시작·중지·재시작·recover를 맡는 단일 진입점이다.
- **JobRegistry, JobScope · StepScope** — 이름 기반 Job 조회와 `#{jobParameters['x']}` late binding을 담당한다.

의존 방향은 `DataSource → TransactionManager → JobRepository → JobOperator → Job`이며, Boot는 DataSource가 있으면 JDBC 기반 JobRepository까지 자동 구성한다.

### `@EnableBatchProcessing`의 버전별 의미

Batch 4.x(Boot 2.x, `javax.*`)에서 이 어노테이션은 JobBuilderFactory·JobRepository를 만드는 필수 선언이었다. Batch 5.x(Boot 3.x, Java 17+, Framework 6, `jakarta.*`)부터는 Boot의 `BatchAutoConfiguration`이 그 역할을 하고, 사용자가 `@EnableBatchProcessing`이나 `DefaultBatchConfiguration`을 선언하면 Boot가 뒤로 물러난다. ==Boot에서는 쓰지 않는 것이 기본이며, 남겨 두면 `spring.batch.*` 프로퍼티가 무시된다.== 빌더는 팩토리 대신 `new JobBuilder(name, repo)`·`new StepBuilder(name, repo)`로 직접 생성한다.

Batch 6.x(Boot 4.x, Framework 7)는 저장소를 선언으로 고른다. `@EnableBatchProcessing` 단독은 `ResourcelessJobRepository`(메모리 전용), `@EnableJdbcJobRepository`는 JDBC, `@EnableMongoJobRepository`는 MongoDB다. 상속 방식은 `DefaultBatchConfiguration`과 Jdbc·Mongo 변형이 대응하며 `getTablePrefix()`·`getDatabaseType()` 등을 override할 수 있다. 이 밖에 Virtual Thread 동시성, `ChunkOrientedStep`, `CommandLineJobOperator`, `recover`, graceful shutdown, JFR, JSpecify, Jackson 3이 추가됐고 Spring Retry는 Framework core retry로 대체됐다. API는 5.x와 거의 호환된다.

## 코드

Spring Boot 3.x + Batch 5.x 기준 최소 Job이다. `@EnableBatchProcessing` 없이 인프라 빈을 메서드 파라미터로 받는다.

```java
@Configuration
public class HelloJobConfig {

    @Bean
    public Job helloJob(JobRepository jobRepository, Step helloStep, Step chunkStep) {
        return new JobBuilder("helloJob", jobRepository)
            .incrementer(new RunIdIncrementer())
            .start(helloStep)
            .next(chunkStep)
            .build();
    }

    @Bean
    public Step helloStep(JobRepository jobRepository,
                          PlatformTransactionManager transactionManager) {
        return new StepBuilder("helloStep", jobRepository)
            .tasklet((contribution, chunkContext) -> {
                System.out.println("Hello, Spring Batch");
                return RepeatStatus.FINISHED;
            }, transactionManager)
            .build();
    }

    @Bean
    public Step chunkStep(JobRepository jobRepository,
                          PlatformTransactionManager transactionManager) {
        return new StepBuilder("chunkStep", jobRepository)
            .<Integer, String>chunk(3, transactionManager)
            .reader(new ListItemReader<>(List.of(1, 2, 3, 4, 5)))
            .processor(item -> "Item-" + item)
            .writer(chunk -> chunk.forEach(System.out::println))
            .build();
    }
}
```

`RunIdIncrementer`는 같은 JobParameters 재실행이 COMPLETED된 JobInstance로 거부되는 문제를 피한다. chunkStep은 5건을 3건씩 두 chunk로 처리한다.

학습용은 스키마 자동 생성과 부팅 시 실행을 켜고, 운영용은 둘 다 끈다.

```yaml
# 학습용
spring:
  datasource:
    url: jdbc:h2:mem:batch
  batch:
    jdbc:
      initialize-schema: always
    job:
      enabled: true

# 운영용
spring:
  datasource:
    url: jdbc:postgresql://db:5432/batch
  batch:
    jdbc:
      initialize-schema: never
      table-prefix: BATCH_
    job:
      enabled: false
```

메타데이터 DB를 분리할 때는 `DefaultBatchConfiguration`을 상속해 배치 전용 DataSource를 지정한다. 이때 Boot의 배치 자동 구성은 꺼진다.

```java
@Configuration
public class BatchInfraConfig extends DefaultBatchConfiguration {

    @Bean
    @ConfigurationProperties("spring.datasource.batch")
    public DataSource batchDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Override
    protected DataSource getDataSource() {
        return batchDataSource();
    }

    @Override
    protected PlatformTransactionManager getTransactionManager() {
        return new JdbcTransactionManager(batchDataSource());
    }

    @Override
    protected String getTablePrefix() {
        return "BATCH_A_";
    }
}
```

## 실무에서 걸리는 지점

- **`@EnableBatchProcessing`을 4.x 습관으로 남겨 둔다.** Boot 3.x 이상에서 자동 구성이 꺼진다. `No qualifying bean of type JobBuilderFactory`는 팩토리 제거를 놓친 신호다.
- ==**Resourceless 저장소로 운영에 나간다.** v6에서 `@EnableBatchProcessing`만 쓰면 메모리 저장소가 기본이라 재시작도 중복 실행 방지도 동작하지 않는다.==
- **`initialize-schema: always`·`job.enabled: true`를 운영에 둔다.** 부팅마다 스키마 생성과 전체 Job 실행이 일어난다. `schema-<db>.sql`을 DBA가 적용하고 명시 실행한다.
- **여러 배치가 같은 table prefix를 쓴다.** 메타데이터가 섞이므로 `table-prefix`로 분리한다.
- **메타데이터 DB와 업무 DB를 한 트랜잭션으로 묶는다.** XA 없이는 원자성이 없으므로 분리한다. Boot 3.x 전환 시 `javax.*`→`jakarta.*`, `com.mysql:mysql-connector-j` 전환도 점검한다.

## 관련 글

- [Spring Batch란 — 아키텍처와 도메인 언어](/notes/spring-batch/what-is-spring-batch/)
- [JobRepository와 메타데이터 스키마](/notes/spring-batch/job-repository-schema/)
- [Job 실행 — JobLauncher·JobOperator·JobExplorer](/notes/spring-batch/running-jobs/)
