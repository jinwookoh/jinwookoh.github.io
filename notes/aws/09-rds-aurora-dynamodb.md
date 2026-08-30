---
title: "RDS·Aurora·DynamoDB"
series: aws
part: "네트워크와 데이터"
order: 9
summary: "관계형은 RDS·Aurora, 키-값 대규모 조회는 DynamoDB로 나누고 복제·캐시·키 설계 함정을 정리한다"
tags: [RDS, Aurora, DynamoDB, Multi-AZ, RDS Proxy]
sources: [2026-05-01-aws-saa-databases.md, 2026-05-03-aws-dva-databases.md]
updated: 2026-08-30
---

EC2에 직접 MySQL을 올리면 OS 패치, 백업, 장애 복구, 읽기 분산을 전부 직접 처리해야 하고, 한 AZ가 죽으면 데이터베이스도 함께 사라진다. 반대로 관계형 DB 하나에 세션과 초당 수만 건의 키 조회까지 몰아넣으면 Join이 필요 없는 워크로드가 커넥션과 CPU를 소모한다. AWS는 이를 관리형 관계형 DB(RDS·Aurora)와 서버리스 NoSQL(DynamoDB)로 나눈다. ==Join과 트랜잭션이 필요하면 관계형, 키 하나로 값을 찾는 조회가 대규모로 반복되면 DynamoDB를 고른다.==

## 핵심 개념

### RDS

RDS는 MySQL, PostgreSQL, MariaDB, Oracle, SQL Server, DB2, Aurora를 지원하는 관리형 관계형 DB다. 인스턴스에 SSH로 접속할 수 없고, OS 접근이 필요하면 Oracle·SQL Server 전용인 RDS Custom을 쓴다.

자동 백업은 1~35일 보존되고 트랜잭션 로그가 5분마다 저장되어 시점 복구가 가능하며, 수동 스냅샷은 영구 보존된다. 복원은 항상 새 인스턴스를 만든다. 저장 암호화는 생성 시에만 켤 수 있어 기존 DB는 스냅샷을 암호화 옵션으로 복원해야 한다. 스토리지 자동 확장은 여유 공간 10% 미만, 5분 이상 지속, 마지막 수정 후 6시간 경과가 모두 맞을 때만 동작한다.

==Multi-AZ와 Read Replica는 목적이 다르다.==

| 구분 | Multi-AZ | Read Replica |
|:---|:---|:---|
| 목적 | 고가용성 | 읽기 확장 |
| 복제 | 동기 | 비동기 |
| Standby 접근 | 불가 | 읽기 전용 쿼리 가능 |
| 장애 조치 | 자동, DNS 유지 (60~120초) | 수동 승격 |
| 리전 | 동일 리전 다른 AZ | 교차 리전 가능 |

Multi-AZ는 활성화에 다운타임이 없고 앱 변경도 없다. 분석 쿼리가 운영 DB를 느리게 하면 Read Replica로 분리한다.

RDS Proxy는 DB 앞에 두는 관리형 커넥션 풀이다. Lambda 동시 실행이 커넥션을 고갈시키는 문제를 해결하고, 장애 조치 시간을 최대 66% 줄이며, IAM 인증과 Secrets Manager 통합을 제공한다. VPC 내부에서만 접근된다.

### Aurora

Aurora는 MySQL·PostgreSQL 호환 엔진으로, 스토리지를 3개 AZ에 6개 복사본으로 저장한다. 쓰기는 6개 중 4개, 읽기는 3개가 정상이면 가능하다. 스토리지는 10GB에서 128TiB까지 자동 확장되고, 읽기 복제본은 최대 15개, 장애 조치는 30초 이내다. 자동 백업은 끌 수 없다.

Writer 엔드포인트는 현재 마스터를 가리키고, Reader 엔드포인트는 복제본 전체에 연결 수준으로 로드 밸런싱하며, Custom 엔드포인트는 특정 인스턴스 묶음을 따로 노출한다.

변형으로 Serverless v2(ACU 단위 자동 확장), Global Database(보조 리전 최대 10개, 복제 지연 1초 미만, 승격 1분 미만), Backtrack(과거 시점 되감기), Cloning(Copy-on-Write), Babelfish(T-SQL 호환)가 있다.

### DynamoDB

DynamoDB는 서버리스 NoSQL로 밀리초 지연과 자동 Multi-AZ 복제를 제공한다. 기본 키는 Partition Key 단독 또는 Sort Key와의 조합이다. ==파티션 키는 UUID나 사용자 ID처럼 균등 분포해야 하며, 날짜처럼 값이 몰리는 키는 hot partition으로 스로틀링을 유발한다.==

인덱스는 GSI(다른 파티션 키, 별도 용량, 언제든 추가)와 LSI(같은 파티션 키에 다른 정렬 키, 생성 시에만)로 나뉜다. 용량 모드는 Provisioned와 On-Demand이며, RCU는 강한 일관성 4KB 읽기 1회, WCU는 1KB 쓰기 1회다.

