---
title: "Lambda·SAM·Step Functions·ECS·Fargate"
series: aws
part: "서버리스와 통합"
order: 12
summary: "코드를 함수로 올릴지 컨테이너로 올릴지 가르는 기준과, 각 선택에서 부딪히는 동시성·권한·시간 제한을 정리한다"
tags: [Lambda, SAM, Step Functions, ECS, Fargate]
sources: [2026-05-01-aws-saa-containers-serverless.md, 2026-05-03-aws-dva-serverless.md, 2026-05-03-aws-dva-containers.md]
updated: 2026-08-30
---

EC2에 애플리케이션을 직접 올리면 패치·용량 산정·스케일 판단이 운영자의 몫이 되고, 하루 몇 시간만 트래픽이 몰려도 인스턴스는 24시간 과금된다. 이 문제는 두 갈래로 푼다. ==짧고 이벤트 기반인 작업은 Lambda에 함수 단위로 올리고, 장시간 실행되거나 메모리·패키지 크기가 Lambda 한도를 넘는 작업은 ECS·Fargate에 컨테이너로 올린다.== 여러 함수를 엮는 흐름은 Step Functions가, 자원 정의는 SAM이 맡는다.

## 핵심 개념

### Lambda의 한도와 동시성

Lambda는 이벤트가 들어올 때만 실행되고 호출 횟수와 실행 시간으로 과금한다. 한도는 메모리 128MB~10GB, 실행 시간 최대 900초, 배포 패키지 압축 해제 250MB(컨테이너 이미지 10GB), 환경 변수 4KB, 리전당 기본 동시 실행 1,000이다. ==CPU는 메모리에 비례해 배정되므로 성능 조정 수단은 메모리 증설이다.== 이 한도를 넘는 작업은 Fargate로 옮긴다.

Reserved Concurrency는 리전 풀에서 특정 함수의 몫을 떼어 두면서 상한으로도 작동하고, 0이면 호출이 전부 스로틀된다. Provisioned Concurrency는 실행 환경을 미리 초기화해 콜드 스타트를 없애지만 유지 시간만큼 과금되고, `$LATEST`가 아닌 게시된 버전이나 별칭에만 붙는다. Java는 SnapStart로 초기화 완료 상태를 스냅샷에 담아 추가 비용 없이 콜드 스타트를 줄인다. 스로틀 시 동기 호출은 즉시 429, 비동기 호출은 최대 6시간 재시도 후 DLQ로 간다.

Lambda가 프라이빗 RDS·ElastiCache에 닿으려면 서브넷과 보안 그룹을 지정해 VPC 안에 배포해야 하고, 인터넷은 NAT Gateway를 경유한다. 함수 인스턴스가 수백 개로 늘면 DB 연결이 고갈되므로 RDS Proxy를 앞에 두는데, RDS Proxy는 퍼블릭 접근이 불가해 VPC 배포가 필수다.

### ECS와 Fargate

ECS는 Cluster, Service, Task Definition, Task 계층이다. Task Definition은 이미지·CPU·메모리·IAM Role을 적은 JSON으로 수정마다 새 리비전이 생기고, Service는 Desired Count만큼 Task를 유지하며 ALB 등록을 처리한다. ==`essential: true` 컨테이너가 종료되면 Task 전체가 내려가므로 사이드카는 `essential: false`로 둔다.==

EC2 Launch Type은 인스턴스와 ECS Agent를 직접 관리하고, Fargate는 Task 단위 vCPU·메모리로 과금하며 awsvpc 모드로 Task마다 ENI와 보안 그룹을 갖는다. Fargate의 영구 스토리지는 EFS만 붙는다.

IAM Role은 둘을 구분한다.

| 역할 | 부여 대상 | 권한 범위 |
|:---|:---|:---|
| Task Execution Role | ECS Agent | ECR Pull, CloudWatch 로그, Secrets 주입 |
| Task Role | Task 안의 애플리케이션 | S3·DynamoDB 등 AWS API 호출 |

EKS는 표준 Kubernetes API를 쓰고 실행 단위가 Pod이며, 멀티 클라우드나 기존 Kubernetes 자산이 있을 때 선택한다.

### Step Functions와 SAM

Step Functions는 Amazon States Language(JSON)로 정의한 상태 머신이다. Task·Choice·Parallel·Map 상태로 흐름을 만들고 Retry·Catch로 재시도와 대체 경로를 선언한다. Standard는 최대 1년, exactly-once, 상태 전환 수 과금이고 Express는 최대 5분, at-least-once, 실행 횟수·기간 과금이다.

SAM은 CloudFormation 위의 축약 문법이다. `Transform: AWS::Serverless-2016-10-31`을 선언하면 `AWS::Serverless::Function` 하나로 함수·이벤트·정책을 정의하고 배포 시 CloudFormation 스택으로 변환된다.

## 코드

