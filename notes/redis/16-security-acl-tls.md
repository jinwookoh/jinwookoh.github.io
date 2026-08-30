---
title: "보안 — ACL·TLS"
series: redis
part: "운영"
order: 16
summary: "default 사용자 잠금과 ACL 최소 권한, 그리고 클라이언트·복제·클러스터 버스까지 TLS로 닫는 방법"
tags: [Redis, ACL, TLS, mTLS, Spring Data Redis]
sources: [data-infra/2026-05-17-redis-acl-security.md, data-infra/2026-05-17-redis-tls-encryption.md]
updated: 2026-08-29
---

Redis를 기본 설정으로 띄우면 `default` 사용자가 비밀번호 없이 모든 명령과 모든 키에 접근할 수 있고, 모든 통신은 평문으로 흐른다. 포트가 노출되는 순간 `FLUSHALL`이나 `CONFIG SET`으로 데이터가 지워지거나 서버가 장악되고, 네트워크 중간에서 세션 토큰이 그대로 읽힌다. `requirepass`는 비밀번호 하나로 전권을 주므로 애플리케이션·배치·모니터링 도구가 같은 권한을 공유하는 문제를 풀지 못한다. Redis 6부터는 ACL로 사용자·명령·키·채널 단위 권한을 나누고, TLS로 전송 구간을 암호화한다.

## 핵심 개념

### ACL DSL

ACL 규칙은 `on +@read -flushall ~user:* &notif:* >password`처럼 한 줄의 DSL로 표현한다.

| 구분자 | 의미 |
|:---:|:---|
| `on` / `off` | 사용자 활성·비활성 |
| `+cmd` / `-cmd` | 개별 명령 허용·차단 |
| `+@cat` / `-@cat` | 카테고리 단위 허용·차단 |
| `~pattern` | 접근 가능한 키 glob 패턴 |
| `%R~` / `%W~` | 읽기 전용·쓰기 전용 키 패턴 (Redis 7+) |
| `&pattern` | Pub/Sub 채널 패턴 |
| `>pw` / `<pw` | 비밀번호 추가·제거 (SHA-256 해시로 저장) |
| `nopass` | 비밀번호 없음 |
| `reset` / `resetkeys` | 권한 전체·키 패턴 초기화 |

`ACL SETUSER`는 누적 동작이라 권한을 다시 정의할 때는 `reset`을 앞에 붙인다. 명령 카테고리는 `@read`·`@write`·`@admin`·`@dangerous` 같은 기능 분류와 `@string`·`@hash` 같은 자료구조 분류가 있고, `ACL CAT <name>`으로 소속 명령을 확인한다. `@dangerous`에는 `FLUSHALL`·`KEYS`·`SHUTDOWN`·`CONFIG`가 모여 있다. ACL은 메모리에만 반영되므로 `aclfile`을 지정하고 `ACL SAVE`로 내려야 재시작 후에도 유지된다.

운영 환경에서는 역할별로 사용자를 나눈다. 관리자는 `+@all`에 강한 비밀번호를 두고 사람만 사용한다. 애플리케이션 사용자는 필요한 카테고리와 채널만 열고 `-@dangerous`를 붙이며 키를 `app:*` prefix로 묶는다. 모니터링 도구는 `+@read -@dangerous`, 캐시 전용 클라이언트는 `+get +set +del +expire ~cached:*` 정도로 좁힌다. `default`는 비밀번호를 걸거나 `off`로 비활성화한다.

### TLS와 통신 경로

Redis는 기본 빌드에 TLS가 빠져 있어 `make BUILD_TLS=yes`로 빌드해야 하며, `INFO server`의 `tls_enabled:1`로 확인한다. 클라이언트-서버, 복제, Cluster bus, Sentinel 통신이 각각 별도 옵션으로 암호화되며, `tls-port`만 켜면 나머지는 평문이다.

