---
title: "분석 — Athena·Glue·Kinesis"
series: aws
part: "네트워크와 데이터"
order: 10
summary: "S3에 쌓인 로그를 옮기지 않고 SQL로 분석하고, Glue로 스키마와 포맷을 정리하고, Kinesis로 실시간 수집하는 파이프라인의 구성 원칙"
tags: [Athena, Glue, Kinesis, Redshift, S3]
sources: [2026-05-01-aws-saa-analytics-ml.md]
updated: 2026-08-30
---

ALB 액세스 로그, VPC Flow Logs, CloudTrail 기록은 모두 S3에 파일로 쌓인다. 이 파일을 분석하려고 매번 Redshift에 적재하면 ETL과 클러스터 비용이 먼저 발생하고, 정작 질문은 "지난주 5xx가 어느 경로에서 났는가" 정도로 단순한 경우가 많다. 반대로 실시간 이벤트를 S3 업로드 폴링으로 받으면 지연이 분 단위로 벌어진다. 저장된 데이터에 즉시 SQL을 던지는 계층, 스키마와 파일 포맷을 관리하는 계층, 스트림을 받아 저장소까지 넘기는 계층이 각각 필요하고, AWS에서는 그 자리에 Athena·Glue·Kinesis가 놓인다.

## 핵심 개념

**Athena**는 S3 객체를 대상으로 표준 SQL을 실행하는 서버리스 쿼리 서비스다. 엔진은 Trino 기반(엔진 v3)이며 클러스터를 띄우지 않고 쿼리당 스캔한 바이트 양으로 과금한다. 사용 전에 쿼리 결과를 저장할 S3 위치(워크그룹 출력 위치)를 지정해야 하며, 이 설정이 없으면 쿼리가 실행되지 않는다. ==테이블 DDL의 `LOCATION`은 접두사 단위로 해석되므로 반드시 `/`로 끝나야 한다.==

과금이 스캔량 기준이므로 비용 최적화는 곧 스캔량 축소다. 네 가지가 표준이다.

| 방법 | 효과 |
|:---|:---|
| 컬럼 기반 포맷(Parquet·ORC) | 필요한 컬럼만 읽어 스캔량 감소 |
| 압축(Snappy·ZSTD 등) | 읽는 바이트 자체 감소 |
| 파티셔닝(`year=2026/month=08/`) | `WHERE` 조건에 맞는 접두사만 읽음 |
| 파일 크기 128MB 이상 | 소파일 메타데이터 오버헤드 제거 |

Lambda 기반 커넥터로 DynamoDB·RDS·CloudWatch Logs·온프레미스 DB에 같은 SQL을 실행하는 페더레이션 쿼리도 지원한다. 비슷한 위치의 **Redshift Spectrum**은 Redshift 클러스터에서 S3를 직접 읽는 기능으로, 실행 중인 클러스터가 전제된다. 클러스터 없이 즉시 SQL이면 Athena, 웨어하우스 테이블과 S3를 조인해야 하면 Spectrum이다.

**Glue**는 서버리스 ETL과 메타데이터 카탈로그를 담당한다. Crawler가 S3·JDBC 소스를 훑어 테이블·컬럼·파티션을 **Data Catalog**에 기록하고, Athena·Redshift Spectrum·EMR이 이 카탈로그를 공유 메타스토어로 사용한다. Athena에서 `CREATE TABLE`을 실행하면 실제로는 Glue Data Catalog에 테이블이 생성된다. ETL Job은 Spark 기반으로 CSV를 Parquet으로 변환하거나 Redshift에 적재하는 데 쓰이며, Job Bookmarks를 켜면 이전 실행에서 처리한 객체를 추적해 새 데이터만 처리한다. Lake Formation은 이 카탈로그 위에서 행·열 수준 권한을 관리한다.

**Kinesis**는 실시간 수집 계층이다. Kinesis Data Streams는 샤드 단위로 처리량을 확보하는 스트림으로, 레코드 최대 1MB, 보존 기간 최대 365일, 컨슈머가 직접 읽어 처리한다. Amazon Data Firehose(구 Kinesis Data Firehose)는 스트림을 S3·Redshift·OpenSearch로 배치 전달하는 서비스로, 버퍼 크기·시간에 따라 근실시간으로 동작하며 전달 중 Lambda 변환과 Parquet 변환을 지원한다. Managed Service for Apache Flink(구 Kinesis Data Analytics)는 Data Streams와 MSK를 소스로 상태 기반 스트림 처리를 수행하며, Firehose는 소스로 쓸 수 없다. 과거 SQL 애플리케이션 옵션은 지원이 종료되어 신규 구성에서는 고려 대상이 아니다.

MSK(관리형 Kafka)는 1MB를 넘는 메시지, Kafka 생태계 호환, 365일 초과 보존이 필요할 때 선택한다.

## 코드

Spring Boot 서비스에서 AWS SDK v2로 Athena 쿼리를 실행하고 완료까지 폴링한 뒤 결과를 읽는 예제다.

