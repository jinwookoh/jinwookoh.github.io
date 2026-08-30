---
title: "DDL 깊이 — CREATE TABLE·파티션·제약·외래 키"
series: postgresql
part: "DDL과 DML"
order: 12
summary: "대용량 테이블은 파티션·IDENTITY·제약·외래 키를 DDL 단계에서 함께 설계해야 운영 중 다운타임 없이 무결성을 지킬 수 있다."
tags: [PostgreSQL, DDL, PARTITION, CONSTRAINT, FOREIGN KEY]
sources: [data-infra/2026-05-17-pg-ddl-overview.md, data-infra/2026-05-17-pg-ddl-create-table.md, data-infra/2026-05-17-pg-ddl-constraints.md, data-infra/2026-05-17-pg-foreign-key.md]
updated: 2026-08-29
---

컬럼 이름과 타입만 나열해 테이블을 만들면 데이터가 수천만 행을 넘기는 순간 문제가 드러난다. 오래된 로그를 지우는 DELETE가 몇 시간을 돌고, 외래 키 없는 주문 테이블에는 고아 행이 쌓이며, 애플리케이션 검증만 믿던 가격 컬럼에 음수가 들어간다. 뒤늦게 제약을 추가하면 전체 검증 락이 걸려 서비스가 멈춘다. 파티션·제약·외래 키를 DDL 단계에서 함께 설계하면 이 비용을 대부분 피할 수 있다.

## 핵심 개념

==PostgreSQL은 DDL이 트랜잭션 안에서 동작한다.== ALTER TABLE과 CREATE INDEX를 하나의 BEGIN·COMMIT으로 묶고 실패 시 ROLLBACK할 수 있다는 점이 일부 DDL이 암묵 커밋되는 MySQL과의 차이다.

### 기본 키 생성 — IDENTITY

자동 증가 정수는 `BIGSERIAL`과 `GENERATED ... AS IDENTITY`로 만든다. BIGSERIAL은 시퀀스를 별도 객체로 노출하는 PostgreSQL 고유 방식이고, IDENTITY는 SQL 표준으로 시퀀스가 컬럼에 종속된다. `ALWAYS`는 직접 값을 넣을 때 `OVERRIDING SYSTEM VALUE`를 요구하고, `BY DEFAULT`는 명시한 값을 받는다. 신규 스키마는 IDENTITY로 통일한다.

### 파티션 테이블

대용량 테이블은 하나의 논리 테이블을 여러 물리 파티션으로 나눈다.

| 방식 | 기준 | 적합한 데이터 |
|---|---|---|
| RANGE | 연속 값의 구간 | 시계열 로그·주문·이벤트 |
| LIST | 열거된 값 | 국가·카테고리 |
| HASH | 해시 나머지 | 균등 분산이 필요한 경우 |

시간 기준 RANGE가 가장 흔하다. WHERE 절에 파티션 키가 있으면 해당 파티션만 스캔하고, 오래된 데이터는 `DROP TABLE`이나 `DETACH PARTITION` 한 문장으로 제거한다. 단 PRIMARY KEY와 UNIQUE는 파티션 키를 반드시 포함해야 한다.

### UNLOGGED·TEMPORARY·복제 생성

`UNLOGGED TABLE`은 WAL을 기록하지 않아 쓰기가 빠르지만 크래시 시 내용이 비워지고 복제도 되지 않는다. `TEMPORARY TABLE`은 현재 세션에서만 보이고 세션 종료 시 사라진다. `CREATE TABLE ... AS SELECT`는 제약·인덱스를 복사하지 않으므로 구조 복제에는 `LIKE t1 INCLUDING ALL`을 쓴다.

### 제약

제약은 NOT NULL·UNIQUE·PRIMARY KEY·FOREIGN KEY·CHECK·EXCLUDE 여섯 가지다. CHECK는 한 행 안의 조건을 검증하며 IMMUTABLE 또는 STABLE 함수만 허용된다. 다른 행이나 테이블을 참조하는 검증은 트리거로 구현한다. EXCLUDE는 PostgreSQL 고유 제약으로, 같은 방에 기간이 겹치는 예약처럼 "겹치는 범위 금지"를 GiST 인덱스로 강제하며 등호 비교에는 `btree_gist` 확장이 필요하다.

DEFERRABLE은 검증 시점을 커밋 시점으로 미룬다. `NOT DEFERRABLE`이 기본이며 문장마다 검증하고, `DEFERRABLE INITIALLY IMMEDIATE`는 `SET CONSTRAINTS ALL DEFERRED`로 지연할 수 있으며, `INITIALLY DEFERRED`는 처음부터 커밋 시점에 검증한다. 서로를 참조하는 두 테이블에 함께 INSERT하는 순환 참조 처리에 필요하다.

