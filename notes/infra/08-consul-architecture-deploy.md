---
title: "Consul 아키텍처와 배포 — Raft·Gossip·클러스터"
series: infra
part: "Consul"
order: 8
summary: "Consul 서버·클라이언트 모드가 Raft와 Gossip을 어떻게 나눠 쓰는지, 5 서버 클러스터를 어떤 구성으로 띄우는지 정리한다."
tags: [Consul, Raft, Gossip, Serf, bootstrap_expect]
sources: [2026-05-03-consul-architecture.md, 2026-05-03-consul-deploy.md]
updated: 2026-08-30
---

서비스 인스턴스가 수십 개로 늘어나면 어느 IP에 어떤 서비스가 살아 있는지 중앙에서 관리하는 장치가 필요하다. 설정 파일에 주소를 박아 두면 인스턴스가 교체될 때마다 배포를 다시 해야 하고, 죽은 인스턴스로 향하는 트래픽을 걸러낼 수도 없다. Consul은 서비스 디스커버리, 헬스 체크, KV 저장소, 서비스 메시 네 기능을 하나의 에이전트 바이너리로 제공하며 Kubernetes·VM·온프레미스 어디서나 같은 방식으로 동작한다.

## 핵심 개념

### 에이전트 모드

Consul 바이너리는 하나지만 `server` 플래그에 따라 역할이 갈린다. 서버 모드(`server = true`)는 Raft 합의에 참여하고 KV·서비스 카탈로그·ACL을 Raft 로그로 저장한다. 클라이언트 모드(`server = false`, 기본값)는 상태를 저장하지 않고 로컬 서비스 등록·헬스 체크·DNS/HTTP API 처리만 담당하며, 나머지는 서버에 위임한다. 애플리케이션이 도는 모든 노드에 클라이언트를 배치하고 서버는 별도 노드에 3·5·7대 홀수로 둔다. 개발 모드(`consul agent -dev`)는 단일 노드가 메모리에만 상태를 두고 Connect를 자동 활성화하는데, 재시작하면 데이터가 사라지므로 로컬 테스트 외에는 쓰지 않는다.

### Raft — 상태 합의

서버들은 Raft로 상태를 동기화한다. Leader 한 대가 모든 쓰기를 처리해 Follower에 복제하고, 리더 장애 시 Candidate 상태를 거쳐 선거가 일어난다. 결정을 내리려면 쿼럼 `floor(N/2) + 1` 대가 살아 있어야 한다.

| 서버 수 | 쿼럼 | 허용 장애 |
|:---:|:---:|:---:|
| 1 | 1 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

짝수 구성은 홀수 대비 장애 허용이 늘지 않고 쿼럼만 커지므로 의미가 없다. 5대가 운영 표준이고, 9대 이상은 복제 지연 때문에 합의 성능이 떨어진다. 네트워크가 [A] | [B, C]로 분할되면 A는 쿼럼 미달로 리더를 뽑지 못하고 B·C만 새 리더를 선출하므로 스플릿 브레인이 발생하지 않는다.

### Gossip — 멤버십 전파

Serf 라이브러리 기반 Gossip은 노드 가입·탈퇴·장애 감지와 이벤트 전파를 담당한다. UDP 위주로 동작하며 결국 일관성만 보장한다. 풀은 두 개다. LAN 풀(8301)은 한 데이터센터의 서버와 클라이언트 전부가 참여하고, WAN 풀(8302)은 여러 데이터센터의 서버만 참여해 Federation을 구성한다. 클라이언트는 WAN 풀에 들어가지 않는다.

| 항목 | Gossip (Serf) | Raft |
|:---|:---|:---|
| 목적 | 멤버십·이벤트 | 상태 데이터 합의 |
| 참여자 | 모든 에이전트 | 서버만 |
| 일관성 | 결국 일관성 | 강한 일관성 |
| 포트 | 8301 / 8302 | 8300 |

그 외 포트는 8500 HTTP API·UI, 8501 HTTPS, 8600 DNS, 21000~21255 Envoy 사이드카다.

### 클러스터 형성

