---
title: "확률 분포·가설 검정·신뢰구간"
series: experimentation
part: "통계 기초"
order: 2
summary: "표본 하나로 모집단을 말할 수 있는 근거는 분포 가정과 CLT이며, p-value와 신뢰구간은 그 위에서만 의미를 가진다."
tags: [확률 분포, 정규 분포, 중심극한정리, p-value, 신뢰구간]
sources: [2026-05-03-prob-stats-distributions.md, 2026-05-03-prob-stats-inferential.md]
updated: 2026-08-30
---

전환율 3.1%와 3.4%의 차이가 실제 개선인지 표본 오차인지 판단하려면, 데이터가 어떤 분포에서 나왔고 그 분포에서 이 정도 차이가 얼마나 흔한지를 알아야 한다. ==분포 가정 없이 숫자만 비교하면 노이즈를 효과로 읽거나 실제 효과를 놓친다.== 확률 분포는 관측값의 생성 모형이고, 가설 검정과 신뢰구간은 그 모형 아래에서 표본이 모집단에 대해 말할 수 있는 범위를 정량화한다.

## 핵심 개념

### 이산 분포와 연속 분포

이산형 확률 변수는 각 값에 확률이 붙고 합이 1이다. 연속형은 한 점의 확률이 0이며 항상 구간으로 확률을 묻는다. 기댓값은 E(X) = Σ x·P(x), 분산은 Σ (x − μ)²·P(x)다.

### 실무에서 반복되는 다섯 분포

| 분포 | 답하는 질문 | 모수 | 평균 | 분산 |
|:---|:---|:---|:---|:---|
| 베르누이 | 1회 시도의 성공 여부 | p | p | p(1−p) |
| 이항 | n회 중 k회 성공 확률 | n, p | np | np(1−p) |
| 기하 | 첫 성공까지 시도 횟수 | p | 1/p | (1−p)/p² |
| 포아송 | 단위 시간·공간의 사건 수 | λ | λ | λ |
| 정규 | 연속 측정값의 기본 모형 | μ, σ | μ | σ² |

이항 분포는 결과가 둘이고, 시도가 독립이며, n이 고정되고, 매 시도의 p가 같을 때만 적용된다. 비복원 추출은 초기하 분포다. 이항 확률은 P(X = k) = C(n, k)·pᵏ·(1−p)ⁿ⁻ᵏ, 포아송은 P(X = k) = λᵏe^(−λ)/k!이며, n이 크고 p가 작은 이항은 λ = np인 포아송으로 근사된다.

정규 분포는 좌우 대칭이며 평균·중앙값·최빈값이 일치한다. μ ± 1σ, 2σ, 3σ 안에 각각 약 68%, 95%, 99.7%가 들어가는 경험 법칙은 정규 분포에서만 성립한다. z = (x − μ)/σ로 표준화하면 어떤 정규 분포든 N(0, 1)로 옮겨져 누적분포 Φ(z) 하나로 확률을 계산한다. 분산은 독립일 때만 더해지며, 공분산 0이 독립을 뜻하지는 않는다.

### 표본 분포와 중심극한정리

표본 분포는 같은 크기의 표본을 반복 추출했을 때 표본 평균들이 이루는 분포다. 평균은 모평균 μ와 같고 표준편차는 σ/√n이며 이를 표준오차라 부른다. 표준오차를 절반으로 줄이려면 표본을 4배 늘려야 한다.

중심극한정리는 n이 충분히 크면(관례적으로 30 이상) 모집단 분포 모양과 무관하게 표본 평균의 분포가 N(μ, σ²/n)에 근사한다는 정리다. ==정규가 되는 것은 표본 평균의 분포이지 표본 자체가 아니다.==

### 신뢰구간

σ를 알면 x̄ ± z(α/2)·σ/√n, 모르면 표본 표준편차 S와 자유도 n−1의 t-분포로 x̄ ± t(α/2, n−1)·S/√n이다. 90%, 95%, 99%에 대응하는 z는 1.645, 1.960, 2.576이다. t-분포는 정규보다 꼬리가 두껍고 자유도가 커질수록 정규에 수렴한다. 실무에서는 σ를 모르므로 t가 기본이다. 비율의 신뢰구간은 p̂ ± z·√(p̂(1−p̂)/n)이다.

95% 신뢰구간은 모수가 그 구간에 있을 확률이 95%라는 뜻이 아니다. 같은 절차로 구간을 반복 생성하면 그중 약 95%가 모수를 포함한다는 의미다.

### 가설 검정과 p-value

귀무가설 H₀는 효과가 없다는 기본 가정이고, 대립가설 H₁은 입증하려는 주장이다. 절차는 가설 설정, 유의수준 α 선택, 검정통계량 계산, p-value와 α 비교, 결론 순이다. 검정통계량은 σ를 알면 z = (x̄ − μ₀)/(σ/√n), 모르면 t = (x̄ − μ₀)/(S/√n)이다.

==p-value는 H₀가 참이라는 가정 아래 관측된 통계량 이상으로 극단적인 결과가 나올 확률이며, H₀가 참일 확률이 아니다.== p < α이면 H₀를 기각하고, p ≥ α이면 기각하지 못할 뿐 H₀가 참으로 입증된 것은 아니다. α는 일반 연구 0.05, 의료 0.01, 탐색적 분석 0.10을 쓴다.

