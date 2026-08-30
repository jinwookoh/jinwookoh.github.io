---
title: "A/B 테스트 통계 — 카이제곱·베이지안·다중 비교"
series: experimentation
part: "A/B 테스트"
order: 5
summary: "전환율 차이가 우연인지 판정하는 카이제곱 검정과 p-value의 정확한 의미, Peeking·다중 비교 함정과 베이지안 대안을 정리한다."
tags: [카이제곱 검정, p-value, Peeking Problem, 베이지안, Bonferroni]
sources: [2026-05-03-ab-test-statistics.md]
updated: 2026-08-30
---

두 변형의 전환율이 7%와 3%로 나왔다는 사실만으로는 어느 쪽이 나은지 결정할 수 없다. 표본이 10명이면 그 차이는 우연으로 충분히 설명되고, 1,000명이면 우연으로 설명하기 어렵다. 통계 검정은 이 "우연으로 설명 가능한가"를 숫자로 만드는 절차다. 검정 없이 테스트를 운영하면 초기 소수 사용자의 쏠림을 실제 효과로 오인해 종료하거나, 여러 지표를 동시에 보다가 우연히 튄 지표를 근거로 채택하는 일이 반복된다.

## 핵심 개념

### p-value와 신뢰 수준

p-value는 귀무가설(두 그룹의 전환율이 같다)이 참이라고 가정할 때, 관찰된 결과 또는 그보다 극단적인 결과가 나올 확률이다. p = 0.03은 "귀무가설이 참일 확률 3%"가 아니라 "귀무가설 아래에서 이 정도 차이가 나올 확률 3%"를 뜻한다.

유의 수준 α를 정해 두고 p < α이면 귀무가설을 기각한다. α = 0.05가 표준이며, 이를 신뢰 수준 95%로 부른다. 신뢰 수준 100%는 존재하지 않는다. 우연 가능성은 표본을 아무리 늘려도 0이 되지 않는다.

### 카이제곱 검정

A/B 테스트의 핵심 질문은 "그룹 배정과 전환 여부가 독립인가"다. 두 범주형 변수의 독립성 검정이 카이제곱이며, 이진 전환율 비교에서는 사실상 표준이다. 통계량은 모든 셀에 대해 (관측값 − 기대값)² / 기대값을 합한 값이다. 관측값이 기대값에서 멀수록 χ²가 커지고 p-value가 낮아진다.

대조군 50명 중 3명, 변형 50명 중 12명이 구매했다고 하자. 독립이라면 각 그룹의 기대 구매자는 7.5명이다. 구매 셀 두 개가 각각 (3 − 7.5)² / 7.5 ≈ 2.7을 기여하고, 미구매 셀 두 개가 각각 (47 − 42.5)² / 42.5 ≈ 0.48을 기여해 χ² ≈ 6.35가 된다. 자유도 1의 임계값 3.84를 넘으므로 α = 0.05에서 귀무가설을 기각한다.

매출·체류 시간 같은 연속형 지표는 t-검정, 기대 빈도가 작은 소표본은 피셔 정확검정을 쓴다.

### Peeking Problem

빈도주의 검정은 표본 크기를 사전에 고정했을 때만 α가 보장된다. 테스트 진행 중 결과를 반복해서 확인하고 유의성이 잠깐 나타난 시점에 종료하면 거짓 양성률이 α를 크게 넘는다. 종료 기준은 시작 전에 정한다. 변형당 최소 전환 수, 최소 기간(1주 이상, 주중과 주말 포함), 목표 신뢰 수준을 코드로 고정한다.

### MDE와 표본 크기

MDE(Minimum Detectable Effect)는 검출하려는 최소 효과 크기다. 기준 전환율 3%에서 6%로의 향상은 작은 표본으로 잡히지만 3.1%로의 향상은 매우 큰 표본이 필요하다. 트래픽이 적은 서비스는 저위험 결정에 한해 80~90%로 낮춰 운영하기도 하지만, 결제 흐름 변경에는 부적합하다.

### 빈도주의와 베이지안

빈도주의는 p-value로 기각 여부만 답하고, 사전 지식을 반영하지 않으며, Peeking에 취약하다. 베이지안은 사전 분포를 데이터로 갱신해 "변형이 대조군보다 나을 확률"을 직접 산출한다. 이진 전환율에는 Beta 분포가 켤레 사전 분포이므로 계산이 단순하다. 해석이 직관적이고 반복 확인에 상대적으로 강건하지만, 사전 분포 선택이 결과에 영향을 준다.

### 다중 비교

지표 20개를 α = 0.05로 동시 검정하면 적어도 하나가 우연히 유의하게 나올 확률은 1 − 0.95²⁰ ≈ 64%다. 이를 FWER(Family-Wise Error Rate)라 한다. Bonferroni 보정은 각 검정의 α를 α/n으로 줄이는 가장 단순한 방법이며, 보수적이라 검정력이 떨어진다. Benjamini-Hochberg 절차는 FDR을 통제해 덜 보수적이다. 실무에서는 합격 판정에 쓰는 주 지표를 1~2개로 고정하고 나머지는 감시 지표로 두어 보정 대상 자체를 줄인다.

### 통계적 유의성과 실무적 유의성

