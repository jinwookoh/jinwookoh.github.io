---
title: "인가 — ACL과 Multi-tenancy"
series: kafka
part: "보안"
order: 20
summary: "인증된 principal에게 PREFIXED ACL과 Quota를 팀 단위로 묶어 부여해야 공유 클러스터가 유지된다"
tags: [Kafka, ACL, StandardAuthorizer, Quota, Multi-tenancy]
sources: [data-infra/2026-05-17-kafka-security-authorization-acl.md, data-infra/2026-05-17-kafka-multi-tenancy.md]
updated: 2026-08-29
---

TLS와 SASL로 클라이언트가 누구인지 확인해도, 무엇을 할 수 있는지는 별개의 문제다. 인가 규칙이 없으면 인증만 통과한 애플리케이션이 다른 팀의 topic을 읽고 임의 이름의 topic을 만든다. 여러 팀이 한 클러스터를 공유하면 한 팀의 producer가 대역폭을 독점해 나머지 팀의 지연이 함께 오른다. ==ACL은 접근 범위를, Quota와 naming convention은 자원 사용 범위를 팀 단위로 가른다.==

## 핵심 개념

ACL 한 건은 Principal · Operation · Resource 세 요소로 구성되며 "Principal이 Resource에 대해 Operation을 할 수 있다"로 읽는다. 여기에 Permission Type(ALLOW · DENY), Host(기본 `*`), Resource Pattern Type이 붙는다. Principal은 SASL/SCRAM이면 `User:<username>`, mTLS면 인증서 DN이다. Resource Type은 Topic · Group · Cluster · TransactionalId · DelegationToken이고, Operation은 많지만 애플리케이션이 실제로 쓰는 것은 Topic의 Read · Write · Describe와 Group의 Read · Describe다.

| Pattern | 매칭 | 용도 |
|:---|:---|:---|
| LITERAL | 이름 정확 일치 | 단일 topic 권한 |
| PREFIXED | 접두사 일치 | 팀 단위 권한, 운영 표준 |
| MATCH | 와일드카드 조회 | `--list` · `--remove` 필터 전용 |

PREFIXED가 표준인 이유는 새 topic이 늘어나도 ACL을 다시 추가할 필요가 없기 때문이다. 이 이점은 topic 이름에 팀 접두사가 일관되게 붙어 있을 때만 성립하므로 ACL 설계와 naming convention은 분리되지 않는다. 권장 형식은 `{env}.{team}.{domain}.{event-type}[.v{N}]`이다. Kafka에는 topic rename이 없어 컨벤션은 처음에 고정하고, `auto.create.topics.enable=false`와 Create 권한 제한으로 컨벤션 밖 topic 생성을 막는다.

Authorizer는 요청마다 매칭되는 DENY가 있으면 거부, ALLOW가 있으면 허용, 둘 다 없으면 `allow.everyone.if.no.acl.found`(기본 `false`)를 따른다. DENY가 우선하므로 전체 허용 후 특정 principal만 차단할 수 있다. `super.users`의 principal은 평가를 건너뛴다. KRaft에서는 `org.apache.kafka.metadata.authorizer.StandardAuthorizer`가 ACL을 metadata log에 저장하며, ZooKeeper용 `AclAuthorizer`는 쓰지 않는다. 외부 정책 시스템과 통합하려면 `org.apache.kafka.server.authorizer.Authorizer`를 직접 구현한다.

Quota는 user · client.id · (user, client.id) 또는 default 단위로 걸린다. `producer_byte_rate`와 `consumer_byte_rate`는 대역폭을, `request_percentage`는 network · I/O 스레드 점유율을 제한한다. 초과 시 broker는 거부하지 않고 응답에 `throttle_time_ms`를 실어 보내며 클라이언트가 그만큼 대기한다. 메시지 손실 없이 속도만 내려간다.

격리 수준은 공유 클러스터의 논리 분리, broker pool 분리, 별도 클러스터 순으로 강해진다. 장애 영향이 큰 영역만 별도 클러스터로 빼는 혼합 구성이 대규모 환경의 일반 형태다.

## 코드

팀 하나를 onboarding하는 표준 절차다. SCRAM 사용자, PREFIXED ACL, Quota를 한 스크립트에 묶는다.

