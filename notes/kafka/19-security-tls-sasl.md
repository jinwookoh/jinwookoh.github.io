---
title: "인증 — TLS·SASL"
series: kafka
part: "보안"
order: 19
summary: "운영 표준은 SASL_SSL + SCRAM-SHA-512이며, TLS는 전송 보호와 브로커 신원, SASL은 클라이언트 신원을 맡는다."
tags: [Kafka, TLS, SASL, SCRAM, mTLS]
sources: [data-infra/2026-05-17-kafka-security-overview.md, data-infra/2026-05-17-kafka-security-ssl.md, data-infra/2026-05-17-kafka-security-sasl.md]
updated: 2026-08-29
---

Kafka의 기본 리스너는 PLAINTEXT다. 네트워크에 닿는 누구든 아무 토픽이나 읽고 쓸 수 있고, 브로커 사이를 오가는 레코드가 그대로 노출된다. "누가 붙었는가"는 SASL 또는 클라이언트 인증서가, "전송 구간이 안전한가"는 TLS가 맡는다. ==인가(ACL)는 이 둘이 확정한 principal 위에서 동작하므로 인증이 흔들리면 ACL도 의미를 잃는다.==

## 핵심 개념

### security.protocol 네 가지

| Protocol | 인증 | 암호화 | 용도 |
|:---|:---|:---|:---|
| PLAINTEXT | 없음 | 없음 | 로컬·학습 |
| SSL | 클라이언트 인증서(mTLS) 선택 | TLS | 인증서 기반 조직 |
| SASL_PLAINTEXT | SASL | 없음 | 신뢰 구간, 인증만 |
| SASL_SSL | SASL | TLS | 운영 표준 |

SSL 프로토콜은 클라이언트 신원을 `ssl.client.auth=required`일 때 인증서로 확인하고, SASL_SSL은 전송 보호를 TLS에, 신원 확인을 SASL에 나눠 맡긴다. 인터브로커 통신도 `security.inter.broker.protocol`로 같은 보호를 건다.

### TLS — Keystore·Truststore·mTLS

Keystore는 자신의 private key와 인증서를, Truststore는 신뢰할 CA 인증서를 담는다. 브로커는 keystore로 신원을 증명하고 truststore로 상대를 검증하며, 모든 브로커와 클라이언트가 같은 CA를 truststore에 두는 구성이 표준이다. 인증서의 CN과 subjectAltName에는 브로커 hostname이 들어가야 한다. 클라이언트가 `ssl.endpoint.identification.algorithm=https`로 hostname 검증을 켰을 때 SAN 불일치는 핸드셰이크 실패로 이어진다.

`ssl.client.auth`는 `required`(mTLS 필수)·`requested`·`none` 세 값이다. mTLS에서는 클라이언트 인증서의 DN이 principal이 되며 `ssl.principal.mapping.rules`로 `CN=app-user-1,OU=...`를 `User:app-user-1`로 축약한다. 프로토콜은 TLSv1.3·1.2만 허용하고 cipher는 GCM 계열 AEAD로 제한한다.

### SASL — 메커니즘 다섯 가지

SASL은 JAAS 위에서 동작하며 `sasl.jaas.config` 인라인 설정이 표준이다. 브로커는 `listener.name.<listener>.<mechanism>.sasl.jaas.config` 키로 리스너별 설정을 둔다.

- **PLAIN** — 비밀번호를 그대로 전송하고 브로커 JAAS에 `user_<name>="..."` 형식으로 모든 사용자를 평문 정의한다. 운영에서는 권장하지 않는다.
- **SCRAM-SHA-256/512** — challenge-response로 비밀번호를 전송하지 않고 브로커는 salted hash만 보관한다. `kafka-configs.sh --entity-type users`로 자격 증명을 동적 관리하며 KRaft에서는 전 브로커에 즉시 전파된다. 운영 표준이며 SHA-512를 택한다.
- **GSSAPI** — Kerberos. 기존 AD·KDC 인프라를 keytab과 principal로 활용한다. KDC 운영과 NTP 시각 동기화가 따라온다.
- **OAUTHBEARER** — OAuth 2.0/OIDC 토큰 기반. 클라이언트는 login callback handler로 토큰을 받고 `sasl.login.refresh.*`에 따라 자동 갱신하며, 브로커는 server callback handler로 검증한다. 클라우드·SSO 환경의 표준이다.
- **AWS_MSK_IAM** — MSK 전용. IAM role을 그대로 쓰지만 AWS 밖 클라이언트에서는 쓰기 어렵다.

