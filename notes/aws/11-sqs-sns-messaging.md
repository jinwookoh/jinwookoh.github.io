---
title: "SQS·SNS·Kinesis 메시징"
series: aws
part: "서버리스와 통합"
order: 11
summary: "큐·Pub/Sub·스트림·이벤트 버스를 언제 고르고, 중복·순서·유실을 어디서 막는지 정리한다"
tags: [SQS, SNS, Kinesis, EventBridge, Amazon MQ]
sources: [2026-05-01-aws-saa-messaging.md, 2026-05-03-aws-dva-messaging.md]
updated: 2026-08-30
---

서비스 A가 B를 직접 호출하는 동기 구조에서는 B의 지연과 장애가 그대로 A에 전파되고, 트래픽이 급증하면 뒤쪽 DB가 먼저 무너진다. 사이에 미들웨어를 두고 비동기로 전달하면 생산자와 소비자가 서로의 상태와 처리 속도에서 독립된다. AWS는 이 역할을 큐(SQS), Pub/Sub(SNS), 스트림(Kinesis), 이벤트 버스(EventBridge)로 나누어 제공하며 각각 풀려는 문제가 다르다.

## 핵심 개념

### SQS — 메시지 하나를 소비자 하나가 처리하는 큐

소비자가 폴링으로 꺼내고, 처리 후 `DeleteMessage`를 호출해야 큐에서 빠진다. 본문은 256KB까지이며 그 이상은 S3에 두고 참조만 넣는다. 보존은 기본 4일, 최대 14일이다.

**Visibility Timeout**은 꺼낸 메시지를 다른 소비자에게 숨기는 시간이다. 기본 30초, 최대 12시간이며 시간 안에 삭제하지 않으면 다시 보인다. `ChangeMessageVisibility`로 연장한다.

**Dead Letter Queue**는 `maxReceiveCount`만큼 수신됐는데도 삭제되지 않은 메시지를 격리하는 큐다. SQS→Lambda 구조는 큐에, SNS→Lambda 구조는 Lambda 쪽에 설정한다.

**Long Polling**은 `WaitTimeSeconds`(최대 20초)만큼 응답을 미뤄 빈 응답과 비용을 줄인다.

| 구분 | Standard | FIFO |
|:---|:---|:---|
| 처리량 | 무제한 | 300 TPS, 배치 시 3,000 TPS |
| 순서 | best-effort | 동일 Message Group ID 안에서 보장 |
| 전달 | at-least-once, 중복 가능 | 5분 창 안에서 중복 제거 |
| 이름 | 제한 없음 | `.fifo` 접미사 필수 |

FIFO의 순서는 같은 `MessageGroupId` 안에서만 보장되고 다른 그룹은 병렬로 소비된다. 큐 기반 워커의 Auto Scaling은 `ApproximateNumberOfMessagesVisible` 지표를 기준으로 한다.

### SNS — 토픽에 한 번 게시하면 모든 구독자가 받는 Pub/Sub

구독자는 SQS, Lambda, Firehose, HTTP/S, 이메일, SMS, 푸시다. SNS는 메시지를 저장하지 않아 전달 실패 시 사라진다. 유실이 허용되지 않으면 SNS 뒤에 SQS를 붙이는 **Fan-out** 패턴을 쓴다. 주문 이벤트 하나를 결제·재고·배송 큐가 각자 받아 독립적으로 처리하고, 새 소비자는 큐를 추가해 구독만 하면 된다. 이때 SQS 액세스 정책에서 토픽의 `sqs:SendMessage`를 허용해야 한다. 구독별 JSON 필터 정책으로 속성이 맞는 메시지만 받게 할 수 있고, SNS FIFO 토픽의 구독자는 SQS FIFO 큐로 제한된다.

### Kinesis — 보존되고 재생 가능한 스트림

SQS는 처리하면 삭제되고 Kinesis는 처리해도 남는다. **Data Streams**는 레코드를 기본 24시간, 최대 365일 보존하며 여러 소비자가 같은 데이터를 읽거나 과거부터 다시 읽을 수 있다. 같은 Partition Key는 같은 샤드로 가서 샤드 안에서 순서가 보장된다. 샤드당 쓰기 1MB/s, 읽기 2MB/s이며 Provisioned 모드는 샤드 수를 직접 조정하고 On-Demand는 자동 확장한다.

