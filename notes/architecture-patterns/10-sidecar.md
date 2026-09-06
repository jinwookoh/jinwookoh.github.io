---
title: "사이드카 — 횡단 관심사를 보조 프로세스로 분리"
series: architecture-patterns
part: "서비스 통신"
order: 10
summary: "인증·로깅·트레이싱을 앱 프로세스 밖의 보조 컨테이너로 옮기면 언어와 무관하게 한 번에 바꿀 수 있다"
tags: [Sidecar, Service Mesh, Envoy, Istio, Kubernetes]
sources: [https://jinwookoh.tistory.com/244]
updated: 2026-09-06
---

마이크로서비스는 모두 인증, 로깅, 메트릭, 분산 트레이싱, 재시도 같은 공통 기능을 갖는다. 이 기능을 라이브러리로 만들어 각 서비스에 의존성으로 넣는 방식은 언어가 하나일 때만 유지된다. Java, Node.js, Go가 섞이는 순간 같은 기능을 세 번 구현하고 세 번 검증해야 하며, 로그 포맷이나 mTLS 정책을 바꾸는 작업이 수백 개 서비스의 재배포로 번진다. 라이브러리 버전이 서비스마다 갈리면 어느 서비스가 어떤 정책을 따르는지 파악하는 일 자체가 운영 부담이 된다. 사이드카 패턴은 이 공통 기능을 애플리케이션 프로세스 밖으로 꺼내 같은 배포 단위 안의 별도 프로세스에 맡긴다.

## 핵심 개념

사이드카는 애플리케이션 컨테이너와 같은 Pod에 배치되는 보조 컨테이너다. 같은 Pod에 있으므로 네트워크 네임스페이스를 공유해 `localhost`로 통신하고, 볼륨을 공유해 파일을 주고받으며, 생명주기가 Pod에 묶여 함께 뜨고 함께 내려간다. 애플리케이션은 사이드카의 존재를 알 필요가 없다. 이 투명성이 언어 독립성의 근거다.

역할에 따라 두 부류로 나뉜다. 첫째는 프록시형이다. Envoy 같은 프록시가 Pod로 들어오고 나가는 모든 트래픽을 가로채 mTLS, 인증 토큰 검증, 재시도, 타임아웃, 서킷 브레이커, 접근 로그, 메트릭 수집을 처리한다. Istio는 iptables 규칙으로 트래픽을 프록시로 우회시키므로 애플리케이션은 평소처럼 서비스 이름으로 요청을 보낼 뿐이다. 서비스 A가 B를 호출하면 경로는 A 앱 → A 프록시 → B 프록시 → B 앱이 되고, 두 프록시 사이 구간이 암호화와 정책 적용의 지점이다. 둘째는 보조형이다. 공유 볼륨의 로그 파일을 읽어 수집기로 보내는 Fluent Bit, 시크릿을 파일로 내려주는 Vault Agent, 설정 변경을 감시해 리로드하는 컨테이너가 여기 속한다.

Kubernetes 1.29부터는 `initContainers`에 `restartPolicy: Always`를 지정하는 네이티브 사이드카가 정식 기능이다. 일반 컨테이너보다 먼저 시작해 준비 상태가 될 때까지 앱 컨테이너를 기다리게 하고, 앱 컨테이너가 종료된 뒤에 함께 종료된다. 그 전까지는 두 컨테이너의 기동 순서를 보장할 방법이 없어 별도 우회가 필요했다.

| 구분 | 라이브러리 | 사이드카 |
|---|---|---|
| 실행 위치 | 앱 프로세스 내부 | 같은 Pod의 별도 컨테이너 |
| 언어 지원 | 언어별 구현 필요 | 언어 무관 |
| 정책 변경 | 코드 수정 후 전체 재배포 | 사이드카 이미지·설정 교체 |
| 호출 비용 | 함수 호출 | localhost 홉 추가 |
| 자원 | 앱에 포함 | Pod마다 컨테이너 하나 추가 |

## 코드

네이티브 사이드카로 Envoy와 로그 수집기를 붙인 Pod 정의다. 앱은 공유 볼륨에 로그 파일만 쓰고, 수집기가 그 파일을 읽어 전송한다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-service
spec:
  initContainers:
    - name: envoy
      image: envoyproxy/envoy:v1.31.0
      restartPolicy: Always
      args: ["-c", "/etc/envoy/envoy.yaml"]
      volumeMounts:
        - name: envoy-config
          mountPath: /etc/envoy
    - name: log-shipper
      image: fluent/fluent-bit:3.1
      restartPolicy: Always
      volumeMounts:
        - name: app-logs
          mountPath: /var/log/app
  containers:
    - name: app
      image: order-service:1.4.0
      ports:
        - containerPort: 8080
      volumeMounts:
        - name: app-logs
          mountPath: /var/log/app
  volumes:
    - name: app-logs
      emptyDir: {}
    - name: envoy-config
      configMap:
        name: envoy-config
```

Spring Boot 쪽은 로그를 공유 볼륨에 구조화된 형식으로 쓰고, 트레이스 컨텍스트를 W3C 헤더로 전파하도록 설정한다. 프록시가 스팬을 만들더라도 들어온 요청과 나가는 요청을 잇는 것은 앱의 몫이다.

```yaml
logging:
  file:
    name: /var/log/app/app.log
  structured:
    format:
      file: ecs
management:
  tracing:
    propagation:
      type: w3c
    sampling:
      probability: 1.0
```

서비스 호출 코드에는 사이드카 관련 내용이 없다. 자동 구성된 `RestClient.Builder`를 쓰면 `traceparent` 헤더가 나가는 요청에 자동으로 붙고, mTLS와 재시도는 프록시가 처리한다.

```java
@Service
public class InventoryClient {

    private final RestClient restClient;

    public InventoryClient(RestClient.Builder builder) {
        this.restClient = builder
                .baseUrl("http://inventory-service")
                .build();
    }

    public InventoryResponse reserve(String sku, int quantity) {
        return restClient.post()
                .uri("/reservations")
                .body(new ReserveRequest(sku, quantity))
                .retrieve()
                .body(InventoryResponse.class);
    }
}
```

## 실무에서 걸리는 지점

- 트레이스 전파. ==프록시는 요청마다 스팬을 만들 뿐 들어온 요청과 나간 요청을 스스로 연결하지 못하므로, 앱이 `traceparent` 헤더를 그대로 넘기지 않으면 서비스 경계마다 트레이스가 끊긴다.== 수동으로 만든 `HttpClient`나 별도 스레드에서 보내는 요청이 흔한 누락 지점이다.
- 기동 순서. 네이티브 사이드카를 쓰지 않는 환경에서는 앱이 프록시보다 먼저 떠서 초기 외부 호출이 실패하고, 반대로 앱이 끝난 뒤에도 프록시가 남아 Job이 종료되지 않는다. ==Kubernetes 1.29 미만이거나 Istio 설정에서 `holdApplicationUntilProxyStarts`를 켜지 않았다면 기동 직후 실패에 대한 재시도가 앱 안에 있어야 한다.==
- 재시도 중복. ==프록시의 재시도와 앱의 Resilience4j 재시도가 동시에 켜져 있으면 실제 시도 횟수는 두 값의 곱이 되어 장애 중인 서비스로 트래픽이 증폭된다.== 재시도는 한 계층에서만 담당하도록 정한다.
- 자원과 지연. Pod마다 프록시 컨테이너가 추가되어 메모리 수십 MB와 CPU가 더 든다. 수천 개 Pod 규모에서는 무시할 수 없는 양이고, 호출마다 두 번의 프록시 홉이 추가되어 밀리초 단위 지연이 붙는다. 프록시 컨테이너의 requests와 limits를 명시하지 않으면 노드 스케줄링 계산이 어긋난다.
- 오류 출처 구분. 503이 앱에서 온 것인지 프록시가 업스트림 연결 실패로 만든 것인지 응답 본문만으로는 구분되지 않는다. Envoy 접근 로그의 response flags(`UF`, `UO`, `URX`)를 함께 수집해야 장애 원인을 프록시 계층과 앱 계층으로 나눌 수 있다.

## 관련 글

- [서비스 디스커버리 — 클라이언트 사이드와 서버 사이드](/notes/architecture-patterns/service-discovery/)
- [서킷 브레이커 — 연쇄 장애를 끊는 세 가지 상태](/notes/architecture-patterns/circuit-breaker/)
- [재시도 — 지수 백오프와 지터](/notes/architecture-patterns/retry/)
