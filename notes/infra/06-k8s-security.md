---
title: "Security — RBAC·NetworkPolicy"
series: infra
part: "Kubernetes"
order: 6
summary: "RBAC로 API 권한을, NetworkPolicy로 Pod 간 트래픽을, SecurityContext와 PSS로 컨테이너 권한을 최소화한다."
tags: [Kubernetes, RBAC, ServiceAccount, NetworkPolicy, SecurityContext]
sources: [2026-05-03-k8s-security.md]
updated: 2026-08-30
---

Kubernetes는 기본 설정만으로는 안전하지 않다. Pod은 namespace와 무관하게 서로 통신하고, 컨테이너는 이미지가 지정한 대로 root로 실행되며, API 권한을 정리하지 않으면 자격 증명 하나의 유출이 클러스터 장악으로 이어진다. 이 세 축을 각각 RBAC, NetworkPolicy, SecurityContext와 Pod Security Standards가 담당한다.

## 핵심 개념

### RBAC

RBAC는 네 객체로 구성된다. Role과 ClusterRole은 권한 묶음이고, RoleBinding과 ClusterRoleBinding은 그 묶음을 주체(User·Group·ServiceAccount)에 연결한다. Role과 RoleBinding은 namespace 범위, ClusterRole과 ClusterRoleBinding은 클러스터 범위이며 Node·PersistentVolume 같은 전역 리소스는 ClusterRole로만 다룬다. RoleBinding은 ClusterRole도 참조할 수 있으므로, 공통 권한을 ClusterRole로 정의하고 namespace마다 RoleBinding으로 범위를 좁혀 부여하는 것이 표준 패턴이다.

규칙은 `apiGroups`·`resources`·`verbs`로 표현한다. Pod·Service·Node 같은 core 리소스는 `apiGroups: [""]`, Deployment는 `apps`, Job은 `batch`다. `pods/log` 같은 하위 리소스는 별도로 허용해야 하고, `resourceNames`로 특정 이름만 제한할 수 있다.

### ServiceAccount

Pod은 ServiceAccount(SA)로 API 서버에 인증하며, 지정이 없으면 namespace의 `default` SA를 공유한다. 1.24 이후 영구 Secret 토큰은 생성되지 않고, kubelet이 TokenRequest API로 만료 시간이 있는 토큰을 발급해 `/var/run/secrets/kubernetes.io/serviceaccount/token`에 프로젝션한다. API를 호출하지 않는 워크로드는 `automountServiceAccountToken: false`로 마운트를 끈다.

### NetworkPolicy

`podSelector`로 대상 Pod을 고르고, `policyTypes`에 선언한 방향에 대해 허용 규칙만 나열한다. 한 방향에 정책이 하나라도 걸리면 명시된 것 외에 전부 차단된다. 한 `from` 항목 안의 podSelector와 namespaceSelector는 AND, 별도 항목은 OR다. 여러 정책은 합집합이므로 `podSelector: {}`로 default deny를 깔고 경로마다 allow를 추가한다.

### SecurityContext와 Pod Security Standards

SecurityContext는 Pod 레벨(runAsUser·fsGroup·runAsNonRoot·seccompProfile)과 컨테이너 레벨(allowPrivilegeEscalation·readOnlyRootFilesystem·capabilities)로 나뉘고, 컨테이너 레벨이 우선한다. Pod Security Standards는 PodSecurityPolicy를 대체하는 내장 admission으로, Privileged·Baseline·Restricted 프로파일을 namespace 라벨로 적용하고 `enforce`·`audit`·`warn` 모드를 가진다.

## 코드

CI용 SA에 특정 Deployment 갱신 권한만 부여한다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: prod
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deploy-order-api
  namespace: prod
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["order-api"]
    verbs: ["get", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer-order-api
  namespace: prod
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: prod
roleRef:
  kind: Role
  name: deploy-order-api
  apiGroup: rbac.authorization.k8s.io
```

prod namespace에 default deny를 깔고, DB Pod에는 `app: order-api`의 5432 ingress와 DNS egress만 허용한다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: prod
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-allow
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: order-api
      ports:
        - protocol: TCP
          port: 5432
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

Spring Boot 3.x 앱을 Restricted namespace에 배포하는 스펙이다. 루트 파일시스템을 읽기 전용으로 잠그고 `/tmp`에 emptyDir를 붙인다.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: prod
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
  namespace: prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: order-api
  template:
    metadata:
      labels:
        app: order-api
    spec:
      serviceAccountName: order-api
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: registry.internal/order-api:1.8.2
          env:
            - name: JAVA_TOOL_OPTIONS
              value: "-Djava.io.tmpdir=/tmp -XX:MaxRAMPercentage=75"
          ports:
            - containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

## 실무에서 걸리는 지점

- **NetworkPolicy는 CNI가 구현한다.** Calico·Cilium은 지원하지만 Flannel 단독 구성은 정책 객체를 받기만 하고 아무것도 차단하지 않는다.
- **default deny가 DNS를 끊는다.** egress deny를 걸면 CoreDNS 질의가 막혀 모든 외부 호출이 이름 해석에서 실패한다. 메트릭 수집기나 사이드카도 별도 allow가 필요하다.
- **readOnlyRootFilesystem은 JVM에서 자주 깨진다.** 내장 Tomcat이 `java.io.tmpdir` 아래에 작업 디렉터리를 만들므로 `/tmp`에 emptyDir가 없으면 기동 직후 실패한다. root 전제 이미지는 `runAsNonRoot`와 충돌해 `CreateContainerConfigError`로 멈춘다.
- **와일드카드 권한이 번진다.** `resources: ["*"]`는 CRD 추가 시 그 리소스까지 자동 포함한다. `secrets` 읽기와 `pods/exec`는 자격 증명 탈취와 같으므로 `kubectl auth can-i --list --as`로 SA별 권한을 주기적으로 검증한다.
- **PSS를 enforce로 바로 켜면 기존 워크로드가 거부된다.** `warn`·`audit`으로 위반 Pod을 먼저 수집하고 고친 뒤 `enforce`로 올린다. 허용 레지스트리 제한이나 이미지 서명 검증은 Kyverno·OPA Gatekeeper로 보완한다.

## 관련 글

- [Services·Networking·Ingress](/notes/infra/k8s-services-networking/)
- [ConfigMap·Secret·Storage](/notes/infra/k8s-config-storage/)
- [Helm과 실전 운영 — 매니지드 K8s·CI/CD·Observability](/notes/infra/k8s-helm-real-world/)