제1종 오류는 H₀가 참인데 기각하는 것으로 확률이 α, 제2종 오류는 H₀가 거짓인데 기각하지 못하는 것으로 확률이 β다. 검정력 1−β는 실제 효과를 잡아낼 확률이며 80% 이상을 목표로 한다. α를 낮추면 β가 오르므로 검정력은 표본 크기로 확보한다. 양측 검정은 α를 α/2씩 나누고, 단측 검정은 한쪽에 몰아 쓰므로 방향이 정해진 가설에서 검정력이 높다.

두 집단 비교는 독립 표본 t-검정, 같은 대상을 두 번 측정한 데이터는 차이에 대한 대응 표본 t-검정을 쓴다. 두 비율 비교는 합동 비율 p̂로 z = (p̂₁ − p̂₂)/√(p̂(1−p̂)(1/n₁ + 1/n₂))를 계산하며, 전환율 A/B 테스트의 기본 검정이다.

## 코드

이항·포아송 확률을 로그 스케일로 계산해 큰 n에서도 오버플로가 없는 Java 21 유틸리티다.

```java
public final class DiscreteDist {

    private DiscreteDist() {}

    private static double logFactorial(int n) {
        double s = 0;
        for (int i = 2; i <= n; i++) s += Math.log(i);
        return s;
    }

    public static double binomial(int n, int k, double p) {
        double logC = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
        return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log1p(-p));
    }

    public static double poisson(double lambda, int k) {
        return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
    }

    public static void main(String[] args) {
        System.out.printf("Binomial(5, 1/3), k=3: %.4f%n", binomial(5, 3, 1.0 / 3));
        System.out.printf("Poisson(4), k=2: %.4f%n", poisson(4, 2));
        System.out.printf("Binomial(1000, 0.001), k=2: %.4f%n", binomial(1000, 2, 0.001));
        System.out.printf("Poisson(1), k=2: %.4f%n", poisson(1, 2));
    }
}
```

Spring Boot 3.x 서비스에서 두 전환율의 z-검정과 95% 신뢰구간을 반환하는 예제다. 누적분포는 commons-math3의 `NormalDistribution`을 쓴다.

```java
import org.apache.commons.math3.distribution.NormalDistribution;
import org.springframework.stereotype.Service;

@Service
public class ConversionTestService {

    private static final NormalDistribution STD_NORMAL = new NormalDistribution(0, 1);
    private static final double Z_95 = 1.959964;

    public record Group(long visitors, long conversions) {
        double rate() { return (double) conversions / visitors; }
    }

    public record Result(double rate1, double rate2, double z, double pValueTwoSided,
                         double[] ci1, double[] ci2) {}

    public Result twoProportionTest(Group a, Group b) {
        double p1 = a.rate();
        double p2 = b.rate();
        double pooled = (double) (a.conversions() + b.conversions())
                / (a.visitors() + b.visitors());
        double se = Math.sqrt(pooled * (1 - pooled)
                * (1.0 / a.visitors() + 1.0 / b.visitors()));
        double z = (p2 - p1) / se;
        double p = 2 * (1 - STD_NORMAL.cumulativeProbability(Math.abs(z)));
        return new Result(p1, p2, z, p, waldInterval(a), waldInterval(b));
    }

    private double[] waldInterval(Group g) {
        double p = g.rate();
        double half = Z_95 * Math.sqrt(p * (1 - p) / g.visitors());
        return new double[] {p - half, p + half};
    }
}
```

## 실무에서 걸리는 지점

- **경험 법칙을 정규가 아닌 데이터에 적용하는 문제.** 구매 금액, 세션 길이처럼 꼬리가 긴 지표는 68-95-99.7이 성립하지 않는다. CLT는 평균의 분포에만 적용되므로 개별 값의 이상치 판정에는 분위수를 써야 한다.
- **표본이 작은데 z를 쓰는 문제.** σ를 모르고 n이 30 미만이면 z 구간은 실제보다 좁아져 제1종 오류가 늘어난다. 조건 없이 t를 기본으로 두는 편이 안전하다.
- **p-value 오독.** p = 0.03은 H₀가 참일 확률이 3%라는 뜻이 아니다. 대시보드에 p-value를 노출할 때는 정의를 함께 표시한다.
- ==**검정력 없이 실험을 시작하는 문제.** 표본이 부족하면 실제 효과가 있어도 p > α가 나오고 이를 효과 없음으로 결론짓는다.== 최소 탐지 효과와 검정력 80% 기준으로 필요한 방문자 수를 실험 전에 산출해야 한다.
- **Wald 구간의 한계.** p̂가 0이나 1에 가깝거나 n이 작으면 Wald 구간은 실제 포함 확률이 명목보다 낮다. 전환율 1% 이하 지표는 Wilson 구간을 쓰는 것이 낫다.

## 관련 글

- [확률 기초와 기술통계](/notes/experimentation/probability-descriptive-stats/)
- [회귀·ANOVA·카이제곱](/notes/experimentation/regression-anova-chisquare/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
