---
title: "트랜잭션 속성과 Repeat"
series: spring-batch
part: "오류 처리와 트랜잭션"
order: 11
summary: "chunk 트랜잭션의 격리·전파·타임아웃을 어떻게 잡고, 그 아래에서 도는 RepeatTemplate을 어떻게 직접 쓰는가"
tags: [Spring Batch, DefaultTransactionAttribute, Propagation, RepeatTemplate, CompletionPolicy]
sources: [batch/2026-05-17-batch-transaction-attributes.md, batch/2026-05-17-batch-repeat.md]
updated: 2026-08-29
---

chunk 지향 Step은 chunk마다 트랜잭션을 열고 닫는다. ==속성을 지정하지 않으면 격리 수준은 DB 기본값, 전파는 REQUIRED, 타임아웃은 무제한(-1)이다.== 느린 외부 호출이 섞인 chunk가 커넥션을 잡은 채 멈춰도 끊어주지 않고, SkipListener가 남긴 기록은 chunk 롤백과 함께 사라진다. 반복 제어도 마찬가지로, 폴링 Tasklet에 시간 한도와 건수 한도를 함께 두려면 카운터를 직접 관리해야 한다. 앞은 Transaction Attributes가, 뒤는 Repeat 추상화가 담당한다.

## 핵심 개념

Step의 `transactionAttribute()`에 `DefaultTransactionAttribute`를 넘기면 chunk 트랜잭션의 세 속성을 정한다. Spring core의 `@Transactional`과 같은 모델이며 적용 단위만 chunk다.

**Isolation**은 동시 실행 트랜잭션 사이의 격리 수준이다. 대부분의 배치는 DEFAULT 또는 READ_COMMITTED로 충분하고, SERIALIZABLE은 여러 chunk가 같은 row를 동시에 수정할 때만 쓴다. JobRepository의 `ISOLATION_SERIALIZABLE`은 JobExecution 동시 생성을 막는 메타데이터 쪽 설정으로 별개다.

**Propagation**의 chunk 기본값은 REQUIRED다. REQUIRES_NEW는 항상 새 트랜잭션을 열어 chunk가 롤백돼도 해당 작업만 따로 커밋되므로 DLQ 저장이나 감사 로그에 쓴다. NOT_SUPPORTED는 트랜잭션 없이 실행하며 파일 압축이나 shell 실행처럼 DB 트랜잭션 의미가 없는 Tasklet에 적용한다.

**Timeout**은 초 단위로 chunk 하나의 최대 시간이다. `chunk size × 항목당 평균 처리 시간 × 안전계수 2~3`으로 잡는다. 일반 DB chunk는 30~120초, 외부 API 호출이 포함되면 60~300초, 대량 insert는 300~1,800초가 출발점이다.

ItemProcessor나 ItemWriter에 붙인 `@Transactional`은 chunk 트랜잭션 안에서 평가된다. 전파를 명시하지 않으면 chunk 트랜잭션에 참여할 뿐이다.

chunk 반복의 밑바닥에는 `RepeatOperations`가 있다. `RepeatTemplate.iterate(callback)`은 `RepeatCallback.doInIteration(context)`를 반복 호출하고, 각 호출은 `RepeatStatus`(CONTINUABLE·FINISHED)를 반환한다. Tasklet의 반환값과 같은 enum이다. callback이 FINISHED를 돌려주면 즉시 멈추고, 아니면 `CompletionPolicy`가 매 반복 뒤 `isComplete`로 판단한다. 표준 구현은 `SimpleCompletionPolicy(N)`, `TimeoutTerminationPolicy(ms)`, 여러 정책을 묶는 `CompositeCompletionPolicy`다. chunk Step은 이 RepeatTemplate 위에서 한 iteration을 read·process·write·commit으로 채운 구조다.

callback의 예외는 `ExceptionHandler`가 받아 다시 던지거나(종료), 흡수하거나(계속), 변환한다. `SimpleLimitExceptionHandler`는 지정 타입을 한도까지 흡수하고 초과분부터 다시 던진다. `RepeatListener`는 open·close가 전체에 한 번, before·after·onError가 매 iteration에 호출되며, 여러 개면 open·before는 등록 순, 나머지는 역순이다. `TaskExecutorRepeatTemplate`은 비동기 TaskExecutor를 넣으면 iteration을 병렬로 돌린다. `RepeatOperationsInterceptor`는 AOP로 메서드 호출을 자동 반복시키며 ==void 반환은 항상 CONTINUABLE, null 반환만 FINISHED다==.

