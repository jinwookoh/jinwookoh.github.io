---
title: "Service Discovery와 KV Store"
series: infra
part: "Consul"
order: 9
summary: "Consul에 서비스를 등록·조회하고 헬스 체크로 걸러내는 방식과, KV Store로 동적 설정·분산 락을 다루는 방법을 정리한다."
tags: [Consul, Service Discovery, Health Check, KV Store, Spring Cloud Consul]
sources: [2026-05-03-consul-service-discovery.md, 2026-05-03-consul-kv-store.md]
updated: 2026-08-30
---

서비스 주소를 설정 파일에 박아 두면 인스턴스가 늘거나 죽을 때마다 재배포해야 하고, 죽은 인스턴스로 요청이 가는 것도 막지 못한다. 기능 플래그 하나를 바꾸는 데도 재배포가 필요하다. ==Consul은 이 두 문제를 Service Discovery와 KV Store로 해결한다.==

## 핵심 개념

### 등록과 조회

서비스는 로컬 에이전트에 등록한다. 구성 디렉터리의 HCL 파일 또는 `PUT /v1/agent/service/register` 두 방법이 있다. 소유권은 에이전트에 있어 노드가 내려가면 그 서비스도 카탈로그에서 비활성화된다. 정의에는 `tags`(DNS 필터 가능)와 `meta`(HTTP API로만 조회)를 붙인다.

DNS 인터페이스는 8600 포트에서 `<service>.service.consul`을 해석한다. `<tag>.<service>.service.consul`로 태그를 거르고 `web.service.dc2.consul`로 데이터센터를 지정하며 SRV 레코드로 포트까지 받는다. ==DNS 응답은 헬스 체크를 통과한 인스턴스만 담는다.==

HTTP API는 `/v1/catalog/service/<name>`이 헬스와 무관한 전체 인스턴스를, `/v1/health/service/<name>?passing`이 통과한 인스턴스만 반환한다. 트래픽 라우팅에는 후자를 쓴다. Prepared Query는 `OnlyPassing`·태그 필터·가까운 DC 우선·페일오버를 서버에 미리 정의해 두고 `<name>.query.consul`로 호출하는 기능이다.

### 헬스 체크

| 종류 | 동작 방식 | 판정 기준 |
|:---|:---|:---|
| HTTP | 엔드포인트 주기 호출 | 2xx passing, 429 warning, 그 외 critical |
| TCP | 포트 연결 시도 | 연결 성공 시 passing |
| gRPC | gRPC Health 프로토콜 | SERVING 응답 시 passing |
| Script | 로컬 스크립트 실행 | 종료 코드 0/1/2 |
| Docker | 컨테이너 안에서 명령 실행 | 종료 코드 |
| TTL | 애플리케이션이 상태를 푸시 | TTL 내 갱신 없으면 critical |
| Alias | 다른 서비스 상태를 따라감 | 대상 서비스 상태 |

TTL만 방향이 반대다. 나머지는 Consul이 능동적으로 호출하지만 TTL은 애플리케이션이 `/v1/agent/check/pass|warn|fail/<id>`를 주기적으로 호출해야 한다. 상태는 passing·warning·critical이며 warning은 기본적으로 트래픽을 받고 critical은 받지 않는다.

### KV Store

`/`로 구분된 계층형 키-값 저장소로 값은 최대 512KB다. CLI·HTTP API·UI로 접근하며 `-recurse`로 prefix 하위를 한꺼번에 읽는다. HTTP 응답의 `Value`는 Base64이므로 평문은 `?raw`로 받는다. prefix 단위 ACL로 `myapp/secrets/`만 권한을 분리할 수 있다.

동시성 제어는 세 가지다. CAS는 `?cas=<ModifyIndex>`로 인덱스가 일치할 때만 쓰는 조건부 쓰기다. Session은 TTL을 가진 소유권 단위로 `?acquire=<session>`으로 키에 락을 걸고 세션이 만료되면 락도 풀린다. 리더 선거는 같은 키에 acquire를 시도해 성공한 하나가 리더가 되는 패턴이다. Transaction(`/v1/txn`)은 여러 연산을 전부 성공하거나 전부 실패하도록 묶는다.

