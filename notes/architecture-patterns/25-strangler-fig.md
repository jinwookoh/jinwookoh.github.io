---
title: "스트랭글러 — 레거시를 점진적으로 교체하기"
series: architecture-patterns
part: "API·운영"
order: 25
summary: "레거시 앞에 프록시를 세우고 기능 단위로 라우팅을 옮기면 빅뱅 재작성 없이 시스템을 교체할 수 있다"
tags: [Strangler Fig, Spring Cloud Gateway, 마이그레이션, 레거시, MSA]
sources: [https://jinwookoh.tistory.com/254]
updated: 2026-09-06
---

10년 된 모놀리스를 새 아키텍처로 옮기기로 결정하면 가장 먼저 떠오르는 방식은 전면 재작성이다. 레거시를 그대로 운영하면서 옆에서 새 시스템을 처음부터 끝까지 만들고, 정해진 날짜에 스위치를 내려 교체한다. 이 방식은 설계의 자유가 크지만 실패 확률도 크다. 개발 기간 동안 비즈니스 요구가 계속 바뀌므로 기능 변경을 양쪽에 이중으로 반영해야 하고, 오픈 전까지는 사용자 피드백을 전혀 받지 못하며, 누적된 데이터를 하룻밤에 일괄 이관해야 한다. 오픈 당일 장애가 나면 되돌릴 단위가 시스템 전체라서 롤백 비용도 전체 규모다. 스트랭글러 패턴은 이 위험을 기능 단위로 쪼개기 위한 방법이다.

## 핵심 개념

스트랭글러 패턴은 레거시 앞에 프록시를 두고, 기능을 하나씩 새 시스템으로 옮기면서 프록시의 라우팅을 바꿔 나가는 방식이다. 레거시와 신규 시스템이 한동안 공존하며, 사용자는 어느 쪽이 요청을 처리하는지 알 필요가 없다. 적용 순서는 다음과 같다.

1. 프록시 설치: 모든 트래픽을 가로채는 API 게이트웨이를 앞단에 둔다. 처음에는 100% 레거시로 전달하므로 동작 변화가 없다.
2. 경계 식별: 의존성이 적고 작은 기능(예: 리뷰 조회)을 첫 대상으로 고른다. 결제나 주문처럼 트랜잭션 범위가 넓은 기능은 뒤로 미룬다.
3. 기능 이전: 해당 기능을 새 서비스로 구현한다. 레거시 데이터가 필요하면 새 서비스가 직접 레거시 테이블을 읽지 않고 어댑터 계층을 통해 접근한다.
4. 라우팅 전환: 게이트웨이에서 해당 경로만 새 서비스로 보낸다. 문제가 생기면 라우팅만 되돌리면 된다.
5. 반복과 폐기: 회원, 주문, 결제 순으로 반복하고, 레거시에 남은 기능이 없으면 레거시를 내린다.

전면 재작성과의 차이는 배포 시점과 롤백 단위에 있다.

| 구분 | 전면 재작성 | 스트랭글러 |
|---|---|---|
| 배포 시점 | 프로젝트 종료 시 한 번 | 기능 이전이 끝날 때마다 |
| 롤백 단위 | 시스템 전체 | 라우팅 한 줄 |
| 데이터 이관 | D-Day 일괄 이관 | 기능별 소유권 이전, 기간 한정 이중 쓰기 |
| 피드백 | 오픈 전까지 없음 | 첫 기능부터 수집 |
| 적합한 경우 | 시스템이 작거나 유지가 불가능할 때 | 대규모 시스템, 비즈니스가 성장 중일 때 |

데이터는 라우팅보다 어렵다. 기능이 옮겨가면 그 기능이 소유하는 데이터도 새 서비스로 넘어가야 하는데, 레거시의 다른 기능이 같은 테이블을 참조하고 있는 경우가 대부분이다. 이 기간에는 새 서비스가 원본이 되고 레거시는 동기화된 사본을 읽거나, 새 서비스 API를 호출하도록 레거시 쪽 코드를 고쳐야 한다.

## 코드

Spring Cloud Gateway의 Java DSL로 라우팅을 정의한다. 옮긴 기능은 구체 경로로 새 서비스에 보내고, 나머지는 모두 레거시로 보낸다. `order`로 우선순위를 명시해 catch-all이 먼저 매칭되는 일을 막는다.

```java
@Configuration
public class StranglerRouteConfig {

    @Bean
    public RouteLocator routes(RouteLocatorBuilder builder) {
        return builder.routes()
            .route("review-service", r -> r
                .path("/api/reviews/**")
                .uri("lb://review-service"))
            .route("legacy-monolith", r -> r
                .order(Integer.MAX_VALUE)
                .path("/**")
                .uri("http://legacy-system:8080"))
            .build();
    }
}
```

전환 초기에 트래픽 일부만 새 서비스로 보내려면 Weight 프레딕에이트를 쓴다. 같은 그룹 이름을 가진 라우트끼리 가중치를 나눠 갖는다.

```java
@Bean
public RouteLocator canaryRoutes(RouteLocatorBuilder builder) {
    return builder.routes()
        .route("review-new", r -> r
            .path("/api/reviews/**")
            .and().weight("review", 10)
            .uri("lb://review-service"))
        .route("review-legacy", r -> r
            .path("/api/reviews/**")
            .and().weight("review", 90)
            .uri("http://legacy-system:8080"))
        .build();
}
```

레거시 내부에서 리뷰 기능을 직접 호출하던 코드는 새 서비스를 호출하도록 바꾼다. 인터페이스를 유지하고 구현만 교체하면 호출부를 건드리지 않아도 된다.

```java
@Service
public class RemoteReviewFacade implements ReviewFacade {

    private final RestClient client;

    public RemoteReviewFacade(RestClient.Builder builder) {
        this.client = builder.baseUrl("http://review-service").build();
    }

    @Override
    public List<ReviewSummary> findByProduct(long productId) {
        return client.get()
            .uri("/api/reviews?productId={id}", productId)
            .retrieve()
            .body(new ParameterizedTypeReference<>() {});
    }
}
```

## 실무에서 걸리는 지점

- 게이트웨이 라우팅만 옮기고 레거시 내부의 직접 호출을 남겨 두면 외부 요청은 새 서비스가, 레거시 내부 흐름은 옛 코드가 처리하는 상태가 된다. ==같은 기능이 두 구현으로 동시에 동작하면 데이터가 조용히 갈라지므로, 라우팅 전환 전에 레거시 내부 호출 경로를 모두 찾아 새 서비스로 돌려야 한다.==
- 이중 쓰기 기간에는 두 저장소 중 어느 쪽이 원본인지 명시적으로 정해야 한다. ==원본을 정하지 않고 양쪽에 쓰면 장애 복구 시 어느 데이터가 맞는지 판단할 수 없고, 이 상태가 길어질수록 정합성 복구 비용이 커진다.== 이중 쓰기는 종료 시점을 정해 둔 임시 조치여야 한다.
- 레거시가 서버 세션 기반 인증이면 새 서비스는 그 세션을 검증할 수 없다. 게이트웨이에서 인증을 처리하고 내부로는 검증된 사용자 정보를 헤더나 토큰으로 전달하는 구조로 먼저 바꿔야 기능 이전이 진행된다.
- catch-all 라우트의 순서를 지정하지 않으면 등록 순서에 따라 `/**`가 구체 경로보다 먼저 매칭될 수 있다. 라우트를 추가할 때마다 실제 매칭 결과를 확인하는 테스트를 둔다.
- 전환이 길어지면 레거시 폐기 단계에 도달하지 못하고 두 시스템이 영구 공존하는 경우가 흔하다. 공존 자체가 운영 비용이므로, 마지막 기능의 이전 일정과 레거시 폐기 기준을 처음부터 계획에 넣어야 한다.

## 관련 글

- [API 게이트웨이 — 단일 진입점과 BFF](/notes/architecture-patterns/api-gateway/)
- [피처 토글 — 배포와 릴리스 분리](/notes/architecture-patterns/feature-toggle/)
- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
