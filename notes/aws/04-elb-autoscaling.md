---
title: "ELB와 Auto Scaling"
series: aws
part: "컴퓨트와 스토리지"
order: 4
summary: "ALB·NLB·GWLB의 선택 기준과 ASG 스케일링 정책·Lifecycle Hook을 하나의 자가 치유 구조로 묶는다."
tags: [ELB, ALB, NLB, Auto Scaling, Sticky Session]
sources: [2026-05-01-aws-saa-elb-asg.md]
updated: 2026-08-30
---

EC2 한 대로 서비스를 운영하면 사양을 키우는 수직 확장은 하드웨어 상한에 막히고, 인스턴스나 AZ 장애가 곧 서비스 중단이 된다. 여러 AZ에 인스턴스를 나란히 두는 수평 확장으로 가려면 트래픽을 나누는 단일 진입점과 인스턴스 수를 부하에 맞춰 조절하는 제어 장치가 필요하다. AWS에서 전자가 Elastic Load Balancing, 후자가 Auto Scaling Group이며, 둘을 묶으면 비정상 인스턴스를 자동으로 교체하는 자가 치유 구조가 된다.

## 핵심 개념

ELB는 단일 DNS 엔드포인트를 제공하고, Health Check를 통과한 대상에만 트래픽을 분산하며, TLS 종료를 대신 처리한다. 보안 그룹은 로드 밸런서 쪽에서 0.0.0.0/0의 80/443을 열고, EC2 쪽은 인바운드 소스를 로드 밸런서의 보안 그룹 ID로 지정한다.

현재 선택지는 세 종류이며 Classic Load Balancer는 신규 사용을 권장하지 않는다.

| 항목 | ALB | NLB | GWLB |
|:---|:---|:---|:---|
| 계층 | L7 (HTTP/HTTPS/WebSocket) | L4 (TCP/UDP/TLS) | L3 (IP, GENEVE 6081) |
| 고정 IP | 없음, DNS 이름 | AZ당 1개, EIP 가능 | 해당 없음 |
| 라우팅 | 경로·호스트·헤더·쿼리 | IP·포트 | VPC 라우팅 테이블 |
| 대상 | EC2, ECS, Lambda, 프라이빗 IP | EC2, 프라이빗 IP, ALB | 가상 어플라이언스 |
| Cross-Zone 기본값 | 활성화, 무료 | 비활성화, 유료 | 비활성화, 유료 |

ALB는 리스너, 리스너 규칙, 대상 그룹으로 구성된다. 규칙의 액션은 Forward·Redirect·Fixed Response이고 우선순위 숫자가 작을수록 먼저 평가된다. HTTPS 리스너에 인증서를 여러 개 붙이면 SNI로 도메인별 인증서가 선택된다. ALB는 클라이언트 연결을 종료하고 백엔드에 새 연결을 맺으므로 원 클라이언트 정보는 `X-Forwarded-For`·`X-Forwarded-Proto`·`X-Forwarded-Port` 헤더로만 확인한다.

NLB는 IP와 포트만 보고 전달하므로 지연이 낮고 처리량이 크다. 결정적 차이는 AZ별 고정 IP다. 상대 방화벽에 IP를 등록해야 하면 NLB가 답이고, 고정 IP와 L7 라우팅이 동시에 필요하면 NLB 뒤에 ALB를 대상으로 둔다. GWLB는 방화벽·IDS/IPS 어플라이언스 앞에 놓여 트래픽을 GENEVE로 캡슐화해 검사시킨 뒤 출발지·목적지를 바꾸지 않고 원래 경로로 돌려보낸다.

대상을 등록 해제하면 Deregistration Delay(기본 300초) 동안 진행 중인 요청을 마무리하며 0이면 즉시 끊긴다. Sticky Session은 쿠키로 같은 클라이언트를 같은 대상으로 보내는 기능으로 Duration-based(`AWSALB`)와 Application-based(`AWSALBAPP`)로 나뉘며, `AWSALB`·`AWSALBAPP`·`AWSALBTG`는 예약어다.

ASG는 Minimum·Desired·Maximum 사이에서 인스턴스 수를 유지한다. 인스턴스 규격은 Launch Template(AMI, 인스턴스 유형, User Data, EBS, 보안 그룹)에 두고, 서브넷은 ASG에 지정한다. ASG에 대상 그룹을 연결하고 Health Check 유형을 ELB로 바꾸면 로드 밸런서가 비정상으로 판정한 인스턴스를 ASG가 종료하고 새로 띄운다.

