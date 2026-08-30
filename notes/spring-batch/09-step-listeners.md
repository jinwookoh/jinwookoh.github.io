---
title: "Step Listener"
series: spring-batch
part: "Step"
order: 9
summary: "Step 실행 사이클에 끼어드는 Listener 6종의 호출 시점과 트랜잭션 커밋 전후 위치를 정리한다"
tags: [Spring Batch, StepExecutionListener, ChunkListener, SkipListener, ExitStatus]
sources: [batch/2026-05-17-batch-step-listeners.md]
updated: 2026-08-29
---

Chunk 지향 Step은 시작·Chunk 시작·read·process·write·Chunk 종료·Step 종료로 이어지는 사이클로 돈다. 이 사이클의 특정 지점에서 메트릭을 찍거나, 실패 항목을 별도 테이블에 기록하거나, ExitStatus를 조건에 따라 바꾸는 요구는 거의 모든 배치에 있다. 이런 코드를 Reader·Writer 안에 섞으면 컴포넌트가 부수 작업으로 오염되고, "실제로 skip된 항목"처럼 프레임워크 내부 상태에 의존하는 정보는 컴포넌트 수준에서 알 수 없다. Spring Batch는 이 지점들을 `StepListener` 계열 인터페이스 6종으로 열어 둔다.

## 핵심 개념

`StepListener`는 비어 있는 marker 인터페이스이고, 실제 후크는 하위 인터페이스 6개가 제공한다. 모든 메서드가 default이므로 필요한 것만 오버라이드한다.

| Listener | 후크 | 호출 시점 |
|:---|:---|:---|
| `StepExecutionListener` | `beforeStep`, `afterStep` | Step 시작·종료 각 1회 |
| `ChunkListener` | `beforeChunk`, `afterChunk`, `afterChunkError` | 트랜잭션 시작 후, 커밋·롤백 후, 예외 시 |
| `ItemReadListener` | `beforeRead`, `afterRead`, `onReadError` | `read()` 전·후·예외 |
| `ItemProcessListener` | `beforeProcess`, `afterProcess`, `onProcessError` | `process()` 전·후·예외 |
| `ItemWriteListener` | `beforeWrite`, `afterWrite`, `onWriteError` | `write()` 전·후(커밋 전)·예외 |
| `SkipListener` | `onSkipInRead`, `onSkipInProcess`, `onSkipInWrite` | 커밋 직전, 항목당 1회 |

한 Chunk 안의 순서는 `beforeChunk` → (read·process 항목 단위 반복) → `beforeWrite` → `write()` → `afterWrite` → `SkipListener` → 커밋 → `afterChunk`다. `afterWrite`와 `afterChunk`는 커밋 경계를 사이에 두고 갈린다.

`afterStep`의 반환값이 Step의 최종 `ExitStatus`가 되며, Flow의 조건부 transition이 이 값을 본다. `afterProcess`의 `result`가 null이면 Processor가 필터링한 것이다.

`onXxxError` 후크는 예외가 날 때마다, 재시도 끝에 성공해도 시도마다 불리므로 최종 skip 여부는 알 수 없다. 그것은 `SkipListener`만 알려 주며, 프레임워크는 항목당 한 번만, 항상 커밋 직전에 호출됨을 보증한다. 롤백과 재스캔이 반복되는 fault-tolerant Step에서도 유지된다.

각 후크는 `org.springframework.batch.core.annotation` 패키지의 어노테이션(`@BeforeStep`, `@AfterChunk`, `@OnSkipInWrite` 등 메서드명과 1:1 대응)으로도 붙일 수 있다. 후크 하나만 필요하면 어노테이션, 여러 후크의 시그니처를 컴파일 타임에 강제하려면 인터페이스가 맞다.

등록은 `StepBuilder.listener()`에 넘기면 되고, 빌더가 구현체와 어노테이션 POJO를 모두 인식한다. Reader·Writer 자체가 Listener를 구현하면 자동 등록되지만 빌더에 직접 전달된 객체에만 적용되며, delegate 안쪽 컴포넌트는 `.listener()`로 따로 등록해야 한다.

## 코드

Step 종료 시 카운터를 읽어 ExitStatus를 동적으로 결정하는 `StepExecutionListener`다.

```java
import org.springframework.batch.core.ExitStatus;
import org.springframework.batch.core.StepExecution;
import org.springframework.batch.core.StepExecutionListener;
import org.springframework.stereotype.Component;

@Component
public class ConditionalStepListener implements StepExecutionListener {

    @Override
    public ExitStatus afterStep(StepExecution exec) {
        if (!exec.getFailureExceptions().isEmpty()) {
            return new ExitStatus("FAILED_CRITICAL");
        }
        if (exec.getSkipCount() > 1000) {
            return new ExitStatus("WARN_HIGH_SKIP");
        }
        return exec.getExitStatus();
    }
}
```

