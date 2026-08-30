---
title: "JobRepository와 메타데이터 스키마"
series: spring-batch
part: "Job과 실행"
order: 4
summary: "JobRepository가 실행 상태를 어떤 테이블에 저장하고, 재시작·동시 실행 차단이 그 스키마 위에서 어떻게 성립하는가"
tags: [Spring Batch, JobRepository, BATCH_JOB_EXECUTION, ExecutionContext, Optimistic Locking]
sources: [batch/2026-05-17-batch-job-repository.md, batch/2026-05-17-batch-meta-data-schema.md]
updated: 2026-08-29
---

배치 Job이 중간에 죽으면 어디까지 처리했는지 알아야 이어서 실행할 수 있고, 완료된 Job의 중복 실행과 같은 JobInstance의 동시 시작도 막아야 한다. 이 판단은 실행 상태가 프로세스 밖에 영속되어 있어야 가능하다. ==Spring Batch에서 그 저장소가 JobRepository이고, 저장 형식이 `BATCH_*` 메타데이터 스키마다.==

## 핵심 개념

JobRepository는 JobInstance·JobExecution·StepExecution·ExecutionContext의 생성·갱신·조회를 담당한다. chunk 커밋마다 Step 통계와 ExecutionContext를 갱신하고, 재시작 시 이 기록을 읽어 마지막 커밋 지점부터 이어간다. 구현체는 운영 표준인 JDBC(`@EnableJdbcJobRepository`), RDBMS가 없는 환경용 MongoDB(`@EnableMongoJobRepository`), 재시작이 불가능한 테스트용 인메모리 Resourceless 세 가지다.

JDBC 구현체는 도메인 객체와 1:1로 대응하는 테이블 여섯 개를 쓴다. `BATCH_JOB_INSTANCE`(JobInstance), `BATCH_JOB_EXECUTION`(JobExecution), `BATCH_JOB_EXECUTION_PARAMS`(JobParameters), `BATCH_STEP_EXECUTION`(StepExecution), 그리고 Job·Step 각각의 `*_EXECUTION_CONTEXT`다. ID 발급용 시퀀스 세 개가 붙으며, 시퀀스가 없는 MySQL은 테이블로 대체한다. JobInstance 1 : JobExecution N, JobExecution 1 : StepExecution N 관계다.

스키마가 보장하는 동작은 세 가지다.

첫째, 인스턴스 식별. `JOB_KEY`는 `IDENTIFYING = 'Y'`인 파라미터를 직렬화해 MD5로 해시한 32자다. ==같은 이름과 같은 식별 파라미터는 같은 JobInstance로 판정되고, 이미 COMPLETED면 `JobInstanceAlreadyCompleteException`이 발생한다.==

둘째, 낙관적 잠금. `VERSION` 컬럼은 갱신마다 1씩 증가하고 UPDATE는 `WHERE ... AND VERSION = ?`로 실행된다. 어긋나면 `OptimisticLockingFailureException`이 발생한다.

셋째, 동시 생성 차단. `createJobExecution`은 기본 `SERIALIZABLE` 격리 수준으로 실행되어 같은 JobInstance의 동시 생성을 DB 수준에서 막는다.

ExecutionContext는 `SHORT_CONTEXT`와 `SERIALIZED_CONTEXT`(CLOB)에 JSON으로 저장되며, 재시작 시 ItemStream의 `open()`이 여기서 상태를 복원한다. `BATCH_STEP_EXECUTION`의 `READ_COUNT`·`WRITE_COUNT`·`FILTER_COUNT`·`*_SKIP_COUNT`·`ROLLBACK_COUNT`로 Step 상태를 진단한다.

스키마 생성은 `spring.batch.jdbc.initialize-schema`(`embedded` 기본·`always`·`never`)로 제어한다. 운영은 `never`로 두고 jar 안의 `org/springframework/batch/core/schema-<db>.sql`을 직접 적용하며, 업그레이드 시 `migration/<version>/` 스크립트를 확인한다.

## 코드

`JdbcDefaultBatchConfiguration` 상속으로 테이블 접두사·격리 수준·직렬화기를 재정의한다. 접두사는 여러 배치 애플리케이션이 한 DB를 공유할 때 충돌을 막는다.

```java
@Configuration
@EnableJdbcJobRepository
public class BatchRepositoryConfig extends JdbcDefaultBatchConfiguration {

    @Override
    protected String getTablePrefix() {
        return "ORDER_BATCH_";
    }

    @Override
    protected Isolation getIsolationLevelForCreate() {
        return Isolation.SERIALIZABLE;
    }

    @Override
    protected ExecutionContextSerializer getExecutionContextSerializer() {
        return new Jackson2ExecutionContextStringSerializer();
    }
}
```

메타데이터 DB를 업무 DB와 분리하고 자동 스키마 생성을 끈 운영 프로퍼티다.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://batch-db:5432/batch_meta
    username: ${BATCH_DB_USER}
    password: ${BATCH_DB_PASSWORD}
  batch:
    jdbc:
      initialize-schema: never
      table-prefix: ORDER_BATCH_
      isolation-level-for-create: SERIALIZABLE
    job:
      enabled: false
