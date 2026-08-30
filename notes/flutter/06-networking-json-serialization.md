---
title: "네트워크·JSON 직렬화"
series: flutter
part: "데이터와 플랫폼"
order: 6
summary: "http 패키지로 요청을 보내고 dart:convert와 json_serializable로 JSON을 타입 안전한 모델로 바꾸는 방법을 정리한다."
tags: [Flutter, Dart, http, json_serializable, JSON]
sources: [https://docs.flutter.dev/data-and-backend/networking, https://docs.flutter.dev/data-and-backend/serialization/json, https://docs.flutter.dev/cookbook/networking/fetch-data]
updated: 2026-08-30
---

앱은 대부분 서버에서 받은 JSON을 화면에 그리는 일로 이루어진다. Dart에는 Java의 리플렉션 기반 라이브러리(Jackson 등)가 없다. Flutter는 트리 셰이킹으로 사용하지 않는 코드를 제거하는데, 런타임 리플렉션(`dart:mirrors`)은 이 최적화와 충돌하므로 앱 빌드에서 사용할 수 없다. ==그래서 JSON을 모델 객체로 바꾸는 코드를 직접 쓰거나 코드 생성으로 만들어야 한다.== 이를 건너뛰고 `Map<String, dynamic>`을 위젯까지 넘기면 키 오타와 타입 오류가 런타임에서야 드러난다.

## 핵심 개념

**HTTP 클라이언트.** 공식 문서는 `http` 패키지를 기본으로 안내한다. `http.get`, `http.post` 같은 최상위 함수는 `Future<Response>`를 반환하고, 반복 호출이 필요하면 `http.Client` 인스턴스를 만들어 연결을 재사용한 뒤 `close()`한다. 인터셉터·취소가 필요하면 `dio`가 쓰이지만 기본 개념은 같다. Spring의 `RestClient`/`WebClient`에 대응하며, `http.Client`를 생성자로 주입하는 패턴은 테스트에서 `MockClient`로 교체하기 위한 것이다.

**응답 처리.** `Response.statusCode`와 `Response.body`를 확인하고, 본문 문자열을 `dart:convert`의 `jsonDecode`로 파싱한다. 결과는 `Map<String, dynamic>` 또는 `List<dynamic>`이다. 200이 아닌 응답에서는 예외를 던져 호출 측이 실패를 명확히 알 수 있게 한다. Spring의 `HttpMessageConverter`가 하던 일을 손으로 하는 셈이다.

**직렬화 두 가지 방식.** 문서는 프로젝트 규모에 따라 두 접근을 구분한다.

| 방식 | 도구 | 적합한 상황 |
|---|---|---|
| 수동 직렬화 | `dart:convert` + `fromJson`/`toJson` 직접 작성 | 소규모, 모델 수가 적을 때 |
| 코드 생성 | `json_serializable` + `build_runner` | 모델이 많고 필드 변경이 잦을 때 |

수동 방식은 모델 클래스 안에 `factory User.fromJson(Map<String, dynamic> json)`과 `Map<String, dynamic> toJson()`을 쓴다. 코드 생성 방식은 클래스에 `@JsonSerializable()`을 붙이고 `part 'user.g.dart';`를 선언한 뒤 `dart run build_runner build`로 `_$UserFromJson`, `_$UserToJson` 함수를 생성한다. Java로 치면 Jackson의 런타임 리플렉션 대신 Lombok·MapStruct처럼 컴파일 타임에 코드를 만들어 두는 셈이다. `@JsonKey(name: 'registration_date_millis')`로 키 이름을 바꾸고, `explicitToJson: true`로 중첩 객체까지 재귀 직렬화한다.

**UI와의 연결.** 네트워크 호출은 `Future`를 반환하므로 `initState`에서 한 번 실행해 필드에 담고, `FutureBuilder`로 로딩·오류·데이터 상태를 분기한다. ==`build` 메서드 안에서 직접 호출하면 리빌드마다 요청이 나가므로 피한다.==

## 코드

`http.Client`를 주입받아 사용자 목록을 가져오고 상태 코드에 따라 실패를 던지는 함수다.

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<User>> fetchUsers(http.Client client) async {
  final response = await client.get(
    Uri.parse('https://api.example.com/users'),
    headers: {'Accept': 'application/json'},
  );
  if (response.statusCode != 200) {
    throw HttpException('사용자 목록 조회 실패: ${response.statusCode}');
  }
  final data = jsonDecode(response.body) as List<dynamic>;
  return data
      .map((e) => User.fromJson(e as Map<String, dynamic>))
      .toList();
}
```

`json_serializable`로 모델을 정의한 예다. 생성 파일은 `build_runner`가 만든다.

```dart
import 'package:json_annotation/json_annotation.dart';

part 'user.g.dart';

@JsonSerializable(explicitToJson: true)
class User {
  final int id;
  final String name;
  @JsonKey(name: 'registration_date_millis')
  final int registrationDateMillis;
  final Address? address;

  const User({
    required this.id,
    required this.name,
    required this.registrationDateMillis,
    this.address,
  });

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
  Map<String, dynamic> toJson() => _$UserToJson(this);
}

@JsonSerializable()
class Address {
  final String city;
  const Address({required this.city});
  factory Address.fromJson(Map<String, dynamic> json) =>
      _$AddressFromJson(json);
  Map<String, dynamic> toJson() => _$AddressToJson(this);
}
```

`FutureBuilder`로 요청 결과를 화면에 반영하는 위젯이다. `Future`는 `initState`에서 한 번만 만든다.

```dart
class UserListPage extends StatefulWidget {
  const UserListPage({super.key, required this.client});
  final http.Client client;

  @override
  State<UserListPage> createState() => _UserListPageState();
}

class _UserListPageState extends State<UserListPage> {
  late final Future<List<User>> _users;

  @override
  void initState() {
    super.initState();
    _users = fetchUsers(widget.client);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<User>>(
      future: _users,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return Text('오류: ${snapshot.error}');
        }
        if (!snapshot.hasData) {
          return const CircularProgressIndicator();
        }
        return ListView(
          children: [
            for (final u in snapshot.data!) ListTile(title: Text(u.name)),
          ],
        );
      },
    );
  }
}
```

## 실무에서 걸리는 지점

- ==**큰 JSON 파싱과 UI 프리즈.** `jsonDecode`는 동기 작업이라 수 MB짜리 응답을 메인 isolate에서 파싱하면 프레임이 끊긴다.== `compute()` 또는 `Isolate.run()`으로 파싱을 별도 isolate에 넘기고, 전달 대상은 문자열이나 순수 데이터로 제한한다.
- **플랫폼별 네트워크 허용 설정.** Android는 `AndroidManifest.xml`의 `INTERNET` 권한이 필요하고, macOS는 entitlements에 네트워크 클라이언트 권한을 추가해야 한다. 웹 빌드는 브라우저의 CORS 제약을 그대로 받아 서버 헤더가 없으면 요청이 실패한다.
- **null과 타입 불일치.** 서버 필드가 누락되면 non-nullable 필드의 `fromJson`에서 `TypeError`가 난다. 스펙상 선택 필드는 `?`로 선언하고, 숫자가 `int`와 `double`로 섞여 오는 API는 `num`으로 받거나 `@JsonKey(fromJson: ...)` 변환기를 둔다.
- **생성 파일 관리.** `build_runner build`는 프로젝트 전체를 스캔해 느리므로 개발 중에는 `watch`를 쓴다. `.g.dart`를 커밋할지 CI에서 생성할지 팀 규칙을 정하지 않으면 PR마다 충돌이 생긴다.
- **클라이언트 수명과 타임아웃.** 요청마다 `http.get`을 호출하면 연결이 재사용되지 않는다. 앱 수준에서 `Client` 하나를 유지하고, `http`에는 타임아웃이 없으므로 `Future.timeout`을 붙인다.

## 관련 글

- [Dart 핵심 — null safety·async·컬렉션](/notes/flutter/dart-essentials/)
- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
- [로컬 저장 — SharedPreferences·SQLite·파일](/notes/flutter/local-storage-sqlite/)
