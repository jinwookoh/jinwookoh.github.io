---
title: "영속성 컨텍스트와 LazyLoading"
series: java-spring
part: "데이터"
order: 29
summary: "영속성 컨텍스트는 트랜잭션 범위의 1차 캐시이며, LazyInitializationException과 N+1은 이 범위를 벗어난 지연 로딩에서 발생한다"
tags: [JPA, Hibernate, 영속성 컨텍스트, LazyLoading, N+1]
sources: [spring/2026-05-16-persistence-context-lazy-loading.md]
updated: 2026-08-29
---

JPA를 처음 쓰면 설명되지 않는 동작이 연달아 나타난다. `save()`를 호출하지 않았는데 UPDATE가 실행되고, 같은 PK로 `findById`를 두 번 호출했는데 SQL은 한 번만 나가며, 서비스 메서드가 끝난 뒤 컨트롤러에서 연관 필드를 읽으면 `LazyInitializationException`이 발생한다. JPA는 SQL을 즉시 실행하는 라이브러리가 아니라 Entity를 메모리에서 관리하다가 필요한 시점에 SQL로 동기화하는 계층이고, 그 관리 공간이 영속성 컨텍스트다. 이 구조를 모르면 조회 한 번이 쿼리 101번으로 늘어나는 N+1 문제도 로그를 보기 전까지 알아채지 못한다.

## 핵심 개념

영속성 컨텍스트(Persistence Context)는 `EntityManager`가 관리하는 Entity의 보관소다. Spring에서는 트랜잭션과 생명주기를 같이하며, `@Transactional` 메서드가 시작될 때 열리고 커밋 또는 롤백 시점에 닫힌다. 컨텍스트가 제공하는 기능은 네 가지다.

첫째, 1차 캐시. 같은 컨텍스트 안에서 같은 PK로 조회하면 두 번째부터는 DB에 가지 않고 보관 중인 객체를 반환하므로 두 참조의 `==` 비교가 참이다. 트랜잭션 단위라 요청 간에 공유되지 않는다.

둘째, 변경 감지(Dirty Checking). Entity를 로딩할 때 초기 상태의 스냅샷을 보관하고, 플러시 시점에 현재 상태와 비교해 달라진 Entity에 대해 UPDATE를 만든다. `save()` 호출 없이 관리 상태의 Entity를 변경한 것만으로 DB가 바뀐다.

셋째, 쓰기 지연. 생성된 SQL은 즉시 실행되지 않고 쌓였다가 커밋 직전, JPQL 실행 직전, `flush()` 호출 시 한꺼번에 나간다.

넷째, 지연 로딩 프록시. 연관 Entity를 프록시로 채워두고, 필드를 처음 읽는 순간 컨텍스트를 통해 SELECT를 실행한다. 컨텍스트가 닫힌 뒤에는 프록시를 초기화할 수 없다.

Entity의 상태는 컨텍스트와의 관계로 네 가지로 나뉜다.

| 상태 | 진입 경로 | 특징 |
|---|---|---|
| Transient | `new` 직후 | 컨텍스트가 모르는 객체, 식별자 없음 |
| Managed | `persist`, `findById`, JPQL 결과 | 1차 캐시·변경 감지 대상 |
| Detached | 트랜잭션 종료, `detach`, `clear` | 변경해도 DB 반영 안 됨, 프록시 초기화 불가 |
| Removed | `remove` 호출 후 | 플러시 시 DELETE 예약 |

로딩 전략은 `FetchType.LAZY`와 `FetchType.EAGER` 두 가지다. `@ManyToOne`과 `@OneToOne`은 기본이 EAGER, `@OneToMany`와 `@ManyToMany`는 기본이 LAZY다. EAGER는 JPQL 조회 시 JOIN이 아니라 별도 SELECT로 채워지므로 N+1을 피하지 못한다. 모든 연관관계를 LAZY로 명시하고 필요한 곳에서만 함께 가져오는 방식이 표준이다.

## 코드

같은 트랜잭션 안에서 1차 캐시와 변경 감지가 동작하는 서비스 메서드다. 두 번째 `findById`는 SQL을 발행하지 않고, 트랜잭션 커밋 시 UPDATE 한 건이 나간다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;

    @Transactional
    public void changeAmount(Long orderId, int amount) {
        Order first = orderRepository.findById(orderId).orElseThrow();
        Order second = orderRepository.findById(orderId).orElseThrow();
        assert first == second;          // 1차 캐시: 같은 인스턴스

        first.changeAmount(amount);      // 변경 감지: save() 없이 커밋 시 UPDATE
    }
}
```

연관관계를 LAZY로 명시한 Entity와, 지연 로딩을 트랜잭션 밖에서 건드려 예외가 나는 경로다.

```java
@Entity
@Table(name = "orders")
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "member_id")
    private Member member;

    private int amount;

    protected Order() {}

    public void changeAmount(int amount) { this.amount = amount; }
    public Long getId() { return id; }
    public Member getMember() { return member; }
    public int getAmount() { return amount; }
}

