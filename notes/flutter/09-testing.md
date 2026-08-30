---
title: "테스트 — 단위·위젯·통합"
series: flutter
part: "운영"
order: 9
summary: "단위·위젯·통합 세 층위를 어떤 기준으로 나누고, 각 층에서 무엇을 어떻게 검증하는지 정리한다."
tags: [Flutter, flutter_test, WidgetTester, integration_test, Dart]
sources: [https://docs.flutter.dev/testing/overview, https://docs.flutter.dev/cookbook/testing/unit/introduction, https://docs.flutter.dev/cookbook/testing/widget/introduction, https://docs.flutter.dev/testing/integration-tests]
updated: 2026-08-30
---

Flutter 앱은 화면 하나에 비즈니스 로직, 위젯 트리, 플랫폼 연동이 함께 얽힌다. 자동화된 테스트가 없으면 기능을 하나 고칠 때마다 시뮬레이터를 띄워 손으로 화면을 눌러 보는 수밖에 없고, 화면 수가 늘어날수록 회귀 확인 비용이 선형으로 증가한다. 특히 상태 관리 코드나 JSON 파싱처럼 UI와 무관한 로직까지 화면을 통해서만 검증하게 되면 실패 원인을 좁히는 데 시간이 오래 걸린다. ==Flutter는 단위·위젯·통합 세 층위의 테스트를 제공하며, 각 층위가 검증하는 범위와 실행 비용이 다르다.==

## 핵심 개념

Flutter 테스트는 검증 범위에 따라 세 종류로 나뉜다.

| 종류 | 검증 대상 | 실행 환경 | 속도 |
|---|---|---|---|
| 단위 테스트 | 함수·클래스·메서드 | Dart VM | 빠름 |
| 위젯 테스트 | 위젯 한 개 또는 작은 트리 | 헤드리스 렌더링 환경 | 중간 |
| 통합 테스트 | 앱 전체 또는 큰 흐름 | 실제 기기·에뮬레이터 | 느림 |

**단위 테스트**는 `package:test`(Flutter에서는 `flutter_test`가 이를 재노출한다) 기반으로 순수 Dart 코드를 검증한다. 외부 의존성은 mock으로 대체하며, `mockito`나 `mocktail` 같은 패키지를 쓴다. Spring의 JUnit + Mockito 단위 테스트와 대응된다.

**위젯 테스트**는 `flutter_test`의 `testWidgets`와 `WidgetTester`를 사용한다. 실제 기기 없이 테스트 전용 바인딩(`TestWidgetsFlutterBinding`) 위에서 위젯을 빌드하고, `Finder`로 트리에서 요소를 찾은 뒤 `Matcher`로 검증한다. `tester.pump()`는 프레임 하나를 진행시키고, `pumpAndSettle()`은 애니메이션이 끝날 때까지 프레임을 반복한다. ==테스트 안에서는 시간이 자동으로 흐르지 않으므로 프레임을 직접 밀어야 한다는 점이 핵심이다.== Spring MVC의 `MockMvc`로 컨트롤러 계층만 슬라이스 테스트하는 방식과 비슷한 위치에 있다.

**통합 테스트**는 `integration_test` 패키지를 사용한다. 테스트 코드는 위젯 테스트와 같은 `testWidgets` API를 쓰지만, `IntegrationTestWidgetsFlutterBinding.ensureInitialized()`로 바인딩을 바꾸면 실제 기기에서 앱 전체를 구동하며 검증한다. 프로젝트 루트의 `integration_test/` 디렉터리에 두고 `flutter test integration_test`로 실행한다. 웹은 `chromedriver`를 띄우고 `flutter drive`로 돌린다. Spring의 `@SpringBootTest` + Testcontainers 수준의 E2E에 해당한다.

세 층위 모두 `flutter test` 명령으로 실행되며, `test/` 디렉터리 아래 `_test.dart`로 끝나는 파일이 대상이다. `--coverage` 옵션으로 lcov 커버리지를 얻을 수 있다.

## 코드

단위 테스트. `Counter` 클래스의 증감 로직만 검증하며, 위젯이나 바인딩에 의존하지 않는다.

```dart
// test/counter_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/counter.dart';

void main() {
  group('Counter', () {
    test('초기값은 0이다', () {
      expect(Counter().value, 0);
    });

    test('increment 후 값이 1 증가한다', () {
      final counter = Counter()..increment();
      expect(counter.value, 1);
    });

    test('decrement는 0 아래로 내려가지 않는다', () {
      final counter = Counter()..decrement();
      expect(counter.value, 0);
    });
  });
}
```

위젯 테스트. `MyWidget`이 title과 message를 렌더링하는지 확인한다. `MaterialApp`으로 감싸야 `Directionality`와 테마가 주입된다.

```dart
// test/my_widget_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/my_widget.dart';

void main() {
  testWidgets('title과 message를 표시한다', (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: MyWidget(title: 'T', message: 'M')),
    );

    expect(find.text('T'), findsOneWidget);
    expect(find.text('M'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
  });

  testWidgets('버튼을 누르면 카운트가 증가한다', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CounterPage()));

    expect(find.text('0'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump();
    expect(find.text('1'), findsOneWidget);
  });
}
```

통합 테스트. 바인딩 초기화 한 줄이 다르고, 나머지는 위젯 테스트와 같은 API를 쓴다.

```dart
// integration_test/app_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:my_app/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('앱 실행 후 카운터를 두 번 올린다', (tester) async {
    app.main();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('increment')));
    await tester.tap(find.byKey(const Key('increment')));
    await tester.pumpAndSettle();

    expect(find.text('2'), findsOneWidget);
  });
}
```

```
flutter test                          # 단위·위젯
flutter test integration_test         # 연결된 기기에서 통합 테스트
```

## 실무에서 걸리는 지점

- **`pump`와 `pumpAndSettle` 혼동.** `pumpAndSettle`은 프레임이 안정될 때까지 기다리므로 무한 반복 애니메이션(`CircularProgressIndicator` 등)이 있으면 타임아웃으로 실패한다. 이 경우 `pump(Duration)`으로 시간을 명시적으로 진행시켜야 한다.
- ==**실제 비동기 대기 불가.** 위젯 테스트는 `FakeAsync` 위에서 돌기 때문에 `Future.delayed`나 실제 네트워크 호출은 완료되지 않는다.== HTTP 클라이언트나 저장소는 반드시 mock으로 주입하고, 지연이 필요하면 `tester.pump(Duration)`으로 가짜 시간을 밀어야 한다.
- **플랫폼 채널 호출.** `SharedPreferences`, `path_provider` 같은 플러그인은 테스트 환경에 네이티브 구현이 없다. `SharedPreferences.setMockInitialValues()`처럼 플러그인이 제공하는 mock을 쓰거나, `TestDefaultBinaryMessenger`로 메서드 채널 핸들러를 직접 등록해야 한다.
- **Finder가 여러 개를 찾는 문제.** `find.text('0')`이 리스트 안 여러 항목에 매칭되면 `tap`이 실패한다. 테스트 대상 위젯에 `Key`를 붙이고 `find.byKey`로 좁히는 편이 안정적이다. 접근성 라벨 기준의 `find.bySemanticsLabel`도 대안이다.
- **통합 테스트 CI 비용.** 통합 테스트는 에뮬레이터 부팅이 필요해 수십 초에서 수 분이 걸린다. 핵심 사용자 흐름 몇 개로 범위를 제한하고, 나머지는 위젯 테스트로 내려 보내는 편이 유지 비용을 낮춘다. 골든 테스트(`matchesGoldenFile`)는 OS·폰트 렌더링 차이로 CI와 로컬 결과가 달라질 수 있으므로 실행 환경을 고정해야 한다.

## 관련 글

- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
- [플랫폼 채널과 네이티브 연동·권한](/notes/flutter/platform-channels-native/)
- [빌드·배포·성능 프로파일링](/notes/flutter/build-deploy-performance/)
