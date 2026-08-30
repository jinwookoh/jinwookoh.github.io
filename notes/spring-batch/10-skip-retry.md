---
title: "Skip과 Retry"
series: spring-batch
part: "오류 처리와 트랜잭션"
order: 10
summary: "영구적 데이터 오류는 Skip, 일시적 오류는 Retry — faultTolerant 이후 두 정책이 단계별로 어떻게 동작하는지 정리한다"
tags: [Spring Batch, Skip, Retry, SkipPolicy, BackOffPolicy]
sources: [batch/2026-05-17-batch-skip-logic.md, batch/2026-05-17-batch-retry-logic.md, batch/2026-05-17-batch-retry.md, 2026-05-03-spring-batch-error-handling.md]
updated: 2026-08-29
---

수백만 건을 처리하는 Step은 예외 한 건으로 전체가 FAILED 되는 것도, 모든 예외를 삼키고 COMPLETED 되는 것도 곤란하다. 전자는 CSV 한 줄의 포맷 오류가 야간 배치를 멈추고, 후자는 중요한 데이터가 소리 없이 사라진다. Spring Batch는 이 사이를 두 정책으로 메운다. 재시도해도 결과가 같은 영구적 오류(파싱·검증 실패)는 해당 아이템만 건너뛰는 **Skip**, 잠시 뒤 성공할 수 있는 일시적 오류(Deadlock, 타임아웃)는 다시 시도하는 **Retry**다. 금융 거래처럼 정확성이 전제인 데이터는 Skip 대상이 아니며, 어느 쪽을 쓸지는 데이터의 의미가 결정한다.

## 핵심 개념

두 정책 모두 `StepBuilder`에서 `faultTolerant()`를 호출한 뒤에만 유효하다. 이 호출이 `FaultTolerantStepBuilder`로 전환하는 관문이고, 빠뜨리면 이후의 `skip()`·`retry()` 설정이 무시된다.

Skip은 `skip(Class)`로 대상 예외를, `skipLimit(N)`으로 Step 전체의 누적 허용 횟수를 정한다. N+1번째 skip에서 `SkipLimitExceededException`으로 Step이 FAILED 된다. 하위 예외 클래스는 자동 포함되며 `noSkip(Class)`으로 특정 하위 예외만 제외한다. 빌더 방식은 내부적으로 `LimitCheckingExceptionHierarchySkipPolicy`를 만드는 것이고, `skipPolicy()`로 정책을 직접 넣으면 `skip()`·`skipLimit()`은 무시된다.

Skip 동작은 단계마다 다르다.

| 단계 | 동작 | 비용 |
|:---|:---|:---|
| Read | 예외가 난 아이템만 버리고 다음 `read()` 진행 | 낮음 |
| Process | 해당 아이템만 chunk에서 제외, 나머지는 Write로 | 낮음 |
| Write | chunk 전체 롤백 후 **1건씩 별도 트랜잭션으로 재기록**, 실패한 것만 skip | 높음 |

Write에서는 원인 아이템을 알 수 없으므로 chunk를 되돌리고 하나씩 다시 쓴다. Skip 카운트는 `StepExecution`에 read·process·write 별로 저장되고, 재시작 시 이전 실행의 카운트에서 이어서 센다. 재시작으로 한계를 우회할 수 없다.

Retry는 `retry(Class)`와 `retryLimit(N)`으로 설정한다. N은 첫 시도를 포함한 총 시도 횟수다. 재시도 단위는 아이템이 아니라 **chunk**다. Process나 Write에서 대상 예외가 나면 트랜잭션을 롤백하고 새 트랜잭션에서 chunk를 처음부터 다시 처리한다. Reader 예외는 Retry 대상이 아니므로 Read 단계의 일시적 오류는 Reader 내부에서 재연결하거나 Skip으로 처리한다.

재시도 사이의 대기는 `backOffPolicy()`로 정한다. 기본은 `NoBackOffPolicy`(즉시 재시도)이며, 외부 API에는 지수 증가에 jitter를 더한 `ExponentialRandomBackOffPolicy`가, DB Deadlock에는 재시도 시점을 흩어 주는 `UniformRandomBackOffPolicy`가 맞는다. Spring Batch 6부터는 `spring-retry`에 의존하지 않고 재시도 클래스가 `org.springframework.batch.infrastructure.retry` 패키지로 옮겨졌다.

두 정책을 함께 걸면 Retry가 먼저다. 한도까지 재시도하고도 실패하면 skip 정책을 확인하고, 둘 다 해당하지 않으면 Step이 FAILED 된다.

## 코드

Skip과 Retry를 함께 건 운영형 Step이다. 일시적 오류는 재시도하고 데이터 오류는 건너뛴다.

