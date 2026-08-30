---
title: "Feature Flags와 Experiments"
series: experimentation
part: "Statsig"
order: 9
summary: "Gate의 순차 Targeting·Holdout으로 출시를 제어하고, Experiment의 Layer·SRM·순차 검정으로 인과를 검증하는 방법"
tags: [Statsig, Feature Flag, A/B Testing, Holdout, SRM]
sources: [statsig/2026-05-17-statsig-feature-flags-deep.md, statsig/2026-05-17-statsig-experiments-deep.md]
updated: 2026-08-30
---

기능을 코드 배포와 함께 켜면 문제가 두 가지 생긴다. 국가·등급·앱 버전 같은 조건별 출시나 5%에서 100%까지의 점진 확대를 코드 수정 없이 표현할 수 없고, 기능을 켠 뒤 지표가 움직여도 원인이 기능인지 같은 주의 마케팅인지 분리할 수 없다. 전자는 Feature Gate의 Targeting이, 후자는 무작위 통제 시험(RCT)을 SaaS로 옮긴 Experiment가 해결한다. 두 도구는 같은 해싱 기반 위에 있지만 목적이 다르다.

## 핵심 개념

**Targeting Rules.** Gate의 핵심은 누구에게 true인가를 정하는 규칙 목록이다. 규칙은 위에서 아래로 평가되고, 어느 규칙의 조건을 만족하면 그 규칙의 Pass %가 적용되며 아래 규칙은 검사하지 않는다. 따라서 좁은 조건을 위에, 넓은 조건을 아래에 두고 마지막에 Everyone 규칙을 catch-all로 배치한다. 한 규칙 안의 여러 조건은 AND로 결합되며, OR가 필요하면 규칙을 나누거나 Segment로 묶는다.

**Conditions.** 조건은 사용자 식별(User ID·Email), 기기·브라우저(Browser·App Version·OS), 지역(Country·IP), 환경·시간(Environment Tier·Time), 다른 Gate·Segment 참조, Custom·Private 속성의 여섯 범주다. Client SDK는 IP·User Agent·Locale을 자동 추론하지만 Server SDK는 IP를 직접 넘겨야 한다. Private Attributes는 평가에만 쓰이고 로그에 남지 않는다.

**Stability.** 평가는 unit ID와 gate 이름을 결정적으로 해시하므로 같은 사용자는 항상 같은 결과를 받고, Pass %를 올려도 기존 통과자는 유지된다. salt를 바꾸는 Resalting은 새 실험 시작 시에만 쓴다.

**Rollout 제어.** Scheduled Rollouts는 시간표에 따라 비율을 자동으로 올리고, Time 조건은 단일 시점부터 켜는 용도다. Dependent Gate는 상위 gate 통과를 조건으로 걸어 계층을 만들며, 상위 gate가 곧 전역 kill switch가 된다. Holdout은 5~10%의 사용자를 모든 신규 기능에서 제외해 장기 baseline으로 삼는다. Override는 규칙을 무시하는 임시 수단이며 해당 사용자는 분석에서 제외된다.

**Experiment.** Gate에도 Pulse 기반 Built-in A/B가 붙지만 rollout 비율이 불균등하고 primary metric이 없어 참고용이다. 출시 결정에는 정식 Experiment를 쓴다.

| 요소 | 내용 |
|:---|:---|
| Variant | Control과 Treatment. 변형이 늘수록 그룹당 표본이 줄어 검정력이 약해진다 |
| Randomization Unit | B2C는 userID, B2B는 companyID. Session은 UX가 흔들려 비권장 |
| Allocation | 실험 진입 비율. 5%에서 시작해 늘리기만 하고 줄이지 않는다 |
| Scorecard | Primary Metric 1개로 결정하고 Secondary는 보조 정보로만 쓴다 |
| Layer | 같은 Layer 안에서는 사용자가 한 실험에만 참여한다. 관련 실험을 묶어 간섭을 막는다 |
| 통계 설정 | Confidence Level(기본 95%), Bonferroni 보정, 목표 기간·노출 수 |

