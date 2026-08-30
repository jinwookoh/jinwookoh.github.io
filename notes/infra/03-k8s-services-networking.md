---
title: "Services·Networking·Ingress"
series: infra
part: "Kubernetes"
order: 3
summary: "Pod IP가 바뀌어도 접근 경로를 유지하는 Service·DNS·Ingress의 역할 분담과 노출 방식별 선택 기준"
tags: [Kubernetes, Service, Ingress, CoreDNS, CNI]
sources: [2026-05-03-k8s-services-networking.md]
updated: 2026-08-30
---

Pod IP는 일회용이다. Pod가 재시작되거나 Deployment가 스케일을 바꾸면 IP가 새로 할당되고, 이전 IP는 사라진다. 클라이언트가 Pod IP를 직접 들고 있으면 매 변경마다 목록을 다시 받아야 하고, 롤링 업데이트 중에는 절반쯤 죽은 IP로 요청을 보내게 된다. 외부 트래픽의 진입 지점과 TLS 종료, 도메인별 라우팅도 Pod 단위로는 정의되지 않는다. Kubernetes는 이 문제를 Service(안정적인 가상 IP와 DNS 이름), CoreDNS(이름 해석), Ingress(L7 HTTP 라우팅)의 세 층으로 나누어 해결한다.

## 핵심 개념

Service는 라벨 셀렉터로 Pod 집합을 고르고, 그 앞에 고정된 ClusterIP와 DNS 이름을 붙인다. 셀렉터에 매칭되는 Pod IP 목록은 EndpointSlice 객체에 기록되며 컨트롤러가 자동으로 갱신한다. Readiness Probe에 실패한 Pod는 EndpointSlice에서 빠지므로 Service를 통한 트래픽을 받지 않는다. 패킷 전달은 각 노드의 kube-proxy가 iptables 또는 IPVS 규칙으로 ClusterIP를 Pod IP로 DNAT해 처리한다.

Service 타입은 네 가지이고 노출 범위가 다르다.

| 타입 | 접근 범위 | 용도 |
|:---|:---|:---|
| ClusterIP | 클러스터 내부 | 기본값. 서비스 간 통신 |
| NodePort | 모든 노드의 30000~32767 포트 | 개발·테스트, LB 뒤의 백엔드 |
| LoadBalancer | 클라우드 LB의 공개 IP | 단일 서비스의 L4 노출 |
| ExternalName | 내부 이름을 외부 도메인 CNAME으로 매핑 | 외부 시스템을 내부 이름으로 참조 |

LoadBalancer는 클라우드 컨트롤러가 ELB·GCLB 같은 자원을 프로비저닝해야 동작하므로 온프레미스에서는 MetalLB 같은 구현체가 필요하다. Service 하나당 LB 하나가 생기므로 HTTP 서비스가 여러 개면 Ingress로 묶는다.

CoreDNS는 kube-system 네임스페이스의 Deployment로 동작하며 `<svc>.<ns>.svc.cluster.local` 형식의 이름을 ClusterIP로 해석한다. 같은 네임스페이스에서는 `<svc>`만으로, 다른 네임스페이스에서는 `<svc>.<ns>`까지 쓰면 된다. Headless Service(`clusterIP: None`)는 Pod IP 목록을 A 레코드로 직접 반환해 StatefulSet의 개별 Pod 주소를 얻을 때 쓴다.

Ingress는 host와 path 규칙으로 HTTP 요청을 여러 Service에 분배하는 L7 리소스다. Ingress 리소스는 선언일 뿐이고, 실제 트래픽은 NGINX Ingress·Traefik·HAProxy·AWS ALB Controller 같은 Ingress Controller가 처리한다. Controller가 없으면 리소스를 만들어도 동작하지 않으며, `ingressClassName`으로 담당 Controller를 지정한다. TLS 종료는 `tls` 항목에 인증서 Secret을 연결해 Controller 단에서 수행한다. 헤더 기반 매칭과 gRPC·TCP 라우팅은 후속 표준인 Gateway API가 맡는다.

