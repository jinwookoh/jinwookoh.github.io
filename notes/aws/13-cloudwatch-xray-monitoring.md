---
title: "CloudWatch·X-Ray·CloudTrail"
series: aws
part: "운영"
order: 13
summary: "성능 지표는 CloudWatch, 요청 경로는 X-Ray, API 호출 기록은 CloudTrail로 역할을 나눠 운영 가시성을 확보한다."
tags: [CloudWatch, X-Ray, CloudTrail, EventBridge, AWS Config]
sources: [2026-05-01-aws-saa-monitoring.md, 2026-05-03-aws-dva-monitoring.md]
updated: 2026-08-30
---

서비스가 여러 리전과 수십 개의 마이크로서비스로 흩어지면 장애 시 세 가지 질문에 즉시 답해야 한다. 리소스 상태가 어떤가, 느려진 요청이 어느 구간에서 시간을 쓰는가, 누가 어떤 설정을 바꿨는가. 서버에 접속해 로그를 뒤지는 방식으로는 복구보다 원인 파악에 더 오래 걸린다. ==AWS는 이 질문을 각각 CloudWatch, X-Ray, CloudTrail에 맡기고, 설정의 규정 준수 여부는 AWS Config가 담당한다.==

## 핵심 개념

**CloudWatch Metrics**는 시간에 따라 변하는 숫자를 네임스페이스(`AWS/EC2`, `MyApp`)로 묶고 차원(Dimension)으로 필터링한다. 기본 모니터링은 5분, 세부 모니터링은 1분 간격에 추가 비용이 붙는다. ==EC2의 메모리와 디스크 여유 공간은 하이퍼바이저가 볼 수 없어 기본 지표에 없으므로 CloudWatch Agent를 설치해 OS 내부 값을 사용자 지정 지표로 보낸다.== 외부 도구로 지표를 보내려면 Metric Streams가 Kinesis Data Firehose를 통해 거의 실시간으로 송출한다.

**CloudWatch Logs**는 로그 그룹, 로그 스트림, 로그 이벤트의 3층 구조이며 보존 기간은 기본 무기한, 1일부터 10년까지 설정한다. `CreateExportTask`는 S3 배치 내보내기로 완료까지 최대 12시간이 걸린다. 실시간 전달은 구독 필터(Subscription Filter)가 담당하며 Kinesis Data Streams, Firehose, Lambda, OpenSearch로 스트리밍한다. Metric Filter는 로그에서 `ERROR` 같은 패턴을 세어 지표로 바꾸고 알람에 연결한다. Logs Insights는 쌓인 로그를 전용 쿼리 언어로 분석하는 도구이고, Live Tail은 들어오는 로그를 즉시 보여주는 실시간 도구다.

**CloudWatch Alarms**는 OK, ALARM, INSUFFICIENT_DATA 세 상태를 가진다. 평가는 Period × Datapoints이므로 Period 5분에 3/3이면 15분간 조건이 유지돼야 울린다. 액션은 SNS 알림, Auto Scaling 조정, EC2 Stop·Terminate·Reboot·Recover다. Composite Alarm은 여러 알람을 AND/OR로 묶어 노이즈를 줄인다. EventBridge는 CloudTrail에 기록된 특정 API 호출을 패턴으로 잡아 SNS나 Lambda로 넘긴다.

**X-Ray**는 한 요청이 API Gateway, 서비스, DB를 거치는 경로를 Trace ID로 묶어 시각화한다. Trace 안에 서비스 단위 Segment, 그 안에 DB 쿼리·HTTP 호출 단위 Subsegment가 있다. Annotation은 인덱싱되어 필터 검색이 되고 Metadata는 저장만 된다. EC2·ECS에서는 X-Ray Daemon이 UDP 2000 포트로 데이터를 받아 API로 전달하고, Lambda는 Active Tracing만 켜면 된다. 기본 샘플링은 매초 첫 요청 + 이후 5%다.

