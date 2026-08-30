---
title: "Statsig 개관과 SDK Quickstart"
series: experimentation
part: "Statsig"
order: 8
summary: "Statsig의 네 축과 Cloud/Warehouse Native 구분을 정리하고 Java Server SDK로 첫 Feature Gate를 연결한다"
tags: [Statsig, Feature Flag, A/B Testing, Product Analytics, Java SDK]
sources: [statsig/2026-05-17-statsig-welcome.md, statsig/2026-05-17-statsig-sdk-quickstart.md]
updated: 2026-08-30
---

기능 토글이 코드 안의 boolean 상수로 박혀 있으면 기능을 켜고 끄는 일이 곧 재배포가 되고, 롤백 수단도 코드 revert뿐이다. A/B 테스트는 수작업 SQL로 분석하고, 사용자 행동과 서버 지연은 각각 다른 도구에서 본다. "새 결제 흐름을 켰더니 전환율이 올랐지만 p99 지연도 늘었다" 같은 결론을 내기 어렵고, 도구마다 식별자와 이벤트를 다시 이어 붙이는 비용이 실험 자체보다 커진다. Statsig는 이 요소들을 한 데이터 흐름 위에 올리는 플랫폼이다.

## 핵심 개념

Statsig는 Feature Flag, Experimentation, Product Analytics, Infra Analytics의 네 축으로 구성된다. Feature Flag는 코드의 분기를 대시보드에서 제어하는 스위치로 점진 rollout과 재배포 없는 즉시 OFF에 쓴다. Experimentation은 무작위 통제 시험으로 variant를 비교하고 p-value와 신뢰구간을 자동 계산한다. Product Analytics는 SDK가 보낸 이벤트로 Funnel, Retention, Distribution, User Journeys, Lifecycle 차트를 만든다. Infra Analytics는 OpenTelemetry 호환 sink로 서비스 헬스 메트릭과 트레이스를 받는다. 네 축이 같은 사용자 식별자와 이벤트 스트림을 공유하므로 flag를 켰을 때의 funnel 변화 같은 cross-axis 질의가 추가 작업 없이 가능하다.

Feature Flag라고 부르는 것은 실제로 세 유형으로 갈린다.

| 유형 | 반환값 | 용도 |
|:---|:---|:---|
| Feature Gate | boolean | 단순 ON/OFF, Scheduled Rollout, Override, Holdout |
| Dynamic Config | JSON 파라미터 묶음 | 가격·임계값·문구처럼 재배포 없이 바꾸는 값 |
| Experiment | variant 할당 + 파라미터 | 가설 검증과 통계 비교, exposure 자동 기록 |

세 유형은 같은 평가 엔진 위에 있다. ==Experiment만 exposure를 통계 분석에 연결한다.==

무작위화 단위는 실험 설계에서 가장 먼저 정한다. B2C는 user 단위, 로그인 전 구간은 device 단위, B2B는 같은 회사의 사용자가 다른 variant를 받지 않도록 organization 단위를 쓴다. Session 단위는 매 세션 variant가 바뀌므로 피한다. Statsig는 식별자를 결정론적 해시로 variant에 매핑하므로 같은 ID를 넘기면 모든 SDK가 같은 결과를 반환한다.

데이터 저장 위치는 두 옵션이다. Statsig Cloud는 이벤트를 Statsig 인프라로 보내는 managed 방식이고 무료 plan이 월 200만 이벤트까지 받는다. Warehouse Native는 Snowflake·BigQuery·Databricks·Redshift에 원본 데이터를 두고 Statsig가 쿼리만 실행한다. Enterprise 계약이 필요하지만 PII가 회사 밖으로 나가지 않아 규제 환경에 맞는다.

SDK는 Client 13종과 Server 9종으로 나뉜다. Client SDK는 initialize 시점에 해당 사용자의 평가 결과를 받아와 로컬에서 조회하고 공개 가능한 `client-` 키를 쓴다. Server SDK는 rule set 전체를 메모리에 적재해 매 요청을 로컬에서 평가하며 `secret-` 키를 쓴다. 이 키는 백엔드에만 두고 노출되면 즉시 rotation한다. Quickstart는 어느 언어든 설치, `initialize()`, 키 주입, `checkGate`·`getDynamicConfig`·`getExperiment`·`logEvent` 호출의 네 단계다.

## 코드

