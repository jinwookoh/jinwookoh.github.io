---
title: "API 버저닝 — 버전 정보의 위치와 호환성"
series: architecture-patterns
part: "API·운영"
order: 21
summary: "버전은 깨지는 변경에만 올리고, 위치는 URI·헤더·미디어 타입 중 캐싱과 클라이언트 특성에 맞춰 고른다"
tags: [API Versioning, Media Type, Content Negotiation, Vary, Spring MVC]
sources: [https://jinwookoh.tistory.com/249]
updated: 2026-09-06
---

배포된 API는 서버가 통제하지 못하는 클라이언트와 맺은 계약이다. 스토어에 올라간 모바일 앱, 외부 파트너의 연동 코드는 서버 배포와 같은 시점에 갱신되지 않는다. 응답 필드 `name`을 `firstName`과 `lastName`으로 나누는 순간 구버전 앱은 빈 이름을 표시하거나 역직렬화에 실패한다. 버전이 없으면 계약을 영원히 동결하거나 배포 때마다 누군가의 클라이언트를 깨뜨리게 된다. API 버저닝은 옛 계약과 새 계약을 일정 기간 동시에 제공해 클라이언트가 자기 속도로 이전하게 만드는 장치다.

## 핵심 개념

버저닝의 첫 원칙은 모든 변경에 버전을 올리지 않는 것이다. 응답에 선택적 필드를 추가하거나, 새 엔드포인트를 여는 변경은 기존 클라이언트를 깨뜨리지 않으므로 같은 버전 안에서 처리한다. 버전을 올려야 하는 변경은 필드 삭제·이름 변경·타입 변경, 필수 요청 파라미터 추가, 같은 값의 의미 변경, 에러 응답 형식 변경처럼 기존 클라이언트의 동작을 바꾸는 것이다. 이 구분이 성립하려면 클라이언트가 모르는 필드를 무시하는 관용적 수신자(tolerant reader)여야 한다. ==Jackson의 기본 `ObjectMapper`는 모르는 필드를 만나면 `UnrecognizedPropertyException`을 던지므로, Spring Boot 자동 설정을 거치지 않은 클라이언트에는 필드 추가만으로도 깨지는 변경이 된다.== 호환 정책은 서버 혼자 정할 수 없고 클라이언트 가이드에 함께 명시해야 한다.

버전 정보를 어디에 둘지는 네 가지 위치가 쓰인다.

| 위치 | 형태 | 캐싱 | 특징 |
|---|---|---|---|
| URI 경로 | `GET /v1/members` | URL이 다르므로 CDN·프록시가 자동 분리 | 가장 널리 쓰임. 브라우저·로그·문서에서 버전이 바로 보임 |
| 쿼리 파라미터 | `GET /members?version=1` | 캐시 키에 쿼리가 포함되면 분리 | 생략 시 기본 버전 규칙이 필요 |
| 커스텀 헤더 | `X-API-Version: 1` | `Vary` 헤더 필요 | URI는 유지, 도구 없이는 호출 불편 |
| 미디어 타입 | `Accept: application/vnd.company.v2+json` | `Vary: Accept` 필요 | 콘텐츠 협상의 일부로 처리, HTTP 의미에 가장 부합 |

URI 방식은 리소스 식별자에 표현 방식이 섞인다는 점에서 REST 관점의 비판을 받지만, 운영에서 문제를 일으키는 쪽은 그 반대다. 헤더나 미디어 타입 방식은 같은 URL이 여러 표현을 갖기 때문에 중간 캐시가 버전을 구분할 근거를 응답이 직접 알려줘야 한다. 공개 API처럼 클라이언트가 다양하고 캐시 계층이 많으면 URI 방식이, 게이트웨이 뒤의 내부 API처럼 호출자와 캐시를 통제할 수 있으면 헤더 방식이 무리가 없다.

버전의 단위도 정해야 한다. API 전체에 하나의 버전을 두면 엔드포인트 하나가 깨지는 변경을 겪어도 전체 버전이 올라가고, 클라이언트는 바뀌지 않은 엔드포인트까지 새 경로로 옮겨야 한다. 리소스 단위로 버전을 두면 변경 범위는 작아지지만 클라이언트가 리소스마다 다른 버전을 조합해 호출하게 된다. 어느 쪽이든 서버 내부는 도메인 모델 하나를 유지하고, 버전별 DTO가 그 모델을 서로 다르게 표현하는 구조여야 버전 수만큼 비즈니스 로직이 복제되지 않는다.

## 코드

URI 버저닝. 도메인 모델 `Member`는 하나이고, 컨트롤러가 버전별 DTO로 변환한다. v2는 이름을 두 필드로 나눈 깨지는 변경이다.

```java
@RestController
public class MemberController {

    private final MemberService memberService;

    public MemberController(MemberService memberService) {
        this.memberService = memberService;
    }

    public record MemberV1(Long id, String name) {
        static MemberV1 from(Member m) {
            return new MemberV1(m.id(), m.firstName() + " " + m.lastName());
        }
    }

    public record MemberV2(Long id, String firstName, String lastName) {
        static MemberV2 from(Member m) {
            return new MemberV2(m.id(), m.firstName(), m.lastName());
        }
    }

    @GetMapping("/v1/members/{id}")
    public ResponseEntity<MemberV1> getV1(@PathVariable Long id) {
        return ResponseEntity.ok()
                .header("Deprecation", "true")
                .header("Sunset", "Wed, 31 Mar 2027 00:00:00 GMT")
                .header("Link", "</v2/members/" + id + ">; rel=\"successor-version\"")
                .body(MemberV1.from(memberService.find(id)));
    }

    @GetMapping("/v2/members/{id}")
    public MemberV2 getV2(@PathVariable Long id) {
        return MemberV2.from(memberService.find(id));
    }
}
```

버전별 컨트롤러가 많아지면 패키지 단위로 경로 접두사를 붙이는 편이 매핑 누락을 막는다. `api.v2` 패키지의 핸들러는 모두 `/v2` 아래에 놓인다.

```java
@Configuration
public class ApiPathConfig implements WebMvcConfigurer {

    @Override
    public void configurePathMatch(PathMatchConfigurer configurer) {
        configurer.addPathPrefix("/v1", HandlerTypePredicate.forBasePackage("com.example.api.v1"));
        configurer.addPathPrefix("/v2", HandlerTypePredicate.forBasePackage("com.example.api.v2"));
    }
}
```

미디어 타입 버저닝. 같은 `/members/{id}`에 대해 `Accept` 값으로 핸들러를 고르고, 중간 캐시가 버전을 구분하도록 `Vary` 헤더를 응답에 넣는다. 버전을 지정하지 않은 `application/json` 요청은 마지막 핸들러가 받아 v1로 고정한다.

```java
@RestController
@RequestMapping("/members")
public class MemberMediaTypeController {

    static final String V1 = "application/vnd.company.v1+json";
    static final String V2 = "application/vnd.company.v2+json";

    private final MemberService memberService;

    public MemberMediaTypeController(MemberService memberService) {
        this.memberService = memberService;
    }

    @GetMapping(value = "/{id}", produces = V2)
    public ResponseEntity<MemberV2> getV2(@PathVariable Long id) {
        return ResponseEntity.ok()
                .header(HttpHeaders.VARY, HttpHeaders.ACCEPT)
                .body(MemberV2.from(memberService.find(id)));
    }

    @GetMapping(value = "/{id}", produces = {V1, MediaType.APPLICATION_JSON_VALUE})
    public ResponseEntity<MemberV1> getV1(@PathVariable Long id) {
        return ResponseEntity.ok()
                .header(HttpHeaders.VARY, HttpHeaders.ACCEPT)
                .body(MemberV1.from(memberService.find(id)));
    }
}
```

## 실무에서 걸리는 지점

- 캐시 오염. ==헤더·미디어 타입 방식에서 응답에 `Vary` 헤더가 없으면 CDN이 먼저 도착한 버전의 응답을 URL 하나로 캐시해 다른 버전 클라이언트에 그대로 돌려준다.== 반대로 `Vary: Accept`는 `Accept` 문자열 수만큼 캐시를 쪼개므로 적중률이 떨어진다.
- 기본 버전. ==버전 정보가 없는 요청을 최신 버전으로 해석하면 새 버전을 배포하는 순간 버전을 명시하지 않던 기존 클라이언트가 모두 깨진다.== 기본값은 가장 오래된 지원 버전으로 고정하거나, 명시하지 않은 요청을 400으로 거절해 처음부터 버전을 보내게 만든다.
- 매핑 모호성. `produces`로만 버전을 나눈 상태에서 `Accept: */*` 요청이 오면 두 핸들러가 모두 매칭되어 모호성 예외가 나거나 의도하지 않은 버전이 선택된다. 버전 없는 요청을 받는 핸들러를 하나 명시적으로 두고, 통합 테스트에 `Accept` 헤더가 없는 케이스를 포함한다.
- 은폐된 깨지는 변경. 열거형 값 추가, 날짜 형식 변경, 페이지 크기 기본값 변경, 검증 규칙 강화, 에러 응답 구조 변경은 스키마상 필드가 그대로라 버전을 올리지 않고 배포되기 쉽다. API 변경 검토 항목에 형식·의미·기본값을 포함한다.
- 버전 폐기. 버전은 만들기보다 없애기가 어렵다. 폐기 기준(N-1 지원, 공지 후 몇 개월)을 처음부터 정하고, 버전을 태그로 붙인 요청 지표로 구버전 호출량과 호출자를 추적한다. `Deprecation`·`Sunset` 헤더를 미리 보내면 클라이언트가 로그에서 폐기 예정을 감지할 수 있다.

## 관련 글

- [API 게이트웨이 — 단일 진입점과 BFF](/notes/architecture-patterns/api-gateway/)
- [피처 토글 — 배포와 릴리스 분리](/notes/architecture-patterns/feature-toggle/)
- [스트랭글러 — 레거시를 점진적으로 교체하기](/notes/architecture-patterns/strangler-fig/)