**CloudTrail**은 기본 활성화되며 콘솔·SDK·CLI 호출을 모두 기록한다. Event History는 최근 90일의 관리 이벤트만 보여주므로 장기 보존은 Trail을 만들어 S3나 CloudWatch Logs로 보낸다. Trail은 단일 리전, 다중 리전, Organization 단위로 만든다. 관리 이벤트는 제어 영역 작업으로 기본 활성화·무료, 데이터 이벤트는 S3 GetObject나 Lambda Invoke 같은 데이터 영역 작업으로 기본 비활성화·유료, Insights 이벤트는 기준선 대비 이상한 호출 패턴을 감지한다. CloudTrail Lake를 쓰면 Athena 없이 SQL로 조회하고 최대 7년 보존한다.

**AWS Config**는 리소스 구성을 시간순으로 기록하고 규칙으로 Compliant/Non-compliant를 판정한다. ==위반을 탐지·평가만 할 뿐 사전 차단은 IAM이나 SCP의 몫이고, 사후 수정은 SSM Automation 문서로 자동화한다.==

## 코드

주문 처리 건수를 사용자 지정 지표로 송출하는 Spring 컴포넌트다. AWS SDK for Java 2.x의 `CloudWatchClient`를 빈으로 등록해 쓴다.

```java
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.cloudwatch.CloudWatchClient;
import software.amazon.awssdk.services.cloudwatch.model.*;

import java.time.Instant;

@Component
public class OrderMetricPublisher {

    private final CloudWatchClient cloudWatch;

    public OrderMetricPublisher(CloudWatchClient cloudWatch) {
        this.cloudWatch = cloudWatch;
    }

    public void publish(String region, int orderCount) {
        var datum = MetricDatum.builder()
                .metricName("OrderCount")
                .unit(StandardUnit.COUNT)
                .value((double) orderCount)
                .timestamp(Instant.now())
                .storageResolution(1)   // 1초 단위 고해상도 지표
                .dimensions(Dimension.builder().name("Region").value(region).build())
                .build();

        cloudWatch.putMetricData(PutMetricDataRequest.builder()
                .namespace("MyApp")
                .metricData(datum)
                .build());
    }
}
```

X-Ray SDK for Java로 서비스 로직을 Subsegment로 감싸고, 검색 가능한 Annotation과 검색 불가한 Metadata를 나눠 기록한다. `AWSXRayServletFilter`를 등록하면 요청 단위 Segment는 자동 생성된다.

```java
import com.amazonaws.xray.AWSXRay;
import com.amazonaws.xray.entities.Subsegment;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public Order process(long orderId, String customerTier) {
        Subsegment sub = AWSXRay.beginSubsegment("process_order");
        try {
            sub.putAnnotation("customerTier", customerTier); // 인덱싱, 필터 조건으로 사용
            sub.putMetadata("orderId", orderId);             // 저장만, 검색 불가
            return repository.findById(orderId)
                    .map(Order::markProcessed)
                    .orElseThrow();
        } catch (RuntimeException e) {
            sub.addException(e);
            throw e;
        } finally {
            AWSXRay.endSubsegment();
        }
    }
}
```

배포 직후 에러 로그를 Logs Insights로 조회하는 쿼리다.

```
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 100
```

## 실무에서 걸리는 지점

- **로그 보존 기간을 두지 않으면 비용이 계속 는다.** 로그 그룹은 기본 무기한이라 Lambda·ECS 로그가 그대로 쌓인다. 생성 시점에 보존 정책을 걸고 장기 보관은 S3로 옮긴다.
- **알람 평가 기간이 짧으면 스파이크마다 울린다.** Datapoints to alarm을 5분 중 3회처럼 잡고 Composite Alarm으로 조건을 묶는다.
- ==**CloudTrail 데이터 이벤트는 켜야 기록된다.**== S3 객체 접근을 사후 추적하려 했을 때 기록이 없는 원인은 대부분 이 설정 누락이다. 대상 버킷을 좁혀 활성화해 비용을 통제한다.
- **X-Ray 샘플링을 100%로 올리면 오버헤드와 비용이 급증한다.** 특정 경로에만 사용자 지정 규칙으로 비율을 높이고, Daemon이 없으면 Segment가 버려지므로 배포 시 Daemon 존재를 확인한다.

## 관련 글

- [SQS·SNS·Kinesis 메시징](/notes/aws/sqs-sns-messaging/)
- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
- [KMS·SSM·Secrets Manager — 암호화와 비밀 관리](/notes/aws/kms-secrets-security/)