Java 21 Lambda 핸들러. 무거운 클라이언트를 정적 필드에 두어 실행 환경 재사용 시 다시 만들지 않고, SnapStart 스냅샷에도 포함되게 한다.

```java
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;

import java.util.Map;

public class OrderHandler
        implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {

    private static final DynamoDbClient DYNAMO = DynamoDbClient.create();
    private static final String TABLE = System.getenv("ORDER_TABLE");

    @Override
    public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
        String orderId = event.getPathParameters().get("id");
        var item = DYNAMO.getItem(GetItemRequest.builder()
                .tableName(TABLE)
                .key(Map.of("pk", AttributeValue.fromS(orderId)))
                .build()).item();

        if (item.isEmpty()) {
            return APIGatewayV2HTTPResponse.builder().withStatusCode(404).build();
        }
        return APIGatewayV2HTTPResponse.builder()
                .withStatusCode(200)
                .withHeaders(Map.of("Content-Type", "application/json"))
                .withBody("{\"id\":\"" + orderId + "\",\"status\":\""
                        + item.get("status").s() + "\"}")
                .build();
    }
}
```

위 함수를 배포하는 SAM 템플릿. 별칭에 Provisioned Concurrency와 SnapStart를 함께 걸고, 정책 템플릿으로 DynamoDB 읽기 권한만 부여한다.

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  OrderTable:
    Type: AWS::Serverless::SimpleTable

  OrderFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: java21
      Handler: com.example.OrderHandler::handleRequest
      CodeUri: target/order-1.0.jar
      MemorySize: 1024
      Timeout: 10
      AutoPublishAlias: live
      SnapStart:
        ApplyOn: PublishedVersions
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 5
      Environment:
        Variables:
          ORDER_TABLE: !Ref OrderTable
      Policies:
        - DynamoDBReadPolicy:
            TableName: !Ref OrderTable
      Events:
        GetOrder:
          Type: HttpApi
          Properties:
            Path: /orders/{id}
            Method: get
```

금액에 따라 자동 승인과 수동 승인으로 분기하는 Step Functions 정의. 검증 단계에 재시도와 실패 경로를 선언한다.

```json
{
  "StartAt": "Validate",
  "States": {
    "Validate": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "${ValidateFunctionArn}",
        "Payload.$": "$"
      },
      "OutputPath": "$.Payload",
      "Retry": [{
        "ErrorEquals": ["States.TaskFailed"],
        "IntervalSeconds": 1,
        "MaxAttempts": 3,
        "BackoffRate": 2
      }],
      "Catch": [{
        "ErrorEquals": ["States.ALL"],
        "Next": "Rejected"
      }],
      "Next": "CheckAmount"
    },
    "CheckAmount": {
      "Type": "Choice",
      "Choices": [{
        "Variable": "$.amount",
        "NumericGreaterThan": 1000,
        "Next": "WaitForApproval"
      }],
      "Default": "AutoApprove"
    },
    "WaitForApproval": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
      "Parameters": {
        "QueueUrl": "${ApprovalQueueUrl}",
        "MessageBody": { "orderId.$": "$.orderId", "token.$": "$$.Task.Token" }
      },
      "TimeoutSeconds": 86400,
      "Next": "AutoApprove"
    },
    "AutoApprove": { "Type": "Succeed" },
    "Rejected": { "Type": "Fail", "Error": "ValidationFailed" }
  }
}
```

## 실무에서 걸리는 지점

- ==**API Gateway 29초와 Lambda 15분의 불일치.** 함수 Timeout을 길게 잡아도 API Gateway가 29초에 504를 먼저 반환한다.== 오래 걸리는 작업은 SQS나 Step Functions로 넘기고 즉시 202를 돌려준다.
- **Java 콜드 스타트.** JVM 기동과 Spring 컨텍스트 로딩으로 첫 호출이 수 초 걸린다. SnapStart로 줄지만 지연이 일정해야 하면 Provisioned Concurrency 비용을 감수하고, Spring Boot 전체보다 얇은 핸들러가 유리하다.
- **Task Role과 Execution Role 혼동.** `secrets` 필드로 값을 주입하는 권한은 Execution Role, 런타임에 SDK로 같은 시크릿을 읽는 권한은 Task Role에 있다.
- **Express 워크플로의 at-least-once.** 같은 상태가 두 번 실행될 수 있으므로 호출되는 함수는 멱등해야 한다. 결제·재고처럼 중복이 치명적인 흐름은 Standard를 쓰거나 DynamoDB 조건부 쓰기로 방어한다.

## 관련 글

- [SQS·SNS·Kinesis 메시징](/notes/aws/sqs-sns-messaging/)
- [RDS·Aurora·DynamoDB](/notes/aws/rds-aurora-dynamodb/)
- [CI/CD와 개발자 도구 — CodePipeline·CDK·CloudFormation](/notes/aws/cicd-developer-tools/)
