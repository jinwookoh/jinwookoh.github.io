---
title: "테스트와 관측성 — @SpringBatchTest·Micrometer·JFR"
series: spring-batch
part: "확장과 운영"
order: 19
summary: "Job을 테스트로 검증하고, 운영 중에는 Micrometer 메트릭과 JFR 이벤트로 무엇이 왜 느린지 찾는 방법"
tags: [Spring Batch, SpringBatchTest, Micrometer, Observation, JFR]
sources: [batch/2026-05-17-batch-testing.md, batch/2026-05-17-batch-observability-micrometer.md, batch/2026-05-17-batch-observability-jfr.md]
updated: 2026-08-29
---

배치 Job의 결과는 JobRepository 메타데이터와 대상 DB에 흩어져 남기 때문에 테스트 없이 배포하면 실패를 운영 로그에서 처음 발견한다. ==`@StepScope` Bean은 Step 실행 중에만 만들어지므로 일반 단위 테스트에서 주입하면 `IllegalStateException: No Scope registered`가 난다.== 운영 중에는 어느 Step이 느린지 알 수단이 없고, GC나 I/O 대기 같은 원인은 로그에 나타나지 않는다. `spring-batch-test`, Micrometer Observation, JFR이 각각 이 공백을 메운다.

## 핵심 개념

### @SpringBatchTest

`@SpringBatchTest`는 Job이나 Step을 실행하는 `JobOperatorTestUtils`(v5까지 `JobLauncherTestUtils`), 메타데이터를 지우는 `JobRepositoryTestUtils`, Step·Job scope 테스트 리스너를 등록한다. Job Bean이 여러 개면 `setJob()`으로 고른다.

Step scope 리스너는 테스트 클래스에서 `StepExecution`을 반환하는 메서드를 찾아 각 테스트 전에 호출해 Step 컨텍스트를 활성화한다. 한 테스트 안에서 컨텍스트를 바꾸려면 `StepScopeTestUtils.doInStepScope()`를 쓴다. `MetaDataInstanceFactory`는 StepExecution 체인을 한 줄로 만들어 주므로 Listener나 Processor는 ApplicationContext 없이 테스트한다.

### Micrometer Observation

Spring Batch 5부터 메트릭과 트레이싱은 Micrometer Observation API로 통합됐다. `ObservationRegistry` Bean이 있어야 수집이 시작되고 `DefaultMeterObservationHandler`가 Observation을 `MeterRegistry`의 Timer와 Counter로 바꾼다. Spring Boot Actuator가 두 registry를 자동 구성한다.

기본 메트릭은 `spring.batch` 접두어로 여덟 개다. `job`과 `step`은 완료된 실행의 TIMER, `job.active`와 `step.active`는 진행 중인 실행의 LONG_TASK_TIMER다. `item.read`, `item.process`, `chunk.write`는 `job.name`, `step.name`, `status` 태그를 갖고, `job.launch.count`는 COUNTER다. `micrometer-tracing-bridge-otel` 같은 bridge를 추가하면 Job, Step, chunk 계층의 span이 생기고 MDC에 `traceId`가 들어간다.

### Java Flight Recorder

JFR은 JVM 내장 이벤트 프로파일러로 오버헤드가 1~2% 수준이다. Spring Batch 6은 Job과 Step 실행, item read와 write, chunk 트랜잭션 경계를 JFR 이벤트로 기록한다. Micrometer가 집계값을 외부로 보내는 반면 JFR은 원시 이벤트를 로컬 `.jfr` 파일에 남기고 GC pause, 스레드 대기, 할당 hot spot을 같은 타임라인에서 보여준다. 분석은 JMC에서 하고, 실행 중인 JVM에는 `jcmd <pid> JFR.start`로 켜며, 상시 기록은 `-XX:StartFlightRecording`에 `dumponexit`·`maxage`·`maxsize`를 준다.

## 코드

Job 전체를 실행하고 상태, Step 통계, 결과 데이터를 검증하는 테스트다. `run.id`를 매번 다르게 주어 JobInstance 중복을 피한다.

