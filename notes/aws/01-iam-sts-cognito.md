---
title: "IAM·STS·Cognito — 사용자·역할·정책"
series: aws
part: "기초와 보안"
order: 1
summary: "AWS 권한은 정책 평가 순서·역할 수임·PassRole·Cognito 두 풀의 역할 분담을 알아야 안전하게 설계할 수 있다."
tags: [IAM, STS, Cognito, AssumeRole, SCP]
sources: [2026-05-01-aws-saa-iam-fundamentals.md, 2026-05-03-aws-dva-iam.md]
updated: 2026-08-30
---

AWS 워크로드는 대부분 다른 서비스를 호출한다. EC2가 S3에 쓰고, Lambda가 DynamoDB를 읽고, 타 계정이 우리 버킷을 조회한다. 이 호출을 통제하는 장치가 없으면 액세스 키를 코드에 박게 되고, 키가 유출되는 순간 계정 전체가 노출되며, 누가 무엇을 할 수 있는지 추적할 수 없어 감사가 불가능해진다. IAM은 "누가 어떤 리소스에 무슨 작업을 할 수 있는가"를 선언하고, STS는 그 권한을 만료되는 임시 자격 증명으로 빌려주며, Cognito는 IAM 바깥의 앱 최종 사용자를 같은 체계에 연결한다.

## 핵심 개념

IAM은 리전에 종속되지 않는 글로벌 서비스다. 계정 생성 시 만들어지는 루트 사용자는 모든 권한을 가지며 삭제할 수 없으므로 초기 설정과 결제 변경에만 쓰고 MFA를 켠 뒤 봉인한다.

구성 요소는 넷이다. 사용자는 사람 한 명에 대응하며 콘솔 비밀번호와 액세스 키를 가진다. 그룹은 사용자만 담을 수 있고 중첩되지 않으며, 한 사용자가 속한 모든 그룹의 정책이 합집합으로 적용된다. 역할은 서비스·타 계정·외부 IdP가 신뢰 정책에 따라 수임하는 주체이고, STS가 임시 자격 증명을 발급한다. 정책은 Effect·Action·Resource·Condition으로 권한을 기술한 JSON이며 리소스 기반 정책에는 Principal이 추가된다. S3는 버킷 작업(`s3:ListBucket`)에 `arn:aws:s3:::bucket`, 객체 작업(`s3:GetObject`)에 `arn:aws:s3:::bucket/*`를 써야 하고, 이 불일치가 정책이 동작하지 않는 가장 흔한 원인이다.

Identity 기반 정책은 AWS 관리형·고객 관리형·인라인으로 나뉘며 버전 관리가 되는 고객 관리형이 권장된다. 리소스 기반 정책은 S3 버킷·Lambda·SQS·SNS 등에 직접 붙는다.

평가 규칙은 명시적 Deny가 모든 Allow보다 우선하고, 명시적 Allow가 없으면 암묵적 Deny다. 요청은 SCP, 리소스 기반 정책, Identity 기반 정책, Permission Boundary, 세션 정책을 모두 통과해야 허용된다. Permission Boundary는 사용자·역할의 권한 상한으로 유효 권한은 Identity 정책과의 교집합이며, 위임받은 사용자가 스스로 관리자 권한을 만드는 것을 막는다. ==SCP는 Organizations의 OU·계정 단위 상한으로 멤버 계정의 루트까지 제한하지만 관리 계정에는 적용되지 않는다.==

STS는 15분에서 12시간(기본 1시간) 유효한 Access Key ID·Secret Access Key·Session Token을 발급한다. `AssumeRole`은 같은 계정 또는 교차 계정 역할 수임, `GetSessionToken`은 MFA 사용자의 임시 자격 증명, `GetCallerIdentity`는 현재 주체 확인, `DecodeAuthorizationMessage`는 Access Denied 메시지 해독에 쓴다. ==역할을 수임하면 세션 동안 원래 권한은 사라지고 역할 권한만 남는다.== 따라서 A 계정 DynamoDB를 읽어 B 계정 S3에 쓰는 것처럼 두 계정 권한이 동시에 필요하면 B 계정 버킷 정책에 A 계정 주체를 허용하는 리소스 기반 정책을 쓴다.

