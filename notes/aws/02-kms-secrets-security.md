---
title: "KMS·SSM·Secrets Manager — 암호화와 비밀 관리"
series: aws
part: "기초와 보안"
order: 2
summary: "KMS 봉투 암호화로 데이터를 잠그고, 설정은 Parameter Store에, 회전이 필요한 자격 증명은 Secrets Manager에 둔다."
tags: [KMS, Secrets Manager, Parameter Store, Envelope Encryption]
sources: [2026-05-01-aws-saa-security.md, 2026-05-03-aws-dva-security.md]
updated: 2026-08-30
---

DB 비밀번호를 환경 변수나 설정 파일에 평문으로 두면 값을 바꿀 때마다 재배포가 필요하고, 누가 언제 읽었는지 추적할 수 없으며, 유출 시 즉시 교체할 수단이 없다. 암호화 키를 애플리케이션이 코드와 같은 저장소에 들고 있는 구조도 마찬가지다. AWS는 이 문제를 키 관리(KMS)와 비밀 저장(Parameter Store·Secrets Manager)으로 분리해 해결한다.

## 핵심 개념

### 암호화 3방식

전송 중 암호화(TLS)는 도착 후 서버가 평문을 본다. 서버 측 암호화(SSE)는 AWS가 저장 시점에 암호화한다. 클라이언트 측 암호화(CSE)는 전송 전에 고객이 암호화하므로 AWS는 평문을 볼 수 없다.

### KMS 키 종류

| 키 | 관리 주체 | 비용 | 특징 |
|:---|:---|:---|:---|
| AWS Owned | AWS | 무료 | 서비스 내부용, 사용자에게 보이지 않음 |
| AWS Managed (`aws/rds` 등) | AWS | 무료 | 해당 서비스 전용, 키 정책 수정 불가 |
| Customer Managed | 고객 | 월 $1 | 키 정책·회전·삭제 직접 제어 |
| Imported (BYOK) | 고객 | 월 $1 | 외부 키 재료 반입, 자동 회전 불가 |

일반 데이터 암호화는 대칭 키(AES-256)를 쓴다. 비대칭 키(RSA·ECC)는 서명 검증이나 외부 시스템이 공개 키로 암호화하는 경우에 한정된다. 모든 KMS API 호출은 CloudTrail에 기록된다.

### 키 회전

AWS Managed Key는 매년 자동 회전되고 주기를 바꿀 수 없다. Customer Managed Key는 90일~2,560일(기본 1년) 주기의 자동 회전과 온디맨드 회전이 가능하다. Imported Key는 새 키를 만들고 별칭(Alias)을 옮기는 수동 회전만 된다. 회전 후에도 이전 키 재료는 유지되어 기존 암호문은 계속 복호화된다.

### 봉투 암호화

KMS의 `Encrypt`는 4KB 이하만 직접 암호화한다. 그 이상은 봉투 암호화를 쓴다. `GenerateDataKey`가 평문 DEK와 암호화된 DEK를 함께 반환하면, 평문 DEK로 데이터를 로컬에서 암호화한 뒤 폐기하고 암호화된 DEK를 암호문 옆에 저장한다. 복호화는 암호화된 DEK를 `Decrypt`에 넘겨 평문 DEK를 되찾는 순서다. 암호문 blob에 키 정보가 들어 있어 `Decrypt`에 키 ID를 줄 필요는 없다. S3 SSE-KMS와 AWS Encryption SDK 모두 내부적으로 이 패턴을 쓴다.

### 키 정책과 교차 계정

키 정책은 키에 직접 붙으며 IAM 정책과 별도로 평가된다. 키 정책이 허용하지 않으면 IAM 정책이 아무리 넓어도 키를 쓸 수 없다. 교차 계정 접근은 키 정책에 대상 계정을 명시해야 하며 AWS Managed Key로는 불가능하므로, EBS 스냅샷이나 AMI를 다른 계정과 공유하려면 Customer Managed Key로 암호화한다. Multi-Region Key는 Primary와 Replica가 같은 Key ID와 키 재료를 공유해 리전 간 재암호화 없이 복호화되지만 키 정책은 리전별로 독립이다.

### Parameter Store와 Secrets Manager

| 비교 | Parameter Store | Secrets Manager |
|:---|:---|:---|
| 용도 | 설정 값 + 비밀 | 비밀 전용 |
| 계층 구조 | `/app/prod/db-url` 경로 기반 | 없음 |
| 자동 회전 | 미지원 | Lambda 기반 지원 |
| RDS·Aurora·Redshift 통합 | 수동 | 기본 통합 (DB 암호 동시 갱신) |
| 최대 크기 | 4KB (Standard) / 8KB (Advanced) | 64KB |
| 다중 리전 복제 | 미지원 | 지원 |
| 비용 | Standard 무료, Advanced 파라미터당 월 $0.05 | 비밀당 월 $0.40 + API 1만 건당 $0.05 |

