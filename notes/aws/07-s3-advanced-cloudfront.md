---
title: "S3 — Object Lock·Access Points·CloudFront·Lambda 통합"
series: aws
part: "컴퓨트와 스토리지"
order: 7
summary: "삭제 불가 보존, 버킷 하나에 여러 접근 경로, CDN 뒤로 버킷 숨기기, 업로드 이벤트 자동 처리를 S3 위에 어떻게 얹는가"
tags: [S3, Object Lock, Access Points, CloudFront, Lambda]
sources: [2026-05-02-aws-s3-advanced.md, 2026-05-02-aws-s3-integration.md]
updated: 2026-08-30
---

버킷·버전 관리·라이프사이클만으로는 남는 요구가 있다. 감사 기록은 관리자 권한으로도 지워지면 안 되고, 한 버킷을 여러 팀이 쓰면 버킷 정책이 수십 개 Statement로 불어난다. 정적 자산을 S3 URL로 직접 서비스하면 HTTPS·캐시가 없고, 업로드 후처리는 폴링 배치가 필요하다. Object Lock, Access Points, CloudFront OAC, 이벤트 알림과 Lambda가 각각 이 빈자리를 채운다.

## 핵심 개념

**Object Lock** 은 WORM(Write Once Read Many) 보존을 객체 버전 단위로 강제한다. 버킷 생성 시점에 활성화해야 하며 버전 관리가 전제된다. 보존 방식은 세 가지가 조합된다.

| 구분 | 해제 | 용도 |
|:---|:---|:---|
| Governance 모드 | `s3:BypassGovernanceRetention` 권한 + bypass 헤더로 해제 가능 | 내부 정책, 실수 방지 |
| Compliance 모드 | 보존 기간 만료 전에는 루트 계정도 해제 불가 | SEC 17a-4 등 외부 규정 |
| Legal Hold | 기간 없음, `s3:PutObjectLegalHold` 로 명시적 OFF | 소송·감사 중 증거 보전 |

Retention과 Legal Hold는 독립적이며 둘 중 하나라도 살아 있으면 삭제가 거부된다. 버킷 기본 보존 규칙은 신규 객체에 자동 적용된다.

**Access Points** 는 한 버킷에 이름 붙은 엔드포인트를 여러 개 만들고 엔드포인트마다 독립 정책을 두는 기능이다. 클라이언트는 버킷 이름 자리에 Access Point ARN을 넣는다. VPC 전용으로 만들면 인터넷 경로가 막힌다. Access Point 정책은 버킷 정책과 함께 평가되므로 버킷 정책은 "Access Point 경유만 허용"으로 단순화하고 세부 권한을 Access Point로 옮긴다. Multi-Region Access Point는 여러 리전 버킷 위의 글로벌 엔드포인트로 가장 가까운 리전에 라우팅·페일오버하며, 복제는 하지 않으므로 CRR이 선행돼야 한다. Object Lambda Access Point는 GET만 가로채 Lambda 변환 결과를 돌려주고 PUT·DELETE·HEAD는 통과한다.

**CloudFront + OAC** 는 S3를 오리진으로 두고 엣지에서 캐싱하는 표준 구성이다. OAC는 CloudFront 서비스 주체가 SigV4 서명으로 버킷에 접근하고, 버킷 정책의 `AWS:SourceArn` 조건으로 특정 배포만 허용한다. OAI는 레거시이며 SSE-KMS 오리진을 지원하지 않는다. S3 웹사이트 엔드포인트 단독은 HTTPS가 없으므로 S3 + CloudFront + Route 53으로 운영한다.

**이벤트 알림** 은 ObjectCreated·ObjectRemoved·Restore 등을 SNS·SQS·Lambda·EventBridge로 보낸다. 한 이벤트를 여러 규칙으로 분기하려면 EventBridge를 쓴다. prefix·suffix 필터로 대상을 좁힌다. Lambda 연결은 리소스 정책에 `s3.amazonaws.com` 주체의 InvokeFunction 허용과 버킷 알림 구성 두 단계다. 전달은 at-least-once 이므로 소비 측은 멱등해야 한다.

**Batch Operations** 는 매니페스트(Inventory 보고서 또는 CSV)의 객체 전체에 복사·태깅·Glacier 복원·Retention·Legal Hold·Lambda 호출을 단일 잡으로 적용하고 보고서를 남긴다. 본문 변환은 LambdaInvoke 로만 가능하다.

## 코드

AWS SDK for Java 2.x 로 Compliance 보존과 Legal Hold를 객체 버전에 적용하는 서비스다. `bypassGovernanceRetention` 은 Governance 모드 해제에만 의미가 있다.