## 코드

chunk 트랜잭션 속성을 Bean으로 만들어 여러 Step에서 재사용한다.

```java
@Configuration
public class ChunkTxConfig {

    @Bean
    public TransactionAttribute defaultChunkTx() {
        DefaultTransactionAttribute attr = new DefaultTransactionAttribute();
        attr.setIsolationLevel(Isolation.READ_COMMITTED.value());
        attr.setPropagationBehavior(Propagation.REQUIRED.value());
        attr.setTimeout(120);
        return attr;
    }

    @Bean
    public Step orderStep(JobRepository repo, PlatformTransactionManager tx,
                          ItemReader<Order> reader, ItemWriter<Order> writer,
                          TransactionAttribute defaultChunkTx) {
        return new StepBuilder("orderStep", repo)
            .<Order, Order>chunk(500, tx)
            .reader(reader)
            .writer(writer)
            .transactionAttribute(defaultChunkTx)
            .build();
    }
}
```

SkipListener의 DLQ 저장을 REQUIRES_NEW로 분리해 chunk 롤백과 무관하게 커밋한다.

```java
@Component
public class DlqSkipListener implements SkipListener<Order, Order> {

    private final DlqRepository dlqRepository;

    public DlqSkipListener(DlqRepository dlqRepository) {
        this.dlqRepository = dlqRepository;
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onSkipInProcess(Order item, Throwable t) {
        dlqRepository.save(new DlqRecord(item.id(), t.getMessage()));
    }
}
```

Tasklet 안에서 RepeatTemplate으로 큐를 폴링한다. 건수 한도, 시간 한도, 큐 비움 중 먼저 오는 조건에서 멈추고 일시적 예외는 열 번까지 흡수한다.

```java
@Bean
public Tasklet pollingTasklet(MessageQueue queue, MessageHandler handler) {
    return (contribution, chunkContext) -> {
        SimpleLimitExceptionHandler exceptionHandler = new SimpleLimitExceptionHandler();
        exceptionHandler.setLimit(10);
        exceptionHandler.setExceptionClasses(List.of(TransientException.class));

        RepeatTemplate template = new RepeatTemplate();
        template.setCompletionPolicy(new CompositeCompletionPolicy(
            new SimpleCompletionPolicy(100),
            new TimeoutTerminationPolicy(30_000)));
        template.setExceptionHandler(exceptionHandler);

        template.iterate(ctx -> {
            Message msg = queue.poll();
            if (msg == null) {
                return RepeatStatus.FINISHED;
            }
            handler.handle(msg);
            return RepeatStatus.CONTINUABLE;
        });
        return RepeatStatus.FINISHED;
    };
}
```

## 실무에서 걸리는 지점

- 타임아웃이 없으면 stuck 트랜잭션이 커넥션을 무기한 점유하고, 3,600초처럼 크면 멈춘 Job을 감지하지 못한다. 측정값 기반 한계와 모니터링을 같이 둔다.
- SERIALIZABLE로 올리면 deadlock과 serialization failure가 잦아진다. 해당 예외를 retry 대상에 포함시켜야 chunk가 살아남는다.
- REQUIRES_NEW는 별도 커넥션을 쓴다. ==멀티스레드 Step에서는 커넥션 풀이 스레드 수의 두 배로 소모된다.==
- NOT_SUPPORTED Step은 ExecutionContext 갱신도 트랜잭션 밖이라 재시작 안전성이 떨어진다. 단발성 Tasklet에만 쓴다.
- CompletionPolicy 없이 callback이 항상 CONTINUABLE을 반환하면 무한 루프다. RepeatOperationsInterceptor의 void 메서드가 특히 그렇다. ExceptionHandler가 반응하지 않으면 대개 checked 예외를 등록하지 않은 탓이다.

## 관련 글

- [Step — Chunk 지향과 Tasklet·Commit Interval](/notes/spring-batch/step-chunk-tasklet/)
- [Skip과 Retry](/notes/spring-batch/skip-retry/)
- [Step Listener](/notes/spring-batch/step-listeners/)
