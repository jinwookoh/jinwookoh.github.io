---
title: "CQRS — 명령과 조회 모델 분리"
series: architecture-patterns
part: "데이터"
order: 6
summary: "쓰기 모델과 읽기 모델을 코드 수준에서 먼저 나누고, 조회 부하가 한계에 닿을 때만 저장소까지 분리한다"
tags: [CQRS, Command, Query, Eventual Consistency, Spring Data]
sources: [https://jinwookoh.tistory.com/237]
updated: 2026-09-06
---

대부분의 서비스는 읽기 요청이 쓰기 요청보다 훨씬 많다. 그런데 하나의 엔티티와 하나의 서비스가 회원 가입, 비밀번호 변경, 프로필 조회, 목록 검색을 모두 담당하는 구조에서는 두 요구가 충돌한다. 조회 화면에 맞추려고 엔티티에 연관 관계와 필드를 늘리면 쓰기 쪽 불변식이 흐려지고, 도메인 로직을 지키려고 엔티티를 단단히 만들면 목록 화면 하나를 위해 여러 엔티티를 조인해 DTO로 다시 조립하는 비용이 붙는다. 조회 부하를 줄이려고 캐시나 복제본을 붙이려 해도 쓰기와 읽기가 같은 모델을 공유하면 어디까지 분리할 수 있는지 경계가 없다. CQRS는 이 두 책임을 처음부터 다른 모델로 나눈다.

## 핵심 개념

CQRS(Command Query Responsibility Segregation)는 상태를 바꾸는 명령(Command)과 상태를 읽는 조회(Query)를 서로 다른 모델로 다루는 패턴이다. 명령 모델은 도메인 규칙과 불변식을 지키는 데 집중하고 반환값은 없거나 식별자 정도로 제한한다. 조회 모델은 화면이나 API 응답에 필요한 형태의 DTO를 바로 만들어 내며 도메인 로직을 갖지 않는다.

분리 수준은 두 단계로 나뉜다.

논리적 분리는 저장소는 하나를 쓰되 애플리케이션 안에서 서비스·모델·리포지토리를 명령용과 조회용으로 나눈다. 명령 쪽은 JPA 엔티티와 도메인 메서드로 상태를 바꾸고, 조회 쪽은 JPQL 프로젝션, QueryDSL, JdbcClient 같은 도구로 필요한 컬럼만 읽어 DTO에 담는다. 같은 트랜잭션 저장소를 쓰므로 쓰기 직후 읽기가 최신 상태를 보장한다.

물리적 분리는 읽기 저장소를 따로 둔다. 쓰기는 RDBMS에 하고, 조회는 Elasticsearch·Redis·읽기 복제본처럼 조회 패턴에 맞는 저장소에서 처리한다. 두 저장소는 이벤트로 동기화한다. 쓰기 트랜잭션이 커밋되면 변경 이벤트를 메시지 브로커로 발행하고, 컨슈머가 이를 받아 읽기 저장소의 문서를 갱신한다. 이 구간에서 두 저장소는 최종적 일관성(eventual consistency)만 갖는다.

| 구분 | 논리적 분리 | 물리적 분리 |
|---|---|---|
| 저장소 | 1개 공유 | 쓰기·읽기 별도 |
| 일관성 | 트랜잭션으로 즉시 | 이벤트 전파 후 최종적 |
| 얻는 것 | 도메인 모델 보호, 조회 코드 단순화 | 조회 저장소 선택 자유, 읽기 독립 확장 |
| 비용 | 낮음 | 브로커·컨슈머·재동기화 운영 |

## 코드

명령 서비스는 엔티티를 통해서만 상태를 바꾸고 DTO를 반환하지 않는다. 비밀번호 변경은 더티 체킹으로 커밋 시점에 반영된다.

```java
@Service
@Transactional
public class MemberCommandService {

    private final MemberRepository memberRepository;
    private final PasswordEncoder passwordEncoder;

    public MemberCommandService(MemberRepository memberRepository, PasswordEncoder passwordEncoder) {
        this.memberRepository = memberRepository;
        this.passwordEncoder = passwordEncoder;
    }

    public Long register(RegisterMemberCommand command) {
        Member member = Member.register(command.email(), passwordEncoder.encode(command.rawPassword()));
        return memberRepository.save(member).getId();
    }

    public void changePassword(Long memberId, String rawPassword) {
        Member member = memberRepository.findById(memberId)
                .orElseThrow(() -> new MemberNotFoundException(memberId));
        member.changePassword(passwordEncoder.encode(rawPassword));
    }
}
```

조회 서비스는 엔티티를 거치지 않고 `JdbcClient`로 화면에 필요한 컬럼만 읽어 record에 담는다. 읽기 전용 트랜잭션으로 플러시와 스냅샷 비용을 없앤다.

```java
public record MemberProfileView(Long id, String email, String nickname, int postCount) {}

@Service
@Transactional(readOnly = true)
public class MemberQueryService {

    private final JdbcClient jdbcClient;

    public MemberQueryService(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public MemberProfileView profile(Long memberId) {
        return jdbcClient.sql("""
                select m.id, m.email, m.nickname, count(p.id) as post_count
                from member m left join post p on p.member_id = m.id
                where m.id = :id
                group by m.id, m.email, m.nickname
                """)
                .param("id", memberId)
                .query(MemberProfileView.class)
                .single();
    }
}
```

물리적 분리에서는 쓰기 트랜잭션 커밋 뒤에만 이벤트를 내보내야 한다. `@TransactionalEventListener`가 커밋 이후를 보장하고, 컨슈머는 받은 이벤트로 Elasticsearch 문서를 덮어쓴다.

```java
@Component
public class ProductEventRelay {

    private final KafkaTemplate<String, ProductUpdated> kafkaTemplate;

    public ProductEventRelay(KafkaTemplate<String, ProductUpdated> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(ProductUpdated event) {
        kafkaTemplate.send("product-updates", event.productId().toString(), event);
    }
}

@Component
public class ProductSearchProjector {

    private final ProductSearchRepository searchRepository;

    public ProductSearchProjector(ProductSearchRepository searchRepository) {
        this.searchRepository = searchRepository;
    }

    @KafkaListener(topics = "product-updates", groupId = "product-search")
    public void project(ProductUpdated event) {
        searchRepository.save(ProductDocument.from(event));
    }
}
```

## 실무에서 걸리는 지점

- 쓰기 직후 조회가 옛 값을 돌려준다. 물리적 분리에서는 커밋과 읽기 저장소 반영 사이에 지연이 있으므로, ==저장 응답을 받자마자 목록을 다시 불러오는 화면은 방금 만든 항목이 빠진 결과를 정상 응답으로 받는다.== 명령 응답에 포함된 데이터로 화면을 갱신하거나, 해당 사용자의 직후 요청만 잠시 쓰기 저장소로 보내는 식으로 처리한다.
- 이벤트를 커밋 전에 발행하면 읽기 저장소에 존재하지 않는 데이터가 생긴다. ==일반 이벤트 리스너는 트랜잭션과 무관하게 즉시 실행되므로 이후 롤백된 변경이 읽기 저장소에 남는다.== 커밋 이후 리스너를 쓰더라도 브로커 전송 자체가 실패하면 이벤트가 유실되므로, 확실한 전달이 필요하면 아웃박스 테이블을 거친다.
- 컨슈머는 같은 이벤트를 두 번 받을 수 있다. 읽기 저장소 갱신은 문서 전체를 덮어쓰는 멱등한 upsert로 만들고, 순서가 바뀌어도 오래된 이벤트가 최신 문서를 덮지 않도록 버전이나 갱신 시각을 비교한다.
- 읽기 저장소는 언제든 다시 만들 수 있어야 한다. 매핑 변경, 컨슈머 버그, 브로커 보존 기간 초과 등으로 읽기 저장소가 어긋나면 쓰기 저장소에서 전체를 다시 투영하는 재색인 경로가 필요하다. ==이 경로를 처음부터 만들어 두지 않으면 데이터 불일치를 발견해도 복구 수단이 없다.==
- 논리적 분리에서 `@Transactional(readOnly = true)`는 힌트일 뿐 쓰기를 막지 않는다. 조회 서비스에서 엔티티를 꺼내 필드를 바꾸면 JPA는 플러시를 건너뛰어 변경이 조용히 사라진다. 조회 쪽은 엔티티 대신 DTO 프로젝션만 반환하도록 강제하는 편이 안전하다.

## 관련 글

- [이벤트 소싱 — 상태 대신 이벤트를 저장하기](/notes/architecture-patterns/event-sourcing/)
- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
- [캐싱 — Look-aside·Write-through·Write-behind](/notes/architecture-patterns/caching/)
