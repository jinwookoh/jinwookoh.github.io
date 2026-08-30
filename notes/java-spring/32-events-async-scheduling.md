---
title: "이벤트·비동기·스케줄링"
series: java-spring
part: "운영·통합"
order: 32
summary: "부가 작업을 도메인 이벤트로 분리하고 @Async 스레드 풀과 @Scheduled 분산 락으로 안전하게 운영하는 방법"
tags: [ApplicationEvent, "@Async", CompletableFuture, "@Scheduled", ShedLock]
sources: [spring/2026-05-17-application-event-listener.md, spring/2026-05-17-async-completable-future.md, spring/2026-05-16-scheduled-task.md]
updated: 2026-08-29
---

주문 완료 서비스가 이메일 발송, SMS 발송, 재고 차감, 포인트 적립을 직접 호출하면 세 가지 문제가 생긴다. `OrderService`가 협력 서비스를 모두 알아야 하므로 부가 작업이 늘 때마다 핵심 클래스를 수정하게 되고, 부가 작업이 응답 경로에 동기로 놓여 외부 호출 시간이 그대로 응답 지연이 되며, 이메일 발송 실패가 주문 트랜잭션 롤백으로 번진다. ==여기에 새벽 집계나 주기 폴링 같은 반복 작업까지 더해지면 이벤트·비동기·스케줄링을 하나의 실행 모델로 이해해야 운영 사고를 피할 수 있다.==

## 핵심 개념

### ApplicationEvent와 리스너

발행자는 `ApplicationEventPublisher.publishEvent()`로 사건을 알리고, 수신자는 `@EventListener` 메서드의 매개변수 타입으로 받을 이벤트를 결정한다. 이벤트 객체는 `ApplicationEvent`를 상속할 필요 없이 record면 충분하다. 이름은 `OrderCompletedEvent`처럼 비즈니스 사건을 표현하고, `DatabaseUpdatedEvent` 같은 구현 관점의 이름은 피한다.

기본 `@EventListener`는 발행자와 같은 스레드에서 동기 실행되며 발행자의 트랜잭션에 참여한다. 따라서 리스너의 예외가 발행자를 롤백시키고, 리스너 소요 시간이 응답 시간에 더해진다.

`@TransactionalEventListener`는 리스너를 트랜잭션 단계에 묶는다. `phase`는 `BEFORE_COMMIT`, `AFTER_COMMIT`(기본값), `AFTER_ROLLBACK`, `AFTER_COMPLETION` 네 가지다. 활성 트랜잭션이 없으면 호출되지 않으며, 트랜잭션 밖에서도 실행하려면 `fallbackExecution = true`를 지정한다. `AFTER_COMMIT`에서 DB 쓰기를 하려면 `REQUIRES_NEW`로 새 트랜잭션을 열어야 한다.

### @Async와 CompletableFuture

`@EnableAsync`를 활성화하면 `@Async` 메서드는 프록시를 거쳐 별도 스레드에서 실행된다. 반환 타입은 `void` 또는 `CompletableFuture<T>`다. `CompletableFuture`는 `thenApply`(변환), `thenCompose`(비동기 체이닝), `thenCombine`(결합), `allOf`/`anyOf`(다중 대기), `exceptionally`/`handle`(예외 처리)로 흐름을 조합한다.

Spring Boot 3.x는 `spring.task.execution.*` 속성으로 `ThreadPoolTaskExecutor`를 자동 구성한다. 기본값은 core 8, max와 queue 무제한이므로 운영에서는 값을 명시한다. Boot 3.2 이상에서 `spring.threads.virtual.enabled=true`를 주면 `@Async`와 `@Scheduled` 모두 가상 스레드에서 실행된다.

| 구분 | ApplicationEvent | Kafka·RabbitMQ |
|---|---|---|
| 범위 | 같은 JVM | 여러 프로세스·서버 |
| 영속성 | 없음, 프로세스 종료 시 유실 | 브로커가 보관 |
| 재시도 | 직접 구현 | 내장 |
| 적합한 용도 | 단일 서비스 내 모듈 분리 | 서비스 간 통신, 전달 보장 |

### @Scheduled

`@EnableScheduling` 후 `@Scheduled`를 붙인 void·무인자 메서드가 주기 실행된다. `fixedRate`는 직전 실행 시작 시점, `fixedDelay`는 직전 실행 종료 시점 기준으로 다음 실행을 잡는다. `cron`은 초·분·시·일·월·요일 6자리로 Linux cron의 5자리와 다르다. 스케줄러는 기본 스레드 1개로 순차 실행하므로 `spring.task.scheduling.pool.size`를 늘리거나 `@Async`를 조합해야 긴 작업이 다른 스케줄을 막지 않는다.

