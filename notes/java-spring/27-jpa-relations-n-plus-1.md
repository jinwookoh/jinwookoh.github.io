---
title: "연관관계·N+1·값 객체"
series: java-spring
part: "데이터"
order: 27
summary: "외래 키를 가진 쪽이 연관관계의 주인이며, 모든 관계를 LAZY로 두고 Fetch Join으로 N+1을 끊고, 식별자 없는 값은 @Embeddable로 묶는다."
tags: [JPA, Hibernate, N+1, Fetch Join, Embeddable]
sources: [spring/2026-05-17-jpa-relations.md, spring/2026-05-17-jpa-embedded-embeddable.md, 2026-05-02-spring-jpa-relationships.md]
updated: 2026-08-29
---

고객은 여러 주문을 가지고, 주문은 여러 항목을 담으며, 주문에는 주소와 금액이 붙는다. 이 구조를 외래 키 컬럼과 개별 필드로만 표현하면 서비스 코드가 ID를 들고 반복 조회를 하고, 연관 객체의 로딩 시점이 드러나지 않아 목록 화면 하나에 SQL이 수백 번 나가는 N+1이 생기며, 주소·금액 필드가 엔티티마다 흩어져 검증·계산 로직이 중복된다. ==연관관계 매핑, 페치 전략, `@Embeddable` 값 객체가 이 세 문제를 각각 맡는다.==

## 핵심 개념

### 네 가지 연관관계와 주인

JPA는 관계를 `@ManyToOne`·`@OneToMany`·`@OneToOne`·`@ManyToMany`로 분류한다. 외래 키 컬럼 하나가 `@ManyToOne` 필드 하나에 대응하므로 실무에서 가장 자주 쓰는 것은 `@ManyToOne`이다.

양방향으로 매핑해도 데이터베이스의 외래 키는 한 곳에만 있다. 그래서 JPA는 **연관관계의 주인(owning side)** 을 정한다. 외래 키를 가진 쪽이 주인이며 `@JoinColumn`으로 컬럼명을 지정하고, 반대편은 `mappedBy`로 주인 필드명을 가리키는 읽기 전용이다. 주인이 아닌 쪽 컬렉션에 객체를 추가해도 SQL은 나가지 않으므로, 양방향일 때는 두 참조를 한 번에 맞추는 편의 메서드를 엔티티에 둔다.

단방향이 기본이다. 양방향은 반대편 컬렉션을 실제로 탐색해야 할 때만 추가한다. JSON 직렬화 순환과 동기화 누락이 양방향의 대가다.

`@ManyToMany`는 조인 테이블을 자동 관리하지만 가입일·역할 같은 추가 컬럼을 둘 수 없다. 중간 엔티티를 만들고 양쪽에 `@ManyToOne`을 두는 방식으로 푼다.

### 페치 전략과 N+1

| 어노테이션 | 기본 FetchType | 위험 |
|---|---|---|
| `@ManyToOne`, `@OneToOne` | EAGER | 사용하지 않는 연관 객체까지 매번 조인 |
| `@OneToMany`, `@ManyToMany` | LAZY | 컬렉션 접근 시 행마다 추가 쿼리 |

N+1은 부모 N건을 한 번에 조회한 뒤 각 부모의 연관 객체에 접근할 때 N번의 SELECT가 추가로 나가는 현상이다. EAGER는 해결책이 아니다. JPQL로 목록을 조회하면 EAGER 연관마다 별도 쿼리가 나가 숨은 N+1이 된다. 정석은 모든 연관관계를 `FetchType.LAZY`로 명시하고, 함께 필요한 연관 객체만 조회 시점에 `JOIN FETCH` 또는 `@EntityGraph`로 한 번의 조인에 끌어오는 것이다.

### Cascade와 orphanRemoval

`cascade`는 부모의 영속성 작업을 자식에게 전파한다. `CascadeType.ALL`은 `PERSIST`·`MERGE`·`REMOVE`·`REFRESH`·`DETACH` 전부를 포함하며, `REMOVE`는 부모 삭제 시 자식 전부를 지운다. `orphanRemoval = true`는 부모 컬렉션에서 빠진 자식을 DELETE한다. 둘 다 주문–주문항목처럼 부모 없이는 자식이 의미가 없는 소유 관계에만 붙인다. 고객–주문에 `ALL`을 붙이면 고객 정리 한 번에 과거 주문 이력이 사라진다.

### 값 객체 — @Embeddable

식별자가 의미를 갖는 것이 엔티티이고, 필드 값이 같으면 같은 것으로 취급되는 것이 값 객체다. 주소·금액·기간·이메일이 대표적이다. `@Embeddable` 클래스를 엔티티에 `@Embedded`로 두면 조인 없이 값 객체의 필드가 엔티티 테이블 컬럼으로 펼쳐진다. 같은 값 객체를 두 번 쓰면 컬럼명이 충돌하므로 `@AttributeOverride`로 재정의한다. 값 객체는 불변으로 설계하고, 모든 필드 기반 `equals`/`hashCode`와 도메인 메서드를 갖춰야 데이터 묶음 이상의 의미를 가진다.