표본 100만 명이면 10.00%와 10.01%의 차이도 p < 0.001이 된다. 큰 표본은 어떤 작은 차이도 유의하게 만든다. 결과 보고에는 신뢰 수준과 함께 효과 크기(절대·상대 차이), 표본 크기, 핵심 KPI 변화를 같이 넣는다. 검정 방향도 사전에 정한다. 단측 검정은 "B가 A보다 좋은가"만 묻고, 양측 검정은 나빠지는 방향도 잡는다. 결제 흐름처럼 부작용을 감지해야 하는 자리에는 양측을 쓴다.

## 코드

2×2 분할표의 카이제곱 통계량과 p-value를 Apache Commons Math로 계산하는 서비스다. 기대 빈도가 5 미만인 셀이 있으면 결과를 신뢰하지 않도록 플래그를 붙인다.

```java
import org.apache.commons.math3.stat.inference.ChiSquareTest;
import org.springframework.stereotype.Service;

@Service
public class SignificanceService {

    public record Arm(String name, long users, long conversions) {}

    public record Result(double chiSquare, double pValue, double confidence, boolean lowExpectedCount) {}

    private final ChiSquareTest chiSquareTest = new ChiSquareTest();

    public Result test(Arm control, Arm variant) {
        long[][] table = {
            {control.conversions(), control.users() - control.conversions()},
            {variant.conversions(), variant.users() - variant.conversions()}
        };
        double chi = chiSquareTest.chiSquare(table);
        double p = chiSquareTest.chiSquareTest(table);

        double totalConv = control.conversions() + variant.conversions();
        double totalUsers = control.users() + variant.users();
        double minExpected = Math.min(control.users(), variant.users())
                * Math.min(totalConv, totalUsers - totalConv) / totalUsers;

        return new Result(chi, p, 1 - p, minExpected < 5);
    }
}
```

종료 기준을 실행 중에 바꾸지 못하도록 설정으로 고정하고, 최소 전환 수·최소 기간·목표 신뢰 수준을 모두 충족할 때만 종료를 허용한다.

```java
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

@ConfigurationProperties(prefix = "experiment.stop")
public record StopPolicy(long minConversionsPerArm, Duration minDuration, double targetConfidence) {}

@Component
public class StopDecider {

    public record Decision(boolean stop, String reason) {}

    private final StopPolicy policy;

    public StopDecider(StopPolicy policy) {
        this.policy = policy;
    }

    public Decision decide(List<SignificanceService.Arm> arms, Instant startedAt,
                           SignificanceService.Result result) {
        boolean enoughConversions = arms.stream()
                .allMatch(a -> a.conversions() >= policy.minConversionsPerArm());
        if (!enoughConversions) {
            return new Decision(false, "min conversions not reached");
        }
        if (Duration.between(startedAt, Instant.now()).compareTo(policy.minDuration()) < 0) {
            return new Decision(false, "min duration not reached");
        }
        if (result.confidence() < policy.targetConfidence()) {
            return new Decision(false, "target confidence not reached");
        }
        return new Decision(true, "criteria met");
    }
}
```

Beta(1, 1) 사전 분포에서 시작해 몬테카를로 표본으로 "변형이 대조군보다 나을 확률"을 구하는 베이지안 계산이다.

```java
import org.apache.commons.math3.distribution.BetaDistribution;

public final class BayesianAb {

    private BayesianAb() {}

    public static double probabilityVariantBeats(SignificanceService.Arm control,
                                                 SignificanceService.Arm variant,
                                                 int samples) {
        var ctrl = new BetaDistribution(1 + control.conversions(),
                1 + control.users() - control.conversions());
        var var_ = new BetaDistribution(1 + variant.conversions(),
                1 + variant.users() - variant.conversions());
        long wins = 0;
        for (int i = 0; i < samples; i++) {
            if (var_.sample() > ctrl.sample()) {
                wins++;
            }
        }
        return (double) wins / samples;
    }
}
```

## 실무에서 걸리는 지점

- 결과를 본 뒤 종료 시점을 정하는 것이 가장 흔한 실수다. 대시보드가 실시간으로 신뢰 수준을 보여 주면 팀은 92%에서 멈추려 한다. 종료 판정을 사람이 아닌 `StopDecider` 같은 코드가 내리게 하고, 정책 값은 배포 시점에 고정한다.
- 카이제곱은 기대 빈도가 5 미만인 셀이 있으면 근사가 깨진다. 초기 단계나 전환율이 매우 낮은 지표에서는 피셔 정확검정으로 대체하거나 최소 전환 수 기준을 높인다.
- 주 지표 외의 보조 지표가 유의하게 나왔다고 결론을 뒤집으면 다중 비교 함정에 빠진다. 보조 지표는 트레이드오프 검토용으로만 쓰고, 판정 근거로 쓰려면 별도 실험을 설계한다.
- 유의성만 보고하고 효과 크기를 빠뜨리면 대표본에서 의미 없는 차이가 채택된다. 보고 형식에 절대 차이·상대 차이·표본 수를 필수 항목으로 넣는다.
- 집계 파이프라인에서 CSV나 로그의 빈 줄, 배정 정보 누락 행이 섞이면 분할표의 users와 conversions가 어긋난다. 검정 전에 변형 이름이 null이거나 알 수 없는 행을 걸러 내고, 걸러진 행 수를 함께 기록한다.

## 관련 글

- [회귀·ANOVA·카이제곱](/notes/experimentation/regression-anova-chisquare/)
- [A/B 테스트 — 대조군·전환율·가설과 지표 설계](/notes/experimentation/ab-test-basics-design/)
- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
