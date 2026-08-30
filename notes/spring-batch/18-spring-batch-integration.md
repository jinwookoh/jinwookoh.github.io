---
title: "Spring Batch Integration — 메시지로 Job 실행"
series: spring-batch
part: "확장과 운영"
order: 18
summary: "파일 도착·Kafka 메시지 같은 이벤트를 Job 실행 트리거로 바꾸고, 진행 상태를 메시지 채널로 내보내는 방법"
tags: [Spring Batch Integration, Spring Integration, JobLaunchingGateway, JobLaunchRequest, Informational Messages]
sources: [batch/2026-05-17-batch-integration-overview.md, batch/2026-05-17-batch-launching-via-messages.md]
updated: 2026-08-29
---

Job을 띄우는 기본 수단은 커맨드라인, `JobOperator.start()`, `@Scheduled` cron이다. 셋 다 시간 또는 명령이 기준이라서 "SFTP에 파일이 올라오면", "Kafka 메시지가 오면" 같은 이벤트 기반 요구를 만나면 폴링 스레드를 직접 짜거나 cron 간격을 좁혀 빈 실행을 반복하게 된다. 반대 방향도 문제다. 진행 상태를 외부에 알리려면 리스너마다 알림 코드를 심어야 하고, 알림 대상이 바뀔 때마다 배치 코드를 고치게 된다. ==`spring-batch-integration` 모듈은 이 두 방향을 Spring Integration의 채널·게이트웨이로 흡수한다.==

## 핵심 개념

Spring Batch는 대량 레코드를 chunk 단위 트랜잭션으로 처리하고 JobRepository로 재시작을 보장한다. Spring Integration은 메시지 한 건을 채널·라우터·어댑터로 흘려보내며 대체로 stateless다. 경계는 granularity로 갈린다. ==batch run 안의 처리는 Batch가, run을 시작시키는 트리거와 결과를 내보내는 notify는 Integration이 맡는다.==

모듈의 결합점은 여섯 가지다. 메시지로 Job 실행, Job-Launching Gateway, Informational Messages, `AsyncItemProcessor`/`AsyncItemWriter` 쌍, Step 실행의 원격 분리, 메시징 기반 Remote Chunking·Partitioning. 이 글은 앞의 셋을 다루고, 나머지는 Scaling 편의 기반이다.

메시지 페이로드는 `Job`과 `JobParameters`를 감싼 `JobLaunchRequest`다. `JobLaunchingMessageHandler`가 이를 받아 Job을 실행하고 `JobExecution`을 reply 채널로 돌려준다. `JobLaunchingGateway`는 같은 핸들러의 게이트웨이 버전으로 request-channel·reply-channel·reply-timeout(기본 -1, 무한 대기)·auto-startup·order를 조정할 수 있다. Spring Batch 6부터는 `JobLauncher` 대신 `JobOperator`를 넘기는 생성자가 기본이다.

반환 시점은 TaskExecutor가 결정한다. `SyncTaskExecutor`면 Job이 끝난 뒤에야 `JobExecution`이 돌아오고 그동안 폴링 스레드가 묶인다. 비동기 실행기면 시작 직후 STARTED 상태로 반환되며 이후 상태는 `JobExplorer`로 조회한다.

Informational Messages는 `@MessagingGateway` 인터페이스가 `StepExecutionListener`를 상속하는 형태다. 런타임 프록시가 `afterStep` 호출을 채널 송신으로 바꾸므로, 채널 뒤의 Router·어댑터만 교체하면 배치 코드 수정 없이 알림 경로가 바뀐다.

`batch-integration` XML 네임스페이스는 6.0에서 deprecated되었고 7.0에서 제거되므로 구성은 Java DSL(`IntegrationFlow`)로 작성한다.

## 코드

디렉토리를 30초마다 폴링해 새 CSV 파일을 `JobLaunchRequest`로 바꾸고 Job을 실행하는 표준 flow다.

```java
@Configuration
public class FileLaunchConfig {

    @Bean
    public JobOperator asyncJobOperator(JobRepository repository) {
        TaskExecutorJobOperator operator = new TaskExecutorJobOperator();
        operator.setJobRepository(repository);
        operator.setTaskExecutor(new SimpleAsyncTaskExecutor("batch-"));
        return operator;
    }

    @Bean
    public IntegrationFlow fileLaunchFlow(JobOperator jobOperator, Job importJob) {
        return IntegrationFlow
            .from(Files.inboundAdapter(new File("/data/incoming"))
                    .filter(new ChainFileListFilter<>(List.of(
                        new SimplePatternFileListFilter("*.csv"),
                        new AcceptOnceFileListFilter<>()))),
                c -> c.poller(Pollers.fixedRate(Duration.ofSeconds(30)).maxMessagesPerPoll(1)))
            .<File, JobLaunchRequest>transform(file -> new JobLaunchRequest(
                importJob,
                new JobParametersBuilder()
                    .addString("input.file.name", file.getAbsolutePath())
                    .addLong("run.id", System.currentTimeMillis())
                    .toJobParameters()))
            .handle(new JobLaunchingMessageHandler(jobOperator))
            .log(LoggingHandler.Level.INFO, "headers.id + ': ' + payload")
            .get();
    }
}
```

