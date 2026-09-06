---
title: "벌크헤드 — 스레드 풀·세마포어로 자원 격리"
series: architecture-patterns
part: "복원력"
order: 17
summary: "느린 의존성 하나가 서버 전체 스레드를 잠식하지 않도록 동시 실행 수와 스레드 풀을 기능별로 나누는 방법"
tags: [Bulkhead, Resilience4j, Semaphore, ThreadPool, Spring Boot]
sources: [https://jinwookoh.tistory.com/243]
updated: 2026-09-06
---

하나의 서블릿 컨테이너 스레드 풀을 모든 API가 공유하는 구조에서는 느린 기능 하나가 서비스 전체를 멈추게 한다. 이미지 업로드가 외부 스토리지 지연으로 수십 초씩 걸리기 시작하면 요청 스레드가 그 호출에 묶이고, 풀이 소진되는 순간 텍스트 조회 같은 가벼운 API까지 대기열에 쌓여 타임아웃을 낸다. 벌크헤드 패턴은 스레드·커넥션 같은 자원을 기능별 구역으로 나눠, 한 구역이 가득 차더라도 다른 구역은 정상적으로 동작하게 만든다.

## 핵심 개념

벌크헤드는 자원 사용량에 상한을 두는 방식에 따라 두 가지로 나뉜다.

**세마포어 격리**는 호출을 실행하는 스레드를 바꾸지 않는다. 동시에 진입할 수 있는 호출 수(permit)만 제한하고, 허가를 얻은 요청 스레드가 그대로 작업을 수행한 뒤 반납한다. 스레드 생성이나 컨텍스트 스위칭이 없어 오버헤드는 카운터 연산 수준에 그친다. 대신 허가를 잡은 스레드가 I/O에서 멈추면 그 스레드는 계속 점유된다. 격리 자체는 유지되지만 스레드 회수는 하위 호출의 타임아웃에 전적으로 의존한다.

**스레드 풀 격리**는 보호 대상 호출을 전용 스레드 풀에서 실행한다. 요청 스레드는 작업을 제출하고 `CompletableFuture`로 결과를 받는다. 전용 풀이 가득 차더라도 요청 스레드 풀은 비어 있으므로 다른 기능은 영향을 받지 않는다. 호출이 별도 스레드에서 돌기 때문에 호출자 입장에서는 결과를 기다리는 시간에 상한을 두기 쉽다. 비용은 컨텍스트 스위칭과 풀별 메모리, 그리고 `ThreadLocal`에 담긴 보안 컨텍스트·MDC·트랜잭션 정보가 전파되지 않는다는 점이다.

| 구분 | 세마포어 격리 | 스레드 풀 격리 |
|---|---|---|
| 실행 스레드 | 호출 스레드 그대로 | 전용 풀의 스레드 |
| 오버헤드 | 카운터 연산 수준 | 컨텍스트 스위칭·풀별 메모리 |
| 타임아웃 | 하위 호출 타임아웃에 의존 | 호출자가 대기 시간 상한을 둘 수 있음 |
| 컨텍스트 전파 | 불필요 | ThreadLocal 별도 전파 필요 |
| 적합한 대상 | 응답 시간이 안정적인 내부 서비스, 고트래픽 경로 | 응답 시간을 예측할 수 없는 외부·레거시 시스템 |

Hystrix는 스레드 풀 격리를 기본으로 채택했고, 그 후속으로 쓰이는 Resilience4j는 세마포어 격리를 기본(`Bulkhead`)으로, 스레드 풀 격리를 별도 모듈(`ThreadPoolBulkhead`)로 제공한다. 세마포어 방식이 기본이 된 이유는 대부분의 호출에서 격리 효과 대비 비용이 훨씬 낮기 때문이다. 스레드 풀 격리는 응답 시간을 통제할 수 없는 호출을 서버 스레드에서 완전히 떼어내야 할 때만 선택한다.

## 코드

Resilience4j 설정. 세마포어 벌크헤드는 `maxWaitDuration`을 0으로 두면 허가가 없을 때 즉시 실패하고, 스레드 풀 벌크헤드는 스레드가 모두 사용 중이면 큐에 쌓였다가 큐까지 차면 거부한다.

```yaml
resilience4j:
  bulkhead:
    instances:
      boardService:
        maxConcurrentCalls: 50
        maxWaitDuration: 0ms
  thread-pool-bulkhead:
    instances:
      imageService:
        coreThreadPoolSize: 5
        maxThreadPoolSize: 10
        queueCapacity: 20
  timelimiter:
    instances:
      imageService:
        timeoutDuration: 3s
        cancelRunningFuture: true
```

세마포어 격리를 적용한 동기 호출. 허가를 얻지 못하면 `BulkheadFullException`이 발생하고 `fallbackMethod`가 대신 응답한다.

```java
@Service
public class BoardService {

    private final RestClient restClient;

    public BoardService(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("http://board-api").build();
    }

    @Bulkhead(name = "boardService", fallbackMethod = "fallback")
    public List<PostSummary> recentPosts() {
        return restClient.get()
                .uri("/posts?limit=20")
                .retrieve()
                .body(new ParameterizedTypeReference<>() {});
    }

    private List<PostSummary> fallback(BulkheadFullException e) {
        return List.of();
    }
}
```

스레드 풀 격리를 적용한 비동기 호출. 메서드는 `CompletionStage`를 반환해야 하며, 메서드 본문은 전용 풀의 스레드에서 실행된다.

```java
@Service
public class ImageService {

    private final ImageStorageClient storage;

    public ImageService(ImageStorageClient storage) {
        this.storage = storage;
    }

    @Bulkhead(name = "imageService", type = Bulkhead.Type.THREADPOOL,
              fallbackMethod = "fallback")
    @TimeLimiter(name = "imageService")
    public CompletableFuture<String> upload(byte[] content) {
        return CompletableFuture.completedFuture(storage.put(content));
    }

    private CompletableFuture<String> fallback(byte[] content, Throwable t) {
        return CompletableFuture.failedFuture(
                new ImageUploadUnavailableException(t));
    }
}
```

## 실무에서 걸리는 지점

**허가 수 산정.** 세마포어의 `maxConcurrentCalls`는 `server.tomcat.threads.max`(기본 200)보다 충분히 작아야 한다. ==한 벌크헤드의 허가 수가 요청 스레드 수에 가까우면 그 기능이 멈출 때 서버 전체가 함께 멈춘다.== 허가 수는 처리량 목표가 아니라, 해당 기능이 완전히 정지했을 때 나머지 기능에 남는 스레드가 얼마인지를 기준으로 정한다.

**타임아웃은 별도로 필요하다.** 세마포어 격리는 스레드를 회수하지 않는다. `RestClient`·JDBC·Redis 클라이언트마다 연결·읽기 타임아웃을 설정하지 않으면 허가는 반납되지 않고 하위 호출이 끝날 때까지 점유된다. 스레드 풀 격리도 예외가 아니다. ==Resilience4j `TimeLimiter`의 cancel은 `CompletableFuture.cancel`을 호출할 뿐 실행 중인 풀 스레드를 인터럽트하지 않는다.== 호출자는 타임아웃 응답을 받지만 풀 스레드는 여전히 하위 호출에 묶여 있으므로, 하위 타임아웃이 없으면 전용 풀도 결국 고갈된다.

**서킷 브레이커와의 조합.** Resilience4j 기본 애스펙트 순서에서 서킷 브레이커가 벌크헤드 바깥을 감싼다. ==`BulkheadFullException`을 서킷 브레이커의 `ignoreExceptions`에 넣지 않으면 자기 용량 초과가 실패로 집계되어 서킷이 열린다.== 하위 시스템은 정상인데 서킷이 열려 트래픽 전체가 폴백으로 빠지는 상황이 된다.

**컨텍스트 전파.** 스레드 풀 격리 안의 코드는 호출 스레드의 `SecurityContext`, MDC, 트랜잭션에 접근할 수 없다. `@Transactional` 메서드에서 스레드 풀 벌크헤드 메서드를 호출해도 그 안의 DB 작업은 다른 커넥션과 다른 트랜잭션으로 실행되고, 바깥 트랜잭션이 롤백돼도 되돌아가지 않는다. 필요한 값은 인자로 넘기고, 로깅 컨텍스트처럼 반드시 옮겨야 하는 값은 Resilience4j의 `ContextPropagator`를 등록해 전파한다.

**가상 스레드 환경.** Java 21에서 `spring.threads.virtual.enabled=true`로 요청 처리를 가상 스레드로 바꾸면 요청 스레드 소진 자체는 드물어진다. 그러나 벌크헤드가 불필요해지는 것은 아니다. 제한 없이 늘어난 동시 호출은 DB 커넥션 풀이나 하위 서비스로 그대로 쏟아지므로 하위 자원 보호 목적의 세마포어 격리는 여전히 필요하다.

## 관련 글

- [서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태](/notes/architecture-patterns/circuit-breaker/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
- [처리율 제한 — 고정 윈도·슬라이딩 윈도·토큰 버킷](/notes/architecture-patterns/rate-limiter/)