```bash
TEAM=order-team; ENV=prod; PRINCIPAL="User:${TEAM}-app"
OPTS="--bootstrap-server broker:9093 --command-config admin.properties"

kafka-configs.sh $OPTS --alter \
  --add-config 'SCRAM-SHA-512=[iterations=8192,password=CHANGE_ME]' \
  --entity-type users --entity-name "${TEAM}-app"

kafka-acls.sh $OPTS --add --allow-principal "${PRINCIPAL}" \
  --operation Read --operation Write --operation Describe \
  --topic "${ENV}.${TEAM}." --resource-pattern-type PREFIXED

kafka-acls.sh $OPTS --add --allow-principal "${PRINCIPAL}" \
  --operation Read --operation Describe \
  --group "${ENV}.${TEAM}." --resource-pattern-type PREFIXED

kafka-configs.sh $OPTS --alter \
  --add-config 'producer_byte_rate=20971520,consumer_byte_rate=20971520,request_percentage=30' \
  --entity-type users --entity-name "${TEAM}-app"
```

같은 작업을 AdminClient로 수행하는 Spring 서비스다.

```java
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.common.acl.*;
import org.apache.kafka.common.quota.*;
import org.apache.kafka.common.resource.*;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class TenantOnboardingService {

    private final AdminClient admin;

    public TenantOnboardingService(AdminClient admin) {
        this.admin = admin;
    }

    public void onboard(String env, String team) throws Exception {
        String principal = "User:" + team + "-app";
        String prefix = env + "." + team + ".";
        var topic = new ResourcePattern(ResourceType.TOPIC, prefix, PatternType.PREFIXED);
        var group = new ResourcePattern(ResourceType.GROUP, prefix, PatternType.PREFIXED);

        admin.createAcls(List.of(
            allow(topic, principal, AclOperation.READ),
            allow(topic, principal, AclOperation.WRITE),
            allow(topic, principal, AclOperation.DESCRIBE),
            allow(group, principal, AclOperation.READ),
            allow(group, principal, AclOperation.DESCRIBE)
        )).all().get();

        var entity = new ClientQuotaEntity(Map.of(ClientQuotaEntity.USER, team + "-app"));
        admin.alterClientQuotas(List.of(new ClientQuotaAlteration(entity, List.of(
            new ClientQuotaAlteration.Op("producer_byte_rate", 20_971_520.0),
            new ClientQuotaAlteration.Op("consumer_byte_rate", 20_971_520.0),
            new ClientQuotaAlteration.Op("request_percentage", 30.0)
        )))).all().get();
    }

    private static AclBinding allow(ResourcePattern p, String principal, AclOperation op) {
        return new AclBinding(p, new AccessControlEntry(principal, "*", op, AclPermissionType.ALLOW));
    }
}
```

애플리케이션은 팀 principal로 인증하고 `client.id`를 서비스 이름으로 고정해 Quota와 메트릭이 서비스 단위로 분해되게 한다.

```yaml
spring:
  application:
    name: order-service
  kafka:
    bootstrap-servers: broker:9093
    client-id: ${spring.application.name}
    properties:
      security.protocol: SASL_SSL
      sasl.mechanism: SCRAM-SHA-512
      sasl.jaas.config: >-
        org.apache.kafka.common.security.scram.ScramLoginModule required
        username="order-team-app" password="${KAFKA_PASSWORD}";
    consumer:
      group-id: prod.order-team.order-service
```

## 실무에서 걸리는 지점

- ==**Group ACL 누락.** Topic Read만 주면 poll은 되다가 offset commit에서 `GroupAuthorizationException`이 난다.== `kafka-acls.sh --consumer`는 Topic Read · Describe와 Group Read를, `--producer`는 Topic Write · Describe · Create와 Cluster IdempotentWrite를 한 번에 넣는다.
- **mTLS principal 불일치.** `ssl.principal.mapping.rules`가 어긋나면 ACL의 이름과 실제 principal이 달라 모든 요청이 거부된다. broker 로그의 principal 문자열을 ACL과 대조한다.
- **`super.users` 남발과 `allow.everyone.if.no.acl.found=true`.** 둘 다 ACL을 무력화한다. 운영 admin 1~2명만 super.users에 둔다.
- **Quota 부재 또는 과소.** 없으면 producer 하나가 대역폭을 차지하고, 너무 낮으면 throttle이 정상 트래픽에 번진다. user · client-id 별 throttle-time 메트릭을 보며 점진적으로 조정한다.
- **Custom Authorizer 지연.** 인가 판정은 모든 요청 경로에 들어가므로 외부 시스템을 동기 조회하면 throughput이 직접 깎인다. 로컬 캐시가 필수다.

## 관련 글

- [인증 — TLS·SASL](/notes/kafka/security-tls-sasl/)
- [Admin Client — API 5종 개관과 관리 작업](/notes/kafka/admin-client/)
- [Broker·Topic 설정](/notes/kafka/broker-topic-config/)
