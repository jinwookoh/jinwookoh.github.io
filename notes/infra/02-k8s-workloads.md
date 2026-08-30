---
title: "Workloads — Deployment·StatefulSet·DaemonSet·Job"
series: infra
part: "Kubernetes"
order: 2
summary: "Pod을 직접 만들지 않고 컨트롤러에 맡겨야 하는 이유와, 다섯 가지 Workload를 상황별로 고르는 기준을 정리한다"
tags: [Kubernetes, Deployment, StatefulSet, DaemonSet, Job]
sources: [2026-05-03-k8s-workloads.md]
updated: 2026-08-30
---

`kind: Pod`로 직접 만든 Pod은 노드 장애나 OOM으로 사라지면 되살아나지 않고, 복제본을 늘리거나 이미지를 바꾸려면 손으로 지우고 다시 띄워야 하며 그 사이 트래픽이 끊긴다. Kubernetes는 Pod을 감싸는 상위 컨트롤러, 즉 Workload 리소스로 이 문제를 푼다. 컨트롤러는 원하는 상태를 선언받고 실제 상태가 어긋나면 스스로 맞춘다. ==어떤 컨트롤러를 고르느냐가 복구·배포 방식과 스토리지·네트워크 정체성까지 결정한다.==

## 핵심 개념

다섯 Workload의 사용처는 Deployment는 상태 없는 앱, StatefulSet은 DB·Kafka 같은 상태 있는 앱, DaemonSet은 노드마다 1개, Job은 일회성 작업, CronJob은 스케줄 작업으로 요약된다.

**ReplicaSet과 Deployment.** ReplicaSet은 `selector`에 매칭되는 Pod 수를 `replicas`와 일치시키는 것만 한다. Deployment는 이 ReplicaSet을 버전별로 생성하는 상위 컨트롤러다. 이미지를 바꾸면 새 ReplicaSet으로 Pod을 옮겨 가고, 이전 ReplicaSet은 replicas 0으로 남겨 롤백에 쓴다. ==사용자는 Deployment만 다루고 ReplicaSet은 조회만 한다.==

**롤링 업데이트.** 기본 전략 `RollingUpdate`는 `maxSurge`(초과해 띄울 수 있는 Pod 수)와 `maxUnavailable`(동시에 내릴 수 있는 Pod 수)로 속도를 제어한다. 둘 다 0이면 진행할 방법이 없어 API 서버가 거부한다. `Recreate`는 전부 내린 뒤 새로 띄우므로 다운타임이 있지만 두 버전이 공존하면 안 되는 앱에는 이쪽이 맞다. 롤백은 `kubectl rollout undo`로 이전 ReplicaSet을 다시 키우는 것이라 즉시 끝난다.

**StatefulSet.** Deployment의 Pod은 무작위 이름을 받고 동시에 뜨며 스토리지를 공유하거나 갖지 않는다. StatefulSet은 `pg-0`, `pg-1`처럼 순번 이름을 부여하고 순서대로 시작해 역순으로 종료하며, `volumeClaimTemplates`로 Pod마다 별도 PVC를 만들어 재생성 후에도 같은 볼륨을 붙인다. `serviceName`의 Headless Service(`clusterIP: None`)와 결합하면 `pg-0.postgres-headless.<ns>.svc.cluster.local` 형태의 고정 DNS를 얻는다. 복제 토폴로지가 특정 멤버 주소에 의존하는 시스템에는 이 세 안정성이 모두 필요하다.

**DaemonSet.** `replicas` 없이 Pod 수가 노드 수를 따른다. 노드가 추가되면 자동 배포되고, 일부 노드에만 두려면 `nodeSelector`나 affinity를 쓴다.

**Job과 CronJob.** Job은 컨테이너가 exit 0으로 끝날 때까지 실행하고 실패하면 `backoffLimit`까지 재시도한다. `restartPolicy`는 `Never`·`OnFailure`만 허용된다. `completions`와 `parallelism`으로 병렬 배치를 표현한다. CronJob은 `schedule`에 맞춰 Job을 생성하며, 컨트롤 플레인이 멈춰 있던 시각의 실행은 `startingDeadlineSeconds`를 넘기면 건너뛴다.

## 코드

Deployment 매니페스트. `maxUnavailable: 0`으로 가용 Pod 수를 유지하면서 한 개씩 교체한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: order-api
    spec:
      containers:
        - name: app
          image: registry.local/order-api:1.4.0
          ports:
            - containerPort: 8080
```

StatefulSet과 Headless Service. PostgreSQL 3대에 각각 10Gi PVC를 붙이고 고정 DNS를 부여한다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres-headless
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 10Gi
```

Spring Boot 마이그레이션 앱을 Job으로 실행하는 예. 앱은 작업 후 명시적으로 종료 코드를 반환해야 Job이 성공·실패를 판정할 수 있다.

```java
@SpringBootApplication
public class MigrationApplication {

    public static void main(String[] args) {
        int code = SpringApplication.exit(
                SpringApplication.run(MigrationApplication.class, args));
        System.exit(code);
    }

    @Bean
    ApplicationRunner migrate(JdbcTemplate jdbc) {
        return args -> jdbc.execute("""
                ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz
                """);
    }

    @Bean
    ExitCodeGenerator exitCode() {
        return () -> 0;
    }
}
```

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: order-db-migration
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: registry.local/order-migration:1.4.0
```

## 실무에서 걸리는 지점

- **롤링 업데이트 중 두 버전 공존.** 교체가 끝날 때까지 구버전과 신버전이 같이 요청을 받는다. 스키마나 API 형식 변경은 양쪽이 읽을 수 있는 중간 단계를 거쳐야 하며, Canary·Blue-Green은 Argo Rollouts 같은 별도 컨트롤러가 필요하다. ==readinessProbe가 없으면 JVM이 준비되기 전에 옛 Pod이 내려가므로 `maxUnavailable: 0`도 무중단을 보장하지 못한다.==
- **StatefulSet의 PVC는 삭제되지 않는다.** StatefulSet을 지워도 PVC는 남아 비용이 계속 나간다. `persistentVolumeClaimRetentionPolicy`를 설정하거나 정리 절차를 문서화한다. `volumeClaimTemplates`는 생성 후 수정할 수 없어 용량 변경은 PVC를 직접 편집한다.
- **Job의 restartPolicy.** `OnFailure`는 같은 Pod에서 컨테이너를 재시작하고 `Never`는 새 Pod을 만든다. 실패 로그 보존에는 `Never`가 낫지만 Pod이 backoffLimit만큼 쌓이며, 재시도 간격은 지수 백오프로 최대 6분까지 벌어진다.
- **CronJob의 동시 실행과 누락.** 이전 Job이 끝나기 전에 다음 스케줄이 오면 기본값 `concurrencyPolicy: Allow`로 겹쳐 실행되므로 백업류는 `Forbid`로 막는다. 정확한 실행 보장이 필요하면 Argo Workflows 같은 워크플로 엔진을 쓴다. 완료된 Job은 `ttlSecondsAfterFinished`로 정리하지 않으면 계속 쌓인다.

## 관련 글

- [Kubernetes 아키텍처와 Pod](/notes/infra/k8s-architecture-pod/)
- [Services·Networking·Ingress](/notes/infra/k8s-services-networking/)
- [Scaling·Scheduling·Probes](/notes/infra/k8s-scaling-scheduling/)
