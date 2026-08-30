---
title: "gRPC — 에러·인터셉터·보안·운영"
series: reactive-spring
part: "gRPC"
order: 21
summary: "Status Code로 재시도 가능 여부를 표현하고, 인증·로깅은 인터셉터로 분리하며, 운영에서는 mTLS·Health Check·KeepAlive를 갖춘다"
tags: [gRPC, Interceptor, Status Code, mTLS, Health Check]
sources: [2026-05-03-grpc-error-handling.md, 2026-05-03-grpc-interceptors.md, 2026-05-03-grpc-security.md, 2026-05-03-grpc-advanced.md]
updated: 2026-08-29
---

RPC 모드 구현은 메서드 안에서 끝나지만, 실패 시 재시도를 결정할 근거, 인증·로깅을 반복하지 않을 위치, 평문 페이로드의 보호, 인스턴스 상태 확인은 메서드 밖의 문제다. 이를 비워 두면 모든 실패가 UNKNOWN으로 뭉개지고, 토큰 검증 코드가 서비스마다 복사되며, 일반 Kubernetes Service 뒤의 서버는 한 파드에만 트래픽이 몰린다.

## 핵심 개념

### Status Code는 분류, Description은 메시지, Details는 구조화된 정보

gRPC 에러는 16종의 Status Code로 표현된다. 서버는 `Status.NOT_FOUND.withDescription(...).asRuntimeException()`으로 호출을 닫고, 클라이언트는 `StatusRuntimeException`에서 `getStatus().getCode()`와 `getTrailers()`를 읽는다. 선택 기준은 재시도 가능 여부다.

| 분류 | Status Code | 재시도 |
|:---|:---|:---|
| 일시적 장애 | UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED | 가능 (백오프 후) |
| 요청의 문제 | INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, FAILED_PRECONDITION | 불가 |
| 인증·인가 | UNAUTHENTICATED, PERMISSION_DENIED | 불가 |
| 서버 결함 | INTERNAL, UNIMPLEMENTED, DATA_LOSS | 불가 |

필드 단위 검증 오류처럼 문자열로 부족한 정보는 `google.rpc.Status`의 `details`에 `Any`로 감싼 표준 메시지(BadRequest, RetryInfo 등)를 넣는다. 잔액 부족 같은 도메인 결과는 응답 필드로 표현한다. 스트림은 `onError` 한 번으로 종료되므로 일부 항목만 실패한 상황을 에러로 나타낼 수 없다.

### 인터셉터는 양쪽 호출의 횡단 관심사 지점

`ServerInterceptor`는 들어오는 호출, `ClientInterceptor`는 나가는 호출을 가로챈다. 서버 인터셉터는 `Metadata`를 검증해 실패 시 `call.close`로 종료하고, 성공 시 `Context`에 사용자 정보를 담아 `Contexts.interceptCall`로 넘기며 서비스 메서드는 `Context.Key.get()`으로 읽는다. 응답 시점 개입은 `ForwardingServerCall`의 `close`, 요청 헤더 주입은 `ForwardingClientCall`의 `start`를 오버라이드한다. `@GrpcGlobalServerInterceptor`는 전역, `@GrpcService(interceptors = ...)`는 서비스별 등록이며 `@Order`가 낮을수록 먼저 실행된다.

### 보안은 암호화·인증·인가 세 층

단방향 TLS는 외부 클라이언트용, 클라이언트도 인증서를 제시하는 mTLS는 서비스 간 통신의 기본값이며 Istio·Linkerd는 사이드카에서 이를 자동 적용한다. 인증은 인터셉터에서 `Authorization: Bearer` JWT를 검증하고, Spring Security를 붙이면 `@EnableMethodSecurity` 아래 `@PreAuthorize`로 메서드 단위 인가를 분리한다. API Key는 회전이 어려워 외부용에 한정한다.

### 운영 구성 요소

Health Check는 `grpc.health.v1.Health/Check` 표준으로 제공하고 Kubernetes의 `grpc` probe로 확인한다. HTTP/2 연결이 오래 유지되므로 일반 ClusterIP Service로는 분산되지 않으며, Headless Service와 `dns:///` 주소의 클라이언트 사이드 round-robin 또는 Envoy를 쓴다. Deadline은 하위 호출로 자동 전파되어 체인 전체의 시간 상한이 된다.

## 코드

`@GrpcAdvice`로 도메인 예외를 Status와 표준 Error Details로 변환하는 전역 핸들러다.

