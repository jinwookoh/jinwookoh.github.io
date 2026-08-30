---
title: "쿼리 — 메서드 이름·@Query·QueryDSL·Auditing"
series: java-spring
part: "데이터"
order: 28
summary: "단순 조건은 메서드 이름, 조인은 @Query, 동적 조건은 QueryDSL로 나누고 생성·수정 이력은 Auditing에 맡긴다"
tags: [Spring Data JPA, JPQL, QueryDSL, Auditing, Pageable]
sources: [spring/2026-05-16-jpa-query-methods.md, spring/2026-05-17-querydsl.md, spring/2026-05-17-jpa-auditing.md]
updated: 2026-08-29
---

`JpaRepository`의 기본 CRUD만으로는 상태별·기간별·조인 조회를 처리할 수 없다. JPQL 문자열로만 해결하면 조건이 늘수록 `(:status IS NULL OR o.status = :status)` 분기가 쌓이고, 필드 이름을 바꿔도 컴파일은 통과해 런타임에 깨진다. `created_at`·`updated_at`을 서비스 코드에서 손으로 채우면 누락이 생긴다. ==쿼리 작성 방식 세 가지와 Auditing이 이를 나누어 해결한다.==

## 핵심 개념

### 메서드 이름 쿼리

`findByStatusAndAmountGreaterThan(String, int)` 같은 메서드를 선언하면 Spring Data JPA가 시작 시 이름을 파싱해 JPQL을 생성한다. 접두어는 `find`·`count`·`exists`·`delete`, 조건은 `LessThan`·`GreaterThan`·`Between`·`Like`·`Containing`·`In`·`IsNull`, 결합은 `And`·`Or`, 정렬·제한은 `OrderBy…Desc`·`Top<N>`이다. 조건이 서너 개를 넘으면 `@Query`로 넘긴다.

### @Query — JPQL과 네이티브 SQL

JPQL은 테이블이 아니라 엔티티 클래스와 필드를 대상으로 하며 Hibernate가 방언에 맞춰 SQL로 변환한다. `nativeQuery = true`는 DB 고유 함수를 쓰는 대신 DB에 종속된다. 파라미터는 `:name`으로 바인딩하며 Spring Boot 3의 `-parameters` 옵션 덕에 `@Param`을 생략할 수 있다. `UPDATE`·`DELETE`는 `@Modifying`과 트랜잭션이 필요하다.

### 페이징과 프로젝션

`Pageable`을 받으면 `offset`·`limit`과 count 쿼리가 함께 실행되어 `Page<T>`로 돌아온다. 컨트롤러의 `Pageable` 매개변수는 `?page=0&size=20&sort=createdAt,desc`에서 자동 변환되고 `@PageableDefault`로 기본값을 정한다. 전체 개수가 필요 없으면 `Slice<T>`를 쓴다. 프로젝션은 getter만 가진 인터페이스를 반환 타입으로 쓰거나 JPQL의 `SELECT new 패키지.DTO(...)` 생성자 표현식으로 필요한 컬럼만 조회한다.

### QueryDSL

어노테이션 프로세서가 엔티티마다 `QOrder` 같은 Q 클래스를 생성하고, 필드를 자바 표현식으로 참조하므로 오타가 컴파일 오류가 된다. 핵심은 `where(...)`에 넘긴 `BooleanExpression`이 null이면 조건에서 제외된다는 점이다. 조건마다 null을 돌려주는 메서드를 나열하면 동적 검색이 분기문 없이 표현되고, `OrderSpecifier`로 정렬도 런타임에 바꾼다. Spring Data와는 커스텀 인터페이스 + `Impl` 접미사 구현체 규칙으로 결합한다.

### Auditing

`@EnableJpaAuditing`을 켜고 `@MappedSuperclass` + `@EntityListeners(AuditingEntityListener.class)`를 붙인 부모 클래스에 `@CreatedDate`·`@LastModifiedDate`·`@CreatedBy`·`@LastModifiedBy` 필드를 두면 INSERT·UPDATE가 나가는 시점에 값이 채워진다. 작성자는 `AuditorAware<T>` 빈이 돌려준다. 시각 타입은 단일 시간대라면 `LocalDateTime`, 여러 시간대라면 `Instant`를 쓴다.

## 코드

메서드 이름 쿼리, JPQL, 네이티브 SQL, 벌크 수정, 프로젝션을 한 리포지토리에 선언한 예다.

```java
public interface OrderRepository extends JpaRepository<Order, Long>, OrderQueryRepository {

    List<Order> findByStatusAndAmountGreaterThanOrderByCreatedAtDesc(OrderStatus status, long amount);

    Optional<Order> findByOrderNumber(String orderNumber);

    Page<Order> findByStatus(OrderStatus status, Pageable pageable);

    @Query("SELECT o FROM Order o JOIN FETCH o.user u WHERE u.email = :email")
    List<Order> findByUserEmail(String email);

    @Query(value = "SELECT * FROM orders WHERE created_at > NOW() - INTERVAL '7 days'",
           nativeQuery = true)
    List<Order> findRecent();

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Order o SET o.status = 'EXPIRED' WHERE o.expiresAt < CURRENT_TIMESTAMP")
    int expireOldOrders();

    @Query("SELECT new com.example.order.OrderSummary(o.id, o.status, o.amount) " +
           "FROM Order o WHERE o.status = :status")
    List<OrderSummary> findSummaries(OrderStatus status);
}

public record OrderSummary(Long id, OrderStatus status, long amount) {}
```