메시지가 실어 온 파일 경로는 Step Scope의 Late Binding으로 Reader에 주입한다.

```java
@Bean
@StepScope
public FlatFileItemReader<Person> personReader(
        @Value("#{jobParameters['input.file.name']}") String path) {
    return new FlatFileItemReaderBuilder<Person>()
        .name("personReader")
        .resource(new FileSystemResource(path))
        .delimited()
        .names("firstName", "lastName")
        .targetType(Person.class)
        .build();
}
```

Step 이벤트를 채널로 내보내고 ExitStatus에 따라 실패만 메일로 보내는 Informational Messages 구성이다. `@IntegrationComponentScan`이 있어야 게이트웨이 인터페이스가 빈으로 등록된다.

```java
@Configuration
@IntegrationComponentScan
public class StepNotificationConfig {

    @MessagingGateway(name = "stepEventListener",
                      defaultRequestChannel = "stepEventsChannel")
    public interface StepEventListener extends StepExecutionListener {
    }

    @Bean
    public IntegrationFlow stepEventFlow(MailSender mailSender) {
        return IntegrationFlow.from("stepEventsChannel")
            .<StepExecution, String>route(exec -> exec.getExitStatus().getExitCode(), r -> r
                .subFlowMapping("FAILED", sf -> sf.handle(m -> {
                    StepExecution exec = (StepExecution) m.getPayload();
                    mailSender.send(buildFailureMail(exec));
                }))
                .defaultSubFlowMapping(sf -> sf.log(LoggingHandler.Level.INFO,
                    "'step ' + payload.stepName + ' ' + payload.exitStatus.exitCode")))
            .get();
    }

    @Bean
    public Step importStep(JobRepository repository, PlatformTransactionManager tx,
                           ItemReader<Person> reader, ItemWriter<Person> writer,
                           StepEventListener listener) {
        return new StepBuilder("importStep", repository)
            .<Person, Person>chunk(200, tx)
            .reader(reader)
            .writer(writer)
            .listener(listener)
            .build();
    }
}
```

## 실무에서 걸리는 지점

- **JobParameters 유일성**. 파일 경로만 파라미터로 넣으면 같은 파일 재처리 시 `JobInstanceAlreadyCompleteException`이 난다. `run.id`에 타임스탬프를 넣거나, 재처리 차단이 의도라면 예외를 로그로 남긴다.
- ==**동기 실행기의 폴링 블로킹**. `SyncTaskExecutor`는 Job이 끝날 때까지 poller 스레드를 점유해 다음 파일이 그만큼 대기한다.== 비동기 실행기로 바꾸고 결과는 `JobExecutionListener`나 `JobExplorer`로 확인한다.
- **비동기 결과 오인**. 비동기 모드의 `JobExecution`은 시작 직후 상태라 실패 여부를 담지 않는다. reply만 보고 성공으로 처리하면 실패가 묻힌다.
- **인메모리 채널의 메시지 손실**. `DirectChannel`·`QueueChannel`은 프로세스가 죽으면 메시지도 사라진다. 트리거 유실이 허용되지 않으면 Kafka·JMS 같은 durable 채널을 통로로 둔다.
- **중복 처리**. `AcceptOnceFileListFilter`는 메모리 기반이라 재기동 후 초기화된다. 처리 후 archive로 옮기는 Tasklet을 두거나 `FileSystemPersistentAcceptOnceFileListFilter`로 상태를 외부에 저장한다.
- **과도한 도입**. 트리거가 cron이면 `@Scheduled`, 완료 알림 한 줄이면 `JobExecutionListener`로 충분하다. Integration은 외부 이벤트·다중 소스·알림 경로 분리가 실제로 필요한 자리에만 붙인다.

## 관련 글

- [Job 실행 — JobLauncher·JobOperator·JobExplorer](/notes/spring-batch/running-jobs/)
- [Flow 제어 — Decision·Split·Late Binding](/notes/spring-batch/flow-control-late-binding/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
