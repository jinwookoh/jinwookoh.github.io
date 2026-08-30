---
title: "Virtual Thread — 원리·API·Pinning"
series: java-spring
part: "자바 기초·모던 자바"
order: 7
summary: "Virtual Thread가 Carrier 위에서 mount·unmount하는 원리, 생성 API 4가지, synchronized가 일으키는 Pinning의 원인과 대응을 정리한다."
tags: [Virtual Thread, Project Loom, Carrier Thread, Pinning, ReentrantLock]
sources: [2026-05-03-vt-concurrency-basics.md, 2026-05-03-vt-virtual-thread.md, 2026-05-03-vt-api.md, 2026-05-03-vt-pinning.md]
updated: 2026-08-29
---

전통적인 Java 스레드(Platform Thread)는 OS 커널 스레드와 1:1로 대응한다. 스레드마다 1~2MB의 스택을 고정 예약하고 컨텍스트 스위칭 비용이 크므로 동시 요청 1만 개를 스레드 1만 개로 받는 설계는 성립하지 않았다. 고정 크기 스레드 풀이 표준이 됐지만 처리량이 풀 크기에 묶이고, 요청 시간의 대부분인 I/O 대기 동안 스레드는 놀면서 슬롯을 점유한다. 이를 피하려면 CompletableFuture나 Reactor 같은 논블로킹 모델로 옮겨야 했는데, 코드가 콜백 체인으로 바뀌고 JDBC 같은 블로킹 라이브러리를 그대로 쓸 수 없었다. Java 21에서 정식화된 Virtual Thread(JEP 444)는 블로킹 코드를 그대로 두고 논블로킹 수준의 처리량을 얻기 위한 답이다.

## 핵심 개념

Virtual Thread는 OS 스레드가 아니라 JVM이 관리하는 힙 객체다. 실제 실행은 Carrier Thread라 부르는 Platform Thread가 맡고, Carrier 풀은 기본적으로 코어 수만큼의 병렬도를 가진 ForkJoinPool이다. Virtual Thread는 실행 시 Carrier에 mount되고, `Thread.sleep`·소켓 I/O·`LockSupport.park`·`ReentrantLock` 대기처럼 JDK가 블로킹 지점으로 인식하는 호출을 만나면 unmount된다. 이때 스택 프레임은 힙에 저장되고 Carrier는 즉시 다른 Virtual Thread를 실행한다. I/O가 끝나면 스택을 복원해 다시 mount되는데, 이 저장·복원이 JVM 내부 Continuation 메커니즘이며 사용자 코드가 직접 다루지 않는다.

재개 시 같은 Carrier에서 실행된다는 보장은 없다. ForkJoinPool의 work stealing 때문이다. 다만 `ThreadLocal`은 Virtual Thread 단위로 유지되므로 Carrier가 바뀌어도 값은 보존된다.

Platform Thread가 고정 스택을 미리 잡는 것과 달리 Virtual Thread의 스택은 unmount 상태에서 실제 사용량만큼(대개 수 KB) 힙에 남고 GC 대상이 되므로 수십만~수백만 개를 동시에 유지할 수 있다. ==다만 늘어나는 것은 I/O 대기 중의 동시성이지 병렬성이 아니다.== CPU 집약 작업은 여전히 코어 수에 묶인다.

Virtual Thread는 별도 클래스가 아니라 `java.lang.Thread`의 구현이므로 `join`·`interrupt`·`getState`가 그대로 동작한다. 다른 점은 항상 daemon이고, 우선순위가 무시되며, 기본 이름이 빈 문자열이라는 것이다. 가벼우므로 풀링하지 않고 작업마다 새로 만드는 것이 표준이다.

## 코드

단순 실행은 `startVirtualThread`, 이름·예외 핸들러가 필요하면 `Thread.ofVirtual()` 빌더, ExecutorService 연동은 `factory()`를 쓴다.