`iam:PassRole`은 EC2·Lambda 같은 서비스에 역할을 전달하는 권한이다. ==Resource를 특정 역할 ARN으로 좁히지 않으면 권한이 적은 사용자가 관리자 역할을 인스턴스에 붙여 권한을 상승시킬 수 있다.==

Cognito User Pool은 가입·로그인·소셜 로그인·MFA를 처리해 JWT를 발급하고 API Gateway·ALB와 직접 통합된다. Identity Pool은 그 토큰이나 게스트 상태를 IAM 역할에 매핑해 임시 AWS 자격 증명을 발급한다. User Pool로 신원을 확인하고 Identity Pool로 AWS 권한을 주는 두 단계 조합이 표준이다.

## 코드

Lambda가 수임할 역할의 신뢰 정책이다. Principal이 서비스일 때 형식은 다음과 같다.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

MFA 없는 세션의 EC2 종료를 차단하는 정책과, PassRole을 특정 역할로 제한하는 정책이다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": "ec2:TerminateInstances",
      "Resource": "*",
      "Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } }
    },
    {
      "Effect": "Allow",
      "Action": ["iam:PassRole", "iam:GetRole"],
      "Resource": "arn:aws:iam::123456789012:role/LambdaExecutionRole"
    }
  ]
}
```

Spring Boot 3.x에서 AWS SDK for Java v2로 교차 계정 역할을 수임하고, 그 임시 자격 증명으로 S3 클라이언트를 만든다. `StsAssumeRoleCredentialsProvider`가 만료 전 자동 갱신을 처리한다.

```java
@Configuration
public class CrossAccountS3Config {

    @Bean
    public S3Client crossAccountS3Client() {
        StsClient sts = StsClient.builder()
                .region(Region.AP_NORTHEAST_2)
                .build();

        AssumeRoleRequest request = AssumeRoleRequest.builder()
                .roleArn("arn:aws:iam::123456789012:role/CrossAccountRole")
                .roleSessionName("order-service")
                .durationSeconds(3600)
                .build();

        AwsCredentialsProvider provider = StsAssumeRoleCredentialsProvider.builder()
                .stsClient(sts)
                .refreshRequest(request)
                .build();

        return S3Client.builder()
                .region(Region.AP_NORTHEAST_2)
                .credentialsProvider(provider)
                .build();
    }
}
```

Cognito User Pool이 발급한 JWT를 Spring Security 6 리소스 서버로 검증한다. 발급자 URI만 지정하면 JWKS를 내려받아 서명과 만료를 확인한다.

```java
@Configuration
public class ResourceServerConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().permitAll())
                .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
        return http.build();
    }
}
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_XXXXXXXXX
```

## 실무에서 걸리는 지점

- Secret Access Key는 생성 직후 한 번만 표시된다. 처음부터 키를 쓰지 않고 EC2는 인스턴스 프로파일, ECS·Lambda는 실행 역할로 자격 증명을 받는 구조가 기본이다.
- `durationSeconds`는 역할의 최대 세션 시간을 넘길 수 없고, ==역할 체이닝은 상한이 1시간으로 고정되어 장시간 배치에 쓰면 중간에 만료된다.==
- Access Denied가 나면 `GetCallerIdentity`로 실제 호출 주체를 먼저 확인한다. 로컬 프로파일과 컨테이너 역할이 섞여 다른 주체로 호출되는 경우가 잦다.
- `iam:PassRole`에 `Resource: "*"`를 준 CI 역할은 관리자 역할을 배포 대상에 붙일 수 있어 사실상 관리자와 같다. 전달 가능한 역할 ARN을 열거한다.
- 미사용 권한은 Access Advisor로 찾아 제거하고, 계정 전체 MFA·키 교체 상태는 Credential Report로 감사한다. 태그 정책은 태그 없는 리소스 생성을 막지 않으므로 SCP나 Config 규칙이 따로 필요하다.

## 관련 글

- [KMS·SSM·Secrets Manager — 암호화와 비밀 관리](/notes/aws/kms-secrets-security/)
- [S3 — 버킷·버전 관리·암호화·버킷 정책](/notes/aws/s3-basics-security/)
- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
