---
title: "Service Mesh·보안·백업"
series: infra
part: "Consul"
order: 10
summary: "Connect 사이드카·mTLS·Intentions로 서비스 간 통신을 통제하고, TLS·ACL·Gossip 키와 스냅샷으로 클러스터를 지킨다"
tags: [Consul, Service Mesh, Envoy, ACL, Snapshot]
sources: [2026-05-03-consul-service-mesh.md, 2026-05-03-consul-security.md, 2026-05-03-consul-backup-restore.md]
updated: 2026-08-30
---

Consul을 설치한 직후에는 모든 통신이 평문이고 인증도 없다. 누가 누구를 호출할 수 있는지 통제하는 장치가 없고, API·KV·카탈로그는 토큰 없이 누구나 읽고 쓴다. 손상된 노드 하나가 클러스터 상태를 통째로 복제해 갈 수도 있다. 백업이 없으면 잘못된 KV 삭제에서 돌아올 방법도 없다. 이 공백을 Connect, TLS·ACL·Gossip 암호화, 스냅샷이 각각 메운다.

## 핵심 개념

### Connect — 사이드카 프록시와 Intentions

Connect는 Consul 내장 서비스 메시다. 애플리케이션은 localhost의 사이드카 프록시(운영 표준은 Envoy)와만 통신하고, 프록시끼리 mTLS 채널을 맺어 암호화·상호 인증·정책 강제를 맡는다. Connect는 기본 비활성이며 `connect { enabled = true }`를 명시하고 재시작해야 한다.

서비스 정의의 `sidecar_service` 블록에 upstream(의존 대상)과 `local_bind_port`를 선언하면 애플리케이션은 `localhost:<port>`로 upstream에 접근한다. 등록과 프록시 기동은 별개다. `consul services register`는 카탈로그에 알릴 뿐이고 프록시는 `consul connect envoy -sidecar-for <service>`로 따로 띄운다. 각 서비스는 CA(내장 또는 Vault)가 발급한 X.509 인증서로 신원을 증명한다.

Intentions는 source가 destination에 접속할 수 있는지 정의한다. destination 프록시가 인증서의 서비스 신원을 확인한 뒤 Intentions를 조회해 허용·거부한다. 명시적 매치가 `*`보다 우선하고 충돌 시 deny가 이긴다. 기본 정책은 ACL의 `default_policy`를 따르므로 deny로 운영하면 명시 허용된 쌍만 통신한다. L4가 기본이고 HTTP 단위 L7은 service-intentions 설정 항목으로 정의한다.

### TLS·ACL·Gossip 암호화

보안은 Gossip 암호화(에이전트 간 멤버십), TLS(RPC·HTTPS API), mTLS(서비스 간 트래픽), ACL(API·KV·카탈로그 접근)의 네 계층으로 나뉜다.

TLS 검증 파라미터 세 개는 모두 기본 false다. `verify_incoming`은 수신 연결에 클라이언트 인증서를 요구하고, `verify_outgoing`은 발신에 TLS를 강제하며, `verify_server_hostname`은 서버 인증서에 `server.<dc>.<domain>` SAN을 요구한다. 마지막이 없으면 손상된 클라이언트가 `server = true`로 재시작해 Raft에 합류하고 상태 전체를 복제하는 권한 상승이 가능하다. 모든 인증서는 같은 CA로 서명하며 `auto_encrypt`로 클라이언트 인증서 배포를 자동화한다.

ACL은 Policy, Token, Role, Service Identity로 구성되며 규칙은 `key_prefix`·`service_prefix`·`node_prefix` 등에 `read`/`write`/`deny`를 부여한다. `default_policy`는 deny가 기준이고 `down_policy`는 리더 장애 시 캐시 토큰으로 운영을 잇는 `extend-cache`가 권장값이다. 활성화는 allow로 시작해 `consul acl bootstrap`으로 관리 토큰을 만들고, 정책·토큰을 배포해 모든 에이전트에 agent 토큰을 설정한 뒤 deny로 전환한다. bootstrap은 한 번만 가능하다.

Gossip 키는 `consul keygen`으로 만들어 모든 노드의 `encrypt`에 동일하게 넣는다. 로테이션은 `keyring -install`(수신만)로 전 노드에 배포하고 `keyring -use`로 활성 키를 바꾼 뒤 `keyring -remove`로 옛 키를 제거한다.

### 스냅샷 백업

`consul snapshot save`는 Raft 상태를 파일 하나로 내보낸다. KV, 카탈로그, 헬스 체크, ACL, 세션, Raft 메타데이터가 포함되고 Gossip 키와 TLS 인증서는 포함되지 않는다. `snapshot inspect`로 손상 여부를 복원 전에 확인한다. `snapshot restore`는 전체를 덮어쓰며 백업 이후 변경은 사라지고, datacenter 이름이 다르면 거부된다. RPO는 백업 주기와 같으므로 필요하면 주기를 줄인다.

## 코드

dashboard 서비스가 counting을 upstream으로 두는 사이드카 정의다.

```hcl
service {
  name = "dashboard"
  port = 9002
  connect {
    sidecar_service {
      proxy {
        upstreams = [
          { destination_name = "counting", local_bind_port = 5000 }
        ]
      }
    }
  }
}
```

Spring Boot 3.x에서 upstream을 호출하는 클라이언트다. mTLS는 프록시가 처리하므로 애플리케이션에는 인증서 설정이 없다.

```java
@Configuration
public class UpstreamConfig {

    @Bean
    RestClient countingClient(
            @Value("${upstream.counting.base-url:http://localhost:5000}") String baseUrl) {
        return RestClient.builder().baseUrl(baseUrl).build();
    }
}

@Service
public class CountingGateway {

    private final RestClient client;

    public CountingGateway(RestClient countingClient) {
        this.client = countingClient;
    }

    public long current() {
        return client.get().uri("/count")
                .retrieve()
                .body(CountResponse.class)
                .count();
    }

    record CountResponse(long count) {}
}
```

ACL을 켠 클러스터에서 KV를 읽는 Spring Cloud Consul 설정이다. 토큰은 환경 변수로 주입한다.

```yaml
spring:
  config:
    import: "consul:"
  cloud:
    consul:
      host: 127.0.0.1
      port: 8500
      token: ${CONSUL_HTTP_TOKEN}
      config:
        enabled: true
        prefix: config
        format: YAML
```

## 실무에서 걸리는 지점

- 등록은 됐는데 upstream 연결이 안 되면 프록시 프로세스부터 확인한다.
- ACL을 처음부터 deny로 켜면 agent 토큰이 없는 노드가 서로 통신하지 못해 클러스터가 멈춘다. allow로 시작해 토큰을 배포한 뒤 전환한다.
- Gossip 키 로테이션에서 `-use`를 `-install`보다 먼저 실행하면 새 키를 못 받은 노드가 멤버십에서 떨어진다. 단계마다 `keyring -list`로 전 노드 반영을 확인한다.
- 스냅샷은 리더에서 생성하고 `inspect`로 검증한 뒤 외부 저장소로 옮기며, 정기적으로 별도 환경에 복원해 본다.
- `data_dir`를 OS 레벨로 복원할 때는 클러스터 전체를 동시에 처리한다. 한 노드만 되돌리면 Raft가 깨진다.

## 관련 글

- [Consul 아키텍처와 배포 — Raft·Gossip·클러스터](/notes/infra/consul-architecture-deploy/)
- [Service Discovery와 KV Store](/notes/infra/consul-service-discovery-kv/)
- [Security — RBAC·NetworkPolicy](/notes/infra/k8s-security/)
