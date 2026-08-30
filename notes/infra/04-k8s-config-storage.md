---
title: "ConfigMap·Secret·Storage"
series: infra
part: "Kubernetes"
order: 4
summary: "설정은 ConfigMap·Secret으로 주입하고 데이터는 PVC·StorageClass로 영속화하되, Secret 평문과 Delete 회수 정책을 경계한다"
tags: [Kubernetes, ConfigMap, Secret, PersistentVolume, StorageClass]
sources: [2026-05-03-k8s-config-secrets.md, 2026-05-03-k8s-storage.md]
updated: 2026-08-30
---

컨테이너 이미지는 환경에 상관없이 동일해야 한다. DB 호스트나 API 키를 이미지에 굽으면 환경마다 다시 빌드해야 하고 비밀번호가 레지스트리와 Git 이력에 남는다. 한편 Pod은 언제든 교체되므로 컨테이너 파일시스템에 쓴 데이터는 Pod과 함께 사라진다. 설정은 이미지 밖에서 주입하고 데이터는 Pod 밖에서 보존해야 한다는 두 요구를 Kubernetes는 ConfigMap·Secret과 PV·PVC·StorageClass로 해결한다.

## 핵심 개념

### ConfigMap과 Secret

ConfigMap은 일반 설정, Secret은 민감 정보를 담는 키-값 객체다. 구조와 주입 방식은 같고 용도만 다르며, 한 객체는 etcd 제약으로 1MiB를 넘을 수 없다. 주입 방법은 네 가지다.

| 방법 | 형태 | 변경 반영 |
|:---|:---|:---|
| `env.valueFrom` | 키 하나를 환경 변수로 | 재시작 필요 |
| `envFrom` | 모든 키를 환경 변수로 | 재시작 필요 |
| Volume mount | 키마다 파일 하나 | kubelet 동기 주기 후 자동 갱신 |
| `subPath` | 특정 파일 하나만 | 자동 갱신 안 됨 |

환경 변수는 프로세스 시작 시점에 고정된다. Volume mount는 kubelet이 주기적으로 파일을 교체하지만 subPath는 심볼릭 링크 교체 방식에서 빠진다. 갱신된 파일을 다시 읽는 것은 애플리케이션의 책임이다.

Secret의 `data`는 base64 인코딩일 뿐 암호화가 아니다. 읽기 권한이 있으면 즉시 평문을 복원할 수 있고 etcd에도 그대로 저장된다. 운영 환경은 EncryptionConfiguration으로 etcd 암호화를 켜거나(기본 비활성), Sealed Secrets로 암호화된 객체만 Git에 커밋하거나, External Secrets Operator로 Vault·클라우드 Secret Manager 값을 동기화하거나, Secrets Store CSI Driver로 외부 값을 볼륨에 직접 마운트한다.

### Volume에서 StorageClass까지

Pod은 PVC를 참조하고, PVC는 PV에 바인딩되며, StorageClass가 PV를 동적으로 만들고, CSI 드라이버가 실제 스토리지를 다룬다.

- `emptyDir`: Pod과 생명주기를 같이하는 빈 디렉토리. 컨테이너 간 공유와 임시 캐시용이다.
- `hostPath`: 노드 디스크 직접 마운트. 보안 위험이 커 시스템 데몬에만 한정한다.
- PV: 클러스터 범위 자원. 관리자가 미리 만들거나(Static) StorageClass가 만든다(Dynamic).
- PVC: 네임스페이스 범위의 요청. 네임스페이스 간 PV 공유는 불가하다.

AccessMode는 ReadWriteOnce(한 노드), ReadOnlyMany, ReadWriteMany(여러 노드 쓰기), ReadWriteOncePod(한 Pod만)이 있다. EBS 같은 블록 스토리지는 RWX를 지원하지 않으므로 여러 Pod이 같은 데이터를 쓰려면 NFS·EFS·CephFS 같은 파일 스토리지가 필요하다.

