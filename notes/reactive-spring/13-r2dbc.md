---
title: "R2DBC — 리액티브 DB 연동과 JPA 비교"
series: reactive-spring
part: "리액티브 데이터"
order: 13
summary: "WebFlux 이벤트 루프를 막지 않는 DB 접근 방법과, JPA에서 사라지는 것·얻는 것의 경계를 정리한다"
tags: [R2DBC, Spring Data R2DBC, JPA, Backpressure, WebFlux]
sources: [2026-05-03-webflux-r2dbc.md, 2026-05-03-webflux-r2dbc-vs-jpa.md]
updated: 2026-08-29
---

WebFlux로 웹 계층을 논블로킹으로 만들어도 데이터 접근이 JDBC라면 이벤트 루프가 DB 응답을 기다리며 멈춘다. JDBC는 호출 스레드가 결과를 받을 때까지 블로킹되고, 이벤트 루프 스레드는 수가 적어 요청 몇 개만 DB에서 대기해도 서버 전체 처리량이 무너진다. JPA를 별도 스레드 풀로 격리할 수 있지만 풀 크기가 곧 동시성 상한이 된다. R2DBC는 이 구간을 처음부터 논블로킹으로 설계한 드라이버 명세이며, Spring Data R2DBC는 그 위에 Repository·`@Query`·트랜잭션 같은 Spring Data 패턴을 얹는다.

## 핵심 개념

R2DBC(Reactive Relational Database Connectivity)는 관계형 DB에 대한 리액티브 드라이버 명세다. 모든 결과는 `Mono`/`Flux`로 돌아오고, 결과 행은 소비자가 요청한 만큼만 DB에서 흘러온다. 즉 Reactive Streams의 backpressure가 DB 커넥션 수준까지 이어진다. `findAll()`이 반환하는 `Flux`는 구독 전까지 실행되지 않으며, 구독 후에도 메모리에는 처리 중인 일부 행만 머문다. 그래서 1,000만 건을 200MB 힙으로 순회할 수 있고, 같은 작업을 JPA `findAll()`로 `List`에 담으면 힙을 4GB로 늘려도 OOM이 난다.

연결 URL은 `r2dbc:postgresql://host:5432/db` 형식이며 JDBC URL을 그대로 넣으면 연결에 실패한다. 의존성은 `spring-boot-starter-data-r2dbc`와 DB별 드라이버(`r2dbc-postgresql` 등)를 함께 둔다.

접근 계층은 세 단계다. `ReactiveCrudRepository`는 인터페이스 선언만으로 CRUD와 파생 쿼리 메서드를 제공한다. `@Query`는 고정된 JOIN·집계 SQL을 네임드 파라미터(`:name`)로 작성한다. `DatabaseClient`는 동적 SQL과 DTO 매핑용 저수준 API다.

트랜잭션은 `@Transactional`을 그대로 쓰되 반환 타입이 `Mono`/`Flux`여야 한다. Spring Boot가 `R2dbcTransactionManager`를 자동 구성하고, 상태는 ThreadLocal이 아니라 Reactor Context에 담긴다. 구독 시 시작, `onComplete`에 커밋, `onError`에 롤백된다.

JPA와의 차이는 다음으로 요약된다.

| 항목 | Spring Data JPA | Spring Data R2DBC |
|:---|:---|:---|
| 1차 캐시 | 있음 | 없음, 같은 ID도 매번 DB 조회 |
| Dirty Checking | 자동 UPDATE | 없음, `save()` 명시 호출 |
| 연관 매핑 | `@OneToMany` 등 | 없음, JOIN 직접 작성 |
| 낙관적 잠금 | `@Version` | `@Version` 동일하게 동작 |
| 비관적 잠금 | `@Lock` | `FOR UPDATE`를 SQL에 직접 작성 |
| 결과 소비 | `List`·`Optional` | `Flux`·`Mono`, 스트리밍 |

`@Id`는 필수지만 `@GeneratedValue`는 없다. `save()`는 id가 `null`이면 INSERT, 아니면 UPDATE로 동작하고, DB의 SERIAL이나 IDENTITY가 키를 채운다.

## 코드

엔티티와 Repository. JPA 관계 애노테이션은 붙여도 무시되므로 연관 데이터는 `@Query`로 조회한다.

