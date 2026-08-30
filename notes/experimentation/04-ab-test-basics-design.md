---
title: "A/B 테스트 — 대조군·전환율·가설과 지표 설계"
series: experimentation
part: "A/B 테스트"
order: 4
summary: "무작위 동시 배정·고정 버케팅·이진 지표·사전 종료 기준이 갖춰져야 A/B 테스트 결과를 의사결정 근거로 쓸 수 있다"
tags: [A/B 테스트, 버케팅, 전환율, 귀무가설, Peeking Problem]
sources: [2026-05-03-ab-test-basics.md, 2026-05-03-ab-test-design.md]
updated: 2026-08-30
---

기능 변경의 효과를 실험 없이 판단하면 두 가지 오류가 반복된다. 배포 전후의 지표 차이를 변경의 효과로 해석하지만, 그 사이에 계절·프로모션·트래픽 구성이 함께 바뀌므로 변경 자체의 기여를 분리할 수 없다. 그리고 데이터가 없는 자리를 직급이 높은 사람의 의견(HiPPO)이 채운다. A/B 테스트는 같은 기간에 사용자를 무작위로 두 집단에 나누어 노출하고 차이가 우연의 범위를 넘는지 판정해 두 문제를 제거한다. 실험을 돌리는 것은 쉽고, 결과가 의미를 갖도록 설계하는 것이 어렵다.

## 핵심 개념

### 대조군·변형·동시 실험

실험은 현재 운영 중인 대조군(control)과 검증 대상인 변형(treatment) 두 버전으로 구성한다. 사용자는 무작위로 한 집단에 배정되고, 두 집단은 반드시 같은 기간에 동시에 운영된다. 한 주는 A만, 다음 주는 B만 노출하는 순차 실험은 외부 요인이 그대로 결과에 섞이므로 A/B 테스트가 아니다.

### 버케팅

버케팅(bucketing)은 사용자를 집단에 배정하는 과정이다. 원칙은 하나다. 같은 사용자는 실험 기간 내내 같은 집단에 속해야 한다. 요청마다 난수를 새로 뽑으면 한 사용자가 두 경험을 번갈아 보게 되고 노출 집단과 전환 집단이 어긋나 데이터가 오염된다. 영속 저장된 사용자 식별자(쿠키·localStorage·계정 ID)와 실험 키를 함께 해시해 결정론적으로 배정하면 서버 상태 없이 어느 인스턴스에서든 같은 결과가 나온다.

### 전환율

전환율은 목표 행동을 완료한 사용자 수를 노출 사용자 수로 나눈 비율이다. 절대 건수로 비교하면 집단 크기 차이에 속는다. 두 집단 모두 17명이 구매했어도 대조군 49명(34.7%)과 변형 42명(40.5%)은 다른 결과다.

### 가설과 귀무가설

가설은 "[변경]을 하면 [이유] 때문에 [측정 가능한 결과]가 발생한다"의 세 요소를 갖춰야 한다. "버튼을 빨간색으로 바꾸면 좋아진다"는 이유도 지표도 없다. "장바구니 담기 시 패널을 자동으로 열면 결제 버튼 발견이 빨라져 구매 전환율이 오른다"는 실패하더라도 해당 메커니즘이 작동하지 않았다는 사실을 남긴다.

통계적으로는 귀무가설 H₀(변경이 전환율에 영향을 주지 않는다)에서 출발해, 데이터가 충분한 증거를 제시할 때만 H₀를 기각하고 대립가설 H₁을 채택한다. 기본값은 항상 기존 버전이며 새 버전이 우위를 스스로 증명해야 한다.

### 통계적 유의성

같은 70%라도 10명 중 7명과 1,000명 중 700명은 신뢰도가 다르다. 유의성은 관측된 차이가 우연으로 발생할 확률이 사전에 정한 유의수준 α 아래인지로 판정하며, 관례적으로 95% 신뢰 수준(α=0.05)을 쓴다. 트래픽이 적으면 90%, 결제 같은 핵심 경로는 99%를 쓰기도 한다. 100% 확신은 존재하지 않는다.

### 지표 선택

좋은 지표는 세 조건을 만족한다. 짧은 기간에 측정 가능할 것, 비즈니스 목표와 직접 연결될 것, 외부 요인과 이상치에 안정적일 것. LTV와 재구매율은 측정에 수개월이 걸리고, 매출 합계는 한 건의 대형 주문이 집단 평균을 흔든다.

실무에서 유용한 기법은 연속형 지표를 이진 지표로 바꾸는 것이다. ==평균 장바구니 크기 대신 "2개 이상 구매 여부"를 이벤트로 기록하면 100개를 사도 1회로 집계되어 이상치에 강건하고, 전환율과 같은 비율 검정 파이프라인을 그대로 쓸 수 있다.==

주 지표 하나만 보면 부작용을 놓친다. "2개 이상 구매 비율"이 15% 올랐는데 전체 구매 완료율이 20% 떨어졌다면 실험은 실패다. 목표 지표 1~2개와 함께 핵심 KPI를 가드레일 지표로 2~3개 추적한다.

### 타겟팅과 트래픽 분할

