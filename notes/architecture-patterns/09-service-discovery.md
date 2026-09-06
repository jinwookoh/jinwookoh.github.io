---
title: "서비스 디스커버리 — 클라이언트 사이드와 서버 사이드"
series: architecture-patterns
part: "서비스 통신"
order: 9
summary: "동적으로 바뀌는 인스턴스 주소를 레지스트리로 관리하고, 그 레지스트리를 클라이언트가 볼지 인프라가 볼지 결정한다"
tags: [Service Discovery, Eureka, Kubernetes, Spring Cloud LoadBalancer, Load Balancing]
sources: [https://jinwookoh.tistory.com/242]
updated: 2026-09-06
---

온프레미스 환경에서는 서버 IP가 고정되어 있어 호출 대상 주소를 설정 파일에 적어 두는 것으로 충분했다. 컨테이너 환경에서는 인스턴스가 배포·스케일 아웃·장애 교체 때마다 새 IP를 받으므로 설정에 적힌 주소는 곧 무효가 된다. 인스턴스 수가 늘어나면 어느 주소가 살아 있는지 클라이언트가 알 방법도 없다. 그래서 현재 살아 있는 인스턴스 목록을 유지하는 서비스 레지스트리가 필요하고, 설계의 핵심은 그 레지스트리를 누가 조회하느냐로 갈린다.

## 핵심 개념

서비스 레지스트리는 서비스 이름을 키로 인스턴스 주소 목록을 보관한다. 인스턴스는 기동 시 자신을 등록하고 주기적으로 하트비트를 보내며, 하트비트가 끊긴 인스턴스는 일정 시간 뒤 목록에서 제거된다. 등록 주체에 따라 인스턴스가 직접 등록하는 자기 등록 방식과 오케스트레이터가 대신 등록하는 제3자 등록 방식으로 나뉜다.

클라이언트 사이드 디스커버리는 호출자가 레지스트리를 직접 조회해 인스턴스 하나를 고르고 그 주소로 바로 요청한다. Netflix Eureka와 Spring Cloud LoadBalancer 조합이 대표적이다. 로드 밸런싱 알고리즘이 클라이언트 안에서 동작하므로 중간 홉이 없고, 호출자가 인스턴스별 상태를 반영해 대상을 고를 수 있다. 대신 디스커버리 라이브러리가 애플리케이션 코드에 들어오며, 언어마다 구현을 따로 갖춰야 한다.

서버 사이드 디스커버리는 호출자가 고정된 이름이나 가상 IP로 요청을 보내고, 라우터나 로드 밸런서가 레지스트리를 조회해 실제 인스턴스로 전달한다. Kubernetes Service, AWS ALB의 타깃 그룹, Nginx 업스트림이 이 방식이다. 클라이언트는 `http://payment-service` 같은 이름만 알면 되므로 언어와 무관하게 동작하고 코드가 단순해진다. 대신 홉이 하나 추가되고, 로드 밸런서 자체가 가용성의 병목이 된다.

| 구분 | 클라이언트 사이드 | 서버 사이드 |
|---|---|---|
| 조회 주체 | 호출 서비스 | 로드 밸런서·라우터 |
| 의존성 | 언어별 라이브러리 | 인프라(Kubernetes, ELB) |
| 경로 | 직접 호출 | 로드 밸런서 경유 |
| 적합한 상황 | 인프라를 제어할 수 없는 환경 | 컨테이너 오케스트레이터 위 |

Kubernetes에서는 Service가 셀렉터로 Pod를 골라 Endpoints 목록을 만들고, kube-proxy가 iptables나 IPVS 규칙으로 ClusterIP 요청을 Pod로 분산한다. 클러스터 DNS가 `payment-service.default.svc.cluster.local` 형태의 이름을 ClusterIP로 풀어 준다. ==Endpoints에는 readiness probe를 통과한 Pod만 포함되므로 probe가 없으면 기동 중인 Pod에도 트래픽이 들어간다.==

## 코드

Spring Boot 3.x에서는 `spring-cloud-starter-netflix-eureka-client`를 의존성에 추가하면 별도 애너테이션 없이 등록과 조회가 활성화된다. Eureka 서버 주소와 인스턴스 식별 방식을 설정한다.

```yaml
spring:
  application:
    name: order-service
eureka:
  client:
    service-url:
      defaultZone: http://eureka:8761/eureka/
  instance:
    prefer-ip-address: true
    lease-renewal-interval-in-seconds: 10
    lease-expiration-duration-in-seconds: 30
```

`RestClient.Builder`에 `@LoadBalanced`를 붙이면 Spring Cloud LoadBalancer가 서비스 이름을 레지스트리에서 찾은 인스턴스 주소로 치환한다. Ribbon과 RestTemplate은 유지보수가 종료되었으므로 사용하지 않는다.

```java
@Configuration
public class PaymentClientConfig {

    @Bean
    @LoadBalanced
    RestClient.Builder loadBalancedRestClientBuilder() {
        return RestClient.builder();
    }

    @Bean
    RestClient paymentRestClient(RestClient.Builder builder) {
        return builder.baseUrl("http://payment-service").build();
    }
}

@Service
public class PaymentGateway {

    private final RestClient client;

    public PaymentGateway(RestClient paymentRestClient) {
        this.client = paymentRestClient;
    }

    public PaymentResult pay(PaymentRequest request) {
        return client.post()
                .uri("/payments")
                .body(request)
                .retrieve()
                .body(PaymentResult.class);
    }
}
```

Kubernetes에서는 Service 하나와 Deployment의 readiness probe로 같은 역할을 인프라에 넘긴다. 애플리케이션은 `http://payment-service`를 그대로 호출한다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-service
spec:
  selector:
    app: payment
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment
  template:
    metadata:
      labels:
        app: payment
    spec:
      containers:
        - name: payment
          image: payment:1.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            periodSeconds: 5
```

## 실무에서 걸리는 지점

- **Eureka의 전파 지연.** 하트비트 30초, 서버 응답 캐시 30초, 클라이언트 로컬 캐시 30초, 만료 판정 90초가 기본값이다. ==기본 설정에서는 인스턴스가 죽은 뒤 최대 2분 가까이 목록에 남아 있으므로 그 사이 요청은 실패한다.== graceful shutdown으로 종료 전 등록을 해제하고, 클라이언트 쪽에 재시도를 두어 창을 줄인다.
- **Self-preservation 모드.** 일정 시간 동안 수신한 하트비트가 기대치의 85% 미만이면 Eureka 서버는 네트워크 분단으로 판단하고 만료 처리를 중단한다. ==인스턴스가 몇 개 없는 소규모 클러스터에서는 하나만 죽어도 이 모드가 켜져 죽은 인스턴스가 목록에서 사라지지 않는다.== 운영 환경에서 임계값을 조정하거나 인스턴스 수를 충분히 확보한다.
- **Kubernetes Service는 L4 분산이다.** 커넥션 단위로 분산하므로 gRPC나 HTTP/2처럼 연결 하나를 오래 재사용하는 프로토콜은 ==요청이 특정 Pod로 편중되고 스케일 아웃해도 새 Pod에 트래픽이 가지 않는다.== 헤드리스 Service로 Pod 주소를 직접 받아 클라이언트가 분산하거나, 서비스 메시의 L7 프록시를 쓴다.
- **두 방식의 혼용.** Kubernetes 위에 Eureka를 올리면 레지스트리가 두 벌이 되고, Pod IP를 Eureka에 등록하는 과정에서 Service의 readiness 게이팅을 우회한다. 오케스트레이터가 있는 환경에서는 Eureka를 제거하고 Service로 통일하는 편이 관리 비용이 낮다.
- **레지스트리 장애.** Eureka 클라이언트는 마지막으로 받은 목록을 로컬에 캐시하므로 레지스트리가 내려가도 기존 인스턴스 호출은 유지된다. 다만 그 사이 인스턴스 변경은 반영되지 않으므로 레지스트리 복구 시간이 곧 목록의 최대 오차가 된다.

## 관련 글

- [API 게이트웨이 — 단일 진입점과 BFF](/notes/architecture-patterns/api-gateway/)
- [헬스 체크 — Liveness와 Readiness](/notes/architecture-patterns/health-check/)
- [사이드카 — 횡단 관심사를 보조 프로세스로 분리](/notes/architecture-patterns/sidecar/)