## 코드

주문–주문항목 소유 관계. 연관관계는 LAZY로 명시하고, 양쪽 참조를 편의 메서드 하나로 맞춘다.

```java
import jakarta.persistence.*;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    @Embedded
    @AttributeOverride(name = "amount", column = @Column(name = "total_amount"))
    @AttributeOverride(name = "currency", column = @Column(name = "total_currency"))
    private Money total = Money.zero("KRW");

    protected Order() {}

    public Order(Customer customer) {
        this.customer = customer;
    }

    public void addItem(Product product, int quantity) {
        OrderItem item = new OrderItem(this, product, quantity);
        items.add(item);
        total = total.add(product.getPrice().multiply(quantity));
    }

    @Override
    public boolean equals(Object o) {
        return this == o || (o instanceof Order other && id != null && id.equals(other.id));
    }

    @Override
    public int hashCode() {
        return getClass().hashCode();
    }
}

@Entity
@Table(name = "order_items")
public class OrderItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;

    private int quantity;

    protected OrderItem() {}

    OrderItem(Order order, Product product, int quantity) {
        this.order = order;
        this.product = product;
        this.quantity = quantity;
    }
}
```

불변 값 객체. 기본 생성자는 Hibernate 리플렉션용으로 `protected`로 두고, 비교는 모든 필드 값으로 한다.

```java
import jakarta.persistence.Embeddable;
import java.util.Objects;

@Embeddable
public class Money {

    private long amount;
    private String currency;

    protected Money() {}

    public Money(long amount, String currency) {
        if (amount < 0) throw new IllegalArgumentException("amount must be >= 0");
        this.amount = amount;
        this.currency = Objects.requireNonNull(currency);
    }

    public static Money zero(String currency) {
        return new Money(0, currency);
    }

    public Money add(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("currency mismatch");
        }
        return new Money(amount + other.amount, currency);
    }

    public Money multiply(int factor) {
        return new Money(amount * factor, currency);
    }

    public long amount() { return amount; }
    public String currency() { return currency; }

    @Override
    public boolean equals(Object o) {
        return o instanceof Money m && amount == m.amount && currency.equals(m.currency);
    }

    @Override
    public int hashCode() {
        return Objects.hash(amount, currency);
    }
}
```

N+1 회피. 목록은 `@EntityGraph`, 단건 상세는 `JOIN FETCH`로 필요한 연관만 한 번에 가져온다.

```java
import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;
import java.util.List;
import java.util.Optional;

public interface OrderRepository extends JpaRepository<Order, Long> {

    @EntityGraph(attributePaths = {"customer"})
    List<Order> findAllByCustomerId(Long customerId);

    @Query("""
            select distinct o from Order o
            join fetch o.items i
            join fetch i.product
            where o.id = :id
            """)
    Optional<Order> findByIdWithItems(@Param("id") Long id);
}
```

## 실무에서 걸리는 지점

- ==**컬렉션 Fetch Join과 페이징을 함께 쓰면 메모리 페이징이 일어난다.**== Hibernate는 `HHH90003004` 경고를 남기고 전체 결과를 메모리에 올린 뒤 잘라낸다. 컬렉션은 `hibernate.default_batch_fetch_size`로 IN 쿼리 묶음 로딩을 하고, Fetch Join은 `@ManyToOne` 방향에만 쓴다.
- **`CascadeType.REMOVE`와 `orphanRemoval`은 자식 행을 한 건씩 DELETE한다.** 자식이 수천 건이면 그만큼의 DELETE 문이 나간다. 대량 삭제는 `@Modifying` 벌크 JPQL이나 DB의 `ON DELETE CASCADE`로 처리한다.
- **Lombok `@Data`·`@ToString`을 엔티티에 붙이면 양방향 관계에서 `StackOverflowError`가 난다.** `equals`는 ID 기반으로 직접 구현하고, `hashCode`는 영속화 전후로 ID가 바뀌어도 `Set` 버킷이 유지되도록 클래스 상수로 둔다.
- ==**트랜잭션 밖에서 LAZY 컬렉션에 접근하면 `LazyInitializationException`이 난다.**== `spring.jpa.open-in-view=true` 기본값이 이를 감추지만 뷰 렌더링까지 커넥션을 붙잡는다. OSIV를 끄고 서비스 계층 안에서 DTO로 변환해 반환한다.

## 관련 글

- [JPA·Hibernate·Spring Data JPA — Entity와 Repository](/notes/java-spring/jpa-hibernate-spring-data/)
- [쿼리 — 메서드 이름·@Query·QueryDSL·Auditing](/notes/java-spring/jpa-queries-querydsl-auditing/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
