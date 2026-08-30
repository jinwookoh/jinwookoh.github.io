---
title: "S3 — 멀티파트·라이프사이클·복제"
series: aws
part: "컴퓨트와 스토리지"
order: 6
summary: "대용량 객체를 병렬로 올리고, 시간에 따라 자동으로 옮기고 지우며, 다른 버킷에 비동기 복제하는 S3 운영 축을 정리한다."
tags: [S3, Multipart Upload, Lifecycle, Replication, Intelligent-Tiering]
sources: [2026-05-02-aws-s3-performance.md, 2026-05-02-aws-s3-lifecycle.md, 2026-05-02-aws-s3-replication.md]
updated: 2026-08-30
---

단일 PUT은 5GB까지만 허용되고 전송 중 끊기면 처음부터 다시 보내야 한다. 버전 관리를 켠 버킷은 이전 버전과 중단된 멀티파트 조각이 쌓여 저장 비용이 조용히 늘어난다. 리전 하나에만 데이터가 있으면 리전 장애나 데이터 주권 요구에 대응할 수 없다. 멀티파트 업로드, 라이프사이클 정책, 복제가 각각 이 문제를 담당한다.

## 핵심 개념

### 처리량과 멀티파트 업로드

S3 처리량 한도는 버킷이 아니라 prefix 단위로, prefix당 초당 PUT/COPY/POST/DELETE 3,500건, GET/HEAD 5,500건이다. 한도에 닿으면 키 앞에 해시 몇 자리를 붙여 prefix를 분산한다. 날짜 기반 prefix는 같은 날 객체가 한 prefix에 몰리므로 고트래픽에 불리하다.

멀티파트 업로드는 CreateMultipartUpload로 UploadId를 받고, UploadPart를 병렬 호출한 뒤, CompleteMultipartUpload로 병합한다(실패 시 Abort). 파트는 5MB~5GB이고 마지막 파트만 5MB 미만이 허용되며, 최대 10,000 파트, 객체 최대 5TB다. 100MB 이상이면 권장, 5GB 초과는 필수다. 클라이언트가 리전에서 멀면 Transfer Acceleration이 가까운 엣지까지만 공용망을 타고 이후 AWS 백본으로 전달하며 별도 요금이 붙는다. 다운로드는 Range 헤더로 범위를 나눠 병렬로 받고, S3 Select는 단일 객체 안에서 SQL로 행을 필터한다.

### 라이프사이클

라이프사이클 정책은 조건에 맞는 객체를 N일 뒤 처리하는 규칙 모음이며 정책 자체는 무료다. 전환(Transition)은 Standard에서 IA·Glacier·Deep Archive 방향으로만 흐르고 역방향은 자동화되지 않는다. IA 계층으로의 전환은 객체 생성 후 30일이 지나야 하며 그보다 짧은 규칙은 거부된다. 만료(Expiration)는 현재 버전, 이전 버전(`NoncurrentDays`와 `NewerNoncurrentVersions`로 최신 N개 보존), 혼자 남은 삭제 마커, 미완료 멀티파트 네 종류다. 필터는 Prefix·Tag·객체 크기를 쓰고 조건을 결합할 때는 `And` 블록 안에 넣는다.

Intelligent-Tiering은 정해진 시점이 아니라 접근 패턴을 관찰해 Frequent와 Infrequent 사이를 양방향으로 옮기며, 객체당 모니터링 비용이 붙고 128KB 미만 객체는 제외된다. Glacier 계층 객체는 복원 요청 후 지정 일수 동안만 임시 사본으로 읽을 수 있고 클래스는 바뀌지 않는다. Deep Archive에는 Expedited 복원이 없다.

### 복제

복제는 소스 버킷에 새로 들어온 객체를 대상 버킷으로 비동기 복사한다.

| 항목 | CRR | SRR |
|:---|:---|:---|
| 리전 | 서로 다름 | 동일 |
| 주 용도 | 재해 복구, 데이터 주권, 지연 단축 | 로그 집계, 환경·계정 분리 |
| 전송 비용 | 리전 간 요금 발생 | 상대적으로 낮음 |
| 전제 조건 | 양쪽 버전 관리 + IAM 역할 | 동일 |

소스와 대상 모두 버전 관리가 켜져 있어야 하고, IAM 역할에는 소스의 `s3:GetObjectVersionForReplication` 계열 읽기 권한과 대상의 `s3:Replicate*` 권한이 필요하다. 교차 계정이면 대상 버킷 정책에서 소스 역할을 추가로 허용한다. 규칙이 겹치면 Priority 값이 큰 쪽이 적용되고 대상 클래스는 소스와 다르게 둘 수 있다. 삭제 마커 복제는 옵션이지만 버전 ID를 지정한 영구 삭제는 복제되지 않는다. RTC(Replication Time Control)는 객체의 99.99%를 15분 안에 복제하는 SLA와 메트릭을 함께 켜며 추가 요금이 붙는다. 양방향 복제는 각 버킷에 서로를 향한 규칙을 두면 되고, 이미 복제된 객체는 재복제되지 않아 루프가 없다.

## 코드

AWS SDK for Java 2.x의 S3TransferManager는 멀티파트 분할·병렬 전송·재시도를 내부에서 처리하며, CRT 클라이언트에 임계값과 파트 크기를 지정한다.