## 코드

브로커에 SASL_SSL 리스너와 SCRAM-SHA-512, 인터브로커 보호를 설정한다.

```properties
listeners=SASL_SSL://0.0.0.0:9093
advertised.listeners=SASL_SSL://broker-1.example.com:9093
security.inter.broker.protocol=SASL_SSL
sasl.enabled.mechanisms=SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512
listener.name.sasl_ssl.scram-sha-512.sasl.jaas.config=\
    org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="broker-admin" password="${BROKER_ADMIN_PASSWORD}";

ssl.keystore.location=/etc/kafka/ssl/broker-1.keystore.jks
ssl.keystore.password=${KEYSTORE_PASSWORD}
ssl.key.password=${KEY_PASSWORD}
ssl.truststore.location=/etc/kafka/ssl/kafka.truststore.jks
ssl.truststore.password=${TRUSTSTORE_PASSWORD}
ssl.enabled.protocols=TLSv1.3,TLSv1.2
ssl.client.auth=none
```

애플리케이션 사용자를 SCRAM 자격 증명으로 등록한다.

```bash
kafka-configs.sh --bootstrap-server broker-1.example.com:9093 \
    --command-config admin.properties \
    --alter --add-config 'SCRAM-SHA-512=[iterations=8192,password=order-svc-pass]' \
    --entity-type users --entity-name order-svc
```

Spring Boot 3.x 클라이언트는 자격 증명을 환경변수에서 주입하고 hostname 검증을 켠다.

```yaml
spring:
  kafka:
    bootstrap-servers: broker-1.example.com:9093
    properties:
      security.protocol: SASL_SSL
      sasl.mechanism: SCRAM-SHA-512
      sasl.jaas.config: >
        org.apache.kafka.common.security.scram.ScramLoginModule required
        username="${KAFKA_USERNAME}"
        password="${KAFKA_PASSWORD}";
      ssl.truststore.location: /etc/kafka/ssl/kafka.truststore.jks
      ssl.truststore.password: ${TRUSTSTORE_PASSWORD}
      ssl.endpoint.identification.algorithm: https
```

## 실무에서 걸리는 지점

- ==**인증서 만료.** 브로커 인증서가 만료되면 클라이언트와 인터브로커 연결이 한꺼번에 거부된다.== 만료 30~60일 전 알림을 걸고 Vault PKI·ACME 같은 자동 발급 경로를 둔다. keystore·truststore 경로를 유지한 채 파일을 교체하거나 `kafka-configs.sh --alter`로 갱신하면 재시작 없이 반영된다.
- **PLAINTEXT 리스너 혼재.** `listeners=PLAINTEXT://9092,SSL://9093`처럼 두 리스너를 열어두면 9092가 우회로가 된다. 마이그레이션이 끝나면 PLAINTEXT 리스너를 제거한다.
- **hostname 검증 비활성.** `ssl.endpoint.identification.algorithm=`으로 비워두면 SAN 오류는 사라지지만 중간자 공격에 노출된다. 인증서 SAN을 고친다.
- **TLS 처리량 비용.** TLS를 켜면 sendfile 기반 zero-copy가 무력화되고 처리량이 15~30% 떨어진다. TLSv1.3과 AES-NI 가속이 되는 GCM cipher로 부담을 줄인다.
- **자격 증명 평문 저장.** properties에 박힌 비밀번호와 PLAIN의 JAAS 사용자 목록은 secret manager에서 환경변수로 주입한다. ZooKeeper 모드는 SCRAM 자격 증명이 ZK에 저장돼 ZK 인증까지 필요했으나 KRaft에서는 이 영역이 사라진다.

## 관련 글

- [인가 — ACL과 Multi-tenancy](/notes/kafka/security-acl-multitenancy/)
- [운영 기본 — Topic 관리·Reassign·Rolling Restart·KRaft](/notes/kafka/operations-kraft/)
