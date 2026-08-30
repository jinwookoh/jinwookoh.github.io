---
title: "서비스 분해와 아키텍처"
series: sns-project
part: "아키텍처"
order: 1
summary: "SNS를 서비스 4개로 나누고 Database-per-Service·Gateway·Kafka·Healthcheck로 묶는 기준을 정리한다"
tags: [Microservices, Spring Cloud Gateway, Database-per-Service, Kafka, Docker Compose]
sources: [2026-05-04-javaex-sns-microservices-architecture.md]
updated: 2026-08-29
---

회원·게시글·알림을 한 프로젝트에 컨트롤러 세 개로 두면 처음에는 빠르다. 문제는 운영에 들어간 뒤 나타난다. 게시글 트래픽이 폭주할 때 로그인까지 느려지고, 댓글 테이블 스키마를 바꾸면 알림 코드가 깨지며, DB 한 대가 멈추면 서비스 전체가 멈춘다. 배포 단위와 장애 단위가 하나로 묶여 있기 때문이다. 이 시리즈의 SNS는 그 결합을 끊기 위해 api-gateway·user·post·notification 네 개의 Spring Boot 3.x(Java 21) 서비스로 나누고, PostgreSQL 3대·Redis·Kafka·Elasticsearch·LocalStack S3·Mailhog를 Docker Compose 한 파일로 묶어 기동한다.

## 핵심 개념

### 요청 경로

브라우저 요청은 Next.js(3000)를 거쳐 API Gateway(8080) 한 곳으로 들어온다. 게이트웨이는 Path 조건으로 `/v1/users/**`를 User Service(8081), `/v1/posts/**`와 `/v1/media/**`를 Post Service(8082), `/v1/notifications/**`를 Notification Service(8083)로 라우팅한다. 각 서비스는 전용 PostgreSQL을 가지며, Redis(캐시·블랙리스트·랭킹)·Kafka(서비스 간 이벤트)·Elasticsearch(게시글 검색)·S3(미디어 저장)는 공용 인프라로 둔다.

### Database-per-Service

서비스 분해의 첫 번째 규칙은 DB를 서비스별로 분리하고 다른 서비스의 DB를 직접 조회하지 않는 것이다. 서비스를 나눴어도 DB를 공유하면 스키마 변경이 다른 서비스로 전파되므로 실질적으로 모놀리스와 같다.

| 서비스 | DB | 호스트 포트 | 보관 데이터 |
|---|---|---|---|
| User Service | userdb | 5435 | 회원, 구독 관계, RefreshToken |
| Post Service | postdb | 5433 | 게시글, 댓글, 좋아요, 미디어 메타, Outbox |
| Notification Service | notifdb | 5434 | 알림 로그, 이메일 발송 기록 |

분리로 얻는 것은 세 가지다. 독립 배포와 스케일링(postdb만 증설 가능), 스키마 변경 격리(댓글 테이블을 나눠도 다른 서비스 코드는 변경 없음), 장애 격리(postdb 장애 시에도 가입·로그인 유지). 대가로 서비스 사이에는 외래 키가 없다. `posts.user_id`는 `users.id`를 가리키지만 DB 제약은 없으며, 교차 서비스 일관성은 REST 호출과 Kafka 이벤트로 애플리케이션 수준에서 맞춘다.

### API Gateway의 책임

게이트웨이는 Spring Cloud Gateway를 사용하며 WebFlux 기반 논블로킹으로 동작한다. 책임은 두 가지다. 첫째, Authorization 헤더의 Bearer 토큰 서명을 검증하고 jti가 Redis 블랙리스트에 있으면(로그아웃된 토큰) 거부한다. 둘째, 통과한 요청에 `X-User-Id`·`X-User-Email` 헤더를 주입해 하위 서비스로 넘긴다. 하위 서비스는 토큰을 다시 파싱하지 않고 헤더만 읽는다. 이벤트 루프 위에서 동작하므로 Redis 접근은 `ReactiveStringRedisTemplate` 같은 리액티브 클라이언트로만 해야 한다.

### 포트 배치

호스트 포트 일부는 로컬에 설치된 기본 인스턴스와의 충돌을 피하기 위해 기본값에서 비켜 둔다. postgres-user 5435, redis 6380, elasticsearch 9203이 그 예이며, 컨테이너 내부 포트는 5432·6379·9200 그대로다.

## 코드

게이트웨이 GlobalFilter에서 검증이 끝난 사용자 정보를 헤더로 주입해 하위 서비스로 전달한다.