실험은 가설이 적용되는 페이지·디바이스·시점에만 활성화한다. 전 페이지에서 켜면 무관한 트래픽이 노이즈로 들어간다. 디바이스는 화면 너비가 아니라 User-Agent나 포인터 능력으로 판별한다. 가로 모드 태블릿은 너비가 넓지만 호버가 없다.

| 분할 | 용도 | 비고 |
|:---|:---|:---|
| 50/50 | 효과 측정 | 유의성 도달이 가장 빠름 |
| 10/90 | 위험 관리 | 10 → 25 → 50 → 100 점진 롤아웃 |
| 다중 변형 | 여러 안 비교 | 집단당 표본이 줄어 기간이 배수로 늘어남 |

## 코드

해시 기반 결정론적 버케팅. 사용자 ID와 실험 키를 함께 해시하므로 어느 서버에서든 같은 집단에 배정되고 실험마다 배정이 독립적이다.

```java
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;

public final class Bucketer {

    public record Variant(String name, int weight) {}

    private Bucketer() {}

    public static String assign(String experimentKey, String userId, List<Variant> variants) {
        int total = variants.stream().mapToInt(Variant::weight).sum();
        int point = hashToRange(experimentKey + ":" + userId, total);
        int cursor = 0;
        for (Variant v : variants) {
            cursor += v.weight();
            if (point < cursor) {
                return v.name();
            }
        }
        return variants.get(0).name(); // 첫 항목은 항상 control
    }

    private static int hashToRange(String input, int range) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            long head = ((digest[0] & 0xFFL) << 24) | ((digest[1] & 0xFFL) << 16)
                    | ((digest[2] & 0xFFL) << 8) | (digest[3] & 0xFFL);
            return (int) (head % range);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

Spring Boot 서비스에서 배정·노출 기록·안전한 폴백을 묶은 예. 변형 분기는 `if`에, 기존 동작은 `else`에 두어 배정 실패나 실험 비활성 시 항상 기존 경험으로 떨어지게 한다.

```java
import org.springframework.stereotype.Service;
import java.util.List;

@Service
public class CartService {

    private static final String EXPERIMENT = "add_to_cart_panel";
    private static final List<Bucketer.Variant> VARIANTS = List.of(
            new Bucketer.Variant("control", 50),
            new Bucketer.Variant("auto_open_panel", 50));

    private final ExperimentConfig config;
    private final EventTracker tracker;

    public CartService(ExperimentConfig config, EventTracker tracker) {
        this.config = config;
        this.tracker = tracker;
    }

    public CartResponse addItem(String userId, long productId) {
        Cart cart = doAdd(userId, productId);

        if (isTreatment(userId)) {
            return CartResponse.withPanelOpen(cart);
        } else {
            return CartResponse.plain(cart); // 기본값: 기존 동작
        }
    }

    private boolean isTreatment(String userId) {
        if (!config.isActive(EXPERIMENT) || userId == null) {
            return false;
        }
        String variant = Bucketer.assign(EXPERIMENT, userId, VARIANTS);
        tracker.track("exposure", userId, EXPERIMENT, variant);
        return "auto_open_panel".equals(variant);
    }
}
```

연속형 지표를 이진 이벤트로 변환해 기록하는 주문 완료 처리. 별도 집계 로직 없이 전환 이벤트 파이프라인을 재사용한다.

```java
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class OrderMetricsListener {

    private final EventTracker tracker;

    public OrderMetricsListener(EventTracker tracker) {
        this.tracker = tracker;
    }

    @EventListener
    public void onOrderCompleted(OrderCompletedEvent event) {
        tracker.track("purchase", event.userId());
        if (event.itemCount() > 1) {
            tracker.track("purchase_multi_item", event.userId());
        }
    }
}
```

## 실무에서 걸리는 지점

- **Peeking Problem.** ==실험 중 결과를 반복해서 들여다보다 유의성이 잠깐 나타난 순간 종료하면 거짓 양성 비율이 크게 올라간다.== 목표 신뢰 수준·최소 표본(전환 100건 이상)·최소 기간(주중·주말을 포함한 1주 이상)을 시작 전에 고정하고, 그 조건을 채우기 전에는 판정하지 않는다.
- **노출 없는 배정.** ==변형 UI가 렌더링되지 않은 사용자를 실험군에 포함하면 효과가 희석된다.== 사용자가 실제로 차이를 보는 시점에 exposure 이벤트를 기록한다.
- **식별자 변경에 따른 집단 이동.** ==디바이스 ID로 배정된 사용자가 로그인 후 계정 ID로 재배정되면 집단이 바뀔 수 있다.== 실험 단위를 하나로 정하고 로그인 전후 식별자 매핑 정책을 미리 결정한다.
- **가드레일 없는 승리 판정.** 목표 지표만 개선되고 이탈률·응답 시간·오류율이 악화되는 경우가 잦다. 가드레일 지표의 하한을 실험 정의에 포함하고 하나라도 깨지면 롤백한다.
- **실험 코드 잔존.** 종료된 실험의 분기가 남으면 조건문이 누적되고 다음 실험과 간섭한다. 승리 변형을 기본 동작으로 승격하고 분기·플래그·이벤트를 제거하는 작업을 종료 절차에 포함한다.

## 관련 글

- [확률 분포·가설 검정·신뢰구간](/notes/experimentation/distributions-hypothesis-testing/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
