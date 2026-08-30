---
title: "INSERT 깊이 — Bulk·COPY·UPSERT"
series: postgresql
part: "DDL과 DML"
order: 13
summary: "단건·Bulk·COPY의 비용 차이와 ON CONFLICT·MERGE 기반 UPSERT를 대량 입력 운영 관점에서 정리한다."
tags: [PostgreSQL, INSERT, COPY, UPSERT, ON CONFLICT]
sources: [data-infra/2026-05-17-pg-dml-overview.md, data-infra/2026-05-17-pg-dml-insert.md]
updated: 2026-08-29
---

INSERT는 DML 네 동사 중 가장 단순하다. 옛 버전 행을 남기지 않으므로 MVCC 부담도 없다. 그런데도 대량 입력에서 병목이 되는 이유는 문장마다 붙는 고정 비용 때문이다. 단건 INSERT 한 번에는 네트워크 왕복, 파싱·계획, 트랜잭션 커밋, WAL fsync, 인덱스 갱신, 트리거 실행이 따라붙고, 10만 건을 반복문으로 넣으면 이 비용이 10만 번 반복된다. 여기에 중복 키 처리 방식을 정하지 않으면 동시 요청에서 UNIQUE 위반이 발생한다. 입력 방식과 충돌 처리 전략을 함께 설계해야 하는 이유다.

## 핵심 개념

### 세 가지 입력 방식

| 방식 | 10만 건 기준 | 비용이 줄어드는 지점 |
|---|---|---|
| 단건 INSERT 반복 | 약 10초 | 없음 — 모든 비용이 N번 |
| Bulk INSERT (1,000건씩) | 약 2초 | 파싱·계획·커밋·fsync가 chunk당 1회 |
| COPY | 약 0.5초 | SQL 파싱 생략, 별도 프로토콜, 페이지 단위 WAL |

Bulk INSERT는 `INSERT ... VALUES (...), (...), ...` 형태로 여러 행을 한 문장에 담는다. 파싱·계획이 한 번으로 끝나고 WAL 기록도 묶인다. ==chunk 크기는 1,000~5,000건이 적정하다.== 너무 크면 메모리와 계획 시간이 늘고, 너무 작으면 단건과 차이가 없다.

COPY는 SQL 파서를 거치지 않는 별도 프로토콜로 데이터를 받고, 인덱스·제약 검사를 일괄 처리하며 WAL을 페이지 단위로 기록한다. 서버 파일을 읽는 `COPY FROM`과 클라이언트 스트림을 보내는 `COPY FROM STDIN`이 있고, psql의 `\copy`는 후자를 감싼 명령이다. 애플리케이션에서는 PostgreSQL JDBC의 `CopyManager`로 STDIN 스트림을 직접 보낸다.

### UPSERT — 충돌 처리

`ON CONFLICT`는 INSERT가 UNIQUE 위반을 만났을 때의 동작을 지정한다. 충돌 대상은 UNIQUE 제약이나 unique 인덱스가 있는 컬럼이어야 하며, `WHERE 조건`으로 부분 unique 인덱스를, `ON CONSTRAINT name`으로 명명된 제약을 가리킬 수 있다.

- `DO UPDATE SET ...` — 기존 행을 갱신한다. `EXCLUDED`는 INSERT하려던 값이고, SET에 쓰지 않은 컬럼은 기존 값을 유지한다. ==`WHERE 기존값 <> EXCLUDED.값`을 붙이면 달라진 경우에만 UPDATE가 일어나 행 버전 생성과 WAL을 줄인다.==
- `DO NOTHING` — 충돌 행을 건너뛴다. 재시도해도 결과가 같은 멱등 입력에 쓴다.
- `MERGE` (PG 15+) — 소스와 타깃을 조인해 `WHEN MATCHED`·`WHEN NOT MATCHED` 분기별로 UPDATE·INSERT·DELETE를 지정한다. PG 17부터 `RETURNING merge_action()`으로 행별 적용 동작을 받을 수 있다.
- `SELECT ... FOR UPDATE` 후 분기 — 락을 잡고 애플리케이션에서 판단한다. 느리지만 ON CONFLICT로 표현할 수 없는 로직의 대안이다.

동시 INSERT 경합은 `SELECT`로 존재를 확인한 뒤 `INSERT`하는 분리 패턴에서 생긴다. `ON CONFLICT`는 확인과 입력을 한 문장에서 원자적으로 처리한다.

### RETURNING과 시퀀스