```java
@Component
public class UserHeaderFilter implements GlobalFilter, Ordered {

    private final JwtVerifier jwtVerifier;
    private final ReactiveStringRedisTemplate redis;

    public UserHeaderFilter(JwtVerifier jwtVerifier, ReactiveStringRedisTemplate redis) {
        this.jwtVerifier = jwtVerifier;
        this.redis = redis;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = jwtVerifier.extract(exchange.getRequest());
        if (token == null) {
            return chain.filter(exchange);
        }
        Claims claims = jwtVerifier.verify(token);
        return redis.hasKey("blacklist:" + claims.getId())
            .flatMap(blocked -> {
                if (blocked) {
                    exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
                    return exchange.getResponse().setComplete();
                }
                ServerWebExchange mutated = exchange.mutate()
                    .request(r -> r.header("X-User-Id", claims.getSubject())
                                   .header("X-User-Email", claims.get("email", String.class)))
                    .build();
                return chain.filter(mutated);
            });
    }

    @Override
    public int getOrder() {
        return -1;
    }
}
```

하위 서비스는 주입된 헤더로 사용자를 식별한다.

```java
@RestController
@RequestMapping("/v1/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/me")
    public UserDto me(@RequestHeader("X-User-Id") Long userId) {
        return userService.findById(userId);
    }
}
```

Compose에서 Kafka 이중 리스너와 healthcheck 기반 기동 순서를 정의한다.

```yaml
zookeeper:
  image: confluentinc/cp-zookeeper
  healthcheck:
    test: ["CMD-SHELL", "echo srvr | nc localhost 2181 | grep -q Mode"]
    interval: 10s
    retries: 10

kafka:
  image: confluentinc/cp-kafka
  depends_on:
    zookeeper:
      condition: service_healthy
  environment:
    KAFKA_LISTENERS: PLAINTEXT_INTERNAL://0.0.0.0:29092,PLAINTEXT_EXTERNAL://0.0.0.0:9092
    KAFKA_ADVERTISED_LISTENERS: PLAINTEXT_INTERNAL://kafka:29092,PLAINTEXT_EXTERNAL://localhost:9092
    KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT_INTERNAL

postgres-user:
  image: postgres:16
  ports: ["5435:5432"]
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U appuser -d userdb"]

elasticsearch:
  image: elasticsearch:8.13.0
  ports: ["9203:9200"]
  environment:
    - ES_JAVA_OPTS=-Xms128m -Xmx128m
    - discovery.type=single-node
```

## 실무에서 걸리는 지점

- **`X-User-Id` 위장.** 클라이언트가 게이트웨이를 우회해 8081~8083으로 직접 접속하면서 `X-User-Id: 1`을 넣으면 해당 사용자로 위장된다. 운영에서는 서비스 포트를 외부에 노출하지 않고 게이트웨이만 열어야 한다.
- **Kafka advertised.listeners.** 클라이언트는 최초 접속 후 브로커가 알려준 advertised 주소로 재접속한다. 컨테이너는 `kafka:29092`, 호스트에서 실행한 Spring Boot는 `localhost:9092`를 써야 하며, 주소가 잘못되면 첫 핸드셰이크는 성공하고 두 번째 요청부터 끊기는 증상이 나타난다.
- **Zookeeper healthcheck.** Confluent 이미지는 `ruok` 4글자 명령을 기본 화이트리스트에서 제외한다. `ruok`로 작성하면 영원히 unhealthy 상태로 남으므로 `srvr` 출력에 `Mode`가 포함되는지로 확인한다.
- **Elasticsearch OOM.** 기본 힙이 512MB~1GB라 Docker VM 메모리가 부족하면 exit code 137로 종료된다. 로컬에서 컨테이너 14개를 함께 띄울 때는 힙을 128MB로 제한하되, 운영 값으로 쓰면 안 된다.
- **게이트웨이 블로킹 호출.** WebFlux 이벤트 루프에서 동기 `StringRedisTemplate`이나 블로킹 HTTP 클라이언트를 호출하면 게이트웨이 전체 처리량이 떨어진다.

## 관련 글

- [API Gateway·JWT·OAuth2 인증](/notes/sns-project/gateway-jwt-oauth2/)
- [Kafka 이벤트 흐름·Outbox·Redis 활용 패턴](/notes/sns-project/kafka-outbox-redis-patterns/)
- [Elasticsearch 검색과 S3 업로드](/notes/sns-project/elasticsearch-s3/)