QueryDSL 구현체다. null 조건은 `where`에서 제외되고, 페이징은 내용 쿼리와 count 쿼리를 분리해 `PageImpl`로 조립한다.

```java
@Configuration
class QueryDslConfig {
    @Bean
    JPAQueryFactory jpaQueryFactory(EntityManager em) {
        return new JPAQueryFactory(em);
    }
}

public interface OrderQueryRepository {
    Page<Order> search(OrderSearchCondition cond, Pageable pageable);
}

@RequiredArgsConstructor
public class OrderQueryRepositoryImpl implements OrderQueryRepository {

    private static final QOrder order = QOrder.order;
    private static final QUser user = QUser.user;

    private final JPAQueryFactory queryFactory;

    @Override
    public Page<Order> search(OrderSearchCondition cond, Pageable pageable) {
        List<Order> content = queryFactory
                .selectFrom(order)
                .join(order.user, user).fetchJoin()
                .where(statusEq(cond.status()),
                       createdAtBetween(cond.from(), cond.to()),
                       amountGoe(cond.minAmount()),
                       userIdEq(cond.userId()))
                .orderBy(orderSpec(cond.sortBy()))
                .offset(pageable.getOffset())
                .limit(pageable.getPageSize())
                .fetch();

        Long total = queryFactory
                .select(order.count())
                .from(order)
                .where(statusEq(cond.status()),
                       createdAtBetween(cond.from(), cond.to()),
                       amountGoe(cond.minAmount()),
                       userIdEq(cond.userId()))
                .fetchOne();

        return new PageImpl<>(content, pageable, total == null ? 0 : total);
    }

    private BooleanExpression statusEq(OrderStatus status) {
        return status == null ? null : order.status.eq(status);
    }

    private BooleanExpression createdAtBetween(LocalDateTime from, LocalDateTime to) {
        if (from == null && to == null) return null;
        if (from == null) return order.createdAt.loe(to);
        if (to == null) return order.createdAt.goe(from);
        return order.createdAt.between(from, to);
    }

    private BooleanExpression amountGoe(Long min) {
        return min == null ? null : order.amount.goe(min);
    }

    private BooleanExpression userIdEq(Long userId) {
        return userId == null ? null : order.user.id.eq(userId);
    }

    private OrderSpecifier<?> orderSpec(String sortBy) {
        return "amount".equals(sortBy) ? order.amount.desc() : order.createdAt.desc();
    }
}
```

Auditing 설정이다. 부모 클래스와 `AuditorAware` 빈을 두고 엔티티는 상속만 한다.

```java
@Configuration
@EnableJpaAuditing
class JpaAuditingConfig {
    @Bean
    AuditorAware<String> auditorAware() {
        return () -> Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
                .filter(Authentication::isAuthenticated)
                .filter(a -> !(a instanceof AnonymousAuthenticationToken))
                .map(Authentication::getName);
    }
}

@MappedSuperclass
@EntityListeners(AuditingEntityListener.class)
@Getter
public abstract class BaseEntity {

    @CreatedDate
    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(nullable = false)
    private Instant updatedAt;

    @CreatedBy
    @Column(updatable = false)
    private String createdBy;

    @LastModifiedBy
    private String updatedBy;
}

@Entity
@Table(name = "orders")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Order extends BaseEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    private OrderStatus status;

    private long amount;

    @ManyToOne(fetch = FetchType.LAZY)
    private User user;
}
```

## 실무에서 걸리는 지점

- ==**`@Modifying` 벌크 쿼리와 1차 캐시 불일치.** 벌크 UPDATE는 DB에 직접 반영되고 영속성 컨텍스트는 갱신되지 않는다.== `clearAutomatically = true`를 준다. Auditing도 타지 않는다.
- **count 쿼리 비용.** `Page<T>`는 매 요청마다 count 쿼리를 실행한다. count 쿼리에서는 fetch join을 빼고, 전체 개수가 필요 없으면 `Slice<T>`로 대체한다.
- ==**컬렉션 fetch join과 페이징.** `@OneToMany`를 fetch join한 채 `limit`을 걸면 Hibernate가 전체 행을 메모리에 올린 뒤 잘라낸다(`HHH90003004` 경고).== 컬렉션은 `default_batch_fetch_size`로 푼다.
- **Q 클래스 생성 실패.** `QOrder cannot be resolved`는 어노테이션 프로세서 누락이거나 컴파일 전 상태다. Spring Boot 3에서는 `querydsl-jpa`·`querydsl-apt`에 `jakarta` classifier가 필요하다.
- **Auditing이 비는 경우.** `@EnableJpaAuditing`이나 부모 클래스의 `@EntityListeners`가 빠지면 null이 들어간다. `AuditorAware`가 익명 인증을 거르지 않으면 `createdBy`에 `anonymousUser`가 기록된다.

## 관련 글

- [JPA·Hibernate·Spring Data JPA — Entity와 Repository](/notes/java-spring/jpa-hibernate-spring-data/)
- [연관관계·N+1·값 객체](/notes/java-spring/jpa-relations-n-plus-1/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