Pod가 노드를 넘어 NAT 없이 서로 통신하는 것은 CNI 플러그인이 보장한다. Calico는 BGP 기반으로 NetworkPolicy 지원이 강하고, Cilium은 eBPF로 L7 정책까지 다루며, Flannel은 오버레이만 제공한다. CNI는 클러스터 생성 시 결정되며 운영 중 교체는 재구축에 가깝다.

## 코드

ClusterIP Service와 이를 path 기준으로 노출하는 Ingress 정의다. `port`는 Service 포트, `targetPort`는 Pod 컨테이너 포트를 가리킨다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-api
spec:
  selector:
    app: order-api
  ports:
    - name: http
      port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: nginx
  tls:
    - hosts: [shop.example.internal]
      secretName: shop-tls
  rules:
    - host: shop.example.internal
      http:
        paths:
          - path: /orders
            pathType: Prefix
            backend:
              service:
                name: order-api
                port:
                  number: 80
```

Spring Boot 3.x 서비스가 다른 Service를 호출할 때는 IP가 아니라 DNS 이름을 base URL로 쓴다. RestClient는 Spring 6.1부터 제공되는 동기 클라이언트다.

```java
@Configuration
public class InventoryClientConfig {

    @Bean
    RestClient inventoryClient(RestClient.Builder builder,
                               @Value("${inventory.base-url:http://inventory-api.shop.svc.cluster.local}") String baseUrl) {
        return builder.baseUrl(baseUrl).build();
    }
}

@Service
public class InventoryGateway {

    private final RestClient client;

    public InventoryGateway(RestClient inventoryClient) {
        this.client = inventoryClient;
    }

    public int available(String sku) {
        return client.get()
                .uri("/stock/{sku}", sku)
                .retrieve()
                .body(StockResponse.class)
                .quantity();
    }

    record StockResponse(String sku, int quantity) {}
}
```

Readiness 상태가 EndpointSlice에 반영되도록 Actuator의 readiness 그룹을 Pod 프로브와 연결한다.

```yaml
# application.yml
management:
  endpoint:
    health:
      probes:
        enabled: true
  endpoints:
    web:
      exposure:
        include: health
```

```yaml
# Deployment 컨테이너 스펙 일부
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  periodSeconds: 5
```

## 실무에서 걸리는 지점

- Service는 있는데 `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` 결과가 비어 있으면 셀렉터와 Pod 라벨 불일치이거나 Readiness 실패다.
- kube-proxy의 iptables 모드는 연결 단위 랜덤 분배이므로 keep-alive를 오래 유지하는 클라이언트는 특정 Pod에 몰린다. HTTP/2·gRPC는 클라이언트 측 로드밸런싱이나 Service Mesh 없이는 스케일아웃 효과가 거의 없다.
- `externalTrafficPolicy: Local`을 켜면 클라이언트 IP가 보존되지만 해당 노드에 Pod가 없으면 요청이 버려진다.
- Ingress의 `rewrite-target` 같은 어노테이션은 Controller 구현마다 이름과 의미가 다르다. Controller를 교체하면 무시되거나 오동작하므로 어노테이션 전수 점검이 필요하다.
- 클러스터 내부 DNS 조회는 기본 `ndots:5` 설정 때문에 외부 도메인 하나에 여러 번의 검색 도메인 시도를 거친다. 외부 호출이 많으면 FQDN 끝에 점을 붙이거나 dnsConfig로 ndots를 낮춘다.

## 관련 글

- [Workloads — Deployment·StatefulSet·DaemonSet·Job](/notes/infra/k8s-workloads/)
- [Scaling·Scheduling·Probes](/notes/infra/k8s-scaling-scheduling/)
- [Security — RBAC·NetworkPolicy](/notes/infra/k8s-security/)
