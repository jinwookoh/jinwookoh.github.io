---
title: "확률 기초와 기술통계"
series: experimentation
part: "통계 기초"
order: 1
summary: "실험 결과를 읽기 전에 알아야 할 중심·산포 측도와 조건부 확률·베이즈 정리를 정리한다"
tags: [기술통계, 표준편차, 조건부 확률, 베이즈 정리, z-점수]
sources: [2026-05-03-prob-stats-probability-basics.md, 2026-05-03-prob-stats-descriptive-statistics.md]
updated: 2026-08-30
---

A/B 테스트 결과를 평균 전환율 하나로 판단하면 이상치 몇 개가 결론을 뒤집는다. 산포를 보지 않으면 두 집단의 차이가 실제 효과인지 잡음인지 구분할 수 없고, 조건부 확률을 다루지 못하면 "유의하다"는 결과가 얼마나 믿을 만한지 계산할 수 없다. 기술통계는 데이터를 요약하는 도구이고, 확률은 그 요약이 우연일 가능성을 재는 도구다. 이후 가설 검정·신뢰구간·베이지안 A/B 테스트는 전부 이 두 가지 위에 올라간다.

## 핵심 개념

### 중심 측도 — 평균·중앙값·최빈값

평균은 모든 값의 합을 개수로 나눈 값이며, 데이터의 균형점이다. 중앙값은 정렬 후 정중앙 값이고, 짝수 개일 때는 가운데 두 값의 평균을 취한다. 최빈값은 가장 자주 나타나는 값이며 없을 수도 있고 둘 이상일 수도 있다.

셋을 따로 두는 이유는 무너지는 지점이 다르기 때문이다. {1, 2, 3}에 1000이 추가되면 평균은 251.5로 튀지만 중앙값은 2.5에 머문다. 평균은 이상치에 민감하고 중앙값은 강건하다. 소득·거래 금액·응답 시간처럼 꼬리가 긴 데이터는 중앙값이 대표값으로 적합하다.

분포 모양도 세 값의 순서로 읽는다. 대칭 분포에서는 평균 = 중앙값 = 최빈값이고, 오른쪽 꼬리가 긴 우편향에서는 평균 > 중앙값 > 최빈값, 좌편향에서는 부등호가 반대다. 평균은 꼬리 방향으로 끌려간다.

### 산포 측도 — 범위·IQR·분산·표준편차

| 측도 | 정의 | 약점 |
|:---|:---|:---|
| 범위 | 최댓값 − 최솟값 | 끝값 두 개에만 의존 |
| IQR | Q₃ − Q₁ (가운데 50%) | 분포 전체 모양은 반영하지 못함 |
| 분산 | 편차 제곱의 평균 | 단위가 제곱이라 해석이 어려움 |
| 표준편차 | 분산의 제곱근 | 이상치에 민감 |

표본 분산은 n이 아니라 n−1로 나눈다. 표본 평균을 기준으로 편차를 계산하면 모집단 분산을 과소 추정하는데, n−1로 나누면 이 편향이 보정된다(베셀 보정). 모집단 전체를 가진 경우에만 N으로 나눈다.

데이터 변환 시 통계량의 변화는 규칙적이다. 모든 값에 상수 k를 더하면 평균·중앙값·최빈값은 k만큼 이동하고 범위·IQR·분산·표준편차는 변하지 않는다. 모든 값에 k를 곱하면 평균·중앙값·범위·IQR·표준편차는 k배, 분산만 k²배가 된다.

박스 플롯에서 이상치는 Q₁ − 1.5×IQR 미만 또는 Q₃ + 1.5×IQR 초과로 정의한다.

z-점수 z = (x − μ) / σ 는 값이 평균에서 표준편차의 몇 배 떨어져 있는지를 나타낸다. 단위가 다른 분포를 같은 척도로 비교할 수 있게 하며, 이후 검정통계량의 기본 형태가 된다.

### 확률의 기본 법칙

확률은 원하는 결과 수를 표본공간 크기로 나눈 값이며 0 이상 1 이하다. 시행을 반복하면 실험적 확률은 이론적 확률로 수렴한다(대수의 법칙). 이 법칙은 장기 평균에 관한 진술이며 개별 시행을 보정하지 않는다.

- 덧셈 법칙: P(A ∪ B) = P(A) + P(B) − P(A ∩ B). 두 사건이 동시에 일어날 수 없는 배반 사건이면 교집합 항이 0이 된다.
- 곱셈 법칙: P(A ∩ B) = P(A) × P(B|A). 독립 사건이면 P(B|A) = P(B)로 단순 곱이 된다.
- 조건부 확률: P(A|B) = P(A ∩ B) / P(B). B라는 정보가 주어졌을 때 A의 확률이다.
- 여사건: P(Aᶜ) = 1 − P(A). "적어도 하나" 형태의 문제는 여사건으로 푸는 편이 짧다.

독립의 기준은 확률의 크기가 아니라 한 사건이 다른 사건의 확률을 바꾸는지 여부다.

### 베이즈 정리와 전체 확률의 법칙

베이즈 정리는 새 증거 B를 관측한 뒤 가설 A의 확률을 갱신한다.

P(A|B) = P(B|A) × P(A) / P(B)