## 코드

커밋 확정 후 비동기로 이메일을 보내는 도메인 이벤트 구성이다.

```java
public record OrderCompletedEvent(Long orderId, Long userId, String email, int amount) {}

@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository repository;
    private final ApplicationEventPublisher publisher;

    @Transactional
    public void completeOrder(Long orderId) {
        Order order = repository.findById(orderId).orElseThrow();
        order.complete();
        publisher.publishEvent(new OrderCompletedEvent(
                order.getId(), order.getUserId(), order.getEmail(), order.getAmount()));
    }
}

@Component
@RequiredArgsConstructor
public class OrderEmailListener {

    private final EmailService emailService;

    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderCompleted(OrderCompletedEvent event) {
        emailService.sendOrderConfirm(event.email(), event.orderId());
    }
}
```

이메일 전용 풀을 분리한 실행기 설정과, 외부 API 세 곳을 병렬 호출하는 조합 예제다.

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Bean("emailExecutor")
    public ThreadPoolTaskExecutor emailExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("email-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        return executor;
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) ->
                log.error("async failure in {}", method.getName(), ex);
    }
}

@Service
@RequiredArgsConstructor
public class DashboardService {

    private final UserApi userApi;
    private final OrderApi orderApi;
    private final PaymentApi paymentApi;

    public Dashboard fetch(Long userId) {
        CompletableFuture<User> user = userApi.getUserAsync(userId);
        CompletableFuture<List<Order>> orders = orderApi.getOrdersAsync(userId);
        CompletableFuture<List<Payment>> payments = paymentApi.getPaymentsAsync(userId);

        return CompletableFuture.allOf(user, orders, payments)
                .thenApply(v -> new Dashboard(user.join(), orders.join(), payments.join()))
                .exceptionally(ex -> Dashboard.fallback(userId))
                .join();
    }
}
```

다중 인스턴스에서 한 번만 실행되도록 ShedLock을 적용한 스케줄러다.

```java
@Component
@ConditionalOnProperty(name = "scheduler.enabled", havingValue = "true")
@RequiredArgsConstructor
public class ReportScheduler {

    private final ReportService reportService;

    @Scheduled(cron = "0 0 3 * * *", zone = "Asia/Seoul")
    @SchedulerLock(name = "dailyReport", lockAtLeastFor = "1m", lockAtMostFor = "30m")
    public void generateDailyReport() {
        reportService.generate(LocalDate.now(ZoneId.of("Asia/Seoul")).minusDays(1));
    }

    @Scheduled(fixedDelay = 30_000, initialDelay = 10_000)
    public void pollQueue() {
        reportService.drainPending();
    }
}
```

## 실무에서 걸리는 지점

- ==**자가 호출은 프록시를 우회한다.** `@Async`와 `@Transactional`은 프록시 기반이므로 같은 클래스 안에서 `this.method()`로 호출하면 적용되지 않는다.== 비동기 메서드는 별도 빈으로 분리한다.
- **비동기 리스너에서 지연 로딩은 실패한다.** `@Async` 스레드는 발행자의 영속성 컨텍스트를 공유하지 않아 lazy 연관을 건드리면 `LazyInitializationException`이 난다. 이벤트에는 엔티티 대신 필요한 값을 담는다.
- **무제한 큐는 장애를 늦게 드러낸다.** Boot 기본 실행기는 queue가 무제한이라 유입이 처리량을 넘으면 메모리가 서서히 차오른다. queue 용량·max 크기·거부 정책을 명시하고, 실패 특성이 다른 작업은 풀을 분리한다.
- **`@Async void`의 예외는 사라진다.** 호출자가 받을 수 없으므로 `AsyncUncaughtExceptionHandler`로 로그와 알림을 남긴다. `CompletableFuture` 반환이면 `exceptionally`나 `handle`로 처리한다.
- ==**스케줄러는 인스턴스 수만큼 실행된다.** 서버 3대면 새벽 집계가 3번 돈다.== ShedLock으로 락을 잡거나 배치 인스턴스를 분리하고, `lockAtMostFor`는 작업 최대 시간보다 길게 잡는다. cron에는 `zone`을 명시해 컨테이너의 UTC 기본값과 어긋나지 않게 하고, 실패해도 다음 스케줄은 진행되므로 예외 로깅과 알림을 붙인다.

## 관련 글

- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
- [MSA 입문 — Spring Kafka·Cloud Gateway](/notes/java-spring/msa-spring-kafka-gateway/)
