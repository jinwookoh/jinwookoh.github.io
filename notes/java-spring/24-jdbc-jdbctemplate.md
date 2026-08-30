---
title: "JDBC·DataSource·JdbcTemplate"
series: java-spring
part: "데이터"
order: 24
summary: "JDBC 표준 위에 DataSource로 커넥션을 풀링하고 JdbcTemplate으로 보일러플레이트와 예외를 제거하는 구조"
tags: [JDBC, DataSource, HikariCP, JdbcTemplate, RowMapper]
sources: [spring/2026-05-16-jdbc-datasource.md, spring/2026-05-16-jdbc-template.md]
updated: 2026-08-29
---

자바 코드가 DB 벤더의 프로토콜에 직접 의존하면 DB를 바꿀 때 데이터 접근 코드를 전부 다시 써야 한다. 매 요청마다 새 물리 커넥션을 열면 TCP 연결과 인증 비용(수십~수백 ms)이 응답 시간에 그대로 더해진다. 여기에 `Connection`·`PreparedStatement`·`ResultSet` 정리와 체크드 예외 `SQLException` 처리가 쿼리마다 반복되면 SQL 한 줄보다 부수 코드가 훨씬 많아진다. ==JDBC 표준, DataSource 기반 커넥션 풀, JdbcTemplate은 이 세 문제를 각각 담당하는 계층이다.==

## 핵심 개념

**JDBC**는 `java.sql` 패키지의 표준 API다. 애플리케이션은 `Connection`·`Statement`·`ResultSet` 인터페이스만 사용하고, 벤더별 **JDBC 드라이버**가 실제 통신을 맡는다. 드라이버 jar가 클래스패스에 있으면 자동 등록되며, PostgreSQL `org.postgresql:postgresql`, MySQL `com.mysql:mysql-connector-j` 등의 버전은 Spring Boot가 관리한다.

**DriverManager**는 호출마다 새 물리 커넥션을 만든다. **DataSource**(`javax.sql.DataSource`)는 커넥션을 얻는 방법을 구현체에 위임하는 인터페이스이고, 실무 구현체는 **커넥션 풀**이다. 풀은 기동 시 커넥션을 미리 만들어 `getConnection()` 에 대여하고, `close()` 는 실제로 닫지 않고 반납한다. Spring Boot는 2.0부터 **HikariCP**를 기본 풀로 쓰며, `spring.datasource.url`·`username`·`password` 만 있으면 자동 구성이 `HikariDataSource` 와 `JdbcTemplate`·`NamedParameterJdbcTemplate` Bean을 등록한다.

**JdbcTemplate**은 DataSource를 감싸 커넥션 획득·Statement 생성·ResultSet 순회·자원 반납·예외 변환을 대신 수행한다. 개발자는 SQL, 바인딩 파라미터, 한 행을 객체로 바꾸는 **RowMapper** 만 제공한다.

| 메서드 | 용도 | 반환 |
|---|---|---|
| `queryForObject` | 정확히 1건 조회 | 객체 1개. 0건이면 `EmptyResultDataAccessException` |
| `query` | 다건 조회 | `List<T>` |
| `update` | INSERT·UPDATE·DELETE | 영향받은 행 수 |
| `batchUpdate` | 대량 변경 | 행 수 배열 |

컬럼명과 필드명이 일치하면 `BeanPropertyRowMapper` 가 snake_case를 camelCase로 바꿔 자동 매핑한다. 기본 생성자와 setter가 필요하므로 record 같은 불변 객체에는 생성자 기반 `DataClassRowMapper` 를 쓴다. `NamedParameterJdbcTemplate` 은 `?` 대신 `:name` 파라미터를 받고 `IN (:ids)` 에 컬렉션을 확장한다. `SimpleJdbcInsert` 는 테이블명과 컬럼 Map만으로 INSERT를 만들고 생성 키를 돌려준다.

예외는 `SQLException` 이 `DataAccessException` 계층의 런타임 예외로 변환되며, 벤더별 에러 코드가 `DuplicateKeyException` 같은 공통 타입으로 매핑되어 DB를 바꿔도 catch 절은 그대로다.

## 코드

Spring Boot 설정. HikariCP 항목은 선택이며 기본값으로도 동작한다.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/myshop
    username: postgres
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 10
      connection-timeout: 30000
      max-lifetime: 1800000
      leak-detection-threshold: 60000
