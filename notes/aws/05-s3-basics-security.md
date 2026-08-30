---
title: "S3 — 버킷·버전 관리·암호화·버킷 정책"
series: aws
part: "컴퓨트와 스토리지"
order: 5
summary: "S3 버킷의 평면 키 구조와 버전 관리, 4종 서버 측 암호화, IAM·버킷 정책·BPA의 평가 순서를 정리한다"
tags: [S3, Versioning, SSE-KMS, Bucket Policy, Presigned URL]
sources: [2026-05-01-aws-saa-s3-storage.md, 2026-05-02-aws-s3-basics.md, 2026-05-02-aws-s3-security.md, 2026-05-03-aws-dva-storage.md]
updated: 2026-08-30
---

애플리케이션 파일을 EC2 디스크나 EFS에 쌓으면 용량 계획, 다중 AZ 복제, 백업을 직접 운영해야 하고 인스턴스가 사라지면 데이터도 위험해진다. 업로드 파일·정적 자산·로그·백업처럼 한 번 쓰고 여러 번 읽는 데이터는 객체 스토리지에 둔다. S3는 용량 상한이 없고 데이터를 최소 3개 AZ에 복제해 99.999999999%의 내구성을 제공한다. 대신 접근 제어와 암호화는 공유 책임 모델에 따라 고객 몫이며, 유출 사고 대부분이 권한 설정 실수에서 나온다.

## 핵심 개념

### 버킷과 객체

버킷 이름은 `https://<bucket>.s3.amazonaws.com` 도메인으로 노출되므로 모든 계정·리전에 걸쳐 전역 고유해야 한다. 3~63자, 소문자·숫자·하이픈만 허용한다. 이름은 전역이지만 데이터는 지정한 리전 한 곳에 저장된다. 신규 버킷 기본값은 퍼블릭 액세스 차단, 버전 관리 비활성화, SSE-S3 암호화, ACL 비활성화다.

객체는 키·값·메타데이터·태그·버전 ID로 구성된다. 키에 슬래시가 들어가도 디렉터리는 없고 키 공간은 평면이며, 콘솔이 접두사(prefix)를 폴더처럼 보여 줄 뿐이다. 객체 최대 크기는 5TB, 단일 PUT은 5GB까지다. ==2020년 12월 이후 쓰기·갱신·삭제 후 읽기 모두 강한 일관성을 보장하므로 구 자료의 최종 일관성 설명은 현재와 다르다.==

### 버전 관리

버전 관리는 버킷 단위로 켜며, 같은 키로 업로드할 때마다 새 버전 ID가 부여되고 이전 버전은 남는다. 활성화 이전에 존재하던 객체의 버전 ID는 `null`이다. ==한 번 켜면 비활성으로 되돌릴 수 없고 Suspended 상태로만 전환되며 기존 버전은 유지된다.==

버전 ID 없이 삭제하면 객체는 지워지지 않고 최상단에 삭제 마커가 얹혀 GET이 404를 반환하며, 삭제 마커를 지우면 복구된다. 버전 ID를 지정해 삭제하면 그 버전이 영구 삭제된다. 모든 버전이 저장 비용을 발생시키므로 라이프사이클 규칙으로 비최신 버전을 만료시켜야 한다.

MFA Delete는 버전 영구 삭제와 버전 관리 중단에 MFA 코드를 요구하며, 루트 계정만 CLI 또는 API로 설정할 수 있다.

### 암호화

전송 중 암호화는 TLS로 처리하고, 버킷 정책에서 `aws:SecureTransport`가 false인 요청을 거부해 강제한다. 저장 시 암호화는 서버 측 4종과 클라이언트 측 1종이 있다.

| 방식 | 키 관리 | 비고 |
|:---|:---|:---|
| SSE-S3 | AWS | AES-256, 기본값, 추가 비용 없음 |
| SSE-KMS | KMS | CloudTrail 감사, 키 정책으로 세밀 제어, `kms:Decrypt` 권한 필요 |
| DSSE-KMS | KMS | 두 계층 이중 암호화 |
| SSE-C | 고객 | 요청마다 키 전송, HTTPS 필수, 콘솔 설정 불가 |
| CSE | 고객 | 업로드 전 클라이언트가 암호화, AWS는 평문을 보지 않음 |

==SSE-KMS는 객체를 읽고 쓸 때마다 KMS API를 호출하므로 객체가 많으면 요청 한도와 비용 문제가 생긴다.== S3 Bucket Key를 켜면 버킷 수준 데이터 키를 재사용해 호출을 줄인다. 버킷 정책의 암호화 조건은 기본 암호화 설정보다 먼저 평가된다.

### 접근 제어 계층

IAM 정책은 주체에, 버킷 정책은 리소스에 붙으며 버킷 정책에는 `Principal`이 필수다. 어느 한쪽의 Allow가 있고 어디에도 명시적 Deny가 없을 때 허용된다. `s3:ListBucket`은 버킷 ARN에, `s3:GetObject`는 `bucket/*` 객체 ARN에 걸어야 한다.

Block Public Access(BPA)는 4개 옵션으로 구성되며 버킷 정책이 `Principal: "*"`를 허용해도 이를 무효화한다. 계정 수준에서 켜면 그 계정의 어떤 버킷도 공개되지 않는다. ACL은 레거시 방식이며 `AuthenticatedUsers` 그룹이 전 세계 AWS 사용자를 뜻하는 등 위험해 신규 버킷에서는 비활성화가 기본이다.