```java
@GrpcAdvice
public class GrpcExceptionAdvice {

    private static final Logger log = LoggerFactory.getLogger(GrpcExceptionAdvice.class);

    @GrpcExceptionHandler(UserNotFoundException.class)
    public StatusException handleNotFound(UserNotFoundException e) {
        return Status.NOT_FOUND.withDescription(e.getMessage()).asException();
    }

    @GrpcExceptionHandler(ConstraintViolationException.class)
    public StatusRuntimeException handleValidation(ConstraintViolationException e) {
        BadRequest.Builder badRequest = BadRequest.newBuilder();
        for (ConstraintViolation<?> v : e.getConstraintViolations()) {
            badRequest.addFieldViolations(BadRequest.FieldViolation.newBuilder()
                .setField(v.getPropertyPath().toString())
                .setDescription(v.getMessage()));
        }
        com.google.rpc.Status rich = com.google.rpc.Status.newBuilder()
            .setCode(Status.Code.INVALID_ARGUMENT.value())
            .setMessage("Validation failed")
            .addDetails(Any.pack(badRequest.build()))
            .build();
        return StatusProto.toStatusRuntimeException(rich);
    }

    @GrpcExceptionHandler(Exception.class)
    public StatusException handleUnknown(Exception e) {
        log.error("unhandled grpc error", e);
        return Status.INTERNAL.withDescription("internal error").asException();
    }
}
```

JWT를 검증해 사용자 ID를 `Context`에 싣는 전역 인터셉터와 이를 읽는 서비스 메서드다.

```java
public final class AuthContext {
    public static final Context.Key<String> USER_ID = Context.key("user-id");
    static final Metadata.Key<String> AUTHORIZATION =
        Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
}

@Component
@GrpcGlobalServerInterceptor
@Order(1)
public class JwtServerInterceptor implements ServerInterceptor {

    private final JwtDecoder jwtDecoder;

    public JwtServerInterceptor(JwtDecoder jwtDecoder) {
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        String header = headers.get(AuthContext.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            call.close(Status.UNAUTHENTICATED.withDescription("missing token"), new Metadata());
            return new ServerCall.Listener<>() {};
        }
        try {
            Jwt jwt = jwtDecoder.decode(header.substring(7));
            Context ctx = Context.current().withValue(AuthContext.USER_ID, jwt.getSubject());
            return Contexts.interceptCall(ctx, call, headers, next);
        } catch (JwtException e) {
            call.close(Status.UNAUTHENTICATED.withDescription("invalid token"), new Metadata());
            return new ServerCall.Listener<>() {};
        }
    }
}

@GrpcService
public class ProfileService extends ProfileServiceGrpc.ProfileServiceImplBase {
    @Override
    public void getProfile(Empty request, StreamObserver<Profile> observer) {
        String userId = AuthContext.USER_ID.get();
        observer.onNext(profileRepository.findByUserId(userId));
        observer.onCompleted();
    }
}
```

mTLS, 재시도 정책, KeepAlive, 클라이언트 사이드 로드 밸런싱을 모은 grpc-spring-boot-starter 설정이다.

```yaml
grpc:
  server:
    port: 9090
    security:
      enabled: true
      certificate-chain: file:/etc/certs/server.crt
      private-key: file:/etc/certs/server.key
      trust-cert-collection: file:/etc/certs/ca.crt
      client-auth: REQUIRE
    enable-keep-alive: true
    keep-alive-time: 30s
    permit-keep-alive-time: 10s
    permit-keep-alive-without-calls: true
  client:
    user-service:
      address: dns:///user-service-headless.default.svc.cluster.local:9090
      negotiation-type: tls
      security:
        certificate-chain: file:/etc/certs/client.crt
        private-key: file:/etc/certs/client.key
        trust-cert-collection: file:/etc/certs/ca.crt
      enable-keep-alive: true
      keep-alive-time: 30s
      keep-alive-timeout: 5s
      default-load-balancing-policy: round_robin
      method-config:
        - name:
            - service: user.v1.UserService
          retryPolicy:
            maxAttempts: 3
            initialBackoff: 0.5s
            maxBackoff: 5s
            backoffMultiplier: 2
            retryableStatusCodes: [UNAVAILABLE]
```

## 실무에서 걸리는 지점

- **DEADLINE_EXCEEDED를 무조건 재시도하지 않는다.** 처리 도중 만료되면 재시도는 같은 작업을 두 번 수행한다. 멱등하지 않은 메서드는 UNAVAILABLE만 재시도한다.
- **MDC는 gRPC 스레드 모델과 맞지 않는다.** ThreadLocal이라 인터셉터에서 넣은 trace-id가 서비스 메서드의 executor 스레드로 전파되지 않는다. gRPC `Context`에 싣거나 OpenTelemetry `GrpcTelemetry` 인터셉터에 맡긴다.
- **KeepAlive 시간이 서버 허용치보다 짧으면 연결이 끊긴다.** 클라이언트 `keep-alive-time`이 서버 `permit-keep-alive-time`보다 짧으면 서버가 GOAWAY로 연결을 닫는다. 두 값을 함께 조정한다.
- **Reflection과 상세 에러는 정보 노출 경로다.** 운영에서 Reflection을 끄고, 원인 예외는 로그에만 남기며 INTERNAL의 Description은 일반 문구로 제한한다.

## 관련 글

- [gRPC — 개념·HTTP/2·Protobuf](/notes/reactive-spring/grpc-concepts-protobuf/)
- [gRPC — Unary·Server/Client/Bidirectional Streaming](/notes/reactive-spring/grpc-rpc-modes/)
- [RSocket — 보안·로드 밸런싱·테스트](/notes/reactive-spring/rsocket-security-lb-testing/)