`bootstrap_expect = N`은 서버 N대가 LAN Gossip으로 서로를 발견하면 자동으로 Raft를 부트스트랩하라는 뜻이다. 모든 서버에 같은 값을 두고 동시에 시작하는 것이 표준 절차다. `bootstrap = true`는 한 대를 강제로 리더로 만드는 구식 옵션이라 테스트에만 쓴다. `retry_join`은 시작 시 합류를 시도할 주소 목록으로, 실패해도 계속 재시도하며 자기 IP가 포함돼 있어도 무시된다. 클라우드에서는 `provider=aws tag_key=... tag_value=...` 형식으로 태그 기반 자동 조인이 가능하다. 주소 파라미터는 셋이다. `bind_addr`는 Gossip·RPC를 수신할 사설 IP, `client_addr`는 HTTP·DNS를 수신할 주소(UI 외부 노출이면 `0.0.0.0`, 기본값은 `127.0.0.1`), `advertise_addr`는 NAT 환경에서 다른 노드에 알릴 주소다.

## 코드

5 서버 클러스터의 서버 구성. 다섯 대가 동일한 파일을 사용한다.

```hcl
# /etc/consul.d/consul.hcl
datacenter       = "dc1"
data_dir         = "/opt/consul"
server           = true
bootstrap_expect = 5

bind_addr      = "10.0.1.10"
client_addr    = "0.0.0.0"
advertise_addr = "10.0.1.10"
retry_join     = ["10.0.1.10", "10.0.1.11", "10.0.1.12", "10.0.1.13", "10.0.1.14"]

ui_config {
  enabled = true
}

performance {
  raft_multiplier = 1
}

log_level            = "INFO"
log_file             = "/var/log/consul/consul.log"
log_rotate_duration  = "24h"
log_rotate_max_files = 7
```

systemd 유닛. `Type=notify`로 에이전트가 준비 신호를 보낼 때까지 기동 완료로 보지 않는다.

```ini
# /etc/systemd/system/consul.service
[Unit]
Description=Consul
Requires=network-online.target
After=network-online.target
ConditionFileNotEmpty=/etc/consul.d/consul.hcl

[Service]
Type=notify
User=consul
Group=consul
ExecStart=/usr/bin/consul agent -config-dir=/etc/consul.d/
ExecReload=/bin/kill --signal HUP $MAINPID
KillMode=process
KillSignal=SIGTERM
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Spring Boot 3.x 애플리케이션에서 로컬 클라이언트 에이전트의 HTTP API로 Raft 리더와 LAN 멤버를 조회하는 예제. `RestClient`는 Spring 6.1 이후의 동기 HTTP 클라이언트다.

```java
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class ConsulClusterProbe {

    private final RestClient client = RestClient.builder()
            .baseUrl("http://127.0.0.1:8500/v1")
            .build();

    public String raftLeader() {
        return client.get().uri("/status/leader")
                .retrieve().body(String.class);   // "10.0.1.10:8300"
    }

    public List<String> aliveMembers() {
        List<Map<String, Object>> members = client.get().uri("/agent/members")
                .retrieve().body(new org.springframework.core.ParameterizedTypeReference<>() {});
        return members.stream()
                .filter(m -> Integer.valueOf(1).equals(m.get("Status")))
                .map(m -> (String) m.get("Name"))
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- `bootstrap_expect` 값이 서버마다 다르면 클러스터가 형성되지 않거나 두 개의 리더가 생긴다. 클라이언트 구성에 이 값을 넣어도 안 된다. 서버 전용 파라미터다.
- `consul members`는 LAN Gossip 멤버를, `consul operator raft list-peers`는 Raft 투표자를 보여준다. 전자에 alive로 보이는 서버가 후자에서 빠져 있으면 Gossip은 붙었지만 Raft 합류가 안 된 상태이므로 8300 포트 통신을 먼저 확인한다.
- `client_addr = "0.0.0.0"`으로 UI를 열면 8500이 인증 없이 외부에 노출된다. ACL과 TLS를 켜기 전에는 방화벽으로 접근 대역을 제한해야 한다.
- `raft_multiplier`는 1이 가장 공격적인 타임아웃이다. 지연이 큰 네트워크에서 1을 쓰면 불필요한 리더 선거가 반복되고, 반대로 개발용 기본값 5를 운영에 그대로 두면 장애 감지가 수 초 늦어진다.
- 서버 1대(`bootstrap_expect = 1`) 구성은 장애 허용이 0이다. 운영은 최소 3대, 데이터센터 간 연결은 `retry_join_wan`으로 서버끼리만 묶는다.

## 관련 글

- [Service Discovery와 KV Store](/notes/infra/consul-service-discovery-kv/)
- [Service Mesh·보안·백업](/notes/infra/consul-mesh-security-backup/)
- [Kubernetes 아키텍처와 Pod](/notes/infra/k8s-architecture-pod/)