| 경로 | 옵션 |
|:---|:---|
| 클라이언트 | `tls-port`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file` |
| 복제 | `tls-replication yes` |
| Cluster bus | `tls-cluster yes` |
| Sentinel | `sentinel.conf`에 동일 옵션 별도 지정 |

`tls-auth-clients yes`(기본값)는 클라이언트 인증서까지 요구하는 mTLS 모드다. 유출된 비밀번호만으로는 접속할 수 없지만 클라이언트 인증서 배포·갱신 부담이 따른다. `optional`은 인증서가 있을 때만 검증하고, `no`는 서버 인증서만 검증한다.

## 코드

역할별 사용자를 만들고 영구 저장하는 ACL 설정이다. `reset`으로 시작해 누적 규칙을 초기화한다.

```bash
ACL SETUSER admin reset on >admin-strong-pass ~* &* +@all
ACL SETUSER app reset on >app-pass +@read +@write +@string +@hash +@sorted_set +@stream -@dangerous ~app:* &events:*
ACL SETUSER reader reset on >read-pass +@read -@dangerous %R~app:*
ACL SETUSER default off
ACL SAVE
CLIENT KILL USER default
```

평문 포트를 닫고 모든 경로를 TLS로 통일하는 `redis.conf`다.

```
port 0
tls-port 6379
tls-cert-file /etc/redis/tls/redis.crt
tls-key-file /etc/redis/tls/redis.key
tls-ca-cert-file /etc/redis/tls/ca.crt
tls-auth-clients yes
tls-replication yes
tls-cluster yes
tls-protocols "TLSv1.2 TLSv1.3"
```

Spring Boot 3.x에서 ACL 사용자와 mTLS를 SSL Bundle로 연결하는 설정이다. Lettuce가 `username`·`password`로 `AUTH`를 보내고, 번들의 keystore가 클라이언트 인증서, truststore가 사설 CA를 담는다.

```yaml
spring:
  ssl:
    bundle:
      pem:
        redis-tls:
          keystore:
            certificate: file:/etc/app/tls/client.crt
            private-key: file:/etc/app/tls/client.key
          truststore:
            certificate: file:/etc/app/tls/ca.crt
  data:
    redis:
      host: redis-host
      port: 6379
      username: app
      password: ${REDIS_APP_PASSWORD}
      ssl:
        enabled: true
        bundle: redis-tls
      lettuce:
        pool:
          enabled: true
          max-active: 16
```

권한이 없는 명령은 `NOPERM` 오류로 돌아오며, 재시도 대상이 아니므로 즉시 실패시킨다.

```java
@Service
public class CacheService {

    private final StringRedisTemplate redis;

    public CacheService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public Optional<String> find(String key) {
        try {
            return Optional.ofNullable(redis.opsForValue().get("app:" + key));
        } catch (RedisSystemException e) {
            if (e.getMessage() != null && e.getMessage().contains("NOPERM")) {
                throw new IllegalStateException("ACL 권한 부족: " + key, e);
            }
            throw e;
        }
    }
}
```

## 실무에서 걸리는 지점

- **권한 변경이 기존 연결에 적용되지 않는다.** ==이미 인증된 연결은 `ACL SETUSER` 이후에도 예전 권한을 유지한다.== 권한을 줄이거나 비밀번호를 바꾼 뒤에는 `CLIENT KILL USER <name>`으로 끊어야 즉시 반영된다.
- **`aclfile` 없이 만든 사용자는 재시작 시 사라진다.** ==`ACL SAVE`가 실패했거나 `aclfile`이 없으면 재기동 후 애플리케이션이 인증 실패로 멈춘다.==
- **평문 포트가 남아 있으면 TLS는 우회된다.** `port 6379`와 `tls-port 6380`을 같이 열고 방화벽으로 6379를 막지 않으면 평문 접속이 가능하다. 운영 환경은 `port 0`이 표준이다.
- **복제·Cluster bus는 별도 옵션이다.** ==`tls-replication`을 켜지 않으면 다른 AZ의 replica로 전체 데이터셋이 평문으로 흐른다.== VPC 내부라는 이유로 생략하면 안 된다.
- **TLS는 CPU를 쓴다.** 단순 GET 처리량이 평문 대비 15~30% 줄고 핸드셰이크 비용은 연결마다 든다. 연결 풀과 AES-NI로 완화하고, 트래픽이 매우 크면 TLS 종단 프록시 분리를 검토한다.
- **인증서 만료는 전면 장애다.** 90일짜리 인증서를 쓰면 자동 갱신과 Redis reload를 함께 자동화해야 한다.

## 관련 글

- [Replication과 Sentinel](/notes/redis/replication-sentinel/)
- [Cluster와 일관된 해싱](/notes/redis/cluster-consistent-hashing/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
