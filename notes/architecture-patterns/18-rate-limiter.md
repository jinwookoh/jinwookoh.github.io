---
title: "처리율 제한 — 고정 윈도·슬라이딩 윈도·토큰 버킷"
series: architecture-patterns
part: "복원력"
order: 18
summary: "고정 윈도는 구간 경계에서 한도의 두 배를 통과시키므로 짧은 주기의 제한에는 슬라이딩 윈도나 토큰 버킷을 쓴다"
tags: [Rate Limiter, Token Bucket, Sliding Window, Bucket4j, Redis]
sources: [https://jinwookoh.tistory.com/239]
updated: 2026-09-06
---

서버가 감당할 수 있는 요청량에는 상한이 있다. 매크로가 선착순 API를 초당 수천 번 호출하거나 한 클라이언트의 배치 작업이 공용 API를 독점하면, 나머지 사용자까지 응답을 받지 못한다. 처리율 제한은 호출자별·자원별로 단위 시간당 허용 요청 수를 정하고 초과분을 429 Too Many Requests로 거부해 서비스 전체를 보호하는 패턴이다. 다만 알고리즘마다 "단위 시간"을 세는 방식이 달라서, 같은 "분당 100회"라도 실제 통과량은 두 배까지 벌어진다.

## 핵심 개념

### 고정 윈도 카운터

시간을 일정 길이(예: 1분)로 잘라 구간마다 카운터를 둔다. 요청이 올 때마다 1씩 올리고 한도에 닿으면 거부하며, 다음 구간이 시작되면 새 카운터를 만든다. Redis라면 `INCR`과 `EXPIRE` 두 명령으로 끝나고 키 하나당 정수 하나만 저장하므로 가장 싸다.

문제는 구간 경계다. ==12:00:59에 100회, 12:01:00에 100회를 보내면 두 구간 모두 한도 안이므로 2초 동안 200회가 통과한다.== 한도가 실질적으로 두 배로 풀리는 셈이라, 초 단위의 정밀한 제어에는 맞지 않는다.

### 슬라이딩 윈도 로그

요청 시각을 모두 기록해 두고, 요청이 올 때마다 "지금부터 과거 1분" 안의 기록 수를 센다. 경계가 없으므로 어느 순간을 잘라도 1분 내 요청 수가 한도를 넘지 않는다. 대신 호출자마다 한도만큼의 타임스탬프를 저장해야 해서 메모리가 한도에 비례한다. Redis Sorted Set에 score를 타임스탬프로 넣고 `ZREMRANGEBYSCORE`로 오래된 항목을 지운 뒤 `ZCARD`로 세는 구현이 일반적이다.

### 슬라이딩 윈도 카운터

로그 방식의 메모리를 줄인 근사 방식이다. 이전 구간과 현재 구간의 카운터만 들고, 현재 시점이 구간에서 차지하는 비율로 가중 합산한다. 1분 구간에서 15초가 지났다면 `이전 × 0.75 + 현재`를 요청 수로 본다. 정확하지는 않지만 경계 문제를 실용 수준에서 해소하며, 정수 두 개만 저장한다.

### 토큰 버킷

용량이 정해진 버킷에 일정 속도로 토큰을 채우고, 요청마다 토큰 하나를 꺼낸다. 토큰이 없으면 거부한다. 버킷에 쌓인 만큼의 순간 폭주는 허용하고, 그 뒤로는 리필 속도가 평균 처리율을 결정한다. 상태는 "남은 토큰 수"와 "마지막 리필 시각" 두 값뿐이다. AWS API Gateway를 비롯한 공용 API 제한의 표준 방식이다.

| 방식 | 경계 문제 | 상태 크기 | 버스트 |
|---|---|---|---|
| 고정 윈도 | 있음 (최대 2배) | 정수 1개 | 구간 초반에 몰림 |
| 슬라이딩 로그 | 없음 | 한도만큼의 타임스탬프 | 없음 |
| 슬라이딩 카운터 | 근사 해소 | 정수 2개 | 없음 |
| 토큰 버킷 | 없음 | 정수 2개 | 용량만큼 허용 |

하루 1,000회 같은 긴 주기의 쿼터는 고정 윈도로 충분하다. 초당 100회 같은 짧은 주기의 제한은 경계 문제가 그대로 장애로 이어지므로 토큰 버킷이나 슬라이딩 윈도를 쓴다.

## 코드

Bucket4j로 호출자별 토큰 버킷을 만든다. 용량 100, 초당 10개 리필이므로 순간 100회까지 허용하고 이후 평균 초당 10회로 수렴한다.

```java
@Service
public class TokenBucketLimiter {

    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    private Bucket newBucket() {
        Bandwidth limit = Bandwidth.builder()
                .capacity(100)
                .refillGreedy(10, Duration.ofSeconds(1))
                .build();
        return Bucket.builder().addLimit(limit).build();
    }

    public boolean tryConsume(String clientId) {
        return buckets.computeIfAbsent(clientId, k -> newBucket()).tryConsume(1);
    }
}
```

서블릿 필터에서 한도를 넘긴 요청을 429로 끊고 `Retry-After`를 함께 돌려준다.

```java
@Component
@RequiredArgsConstructor
public class RateLimitFilter extends OncePerRequestFilter {

    private final TokenBucketLimiter limiter;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String clientId = Optional.ofNullable(request.getHeader("X-Api-Key"))
                .orElse(request.getRemoteAddr());

        if (limiter.tryConsume(clientId)) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader("Retry-After", "1");
        response.getWriter().write("rate limit exceeded");
    }
}
```

여러 인스턴스가 한도를 공유해야 하면 Redis Sorted Set으로 슬라이딩 윈도 로그를 구현한다. 오래된 항목 제거·개수 확인·추가를 Lua 스크립트 하나로 묶어 원자적으로 처리한다.

```java
@Component
@RequiredArgsConstructor
public class RedisSlidingWindowLimiter {

    private static final RedisScript<Long> SCRIPT = RedisScript.of("""
            redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
            if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
              redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
              redis.call('PEXPIRE', KEYS[1], ARGV[2])
              return 1
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public boolean tryAcquire(String clientId, int limit, Duration window) {
        long now = System.currentTimeMillis();
        Long allowed = redis.execute(SCRIPT, List.of("rl:" + clientId),
                String.valueOf(now),
                String.valueOf(window.toMillis()),
                String.valueOf(limit),
                now + ":" + UUID.randomUUID());
        return Long.valueOf(1).equals(allowed);
    }
}
```

## 실무에서 걸리는 지점

- **인스턴스별 로컬 상태**: 인메모리 버킷은 인스턴스마다 따로 센다. ==인스턴스 5대에 분당 100회 버킷을 로컬로 두면 전역 한도는 분당 500회가 되고, 스케일 아웃할 때마다 알림 없이 늘어난다.== 전역 한도가 필요하면 Redis 같은 공유 저장소나 게이트웨이 계층에서 센다.
- **읽기-판단-쓰기의 원자성**: Redis에서 `ZCARD`로 확인한 뒤 `ZADD`를 따로 보내면 동시 요청 사이에서 둘 다 통과한다. 고정 윈도에서 `INCR` 결과가 1일 때만 `EXPIRE`를 거는 구현도 두 명령 사이에서 프로세스가 죽으면 키가 만료 없이 남는다. Lua 스크립트로 한 번에 묶는다.
- **429와 재시도의 상호작용**: ==클라이언트의 재시도 정책이 429를 일반 실패로 취급해 즉시 재시도하면 제한이 트래픽을 오히려 늘린다.== 거부 응답에는 `Retry-After`를, 허용 응답에는 `X-RateLimit-Remaining`을 실어 클라이언트가 스스로 속도를 조절하게 한다.
- **식별 키 선택**: IP 기준은 NAT나 프록시 뒤의 사용자 전체를 한 덩어리로 묶고, `X-Forwarded-For`는 위조할 수 있다. 인증된 API 키나 사용자 ID를 우선하고 IP는 비인증 구간의 보조 기준으로만 쓴다.
- **버킷 맵 누수와 용량 산정**: 호출자별 `ConcurrentHashMap`은 지우지 않으면 무한히 자라므로 Caffeine 같은 만료 캐시에 담는다. 버킷 용량은 클라이언트가 한 번에 쏠 수 있는 최대치이므로, 다운스트림이 견디는 순간 부하에 맞춰 잡는다.

## 관련 글

- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
- [벌크헤드 — 스레드 풀·세마포어로 자원 격리](/notes/architecture-patterns/bulkhead/)
- [API 게이트웨이 — 단일 진입점과 BFF](/notes/architecture-patterns/api-gateway/)
