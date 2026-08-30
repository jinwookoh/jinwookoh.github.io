---
title: "Scaling·Scheduling·Probes"
series: infra
part: "Kubernetes"
order: 5
summary: "HPA·Probe·Affinity·Taint·Quota로 Pod의 수·건강·배치·자원을 자동 제어하는 원리와 함정을 정리한다"
tags: [Kubernetes, HPA, Probe, Affinity, Taint]
sources: [2026-05-03-k8s-scaling-scheduling.md]
updated: 2026-08-30
---

replicas를 고정해 두면 트래픽이 늘 때 사람이 숫자를 고쳐야 하고, 줄어도 비용이 남는다. 프로세스가 데드락에 빠져도 kubelet은 모른 채 트래픽을 흘려보낸다. 배치 기준이 없으면 replicas 3개가 한 노드에 모여 노드 장애 한 번에 서비스가 내려가고, 한 팀이 namespace 자원을 다 쓰면 다른 팀의 Pod이 Pending에 걸린다. ==자동 확장·Probe·스케줄링 제어·자원 한도가 이 네 문제를 맡는다.==

## 핵심 개념

### 자동 확장 3계층

| 계층 | 조정 대상 |
|:---|:---|
| HPA | Pod 수 |
| VPA | Pod의 requests·limits |
| Cluster Autoscaler | 노드 수 |

HPA(`autoscaling/v2`)는 Metrics Server가 수집한 CPU·메모리 사용률 평균을 목표값과 비교해 `minReplicas`~`maxReplicas` 범위에서 replicas를 조정한다. 사용률은 `requests` 대비 비율이다. Prometheus Adapter를 두면 커스텀 메트릭(`type: Pods`)으로도 확장한다. `behavior`로 scaleDown 안정화 창과 변화율을 제한해 진동을 막는다. VPA는 requests·limits를 다시 계산하며 `updateMode: Auto`면 Pod을 재생성한다. Cluster Autoscaler는 자원 부족으로 Pending인 Pod이 생기면 노드를 추가하고 비면 제거한다. 일반적인 조합은 HPA + Cluster Autoscaler다.

### Probe 3종

| Probe | 질문 | 실패 시 |
|:---|:---|:---|
| Liveness | 살아 있는가 | 컨테이너 재시작 |
| Readiness | 트래픽을 받을 수 있는가 | Service Endpoints에서 제외, 재시작 없음 |
| Startup | 기동이 끝났는가 | 재시작. 성공 전까지 나머지 두 Probe 비활성 |

Liveness는 프로세스는 살아 있지만 복구 불가능한 상태를 잡는다. Readiness는 워밍업 중이거나 외부 의존이 끊긴 상황에서 트래픽만 끊는다. ==Startup은 기동이 긴 앱에 `failureThreshold × periodSeconds` 만큼 유예를 주어 Liveness가 기동 중인 컨테이너를 죽이지 못하게 막는다.== 검사 방식은 `httpGet`·`tcpSocket`·`exec`·`grpc`다.

### 스케줄링 제어 4가지

`nodeSelector`는 노드 라벨의 단순 일치다. `nodeAffinity`는 `In`·`Exists` 연산자와 `required`(필수)·`preferred`(가중치 선호)를 구분한다. `podAffinity`/`podAntiAffinity`는 다른 Pod의 라벨을 기준으로 같은 `topologyKey`에 모으거나 흩는다. Taint/Toleration은 반대로 노드가 받아들일 Pod을 제한한다. Effect는 `NoSchedule`(신규 거부), `PreferNoSchedule`(가능하면 거부), `NoExecute`(기존 Pod도 추방)다. Affinity는 Pod 관점, Taint는 노드 관점이며 함께 쓴다.

### 자원·가용성 정책

`ResourceQuota`는 namespace 단위로 requests·limits 합계와 Pod·PVC 개수의 상한을 둔다. `LimitRange`는 컨테이너별 기본값과 최소·최대를 강제한다. `PodDisruptionBudget`은 drain 같은 자발적 중단 시 `minAvailable` 또는 `maxUnavailable`을 지킨다. `PriorityClass`는 자원이 모자랄 때 낮은 우선순위 Pod을 선점(preemption)한다.

## 코드

Spring Boot 3.x Actuator의 liveness·readiness 그룹을 Probe 엔드포인트로 노출한다.

```yaml
# application.yml
management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState, db, redis
  endpoints:
    web:
      exposure:
        include: health
```

외부 캐시가 끊겼을 때 재시작 대신 트래픽만 빼도록 Readiness 상태를 이벤트로 바꾼다.

```java
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

@Component
public class CacheHealthWatcher {

    private final ApplicationEventPublisher publisher;

    public CacheHealthWatcher(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    public void onCacheDisconnected() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
    }

    public void onCacheRecovered() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.ACCEPTING_TRAFFIC);
    }
}
```

Deployment에 Probe 3종·AntiAffinity를 지정하고 HPA·PDB를 붙인다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: order-api }
  template:
    metadata:
      labels: { app: order-api }
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels: { app: order-api }
              topologyKey: kubernetes.io/hostname
      tolerations:
        - key: dedicated
          operator: Equal
          value: api
          effect: NoSchedule
      containers:
        - name: app
          image: registry.local/order-api:1.4.0
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits: { memory: 1Gi }
          startupProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            periodSeconds: 5
            failureThreshold: 24
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            periodSeconds: 5
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-api
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 10, periodSeconds: 60 }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-api
spec:
  minAvailable: 2
  selector:
    matchLabels: { app: order-api }
```

## 실무에서 걸리는 지점

- ==**Liveness에 외부 의존을 넣으면 연쇄 재시작이 난다.**== DB가 잠시 끊겼을 때 모든 Pod이 동시에 재시작되고 복구 후 커넥션 폭주가 따른다. 외부 의존은 Readiness 그룹에만 두고 Liveness는 프로세스 상태만 본다.
- **Startup Probe 없이 JVM 앱을 올리면 기동 중에 죽는다.** `initialDelaySeconds`로 버티는 방식은 기동 시간이 늘면 깨진다. `failureThreshold × periodSeconds`를 최악의 기동 시간보다 넉넉히 잡는다.
- **HPA는 CPU requests가 없으면 동작하지 않는다.** 사용률 분모가 requests이므로 생략하면 메트릭이 `unknown`이 된다. VPA와 HPA를 같은 메트릭에 동시에 걸면 서로 반대 방향으로 조정해 충돌한다.
- **PDB와 AntiAffinity가 drain을 막을 수 있다.** `minAvailable: 2`에 replicas 2면 drain이 끝나지 않고, `required` AntiAffinity는 노드보다 replicas가 많으면 Pending을 만든다. 노드가 적으면 `preferred`로 완화한다.
- **JVM 힙과 limits를 맞추지 않으면 OOMKilled가 반복된다.** limits는 컨테이너 전체 RSS 기준이므로 `-XX:MaxRAMPercentage`로 힙 비율을 지정하고 메타스페이스 여유를 남긴다.

## 관련 글

- [Workloads — Deployment·StatefulSet·DaemonSet·Job](/notes/infra/k8s-workloads/)
- [Services·Networking·Ingress](/notes/infra/k8s-services-networking/)
- [Helm과 실전 운영 — 매니지드 K8s·CI/CD·Observability](/notes/infra/k8s-helm-real-world/)