```java
@Configuration
public class RobustEtlStepConfig {

    @Bean
    public Step robustEtlStep(JobRepository jobRepository,
                              PlatformTransactionManager transactionManager,
                              ItemReader<RawRecord> reader,
                              ItemProcessor<RawRecord, CleanRecord> processor,
                              ItemWriter<CleanRecord> writer,
                              SkipListener<RawRecord, CleanRecord> skipListener) {

        ExponentialRandomBackOffPolicy backOff = new ExponentialRandomBackOffPolicy();
        backOff.setInitialInterval(200);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(10_000);

        return new StepBuilder("robustEtlStep", jobRepository)
                .<RawRecord, CleanRecord>chunk(500, transactionManager)
                .reader(reader)
                .processor(processor)
                .writer(writer)
                .faultTolerant()
                .retryLimit(3)
                .retry(DeadlockLoserDataAccessException.class)
                .retry(TransientDataAccessException.class)
                .noRetry(IllegalArgumentException.class)
                .backOffPolicy(backOff)
                .skipLimit(100)
                .skip(FlatFileParseException.class)
                .skip(ValidationException.class)
                .noSkip(CriticalDataException.class)
                .listener(skipListener)
                .build();
    }
}
```

건너뛴 아이템을 별도 테이블에 남기는 SkipListener다. Read 단계에는 아이템 객체가 없으므로 `FlatFileParseException`에서 원본 라인과 라인 번호를 꺼낸다. 저장은 chunk 트랜잭션과 분리하기 위해 `REQUIRES_NEW`를 쓴다.

```java
@Component
public class DlqSkipListener implements SkipListener<RawRecord, CleanRecord> {

    private static final Logger log = LoggerFactory.getLogger(DlqSkipListener.class);
    private final SkippedRecordRepository repository;

    public DlqSkipListener(SkippedRecordRepository repository) {
        this.repository = repository;
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onSkipInRead(Throwable t) {
        String payload = null;
        int line = -1;
        if (t instanceof FlatFileParseException e) {
            payload = e.getInput();
            line = e.getLineNumber();
        }
        repository.save(new SkippedRecord("READ", line, payload, t.getClass().getName(), t.getMessage()));
        log.warn("skip in read, line={}", line, t);
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onSkipInProcess(RawRecord item, Throwable t) {
        repository.save(new SkippedRecord("PROCESS", -1, item.toString(), t.getClass().getName(), t.getMessage()));
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onSkipInWrite(CleanRecord item, Throwable t) {
        repository.save(new SkippedRecord("WRITE", -1, item.toString(), t.getClass().getName(), t.getMessage()));
    }
}
```

원본 데이터를 보고 skip 여부를 정하는 커스텀 SkipPolicy다. 필드 수가 모자라면 필수 데이터 누락으로 보고 실패시키고, 그 외의 파싱 오류만 건너뛴다. `shouldSkip`의 두 번째 인자는 누적 skip 횟수다.

```java
public class FieldCountSkipPolicy implements SkipPolicy {

    private static final int EXPECTED_FIELDS = 4;
    private final long limit;

    public FieldCountSkipPolicy(long limit) {
        this.limit = limit;
    }

    @Override
    public boolean shouldSkip(Throwable t, long skipCount) throws SkipLimitExceededException {
        if (t instanceof CriticalDataException) {
            return false;
        }
        if (skipCount >= limit) {
            throw new SkipLimitExceededException((int) limit, t);
        }
        if (t instanceof FlatFileParseException e) {
            String line = e.getInput();
            return line != null && line.split(",").length >= EXPECTED_FIELDS;
        }
        return t instanceof ValidationException;
    }
}
```

## 실무에서 걸리는 지점

- **Write skip의 비용.** chunk 롤백 후 1건씩 재기록하므로 chunk 크기만큼 트랜잭션이 늘어난다. Writer에서 잡히는 제약 위반은 Processor 단계의 검증으로 앞당겨 Process skip으로 바꾼다.
- **광범위한 skip·retry.** `skip(Exception.class)`은 코드 버그를 데이터 오류로 위장시키고, `retry(Exception.class)`는 성공할 수 없는 호출을 반복한다. 예상 가능한 예외만 명시한다.
- **Retry는 read()도 다시 호출한다.** 외부 API를 부르거나 상태를 바꾸는 Reader는 중복 호출된다. Writer가 멱등하지 않은 외부 시스템을 부른다면 idempotency key 없이 Retry를 걸지 않는다.
- **BackOff 없는 재시도.** 기본이 즉시 재시도라 상대 시스템에 부하가 몰리고, 재시도 동안 chunk 트랜잭션이 커넥션을 붙들고 있어 풀이 고갈된다. 3~5회에 최대 대기 수 초 안쪽이 무난하다.
- **Step retry와 `@Retryable`의 중첩.** Processor 메서드와 Step에 같은 예외를 걸면 총 시도 횟수가 곱으로 늘어난다. API 호출은 메서드 단위, DB Deadlock은 chunk 단위로 책임을 나눈다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Step Listener](/notes/spring-batch/step-listeners/)
- [트랜잭션 속성과 Repeat](/notes/spring-batch/transaction-attributes-repeat/)
