---
title: "Step — Chunk 지향과 Tasklet·Commit Interval"
series: spring-batch
part: "Step"
order: 6
summary: "Step은 chunk 지향과 Tasklet 두 방식으로 동작하며, chunk 크기가 곧 트랜잭션 경계이자 성능 튜닝의 핵심이다."
tags: [Spring Batch, Step, Chunk, Tasklet, Commit Interval]
sources: [batch/2026-05-17-batch-step-overview.md, batch/2026-05-17-batch-chunk-configuring.md, batch/2026-05-17-batch-tasklet-step.md, 2026-05-03-spring-batch-chunk.md]
updated: 2026-08-29
---

수백만 건을 단일 트랜잭션으로 묶으면 전체 데이터가 메모리에 올라가 OOM이 나고, 마지막 한 건의 실패가 앞선 결과를 모두 되돌린다. 반대로 한 건마다 commit하면 트랜잭션 오버헤드가 건수만큼 늘어난다. 파일 이동이나 프로시저 호출 같은 단발 작업을 Reader·Writer로 억지로 짜면 no-op Writer 같은 코드도 생긴다. Step은 이 문제를 chunk 지향 처리와 Tasklet이라는 두 실행 모델로 나누어 해결한다.

## 핵심 개념

Step은 Job을 구성하는 독립적이고 순차적인 단계로, 별도의 StepExecution과 트랜잭션 경계를 갖는다. 실행 모델은 두 가지뿐이며 `StepBuilder`에서 `.chunk()`와 `.tasklet()` 중 하나만 호출한다.

### Chunk 지향 처리

Reader가 chunk 크기만큼 `read()`를 반복해 아이템을 모으고, Processor가 한 건씩 처리한 뒤, Writer가 처리된 묶음을 한 번에 받아 쓴다. 이 사이클 하나가 트랜잭션 하나이며 write가 끝나면 commit한다. Reader와 Processor는 건 단위, Writer는 chunk 단위로 호출된다.

`read()`의 null은 데이터 종료 신호다. 모아둔 부분 chunk를 commit하고 Step을 끝내므로 마지막 chunk가 설정 크기보다 작은 것은 정상이다. Processor의 null은 해당 아이템을 Writer에 넘기지 않는 필터링이며 `filterCount`에 기록된다. 예외 후 건너뛰는 skip은 `skipCount`로 따로 집계된다.

chunk 중간에 예외가 나면 그 chunk만 rollback되고 이미 commit된 이전 chunk는 보존된다. 그래서 재시작·skip·retry의 단위가 chunk가 된다.

### Commit Interval

`chunk(N, transactionManager)`의 N이 commit interval이다. 100만 건을 N=1로 돌리면 트랜잭션이 100만 번, N=1000이면 1천 번이다. 크기를 키울수록 트랜잭션 오버헤드는 줄지만 메모리 점유, rollback 범위, DB lock 유지 시간이 함께 늘어난다.

| 항목 | 작은 chunk | 큰 chunk |
|:---|:---:|:---:|
| 트랜잭션 오버헤드 | 크다 | 작다 |
| 메모리 사용 | 적다 | 많다 |
| 실패 시 rollback 범위 | 좁다 | 넓다 |
| DB lock 유지 시간 | 짧다 | 길다 |

일반적인 DB row 기준으로 100~1000이 출발점이다. 레코드 하나가 수 MB인 큰 객체는 10~50, Processor에서 외부 API를 호출한다면 10~100으로 낮춰 호출 지연이 트랜잭션 timeout으로 번지지 않게 한다. 100에서 시작해 2배·5배로 늘리며 처리량을 측정하고 정체되는 지점에서 멈춘다. ==chunk 크기는 commit 단위이고 JDBC fetch size는 드라이버가 한 번에 가져오는 row 수로, 별개다.==

### TaskletStep

`Tasklet`은 `execute(StepContribution, ChunkContext)` 메서드 하나를 가진 인터페이스다. `RepeatStatus.FINISHED`를 반환하거나 예외를 던질 때까지 반복 호출되며, `CONTINUABLE`을 반환하면 다시 호출된다. 호출 한 번이 트랜잭션 하나다. `StepContribution`으로 카운트와 ExitStatus를 조작하고, `ChunkContext`를 통해 StepExecution·JobParameters·ExecutionContext에 접근한다. 기존 메서드를 감싸는 `MethodInvokingTaskletAdapter`, OS 명령을 실행하는 `SystemCommandTasklet`도 제공된다.

