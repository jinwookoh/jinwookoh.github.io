---
title: "CI/CD와 개발자 도구 — CodePipeline·CDK·CloudFormation"
series: aws
part: "운영"
order: 15
summary: "Code* 파이프라인으로 배포를, CloudFormation·CDK로 인프라를 코드로 고정하는 방법"
tags: [CodePipeline, CodeDeploy, CloudFormation, CDK, Blue/Green]
sources: [2026-05-03-aws-dva-cicd.md, 2026-05-03-aws-dva-developer-tools.md, 2026-05-01-aws-saa-exam-prep.md]
updated: 2026-08-30
---

수동 배포는 절차가 문서와 어긋나기 쉽고, 장애 시 이전 버전으로 돌아가는 경로가 명확하지 않으며, 인프라를 콘솔에서 손으로 만들면 어떤 설정이 언제 바뀌었는지 추적할 수 없다. AWS에서는 CodePipeline·CodeBuild·CodeDeploy가 배포 절차를, CloudFormation·CDK가 인프라 정의를 코드로 고정한다.

## 핵심 개념

### 파이프라인 구성

CodePipeline은 Source → Build → Test → Manual Approval → Deploy 스테이지를 오케스트레이션하고, 스테이지 사이의 산출물은 S3 아티팩트 버킷으로 전달한다. 트리거는 저장소 push·S3 변경·ECR push 또는 수동 Release change다. GitHub·Bitbucket은 CodeConnections(구 CodeStar Connections)로 연결하며, CodeCommit은 2024년 7월부터 신규 제공이 중단되어 외부 Git 연결이 기본이다. Manual Approval은 SNS 알림 후 승인이 있어야 진행한다.

CodeBuild는 `buildspec.yml`의 `phases`·`artifacts`·`cache`대로 빌드한다. 기본적으로 VPC 밖에서 실행되므로 프라이빗 리소스에 붙는 테스트는 VPC 설정이 필요하고, 비밀값은 `env.parameter-store`·`env.secrets-manager`로 참조한다.

### CodeDeploy 배포 전략

CodeDeploy는 `appspec.yml`에 따라 EC2·Lambda·ECS에 배포한다. EC2는 파일 복사 위치와 훅(ApplicationStop → BeforeInstall → AfterInstall → ApplicationStart → ValidateService)을, Lambda는 별칭과 버전 전환에 BeforeAllowTraffic/AfterAllowTraffic 훅을, ECS는 새 태스크 정의와 로드밸런서 정보를 선언한다. 훅 실패나 CloudWatch 알람 발동 시 자동 롤백한다.

| 대상 | 전략 | 동작 |
|:---|:---|:---|
| EC2 | In-Place | 기존 인스턴스 갱신, 다운타임 가능 |
| EC2 | Blue/Green | 새 ASG 배포 후 ELB 전환, 즉시 롤백 |
| Lambda·ECS | Canary | 일부 트래픽을 일정 시간 보낸 뒤 100% 전환 |
| Lambda·ECS | Linear | 일정 간격으로 고정 비율씩 전환 |
| Lambda·ECS | All-at-once | 즉시 100% 전환 |

==Canary·Linear는 Lambda 별칭 가중치 또는 ALB 리스너 가중치로 구현되므로 EC2에서는 선택할 수 없다.==

### CloudFormation과 CDK

CloudFormation은 YAML/JSON 템플릿(`Parameters`·`Resources`·`Outputs`)을 Stack 단위로 생성·갱신·삭제한다. `!Ref`·`!GetAtt`·`!Sub`·`!ImportValue`로 리소스를 연결하고, 모듈화는 Nested Stack, 다계정·다리전 배포는 StackSets를 쓴다. Change Set은 갱신 전 리소스 교체(Replacement) 여부를 보여 주고, Drift Detection은 콘솔에서 손으로 바꾼 리소스를 찾아낸다. CodePipeline의 Deploy 액션은 Stack 갱신을 직접 지원한다.

CDK는 TypeScript·Python·Java로 인프라를 작성하고 `cdk synth`로 CloudFormation 템플릿을 만든다. Construct는 L1(`Cfn*`, CFN 1:1)·L2(기본값과 권한 헬퍼)·L3(다중 리소스 패턴) 세 계층이다. 실행 엔진은 CloudFormation이므로 실패 원인은 CFN 콘솔의 Stack 이벤트에서 본다.