변경 감지는 블로킹 쿼리(`?index=<N>&wait=5m`) 위에 있다. `consul watch`는 이를 감싸 변경 시 명령을 실행하고, envconsul은 prefix 하위 키를 환경 변수로 주입하며, consul-template은 서비스 목록과 KV로 설정 파일을 렌더링한 뒤 reload 명령을 실행한다.

## 코드

Spring Cloud Consul로 서비스를 등록하고 Actuator 헬스 엔드포인트를 HTTP 체크로 연결하는 설정이다.

```yaml
spring:
  application:
    name: order-service
  cloud:
    consul:
      host: localhost
      port: 8500
      discovery:
        register: true
        prefer-ip-address: true
        tags: [v1, primary]
        metadata:
          team: commerce
        health-check-path: /actuator/health
        health-check-interval: 10s
        health-check-timeout: 1s
        health-check-critical-timeout: 1m
      config:
        enabled: true
        prefix: config
        format: YAML
        watch:
          enabled: true
          delay: 1000
management:
  endpoints:
    web:
      exposure:
        include: health
```

`@LoadBalanced` `RestClient`로 서비스 이름을 호스트로 써서 passing 인스턴스에 호출하는 예제다.

```java
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Configuration
class ClientConfig {
    @Bean
    @LoadBalanced
    RestClient.Builder restClientBuilder() {
        return RestClient.builder();
    }
}

@Service
class InventoryClient {
    private final RestClient restClient;

    InventoryClient(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("http://inventory-service").build();
    }

    int stock(long skuId) {
        return restClient.get()
                .uri("/api/stock/{id}", skuId)
                .retrieve()
                .body(Integer.class);
    }
}
```

KV의 `config/order-service/data`에 저장한 YAML을 기능 플래그로 바인딩하는 예제다. watch가 변경을 감지하면 `RefreshEvent`가 발행되어 `@ConfigurationProperties` 빈이 리바인딩된다.

```java
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "feature")
class FeatureFlags {
    private boolean newCheckout;

    public boolean isNewCheckout() { return newCheckout; }
    public void setNewCheckout(boolean v) { this.newCheckout = v; }
}
```

```bash
consul kv put config/order-service/data - <<'EOF'
feature:
  new-checkout: true
EOF
```

## 실무에서 걸리는 지점

- ==**`/catalog`로 라우팅하면 죽은 인스턴스로 요청이 간다.**== 직접 API를 쓰는 클라이언트는 `/health/service?passing`을 써야 하고, 클라이언트 리졸버가 DNS 결과를 오래 캐시하면 Consul이 걸러낸 인스턴스가 다시 살아난다.
- **Script 체크는 임의 명령 실행 경로다.** `enable_script_checks`를 켜면 HTTP API로 등록한 체크도 스크립트를 실행할 수 있다. 필요하면 로컬 구성 파일만 허용하는 `enable_local_script_checks`를 쓴다.
- **TTL 체크는 푸시 스레드가 멈추면 프로세스가 살아 있어도 critical이 된다.** 푸시 주기는 TTL의 절반 이하로 두고 푸시 실패를 메트릭으로 남긴다.
- **블로킹 쿼리는 서버 부하를 만든다.** 수백 인스턴스가 watch를 걸면 매 변경마다 전부가 응답을 받고 재요청한다. `delay`를 넓히고 prefix 단위로 묶으며 자주 바뀌는 값은 KV에 두지 않는다.
- **Session 락은 TTL과 lock-delay를 함께 본다.** 세션 만료 후 기본 15초 동안 재획득이 막힌다. 보유자는 renew를 주기적으로 호출하고 실패 시 작업을 중단해야 한다.

## 관련 글

- [Consul 아키텍처와 배포 — Raft·Gossip·클러스터](/notes/infra/consul-architecture-deploy/)
- [Service Mesh·보안·백업](/notes/infra/consul-mesh-security-backup/)