Presigned URL은 버킷을 공개하지 않고 특정 객체에 시간 제한 접근을 부여한다. 생성자의 권한을 상속하며, ==유효 기간 상한은 자격 증명에 따라 IAM 사용자 7일, STS 임시 자격 증명 36시간, 인스턴스 프로필 6시간이다.== VPC 내부에서는 게이트웨이 엔드포인트를 쓰고 버킷 정책에 `aws:SourceVpce` 조건을 걸어 인터넷 경로를 차단한다.

## 코드

AWS SDK for Java 2.x의 `S3Client`와 `S3Presigner`를 Spring Boot 3.x 빈으로 등록한다. 자격 증명은 기본 체인에서 가져오고 코드에 키를 넣지 않는다.

```java
@Configuration
public class S3Config {

    @Bean
    public S3Client s3Client(@Value("${app.aws.region}") String region) {
        return S3Client.builder()
                .region(Region.of(region))
                .credentialsProvider(DefaultCredentialsProvider.create())
                .build();
    }

    @Bean
    public S3Presigner s3Presigner(@Value("${app.aws.region}") String region) {
        return S3Presigner.builder()
                .region(Region.of(region))
                .credentialsProvider(DefaultCredentialsProvider.create())
                .build();
    }
}
```

SSE-KMS로 업로드하고 응답의 버전 ID를 보관한 뒤, 특정 버전을 읽고 삭제 마커를 제거해 복구하는 서비스다.

```java
@Service
public class DocumentStorage {

    private final S3Client s3;
    private final String bucket;
    private final String kmsKeyId;

    public DocumentStorage(S3Client s3,
                           @Value("${app.aws.s3.bucket}") String bucket,
                           @Value("${app.aws.kms.key-id}") String kmsKeyId) {
        this.s3 = s3;
        this.bucket = bucket;
        this.kmsKeyId = kmsKeyId;
    }

    public String upload(String key, byte[] body, String contentType) {
        PutObjectResponse res = s3.putObject(PutObjectRequest.builder()
                        .bucket(bucket)
                        .key(key)
                        .contentType(contentType)
                        .serverSideEncryption(ServerSideEncryption.AWS_KMS)
                        .ssekmsKeyId(kmsKeyId)
                        .bucketKeyEnabled(true)
                        .build(),
                RequestBody.fromBytes(body));
        return res.versionId();
    }

    public byte[] readVersion(String key, String versionId) {
        ResponseBytes<GetObjectResponse> bytes = s3.getObjectAsBytes(
                GetObjectRequest.builder()
                        .bucket(bucket).key(key).versionId(versionId).build());
        return bytes.asByteArray();
    }

    public void restoreDeleted(String key) {
        ListObjectVersionsResponse versions = s3.listObjectVersions(
                ListObjectVersionsRequest.builder().bucket(bucket).prefix(key).build());
        versions.deleteMarkers().stream()
                .filter(m -> m.key().equals(key) && Boolean.TRUE.equals(m.isLatest()))
                .findFirst()
                .ifPresent(m -> s3.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket).key(key).versionId(m.versionId()).build()));
    }
}
```

브라우저가 S3에 직접 올리도록 PUT용 Presigned URL을 발급하는 컨트롤러다. 유효 기간은 짧게 잡고 Content-Type을 서명에 포함시킨다.

```java
@RestController
@RequestMapping("/api/uploads")
public class UploadUrlController {

    private final S3Presigner presigner;
    private final String bucket;

    public UploadUrlController(S3Presigner presigner,
                               @Value("${app.aws.s3.bucket}") String bucket) {
        this.presigner = presigner;
        this.bucket = bucket;
    }

    public record UploadUrl(String url, String key, Instant expiresAt) {}

    @PostMapping
    public UploadUrl issue(@RequestParam String contentType) {
        String key = "uploads/" + LocalDate.now() + "/" + UUID.randomUUID();
        PresignedPutObjectRequest presigned = presigner.presignPutObject(
                PutObjectPresignRequest.builder()
                        .signatureDuration(Duration.ofMinutes(10))
                        .putObjectRequest(PutObjectRequest.builder()
                                .bucket(bucket).key(key)
                                .contentType(contentType).build())
                        .build());
        return new UploadUrl(presigned.url().toString(), key, presigned.expiration());
    }
}
```

## 실무에서 걸리는 지점

- SSE-KMS 객체를 읽지 못하는 원인은 대부분 `kms:Decrypt` 권한 누락이다. IAM 정책과 KMS 키 정책 양쪽에서 허용해야 하며, 크로스 계정이면 키 정책에 상대 계정을 명시한다.
- 버전 관리를 라이프사이클 없이 켜면 갱신이 잦은 키의 비최신 버전이 저장 비용을 불린다. 켜는 시점에 비최신 버전 만료 규칙을 같이 넣는다.
- 인스턴스 프로필로 만든 Presigned URL은 7일로 설정해도 임시 자격 증명이 갱신되는 6시간 안에 만료된다. 요청 시점에 짧게 재발급하는 구조가 안전하다.
- 정적 웹사이트 버킷의 403은 버킷 정책의 `s3:GetObject` 공개 허용과 BPA 해제 두 가지를 확인한다. 계정 수준 BPA가 켜져 있으면 버킷 수준에서 풀어도 소용없다.
- CORS는 리소스를 제공하는 버킷에 설정하며 `AllowedOrigins: ["*"]`는 개발 환경에서만 쓴다.

## 관련 글

- [KMS·SSM·Secrets Manager — 암호화와 비밀 관리](/notes/aws/kms-secrets-security/)
- [S3 — 멀티파트·라이프사이클·복제](/notes/aws/s3-performance-lifecycle-replication/)
- [S3 — Object Lock·Access Points·CloudFront·Lambda 통합](/notes/aws/s3-advanced-cloudfront/)