```java
@Service
public class AlbLogQueryService {

    private final AthenaClient athena;
    private final String outputLocation;

    public AlbLogQueryService(AthenaClient athena,
                              @Value("${app.athena.output}") String outputLocation) {
        this.athena = athena;
        this.outputLocation = outputLocation;
    }

    public List<String> topErrorPaths(LocalDate date) throws InterruptedException {
        String sql = """
            SELECT request_url, count(*) AS cnt
            FROM logs.alb_access
            WHERE year = '%d' AND month = '%02d' AND day = '%02d'
              AND elb_status_code >= 500
            GROUP BY request_url ORDER BY cnt DESC LIMIT 10
            """.formatted(date.getYear(), date.getMonthValue(), date.getDayOfMonth());

        String id = athena.startQueryExecution(r -> r
                .queryString(sql)
                .queryExecutionContext(c -> c.database("logs"))
                .resultConfiguration(c -> c.outputLocation(outputLocation)))
            .queryExecutionId();

        while (true) {
            QueryExecutionState state = athena.getQueryExecution(r -> r.queryExecutionId(id))
                .queryExecution().status().state();
            if (state == QueryExecutionState.SUCCEEDED) break;
            if (state == QueryExecutionState.FAILED || state == QueryExecutionState.CANCELLED) {
                throw new IllegalStateException("Athena query " + id + " " + state);
            }
            Thread.sleep(1000);
        }

        return athena.getQueryResultsPaginator(r -> r.queryExecutionId(id))
            .resultSet().stream()
            .skip(1)
            .map(row -> row.data().get(0).varCharValue())
            .toList();
    }
}
```

파티션 프로젝션을 쓰면 Crawler나 `MSCK REPAIR TABLE` 없이 날짜 파티션이 자동 인식된다. Athena에서 실행하는 DDL이며 `LOCATION` 끝의 `/`에 주의한다.

```sql
CREATE EXTERNAL TABLE logs.alb_access (
  elb_status_code INT,
  request_url STRING
)
PARTITIONED BY (year STRING, month STRING, day STRING)
STORED AS PARQUET
LOCATION 's3://my-log-bucket/alb/'
TBLPROPERTIES (
  'projection.enabled' = 'true',
  'projection.year.type' = 'integer',  'projection.year.range' = '2024,2030',
  'projection.month.type' = 'integer', 'projection.month.range' = '1,12',
  'projection.month.digits' = '2',
  'projection.day.type' = 'integer',   'projection.day.range' = '1,31',
  'projection.day.digits' = '2',
  'storage.location.template' = 's3://my-log-bucket/alb/year=${year}/month=${month}/day=${day}/'
);
```

애플리케이션 이벤트를 Kinesis Data Streams에 넣는 프로듀서다. 파티션 키가 샤드 분배를 결정하므로 카디널리티가 높은 값을 쓴다.

```java
@Component
public class OrderEventProducer {

    private final KinesisClient kinesis;
    private final ObjectMapper mapper;

    public OrderEventProducer(KinesisClient kinesis, ObjectMapper mapper) {
        this.kinesis = kinesis;
        this.mapper = mapper;
    }

    public void publish(OrderEvent event) throws JsonProcessingException {
        byte[] payload = mapper.writeValueAsBytes(event);
        kinesis.putRecord(r -> r
            .streamName("order-events")
            .partitionKey(event.orderId())
            .data(SdkBytes.fromByteArray(payload)));
    }
}
```

## 실무에서 걸리는 지점

- **소파일 문제.** ==Firehose 버퍼를 60초·1MB로 잡으면 하루에 수천 개의 작은 파일이 생기고 Athena 스캔 비용과 쿼리 시간이 늘어난다.== 버퍼를 최대(900초·128MB)에 가깝게 두거나, Glue Job으로 주기적으로 병합(compaction)한다.
- **Glue Crawler 스키마 변동.** ==소스 파일의 컬럼이 늘거나 타입이 바뀌면 Crawler가 테이블 스키마를 덮어써 기존 쿼리가 깨진다.== 스키마가 안정된 로그는 DDL을 직접 관리하고 파티션 프로젝션을 쓰는 편이 예측 가능하다.
- **Athena 결과 버킷 정리.** 쿼리마다 결과 CSV와 메타데이터 파일이 출력 위치에 남는다. 라이프사이클 규칙으로 삭제하지 않으면 저장 비용이 쌓인다.
- **Kinesis 샤드 한계와 재시도.** ==샤드당 초당 1MB·1,000레코드 쓰기 제한을 넘으면 `ProvisionedThroughputExceededException`이 발생한다.== 온디맨드 모드로 전환하거나, `PutRecords` 배치 응답의 실패 레코드만 골라 재시도하는 로직이 있어야 한다.
- **Flink 소스 선택 오류.** Firehose를 Flink 소스로 지정할 수 없으므로, 실시간 처리와 S3 적재가 모두 필요하면 Data Streams를 앞에 두고 Firehose와 Flink가 각각 그 스트림을 읽는 구조로 설계한다.

## 관련 글

- [S3 — 멀티파트·라이프사이클·복제](/notes/aws/s3-performance-lifecycle-replication/)
- [RDS·Aurora·DynamoDB](/notes/aws/rds-aurora-dynamodb/)
- [SQS·SNS·Kinesis 메시징](/notes/aws/sqs-sns-messaging/)
