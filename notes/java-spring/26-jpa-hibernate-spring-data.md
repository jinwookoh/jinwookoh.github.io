---
title: "JPA·Hibernate·Spring Data JPA — Entity와 Repository"
series: java-spring
part: "데이터"
order: 26
summary: "JPA는 표준, Hibernate는 구현체, Spring Data JPA는 Repository 추상화이며 코드의 두 축은 @Entity와 JpaRepository다."
tags: [JPA, Hibernate, Spring Data JPA, Entity, JpaRepository]
sources: [spring/2026-05-16-jpa-hibernate-spring-data.md, spring/2026-05-16-entity-repository.md, 2026-05-02-spring-data-jpa.md]
updated: 2026-08-29
---

JdbcTemplate만으로 데이터 접근 계층을 만들면 테이블마다 SQL 문자열, RowMapper, 객체 간 참조를 잇는 코드가 반복된다. 자바 객체는 참조·상속·컬렉션으로 그래프를 이루지만 관계형 DB는 테이블·행·외래 키의 평면 구조이므로 이 불일치를 매번 손으로 메워야 한다. 그 작업을 자동화하는 것이 ORM이고, 자바에서는 JPA·Hibernate·Spring Data JPA 세 층이 역할을 나눠 맡는다.

## 핵심 개념

**JPA(Jakarta Persistence API)** 는 자바 ORM의 표준 규격이다. 2006년 Java EE 5에서 시작해 현재는 Jakarta EE 산하이며 패키지는 `jakarta.persistence.*`다. `@Entity`·`@Id`·`@Column` 같은 어노테이션과 `EntityManager` 인터페이스만 정의하고, SQL 생성이나 캐싱 방식은 정의하지 않는다.

**Hibernate** 는 JPA 표준의 구현체다. 2001년에 JPA보다 먼저 등장했고 JPA 표준이 Hibernate를 모델로 설계되었다. SQL 생성·실행·결과 매핑·1차 캐시를 실제로 처리한다. EclipseLink 같은 다른 구현체도 있지만 Spring Boot의 기본은 Hibernate다.

**Spring Data JPA** 는 JPA 위에 얹힌 Spring의 추상화 계층이다. `JpaRepository`를 상속한 인터페이스만 선언하면 시작 시점에 프록시 구현체를 만들어 Bean으로 등록하고, 기본 CRUD와 메서드 이름 기반 쿼리를 제공한다. JPA 구현체가 아니며 내부에서 `EntityManager`를 호출한다. 층을 위에서부터 나열하면 Spring Data JPA → JPA → Hibernate → JDBC/DataSource → DB이고, `spring-boot-starter-data-jpa` 하나에 세 층이 모두 포함된다.

### Entity

`@Entity`가 붙은 클래스는 JPA 관리 대상이 되고 인스턴스 하나가 행 하나에 대응한다. 조건은 세 가지다. `@Entity` 선언, JPA가 리플렉션으로 객체를 만들 때 쓰는 인자 없는 생성자, `@Id` 식별자 필드다. `@Table`은 클래스명과 테이블명이 다를 때, `@Column`은 컬럼명·`nullable`·`length`·`unique`·`updatable`을 지정한다.

`@GeneratedValue` 전략은 `IDENTITY`(AUTO_INCREMENT 위임), `SEQUENCE`(DB 시퀀스), `TABLE`(별도 키 테이블), `AUTO`(방언에 따라 선택), 그리고 JPA 3.1에 추가된 `UUID` 다섯 가지다. MySQL은 시퀀스가 없어 `IDENTITY` 또는 `UUID`를 쓰고, PostgreSQL·Oracle은 `SEQUENCE`가 배치 INSERT에 유리하다.

### Repository

Spring Data 3.x의 `JpaRepository<T, ID>`는 `ListCrudRepository`와 `ListPagingAndSortingRepository`를 상속하고 `flush()`·`saveAndFlush()`·`deleteAllInBatch()` 같은 JPA 특화 메서드를 더한다. 3.x부터 `PagingAndSortingRepository`는 `CrudRepository`를 상속하지 않으므로 페이징과 CRUD를 함께 쓰려면 `JpaRepository`를 상속한다.

