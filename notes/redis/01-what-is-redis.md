---
title: "Redis란 — 역할 분담과 CLI 첫걸음"
series: redis
part: "기초"
order: 1
summary: "Redis는 PostgreSQL을 대체하지 않는 인메모리 키-값 계층이며, 단일 스레드 atomic 명령이 핵심 가치다."
tags: [Redis, 인메모리, 키-값 저장소, redis-cli, Lettuce]
sources: [data-infra/2026-05-17-redis-intro.md, 2026-05-02-redis-basics.md]
updated: 2026-08-29
---

디스크 기반 관계형 DB 하나로 서비스를 운영하면 세 가지 문제가 반복된다. 같은 SELECT 결과를 매 요청마다 다시 읽어 DB 커넥션과 CPU를 소모하고, 로그인 세션을 서버 로컬 메모리에 두면 서버가 늘어날 때 sticky session 없이는 세션이 유지되지 않으며, 조회수·좋아요 같은 카운터를 read-modify-write로 갱신하면 동시 요청 사이에 갱신이 유실된다. PostgreSQL의 응답 시간은 ms 단위이므로 이런 작업을 모두 DB에 맡기면 지연과 부하가 함께 커진다. Redis는 이 세 문제를 RAM 상의 자료구조와 atomic 명령으로 해결하는 계층이다.

## 핵심 개념

Redis(REmote DIctionary Server)는 모든 데이터를 RAM에 두고 키로 값을 찾는 키-값 저장소다. RAM 접근은 수십 ns, 디스크 임의 접근은 수 ms 단위이므로 디스크 I/O를 경로에서 제거하는 것만으로 지연 시간이 μs 영역으로 내려간다. 여기에 값 자리에 String뿐 아니라 Hash·List·Set·Sorted Set·Stream 같은 자료구조가 들어간다는 점이 Memcached와의 차이다. 카운터 증가를 클라이언트가 읽고 더하고 쓰는 대신 `INCR` 한 명령으로 끝내고, Top N 랭킹을 `ZADD`와 `ZREVRANGE` 두 명령으로 처리한다.

명령 실행은 단일 스레드다. 네트워크 I/O는 별도 스레드가 처리하므로 병목이 되지 않으면서, 모든 명령이 서버 안에서 쪼개지지 않고 실행되어 atomic이 기본으로 보장된다. 분산 환경에서 락 없이 동시성 문제를 피할 수 있는 근거가 이 구조다. 반대로 한 명령이 오래 걸리면 전체가 멈춘다는 제약도 같은 구조에서 나온다.

PostgreSQL과의 관계는 대체가 아니라 보완이다.

| 항목 | PostgreSQL | Redis |
|:---|:---|:---|
| 저장 위치 | 디스크 | 메모리(디스크는 보조) |
| 데이터 모델 | 관계형, JOIN | 키-값 + 자료구조 |
| 지연 시간 | ms | μs |
| 트랜잭션 | ACID | MULTI/EXEC 수준의 부분 지원 |
| 용량 | TB | RAM 크기가 상한 |
| 역할 | source of truth | 캐시·세션·실시간 가공물 |

Redis도 RDB 스냅샷과 AOF 로그로 디스크에 기록하지만, 이는 재시작 시 대부분을 복구하기 위한 장치이지 커밋 즉시 영속을 보장하는 설계가 아니다. 따라서 진실은 PostgreSQL에 두고 Redis에는 언제든 사라져도 재생성 가능한 데이터만 둔다는 원칙이 성립한다.

키는 항상 문자열이며 `user:1000`, `items:views:a1`처럼 콜론으로 계층을 표현하는 관습을 따른다. 운영 중인 시스템에서 키 패턴을 바꾸면 전체 데이터 마이그레이션이 따라오므로 키 생성은 처음부터 헬퍼 함수 한 곳에 모은다.

클라이언트 라이브러리는 ORM이 아니라 명령어를 그대로 매핑하는 얇은 래퍼다. Java에서는 Jedis와 Lettuce가 있고 Spring Boot는 Lettuce를 기본으로 채택한다. 어느 쪽을 쓰든 메서드 호출이 곧 Redis 명령이므로 명령어 자체를 알아야 라이브러리를 쓸 수 있다.

## 코드

Docker로 서버를 띄우고 redis-cli로 기본 명령 다섯 개를 확인한다. 기본 포트는 6379다.

```bash
docker run --name redis -p 6379:6379 -d redis:7
docker exec -it redis redis-cli

127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET user:1000:name "Alice" EX 3600
OK
127.0.0.1:6379> GET user:1000:name
"Alice"
127.0.0.1:6379> EXISTS user:1000:name
(integer) 1
127.0.0.1:6379> DEL user:1000:name
(integer) 1
127.0.0.1:6379> DBSIZE
(integer) 0
```

Spring Boot 3.x에서 `spring-boot-starter-data-redis`를 추가하면 Lettuce 기반 `StringRedisTemplate`이 자동 구성된다. 접속 정보는 `spring.data.redis.*` 프리픽스를 쓴다.

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 2s
```

키 생성을 한 곳에 모으고, 캐시 값에는 TTL을 함께 지정한다. 카운터는 `increment`로 atomic하게 올린다.

```java
@Service
public class UserCacheService {

    private final StringRedisTemplate redis;

    public UserCacheService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    static String nameKey(long userId) { return "user:%d:name".formatted(userId); }
    static String viewKey(String itemId) { return "items:views:" + itemId; }

    public void cacheName(long userId, String name) {
        redis.opsForValue().set(nameKey(userId), name, Duration.ofHours(1));
    }

    public Optional<String> findName(long userId) {
        return Optional.ofNullable(redis.opsForValue().get(nameKey(userId)));
    }

    public long increaseView(String itemId) {
        return redis.opsForValue().increment(viewKey(itemId));
    }
}
```

## 실무에서 걸리는 지점

- `KEYS *`는 단일 스레드를 키 개수만큼 점유해 그 동안 모든 요청이 멈춘다. 운영에서는 `SCAN 0 MATCH user:* COUNT 100`처럼 커서 기반으로 나눠 조회한다.
- TTL 없는 키가 쌓이면 RAM 상한에 도달해 eviction이 발동하거나 쓰기가 실패한다. 임시 데이터는 저장 시점에 `EX`나 `Duration`으로 만료를 지정한다.
- Redis 값은 바이트열이다. 객체를 직렬화 없이 넣으면 `toString()` 결과가 저장되므로 JSON 직렬화를 명시하고, `RedisTemplate`의 기본 JDK 직렬화는 다른 언어 클라이언트와 호환되지 않는다.
- 캐시는 재시작·eviction·장애로 언제든 비어 있을 수 있다. miss 시 DB에서 읽어 다시 채우는 cache-aside를 기본으로 두고, Redis에만 존재하는 데이터를 만들지 않는다.
- persistence를 켜도 마지막 몇 초는 유실될 수 있다. 주문·결제 같은 기록은 PostgreSQL에 먼저 커밋하고 Redis는 그 사본으로만 쓴다.

## 관련 글

- [데이터 타입 개관](/notes/redis/data-types-overview/)
- [String·Hash — 값 캐싱과 객체 저장](/notes/redis/string-hash/)
- [캐싱 패턴 — Cache-Aside·스탬피드·Hot Key](/notes/redis/caching-patterns-stampede/)
