---
title: "Helm과 실전 운영 — 매니지드 K8s·CI/CD·Observability"
series: infra
part: "Kubernetes"
order: 7
summary: "환경별 YAML 중복은 Helm 템플릿으로, 배포는 GitOps로, 상태 파악은 Metrics·Logs·Traces 3축으로 묶는다"
tags: [Helm, Kustomize, ArgoCD, GitOps, Prometheus]
sources: [2026-05-03-k8s-helm.md, 2026-05-03-k8s-real-world.md]
updated: 2026-08-30
---

같은 애플리케이션을 dev·staging·prod에 배포하면 이미지 태그와 replicas만 다른 매니페스트가 환경 수만큼 복제되고, 변경이 한 환경에 누락된다. 배포가 수동 `kubectl apply`면 롤백 기준점이 없고, 메트릭과 로그가 없으면 장애를 사용자 신고로 알게 된다. Helm은 매니페스트 중복을, GitOps는 배포 추적을, Observability 스택은 상태 파악을 해결한다.

## 핵심 개념

### Helm — 템플릿 + 패키지

Helm은 Kubernetes의 패키지 매니저다. 매니페스트를 Go 템플릿으로 한 번 작성하고 값만 `values.yaml`로 분리한다. Chart는 `Chart.yaml`, `values.yaml`, `templates/`, 서브 차트용 `charts/`로 구성되며 `_helpers.tpl`의 함수를 `include`로 재사용한다. 문법은 Go 템플릿에 Sprig 함수를 더한 것으로 중첩 구조는 `toYaml`과 `nindent`로 들여쓰기를 맞춘다.

`helm install`은 Release를 만들고 `helm upgrade`는 Revision을 올리며 `helm rollback`으로 되돌린다. 생성된 객체에는 `app.kubernetes.io/instance` 라벨이 붙는다. `dependencies`로 PostgreSQL·Redis 같은 서브 차트를 함께 설치하고, `helm.sh/hook` Job은 pre-install·pre-upgrade 시점에 실행되어 마이그레이션에 쓰인다. 차트는 `helm package` 후 OCI 레지스트리로 `helm push`한다.

Kustomize는 템플릿 없이 base 위에 overlay patch를 겹치며 `kubectl apply -k`로 실행된다.

| 기준 | Helm | Kustomize |
|:---|:---|:---|
| 방식 | 템플릿 + 변수 | overlay·patch |
| 패키징·의존성 | 차트 저장소·서브 차트 | 없음 |
| 적합한 경우 | 외부 배포 차트, 변수 많은 앱 | 자체 앱의 환경별 소규모 차이 |

### 매니지드 클러스터와 GitOps

kubeadm·kops로 직접 세우면 etcd 백업·인증서 갱신·노드 패치가 전부 사용자 책임이다. GKE·EKS·AKS가 컨트롤 플레인을 관리하고, GKE Autopilot과 EKS Auto Mode는 노드까지 자동화한다. 클라우드 IAM과 ServiceAccount는 GKE의 Workload Identity, EKS의 IRSA 또는 Pod Identity로 연결한다.

GitOps는 Git을 desired state의 단일 진실로 삼는다. CI가 이미지를 푸시하고 Git의 태그를 갱신하면 ArgoCD·Flux가 변경을 감지해 클러스터를 동기화한다. 모든 변경이 커밋으로 남고 롤백은 `git revert`다.

### Observability 3축

Metrics는 `kube-prometheus-stack` 차트가 Prometheus·Grafana·Alertmanager를 한 번에 설치하고 `ServiceMonitor`로 스크레이프 대상을 등록한다. Logs는 stdout으로 내보내고 DaemonSet 수집기가 모은다. Loki는 라벨 인덱스로 가볍고, Elasticsearch 기반 EFK는 풀텍스트 검색용이다. Traces는 OpenTelemetry로 계측해 Jaeger·Tempo로 내보낸다. cert-manager로 TLS 갱신을, Velero로 객체와 PVC 백업을 자동화한다.

## 코드

Spring Boot 앱 차트의 Deployment 템플릿이다. 이미지 태그는 `appVersion`을 기본값으로 삼고 Actuator 포트를 metrics로 노출해 ServiceMonitor가 참조한다.

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "order-api.fullname" . }}
  labels:
    {{- include "order-api.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "order-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "order-api.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8080
            - name: metrics
              containerPort: 8081
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: {{ .Values.springProfile | quote }}
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: metrics
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: metrics
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
---
# templates/servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ include "order-api.fullname" . }}
spec:
  selector:
    matchLabels:
      {{- include "order-api.selectorLabels" . | nindent 6 }}
  endpoints:
    - port: metrics
      path: /actuator/prometheus
```

위 템플릿이 기대하는 Spring Boot 3.x 설정이다. 관리 포트를 분리하고 Prometheus 엔드포인트와 probe 그룹을 켠다.

```yaml
# application.yaml
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,prometheus
  endpoint:
    health:
      probes:
        enabled: true
```

```groovy
// build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-actuator'
    runtimeOnly 'io.micrometer:micrometer-registry-prometheus'
}
```

CI가 차트를 OCI 레지스트리로 푸시하고 ArgoCD Application이 Git의 values와 함께 동기화한다. `prune`은 Git에서 제거된 리소스를 삭제하고 `selfHeal`은 수동 변경을 되돌린다.

```yaml
# CI: helm package ./chart && helm push order-api-1.4.2.tgz oci://registry.example.com/charts
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-api
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/example/order-api-deploy
    targetRevision: main
    path: chart
    helm:
      valueFiles:
        - values-prod.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: prod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## 실무에서 걸리는 지점

- **`latest` 태그.** 어느 커밋이 떠 있는지 알 수 없고 롤백 기준도 사라진다. semver 또는 git SHA로 고정한다. 태그를 재사용해 덮어쓰면 노드 캐시 때문에 구버전이 뜬다.
- **`upgrade --install`.** 첫 배포에 `upgrade`만 쓰면 Release가 없어 실패한다. `--install`을 붙여야 파이프라인이 멱등해진다. 적용 전 `helm template`·`helm lint`로 렌더링 결과를 확인한다.
- **Hook 리소스 누적.** Hook Job은 Release 관리 대상이 아니어서 삭제 정책이 없으면 실행 후 남고, 이름이 같은 Job은 다음 업그레이드에서 충돌한다. `hook-delete-policy: hook-succeeded`와 `hook-weight`를 함께 지정한다.
- **selfHeal과 HPA 충돌.** `replicas`를 차트에 박아 두면 HPA가 늘린 값을 ArgoCD가 되돌린다. 템플릿에서 `replicas`를 빼거나 `ignoreDifferences`를 설정한다. `kubectl edit`한 임시 조치도 즉시 원복된다.
- **Prometheus 카디널리티.** URI에 ID가 섞인 메트릭이나 사용자별 태그는 시계열 수를 폭발시킨다. 태그 값 범위를 제한하고, 지연은 percentile이 아니라 histogram으로 내보내야 여러 Pod를 집계할 수 있다.

## 관련 글

- [Scaling·Scheduling·Probes](/notes/infra/k8s-scaling-scheduling/)
- [Security — RBAC·NetworkPolicy](/notes/infra/k8s-security/)
- [Consul 아키텍처와 배포 — Raft·Gossip·클러스터](/notes/infra/consul-architecture-deploy/)