`RETURNING`은 입력된 행의 컬럼을 결과로 돌려주므로 생성된 ID를 받기 위한 SELECT가 필요 없다. `WITH ... AS (INSERT ... RETURNING id)` 형태의 데이터 수정 CTE와 결합하면 부모·자식 행 입력을 한 문장으로 묶는다.

시퀀스는 트랜잭션과 무관하다. ==ROLLBACK해도 배정된 번호는 되돌아오지 않으며, ID가 건너뛰는 것은 정상이다.==

## 코드

Bulk INSERT의 충돌 처리와 RETURNING, CTE 체이닝을 한 문장에 담은 SQL이다.

```sql
WITH upserted AS (
    INSERT INTO products (sku, name, price, updated_at)
    VALUES ('A-001', 'Keyboard', 59000, now()),
           ('A-002', 'Mouse',    29000, now())
    ON CONFLICT (sku)
    DO UPDATE SET name = EXCLUDED.name,
                  price = EXCLUDED.price,
                  updated_at = EXCLUDED.updated_at
    WHERE products.price <> EXCLUDED.price
    RETURNING id, sku, price
)
INSERT INTO price_changes (product_id, new_price, changed_at)
SELECT id, price, now() FROM upserted;
```

JPA `saveAll()`이 실제로 배치 INSERT를 내보내게 하는 설정이다. `batch_size`가 없으면 단건 INSERT가 N번 나간다.

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 1000
        order_inserts: true
        order_updates: true
```

PostgreSQL JDBC의 `CopyManager`로 STDIN 스트림 COPY를 수행하는 Spring Boot 3.x 컴포넌트다. `DataSourceUtils`로 현재 트랜잭션의 커넥션을 얻어 `@Transactional` 경계 안에서 실행한다.

```java
import java.io.StringReader;
import java.sql.Connection;
import java.util.List;
import java.util.stream.Collectors;
import javax.sql.DataSource;

import org.postgresql.PGConnection;
import org.postgresql.copy.CopyManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class LogCopyRepository {

    private final DataSource dataSource;

    public LogCopyRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public record LogRow(String level, String msg) {}

    @Transactional
    public long copyIn(List<LogRow> rows) throws Exception {
        Connection conn = DataSourceUtils.getConnection(dataSource);
        try {
            CopyManager copy = conn.unwrap(PGConnection.class).getCopyAPI();
            String csv = rows.stream()
                    .map(r -> r.level() + "," + escape(r.msg()))
                    .collect(Collectors.joining("\n"));
            return copy.copyIn(
                    "COPY logs (level, msg) FROM STDIN WITH (FORMAT csv)",
                    new StringReader(csv));
        } finally {
            DataSourceUtils.releaseConnection(conn, dataSource);
        }
    }

    private static String escape(String value) {
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }
}
```

## 실무에서 걸리는 지점

- **반복문 save()** — `for (...) repo.save(u)`는 단건 INSERT를 N번 보내며, `saveAll()`로 바꿔도 `batch_size`가 없으면 같다. ==IDENTITY 전략은 Hibernate가 배치 INSERT를 비활성화하므로 SEQUENCE 전략과 `allocationSize`를 함께 잡는다.==
- **트리거의 행 단위 비용** — `FOR EACH ROW` 트리거는 대량 입력에서 행마다 실행된다. 적재 전 `ALTER TABLE ... DISABLE TRIGGER`로 끄고 끝난 뒤 켠다.
- **EXCLUDED 대신 상수** — `DO UPDATE SET name = 'fixed'`처럼 상수를 쓰면 충돌 행이 모두 같은 값으로 덮인다. INSERT하려던 값을 반영하려면 `EXCLUDED.name`이어야 한다.
- **UPSERT 대상 인덱스 누락** — `ON CONFLICT (col)`은 col에 unique 인덱스가 있어야 실행된다. 오류가 나면 인덱스 존재 여부와, 부분 인덱스라면 WHERE 조건 일치 여부를 확인한다.
- **대량 입력 후 통계** — 10만 건 이상을 COPY로 넣으면 계획자 통계가 실제 분포와 어긋난다. autovacuum을 기다리지 않고 정확한 계획이 필요하면 `ANALYZE`를 직접 실행한다.

## 관련 글

- [INSERT·UPDATE·DELETE 표준 패턴](/notes/postgresql/insert-update-delete/)
- [UPDATE·DELETE 깊이 — HOT·bloat·VACUUM](/notes/postgresql/update-delete-hot-bloat-vacuum/)
- [내부 구조 — Storage Engine·페이지·WAL](/notes/postgresql/storage-engine-wal/)
