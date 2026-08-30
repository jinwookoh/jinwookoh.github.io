---
title: "VPC·CloudFront·API Gateway"
series: aws
part: "네트워크와 데이터"
order: 8
summary: "VPC 경계 설계부터 CloudFront 캐싱, API Gateway 인증·스로틀링, Route 53 라우팅까지 트래픽 경로를 정리한다"
tags: [VPC, CloudFront, API Gateway, Route 53, NAT Gateway]
sources: [2026-05-01-aws-saa-networking.md, 2026-05-03-aws-dva-networking.md]
updated: 2026-08-30
---

네트워크 경계를 설계하지 않으면 DB가 인터넷에 노출되고, 전 세계 사용자가 한 리전의 오리진을 직접 두드린다. VPC는 이 경계를 정의하고, CloudFront는 오리진 앞에서 응답을 캐싱하며, API Gateway는 인증과 속도 제한을 애플리케이션 코드 밖으로 끌어낸다. Route 53은 진입점에 이름을 붙이고 장애 시 경로를 바꾼다.

## 핵심 개념

### VPC와 서브넷

VPC는 계정 안의 격리된 네트워크로, CIDR은 `/16`부터 `/28`까지 지정한다. 서브넷마다 5개 IP가 예약되므로 `/24`의 실사용 IP는 251개다. 라우팅 테이블에 `0.0.0.0/0 → IGW` 경로가 있으면 퍼블릭 서브넷, 없으면 프라이빗 서브넷이다. 프라이빗 서브넷의 아웃바운드는 퍼블릭 서브넷에 둔 NAT Gateway를 경유하며, NAT Gateway는 AZ 단위 자원이라 AZ마다 하나씩 둔다. IPv6는 사설 주소가 없어 Egress-Only Internet Gateway(`::/0`)를 쓴다.

### Security Group과 NACL

| 항목 | Security Group | NACL |
|:---|:---|:---|
| 적용 단위 | ENI | 서브넷 |
| 상태 | Stateful | Stateless |
| 규칙 | Allow만 | Allow + Deny, 번호순 |

특정 IP 차단은 Deny 규칙이 있는 NACL로 한다. NACL은 응답이 나갈 임시 포트(1024–65535) 아웃바운드를 따로 열어야 하며, Flow Logs에서 인바운드 ACCEPT 뒤 아웃바운드 REJECT가 보이면 이 규칙 누락이다.

### VPC 간 연결과 서비스 접근

VPC Peering은 비전이적 1:1 연결이라 A–B, B–C를 맺어도 A–C가 열리지 않으며 CIDR 중복을 허용하지 않는다. VPC가 늘면 전이적 라우팅을 지원하는 Transit Gateway 허브로 모은다. PrivateLink는 서비스를 다수 VPC에 노출하며 CIDR 중복도 허용한다.

VPC Endpoint는 S3·DynamoDB 전용이며 무료인 Gateway Endpoint와, 그 외 서비스용으로 ENI를 만들고 요금이 붙는 Interface Endpoint로 나뉜다. 온프레미스 연결은 Site-to-Site VPN과 전용 회선인 Direct Connect가 있고, Direct Connect는 기본 암호화가 없어 필요하면 그 위에 VPN을 올린다.

### CloudFront

전 세계 엣지에서 오리진 응답을 캐싱하는 CDN이다. S3 오리진은 Origin Access Control로 CloudFront만 읽도록 제한하며, OAC는 OAI를 대체한다. 프라이빗 ALB·NLB는 VPC Origin으로 연결한다. 접근 제어는 파일 하나면 Signed URL, 여러 파일이나 세션이면 Signed Cookie다. 엣지 코드는 단순 헤더 조작이면 CloudFront Functions, 네트워크 접근이 필요하면 Lambda@Edge다. 캐싱 없이 TCP/UDP를 정적 Anycast IP로 받는 용도는 Global Accelerator다.

### API Gateway

REST API는 캐싱·요청 검증·Usage Plan을 갖춘 전체 기능형, HTTP API는 단순 프록시용 저비용 버전, WebSocket API는 양방향 실시간용이다. 실제 인증 수단은 IAM(서비스 간)·Cognito User Pool(앱 사용자)·Lambda Authorizer(커스텀 검증) 셋이다. API Key는 Usage Plan에 묶어 스로틀링과 사용량 추적을 하는 용도이며 인증을 대체하지 않는다. 스로틀링 기본값은 계정당 10,000 req/s이고 초과 시 429를 반환한다.