**통계 해석.** p-value는 차이가 우연일 확률이며 0.05 미만이면 유의로 본다. 95% 신뢰구간이 0을 포함하지 않는 것과 같은 조건이다. p-value는 효과 크기를 말하지 않으므로 구간 하한에 비즈니스 규모를 곱해 출시 가치를 판단한다.

## 코드

사용자 객체를 한 곳에서 만들어 속성 이름과 타입을 통일하고 IP를 직접 넘긴다.

```java
@Component
public class StatsigUserFactory {

    public StatsigUser from(HttpServletRequest request, Member member) {
        StatsigUser user = new StatsigUser(member.id());
        user.setEmail(member.email());
        user.setCountry(member.countryCode());
        user.setIp(request.getRemoteAddr());
        user.setUserAgent(request.getHeader("User-Agent"));
        user.setCustom(Map.of(
                "tier", member.tier().name(),
                "signupYear", member.signupYear()));
        user.setCustomIDs(Map.of("companyID", member.companyId()));
        return user;
    }
}
```

Gate 평가는 boolean 분기로 유지한다. Holdout은 콘솔의 Dependent Gate 규칙으로 걸므로 코드에는 gate 하나만 나타난다.

```java
@Service
@RequiredArgsConstructor
public class CheckoutService {

    private final Statsig statsig;
    private final StatsigUserFactory users;

    public CheckoutView render(HttpServletRequest req, Member member) {
        StatsigUser user = users.from(req, member);
        if (statsig.checkGate(user, "new_checkout_flow_v2")) {
            return renderV2(member);
        }
        return renderV1(member);
    }
}
```

Experiment는 파라미터 값으로 분기하고 결정에 쓸 이벤트를 같은 사용자 객체로 기록한다.

```java
public RecommendationResult recommend(HttpServletRequest req, Member member) {
    StatsigUser user = users.from(req, member);
    DynamicConfig exp = statsig.getExperiment(user, "recommendation_algorithm_v2");
    String algorithm = exp.getString("algorithm", "v1");
    RecommendationResult result = engine.run(algorithm, member);
    statsig.logEvent(user, "recommendation_shown", result.size(),
            Map.of("algorithm", algorithm));
    return result;
}
```

## 실무에서 걸리는 지점

- **규칙 순서와 타입 불일치.** VIP 100% 규칙이 Everyone 5% 아래에 있으면 VIP도 5%만 켜진다. Custom 속성이 SDK마다 문자열 "2025"와 정수 2025로 갈리면 `>=` 비교가 어긋나므로 사용자 객체 스키마를 한 곳에서 관리한다.
- **Override와 Temporary gate의 누적.** QA용 Override를 지우지 않으면 QA 계정 전부가 production 신기능을 계속 받는다. GA가 끝난 임시 gate는 코드 분기와 콘솔 항목을 함께 정리하고, 생성 시 temporary·permanent 태그와 만료일을 붙인다.
- **Sample Ratio Mismatch.** 50/50 설계에서 47/53이 나왔고 카이제곱 검정이 유의하면 버그다. 봇 편중, treatment 코드 오류로 인한 로그 누락, 로그인 시 바뀌는 ID가 흔한 원인이며 결과를 무효로 하고 재시작한다.
- **Peeking과 p-hacking.** 매일 결과를 보다가 유의해진 날 종료하면 false positive율이 0.05에서 0.20 이상으로 뛴다. 순차 검정 엔진이 있으면 조기 종료가 허용되고, 없으면 기간을 미리 고정한다. 세그먼트·메트릭을 잘라 보다 우연히 유의한 것을 채택하는 것도 같은 문제이며 Bonferroni 보정(0.05/N)으로 막는다.
- **기간과 효과 크기.** 요일 효과를 흡수하려면 최소 1주, Novelty Effect가 가라앉으려면 2주가 필요하다. 반대로 +0.1%가 p < 0.01이어도 운영 비용보다 작으면 출시 가치가 없으므로 효과 크기 임계값을 가설에 미리 적는다.

## 관련 글

- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
- [Statsig 개관과 SDK Quickstart](/notes/experimentation/statsig-overview-quickstart/)