스케일링 정책은 다섯 가지다. Target Tracking은 목표값 하나를 주면 CloudWatch 경보를 자동 생성해 조절하므로 기본 선택지다. Step Scaling은 임계치 구간별로 증감 수를 다르게 두고, Simple Scaling은 경보 하나에 고정 증감을 매핑하되 Cooldown(기본 300초)까지 다음 조정을 막는다. Scheduled Scaling은 알려진 시각에, Predictive Scaling은 과거 지표를 ML로 학습해 반복 패턴에 앞서 용량을 잡는다. Lifecycle Hook은 인스턴스를 Pending 또는 Terminating 상태에 멈춰 초기화·정리 작업을 끼워 넣고, Instance Refresh는 템플릿 변경 후 Minimum Healthy Percentage를 지키며 점진적으로 교체한다.

## 코드

ALB Health Check용 설정. 대상 그룹 경로는 `/actuator/health/readiness`로 지정한다.

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState, db
server:
  forward-headers-strategy: native
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

`forward-headers-strategy: native`를 켜면 Tomcat이 `X-Forwarded-*` 헤더를 해석해 클라이언트 IP와 원래 스킴을 돌려준다.

```java
package com.example.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ClientInfoController {

    @GetMapping("/whoami")
    public ClientInfo whoami(HttpServletRequest request) {
        // native 전략 적용 시 getRemoteAddr()는 X-Forwarded-For의 첫 IP를 반환한다
        return new ClientInfo(request.getRemoteAddr(), request.getScheme(), request.getServerPort());
    }

    public record ClientInfo(String ip, String scheme, int port) {}
}
```

Terminating 훅에서 정리 작업 후 ASG에 진행을 알리는 코드.

```java
package com.example.scaling;

import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.autoscaling.AutoScalingClient;
import software.amazon.awssdk.services.autoscaling.model.CompleteLifecycleActionRequest;

@Component
public class TerminationHookHandler {

    private final AutoScalingClient autoScaling = AutoScalingClient.create();

    public void handle(String groupName, String hookName, String instanceId, String token) {
        flushLogsAndDrain(instanceId);
        autoScaling.completeLifecycleAction(CompleteLifecycleActionRequest.builder()
                .autoScalingGroupName(groupName)
                .lifecycleHookName(hookName)
                .instanceId(instanceId)
                .lifecycleActionToken(token)
                .lifecycleActionResult("CONTINUE")
                .build());
    }

    private void flushLogsAndDrain(String instanceId) {
        // 로그 업로드, 진행 중 작업 마무리
    }
}
```

## 실무에서 걸리는 지점

- Health Check에 DB 의존성을 넣으면 DB 장애 한 번에 모든 인스턴스가 비정상 판정되고 ASG가 정상 인스턴스를 연쇄 교체한다. readiness와 liveness를 분리하고 교체 기준은 프로세스 생존에 둔다.
- Deregistration Delay와 graceful shutdown 타임아웃이 맞지 않으면 배포마다 5xx가 섞인다. 짧은 API는 30초 안팎으로 낮추고, 긴 업로드가 있으면 그 이상으로 잡는다.
- NLB에서 Cross-Zone을 켜면 AZ 간 전송 요금이 붙고, 끄면 AZ별 인스턴스 수가 다를 때 부하가 편중된다. ASG의 AZ 균형 유지에 맡기는 편이 낫다.
- Sticky Session은 특정 인스턴스에 부하가 쏠리고 스케일 인 시 세션이 유실된다. 세션은 ElastiCache로 빼고 Sticky는 임시 수단으로 제한한다.
- Cooldown보다 부팅이 오래 걸리면 워밍업 중인 인스턴스의 높은 CPU가 다시 스케일 아웃을 유발한다. Golden AMI로 부팅을 줄이고 warm-up 시간을 명시한다.

## 관련 글

- [EC2·EBS·EFS](/notes/aws/ec2-ebs-efs/)
- [VPC·CloudFront·API Gateway](/notes/aws/vpc-networking/)
- [Multi-AZ 아키텍처·DR·마이그레이션](/notes/aws/multi-az-dr-migration/)
