---
title: "Kubernetes 아키텍처와 Pod"
series: infra
part: "Kubernetes"
order: 1
summary: "Control Plane과 Worker Node가 선언된 상태를 어떻게 유지하는지, 그 최소 단위인 Pod이 왜 휘발성인지 정리한다."
tags: [Kubernetes, Control Plane, etcd, Pod, Sidecar]
sources: [2026-05-03-k8s-architecture.md, 2026-05-03-k8s-pod.md]
updated: 2026-08-30
---

컨테이너 한두 개는 `docker run`으로 충분하다. 문제는 컨테이너가 여러 서버에 걸쳐 수십 개를 넘어갈 때 생긴다. 죽은 프로세스의 재시작, 부하에 따른 증감, 무중단 배포, IP가 바뀐 컨테이너의 탐색을 수동으로 처리하는 순간 운영은 사람의 반응 속도에 묶인다. Kubernetes는 "이 상태로 유지하라"는 선언을 받아 클러스터가 스스로 그 상태로 수렴하게 만드는 시스템이다.

## 핵심 개념

### Desired State와 Reconciliation Loop

Kubernetes의 모든 동작은 선언형이다. 사용자는 YAML로 원하는 상태를 제출하고, 컨트롤러는 현재 상태와의 차이를 찾아 리소스를 만들거나 지워 좁힌다. 이 무한 반복이 Reconciliation Loop이며, 자가 치유·수평 확장·롤링 업데이트는 전부 이 루프의 결과물이다.

### Control Plane

| 컴포넌트 | 역할 |
|:---|:---|
| kube-apiserver | 모든 요청의 유일한 진입점. 인증·인가·검증 후 etcd에 기록한다. 자체 상태가 없어 수평 확장 가능하다. |
| etcd | Raft 합의 기반 분산 키-값 저장소. 클러스터의 모든 상태를 보관한다. |
| kube-scheduler | 노드 미배정 Pod을 자원 여유·라벨·Affinity·Taint/Toleration 기준으로 배치할 노드를 결정한다. 실행은 하지 않는다. |
| kube-controller-manager | Node·ReplicaSet·Endpoint 등 수십 개 컨트롤러를 한 프로세스로 묶은 것. 각각 Reconciliation Loop를 돈다. |

API Server는 stateless이고 etcd가 단일 진실이므로, etcd를 잃으면 클러스터 전체를 잃는다. 운영 환경에서 etcd를 홀수 노드로 구성하고 정기 스냅샷을 남기는 이유다.

### Worker Node

kubelet은 자기 노드에 배정된 Pod 명세를 받아 Container Runtime에 실행을 지시하고 상태와 Probe 결과를 보고하는 노드 에이전트다. kube-proxy는 Service 트래픽을 Pod으로 보내는 iptables 또는 IPVS 규칙을 관리한다. Container Runtime은 CRI를 구현한 containerd나 CRI-O를 쓴다. 1.24에서 dockershim이 제거되어 Docker Engine은 런타임으로 쓰지 않는다.

kube-proxy와 CNI는 층위가 다르다. CNI는 Pod에 IP를 부여하고 노드 간 Pod 네트워크를 구성하며, kube-proxy는 그 위에서 Service 라우팅만 담당한다.

### Pod

Kubernetes는 컨테이너를 직접 다루지 않는다. 스케줄링·자원 할당·생명주기의 단위는 Pod이다. Pod은 하나 이상의 컨테이너와 그들이 공유하는 네트워크·IPC 네임스페이스·볼륨의 묶음이다. 같은 Pod 안의 컨테이너는 하나의 IP를 공유하고 localhost로 통신한다. 네임스페이스의 실제 소유자는 숨겨진 pause 컨테이너이며, 애플리케이션 컨테이너가 재시작돼도 Pod IP가 유지되는 이유다.

