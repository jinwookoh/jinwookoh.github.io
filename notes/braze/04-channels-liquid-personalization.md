---
title: "메시지 채널과 Liquid 개인화"
series: braze
part: "메시징과 운영"
order: 4
summary: "Push·In-app·Content Card·Feature Flag의 역할 분담과 Liquid·Connected Content로 발송 시점에 메시지를 개인화하는 구조"
tags: [Braze, Liquid, Connected Content, Push Notification, Content Card]
sources: [braze/2026-05-17-braze-features-deep.md, braze/2026-05-17-braze-liquid-and-connected-content.md]
updated: 2026-08-30
---

채널을 구분하지 않고 메시지를 보내면 두 가지 문제가 생긴다. 하나는 전달 실패다. 앱을 열지 않은 사용자에게 In-app 메시지를 걸어 두거나 Web Push 인증을 빼먹는 식이다. 다른 하나는 피로다. 같은 사용자에게 Push·In-app·Email이 동시에 도착하면 옵트아웃으로 이어진다. 개인화가 없으면 클릭률이 낮고, 속성을 그대로 끼워 넣으면 이름이 빈 사용자에게 "안녕하세요, 님"이 나간다. 채널 특성과 템플릿 안전선을 함께 잡아야 한다.

## 핵심 개념

### 네 가지 전달 기능의 역할

개발자가 직접 통합하는 기능은 Push, In-app Message, Content Card, Feature Flag 네 가지이며, 사용자가 어디에 있을 때 닿는지가 다르다.

| 기능 | 사용자 위치 | 성격 | 약점 |
|:---|:---|:---|:---|
| Push | 앱 외부·브라우저 | 즉시, 광범위 | OS 권한 필요 |
| In-app Message | 앱 사용 중 | 권한 불필요, 풍부한 UI | 비활성 사용자 도달 불가 |
| Content Card | 앱 내 인박스 | dismiss까지 지속 노출 | 인박스 미진입 시 노출 없음 |
| Feature Flag | 코드 분기 | 배포 없이 기능 ON/OFF | 메시지가 아님 |

긴급도는 Push가 가장 높고 Content Card가 가장 낮으며, 정보량은 그 반대다. 한 캠페인은 한 채널로 시작하고 도달하지 못했을 때 다음 채널로 넘기는 cascade fallback이 표준이다.

Push 인증은 플랫폼마다 다르다. iOS는 APNs Auth Key(.p8, 무기한) 또는 인증서(.p12, 연 1회 만료), Android는 FCM v1 API와 Service Account JSON, Web은 Service Worker와 VAPID 키에 HTTPS가 필수다. Deep link를 붙이면 탭 시 목적 화면으로 진입한다. 권한은 Soft Prompt로 가치를 먼저 설명한 뒤 OS 프롬프트를 띄우는 순서가 거부율을 낮춘다.

In-app Message는 Custom Event·Session Start·Purchase를 트리거로 노출되며, 조건을 동시에 만족하면 우선순위가 높은 것만 표시한다. Content Card는 Classic·Captioned Image·Banner에 더해 비표시 Control Card가 있어 노출 효과를 A/B로 측정한다. Feature Flag는 Canvas 단계와 연결해 기능 출시와 메시지를 동기화하는 점이 전용 도구와의 차이다.

### 개인화의 세 층

개인화는 Static(하드코딩), Dynamic(Liquid, Braze 내부 데이터), Connected(외부 API)의 세 층으로 나뉘고 한 메시지 안에서 섞여 동작한다.

Liquid는 Shopify가 공개한 템플릿 언어로 Variable `{{ }}`, Tag `{% %}`, Filter `| name` 세 요소로 구성된다. Braze는 사용자 속성을 `${attr}`, 트리거 이벤트 속성을 `event_properties.${prop}`, Canvas 진입 속성을 `canvas_entry_properties.${prop}`로 노출하고, `catalog_items`(Catalog 조회)·`connected_content`(외부 API)·`abort_message`(해당 사용자만 발송 중단) 확장 태그를 더했다. Email·Push·SMS·In-app·Content Card 본문과 Deep link URL, Webhook body까지 거의 모든 필드에 들어간다.

Connected Content는 발송 직전에 외부 API를 호출해 응답을 변수로 저장한다. `:cache_max_age`(초)로 응답을 캐싱하고, `:timeout`으로 한도를 두며, `:rescue`로 실패 시 플래그 변수를 세운다. ==호출이 실패해도 발송은 진행되고 해당 구간만 fallback으로 대체된다.==

