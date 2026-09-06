# architecture-patterns 매핑 (25편) — 옛 티스토리 글(T/<id> = https://jinwookoh.tistory.com/<id>) 기반

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | optimistic-pessimistic-lock | 동시성 제어 — 비관적 락과 낙관적 락 | 데이터 | T/229 |
| 2 | pagination | 페이지네이션 — 오프셋과 커서 | 데이터 | T/231 |
| 3 | orm-active-record-repository | ORM — Active Record와 Repository | 데이터 | T/233 |
| 4 | caching | 캐싱 — Look-aside·Write-through·Write-behind | 데이터 | T/235 |
| 5 | sharding | 샤딩 — 수평 분할과 샤드 키 선택 | 데이터 | T/247 |
| 6 | cqrs | CQRS — 명령과 조회 모델 분리 | 데이터 | T/237 |
| 7 | event-sourcing | 이벤트 소싱 — 상태 대신 이벤트를 저장하기 | 데이터 | T/251 |
| 8 | api-gateway | API 게이트웨이 — 단일 진입점과 BFF | 서비스 통신 | T/236 |
| 9 | service-discovery | 서비스 디스커버리 — 클라이언트 사이드와 서버 사이드 | 서비스 통신 | T/242 |
| 10 | sidecar | 사이드카 — 횡단 관심사를 보조 프로세스로 분리 | 서비스 통신 | T/244 |
| 11 | messaging | 메시징 — Point-to-Point와 Pub/Sub, 소비 모델 | 서비스 통신 | T/252 |
| 12 | async-request-reply | 비동기 요청-응답 — 오래 걸리는 작업과 폴링 | 서비스 통신 | T/245 |
| 13 | transactional-outbox | 트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결 | 서비스 통신 | T/238 |
| 14 | saga | 사가 — 코레오그래피와 오케스트레이션 | 서비스 통신 | T/232 |
| 15 | circuit-breaker | 서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태 | 복원력 | T/234 |
| 16 | retry | 재시도 — 지수 백오프와 지터 | 복원력 | T/241 |
| 17 | bulkhead | 벌크헤드 — 스레드 풀·세마포어로 자원 격리 | 복원력 | T/243 |
| 18 | rate-limiter | 처리율 제한 — 고정 윈도·슬라이딩 윈도·토큰 버킷 | 복원력 | T/239 |
| 19 | health-check | 헬스 체크 — Liveness와 Readiness | 복원력 | T/240 |
| 20 | leader-election | 리더 선출 — 인스턴스 하나만 작업하게 만들기 | 복원력 | T/246 |
| 21 | api-versioning | API 버저닝 — 버전 정보의 위치와 호환성 | API·운영 | T/249 |
| 22 | session-vs-jwt | 인증 상태 관리 — 세션과 JWT | API·운영 | T/248 |
| 23 | multi-tenancy | 멀티테넌시 — 테넌트별 데이터 격리 전략 | API·운영 | T/250 |
| 24 | feature-toggle | 피처 토글 — 배포와 릴리스 분리 | API·운영 | T/253 |
| 25 | strangler-fig | 스트랭글러 — 레거시를 점진적으로 교체하기 | API·운영 | T/254 |