Spring Boot에서 Java Server SDK(`com.statsig:javacore`)를 빈으로 등록한다. 키는 환경 변수에서 읽고 초기화 완료를 기다린다.

```java
@Configuration
public class StatsigConfig {

    @Bean(destroyMethod = "shutdown")
    public Statsig statsig(
            @Value("${statsig.server-key}") String serverKey,
            @Value("${statsig.environment:production}") String environment)
            throws Exception {
        StatsigOptions options = new StatsigOptions.Builder()
                .setEnvironment(environment)
                .setInitTimeoutMs(3000)
                .build();
        Statsig statsig = new Statsig(serverKey, options);
        statsig.initialize().get();
        return statsig;
    }
}
```

`StatsigUser` 조립을 한 곳으로 모은다. 서버와 클라이언트가 같은 필드를 보내야 email·country 조건 rule에서 평가가 갈리지 않는다.

```java
@Component
public class StatsigUserFactory {

    public StatsigUser from(HttpServletRequest request, Principal principal) {
        var member = (MemberPrincipal) principal;
        return new StatsigUser.Builder()
                .setUserID(member.id())
                .setEmail(member.email())
                .setCountry(request.getHeader("CF-IPCountry"))
                .setCustomIDs(Map.of(
                        "companyID", member.companyId(),
                        "deviceID", request.getHeader("X-Device-Id")))
                .setCustom(Map.of("tier", member.tier()))
                .build();
    }
}
```

컨트롤러에서 gate로 분기하고 Dynamic Config 값을 읽으며 결제 완료 이벤트를 남긴다. 기본값은 운영에 안전한 값으로 둔다.

```java
@RestController
@RequestMapping("/checkout")
public class CheckoutController {

    private static final String EVENT_CHECKOUT_COMPLETED = "checkout_completed";

    private final Statsig statsig;
    private final StatsigUserFactory users;

    public CheckoutController(Statsig statsig, StatsigUserFactory users) {
        this.statsig = statsig;
        this.users = users;
    }

    @GetMapping
    public CheckoutView view(HttpServletRequest request, Principal principal) {
        StatsigUser user = users.from(request, principal);
        DynamicConfig config = statsig.getDynamicConfig(user, "checkout_settings");
        int minOrder = config.getInt("min_order_value", 50);
        if (statsig.checkGate(user, "new_checkout_flow")) {
            return CheckoutView.v2(minOrder);
        }
        return CheckoutView.v1(minOrder);
    }

    @PostMapping("/complete")
    public void complete(@RequestBody CompleteRequest body,
                         HttpServletRequest request, Principal principal) {
        StatsigUser user = users.from(request, principal);
        statsig.logEvent(user, EVENT_CHECKOUT_COMPLETED, body.amount(),
                Map.of("currency", "KRW", "payment_method", body.paymentMethod()));
    }
}
```

## 실무에서 걸리는 지점

- 초기화 전 호출은 모두 기본값을 반환한다. ==`initialize()` 완료를 기다리지 않으면 기동 직후 요청이 전부 OFF로 평가되고, `initTimeoutMs`를 넘겨도 같은 fallback 모드에 들어간다.== 기본값이 운영에 노출되어도 안전하도록 둔다.
- userID가 요청마다 바뀌면 같은 사용자가 다른 variant를 받는다. DB의 안정적인 ID를 쓰고, 익명 구간은 deviceID로 무작위화한 뒤 로그인 시점에 userID를 붙인다.
- ==Client SDK를 SSR과 함께 쓰면 서버 렌더와 클라이언트 마운트 후 결과가 달라 화면이 깜빡인다.== Server SDK의 `getClientInitializeResponse`로 평가값을 미리 만들어 bootstrap으로 주입한다.
- ==이벤트 이름이 `checkoutCompleted`와 `checkout_completed`로 섞이면 두 이벤트로 갈린다.== 상수로 고정한다. 모든 행동을 이벤트로 보내면 무료 plan 한도를 빠르게 넘기므로 핵심 지표 위주로 보낸다.
- gate는 기능마다 생기고 좀처럼 지워지지 않는다. temporary와 permanent를 구분하고 정식 출시 후 gate와 분기 코드를 함께 제거한다.

## 관련 글

- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
- [Feature Flags와 Experiments](/notes/experimentation/statsig-flags-experiments/)
- [Product Analytics와 Warehouse Native](/notes/experimentation/statsig-analytics-warehouse/)