## 코드

Liquid 템플릿. 변수마다 `default`를 걸고 Connected Content 실패와 빈 결과를 가드한다.

```liquid
{% assign safe_name = ${first_name} | default: '회원님' | strip %}
{% if ${tier} == 'banned' %}{% abort_message('banned user') %}{% endif %}

{% connected_content
   https://api.example.com/marketing/recommendations/{{ ${external_id} }}
   :cache_max_age 600
   :timeout 3
   :save rec
   :rescue 'rec_failed'
%}

{{ safe_name }}님, {% if ${tier} == 'premium' %}Premium 전용 30%{% else %}첫 결제 10%{% endif %} 할인 쿠폰이 발급됐습니다.

{% if rec_failed or rec.items.size == 0 %}
오늘의 인기 상품을 확인해 보세요.
{% else %}
{% for item in rec.items %}
- {{ item.name }} ({{ item.price | money_with_currency: 'KRW' }})  myapp://product/{{ item.id }}
{% endfor %}
{% endif %}
```

Connected Content가 호출하는 발송용 추천 API. PII를 제외한 응답 전용 DTO를 반환하고 Spring Cache로 600초 캐싱한다.

```java
package com.example.marketing;

import java.util.List;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/marketing/recommendations")
public class MarketingRecommendationController {

    private final RecommendationService recommendationService;

    public MarketingRecommendationController(RecommendationService recommendationService) {
        this.recommendationService = recommendationService;
    }

    public record Item(String id, String name, long price, String imageUrl) {}
    public record Response(List<Item> items) {}

    @GetMapping("/{userId}")
    @Cacheable(cacheNames = "marketing-rec", key = "#userId")
    public Response recommend(@PathVariable String userId) {
        List<Item> items = recommendationService.topN(userId, 5).stream()
            .map(r -> new Item(r.productId(), r.productName(), r.price(), r.imageUrl()))
            .toList();
        return new Response(items);
    }
}
```

캐시 설정. Caffeine으로 600초 만료를 두고 발송 직전 pre-warming이 같은 캐시를 채우게 한다.

```java
package com.example.marketing;

import java.util.concurrent.TimeUnit;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.caffeine.CaffeineCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableCaching
public class MarketingCacheConfig {

    @Bean
    CacheManager cacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager("marketing-rec");
        manager.setCaffeine(Caffeine.newBuilder()
            .expireAfterWrite(600, TimeUnit.SECONDS)
            .maximumSize(500_000));
        return manager;
    }
}
```

## 실무에서 걸리는 지점

- **Connected Content timeout이 곧 발송 지연이다.** ==수십만 명 캠페인이면 호출도 수십만 번 나간다.== 자체 API는 500ms 이내 응답을 목표로 하고 `cache_max_age`·CDN·발송 직전 pre-warming으로 rate limit을 피한다.
- **외부 API 응답의 PII가 메시지에 그대로 박힌다.** 발송 전용 응답 스키마를 분리하고 전화번호·이메일은 제외한다. URL에 들어가는 `${attr}`도 자체 API에서 검증한다.
- **LLM 호출은 prompt injection과 비결정성을 함께 안고 있다.** 사용자 속성을 정제해서 넣고, system prompt에 금지 사항을 고정하며, 응답에 길이·키워드 필터를 건다. temperature를 낮추고 캐시를 병행한다.
- ==**Liquid 문법 오류와 Push 인증 만료는 조용히 실패한다.**== `endif`·`default` 누락은 콘솔 preview와 테스트 세그먼트 발송으로 걸러내고, .p12 만료와 앱 재설치 후 토큰 미갱신은 Auth Key 사용과 세션마다 토큰 등록으로 막는다.
- **Frequency cap 없이는 메시지 폭격이 된다.** 사용자·캠페인 단위 cap을 두고, 앱 사용 중 Push는 표시하지 않거나 In-app 하나로 대체한다. Content Card는 expiration을 걸어 오래된 카드가 남지 않게 한다.

## 관련 글

- [SDK 통합·Identity·데이터 모델](/notes/braze/sdk-identity-data-model/)
- [REST API와 Currents](/notes/braze/rest-api-currents/)
- [Canvas·Campaign 운영과 도입 결정](/notes/braze/canvas-operations-adoption/)