**Data Firehose**는 스트림을 S3·Redshift·OpenSearch 등으로 적재하는 완전 관리형 서비스다. 버퍼 크기 또는 간격이 먼저 채워질 때 전송하므로 near real-time이며 보존과 재생은 없다. Redshift는 S3에 적재한 뒤 `COPY`로 로드한다.

### EventBridge와 Amazon MQ

EventBridge는 이벤트를 규칙의 패턴 매칭으로 Lambda·SQS·SNS 등에 라우팅하고 `cron`·`rate` 스케줄도 담당한다. Amazon MQ는 AMQP·MQTT를 쓰는 기존 ActiveMQ·RabbitMQ 애플리케이션을 코드 수정 없이 옮길 때 쓰며, Multi-AZ 스토리지로 EFS를 사용한다.

## 코드

Spring Cloud AWS 3.x(`spring-cloud-aws-starter-sqs`)로 FIFO 큐에 보내는 예제다. 그룹 ID와 중복 제거 ID를 헤더로 지정한다.

```java
import io.awspring.cloud.sqs.operations.SqsTemplate;
import org.springframework.stereotype.Service;

@Service
public class OrderEventPublisher {

    private final SqsTemplate sqsTemplate;

    public OrderEventPublisher(SqsTemplate sqsTemplate) {
        this.sqsTemplate = sqsTemplate;
    }

    public void publish(OrderCreated event) {
        sqsTemplate.send(to -> to
                .queue("order-events.fifo")
                .payload(event)
                .header("message-group-id", event.customerId())
                .header("message-deduplication-id", event.orderId()));
    }
}
```

소비자는 `@SqsListener`로 받는다. 메서드가 정상 종료되면 메시지가 삭제되고, 예외가 나면 Visibility Timeout 이후 재수신되며 `maxReceiveCount`를 넘기면 DLQ로 간다.

```java
import io.awspring.cloud.sqs.annotation.SqsListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEventConsumer {

    private final OrderService orderService;

    public OrderEventConsumer(OrderService orderService) {
        this.orderService = orderService;
    }

    @SqsListener(value = "order-events.fifo", maxConcurrentMessages = "10")
    public void handle(OrderCreated event) {
        if (orderService.alreadyProcessed(event.orderId())) {
            return;
        }
        orderService.process(event);
    }
}
```

AWS SDK for Java 2.x로 SNS 토픽에 게시하면서 필터링용 메시지 속성을 붙이는 예제다.

```java
import java.util.Map;
import software.amazon.awssdk.services.sns.SnsClient;
import software.amazon.awssdk.services.sns.model.MessageAttributeValue;
import software.amazon.awssdk.services.sns.model.PublishRequest;

public class OrderTopicPublisher {

    private final SnsClient snsClient;
    private final String topicArn;

    public OrderTopicPublisher(SnsClient snsClient, String topicArn) {
        this.snsClient = snsClient;
        this.topicArn = topicArn;
    }

    public void publish(String jsonBody, String status) {
        snsClient.publish(PublishRequest.builder()
                .topicArn(topicArn)
                .message(jsonBody)
                .messageAttributes(Map.of("status",
                        MessageAttributeValue.builder()
                                .dataType("String")
                                .stringValue(status)
                                .build()))
                .build());
    }
}
```

## 실무에서 걸리는 지점

- **소비자 멱등성은 FIFO를 써도 필요하다.** Standard는 at-least-once가 기본이고, FIFO도 Visibility Timeout 안에 처리가 끝나지 않으면 재전달된다. 주문 ID 같은 비즈니스 키로 처리 여부를 기록해 둔다.
- **Visibility Timeout은 최악 처리 시간에 맞춘다.** 짧으면 중복 처리, 길면 소비자 장애 시 재전달까지 공백이 생긴다.
- **SNS만 쓰면 유실을 감지할 수 없다.** 처리 보장이 필요한 경로는 SQS를 사이에 둔다. Fan-out이 동작하지 않을 때 가장 흔한 원인은 SQS 액세스 정책 누락이다.
- **FIFO 처리량은 그룹 수가 결정한다.** Message Group ID가 하나면 사실상 단일 스레드로 소비된다. 순서가 필요한 최소 범위로 그룹을 나눈다.
- **Kinesis는 샤드 핫스팟에 취약하다.** 편중된 Partition Key는 특정 샤드에서만 스로틀링을 일으키므로 키 분포를 점검한다.

## 관련 글

- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
- [분석 — Athena·Glue·Kinesis](/notes/aws/analytics-athena/)
- [S3 — Object Lock·Access Points·CloudFront·Lambda 통합](/notes/aws/s3-advanced-cloudfront/)