@Service
@RequiredArgsConstructor
public class OrderQueryService {

    private final OrderRepository orderRepository;

    @Transactional(readOnly = true)
    public Order find(Long id) {
        return orderRepository.findById(id).orElseThrow();  // member는 프록시
    }
}

@RestController
@RequiredArgsConstructor
public class OrderController {

    private final OrderQueryService orderQueryService;

    @GetMapping("/orders/{id}")
    public OrderResponse get(@PathVariable Long id) {
        Order order = orderQueryService.find(id);          // 여기서 컨텍스트 종료
        return new OrderResponse(order.getId(), order.getMember().getName(), order.getAmount());
        // open-in-view=false 환경에서 getName() 호출 시 LazyInitializationException
    }
}
```

해결은 필요한 연관 Entity를 조회 쿼리에서 함께 가져오고, DTO 변환을 트랜잭션 안에서 끝내는 것이다. 목록 조회에는 `@EntityGraph`, 단건 조회에는 Fetch Join을 사용했다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    @Query("select o from Order o join fetch o.member where o.id = :id")
    Optional<Order> findWithMemberById(@Param("id") Long id);

    @EntityGraph(attributePaths = "member")
    List<Order> findAllByStatus(OrderStatus status);
}

@Service
@RequiredArgsConstructor
public class OrderQueryService {

    private final OrderRepository orderRepository;

    @Transactional(readOnly = true)
    public OrderResponse findResponse(Long id) {
        Order order = orderRepository.findWithMemberById(id).orElseThrow();
        return new OrderResponse(order.getId(), order.getMember().getName(), order.getAmount());
    }

    @Transactional(readOnly = true)
    public List<OrderResponse> findAll(OrderStatus status) {
        return orderRepository.findAllByStatus(status).stream()
                .map(o -> new OrderResponse(o.getId(), o.getMember().getName(), o.getAmount()))
                .toList();
    }
}
```

```yaml
spring:
  jpa:
    open-in-view: false
    properties:
      hibernate:
        default_batch_fetch_size: 100
```

## 실무에서 걸리는 지점

- **N+1은 로그에서만 보인다.** 주문 100건을 조회한 뒤 반복문에서 `getMember()`를 읽으면 SELECT가 1 + 100번 나간다. 테스트 데이터가 적으면 드러나지 않으므로 SQL 로그로 쿼리 수를 확인해야 한다. Fetch Join 또는 `@EntityGraph`로 명시하고, 놓친 경로를 위해 `default_batch_fetch_size`를 전역으로 두어 프록시 초기화가 IN 쿼리로 묶이게 하는 조합이 기본 대응이다.

- **컬렉션 Fetch Join의 한계.** `@OneToMany`를 Fetch Join하면서 `Pageable`을 붙이면 Hibernate가 전체를 메모리로 가져와 페이징하는 경고를 내고, 컬렉션 두 개 이상을 동시에 Fetch Join하면 `MultipleBagFetchException`이 발생한다. 컬렉션은 `default_batch_fetch_size`에 맡기는 편이 안전하다.

- **open-in-view 기본값은 true다.** Spring Boot는 HTTP 응답이 끝날 때까지 컨텍스트를 열어두는 인터셉터를 기본 등록한다. 예외는 사라지지만 직렬화 중에 쿼리가 나가고 DB 커넥션이 요청 전체 시간 동안 점유된다. 운영에서는 `open-in-view: false`로 끄고 조회 서비스에서 DTO 변환까지 끝낸다.

- **의도하지 않은 변경 감지.** 트랜잭션 안에서 계산용으로 Entity 필드를 바꾸면 그대로 UPDATE가 나간다. Entity에 무분별한 setter를 두지 않고, 읽기 전용 경로는 `@Transactional(readOnly = true)`로 선언해 플러시를 막는다.

- **양방향 연관관계의 직렬화 순환.** `Order.member`와 `Member.orders`가 서로를 참조하는 Entity를 그대로 JSON으로 반환하면 Jackson이 무한 재귀에 빠지고 프록시 필드에서 직렬화 예외가 난다. `@JsonIgnore`는 임시 조치이며 응답은 항상 DTO로 변환한다.

## 관련 글

- [JPA·Hibernate·Spring Data JPA — Entity와 Repository](/notes/java-spring/jpa-hibernate-spring-data/)
- [연관관계·N+1·값 객체](/notes/java-spring/jpa-relations-n-plus-1/)
- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