```java
@SpringBatchTest
@SpringJUnitConfig({BatchConfig.class, TestConfig.class})
@ActiveProfiles("test")
class ImportJobIntegrationTests {

    @Autowired private JobOperatorTestUtils jobOperatorTestUtils;
    @Autowired private JobRepositoryTestUtils jobRepositoryTestUtils;
    @Autowired private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void clean() {
        jdbcTemplate.update("DELETE FROM customer");
        jobRepositoryTestUtils.removeJobExecutions();
    }

    @Test
    void importsAllCustomers() throws Exception {
        for (int i = 1; i <= 10; i++) {
            jdbcTemplate.update("INSERT INTO source_customer VALUES (?, ?)", i, "customer" + i);
        }
        JobParameters params = new JobParametersBuilder()
                .addString("input.file", "customers.csv")
                .addLong("run.id", System.currentTimeMillis())
                .toJobParameters();

        JobExecution execution = jobOperatorTestUtils.startJob(params);

        assertEquals(BatchStatus.COMPLETED, execution.getStatus());
        StepExecution step = execution.getStepExecutions().iterator().next();
        assertEquals(10, step.getReadCount());
        assertEquals(10, step.getWriteCount());
        assertEquals(10L, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM customer", Long.class));
    }
}
```

`@StepScope` Reader를 Step 컨텍스트 안에서 단독으로 검증한다. `getStepExecution()`이 테스트마다 호출된다.

```java
@SpringBatchTest
@SpringJUnitConfig(ReaderConfig.class)
class CustomerReaderTests {

    @Autowired private FlatFileItemReader<Customer> reader;

    public StepExecution getStepExecution() {
        StepExecution execution = MetaDataInstanceFactory.createStepExecution();
        execution.getExecutionContext().putString("input.file", "src/test/resources/customers.csv");
        return execution;
    }

    @Test
    void readsAllRows() throws Exception {
        reader.open(new ExecutionContext());
        int count = 0;
        while (reader.read() != null) {
            count++;
        }
        reader.close();
        assertEquals(10, count);
    }
}
```

ItemProcessor의 외부 API 호출을 별도 Observation으로 감싸 메트릭과 span을 동시에 남긴다.

```java
public class ApiEnrichmentProcessor implements ItemProcessor<Customer, EnrichedCustomer> {

    private final ApiClient client;
    private final ObservationRegistry observationRegistry;

    public ApiEnrichmentProcessor(ApiClient client, ObservationRegistry observationRegistry) {
        this.client = client;
        this.observationRegistry = observationRegistry;
    }

    @Override
    public EnrichedCustomer process(Customer customer) {
        return Observation.createNotStarted("processor.api.enrich", observationRegistry)
                .lowCardinalityKeyValue("country", customer.country())
                .observe(() -> new EnrichedCustomer(customer, client.fetch(customer.id())));
    }
}
```

## 실무에서 걸리는 지점

- 같은 JobParameters로 두 번 실행하면 `JobInstanceAlreadyCompleteException`이 난다. 타임스탬프 파라미터를 주거나 `removeJobExecutions()`로 비운다.
- 멀티스레드 Step은 처리 순서가 비결정적이라 테스트가 간헐적으로 깨진다. 테스트 프로파일에서 `SyncTaskExecutor`로 바꾼다.
- ==`customer.id`처럼 unique 값이 많은 태그를 메트릭에 넣으면 시계열이 폭증한다.== 식별자는 `highCardinalityKeyValue`로 span에만 남기고, 운영에서는 `management.tracing.sampling.probability`를 0.05~0.1로 낮춘다.
- ==비동기 TaskExecutor를 거치면 trace context가 끊겨 span이 분리된다.== `ContextPropagatingTaskDecorator`를 executor에 적용한다. JFR은 JVM 단위이므로 worker JVM의 `.jfr` 파일은 각각 수집한다.
- item마다 커스텀 JFR 이벤트를 `commit()`하면 파일이 처리 건수만큼 급증하므로 chunk 단위로 집계한다. `.jfr` 파일에는 클래스와 메서드 이름이 포함되므로 접근 권한을 관리한다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
- [운영 패턴과 FAQ](/notes/spring-batch/operations-patterns-faq/)
