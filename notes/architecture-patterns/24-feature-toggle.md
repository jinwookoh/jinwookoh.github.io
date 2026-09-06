---
title: "피처 토글 — 배포와 릴리스 분리"
series: architecture-patterns
part: "API·운영"
order: 24
summary: "코드 배포와 기능 공개를 분리해 재배포 없이 기능을 켜고 끄고, 일부 사용자에게만 점진적으로 여는 방법"
tags: [Feature Toggle, Canary Release, Trunk-based Development, Kill Switch, Spring Boot]
sources: [https://jinwookoh.tistory.com/253]
updated: 2026-09-06
---

새 결제 로직을 배포한 직후 치명적 결함이 드러나면 코드 수정, 빌드, 재배포까지 수십 분이 걸리고 그동안 결제는 중단된다. 배포 행위가 기능 공개와 묶여 있기 때문이다. 반대 방향의 문제도 있다. 완성되지 않은 기능은 메인 브랜치에 합칠 수 없어 장기 브랜치가 생기고, 병합 시점에 충돌이 누적된다. 피처 토글은 기능의 활성 여부를 코드 밖에서 결정하는 분기점을 두어 배포(deploy)와 릴리스(release)를 분리한다. 코드는 먼저 나가고, 기능은 준비됐을 때 켠다.

## 핵심 개념

토글은 기능 실행 경로 앞에 놓인 조건 분기이며, 조건값이 어디에서 오는지에 따라 두 방식으로 나뉜다.

정적 토글은 `application.yml`이나 환경 변수에 값을 두는 방식이다. 구현이 가장 단순하고, 미완성 코드를 `false`로 막아둔 채 트렁크에 병합하는 용도에 적합하다. 값을 바꾸려면 재시작 또는 설정 리로드가 필요하므로 긴급 차단 용도로는 반응이 느리고, 조건 없이 시스템 전체에 일괄 적용된다.

동적 토글은 DB, Redis, 또는 Unleash·LaunchDarkly 같은 토글 관리 서버에서 런타임에 값을 읽는다. 재배포 없이 즉시 반영되고, 요청 컨텍스트(사용자 ID, IP 대역, 가입일)를 조건으로 넣어 특정 집단에만 활성화할 수 있다. 카나리 릴리스와 A/B 테스트가 이 위에서 동작한다.

| 구분 | 정적 토글 | 동적 토글 |
|---|---|---|
| 값의 위치 | yml, 환경 변수 | DB, Redis, 외부 SaaS |
| 변경 반영 | 재시작·리로드 | 런타임 즉시 |
| 적용 단위 | 전체 일괄 | 사용자·조건별 |
| 주 용도 | 미완성 코드 은닉, 점검 모드 | 카나리, A/B, 긴급 차단 |

토글은 수명과 용도로도 구분한다. 릴리스 토글은 미완성 기능을 숨기며 며칠에서 몇 주 안에 제거된다. 실험 토글은 A/B 테스트용으로 실험 종료와 함께 사라진다. 운영 토글은 부하가 큰 기능을 끄는 킬 스위치로 오래 남는다. 권한 토글은 특정 고객군에만 기능을 여는 용도다. 수명이 다른 토글을 한 체계로 섞어 관리하면 제거 시점을 놓친다.

동적 토글을 이용한 카나리 릴리스는 다음 순서로 진행한다. 토글 OFF 상태로 배포하고, 사내 IP 대역만 ON으로 바꿔 내부 검증을 거친 뒤, 전체 사용자의 1%를 ON으로 열어 에러율과 지연을 관찰한다. 이상이 없으면 10%, 50%, 100%로 넓히고, 문제가 나오면 토글을 OFF로 되돌린다.

## 코드

정적 토글. `application.yml` 값을 `@ConfigurationProperties` 레코드로 바인딩한다(`@ConfigurationPropertiesScan` 또는 `@EnableConfigurationProperties` 등록이 필요하다).

```yaml
features:
  new-billing: false
```

```java
@ConfigurationProperties(prefix = "features")
public record FeatureProperties(boolean newBilling) {}

@Service
public class BillingService {

    private final FeatureProperties features;
    private final LegacyBillingClient legacy;
    private final NewBillingClient next;

    public BillingService(FeatureProperties features,
                          LegacyBillingClient legacy,
                          NewBillingClient next) {
        this.features = features;
        this.legacy = legacy;
        this.next = next;
    }

    public PaymentResult pay(PaymentRequest request) {
        return features.newBilling()
                ? next.pay(request)
                : legacy.pay(request);
    }
}
```

동적 토글. 토글 상태를 DB에 두고 요청 컨텍스트로 활성 여부를 판단한다. 30초 TTL의 로컬 캐시로 매 요청 조회를 막고, 퍼센트 롤아웃은 사용자 ID 해시로 버킷을 정한다.

```java
public record FeatureContext(long userId, String clientIp) {}

public record FeatureFlag(String name, boolean enabled,
                          int rolloutPercent, Set<Long> allowedUserIds) {
    static FeatureFlag disabled(String name) {
        return new FeatureFlag(name, false, 0, Set.of());
    }
}

public interface FeatureManager {
    boolean isActive(String feature, FeatureContext ctx);
}

@Component
public class DbFeatureManager implements FeatureManager {

    private final FeatureFlagRepository repository;
    private final Cache<String, FeatureFlag> cache = Caffeine.newBuilder()
            .expireAfterWrite(Duration.ofSeconds(30))
            .build();

    public DbFeatureManager(FeatureFlagRepository repository) {
        this.repository = repository;
    }

    @Override
    public boolean isActive(String feature, FeatureContext ctx) {
        FeatureFlag flag = cache.get(feature, key ->
                repository.findByName(key).orElse(FeatureFlag.disabled(key)));
        if (!flag.enabled()) {
            return false;
        }
        if (flag.allowedUserIds().contains(ctx.userId())) {
            return true;
        }
        int bucket = Math.floorMod(Objects.hash(feature, ctx.userId()), 100);
        return bucket < flag.rolloutPercent();
    }
}
```

사용처. 토글 평가를 서비스 진입점에서 한 번만 수행하고 결과에 따라 경로를 고른다.

```java
@Service
public class ProductService {

    private final FeatureManager features;

    public ProductService(FeatureManager features) {
        this.features = features;
    }

    public ProductView getProduct(long productId, FeatureContext ctx) {
        if (features.isActive("new-product-ui", ctx)) {
            return renderNewUi(productId);
        }
        return renderLegacyUi(productId);
    }
}
```

## 실무에서 걸리는 지점

- **평가 결과의 일관성.** 같은 사용자가 요청마다 다른 그룹에 떨어지면 A/B 결과가 오염되고 화면이 요청마다 바뀐다. ==퍼센트 롤아웃은 난수가 아니라 사용자 ID 해시로 버킷을 정해야 같은 사용자가 항상 같은 경로를 탄다.== 한 요청 안에서 토글을 여러 번 평가하지 말고 진입점에서 한 번 평가한 결과를 전달한다.
- **토글 저장소 장애.** 매 요청마다 외부 저장소를 조회하면 지연이 누적되고, 저장소가 멈추면 서비스 전체가 멈춘다. 로컬 캐시에 TTL을 두고, ==저장소 조회 실패 시 마지막으로 성공한 값이나 명시된 기본값으로 폴백하지 않으면 토글 서버 장애가 곧 서비스 장애가 된다.==
- **되돌릴 수 없는 변경.** 새 기능이 DB 스키마나 데이터 형식을 바꿨다면 토글을 끄는 것만으로 이전 상태로 돌아가지 않는다. ==토글로 끌 수 있는 것은 실행 경로뿐이므로 스키마 변경은 신구 코드가 모두 읽을 수 있는 확장-수축(expand-contract) 방식으로 따로 관리한다.==
- **제거되지 않는 토글.** 릴리스가 끝난 토글의 분기는 죽은 코드가 되고, 토글이 n개면 이론상 2^n 조합의 경로가 생겨 테스트 범위가 정해지지 않는다. 토글 생성 시 소유자와 만료일을 기록하고, 만료된 토글은 빌드 경고나 테스트 실패로 드러나게 한다.
- **응답 캐시와의 충돌.** 토글 결과가 응답 캐시에 섞이면 토글을 껐는데도 캐시된 새 화면이 계속 나가고, 켰는데도 옛 응답이 나간다. 캐시 키에 토글 상태를 포함하거나 토글 변경 시 해당 캐시를 무효화한다.

## 관련 글

- [API 버저닝 — 버전 정보의 위치와 호환성](/notes/architecture-patterns/api-versioning/)
- [스트랭글러 — 레거시를 점진적으로 교체하기](/notes/architecture-patterns/strangler-fig/)
- [캐싱 — Look-aside·Write-through·Write-behind](/notes/architecture-patterns/caching/)