P(A)는 사전 확률, P(B|A)는 우도, P(A|B)는 사후 확률이다. 분모 P(B)는 전체 확률의 법칙 P(B) = Σ P(B|Aᵢ) × P(Aᵢ)로 구하며, B가 일어나는 모든 경로를 합산해야 한다. 계산이 가장 자주 틀리는 자리가 이 분모다.

공정한 주사위와 6이 50% 확률로 나오는 편향 주사위 중 하나를 무작위로 골라 굴렸더니 6이 나왔다고 하자. P(6) = 1/2 × 1/2 + 1/6 × 1/2 = 1/3이고, P(편향|6) = (1/2 × 1/2) / (1/3) = 3/4다. 증거 하나로 사전 확률 50%가 사후 확률 75%로 갱신된다. 베이지안 A/B 테스트는 이 갱신을 전환 데이터에 반복 적용하는 방식이다.

## 코드

표본 평균·중앙값·표본 표준편차·IQR과 1.5×IQR 기준 이상치를 계산하는 Java 21 유틸리티다.

```java
import java.util.Arrays;
import java.util.List;

public final class DescriptiveStats {

    public record Summary(double mean, double median, double sampleStdDev,
                          double q1, double q3, double iqr, List<Double> outliers) {}

    public static Summary of(double[] raw) {
        double[] x = raw.clone();
        Arrays.sort(x);
        int n = x.length;

        double mean = Arrays.stream(x).average().orElseThrow();
        double ss = Arrays.stream(x).map(v -> (v - mean) * (v - mean)).sum();
        double sampleStdDev = Math.sqrt(ss / (n - 1));   // 베셀 보정

        double median = medianOf(x, 0, n);
        double q1 = medianOf(x, 0, n / 2);
        double q3 = medianOf(x, (n + 1) / 2, n);          // 홀수면 중앙값 제외
        double iqr = q3 - q1;

        double low = q1 - 1.5 * iqr, high = q3 + 1.5 * iqr;
        List<Double> outliers = Arrays.stream(x).boxed()
                .filter(v -> v < low || v > high).toList();

        return new Summary(mean, median, sampleStdDev, q1, q3, iqr, outliers);
    }

    private static double medianOf(double[] sorted, int from, int to) {
        int len = to - from;
        int mid = from + len / 2;
        return (len % 2 == 0) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
}
```

전체 확률의 법칙으로 분모를 구한 뒤 베이즈 정리를 적용하는 코드다. 가설별 사전 확률과 우도를 배열로 받아 사후 확률 벡터를 돌려준다.

```java
public final class Bayes {

    /** priors[i] = P(H_i), likelihoods[i] = P(E | H_i). 반환값은 P(H_i | E). */
    public static double[] posterior(double[] priors, double[] likelihoods) {
        if (priors.length != likelihoods.length) {
            throw new IllegalArgumentException("priors and likelihoods must align");
        }
        double evidence = 0.0;                              // P(E) = Σ P(E|H_i) P(H_i)
        for (int i = 0; i < priors.length; i++) {
            evidence += likelihoods[i] * priors[i];
        }
        double[] post = new double[priors.length];
        for (int i = 0; i < priors.length; i++) {
            post[i] = likelihoods[i] * priors[i] / evidence;
        }
        return post;
    }

    public static void main(String[] args) {
        // H0 = 편향 주사위, H1 = 공정 주사위, E = 6이 나옴
        double[] post = posterior(new double[]{0.5, 0.5}, new double[]{0.5, 1.0 / 6});
        System.out.printf("P(편향 | 6) = %.3f%n", post[0]);   // 0.750
    }
}
```

## 실무에서 걸리는 지점

- 평균 응답 시간·평균 주문 금액은 이상치 몇 건에 좌우된다. 꼬리가 긴 지표는 중앙값이나 p95와 함께 보고하고, 실험 지표로 쓸 때는 윈저화나 상한 절단을 적용한 뒤 그 기준을 실험 전에 고정한다.
- 사분위수 계산 방식이 라이브러리마다 다르다. 위 코드의 방식과 NumPy·Pandas·SQL의 `percentile_cont`는 같은 데이터에서 다른 Q₁·Q₃를 내놓을 수 있으므로, 대시보드와 배치 집계의 계산 규칙을 하나로 맞춰야 한다.
- 표본 분산을 N으로 나누는 구현이 섞이면 표준오차가 작게 나와 유의성이 과장된다. 통계 라이브러리의 기본값(`ddof`)을 확인하고 팀 공통 유틸리티에서 n−1을 강제한다.
- 분산 계산을 단일 패스로 구현할 때 합과 제곱합을 따로 누적하면 큰 값에서 부동소수점 상쇄로 음수 분산이 나올 수 있다. 데이터가 크면 Welford 알고리즘이나 `DoubleSummaryStatistics` 기반 두 패스 계산을 쓴다.
- 베이즈 갱신에서 사전 확률을 0으로 두면 어떤 증거가 와도 사후 확률이 0에 고정된다. 초기 전환율 추정에는 약한 사전 분포를 두고, 우도 곱이 언더플로되지 않도록 로그 공간에서 누적한다.

## 관련 글

- [확률 분포·가설 검정·신뢰구간](/notes/experimentation/distributions-hypothesis-testing/)
- [회귀·ANOVA·카이제곱](/notes/experimentation/regression-anova-chisquare/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
