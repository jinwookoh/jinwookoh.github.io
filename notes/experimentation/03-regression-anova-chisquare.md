---
title: "회귀·ANOVA·카이제곱"
series: experimentation
part: "통계 기초"
order: 3
summary: "두 변수의 관계는 회귀로, 세 그룹 이상의 평균은 ANOVA로, 범주형 빈도는 카이제곱으로 검정하는 기준을 정리한다"
tags: [regression, ANOVA, chi-square, 효과 크기, 다중 비교]
sources: [2026-05-03-prob-stats-regression.md, 2026-05-03-prob-stats-advanced.md]
updated: 2026-08-30
---

t-검정과 z-검정은 한 집단 또는 두 집단의 평균만 다룬다. 실무 데이터는 그 범위를 자주 벗어난다. 광고비와 매출처럼 두 연속 변수의 관계를 수치로 표현해야 하고, 세 개 이상의 실험군 평균을 한 번에 비교해야 하며, 연령대별 선호 항목처럼 빈도로만 주어지는 범주형 데이터도 검정해야 한다. 이때 t-검정을 반복하면 제1종 오류율이 통제되지 않고, 범주형 데이터에 평균 검정을 적용하면 결과 자체가 성립하지 않는다. 회귀·ANOVA·카이제곱은 각각 이 세 상황을 담당하는 도구다.

## 핵심 개념

### 상관계수와 단순 선형 회귀

피어슨 상관계수 r은 두 변수의 선형 관계의 방향과 강도를 -1과 1 사이의 값으로 나타낸다. 공분산을 두 표준편차의 곱으로 나눈 값이므로 단위가 없다. |r|이 0.7 이상이면 강한 상관, 0.3 미만이면 약한 상관으로 본다. r = 0은 선형 관계가 없다는 뜻이지 관계가 없다는 뜻이 아니다. y = x² 같은 비선형 관계는 r이 0에 가깝게 나온다. 결정계수 R² = r²는 독립 변수가 종속 변수 변동을 설명하는 비율이다. r = 0.8이면 설명력은 80%가 아니라 64%다.

회귀선 ŷ = b₀ + b₁x는 잔차 제곱합 Σ(yᵢ - ŷᵢ)²을 최소화하는 직선이다. 기울기와 절편은 다음과 같이 구한다.

- b₁ = (nΣxy - ΣxΣy) / (nΣx² - (Σx)²) = r · (Sy / Sx)
- b₀ = ȳ - b₁x̄

회귀가 성립하려면 선형성·잔차 독립성·등분산성·잔차 정규성 네 가지 가정이 필요하다. 잔차 도표에서 곡선 패턴이 보이면 선형성 위반, 깔때기 모양이면 이분산성, 시간순 패턴이면 자기상관을 의심한다. 독립 변수가 여러 개인 다중 회귀에서는 변수를 추가할수록 R²가 기계적으로 상승하므로 변수 수 k로 보정한 조정된 R²를 본다.

### ANOVA

세 그룹 이상의 평균이 같은지 검정한다. 그룹이 3개일 때 t-검정을 세 번 하면 모두 귀무가설이 참이라도 최소 한 번 기각할 확률이 1 - 0.95³ = 14.3%가 된다. ANOVA는 검정 한 번으로 전체 오류율을 α에 묶는다.

F = MSB / MSW로 계산하며, MSB = SSB / (k - 1)은 그룹 간 분산, MSW = SSW / (N - k)는 그룹 내 분산이다. F가 1 부근이면 그룹 간 차이가 그룹 내 변동 수준이라는 뜻이고, F가 크면 귀무가설을 기각한다. 가정은 각 그룹의 정규성, 등분산성, 관측치 독립이다. 기각은 적어도 한 쌍의 평균이 다르다는 결론일 뿐이므로, 어느 쌍인지는 Tukey HSD나 Bonferroni 같은 사후 검정으로 확인한다.

### 카이제곱 검정

범주형 데이터의 빈도를 검정한다. 통계량은 χ² = Σ(O - E)² / E로, 관측 빈도 O가 기대 빈도 E에서 얼마나 벗어났는지를 모든 셀에서 합산한다. 적용 조건은 무작위 표본, 모든 셀의 기대 빈도 5 이상, 표본이 모집단의 10% 이하다. 계산식은 같지만 목적과 표본 설계에 따라 세 가지로 나뉜다.

| 검정 | 표본 | 질문 | 자유도 |
|:---|:---|:---|:---|
| 동질성 | 독립된 여러 표본 | 그룹별 분포가 같은가 | (행-1)(열-1) |
| 독립성 | 하나의 표본 | 두 변수가 독립인가 | (행-1)(열-1) |
| 적합도 | 하나의 표본 | 특정 분포를 따르는가 | 범주 수 - 1 |

교차표의 기대 빈도는 (행 합계 × 열 합계) / 전체 합계로 구한다. 임계값을 넘지 못하면 차이를 검출하지 못한 것이지 차이가 없음을 증명한 것이 아니다.

### 비모수 검정과 효과 크기

정규성이 성립하지 않거나 표본이 매우 작거나 데이터가 순위 척도이면 원자료를 순위로 변환하는 비모수 검정을 쓴다. 독립 t-검정은 Mann-Whitney U, 대응 t-검정은 Wilcoxon signed-rank, ANOVA는 Kruskal-Wallis에 대응한다. 정규성이 충족되는 상황에서 비모수를 쓰면 검정력이 떨어진다.

