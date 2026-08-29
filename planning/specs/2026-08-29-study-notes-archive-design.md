# 기술 노트 아카이브 설계 (Study Notes Archive)

작성일: 2026-08-29
상태: 확정 (2026-08-29, 루트 235편 재집계 반영)

## 1. 목적

`~/Project/Coupang/posts/study/`에 쌓인 강의 노트 약 580편(시리즈 폴더 9개 + 루트 235편)을 **포트폴리오용 기술 노트 약 230편**으로 통합·재작성하고,
포트폴리오 사이트(https://jinwookoh.github.io)의 아카이브로 발행한다.

- 독자: 채용 담당자, 동료 개발자. "개념을 얼마나 명확히 정리하는 사람인가"를 보여주는 자산.
- 옛 글의 문제: 같은 주제가 시리즈·루트에 중복, 블로거 말투·비유·이모지·SEO 늘어짐, 닫힌 블로그(smartlifen4n.com) 링크·쿠팡 위젯 잔재.

## 2. 범위

### 포함 — 통합 시리즈 13개 (원본 → 목표 편수)

| # | 시리즈 slug | 이름 | 원본 | 목표 |
|---|---|---|---|---|
| 1 | `java-spring` | Java / Spring | spring 62 + 루트 spring 16 + java-fp 6 + vt 8 + oop/solid 2 + design-patterns 4 + 타 시리즈 Spring 글 4 = 102 | 40 |
| 2 | `reactive-spring` | Reactive Spring | 루트 reactive 15 + webflux 15 + reactive-redis 7 + rsocket 9 + grpc 10 + graphql 7 = 63 | 24 |
| 3 | `kafka` | Kafka | data-infra 80~130 (51) + 보강 2 + 루트 kafka 입문·마스터 28 + connect 5 = 86 | 26 |
| 4 | `redis` | Redis | data-infra 47~79 (33) + 보강 2 + 루트 redis 9 = 44 | 16 |
| 5 | `postgresql` | DB 원리와 PostgreSQL | data-infra 1~46 (46) + 루트 db-eng 8 = 54 | 24 |
| 6 | `elasticsearch` | Elasticsearch | 38 + 보강 2 + 루트 es 10 = 50 | 20 |
| 7 | `spring-batch` | Spring Batch | 48 + 루트 8 = 56 | 20 |
| 8 | `observability` | 관측성 | micrometer 9 + grafana 9 + ES 30·34 + spring 57 = 20 | 10 |
| 9 | `experimentation` | 실험·분석 (Statsig · GA4 · A/B · 통계) | statsig 9 + ga 9 + 루트 ab-test 7 + ga4 7 + prob-stats 6 = 38 | 15 |
| 10 | `sns-project` | 실전 프로젝트: SNS 마이크로서비스 | 루트 javaex-sns 7 | 5 |
| 11 | `infra` | 인프라: Kubernetes · Consul | 루트 k8s 10 + consul 7 = 17 | 10 |
| 12 | `aws` | AWS | 루트 saa 14 + dva 12 + s3 7 = 33 | 15 |
| 13 | `braze` | Braze | 8 | 5 |

작업 순서: 1 → 3 → 4 → 5 → 6 → 2 → 7 → 10 → 8 → 9 → 11 → 12 → 13.

### Java / Spring 목차 (40편, 확정)

Part 1 자바 기초·모던 자바 (10): (1) 개관·JVM·객체와 클래스·OOP 4기둥 ← spring 1,2, 루트 oop-principles · (2) 인터페이스·다형성·SOLID ← spring 3, 루트 solid-principles · (3) 컬렉션·제네릭·Optional ← 5,6,8 · (4) 예외 처리 ← 7 · (5) 람다·함수형 인터페이스·Stream ← 9, 루트 java-fp-lambda, java-fp-functional-interfaces, java-fp-stream, java-fp-basics · (6) Modern Java 9~21 핵심 ← 루트 java-fp-modern, java-fp-virtual-threads · (7) Virtual Thread 원리·API·Pinning ← 루트 vt-concurrency-basics, vt-virtual-thread, vt-api, vt-pinning · (8) Virtual Thread 실전·Spring Boot·Structured Concurrency ← 루트 vt-patterns, vt-performance, vt-spring-boot, vt-structured-concurrency · (9) 디자인 패턴 — 생성·구조 ← 루트 design-patterns-creational, design-patterns-structural · (10) 디자인 패턴 — 행위·조합 ← 루트 design-patterns-behavioral, design-patterns-combinations
Part 2 Spring 코어 (7): (11) 빌드·프로젝트 구성 — Maven/Gradle, start.spring.io, application.yml·Profiles ← 10,12,13 · (12) Framework와 Boot 자동 구성 ← 11, 60(보강-자동구성), 루트 spring-boot-basics · (13) IoC/DI·ApplicationContext·Bean ← 14,15,16,17 · (14) Bean 등록·주입 ← 4,18,19 · (15) Scope·생명주기 ← 20,21 · (16) AOP·SpEL ← 22,23,24 · (17) 계층 설계 — 서비스 레이어 ← 61(보강)
Part 3 Web MVC (6): (18) DispatcherServlet·Filter/Interceptor ← 25,26 · (19) Controller·요청 바인딩 ← 27,28,29 · (20) ArgumentResolver·업로드·페이징 ← 30,31, 루트 spring-mvc-features · (21) 예외 처리·검증 ← 33,34,35 · (22) CORS·Security·OAuth2·JWT ← 32,37, 루트 spring-security · (23) OpenAPI 문서화 ← 59, 루트 spring-openapi-ai(OpenAPI 부분)
Part 4 데이터 (7): (24) JDBC·JdbcTemplate ← 41,42 · (25) @Transactional·낙관/비관 락 ← 43, 62(보강-락) · (26) JPA·Hibernate·Spring Data JPA ← 44,45, 루트 spring-data-jpa · (27) 연관관계·N+1·값 객체 ← 46,47, 루트 spring-jpa-relationships · (28) 쿼리·QueryDSL·Auditing ← 48,49,50 · (29) 영속성 컨텍스트·LazyLoading ← 51 · (30) 캐싱 — @Cacheable·Spring Data Redis ← 56, 루트 spring-caching-events, 루트 redis-spring-data, data-infra 73
Part 5 운영·통합 (10): (31) 로깅 ← 36 · (32) 이벤트·비동기·스케줄링 ← 38,39,55 · (33) HTTP 클라이언트 — RestClient ← 40, 루트 spring-rest-client · (34) 테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway ← 52,53,54, 루트 spring-database-advanced, 루트 spring-mvc-rest · (35) Actuator·Micrometer ← 57, 루트 spring-observability, micrometer 5 · (36) DTO 매핑 — MapStruct ← 58 · (37) 배포 — Docker·Buildpack ← 루트 spring-containers-deployment, spring-cloud-gateway-build(Buildpack 부분) · (38) MSA 입문 — Spring Kafka·Cloud Gateway ← 루트 spring-microservices-kafka, spring-cloud-gateway-build(Gateway 부분), data-infra 130 · (39) Spring AI ← 루트 spring-openapi-ai(AI 부분) · (40) 베스트 프랙티스 ← 루트 spring-certification-best-practices

WebFlux·WebClient·리액티브 계열은 `reactive-spring` 시리즈로 보낸다 (루트 spring-webflux-basics, spring-webflux-advanced 포함).

나머지 12개 시리즈의 세부 목차는 각 시리즈 착수 시 같은 형식(목표 글 ← 원본 목록)의 매핑 파일로 확정한다.

### 제외

`posts/english`, `book`, `youtube`, `picture`, `trending`, `partners` — 포트폴리오 성격과 무관, 이전하지 않음.

## 3. 글 형식 (모든 시리즈 공통)

- 분량 1,500~2,500자 (코드 제외).
- 문체: "~한다"체 기술 문서. 비유·구어체·이모지·"이 글은 N편 중 M편이에요" 류 안내문·SEO용 반복 문장 금지.
- 구조: 제목 → 한 줄 요약(summary) → 왜 필요한가 → 핵심 개념 → 코드 1~3개(최신 안정 버전 기준: Spring Boot 3.x, Java 21) → 실무에서 걸리는 지점 → 관련 글.
- 금지: smartlifen4n.com 링크, 쿠팡 위젯/어필리에이트 문구, 외부 이미지. 시리즈 내부 링크는 `/notes/<series>/<slug>/` 형식만.
- 원본 두 글이 충돌하면 최신 문서(공식 레퍼런스) 기준으로 통일하고, 원본의 좋은 코드 예시는 재사용한다.

Front matter:

```yaml
---
title: "IoC/DI와 ApplicationContext"
series: java-spring
part: "Spring 코어"
order: 6
summary: "Spring이 객체 생성과 의존성 연결을 대신 맡는 이유와 컨테이너의 역할."
tags: [Spring, DI, ApplicationContext]
sources: [spring/2026-05-xx-di-why.md, spring/2026-05-xx-application-context.md]
updated: 2026-09-01
---
```

## 4. 사이트 구조 (jinwookoh.github.io)

### 저장소 레이아웃

```
notes/<series>/<NN>-<slug>.md   # 원고 (source of truth)
notes/<series>/_series.yml      # 시리즈 이름·설명·파트 순서
build/build.mjs                 # notes → docs/notes HTML 생성 (Node 24, 의존성: marked, gray-matter, highlight.js)
planning/                       # 스펙·매핑 (Pages 미발행)
docs/                           # GitHub Pages 소스 (main / docs)
  index.html, style.css         # 프로필 (기존)
  .nojekyll
  notes/index.html              # 시리즈 목록
  notes/<series>/index.html     # 시리즈 목차 (Part별)
  notes/<series>/<slug>/index.html
  notes/notes.css
```

Jekyll을 쓰지 않는 이유: 로컬 Ruby 2.6으로 빌드 불가, Node는 있음. 생성 HTML을 커밋하면 GitHub 빌드 실패 위험도 없다.

### 페이지

- `/notes/` — 13개 시리즈 카드(이름·설명·편수). 프로필 `index.html` 상단 내비와 푸터 "Coming soon"을 이 링크로 교체.
- `/notes/<series>/` — Part 제목 아래 순서대로 글 목록(제목·요약).
- `/notes/<series>/<slug>/` — 본문. 상단 breadcrumb(Notes › 시리즈), 하단 이전/다음 글, 본문 h2 목차 없음(글이 짧음).
- 디자인: 프로필의 시트 디자인(F)과 같은 토큰(네이비·회색 바탕·Pretendard). 코드 블록은 highlight.js 테마를 라이트/다크 둘 다 지정.
- `<title>`, meta description(summary), og 태그 생성. sitemap.xml 생성.

### 빌드

- `node build/build.mjs` — 전체 재생성. 삭제된 원고의 HTML도 제거(디렉토리를 비우고 다시 씀).
- 검증(빌드 시 실패 처리): front matter 필수 키, 같은 시리즈 내 order 중복, 본문 글자 수 범위(1,200~3,000, 코드 제외) 경고, 금지 문자열(smartlifen4n, coupang, 이모지 범위) 오류, 깨진 내부 링크 오류.

## 5. 재작성 파이프라인

1. 시리즈 매핑 확정: `planning/mapping/<series>.md` — 목표 글마다 제목·slug·원본 파일 경로.
2. 글 생성: 목표 글 1편 = 서브에이전트 1회. 입력 = 매핑 행 + 원본 전문 + 이 스펙의 3절. 출력 = `notes/<series>/<NN>-<slug>.md`.
3. 검토: 빌드 검증 통과 + 사람이 시리즈 단위로 훑음(사용자 리뷰 → 수정 요청 반영).
4. 커밋 단위: 시리즈 하나. 푸시는 사용자 승인 후.

## 6. 하지 않는 것 (YAGNI)

댓글, 검색, 태그 페이지, RSS, 다국어, 조회수. 필요해지면 그때 추가.

## 7. 완료 기준

- 13개 시리즈 230편(±10%)이 `/notes/`에서 열리고 내부 링크가 모두 살아 있다.
- 빌드 검증이 0 에러로 통과한다.
- 프로필 페이지에서 Notes로 진입 가능, 모바일에서 본문·코드가 가로 스크롤 없이 읽힌다.