```java
@Service
public class RetentionService {

    private final S3Client s3;

    public RetentionService(S3Client s3) {
        this.s3 = s3;
    }

    public void lockForYears(String bucket, String key, String versionId, int years) {
        Instant until = ZonedDateTime.now(ZoneOffset.UTC).plusYears(years).toInstant();
        s3.putObjectRetention(r -> r.bucket(bucket).key(key).versionId(versionId)
                .retention(ObjectLockRetention.builder()
                        .mode(ObjectLockRetentionMode.COMPLIANCE)
                        .retainUntilDate(until)
                        .build()));
    }

    public void setLegalHold(String bucket, String key, boolean on) {
        s3.putObjectLegalHold(r -> r.bucket(bucket).key(key)
                .legalHold(h -> h.status(on
                        ? ObjectLockLegalHoldStatus.ON
                        : ObjectLockLegalHoldStatus.OFF)));
    }

    public void releaseGovernance(String bucket, String key, String versionId) {
        s3.putObjectRetention(r -> r.bucket(bucket).key(key).versionId(versionId)
                .bypassGovernanceRetention(true)
                .retention(ObjectLockRetention.builder().build()));
    }
}
```

Access Point ARN을 버킷 자리에 넣어 읽고, 다운로드용 presigned URL에 응답 파일명을 강제하는 예다. `S3Presigner` 는 서명한 자격 증명의 만료를 넘는 URL을 만들 수 없다.

```java
@Service
public class FinanceObjectService {

    private static final String ACCESS_POINT =
            "arn:aws:s3:ap-northeast-2:123456789012:accesspoint/finance-ap";

    private final S3Client s3;
    private final S3Presigner presigner;

    public FinanceObjectService(S3Client s3, S3Presigner presigner) {
        this.s3 = s3;
        this.presigner = presigner;
    }

    public byte[] read(String key) {
        return s3.getObjectAsBytes(r -> r.bucket(ACCESS_POINT).key(key)).asByteArray();
    }

    public URL downloadUrl(String key, String fileName) {
        GetObjectRequest get = GetObjectRequest.builder()
                .bucket(ACCESS_POINT).key(key)
                .responseContentDisposition("attachment; filename=\"" + fileName + "\"")
                .build();
        return presigner.presignGetObject(p -> p
                .signatureDuration(Duration.ofMinutes(30))
                .getObjectRequest(get)).url();
    }
}
```

S3 ObjectCreated 이벤트를 받는 Java Lambda 핸들러다. 키는 URL 디코딩이 필요하고, 결과는 별도 버킷에 써서 재트리거를 막는다.

```java
public class ThumbnailHandler implements RequestHandler<S3Event, Void> {

    private final S3Client s3 = S3Client.create();
    private static final String OUT_BUCKET = "my-thumbnail-bucket";

    @Override
    public Void handleRequest(S3Event event, Context context) {
        for (S3EventNotification.S3EventNotificationRecord rec : event.getRecords()) {
            String bucket = rec.getS3().getBucket().getName();
            String key = URLDecoder.decode(rec.getS3().getObject().getKey(), StandardCharsets.UTF_8);
            String outKey = key.replaceFirst("^uploads/", "thumbnails/");

            if (exists(OUT_BUCKET, outKey)) {
                continue; // at-least-once 전달에 대한 멱등 처리
            }
            byte[] original = s3.getObjectAsBytes(r -> r.bucket(bucket).key(key)).asByteArray();
            byte[] thumb = ImageResizer.resize(original, 200, 200);
            s3.putObject(r -> r.bucket(OUT_BUCKET).key(outKey).contentType("image/jpeg"),
                    RequestBody.fromBytes(thumb));
        }
        return null;
    }

    private boolean exists(String bucket, String key) {
        try {
            s3.headObject(r -> r.bucket(bucket).key(key));
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        }
    }
}
```

## 실무에서 걸리는 지점

- **Compliance 모드는 되돌릴 수 없다.** 기본 보존 규칙을 잘못 넣으면 그 기간 동안 객체와 저장 비용이 남는다. Governance 로 검증한 뒤 Compliance 로 올린다. ==라이프사이클 만료 규칙도 보존 기간 전에는 삭제하지 못한다.==
- **이벤트 알림이 오지 않는 첫 원인은 Lambda 리소스 정책 누락이다.** 버킷 알림 구성만 넣으면 호출이 일어나지 않고 에러도 남지 않는다. ==출력 버킷을 입력 버킷과 같게 두고 prefix 필터를 빼면 재귀 호출로 비용이 폭증한다.==
- **Presigned URL 만료는 서명 자격 증명 만료에 묶인다.** ==인스턴스 프로파일이나 Lambda 실행 역할의 임시 자격 증명으로 7일짜리 URL을 만들어도 자격 증명 갱신 시점에 무효가 된다.== 긴 만료가 필요하면 IAM 사용자 키로 서명한다.
- **캐시 헤더는 자산 종류별로 나눈다.** 해시 파일명 자산은 1년, `index.html` 은 `no-cache` 로 올린다. OAC 전환 시 버킷 정책의 `SourceArn` 배포 ID가 틀리면 403이 캐시되어 원인 찾기가 오래 걸린다.
- **Access Point 는 버킷 정책과 AND 로 평가된다.** ==버킷 정책에 `s3:DataAccessPointAccount` 조건을 두지 않으면 버킷 직접 경로가 그대로 열려 있다.== Multi-Region Access Point 는 단일 리전 트래픽에는 과하다.

## 관련 글

- [S3 — 버킷·버전 관리·암호화·버킷 정책](/notes/aws/s3-basics-security/)
- [S3 — 멀티파트·라이프사이클·복제](/notes/aws/s3-performance-lifecycle-replication/)
- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