```

90일이 지난 COMPLETED 실행을 FK 순서대로(자식부터) 지우는 정리 Job이다.

```java
@Configuration
public class MetadataCleanupJobConfig {

    private static final String OLD_EXECUTIONS = """
        SELECT JOB_EXECUTION_ID FROM BATCH_JOB_EXECUTION
        WHERE STATUS = 'COMPLETED' AND END_TIME < NOW() - INTERVAL '90 days'""";

    private static final List<String> DELETE_SQL = List.of(
        "DELETE FROM BATCH_STEP_EXECUTION_CONTEXT WHERE STEP_EXECUTION_ID IN ("
            + "SELECT STEP_EXECUTION_ID FROM BATCH_STEP_EXECUTION WHERE JOB_EXECUTION_ID IN (" + OLD_EXECUTIONS + "))",
        "DELETE FROM BATCH_STEP_EXECUTION WHERE JOB_EXECUTION_ID IN (" + OLD_EXECUTIONS + ")",
        "DELETE FROM BATCH_JOB_EXECUTION_CONTEXT WHERE JOB_EXECUTION_ID IN (" + OLD_EXECUTIONS + ")",
        "DELETE FROM BATCH_JOB_EXECUTION_PARAMS WHERE JOB_EXECUTION_ID IN (" + OLD_EXECUTIONS + ")",
        "DELETE FROM BATCH_JOB_EXECUTION WHERE JOB_EXECUTION_ID IN (" + OLD_EXECUTIONS + ")",
        "DELETE FROM BATCH_JOB_INSTANCE ji WHERE NOT EXISTS ("
            + "SELECT 1 FROM BATCH_JOB_EXECUTION je WHERE je.JOB_INSTANCE_ID = ji.JOB_INSTANCE_ID)");

    @Bean
    public Job metadataCleanupJob(JobRepository jobRepository, Step metadataCleanupStep) {
        return new JobBuilder("metadataCleanupJob", jobRepository)
                .start(metadataCleanupStep)
                .build();
    }

    @Bean
    public Step metadataCleanupStep(JobRepository jobRepository,
                                    PlatformTransactionManager transactionManager,
                                    JdbcTemplate jdbcTemplate) {
        return new StepBuilder("metadataCleanupStep", jobRepository)
                .tasklet((contribution, chunkContext) -> {
                    DELETE_SQL.forEach(jdbcTemplate::update);
                    return RepeatStatus.FINISHED;
                }, transactionManager)
                .build();
    }
}
```

STARTED로 남은 실행을 찾아 ABANDONED로 정리하는 운영 SQL이다. `VERSION` 증가를 빠뜨리면 이후 갱신이 낙관적 잠금에 걸린다.

```sql
SELECT JOB_EXECUTION_ID, JOB_INSTANCE_ID, START_TIME, LAST_UPDATED
FROM BATCH_JOB_EXECUTION
WHERE STATUS = 'STARTED'
  AND LAST_UPDATED < NOW() - INTERVAL '1 hour';

UPDATE BATCH_JOB_EXECUTION
SET STATUS = 'ABANDONED',
    EXIT_CODE = 'ABANDONED',
    EXIT_MESSAGE = 'Manually abandoned after abnormal termination',
    END_TIME = NOW(),
    LAST_UPDATED = NOW(),
    VERSION = VERSION + 1
WHERE JOB_EXECUTION_ID = ?;
```

## 실무에서 걸리는 지점

- ==**STARTED 잔존.** `kill -9`·OOM 뒤에는 `END_TIME`이 NULL인 STARTED 레코드가 남아 재시작이 막힌다.== `LAST_UPDATED` 기준으로 탐지해 ABANDONED 처리하는 절차를 마련한다.
- **트랜잭션 매니저 분리.** 메타데이터 DB와 업무 DB가 다르면 `StepBuilder.chunk(size, businessTxManager)`에 업무 DB의 매니저를 넘긴다. XA 없이 두 DB를 한 트랜잭션에 묶을 수 없다.
- **격리 수준 완화.** 데드락이 잦다고 `READ_COMMITTED`로 낮추면 같은 JobInstance가 두 번 생성될 수 있다. 완화 전에 스케줄러 단의 단일 실행 보장을 갖춘다.
- **ExecutionContext 비대화.** 큰 객체를 넣으면 chunk 커밋마다 CLOB이 다시 쓰여 병목이 된다. 단순 값만 저장하고, 직렬화기 교체 시 기존 레코드의 역직렬화 호환을 확인한다.
- **스키마 관리.** 운영에서 `always`는 기동마다 DDL을 시도하고, 업그레이드 시 `migration/` 스크립트를 빠뜨리면 컬럼 불일치로 실패한다. 이력이 쌓이면 `JOB_NAME`·`STATUS`·`START_TIME`에 인덱스를 둔다.

## 관련 글

- [Job 설정 — JobBuilder·Validator·Listener](/notes/spring-batch/configuring-job/)
- [Job 실행 — JobLauncher·JobOperator·JobExplorer](/notes/spring-batch/running-jobs/)
- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
