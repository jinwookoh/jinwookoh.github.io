---
title: "A/B 테스트 베스트 프랙티스와 사례"
series: experimentation
part: "A/B 테스트"
order: 7
summary: "실험 코드를 안전하게 짜고, 결과를 트레이드오프까지 보고 판단하며, 종료 후 정리하는 실무 원칙과 사례"
tags: [A/B 테스트, Feature Flag, Cross-sell, No Dead Ends, MVP]
sources: [2026-05-03-ab-test-best-practices.md, 2026-05-03-ab-test-cases.md]
updated: 2026-08-30
---

실험 플랫폼과 통계 검정을 갖춰도 운영 원칙이 없으면 결과가 오염된다. 실험 플랫폼 장애 시 신규 변형이 강제 노출되고, 새로고침마다 사용자가 다른 그룹에 배정되며, 유의성이 잠깐 보인 시점에 조기 종료한 결과가 며칠 뒤 뒤집힌다. 종료된 실험 코드가 남아 분기 수가 누적되고, 주 지표만 보고 채택한 변형이 전체 구매율을 떨어뜨리는 경우도 흔하다. 이 글은 코드 설계 원칙, 지표 선택, 결과 해석 절차를 정리하고 이커머스 사례 다섯 개로 각 원칙이 어디에서 적용되는지 확인한다.

## 핵심 개념

**Original은 항상 else에 둔다.** 실험 조회가 false나 null을 반환하는 모든 경우, 즉 플랫폼 장애, 타겟팅 불일치, 배정 실패, 실험 비활성화가 전부 기존 동작으로 떨어져야 한다. 신규 변형에서 결함이 발견되면 코드 수정 없이 실험만 끄면 롤백이 끝난다. ==Original을 if 조건에 두면 이 폴백이 성립하지 않는다.==

**실험 로직은 프레임워크와 분리한다.** 그룹 배정과 변형 실행은 순수한 서비스 모듈에 두고, 상태 관리나 웹 계층은 그 결과를 받아 UI만 제어한다. ==여러 페이지에서 같은 데이터를 바꾸는 실험(전역 상품명 변경 등)은 화면마다 처리하지 않고 데이터가 들어오는 API 계층에서 한 번 적용해 누락을 막는다.==

**배정은 한 번, 식별자는 영속.** 그룹 배정은 세션 시작 시 1회만 수행하고 사용자 식별자는 영속 저장소에 보관한다. 매 요청마다 새 식별자를 만들면 재방문 추적이 불가능하고 같은 사용자가 여러 그룹을 오간다.

**지표는 비즈니스 목표에서 역산한다.** 상위 퍼널은 CTR과 상품 페이지 방문, 중간 퍼널은 장바구니 담기율, 하위 퍼널은 방문 간격 같은 단기 대리 지표를 쓴다. LTV나 재구매율은 측정에 6개월 이상 걸려 단기 실험에 부적합하고, 매출은 대형 주문 하나로 왜곡되므로 전환율 같은 안정 지표로 대체한다. 평균 장바구니 크기처럼 연속값을 직접 비교하기 어려우면 "2개 이상 구매" 같은 조건부 이진 이벤트로 변환한다. 주 지표 외에 감시 지표(전체 구매율, 이탈률)를 함께 추적한다.

**종료 판단은 세 단계.** 유의성 95% 이상, 그룹당 전환 100건 이상, 핵심 KPI 부작용 없음을 순서대로 확인한다. 하나라도 미달이면 대기하거나 Original을 유지한다. 주 지표가 올랐어도 감시 지표가 하락했다면 트레이드오프를 분석한 뒤 변형을 단순화해 재실험한다. 기간은 주중·주말을 모두 포함해 최소 2주, 세일·휴일 등 특수 기간은 피한다.

**사례에서 확인되는 출발점 네 가지.**

| 사례 | 출발점 | 주 지표 | 감시 지표·처리 |
|:---|:---|:---|:---|
| 슬라이딩 장바구니 | 사용성 문제 | 구매 전환율 | 장바구니 이탈률. 유의성 99%, 승리 후 코드 제거·기본값화 |
| 이미지 순서 반전 | 팀 직관 | 클릭률 | 결과와 무관하게 직관을 데이터로 검증 |
| 장바구니 모달 교차 판매 | 비즈니스 목표 | 2개 이상 구매 비율 | 전체 구매율 하락 시 트레이드오프 분석 |
| 긴 이미지 갤러리 | 데이터 분석 | 구매 전환율 | 이미지 3회 이상 조회 사용자 84% 전환은 상관, 인과는 실험으로 검증 |
| 결제 완료 투표 | No Dead Ends | 재방문 간격 | 백엔드 없이 MVP로 관심도 먼저 확인 |

