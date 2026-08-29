# 기술 노트 아카이브 설계 (Study Notes Archive)

작성일: 2026-08-29
상태: 설계 확정 대기 (사용자 리뷰)

## 1. 목적

`~/Project/Coupang/posts/study/`에 쌓인 강의 노트 약 330편을 **포트폴리오용 기술 노트 약 165편**으로 통합·재작성하고,
포트폴리오 사이트(https://jinwookoh.github.io)의 아카이브로 발행한다.

- 독자: 채용 담당자, 동료 개발자. "개념을 얼마나 명확히 정리하는 사람인가"를 보여주는 자산.
- 옛 글의 문제: 같은 주제가 시리즈·루트에 중복, 블로거 말투·비유·이모지·SEO 늘어짐, 닫힌 블로그(smartlifen4n.com) 링크·쿠팡 위젯 잔재.

## 2. 범위

### 포함 — 통합 시리즈 10개 (원본 → 목표 편수)

| # | 시리즈 slug | 이름 | 원본 | 목표 |
|---|---|---|---|---|
| 1 | `java-spring` | Java / Spring | spring 62 + 루트 16 + 타 시리즈 4 = 82 | 33 |
| 2 | `spring-batch` | Spring Batch | 48 | 20 |
| 3 | `kafka` | Kafka | data-infra 80~130 + 보강 2 + 루트 13 = 66 | 24 |
| 4 | `redis` | Redis | data-infra 47~79 + 보강 2 + 루트 8 = 43 | 16 |
| 5 | `postgresql` | PostgreSQL | data-infra 1~46 = 46 | 20 |
| 6 | `elasticsearch` | Elasticsearch | 38 + 보강 2 = 40 | 20 |
| 7 | `observability` | 관측성 | micrometer 9 + grafana 9 + ES 30·34 + spring 57 = 20 | 10 |
| 8 | `experimentation` | 실험·분석 (Statsig + GA4) | statsig 9 + 루트 A/B 2 + ga 9 = 20 | 10 |
| 9 | `braze` | Braze | 8 | 5 |
| 10 | `aws` | AWS | 루트 SAA 13 + S3 7 + DVA 1 = 21 | 12 |

작업 순서: 1 → 3 → 4 → 5 → 6 → 2 → 7 → 8 → 9 → 10.

### Java / Spring 목차 (33편, 확정)

Part 1 자바 기초: (1) 개관·JVM·인터페이스·다형성 ← spring 1,3 · (2) 컬렉션·제네릭·Optional ← 5,6,8 · (3) 예외·Stream·람다 ← 7,9 · (4) 빌드·프로젝트 구성 ← 10,12,13
Part 2 Spring 코어: (5) Framework와 Boot 자동 구성 ← 11, 보강-자동구성, 루트 Spring Boot 입문 · (6) IoC/DI·ApplicationContext·Bean ← 14,15,16,17 · (7) Bean 등록·주입 ← 4,18,19 · (8) Scope·생명주기 ← 20,21 · (9) AOP·SpEL ← 22,23,24 · (10) 서비스 레이어 분리 ← 보강
Part 3 Web MVC: (11) DispatcherServlet·Filter/Interceptor ← 25,26 · (12) Controller·바인딩 ← 27,28,29 · (13) ArgumentResolver·업로드·페이징 ← 30,31, 루트 Multipart·Pageable · (14) 예외 처리·검증 ← 33,34,35 · (15) CORS·Security·OAuth2·JWT ← 32,37, 루트 Security · (16) OpenAPI 문서화 ← 59, 루트 OpenAPI
Part 4 데이터: (17) JDBC·JdbcTemplate ← 41,42 · (18) @Transactional·락 ← 43, 보강-락 · (19) JPA·Hibernate·Spring Data JPA ← 44,45, 루트 Data JPA · (20) 연관관계·N+1·값 객체 ← 46,47, 루트 JPA 관계 매핑 · (21) 쿼리·QueryDSL·Auditing ← 48,49,50 · (22) 영속성 컨텍스트·LazyLoading ← 51 · (23) 캐싱·Spring Data Redis ← 56, 루트 @Cacheable, 루트 Spring Data Redis, data-infra 73
Part 5 운영·통합: (24) 로깅 ← 36 · (25) 이벤트·비동기·스케줄링 ← 38,39,55 · (26) RestClient·WebClient ← 40, 루트 RestClient · (27) 테스트 ← 52,53,54, 루트 Flyway·Testcontainers, 루트 MVC REST · (28) Actuator·Micrometer ← 57, 루트 Actuator, micrometer 5 · (29) MapStruct·Docker ← 58, 루트 Docker · (30) WebFlux ← 루트 WebFlux · (31) Spring Kafka·Cloud Gateway ← 루트 MSA+Kafka, 루트 Gateway, data-infra 130 · (32) Spring AI ← 루트 OpenAPI·Spring AI · (33) 베스트 프랙티스 ← 루트 Spring Professional

나머지 9개 시리즈의 세부 목차는 각 시리즈 착수 시 같은 형식(목표 글 ← 원본 목록)의 매핑 파일로 확정한다.

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

- `/notes/` — 10개 시리즈 카드(이름·설명·편수). 프로필 `index.html` 상단 내비와 푸터 "Coming soon"을 이 링크로 교체.
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

- 10개 시리즈 165편(±10%)이 `/notes/`에서 열리고 내부 링크가 모두 살아 있다.
- 빌드 검증이 0 에러로 통과한다.
- 프로필 페이지에서 Notes로 진입 가능, 모바일에서 본문·코드가 가로 스크롤 없이 읽힌다.