```java
Thread simple = Thread.startVirtualThread(() ->
        System.out.println(Thread.currentThread()));
simple.join();

Thread.Builder.OfVirtual builder = Thread.ofVirtual()
        .name("worker-", 0)   // worker-0, worker-1, ...
        .uncaughtExceptionHandler((t, e) -> log.error("{} failed", t.getName(), e));

Thread vt = builder.unstarted(() -> callExternalApi());
vt.start();
vt.join();

ThreadFactory factory = Thread.ofVirtual().name("vt-", 0).factory();
```

운영 코드의 표준은 `Executors.newVirtualThreadPerTaskExecutor()`다. Java 19부터 `ExecutorService`가 `AutoCloseable`이므로 try-with-resources를 벗어날 때 `shutdown` 후 모든 작업 완료를 기다린다.

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = new ArrayList<>();
    for (int i = 0; i < 10_000; i++) {
        int id = i;
        futures.add(executor.submit(() -> httpClient.get("/api/items/" + id)));
    }
    for (Future<String> f : futures) {
        process(f.get());   // 블로킹 호출이지만 Virtual Thread는 unmount된다
    }
}
```

`CompletableFuture`는 executor를 지정하지 않으면 `ForkJoinPool.commonPool()`에서 실행되므로 Virtual Thread executor를 명시한다.

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    CompletableFuture<String> user = CompletableFuture.supplyAsync(() -> fetchUser(), executor);
    CompletableFuture<String> order = CompletableFuture.supplyAsync(() -> fetchOrder(), executor);
    String merged = user.thenCombine(order, (u, o) -> u + o).join();
}
```

## 실무에서 걸리는 지점

**Pinning — `synchronized` 안에서의 블로킹.** ==Java 21~23에서 `synchronized` 블록·메서드 안에서 I/O나 `Object.wait()`를 만나면 unmount되지 못하고 Carrier에 고정된다.== 이 상태가 동시에 여러 건 발생하면 Carrier 수만큼만 처리되어 Platform Thread 풀과 같아진다. 블로킹 호출을 감싸는 락은 `ReentrantLock` + try-finally로, `wait/notify`는 `Condition`으로 바꾼다. Java 24(JEP 491)부터 `synchronized` 안에서도 unmount되므로 업그레이드가 근본 해결책이다.

**JNI와 CPU 집약 코드.** 네이티브 프레임이 스택에 있으면 unmount할 수 없다. 네이티브 대기가 길거나 CPU 연산이 긴 작업은 Platform Thread 풀로 분리한다.

**파일 I/O는 unmount되지 않는다.** ==파일 I/O는 Carrier를 점유한 채 블로킹하며, JVM이 Carrier 풀을 일시적으로 늘려 보상한다(`jdk.virtualThreadScheduler.maxPoolSize`, 기본 256).== 파일 I/O 비중이 큰 작업은 이 한도를 함께 검토한다.

**Pinning 탐지.** Java 21~23은 `-Djdk.tracePinnedThreads=full|short`로 Pinning 지점의 스택을 출력하는데 로그량이 커 개발·스테이징에서만 켠다. Java 24부터 이 옵션은 제거되고 JFR의 `jdk.VirtualThreadPinned` 이벤트로 대체된다.

**의존성과 커넥션 풀.** ==오래된 JDBC 드라이버·HTTP 클라이언트·로거는 내부 `synchronized`로 Pinning을 유발하므로 PostgreSQL JDBC 42.7+, HikariCP 5.x+ 같은 버전으로 올린다.== DB 커넥션은 유한하므로 풀 크기는 DB가 감당할 수준으로 두고 나머지는 풀에서 대기하게 한다.

**ThreadLocal과 ScopedValue.** 수백만 스레드가 각각 ThreadLocal 값을 들면 메모리가 급증한다. 요청 범위 컨텍스트 전달은 `ScopedValue`(Java 21 Preview, Java 25 정식)로 옮긴다.

## 관련 글

- [Modern Java 9~21 핵심](/notes/java-spring/modern-java/)
- [Virtual Thread — 실전·Spring Boot·Structured Concurrency](/notes/java-spring/virtual-thread-practice/)
- [이벤트·비동기·스케줄링](/notes/java-spring/events-async-scheduling/)