```java
import java.nio.file.Path;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3AsyncClient;
import software.amazon.awssdk.transfer.s3.S3TransferManager;
import software.amazon.awssdk.transfer.s3.model.UploadFileRequest;

@Service
public class LargeObjectUploader {

    private final S3TransferManager transferManager = S3TransferManager.builder()
            .s3Client(S3AsyncClient.crtBuilder()
                    .region(Region.AP_NORTHEAST_2)
                    .minimumPartSizeInBytes(16L * 1024 * 1024)
                    .thresholdInBytes(64L * 1024 * 1024)
                    .accelerate(true)
                    .build())
            .build();

    public String upload(String bucket, String key, Path file) {
        var request = UploadFileRequest.builder()
                .putObjectRequest(b -> b.bucket(bucket).key(key))
                .source(file)
                .build();
        return transferManager.uploadFile(request)
                .completionFuture().join()
                .response().eTag();
    }
}
```

규칙 하나에 전환·만료·이전 버전·미완료 멀티파트 처리를 모두 담은 구성이다.

```java
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;

public class LifecycleConfigurer {

    public void apply(S3Client s3, String bucket) {
        LifecycleRule rule = LifecycleRule.builder()
                .id("LogsLifecycle")
                .status(ExpirationStatus.ENABLED)
                .filter(f -> f.prefix("logs/"))
                .transitions(
                        Transition.builder().days(30).storageClass(TransitionStorageClass.STANDARD_IA).build(),
                        Transition.builder().days(90).storageClass(TransitionStorageClass.GLACIER).build())
                .expiration(e -> e.days(365))
                .noncurrentVersionTransitions(
                        NoncurrentVersionTransition.builder().noncurrentDays(30)
                                .storageClass(TransitionStorageClass.GLACIER).build())
                .noncurrentVersionExpiration(n -> n.noncurrentDays(90).newerNoncurrentVersions(3))
                .abortIncompleteMultipartUpload(a -> a.daysAfterInitiation(7))
                .build();

        s3.putBucketLifecycleConfiguration(PutBucketLifecycleConfigurationRequest.builder()
                .bucket(bucket)
                .lifecycleConfiguration(c -> c.rules(rule))
                .build());
    }
}
```

CRR 규칙에 삭제 마커 복제, SSE-KMS 객체, 대상 KMS 키, RTC를 함께 지정한다.

```java
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;

public class ReplicationConfigurer {

    public void apply(S3Client s3, String source, String destinationArn,
                      String roleArn, String replicaKmsKeyArn) {
        ReplicationRule rule = ReplicationRule.builder()
                .id("CrossRegionReplication")
                .status(ReplicationRuleStatus.ENABLED)
                .priority(10)
                .filter(f -> f.prefix(""))
                .deleteMarkerReplication(d -> d.status(DeleteMarkerReplicationStatus.ENABLED))
                .sourceSelectionCriteria(c -> c.sseKmsEncryptedObjects(
                        k -> k.status(SseKmsEncryptedObjectsStatus.ENABLED)))
                .destination(d -> d.bucket(destinationArn)
                        .storageClass(StorageClass.STANDARD_IA)
                        .encryptionConfiguration(e -> e.replicaKmsKeyID(replicaKmsKeyArn))
                        .replicationTime(t -> t.status(ReplicationTimeStatus.ENABLED)
                                .time(v -> v.minutes(15)))
                        .metrics(m -> m.status(MetricsStatus.ENABLED)
                                .eventThreshold(v -> v.minutes(15))))
                .build();

        s3.putBucketReplication(PutBucketReplicationRequest.builder()
                .bucket(source)
                .replicationConfiguration(c -> c.role(roleArn).rules(rule))
                .build());
    }
}
```

## 실무에서 걸리는 지점

- **미완료 멀티파트 조각은 목록에 보이지 않으면서 과금된다.** Abort 호출 전에 프로세스가 죽는 경우가 생기므로 모든 버킷에 `AbortIncompleteMultipartUpload` 7일 규칙을 건다.
- **최소 저장 기간을 무시한 전환은 비용을 늘린다.** Standard-IA·One Zone-IA 30일, Glacier Instant·Flexible 90일, Deep Archive 180일이 최소 과금 기간이며 그 안에 삭제하거나 다음 계층으로 옮겨도 남은 기간이 청구된다.
- **SSE-KMS 객체는 기본 설정으로 복제되지 않는다.** `SourceSelectionCriteria`, 대상 키 지정, 복제 역할의 소스 키 Decrypt와 대상 키 Encrypt 권한이 모두 있어야 하며, 빠지면 FAILED 상태만 남는다. SSE-C 객체와 Glacier 계층 객체는 복제 대상이 아니다.
- **복제 규칙은 이후 객체에만 적용되고 라이프사이클은 복제되지 않는다.** 기존 객체는 Batch Operations의 `S3ReplicateObject` 작업으로 따로 처리하고, 대상 버킷에도 라이프사이클을 별도로 건다.
- **복제 실패는 감시하지 않으면 드러나지 않는다.** `OperationsFailedReplication` 메트릭과 EventBridge 실패 이벤트를 켜고, S3 Inventory에 `ReplicationStatus` 필드를 넣어 일별로 점검한다.

## 관련 글

- [S3 — 버킷·버전 관리·암호화·버킷 정책](/notes/aws/s3-basics-security/)
- [S3 — Object Lock·Access Points·CloudFront·Lambda 통합](/notes/aws/s3-advanced-cloudfront/)
- [Multi-AZ 아키텍처·DR·마이그레이션](/notes/aws/multi-az-dr-migration/)