대량 데이터의 read·process·write 분리가 필요하면 chunk, 프로시저 호출·파일 정리·사전 검증·통계 통보 같은 단발 작업이면 Tasklet이다. 실무의 Job은 대개 준비용 Tasklet → 처리용 chunk Step → 정리용 Tasklet 순서로 구성된다.

## 코드

Reader·Processor·Writer를 묶은 chunk Step이다. 제네릭은 Reader 출력과 Processor 출력 타입이다.

```java
@Bean
public Step productStep(JobRepository jobRepository,
                        PlatformTransactionManager transactionManager,
                        FlatFileItemReader<Product> productReader,
                        JdbcBatchItemWriter<Product> productWriter) {
    return new StepBuilder("productStep", jobRepository)
        .<Product, Product>chunk(500, transactionManager)
        .reader(productReader)
        .processor(item -> {
            if (item.price() <= 0) {
                return null; // 필터링 — filterCount 증가, Writer로 전달되지 않음
            }
            return new Product(item.id(), item.name().toUpperCase(),
                               item.category(), item.price());
        })
        .writer(productWriter)
        .build();
}
```

Spring Batch 5부터 `ItemWriter.write()`는 `Chunk<? extends T>`를 받는다. 모든 아이템이 필터링되면 빈 Chunk가 들어온다.

```java
public class ProductLoggingWriter implements ItemWriter<Product> {

    private static final Logger log = LoggerFactory.getLogger(ProductLoggingWriter.class);

    @Override
    public void write(Chunk<? extends Product> chunk) {
        if (chunk.isEmpty()) {
            return;
        }
        log.info("writing {} items", chunk.size());
    }
}
```

JobParameters로 받은 디렉터리를 비우는 TaskletStep이다. 삭제 실패는 예외로 던져 Step을 FAILED로 만든다.

```java
@Bean
public Step cleanupStep(JobRepository jobRepository,
                        PlatformTransactionManager transactionManager) {
    Tasklet tasklet = (contribution, chunkContext) -> {
        String dir = chunkContext.getStepContext()
            .getStepExecution().getJobParameters().getString("inputDir");
        try (Stream<Path> files = Files.list(Path.of(dir))) {
            for (Path file : files.toList()) {
                Files.delete(file);
                contribution.incrementWriteCount(1);
            }
        }
        return RepeatStatus.FINISHED;
    };
    return new StepBuilder("cleanupStep", jobRepository)
        .tasklet(tasklet, transactionManager)
        .build();
}
```

## 실무에서 걸리는 지점

- **커스텀 Reader의 null 누락은 무한 루프다.** 직접 구현한 Reader는 종료 조건을 검증한다. `CONTINUABLE`을 반환하는 Tasklet도 같으며, 제한 없는 폴링은 스케줄러로 분리한다.
- **chunk 크기를 10만 단위로 잡으면 OOM과 긴 rollback이 함께 온다.** 한 건의 실패가 chunk 전체를 되돌리므로 skip을 켜지 않은 환경에서 비용이 크다.
- **Tasklet도 트랜잭션 안에서 실행된다.** 긴 작업은 timeout에 걸리고 외부 호출 실패가 곧 rollback이 된다. 긴 작업은 chunk로 쪼개거나 외부 호출을 트랜잭션 밖으로 뺀다.
- **Tasklet 안에서 ItemReader를 직접 돌리면 ItemStream이 등록되지 않는다.** ==`.stream(reader)`를 명시해야 재시작 시 위치가 복원된다.==
- **Processor는 싱글톤이다.** ==인스턴스 필드의 카운터는 chunk 사이에 공유되고 멀티스레드 Step에서 경쟁 조건이 된다.== 누적값은 ExecutionContext에 둔다.

## 관련 글

- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Skip과 Retry](/notes/spring-batch/skip-retry/)
- [트랜잭션 속성과 Repeat](/notes/spring-batch/transaction-attributes-repeat/)