```

record 도메인과 `DataClassRowMapper` 를 쓰는 Repository. 0건 예외를 `Optional` 로 흡수한다.

```java
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.DataClassRowMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

public record Order(Long id, Long productId, int amount, String status, LocalDateTime createdAt) {}

@Repository
public class JdbcOrderRepository {

    private static final RowMapper<Order> MAPPER = new DataClassRowMapper<>(Order.class);

    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate namedJdbc;

    public JdbcOrderRepository(JdbcTemplate jdbc, NamedParameterJdbcTemplate namedJdbc) {
        this.jdbc = jdbc;
        this.namedJdbc = namedJdbc;
    }

    public Optional<Order> findById(Long id) {
        try {
            return Optional.of(jdbc.queryForObject(
                    "SELECT id, product_id, amount, status, created_at FROM orders WHERE id = ?",
                    MAPPER, id));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<Order> findByIds(List<Long> ids) {
        return namedJdbc.query(
                "SELECT id, product_id, amount, status, created_at FROM orders WHERE id IN (:ids)",
                Map.of("ids", ids), MAPPER);
    }

    public int updateStatus(Long id, String status) {
        return jdbc.update("UPDATE orders SET status = ? WHERE id = ?", status, id);
    }
}
```

`SimpleJdbcInsert` 로 자동 생성 키를 받는 저장과 `batchUpdate` 대량 INSERT.

```java
import javax.sql.DataSource;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;

public class OrderWriter {

    private final SimpleJdbcInsert insert;
    private final JdbcTemplate jdbc;

    public OrderWriter(DataSource dataSource, JdbcTemplate jdbc) {
        this.insert = new SimpleJdbcInsert(dataSource)
                .withTableName("orders")
                .usingGeneratedKeyColumns("id");
        this.jdbc = jdbc;
    }

    public long save(Long productId, int amount) {
        Number key = insert.executeAndReturnKey(
                Map.of("product_id", productId, "amount", amount, "status", "CREATED"));
        return key.longValue();
    }

    public int[] saveAll(List<Order> orders) {
        return jdbc.batchUpdate(
                "INSERT INTO orders (product_id, amount, status) VALUES (?, ?, ?)",
                orders.stream()
                        .map(o -> new Object[]{o.productId(), o.amount(), o.status()})
                        .toList());
    }
}
```

## 실무에서 걸리는 지점

- ==**풀 크기는 크게 잡을수록 손해다.** DB가 동시에 실행할 수 있는 쿼리 수는 코어 수에 묶이므로 커넥션을 늘리면 경합만 늘어난다.== 10개 전후에서 시작해 `hikaricp.connections.pending` 메트릭을 보며 조정하고, 인스턴스 수 × 풀 크기가 DB `max_connections` 를 넘지 않게 한다.
- **커넥션 누수는 풀 고갈로 나타난다.** 직접 얻은 커넥션의 반납을 빠뜨리면 `connection-timeout` 이후 `SQLTransientConnectionException` 이 발생한다. `leak-detection-threshold` 를 켜면 임계 시간을 넘긴 대여의 스택 트레이스가 로그에 남는다.
- **`max-lifetime` 은 DB·프록시의 유휴 종료 시간보다 짧아야 한다.** 그렇지 않으면 이미 끊긴 커넥션을 빌려 첫 쿼리에서 실패한다.
- ==**`queryForObject` 의 0건은 null이 아니라 예외다.**== `Optional` 로 감싸려면 `EmptyResultDataAccessException` 을 잡거나 `query()` 로 리스트를 받아 첫 요소를 취한다.
- **JPA와의 역할 분담.** 단순 CRUD는 JPA, 통계·복잡한 조인·대량 배치는 JdbcTemplate이 맞다. 한 트랜잭션에서 섞어 쓸 수 있지만 영속성 컨텍스트의 미반영 변경이 JdbcTemplate 쿼리에 보이지 않는 점은 주의한다.

## 관련 글

- [@Transactional 원리와 낙관/비관 락](/notes/java-spring/transactional-locking/)
- [JPA·Hibernate·Spring Data JPA — Entity와 Repository](/notes/java-spring/jpa-hibernate-spring-data/)
- [테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway](/notes/java-spring/testing-mockmvc-testcontainers/)
