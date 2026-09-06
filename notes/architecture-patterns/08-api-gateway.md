---
title: "API 게이트웨이 — 단일 진입점과 BFF"
series: architecture-patterns
part: "서비스 통신"
order: 8
summary: "클라이언트가 서비스를 직접 호출하지 않도록 진입점을 하나로 모으고, 클라이언트 유형이 갈리면 BFF로 나눈다"
tags: [API Gateway, BFF, Spring Cloud Gateway, MSA]
sources: [https://jinwookoh.tistory.com/236]
updated: 2026-09-06
---

마이크로서비스 환경에서 클라이언트가 각 서비스를 직접 호출하면 몇 가지 문제가 동시에 생긴다. 모바일 앱이 메인 화면 하나를 그리기 위해 회원·주문·추천·알림 서비스를 각각 호출해야 하므로 왕복 횟수가 화면당 수 회로 늘어나고, 이동통신망처럼 지연이 큰 환경에서 체감 속도가 급격히 나빠진다. 모든 서비스가 인증·TLS·CORS·처리율 제한을 각자 구현해야 하고, 서비스 주소나 분할 구조가 바뀌면 클라이언트 배포까지 따라가야 한다. 내부 서비스가 외부에 그대로 노출되는 것 자체가 공격 표면을 넓힌다. API 게이트웨이는 이 문제를 클라이언트와 서비스 사이에 진입점 하나를 두는 방식으로 해결한다.

## 핵심 개념

게이트웨이는 클라이언트의 모든 요청을 받아 경로·헤더·호스트 기준으로 뒤쪽 서비스에 라우팅하는 리버스 프록시다. 라우팅 위에 인증 토큰 검증, 처리율 제한, TLS 종료, 요청·응답 로깅, 상관관계 ID 부여 같은 횡단 관심사를 얹는다. 서비스 쪽은 이 처리를 게이트웨이가 끝냈다고 가정하고 비즈니스 로직에만 집중한다. 클라이언트는 도메인 하나만 알면 되므로 내부 서비스 구성이 바뀌어도 라우팅 규칙만 고치면 된다.

게이트웨이를 어떤 단위로 두느냐에 따라 두 방식으로 갈린다.

| 구분 | 단일 중앙 게이트웨이 | BFF (Backend For Frontend) |
|---|---|---|
| 진입점 | 1개 | 클라이언트 유형별 N개 (Web·Mobile·Public API) |
| 응답 형태 | 모든 클라이언트에 동일 | 클라이언트별로 조합·축소 |
| 소유 팀 | 백엔드·플랫폼 팀 | 각 프론트엔드 팀 |
| 적합한 시점 | 클라이언트 종류가 적은 초기 | 클라이언트별 요구가 뚜렷하게 갈릴 때 |

단일 중앙 게이트웨이는 구축과 운영이 단순하고 보안 정책을 한곳에서 일관되게 적용할 수 있다. 대신 모든 트래픽이 한 지점을 지나므로 장애와 성능 병목이 집중되고, 클라이언트별 요구가 쌓이면 게이트웨이 안에 클라이언트 종류로 분기하는 조건문이 늘어나 여러 팀의 변경이 한 배포 단위에서 충돌한다.

BFF는 클라이언트 유형마다 전용 게이트웨이를 두는 방식이다. 모바일 BFF는 대시보드 요청 하나를 받아 회원·주문·알림 서비스를 병렬로 호출한 뒤 모바일 화면에 필요한 필드만 남겨 응답하고, 웹 BFF는 같은 화면에 고해상도 이미지와 상세 설명을 포함해 응답한다. 각 BFF를 해당 프론트엔드 팀이 소유하므로 백엔드 팀의 일정을 기다리지 않고 응답 구조를 바꿀 수 있다. 대가로 배포 단위가 늘고, 인증 같은 공통 로직이 BFF마다 중복될 수 있다. 실무에서는 두 방식을 계층으로 겹친다. 앞단에 TLS 종료·인증·처리율 제한만 맡는 얇은 엣지 게이트웨이를 두고, 그 뒤에 클라이언트별 BFF가 집계와 응답 변환을 담당하는 구성이 일반적이다.

## 코드

Spring Cloud Gateway로 경로 기반 라우팅과 처리율 제한을 선언한다. 처리율 제한 카운터는 Redis에 저장한다.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: product-service
          uri: lb://product-service
          predicates:
            - Path=/api/v1/products/**
          filters:
            - StripPrefix=2
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
        - id: order-service
          uri: lb://order-service
          predicates:
            - Path=/api/v1/orders/**
          filters:
            - StripPrefix=2
```

모든 요청에 상관관계 ID를 부여해 뒤쪽 서비스로 전달하는 글로벌 필터다. WebFlux 기반이므로 필터 안에서 블로킹 호출을 하지 않는다.

```java
@Component
public class CorrelationIdFilter implements GlobalFilter, Ordered {

    static final String HEADER = "X-Correlation-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String id = Optional.ofNullable(exchange.getRequest().getHeaders().getFirst(HEADER))
                .orElse(UUID.randomUUID().toString());
        ServerHttpRequest request = exchange.getRequest().mutate()
                .header(HEADER, id)
                .build();
        exchange.getResponse().getHeaders().add(HEADER, id);
        return chain.filter(exchange.mutate().request(request).build());
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
```

모바일 BFF가 세 서비스를 가상 스레드로 병렬 호출해 화면 전용 응답으로 조합하는 예다. 알림 서비스가 실패해도 화면은 그려야 하므로 해당 항목만 기본값으로 대체한다.

```java
@RestController
@RequestMapping("/mobile-api")
public class MobileDashboardController {

    private final RestClient members;
    private final RestClient orders;
    private final RestClient notifications;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public MobileDashboardController(RestClient.Builder builder) {
        this.members = builder.baseUrl("http://member-service").build();
        this.orders = builder.baseUrl("http://order-service").build();
        this.notifications = builder.baseUrl("http://notification-service").build();
    }

    public record DashboardResponse(String nickname, List<String> recentOrderIds, int unreadCount) {}

    @GetMapping("/dashboard")
    public DashboardResponse dashboard(@RequestHeader("X-User-Id") String userId) throws Exception {
        var member = executor.submit(() ->
                members.get().uri("/members/{id}", userId).retrieve().body(Member.class));
        var recent = executor.submit(() ->
                orders.get().uri("/orders?userId={id}&limit=3", userId).retrieve().body(OrderPage.class));
        var unread = executor.submit(() -> {
            try {
                return notifications.get().uri("/notifications/unread-count?userId={id}", userId)
                        .retrieve().body(Integer.class);
            } catch (RestClientException e) {
                return 0;
            }
        });
        return new DashboardResponse(
                member.get(2, TimeUnit.SECONDS).nickname(),
                recent.get(2, TimeUnit.SECONDS).orders().stream().map(Order::id).toList(),
                unread.get(2, TimeUnit.SECONDS));
    }
}
```

## 실무에서 걸리는 지점

- 단일 장애점. 게이트웨이가 죽으면 뒤쪽 서비스가 모두 정상이어도 전체가 멈춘다. 게이트웨이는 상태를 갖지 않게 만들어 여러 인스턴스로 띄우고, 처리율 제한 카운터나 세션 같은 상태는 Redis 등 외부 저장소에 둔다. ==처리율 제한 카운터를 인스턴스 메모리에 두면 인스턴스 수만큼 한도가 배로 늘어나 제한이 사실상 동작하지 않는다.==
- 타임아웃 계층. ==게이트웨이의 응답 타임아웃이 뒤쪽 서비스의 타임아웃보다 길면, 서비스가 이미 실패를 돌려준 뒤에도 게이트웨이가 연결을 붙들고 있어 장애 때 스레드와 커넥션이 고갈된다.== 바깥 계층일수록 타임아웃을 짧게 잡고, BFF 집계에서는 가장 느린 호출이 전체 응답 시간을 결정하므로 호출별 타임아웃과 부분 실패 시 대체값을 정한다.
- 블로킹 호출. Spring Cloud Gateway는 WebFlux 위에서 소수의 이벤트 루프 스레드로 동작한다. ==필터 안에서 JDBC 조회나 동기 HTTP 호출을 하면 이벤트 루프가 막혀 게이트웨이 전체 처리량이 무너진다.== 토큰 검증처럼 외부 조회가 필요한 작업은 논블로킹 클라이언트를 쓰거나 결과를 캐시한다.
- 비즈니스 로직 유입. 게이트웨이에 클라이언트 종류로 분기하는 조건문이나 도메인 규칙이 들어가기 시작하면 모든 팀의 변경이 한 배포 단위로 몰린다. 게이트웨이에는 라우팅과 횡단 관심사만 남기고, 클라이언트별 조합은 BFF로 옮긴다.
- 헤더 전파. 게이트웨이나 BFF가 요청을 다시 만들면서 Authorization, 상관관계 ID, 추적 헤더를 빠뜨리면 뒤쪽 서비스에서 인증이 실패하거나 분산 추적이 끊긴다. 반대로 BFF가 백엔드 응답을 그대로 반환하면 내부용 필드가 외부에 노출되므로, 응답은 항상 화면 전용 DTO로 다시 만든다.

## 관련 글

- [서비스 디스커버리 — 클라이언트 사이드와 서버 사이드](/notes/architecture-patterns/service-discovery/)
- [처리율 제한 — 고정 윈도·슬라이딩 윈도·토큰 버킷](/notes/architecture-patterns/rate-limiter/)
- [서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태](/notes/architecture-patterns/circuit-breaker/)
