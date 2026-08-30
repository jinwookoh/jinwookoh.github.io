---
title: "gRPC — 개념·HTTP/2·Protobuf"
series: reactive-spring
part: "gRPC"
order: 19
summary: "gRPC는 Protobuf 스키마와 HTTP/2 전송을 결합한 RPC이며, 필드 번호가 와이어 호환성을 결정한다."
tags: [gRPC, Protobuf, HTTP/2, Spring Boot, RPC]
sources: [2026-05-03-grpc-basics.md, 2026-05-03-grpc-protobuf.md]
updated: 2026-08-29
---

마이크로서비스 사이를 HTTP/1.1과 JSON으로 연결하면 요청마다 텍스트 헤더가 반복되고, 응답이 순서대로 처리되어 head-of-line blocking이 생기며, 스키마가 없어 서비스 간 계약이 문서에만 의존한다. 서버 푸시나 양방향 통신도 표현할 수 없다. ==gRPC는 전송(HTTP/2)과 스키마·직렬화(Protocol Buffers)를 묶어 이 문제를 해결한다.==

## 핵심 개념

gRPC는 Google 내부 RPC(Stubby)를 2015년 오픈소스화한 CNCF 프로젝트다. Protobuf가 스키마를 정의하고 바이너리로 직렬화하며, HTTP/2가 그 바이트를 나르고, gRPC가 둘을 결합해 언어별 스텁을 생성한다. Kubernetes·Envoy·Istio가 기본 지원하므로 외부 API는 REST, 내부 통신은 gRPC로 두는 구성이 일반적이다.

HTTP/2는 한 TCP 연결 위에 여러 스트림을 다중화하고, HPACK으로 헤더를 압축하며, 바이너리 프레임을 쓰고, 스트림 단위 양방향 전송을 지원한다. gRPC는 RPC 호출 하나를 HTTP/2 스트림 하나에 대응시켜 연결 하나로 수많은 호출을 병렬 처리한다.

RPC 모드는 요청·응답이 단일 메시지인지 스트림인지에 따라 Unary(1:1), Server Streaming(1:N), Client Streaming(N:1), Bidirectional Streaming(N:N)으로 나뉘며, `rpc` 선언의 `stream` 키워드 위치가 결정한다. RSocket의 Interaction Model과 거의 대응하지만, gRPC는 Protobuf를 전제로 하고 백프레셔는 HTTP/2 흐름 제어에 의존한다.

Protobuf 와이어 형식에는 필드 이름이 없다. 필드 번호와 와이어 타입을 합친 태그, 길이, 값만 직렬화되므로 번호가 와이어 식별자이고 이름은 코드 생성용이다. ==이름 변경은 호환되지만 번호를 바꾸면 기존 데이터가 다른 필드로 해석된다.== 1~15는 태그가 1바이트라 자주 쓰는 필드에 배정하고, 19000~19999는 내부 예약 범위다.

`int32`/`int64`는 varint라 작은 양수에 유리하지만 음수는 10바이트를 차지하므로, 음수가 잦으면 zigzag 인코딩의 `sint32`/`sint64`, 항상 큰 값이면 `fixed32`/`fixed64`를 쓴다. proto3 스칼라 기본값은 null이 아니라 `""`, 0, false이며, 미설정과 구분하려면 `optional`이나 Wrapper 타입을 쓴다. proto2의 `required`는 제거되었다.

복합 구조로는 `repeated`, `map<K, V>`(키는 정수·string·bool만), 중첩 메시지, `enum`(첫 값은 반드시 0), `oneof`(하나만 설정, 다른 필드 설정 시 기존 값 해제)가 있고, Well-Known Types로 `Timestamp`·`Duration`·`Empty`·`Any`가 제공된다.

스키마 진화 규칙은 번호 중심이다. 새 필드 추가는 안전하다. 구버전은 모르는 필드를 무시하고 신버전은 없는 필드를 기본값으로 읽는다. 필드 삭제 시 번호와 이름을 `reserved`로 남기면 재사용이 컴파일 단계에서 차단된다. 번호 변경, `repeated`와 단일 필드 간 변경은 파괴적이다. `int32`↔`int64`↔`uint32`↔`bool`, UTF-8 유효 데이터에 한한 `string`↔`bytes`는 와이어 호환된다.

## 코드

서비스와 메시지를 정의하는 `.proto` 파일이다. `java_multiple_files` 옵션으로 메시지마다 별도 Java 클래스가 생성된다.

```protobuf
syntax = "proto3";

package com.example.user;
option java_package = "com.example.user.proto";
option java_multiple_files = true;

import "google/protobuf/timestamp.proto";

service UserService {
  rpc GetUser (UserRequest) returns (User);
  rpc ListUsers (ListRequest) returns (stream User);
  rpc CreateUsers (stream User) returns (CreateResult);
  rpc Chat (stream Message) returns (stream Message);
}

message UserRequest { string id = 1; }
message ListRequest { int32 page_size = 1; }

message User {
  reserved 5;
  reserved "nickname";

  string id = 1;
  string name = 2;
  int32 age = 3;
  Status status = 4;
  repeated string emails = 6;
  map<string, string> attributes = 7;
  google.protobuf.Timestamp created_at = 8;
  optional string phone = 9;

  enum Status {
    STATUS_UNSPECIFIED = 0;
    ACTIVE = 1;
    INACTIVE = 2;
  }
}

message CreateResult {
  oneof outcome {
    int32 created_count = 1;
    string error_message = 2;
  }
}

message Message { string text = 1; }
```