Pod phase는 Pending·Running·Succeeded·Failed·Unknown 다섯 가지다. 각 컨테이너는 별도의 ready 플래그를 가지며, Pod이 Running이어도 readiness probe가 실패하면 Service는 트래픽을 보내지 않는다.

멀티 컨테이너 Pod은 생명주기를 함께해야 하는 것만 묶는다. Sidecar 패턴은 로그 수집기·메시 프록시를 주 컨테이너 옆에 두고 emptyDir이나 localhost로 연결한다. Init Container는 메인보다 먼저 순차 실행되며, 실패하면 메인은 시작되지 않고 backoff 재시도에 들어간다.

Pod은 휘발성이다. 재생성된 Pod은 새 IP와 이름을 받고 로컬 데이터는 사라진다. 그래서 Service와 DNS로 접근하고, 영속 데이터는 PersistentVolume에 둔다.

## 코드

Init Container로 PostgreSQL을 기다리고 Sidecar로 로그를 수집하는 Pod. requests는 스케줄링 기준, limits는 강제 상한이다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-api
  labels:
    app: order-api
spec:
  initContainers:
    - name: wait-for-db
      image: busybox:1.36
      command: ["sh", "-c", "until nc -z order-db 5432; do sleep 1; done"]
  containers:
    - name: app
      image: registry.example.com/order-api:1.4.2
      ports:
        - containerPort: 8080
      resources:
        requests:
          cpu: 250m
          memory: 512Mi
        limits:
          memory: 1Gi
      readinessProbe:
        httpGet:
          path: /actuator/health/readiness
          port: 8080
      livenessProbe:
        httpGet:
          path: /actuator/health/liveness
          port: 8080
      volumeMounts:
        - name: logs
          mountPath: /var/log/app
    - name: log-shipper
      image: fluent/fluent-bit:3.0
      volumeMounts:
        - name: logs
          mountPath: /var/log/app
          readOnly: true
  volumes:
    - name: logs
      emptyDir: {}
```

Spring Boot 3.x에서 위 Probe 경로를 Actuator로 노출하는 설정이다.

```yaml
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

캐시 워밍이 끝나기 전까지 readiness를 false로 유지해 Service 엔드포인트에서 제외시키는 코드.

```java
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

@Component
public class WarmupGate {

    private final ApplicationEventPublisher publisher;

    public WarmupGate(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    public void refuse() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
    }

    public void accept() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.ACCEPTING_TRAFFIC);
    }
}
```

## 실무에서 걸리는 지점

- **Memory limit 초과는 OOMKilled, CPU limit 초과는 throttle이다.** JVM은 기본으로 컨테이너 메모리의 25%만 힙으로 잡으므로 `-XX:MaxRAMPercentage`를 명시하고, limit은 메타스페이스·스레드 스택을 포함한 전체 footprint 기준으로 잡는다.
- **CPU limit은 JVM 시작을 늦춘다.** JIT가 throttle에 걸려 readiness까지 수십 초가 걸리고, 그 사이 liveness가 실패하면 재시작 루프에 빠진다. startupProbe로 시작 구간을 분리한다.
- **직접 만든 Pod은 노드 장애 시 복구되지 않는다.** restartPolicy는 같은 노드 안의 컨테이너 재시작만 다루며, 노드 간 재배치는 Deployment 같은 상위 컨트롤러의 몫이다.
- **Init Container가 멈추면 STATUS가 `Init:0/1`에 고정된다.** `kubectl logs <pod> -c <init-container>`로 원인을 본다.
- **Event 누적이 etcd를 키운다.** 잦은 재시작과 CronJob은 Event 객체를 대량으로 쌓아 API Server 응답을 늦춘다.

## 관련 글

- [Workloads — Deployment·StatefulSet·DaemonSet·Job](/notes/infra/k8s-workloads/)
- [Services·Networking·Ingress](/notes/infra/k8s-services-networking/)
- [Scaling·Scheduling·Probes](/notes/infra/k8s-scaling-scheduling/)