### Route 53

100% 가용성 SLA를 가진 권한 있는 DNS다. Alias 레코드는 ALB·CloudFront·API Gateway 같은 AWS 자원을 가리키며 zone apex에도 붙고 무료다. CNAME은 zone apex에 쓸 수 없다. 라우팅 정책은 Simple·Weighted·Latency·Failover·Geolocation·Geoproximity·IP-based·Multi-Value이며, Latency는 측정된 지연으로, Geolocation은 요청자 위치로 고른다.

## 코드

프라이빗 S3 오리진 앞의 CloudFront에서 10분간 유효한 Signed URL을 발급하는 Spring 서비스다. AWS SDK v2의 `cloudfront` 모듈을 사용한다.

```java
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.cloudfront.CloudFrontUtilities;
import software.amazon.awssdk.services.cloudfront.model.CannedSignerRequest;

@Service
public class SignedUrlService {

    private final CloudFrontUtilities utilities = CloudFrontUtilities.create();
    private final NetworkProperties props;

    public SignedUrlService(NetworkProperties props) {
        this.props = props;
    }

    public String signFor(String objectKey) {
        CannedSignerRequest request = CannedSignerRequest.builder()
                .resourceUrl("https://" + props.distributionDomain() + "/" + objectKey)
                .privateKey(Path.of(props.privateKeyPath()))
                .keyPairId(props.keyPairId())
                .expirationDate(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();
        return utilities.getSignedUrlWithCannedPolicy(request).url();
    }
}
```

API Gateway 뒤의 서비스를 호출할 때 429 응답을 지수 백오프로 재시도하는 `RestClient` 클라이언트다. `x-api-key`는 Usage Plan 매칭용이며 인증은 별도 IAM 서명이나 Cognito 토큰으로 처리한다.

```java
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

@Component
public class InventoryClient {

    private final RestClient client;

    public InventoryClient(RestClient.Builder builder, NetworkProperties props) {
        this.client = builder
                .baseUrl(props.inventoryApiBase())
                .defaultHeader("x-api-key", props.inventoryApiKey())
                .build();
    }

    @Retryable(
            retryFor = HttpClientErrorException.TooManyRequests.class,
            maxAttempts = 4,
            backoff = @Backoff(delay = 200, multiplier = 2.0, random = true))
    public StockResponse stock(String sku) {
        return client.get()
                .uri("/prod/stock/{sku}", sku)
                .retrieve()
                .body(StockResponse.class);
    }
}
```

## 실무에서 걸리는 지점

- NAT Gateway 데이터 처리 요금은 S3·DynamoDB 트래픽에서 가장 크게 불어난다. 두 서비스는 무료인 Gateway Endpoint로 빼면 NAT 비용과 인터넷 경유를 동시에 없앤다.
- NAT Gateway를 AZ 하나에만 두면 다른 AZ 트래픽이 AZ 간 요금을 내며 건너가고, 그 AZ가 죽으면 아웃바운드가 전부 끊긴다. AZ별 NAT와 라우팅 테이블을 짝짓는다.
- CloudFront 무효화는 월 1,000건까지 무료지만 배포마다 `/*`를 호출하면 캐시 효과가 사라진다. 정적 자산은 해시 파일명으로 버전을 관리한다.
- 오리진 교체 전에 TTL을 미리 낮추지 않으면 클라이언트가 예전 IP를 TTL 만큼 붙든다. 작업 전날 60초로 낮추고 안정화 뒤 되돌린다.
- Direct Connect는 개통까지 한 달 이상 걸린다. 개통 전에는 Site-to-Site VPN으로 연결하고 개통 후에도 백업 경로로 유지한다.

## 관련 글

- [ELB와 Auto Scaling](/notes/aws/elb-autoscaling/)
- [S3 — Object Lock·Access Points·CloudFront·Lambda 통합](/notes/aws/s3-advanced-cloudfront/)
- [Lambda·SAM·Step Functions·ECS·Fargate](/notes/aws/lambda-serverless-containers/)
