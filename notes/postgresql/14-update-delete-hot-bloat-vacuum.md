---
title: "UPDATE·DELETE 깊이 — HOT·bloat·VACUUM"
series: postgresql
part: "DDL과 DML"
order: 14
summary: "UPDATE와 DELETE는 행을 제자리에서 고치지 않고 새 버전을 쓰거나 표시만 남기므로, HOT·fillfactor·VACUUM·파티션 DROP으로 그 비용을 관리해야 한다"
tags: [PostgreSQL, HOT, fillfactor, VACUUM, bloat]
sources: [data-infra/2026-05-17-pg-dml-update.md, data-infra/2026-05-17-pg-dml-delete.md]
updated: 2026-08-29
---

PostgreSQL의 UPDATE는 기존 행을 제자리에서 고치지 않는다. 새 버전의 행을 추가하고 옛 버전에는 "더 이상 보이지 않음" 표시만 남긴다. DELETE도 마찬가지로 표시만 남기고 디스크 공간을 회수하지 않는다. MVCC를 위한 설계지만, 이 구조를 모른 채 운영하면 두 가지 문제가 누적된다. 죽은 행이 쌓여 테이블과 인덱스가 부풀고(bloat), UPDATE마다 모든 인덱스가 새 행 위치를 가리키도록 갱신되어 쓰기 비용이 인덱스 개수에 비례해 커진다. HOT UPDATE, fillfactor, VACUUM, 파티션 DROP은 이 비용을 통제하는 도구다.

## 핵심 개념

### HOT UPDATE

HOT(Heap Only Tuple)는 새 행 버전을 옛 버전과 같은 데이터 페이지에 두고 인덱스를 갱신하지 않는 최적화다. 조건은 두 가지다. ==새 버전이 들어갈 여유 공간이 같은 페이지에 있어야 하고, 변경된 컬럼이 어떤 인덱스에도 포함되지 않아야 한다.== 둘 중 하나라도 어긋나면 일반 UPDATE가 되어 테이블의 모든 인덱스에 새 항목이 추가된다.

HOT 비율은 `pg_stat_user_tables`의 `n_tup_hot_upd / n_tup_upd`로 계산한다. UPDATE가 잦은 테이블에서 이 비율이 낮으면 fillfactor나 인덱스 구성을 검토한다.

### fillfactor

fillfactor는 페이지를 어느 비율까지 채울지 정하는 테이블 저장 옵션이다. 기본값 100은 페이지를 가득 채우므로 HOT을 위한 여유 공간이 없다. 70으로 설정하면 30%를 UPDATE용으로 남긴다. INSERT 위주 테이블은 100, 가끔 UPDATE되면 90, 자주 UPDATE되면 70~80이 일반적인 기준이다. `ALTER TABLE ... SET (fillfactor = 70)`은 이후 쓰이는 페이지에만 적용되므로 기존 페이지까지 재배치하려면 VACUUM FULL이나 pg_repack이 필요하다.

### bloat와 VACUUM

죽은 행이 차지한 공간은 VACUUM이 재사용 가능한 빈 공간으로 마킹한다. ==일반 VACUUM은 파일 크기를 줄이지 않고 이후 INSERT·UPDATE가 그 공간을 재사용하게 한다.== 파일 크기를 실제로 줄이려면 테이블을 재작성하는 VACUUM FULL이 필요한데, 실행 동안 ACCESS EXCLUSIVE 락이 걸려 읽기까지 막힌다. 운영 중에는 락 없이 재작성하는 pg_repack 확장이 대안이다.

autovacuum은 기본 활성화되어 있고, 변경 행 수가 `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × 행 수`를 넘으면 동작한다. 기본값은 50행 + 20%다. ==1억 행 테이블이면 2천만 행이 변경되어야 실행되므로 큰 테이블은 scale_factor를 낮추고 threshold를 올리는 식으로 테이블 단위 튜닝이 필요하다.==

### 파티션 DROP

시계열 데이터의 대량 삭제는 DELETE 대신 파티션 DROP으로 처리한다. DELETE는 행마다 WAL을 기록하고 죽은 행을 남기지만, DROP TABLE은 파일을 제거하므로 bloat도 WAL 폭증도 없다. pg_partman 확장을 쓰면 월별 파티션 생성과 보존 기간 초과 파티션 DROP을 자동화할 수 있다.

### 동시 수정 제어