`save()`는 식별자가 없는 새 객체면 `persist`, 식별자가 있는 준영속 객체면 `merge`를 호출한다. 영속 상태의 Entity는 커밋 시 변경 감지로 UPDATE가 나가므로 `save()`를 다시 부를 필요가 없다. `@Repository`는 필수가 아니며 컴포넌트 스캔 범위 안의 하위 인터페이스는 자동으로 Bean이 된다.

## 코드

의존성과 JPA 설정이다. `ddl-auto`는 운영에서 `validate` 또는 `none`으로 두고 스키마 변경은 Flyway·Liquibase로 관리한다.

```groovy
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    runtimeOnly 'org.postgresql:postgresql'
}
```

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
    properties:
      hibernate:
        default_batch_fetch_size: 100
```

`orders` 테이블에 매핑되는 Entity다. 생성자는 protected로 제한하고 상태 변경은 의미 있는 메서드로 노출한다.

```java
import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "orders")
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "product_id", nullable = false)
    private Long productId;

    @Column(nullable = false)
    private int amount;

    @Enumerated(EnumType.STRING)
    @Column(length = 20, nullable = false)
    private OrderStatus status;

    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    protected Order() {}

    public Order(Long productId, int amount) {
        this.productId = productId;
        this.amount = amount;
        this.status = OrderStatus.CREATED;
        this.createdAt = LocalDateTime.now();
    }

    public void cancel() {
        this.status = OrderStatus.CANCELLED;
    }

    public Long getId() { return id; }
    public Long getProductId() { return productId; }
    public int getAmount() { return amount; }
    public OrderStatus getStatus() { return status; }

    @Override
    public boolean equals(Object o) {
        return o instanceof Order other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() { return getClass().hashCode(); }
}
```

Repository 인터페이스와 서비스다. 서비스는 Entity를 밖으로 내보내지 않고 record DTO로 변환해 반환한다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByStatus(OrderStatus status);
}

public record OrderResponse(Long id, Long productId, int amount, OrderStatus status) {
    static OrderResponse from(Order o) {
        return new OrderResponse(o.getId(), o.getProductId(), o.getAmount(), o.getStatus());
    }
}

@Service
@Transactional(readOnly = true)
public class OrderService {

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public OrderResponse find(Long id) {
        return orderRepository.findById(id)
                .map(OrderResponse::from)
                .orElseThrow(() -> new NoSuchElementException("order " + id));
    }

    @Transactional
    public OrderResponse create(Long productId, int amount) {
        return OrderResponse.from(orderRepository.save(new Order(productId, amount)));
    }

    @Transactional
    public void cancel(Long id) {
        orderRepository.findById(id).orElseThrow().cancel();
    }
}
```

## 실무에서 걸리는 지점

- **`ddl-auto: update`를 운영에 남기는 실수.** Entity 필드 추가가 곧바로 운영 DB의 ALTER TABLE로 이어지고, 컬럼 삭제·타입 변경은 반영되지 않아 스키마가 서서히 어긋난다.
- **`@Enumerated` 기본값은 `ORDINAL`이다.** enum 순서 번호가 저장되므로 상수 사이에 값을 끼워 넣으면 기존 데이터의 의미가 바뀐다. enum 필드는 항상 `EnumType.STRING`을 명시한다.
- **Lombok `@Data`를 Entity에 쓰면 안 된다.** 전체 필드 기반 `equals`는 영속화 전후로 결과가 바뀌고 연관 필드가 섞이면 지연 로딩과 순환 호출을 유발한다. 식별자 기반으로 직접 구현하고 `hashCode`는 상수로 두어 id 부여 전후에도 `Set` 안에서 안정되게 한다.
- **Entity를 컨트롤러 응답으로 직접 반환하면** 트랜잭션 종료 후 Jackson이 지연 로딩 getter를 호출해 `LazyInitializationException`이 나고, 비밀번호 같은 내부 컬럼이 API에 노출된다. `open-in-view`를 `false`로 두고 서비스 안에서 DTO로 변환한다.

## 관련 글

- [JDBC·DataSource·JdbcTemplate](/notes/java-spring/jdbc-jdbctemplate/)
- [연관관계·N+1·값 객체](/notes/java-spring/jpa-relations-n-plus-1/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