어노테이션 POJO 하나로 에러 알림과 skip 기록을 통합한 예다. 에러 후크는 시도마다 불리므로 알림 채널로, skip 후크는 최종 결과이므로 영속 저장으로 보낸다.

```java
import org.springframework.batch.core.annotation.*;
import org.springframework.batch.item.Chunk;
import org.springframework.stereotype.Component;

@Component
public class ErrorAndSkipListener {

    private final AlertClient alert;
    private final SkipLogRepository skipLogs;

    public ErrorAndSkipListener(AlertClient alert, SkipLogRepository skipLogs) {
        this.alert = alert;
        this.skipLogs = skipLogs;
    }

    @OnReadError
    public void onReadError(Exception e) {
        alert.send("read", e);
    }

    @OnWriteError
    public void onWriteError(Exception e, Chunk<? extends Order> items) {
        alert.send("write(" + items.size() + ")", e);
    }

    @OnSkipInRead
    public void onSkipInRead(Throwable t) {
        skipLogs.save(new SkipLog("READ", null, t.getMessage()));
    }

    @OnSkipInProcess
    public void onSkipInProcess(Order item, Throwable t) {
        skipLogs.save(new SkipLog("PROCESS", item.id(), t.getMessage()));
    }

    @OnSkipInWrite
    public void onSkipInWrite(Order item, Throwable t) {
        skipLogs.save(new SkipLog("WRITE", item.id(), t.getMessage()));
    }
}
```

Step·Chunk 단위 메트릭 Listener와 등록이다. `afterChunk`는 커밋 이후라 외부 호출에 안전하다.

```java
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.batch.core.*;
import org.springframework.batch.core.repository.JobRepository;
import org.springframework.batch.core.scope.context.ChunkContext;
import org.springframework.batch.core.step.builder.StepBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.transaction.PlatformTransactionManager;

public class MetricsListener implements StepExecutionListener, ChunkListener {

    private final MeterRegistry registry;
    private Timer.Sample sample;

    public MetricsListener(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void beforeStep(StepExecution exec) {
        sample = Timer.start(registry);
    }

    @Override
    public ExitStatus afterStep(StepExecution exec) {
        sample.stop(registry.timer("batch.step.duration", "step", exec.getStepName()));
        return exec.getExitStatus();
    }

    @Override
    public void afterChunk(ChunkContext context) {
        registry.counter("batch.chunk.completed").increment();
    }

    @Override
    public void afterChunkError(ChunkContext context) {
        registry.counter("batch.chunk.error").increment();
    }
}

@Bean
Step orderStep(JobRepository repo, PlatformTransactionManager tx,
               ConditionalStepListener stepListener,
               ErrorAndSkipListener errorListener,
               MetricsListener metricsListener) {
    return new StepBuilder("orderStep", repo)
        .<Order, Order>chunk(100, tx)
        .reader(orderReader())
        .processor(orderProcessor())
        .writer(orderWriter())
        .faultTolerant()
        .skip(InvalidOrderException.class).skipLimit(2000)
        .listener(stepListener)
        .listener(errorListener)
        .listener(metricsListener)
        .build();
}
```

## 실무에서 걸리는 지점

- **`afterWrite` 안의 외부 호출은 롤백에 묶인다.** 커밋 이전에 불리므로 여기서 발행한 메시지나 외부 API 호출은 이후 커밋이 실패해도 되돌릴 수 없다. 커밋 이후가 필요하면 `afterChunk`, 같은 트랜잭션에 묶여야 하는 기록이면 `SkipListener`를 쓴다.
- **Multi-threaded Step에서는 `ChunkListener`가 보장되지 않는다.** 공식 문서가 concurrent step에서의 호출을 보장하지 않는다고 명시한다. Tasklet Step에는 Chunk가 없어 의미가 없다.
- **`ChunkListener`에서 예외를 던지면 Step이 실패한다.** 내부 외부 호출은 try-catch로 감싸고 실패는 로그로만 남긴다.
- **`onXxxError`로 skip 통계를 내면 숫자가 부풀려진다.** skip 집계는 `SkipListener`에서 하고, 같은 항목에 `onSkipInXxx`가 두 번 불리면 Listener 중복 등록을 의심한다.
- **`@AfterStep` 메서드를 void로 선언하면 ExitStatus가 바뀌지 않는다.** 조건부 Flow가 동작하지 않을 때 가장 먼저 확인할 지점이다.

## 관련 글

- [Step — Chunk 지향과 Tasklet·Commit Interval](/notes/spring-batch/step-chunk-tasklet/)
- [Flow 제어 — Decision·Split·Late Binding](/notes/spring-batch/flow-control-late-binding/)
- [Skip과 Retry](/notes/spring-batch/skip-retry/)