같은 행을 두 트랜잭션이 동시에 고치는 문제는 두 방식으로 막는다. 낙관적 락은 version 컬럼을 두고 `WHERE version = ?`로 갱신해 결과 행이 0이면 충돌로 판단한다. 비관적 락은 `SELECT ... FOR UPDATE`로 행을 먼저 잠근다. 충돌이 드문 시스템은 낙관적 락이, 잔액 차감처럼 충돌이 잦고 실패를 허용하기 어려운 경우는 비관적 락이 맞다. `FOR UPDATE SKIP LOCKED`는 잠긴 행을 건너뛰므로 여러 워커가 큐 테이블을 나눠 처리할 때 쓴다.

## 코드

HOT 비율과 bloat를 함께 점검하는 조회다. dead_pct가 20%를 넘거나 HOT 비율이 낮은 테이블이 튜닝 대상이다.

```sql
SELECT relname,
       n_tup_upd,
       n_tup_hot_upd,
       ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1)                 AS hot_pct,
       n_live_tup,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_dead_tup + n_live_tup, 0), 1)     AS dead_pct
FROM   pg_stat_user_tables
ORDER  BY n_dead_tup DESC
LIMIT  10;

ALTER TABLE users SET (fillfactor = 70);
ALTER TABLE logs  SET (autovacuum_vacuum_scale_factor = 0.02,
                       autovacuum_vacuum_threshold    = 50000);
```

파티션이 없는 테이블의 대량 삭제는 청크 단위로 나누고 매 청크를 커밋한다. DO 블록 안에서는 COMMIT을 쓸 수 없으므로 프로시저로 만든다. UPDATE도 같은 골격으로 처리한다.

```sql
CREATE OR REPLACE PROCEDURE purge_logs(p_before timestamptz, p_chunk int DEFAULT 10000)
LANGUAGE plpgsql AS $$
DECLARE
    deleted int;
BEGIN
    LOOP
        DELETE FROM logs
        WHERE  id IN (SELECT id FROM logs
                      WHERE  created_at < p_before
                      LIMIT  p_chunk
                      FOR UPDATE SKIP LOCKED);
        GET DIAGNOSTICS deleted = ROW_COUNT;
        EXIT WHEN deleted = 0;
        COMMIT;
        PERFORM pg_sleep(0.1);
    END LOOP;
END $$;

CALL purge_logs('2025-01-01');
```

JPA의 `@Version`은 낙관적 락 패턴을 자동으로 적용한다. 충돌 시 `ObjectOptimisticLockingFailureException`이 발생하므로 재시도 로직을 호출자에 둔다.

```java
@Entity
public class Product {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Version
    private Integer version;

    private Integer price;

    public void changePrice(int price) { this.price = price; }
}

@Service
public class PriceService {
    private final ProductRepository repository;

    public PriceService(ProductRepository repository) { this.repository = repository; }

    @Retryable(retryFor = ObjectOptimisticLockingFailureException.class, maxAttempts = 3)
    @Transactional
    public void changePrice(Long id, int price) {
        Product product = repository.findById(id).orElseThrow();
        product.changePrice(price);
    }
}
```

## 실무에서 걸리는 지점

- 자주 바뀌는 컬럼에 인덱스를 걸면 HOT이 불가능해진다. `updated_at`이나 카운터 컬럼에 인덱스가 있으면 UPDATE마다 모든 인덱스가 갱신되므로, 정말 조회 조건에 쓰이는지 확인하고 없애는 편이 낫다.
- ==`UPDATE ... FROM`에서 조인 결과가 대상 행 하나에 여러 건 매칭되면 어느 값이 반영될지 정해져 있지 않다.== 집계나 `DISTINCT ON`으로 소스를 1:1로 만든 뒤 조인한다.
- ON DELETE CASCADE가 걸린 부모 행 하나를 지우면 자식 수만 건이 연쇄 삭제되어 WAL과 락이 폭주한다. 운영 테이블은 NO ACTION으로 두고 애플리케이션에서 자식부터 청크로 지운다.
- Soft Delete를 쓰면 `deleted_at IS NULL` 조건의 부분 인덱스로 활성 행만 UNIQUE를 걸고 인덱스 크기를 줄인다. 보존 기간이 지난 행을 실제로 지우는 배치를 별도로 돌려야 bloat와 개인정보 보존 요건을 함께 해결한다.
- TRUNCATE는 트랜잭션 안에서 롤백되지만, 외래 키로 참조되는 테이블은 거부한다. CASCADE를 붙이면 참조하는 테이블까지 비우므로 운영에서는 대상 범위를 반드시 확인한다.

## 관련 글

- [INSERT·UPDATE·DELETE 표준 패턴](/notes/postgresql/insert-update-delete/)
- [INSERT 깊이 — Bulk·COPY·UPSERT](/notes/postgresql/insert-bulk-copy-upsert/)
- [MVCC·격리 수준·락](/notes/postgresql/mvcc-isolation-locking/)