StorageClass의 `reclaimPolicy`는 PVC 삭제 시 스토리지까지 지우는 `Delete`와 보존하는 `Retain`이 있고 동적 프로비저닝의 기본값은 `Delete`다. `volumeBindingMode: WaitForFirstConsumer`는 Pod이 스케줄될 때까지 바인딩을 미뤄 PV가 Pod과 같은 AZ에 생성되도록 한다. CSI는 표준 스토리지 플러그인 인터페이스로 in-tree 드라이버는 모두 CSI로 이관됐고 VolumeSnapshot도 CSI로 제공된다.

## 코드

ConfigMap과 Secret을 함께 주입하는 Pod 스펙이다. 일반 설정은 `envFrom`, 비밀번호는 `secretKeyRef`, 설정 파일은 볼륨으로 받는다.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_HOST: "postgres"
  DB_PORT: "5432"
  application.yaml: |
    server:
      port: 8080
    logging:
      level:
        root: INFO
---
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
stringData:
  password: s3cr3t
---
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
    - name: app
      image: registry.example.com/app:1.0.0
      envFrom:
        - configMapRef:
            name: app-config
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
        - name: SPRING_CONFIG_ADDITIONAL_LOCATION
          value: /etc/config/
      volumeMounts:
        - name: config
          mountPath: /etc/config
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: app-config
        items:
          - key: application.yaml
            path: application.yaml
```

Spring Boot 3.x에서 위 값을 읽는 설정이다. `DB_*` 환경 변수는 relaxed binding으로 `db.*`에 매핑되고, `/etc/config/application.yaml`은 추가 설정 경로로 병합된다.

```java
package com.example.app.config;

import javax.sql.DataSource;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@ConfigurationProperties(prefix = "db")
public record DbProperties(String host, int port, String password) {}

@Configuration
@EnableConfigurationProperties(DbProperties.class)
class DataSourceConfig {

    @Bean
    DataSource dataSource(DbProperties props) {
        return DataSourceBuilder.create()
                .url("jdbc:postgresql://%s:%d/app".formatted(props.host(), props.port()))
                .username("app")
                .password(props.password())
                .build();
    }
}
```

DB용 StorageClass와 StatefulSet이다. `Retain`과 `WaitForFirstConsumer`를 지정하고 `volumeClaimTemplates`로 Pod마다 PVC를 만든다.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: db-retain
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
spec:
  serviceName: pg
  replicas: 2
  selector:
    matchLabels:
      app: pg
  template:
    metadata:
      labels:
        app: pg
    spec:
      containers:
        - name: postgres
          image: postgres:16
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: db-retain
        resources:
          requests:
            storage: 20Gi
```

## 실무에서 걸리는 지점

- Secret은 시작 시 설정 덤프나 열려 있는 Actuator `env` 엔드포인트로 평문이 샌다. Secret의 `get`·`list` 권한을 RBAC로 최소화하고 Actuator는 인증 뒤에 둔다.
- 볼륨 마운트로 ConfigMap을 갱신해도 Spring Boot는 파일을 다시 읽지 않는다. Deployment 어노테이션에 ConfigMap 해시를 넣어 롤링 재시작을 유도하는 편이 예측 가능하다.
- 기본 `Delete` 정책 때문에 네임스페이스나 Helm 릴리스를 지우면 DB 데이터가 같이 사라진다. 기존 PV는 `kubectl patch pv`로 `Retain`으로 바꿀 수 있고, `Released` 상태의 PV는 재사용 전 `claimRef`를 수동 제거해야 한다.
- PVC가 `Pending`에 멈추는 원인은 맞는 PV 부재, 없는 StorageClass 지정, `WaitForFirstConsumer`의 정상 대기가 대부분이다. `kubectl describe pvc`의 이벤트로 구분한다.
- Deployment에 RWO PVC를 붙이고 replicas를 올리면 다른 노드의 Pod이 마운트에 실패한다. RWX 파일 스토리지로 옮기거나 StatefulSet의 Pod별 PVC로 바꾼다. 볼륨 축소는 지원하지 않는다.

## 관련 글

- [Workloads — Deployment·StatefulSet·DaemonSet·Job](/notes/infra/k8s-workloads/)
- [Scaling·Scheduling·Probes](/notes/infra/k8s-scaling-scheduling/)
- [Security — RBAC·NetworkPolicy](/notes/infra/k8s-security/)