```java
@Table("customer")
public class Customer {
    @Id
    private Integer id;
    private String name;
    private String email;
    @Version
    private Long version;
    // 기본 생성자, getter/setter 생략
}

public interface CustomerRepository extends ReactiveCrudRepository<Customer, Integer> {

    Flux<Customer> findByEmailEndingWith(String domain);

    @Query("""
        SELECT p.* FROM product p
        JOIN customer_order co ON p.id = co.product_id
        JOIN customer c ON c.id = co.customer_id
        WHERE c.name = :name
        """)
    Flux<Product> findProductsByCustomerName(String name);

    @Query("SELECT * FROM customer WHERE id = :id FOR UPDATE")
    Mono<Customer> findByIdForUpdate(Integer id);
}
```

수정과 트랜잭션. `save()`가 `Mono`를 반환하므로 `map`이 아니라 `flatMap`으로 잇고, 빈 결과는 `switchIfEmpty`로 처리한다.

```java
@Service
public class CustomerService {

    private final CustomerRepository customers;
    private final OrderRepository orders;

    public CustomerService(CustomerRepository customers, OrderRepository orders) {
        this.customers = customers;
        this.orders = orders;
    }

    public Mono<Customer> rename(Integer id, String newName) {
        return customers.findById(id)
                .switchIfEmpty(Mono.error(new CustomerNotFoundException(id)))
                .doOnNext(c -> c.setName(newName))
                .flatMap(customers::save);
    }

    @Transactional
    public Mono<Void> createWithOrder(Customer customer, Order order) {
        return customers.save(customer)
                .flatMap(saved -> {
                    order.setCustomerId(saved.getId());
                    return orders.save(order);
                })
                .then();
    }
}
```

`DatabaseClient`로 JOIN 결과를 DTO에 매핑한다. 파라미터는 `bind`로 넘겨 SQL 인젝션을 막는다.

```java
@Service
public class OrderQueryService {

    private final DatabaseClient client;

    public OrderQueryService(DatabaseClient client) {
        this.client = client;
    }

    public Flux<OrderDetails> findOrderDetails(String customerName) {
        return client.sql("""
                SELECT c.name AS customer_name, p.description, p.price,
                       co.amount, (p.price * co.amount) AS total_price
                FROM customer c
                JOIN customer_order co ON c.id = co.customer_id
                JOIN product p ON p.id = co.product_id
                WHERE c.name = :customerName
                ORDER BY total_price DESC
                """)
                .bind("customerName", customerName)
                .map((row, meta) -> new OrderDetails(
                        row.get("customer_name", String.class),
                        row.get("description", String.class),
                        row.get("price", Integer.class),
                        row.get("amount", Integer.class),
                        row.get("total_price", Integer.class)))
                .all();
    }
}
```

## 실무에서 걸리는 지점

- **처리량 이득은 동시성이 높을 때만 나타난다.** `findById` 10만 회를 동시성 256으로 돌린 측정에서 R2DBC는 약 2초, 256 스레드 풀의 JPA는 약 4초였다. 단일 요청 지연은 거의 같고, 낮은 동시성이나 CPU 집약 작업에서는 JPA가 단순하고 빠를 수 있다. JPA에 가상 스레드를 붙여도 짧은 DB I/O에서는 처리량이 거의 변하지 않는다.
- **Dirty Checking 부재는 설계 선택이다.** 변경 추적은 영속성 컨텍스트에 스냅샷을 유지해야 하므로 대용량 스트리밍과 양립하지 않는다. 대신 수정 후 `save()`를 빠뜨리면 아무 것도 저장되지 않고 어떤 경고도 없다.
- **N+1을 막아 주는 장치가 없다.** `Flux`를 순회하며 건마다 `findById`를 호출하면 그대로 N+1이 된다. 처음부터 JOIN으로 설계하거나 `IN` 절로 묶어 조회한 뒤 조립한다.
- **JPA를 병행해야 한다면 `boundedElastic`으로 격리한다.** `Mono.fromCallable(() -> jpaRepository.findById(id).orElse(null)).subscribeOn(Schedulers.boundedElastic())` 형태로 감싼다. `subscribeOn`을 빠뜨리면 이벤트 루프 스레드에서 블로킹이 실행되어 다른 요청을 막는다. 이 풀도 상한(CPU 코어 수 × 10)이 있으므로 임시 조치다.
- **트랜잭션 경계는 구독 흐름을 따른다.** `@Transactional` 메서드가 반환한 `Mono`를 구독하지 않고 버리면 트랜잭션이 시작조차 되지 않는다. JPA Repository와 함께 두는 경우 `@EnableR2dbcRepositories(basePackages = ...)`로 스캔 범위를 제한한다.

## 관련 글

- [Backpressure](/notes/reactive-spring/backpressure/)
- [Schedulers·스레딩·Context](/notes/reactive-spring/schedulers-context/)
- [리액티브 Redis — 연동·Template·자료구조](/notes/reactive-spring/reactive-redis-basics/)