### 외래 키

외래 키는 자식 테이블의 값이 부모 테이블에 존재함을 DB가 보장한다. 부모 삭제 시 동작은 ON DELETE로 정한다. `NO ACTION`이 기본으로 자식이 있으면 삭제를 거부하며 지연 검증이 가능하고, `RESTRICT`는 같은 거부지만 즉시 검증한다. `CASCADE`는 자식을 함께 삭제하고, `SET NULL`은 자식 컬럼을 NULL로 바꾸며(NOT NULL 컬럼에는 사용 불가), `SET DEFAULT`는 기본값으로 바꾼다. ==외래 키 컬럼에는 인덱스가 자동 생성되지 않는다.==

큰 테이블에 제약을 사후 추가할 때는 `NOT VALID`로 새 행에만 즉시 적용한 뒤 `VALIDATE CONSTRAINT`로 기존 행을 검증한다.

## 코드

월별 RANGE 파티션 주문 테이블. 파티션 키를 포함한 복합 기본 키·IDENTITY·CHECK·외래 키·외래 키 인덱스를 함께 선언한다.

```sql
CREATE TABLE orders (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    user_id     BIGINT NOT NULL,
    amount      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at),
    CONSTRAINT chk_orders_amount CHECK (amount >= 0),
    CONSTRAINT chk_orders_status
        CHECK (status IN ('PENDING', 'PAID', 'SHIPPED', 'CANCELED')),
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE NO ACTION
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2026_08 PARTITION OF orders
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE orders_2026_09 PARTITION OF orders
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE INDEX idx_orders_user_id ON orders (user_id);
```

EXCLUDE로 예약 기간 겹침을 막고, 큰 테이블에 CHECK를 무중단으로 추가한다.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE bookings (
    id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id  BIGINT NOT NULL,
    period   TSTZRANGE NOT NULL,
    canceled BOOLEAN NOT NULL DEFAULT false,
    EXCLUDE USING GIST (room_id WITH =, period WITH &&)
        WHERE (NOT canceled)
);

ALTER TABLE products
    ADD CONSTRAINT chk_products_price CHECK (price >= 0) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT chk_products_price;
```

JPA 엔티티의 외래 키 매핑. `@Min` 같은 Bean Validation은 DB CHECK로 생성되지 않으므로 DDL은 별도로 관리한다.

```java
import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import org.hibernate.annotations.OnDelete;
import org.hibernate.annotations.OnDeleteAction;

@Entity
@Table(name = "orders",
       indexes = @Index(name = "idx_orders_user_id", columnList = "user_id"))
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false,
                foreignKey = @ForeignKey(name = "fk_orders_user"))
    @OnDelete(action = OnDeleteAction.NO_ACTION)
    private User user;

    @Min(0)
    @Column(nullable = false)
    private Integer amount;

    protected Order() {}
}
```

## 실무에서 걸리는 지점

- **파티션 키 없는 유니크 제약.** 파티션 테이블의 PRIMARY KEY·UNIQUE는 파티션 키를 포함해야 하므로 `id` 단독 유일성을 DB가 보장하지 못한다. 전역 유일성은 IDENTITY 시퀀스나 애플리케이션 발급 UUID에 의존한다.
- **외래 키 컬럼 인덱스 누락.** 부모 행을 삭제할 때마다 자식 테이블을 풀스캔하며 큰 테이블에서는 락과 실행 시간이 폭주한다. 외래 키를 선언하면 인덱스를 같이 만든다.
- **CASCADE 남용.** 사용자 한 명을 지웠는데 주문 수만 건이 사라지는 사고는 대부분 ON DELETE CASCADE에서 나온다. order_items처럼 부모 없이 의미가 없는 의존 객체에만 쓴다.
- **UNLOGGED를 운영 데이터에 사용.** 크래시 한 번으로 테이블 전체가 비워지고, 복제본에도 전달되지 않는다.
- **운영 테이블에 제약 직접 추가.** ==`ADD CONSTRAINT`는 기존 행 전체를 검증하는 동안 ACCESS EXCLUSIVE 락을 잡는다.== NOT VALID 후 VALIDATE CONSTRAINT는 SHARE UPDATE EXCLUSIVE 락만 잡아 읽기·쓰기가 계속된다.

## 관련 글

- [파티셔닝과 샤딩](/notes/postgresql/partitioning-sharding/)
- [데이터베이스와 테이블 만들기](/notes/postgresql/create-database-table/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