### 자격 증명

CLI·SDK는 명령행 옵션 → 환경 변수 → `~/.aws/credentials` → `~/.aws/config` → 인스턴스 프로파일·태스크 역할·실행 역할 순으로 자격 증명을 찾는다. 배포된 코드는 역할을 자동으로 쓰므로 액세스 키를 코드에 넣지 않는다.

## 코드

Gradle 기반 Spring Boot 3.x 앱을 빌드해 부팅 가능한 jar를 아티팩트로 넘기는 `buildspec.yml`이다.

```yaml
version: 0.2

env:
  secrets-manager:
    DB_PASSWORD: myapp/test-db:password

phases:
  install:
    runtime-versions:
      java: corretto21
  build:
    commands:
      - ./gradlew clean bootJar test --no-daemon
  post_build:
    commands:
      - cp build/libs/*.jar app.jar

artifacts:
  files:
    - app.jar
    - appspec.yml
    - scripts/**/*

cache:
  paths:
    - /root/.gradle/caches/**/*
```

EC2 In-Place 배포용 `appspec.yml`이다. `validate.sh`는 `curl -sf localhost:8080/actuator/health/readiness`의 종료 코드를 반환하고, 0이 아니면 롤백된다.

```yaml
version: 0.0
os: linux
files:
  - source: /
    destination: /opt/myapp
hooks:
  ApplicationStop:
    - location: scripts/stop.sh
      timeout: 60
  ApplicationStart:
    - location: scripts/start.sh
      timeout: 120
  ValidateService:
    - location: scripts/validate.sh
      timeout: 180
```

Java CDK로 Lambda 함수와 Canary 배포 그룹을 선언하는 Stack이다.

```java
import software.amazon.awscdk.Duration;
import software.amazon.awscdk.Stack;
import software.amazon.awscdk.StackProps;
import software.amazon.awscdk.services.codedeploy.LambdaDeploymentConfig;
import software.amazon.awscdk.services.codedeploy.LambdaDeploymentGroup;
import software.amazon.awscdk.services.lambda.Alias;
import software.amazon.awscdk.services.lambda.Code;
import software.amazon.awscdk.services.lambda.Function;
import software.amazon.awscdk.services.lambda.Runtime;
import software.constructs.Construct;

public class OrderApiStack extends Stack {

    public OrderApiStack(Construct scope, String id, StackProps props) {
        super(scope, id, props);

        Function fn = Function.Builder.create(this, "OrderFn")
                .runtime(Runtime.JAVA_21)
                .handler("com.example.OrderHandler::handleRequest")
                .code(Code.fromAsset("build/libs/order-api.jar"))
                .memorySize(1024)
                .timeout(Duration.seconds(15))
                .build();

        Alias live = Alias.Builder.create(this, "LiveAlias")
                .aliasName("live")
                .version(fn.getCurrentVersion())
                .build();

        LambdaDeploymentGroup.Builder.create(this, "CanaryGroup")
                .alias(live)
                .deploymentConfig(LambdaDeploymentConfig.CANARY_10_PERCENT_10_MINUTES)
                .build();
    }
}
```

## 실무에서 걸리는 지점

- **CodeBuild 환경 변수에 비밀값 직접 기입.** ==빌드 로그에 평문으로 남는다.== SSM·Secrets Manager 참조로 둔다.
- **EC2에 Canary를 기대하는 설계.** 가중치 전환은 Lambda·ECS에서만 동작한다. EC2 무중단은 Blue/Green이며 전환 기간 인스턴스 비용이 두 배다.
- **Change Set 없이 update-stack 실행.** ==Replacement를 유발하는 속성 변경은 기존 리소스를 삭제한다.== 상태 저장 리소스에는 `DeletionPolicy: Retain`을 건다.
- **콘솔 수동 변경으로 인한 Drift.** ==다음 Stack 갱신이 변경을 되돌리거나 실패한다.== 긴급 변경도 템플릿에 반영한다.
- **CDK 실패를 CDK 로그에서만 찾는 습관.** 실제 원인은 CFN 콘솔의 Stack 이벤트에 있다. L2가 자동 생성하는 IAM 정책 범위도 `cdk diff`로 확인한다.

## 관련 글

- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
- [CloudWatch·X-Ray·CloudTrail](/notes/aws/cloudwatch-xray-monitoring/)