재고 부족 배너 사례는 반복 개선의 예다. 진행률 표시줄, 재고 숫자 텍스트, 사이즈 선택 시 잔여 수량은 효과가 없거나 미미했고, 카테고리 페이지 탐색 단계에서 "몇 개 남지 않음"을 미리 노출한 네 번째 실험이 큰 매출 차이를 냈다. 같은 실험이라도 카테고리 카드는 모호한 표현, 상세 페이지는 구체 수량으로 컨텍스트별 UI를 달리한다. 실패한 세 번의 실험이 네 번째 가설의 근거가 된다.

## 코드

실험 조회를 순수 서비스로 분리하고, 조회 실패를 포함한 모든 예외 경로가 Original로 떨어지도록 한 장바구니 서비스다.

```java
@Service
public class CartService {

    private final ExperimentClient experiments;
    private final CartRepository carts;
    private final EventTracker tracker;

    public CartService(ExperimentClient experiments, CartRepository carts, EventTracker tracker) {
        this.experiments = experiments;
        this.carts = carts;
        this.tracker = tracker;
    }

    public AddToCartResult addToCart(String userId, long productId) {
        Cart cart = carts.addItem(userId, productId);

        if (experiments.isOn("show_cart_test", userId)) {
            tracker.track(userId, "cart_opened");
            return new AddToCartResult(cart, true);   // 변형: 장바구니 자동 열기
        }
        return new AddToCartResult(cart, false);      // Original: 기존 동작
    }
}

@Component
public class ExperimentClient {

    private static final Logger log = LoggerFactory.getLogger(ExperimentClient.class);
    private final RestClient restClient;

    public ExperimentClient(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("http://experiment-platform").build();
    }

    public boolean isOn(String experiment, String userId) {
        try {
            Assignment a = restClient.get()
                .uri("/assign/{exp}/{user}", experiment, userId)
                .retrieve()
                .body(Assignment.class);
            return a != null && a.active() && "variation".equals(a.group());
        } catch (RestClientException e) {
            log.warn("experiment lookup failed: {}", experiment, e);
            return false;   // 플랫폼 장애 시 Original
        }
    }

    public record Assignment(String group, boolean active) {}
}
```

교차 판매 모달 실험의 지표 기록이다. 주문 완료 시 주 이벤트와 함께 "2개 이상 구매" 이진 이벤트를 남겨 평균 장바구니 크기 대신 비율로 비교한다.

```java
@Service
public class CheckoutService {

    private final OrderRepository orders;
    private final EventTracker tracker;

    public CheckoutService(OrderRepository orders, EventTracker tracker) {
        this.orders = orders;
        this.tracker = tracker;
    }

    @Transactional
    public Order submit(String userId, Cart cart) {
        Order order = orders.save(Order.from(userId, cart));
        tracker.track(userId, "purchase");
        if (cart.items().size() > 1) {
            tracker.track(userId, "multi_item_purchase");
        }
        return order;
    }
}
```

배정 로그를 집계할 때 새로고침으로 중복 기록된 사용자를 제거하는 분석 코드다.

```java
public record BucketRow(String userId, String variation) {}

public class BucketAnalyzer {

    public Map<String, Long> usersPerVariation(List<BucketRow> rows) {
        Map<String, String> firstAssignment = new LinkedHashMap<>();
        for (BucketRow row : rows) {
            firstAssignment.putIfAbsent(row.userId(), row.variation());
        }
        return firstAssignment.values().stream()
            .collect(Collectors.groupingBy(v -> v, Collectors.counting()));
    }
}
```

## 실무에서 걸리는 지점

- **조기 종료.** 초기 며칠의 유의성은 표본이 작아 흔들린다. 그룹당 전환 100건과 2주라는 하한을 정해 두고, 대시보드를 매일 보더라도 판단은 사전에 정한 시점에만 한다.
- **한 번에 여러 변수 변경.** 색상·문구·크기를 동시에 바꾸면 효과의 출처를 알 수 없다. 변수 하나씩 실험한 뒤 승리 요소를 조합한다.
- **종료 후 코드 미정리.** 승리한 변형은 실험 분기를 제거하고 기본 동작으로 바꾼다. 패배한 변형은 코드를 삭제하되 결과와 학습을 문서화한다. 실험 목록은 알파벳순으로 유지해 수십 개가 되어도 찾을 수 있게 한다.
- **디바이스 타겟팅 오판.** ==마우스 오버 실험은 데스크톱 전용이어야 하는데 화면 너비로 판별하면 가로 모드 태블릿이 포함된다.== User-Agent나 포인터 기능으로 판별한다.
- **실패 은닉과 HiPPO.** 성공만 공유하면 같은 실패가 반복되고, 데이터 없는 의견 충돌은 직급으로 결정된다. 기간·그룹별 인원·지표 비교·유의성·핵심 KPI 변화·결정·다음 단계 일곱 항목을 고정 템플릿으로 공유하고, 실패한 실험도 동일하게 기록한다.

## 관련 글

- [A/B 테스트 — 대조군·전환율·가설과 지표 설계](/notes/experimentation/ab-test-basics-design/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
- [A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현](/notes/experimentation/ab-test-system-implementation/)