p-value는 차이가 우연일 가능성을 말할 뿐 차이의 크기를 말하지 않는다. 표본이 충분히 크면 무의미한 차이도 p < 0.05가 된다. 평균 차이는 Cohen's d = (μ₁ - μ₂) / σ_pooled로 보고하며 0.2·0.5·0.8을 작음·중간·큼의 기준으로 삼는다. 검정력 1 - β는 80% 이상을 목표로 하고, 표본 크기는 실험 시작 전에 감지하려는 차이 Δ와 표준편차 σ로부터 n = ((z_α/2 + z_β) / (Δ/σ))²로 정한다.

## 코드

단순 선형 회귀의 기울기·절편·결정계수를 최소제곱법으로 구하는 Java 21 레코드 기반 구현이다.

```java
package com.example.stats;

import java.util.stream.IntStream;

public record SimpleRegression(double slope, double intercept, double r2) {

    public static SimpleRegression fit(double[] x, double[] y) {
        if (x.length != y.length || x.length < 2) {
            throw new IllegalArgumentException("x와 y의 길이가 같아야 하고 2개 이상이어야 한다");
        }
        int n = x.length;
        double sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
        for (int i = 0; i < n; i++) {
            sumX += x[i];
            sumY += y[i];
            sumXY += x[i] * y[i];
            sumX2 += x[i] * x[i];
            sumY2 += y[i] * y[i];
        }
        double slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        double intercept = sumY / n - slope * sumX / n;
        double r = (n * sumXY - sumX * sumY)
                / Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
        return new SimpleRegression(slope, intercept, r * r);
    }

    public double predict(double x) {
        return intercept + slope * x;
    }

    public double[] residuals(double[] x, double[] y) {
        return IntStream.range(0, x.length)
                .mapToDouble(i -> y[i] - predict(x[i]))
                .toArray();
    }
}
```

교차표를 받아 카이제곱 통계량과 자유도를 계산하고, 기대 빈도 5 미만 셀이 있으면 거부하는 서비스다. p-value 변환은 Apache Commons Math의 ChiSquaredDistribution을 사용한다.

```java
package com.example.stats;

import org.apache.commons.math3.distribution.ChiSquaredDistribution;
import org.springframework.stereotype.Service;

@Service
public class ChiSquareService {

    public record Result(double statistic, int degreesOfFreedom, double pValue) {}

    public Result testIndependence(long[][] observed) {
        int rows = observed.length;
        int cols = observed[0].length;
        long[] rowTotal = new long[rows];
        long[] colTotal = new long[cols];
        long total = 0;
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                rowTotal[i] += observed[i][j];
                colTotal[j] += observed[i][j];
                total += observed[i][j];
            }
        }
        double chi2 = 0;
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                double expected = (double) rowTotal[i] * colTotal[j] / total;
                if (expected < 5) {
                    throw new IllegalStateException(
                            "기대 빈도 5 미만 셀 존재: (%d,%d)=%.2f".formatted(i, j, expected));
                }
                double diff = observed[i][j] - expected;
                chi2 += diff * diff / expected;
            }
        }
        int df = (rows - 1) * (cols - 1);
        double pValue = 1 - new ChiSquaredDistribution(df).cumulativeProbability(chi2);
        return new Result(chi2, df, pValue);
    }
}
```

## 실무에서 걸리는 지점

- **상관은 인과가 아니다.** 아이스크림 판매량과 익사 사고 수는 양의 상관을 보이지만 둘 다 기온이라는 교란 변수의 결과다. 관찰 데이터에서 강한 상관을 발견하면 제3의 변수를 먼저 의심하고, 인과를 주장하려면 무작위 통제 실험이나 차이의 차이 같은 설계가 필요하다.
- **외삽은 신뢰할 수 없다.** 회귀선은 관측된 x 범위 안에서만 유효하다. 1~5월 데이터로 적합한 모델에 x = 100을 넣으면 수식은 값을 내놓지만 그 값에는 근거가 없다.
- **영향점 한 개가 기울기를 바꾼다.** x가 극단적인 레버리지 점이 큰 잔차까지 가지면 회귀선 전체가 끌려간다. 데이터 오류로 확인된 경우에만 제거한다.
- **다중 비교를 보정하지 않으면 거짓 양성이 쌓인다.** 검정 k번의 FWER은 1 - (1 - α)^k로, α = 0.05에서 20번이면 64%에 이른다. 여러 지표를 동시에 보는 실험에서는 Bonferroni(α/k)나 Benjamini-Hochberg FDR 절차로 보정한다.
- **카이제곱의 기대 빈도 조건을 무시하면 근사가 깨진다.** 희소한 범주가 섞인 교차표는 셀 기대 빈도가 5 아래로 떨어지기 쉽다. 범주를 병합하거나 Fisher 정확 검정으로 대체한다.

## 관련 글

- [확률 분포·가설 검정·신뢰구간](/notes/experimentation/distributions-hypothesis-testing/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
- [A/B 테스트 — 대조군·전환율·가설과 지표 설계](/notes/experimentation/ab-test-basics-design/)