SecureString은 KMS로 암호화되며 읽으려면 `ssm:GetParameter`와 `kms:Decrypt`가 모두 필요하다. Secrets Manager의 회전은 지정 주기(기본 30일)마다 Lambda가 새 비밀번호를 만들어 DB와 비밀 값을 함께 갱신하며, 기본 통합되지 않은 서드파티 자격 증명은 회전 Lambda를 직접 작성한다.

## 코드

Spring Boot 3.x에서 AWS SDK for Java 2.x로 Secrets Manager의 DB 자격 증명을 읽어 DataSource를 구성한다. 자격 증명은 JSON(`username`·`password`) 형태다.

```java
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueRequest;

import javax.sql.DataSource;

@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(SecretsManagerClient client, ObjectMapper mapper) throws Exception {
        String json = client.getSecretValue(
                GetSecretValueRequest.builder().secretId("myapp/prod/db").build()
        ).secretString();
        JsonNode secret = mapper.readTree(json);

        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:postgresql://db.internal:5432/app");
        ds.setUsername(secret.get("username").asText());
        ds.setPassword(secret.get("password").asText());
        return ds;
    }
}
```

Parameter Store의 SecureString을 복호화해 읽는다. `withDecryption(true)`가 없으면 암호문이 그대로 반환된다.

```java
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.ssm.SsmClient;
import software.amazon.awssdk.services.ssm.model.GetParameterRequest;

@Component
public class ParameterReader {

    private final SsmClient ssm;

    public ParameterReader(SsmClient ssm) {
        this.ssm = ssm;
    }

    public String secure(String name) {
        return ssm.getParameter(GetParameterRequest.builder()
                .name(name)
                .withDecryption(true)
                .build()).parameter().value();
    }
}
```

4KB를 넘는 데이터를 KMS 봉투 암호화로 처리한다. 평문 DEK는 사용 직후 지우고, 암호화된 DEK를 암호문과 함께 저장한다.

```java
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.services.kms.KmsClient;
import software.amazon.awssdk.services.kms.model.DataKeySpec;
import software.amazon.awssdk.services.kms.model.GenerateDataKeyResponse;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.security.SecureRandom;
import java.util.Arrays;

public record Envelope(byte[] encryptedKey, byte[] iv, byte[] ciphertext) {}

public class EnvelopeEncryptor {

    private final KmsClient kms;
    private final String keyId;

    public EnvelopeEncryptor(KmsClient kms, String keyId) {
        this.kms = kms;
        this.keyId = keyId;
    }

    public Envelope encrypt(byte[] plaintext) throws Exception {
        GenerateDataKeyResponse dk = kms.generateDataKey(b -> b.keyId(keyId).keySpec(DataKeySpec.AES_256));
        byte[] plainKey = dk.plaintext().asByteArray();
        try {
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(plainKey, "AES"), new GCMParameterSpec(128, iv));
            return new Envelope(dk.ciphertextBlob().asByteArray(), iv, cipher.doFinal(plaintext));
        } finally {
            Arrays.fill(plainKey, (byte) 0);
        }
    }

    public byte[] decrypt(Envelope env) throws Exception {
        byte[] plainKey = kms.decrypt(b -> b.ciphertextBlob(SdkBytes.fromByteArray(env.encryptedKey())))
                .plaintext().asByteArray();
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(plainKey, "AES"), new GCMParameterSpec(128, env.iv()));
            return cipher.doFinal(env.ciphertext());
        } finally {
            Arrays.fill(plainKey, (byte) 0);
        }
    }
}
```

## 실무에서 걸리는 지점

- **권한이 둘 다 필요하다.** SecureString 읽기 실패의 대부분은 `kms:Decrypt`를 빠뜨린 경우다. Secrets Manager도 고객 관리 키로 암호화했다면 `secretsmanager:GetSecretValue`에 더해 키의 `kms:Decrypt`가 필요하다.
- **매 요청마다 비밀을 읽지 않는다.** Secrets Manager API는 건당 과금이고 호출 한도가 있다. 기동 시 읽어 캐시하고 인증 실패 시에만 다시 읽는다.
- **회전 후 커넥션 풀.** DB 암호가 바뀌면 열린 커넥션은 유지되지만 새 커넥션은 실패한다. 인증 오류를 감지해 비밀을 재조회하고 풀을 재구성해야 무중단이 된다.
- **키 정책을 비우면 잠긴다.** 키 정책에 계정 root나 관리자 주체를 빠뜨리면 아무도 키를 관리할 수 없다. 키 삭제는 최소 7일 대기 기간이 있어 되돌리기 어렵다.

## 관련 글

- [IAM·STS·Cognito — 사용자·역할·정책](/notes/aws/iam-sts-cognito/)
- [S3 — 버킷·버전 관리·암호화·버킷 정책](/notes/aws/s3-basics-security/)
- [RDS·Aurora·DynamoDB](/notes/aws/rds-aurora-dynamodb/)