Gradle 빌드 설정이다. Spring Boot 3.x와 Jakarta 네임스페이스를 지원하는 3.x 계열 스타터를 사용한다.

```groovy
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.3.2'
    id 'com.google.protobuf' version '0.9.4'
}

dependencies {
    implementation 'net.devh:grpc-spring-boot-starter:3.1.0.RELEASE'
    implementation 'io.grpc:grpc-protobuf:1.65.1'
    implementation 'io.grpc:grpc-stub:1.65.1'
    compileOnly 'org.apache.tomcat:annotations-api:6.0.53'
}

protobuf {
    protoc { artifact = 'com.google.protobuf:protoc:3.25.3' }
    plugins {
        grpc { artifact = 'io.grpc:protoc-gen-grpc-java:1.65.1' }
    }
    generateProtoTasks {
        all()*.plugins { grpc {} }
    }
}
```

생성된 `UserServiceImplBase`를 상속한 Unary 서버와 스텁을 주입받는 클라이언트다. 메시지는 불변이라 `toBuilder()`로 복사해 수정한다.

```java
import com.example.user.proto.User;
import com.example.user.proto.UserRequest;
import com.example.user.proto.UserServiceGrpc;
import com.google.protobuf.util.JsonFormat;
import com.google.protobuf.util.Timestamps;
import io.grpc.stub.StreamObserver;
import net.devh.boot.grpc.client.inject.GrpcClient;
import net.devh.boot.grpc.server.service.GrpcService;
import org.springframework.stereotype.Service;

@GrpcService
public class UserServiceImpl extends UserServiceGrpc.UserServiceImplBase {

    @Override
    public void getUser(UserRequest request, StreamObserver<User> responseObserver) {
        User user = User.newBuilder()
            .setId(request.getId())
            .setName("Alice")
            .setAge(30)
            .setStatus(User.Status.ACTIVE)
            .addEmails("alice@example.com")
            .putAttributes("role", "admin")
            .setCreatedAt(Timestamps.now())
            .build();

        responseObserver.onNext(user);
        responseObserver.onCompleted();
    }
}

@Service
class UserClient {

    @GrpcClient("user-service")
    private UserServiceGrpc.UserServiceBlockingStub blockingStub;

    User getUser(String id) {
        User user = blockingStub.getUser(UserRequest.newBuilder().setId(id).build());
        return user.toBuilder().setAge(user.getAge() + 1).build();
    }

    String toJson(User user) throws Exception {
        return JsonFormat.printer().print(user);
    }

    User fromBytes(byte[] bytes) throws Exception {
        return User.parseFrom(bytes);
    }
}
```

클라이언트 이름 `user-service`는 설정 파일의 채널 정의와 연결된다.

```yaml
grpc:
  server:
    port: 9090
  client:
    user-service:
      address: static://localhost:9090
      negotiation-type: plaintext
```

## 실무에서 걸리는 지점

- **스텁 종류와 모드 불일치.** `BlockingStub`은 Unary와 Server Streaming만, `FutureStub`은 Unary만 지원하며 Client·Bidirectional Streaming은 비동기 `Stub`으로만 호출한다. ==WebFlux 이벤트 루프에서 `BlockingStub`을 호출하면 루프가 막히므로 비동기 스텁을 쓴다.==
- **필드 번호 재사용.** `reserved` 없이 필드를 지우면 같은 번호가 다른 타입에 배정될 수 있다. 구버전 데이터가 새 필드로 잘못 해석되지만 컴파일 경고는 없다.
- **기본값과 미설정의 구분.** `int32 age = 0`은 0인지 값 없음인지 구분되지 않아, 부분 업데이트 API에서 0으로 덮어쓰는 버그가 생긴다. `optional`이나 Wrapper 타입을 쓰고 `hasXxx()`로 검사한다.
- **단일 장수 연결의 쏠림.** L4 로드 밸런서 뒤에서는 HTTP/2 연결 하나가 특정 인스턴스에 고정된다. 클라이언트 측 로드 밸런싱이나 L7 프록시를 두고 `max-connection-age`로 연결을 주기적으로 재수립한다.
- **디버깅 가시성.** 바이너리 페이로드라 캡처만으로는 읽을 수 없다. 개발 환경에서 Reflection을 켜 grpcurl로 호출하고 로그에는 `JsonFormat` 변환 결과를 남기되, 운영 환경에서는 스키마 노출을 막기 위해 Reflection을 끈다.

## 관련 글

- [RSocket — 개념·프레임·Interaction Model](/notes/reactive-spring/rsocket-concepts/)
- [gRPC — Unary·Server/Client/Bidirectional Streaming](/notes/reactive-spring/grpc-rpc-modes/)
- [gRPC — 에러·인터셉터·보안·운영](/notes/reactive-spring/grpc-errors-interceptors-security/)