부가 기능으로 DAX(전용 마이크로초 캐시), Streams(변경 이벤트 24시간 보존, Lambda 트리거), Global Tables(Active-Active 멀티 리전), TTL(자동 삭제), Transactions(최대 100개 항목, 용량 2배), PITR(35일), 용량을 소비하지 않는 S3 Export/Import가 있다.

## 코드

Aurora Writer·Reader 엔드포인트를 분리하고 읽기 전용 트랜잭션을 Reader로 라우팅하는 DataSource 구성이다.

```java
@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource routingDataSource(
            @Value("${aurora.writer-url}") String writerUrl,
            @Value("${aurora.reader-url}") String readerUrl,
            @Value("${aurora.username}") String user,
            @Value("${aurora.password}") String password) {

        HikariDataSource writer = hikari(writerUrl, user, password);
        HikariDataSource reader = hikari(readerUrl, user, password);

        AbstractRoutingDataSource routing = new AbstractRoutingDataSource() {
            @Override
            protected Object determineCurrentLookupKey() {
                return TransactionSynchronizationManager.isCurrentTransactionReadOnly()
                        ? "reader" : "writer";
            }
        };
        routing.setTargetDataSources(Map.of("writer", writer, "reader", reader));
        routing.setDefaultTargetDataSource(writer);
        return new LazyConnectionDataSourceProxy(routing);
    }

    private HikariDataSource hikari(String url, String user, String password) {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl(url);
        ds.setUsername(user);
        ds.setPassword(password);
        ds.setMaximumPoolSize(10);
        return ds;
    }
}
```

`LazyConnectionDataSourceProxy`로 감싸야 `@Transactional(readOnly = true)`가 설정된 뒤에 커넥션을 얻어 Reader로 갈 수 있다.

```java
@Service
public class OrderQueryService {

    private final OrderRepository repository;

    public OrderQueryService(OrderRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<Order> recentOrders(long userId) {
        return repository.findTop20ByUserIdOrderByCreatedAtDesc(userId);
    }
}
```

DynamoDB Enhanced Client로 `userId` 파티션 키 + `createdAt` 정렬 키 테이블에 TTL 속성을 포함해 저장하고 조회하는 예제다.

```java
@DynamoDbBean
public class Session {
    private String userId;
    private long createdAt;
    private String payload;
    private long expiresAt;

    @DynamoDbPartitionKey
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    @DynamoDbSortKey
    public long getCreatedAt() { return createdAt; }
    public void setCreatedAt(long createdAt) { this.createdAt = createdAt; }

    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }

    public long getExpiresAt() { return expiresAt; }
    public void setExpiresAt(long expiresAt) { this.expiresAt = expiresAt; }
}

@Repository
public class SessionRepository {

    private final DynamoDbTable<Session> table;

    public SessionRepository(DynamoDbEnhancedClient client) {
        this.table = client.table("sessions", TableSchema.fromBean(Session.class));
    }

    public void save(String userId, String payload) {
        Session s = new Session();
        s.setUserId(userId);
        s.setCreatedAt(Instant.now().toEpochMilli());
        s.setPayload(payload);
        s.setExpiresAt(Instant.now().plus(Duration.ofHours(1)).getEpochSecond());
        table.putItem(s);
    }

    public List<Session> latest(String userId) {
        return table.query(r -> r
                        .queryConditional(QueryConditional.keyEqualTo(
                                Key.builder().partitionValue(userId).build()))
                        .scanIndexForward(false)
                        .limit(10))
                .items().stream().toList();
    }
}
```

TTL은 테이블 설정에서 `expiresAt` 속성을 지정해야 동작하며, 값은 초 단위 epoch여야 한다.

## 실무에서 걸리는 지점

- ==Lambda가 RDS에 직접 붙으면 동시 실행 수만큼 커넥션이 생겨 `max_connections`를 넘긴다.== RDS Proxy를 둔다.
- Read Replica와 Aurora Reader는 비동기 복제라 방금 쓴 데이터가 바로 읽히지 않을 수 있다. 쓰기 직후 확인 조회는 Writer로 보내야 한다.
- Multi-AZ 장애 조치 후 JVM DNS 캐시 때문에 앱이 구 IP를 잡을 수 있다. `networkaddress.cache.ttl`을 짧게 둔다.
- DynamoDB는 파티션 키를 나중에 바꾸기 어렵다. 조회 패턴을 먼저 정의하고 키와 GSI를 설계한다.
- Scan은 테이블 전체를 읽어 RCU를 급격히 소모한다. Query 위주로 접근하고 대량 내보내기는 S3 Export를 쓴다.

## 관련 글

- [VPC·CloudFront·API Gateway](/notes/aws/vpc-networking/)
- [KMS·SSM·Secrets Manager — 암호화와 비밀 관리](/notes/aws/kms-secrets-security/)
- [Multi-AZ 아키텍처·DR·마이그레이션](/notes/aws/multi-az-dr-migration/)
