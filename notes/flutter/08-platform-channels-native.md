---
title: "플랫폼 채널과 네이티브 연동·권한"
series: flutter
part: "데이터와 플랫폼"
order: 8
summary: "Dart 코드가 못 건드리는 OS 기능은 MethodChannel·EventChannel·플러그인으로 네이티브에 위임하고, 권한은 플랫폼 쪽에서 처리한다"
tags: [Flutter, Platform Channel, MethodChannel, Plugin, Pigeon]
sources: [https://docs.flutter.dev/platform-integration/platform-channels, https://docs.flutter.dev/packages-and-plugins/developing-packages, https://docs.flutter.dev/platform-integration/android/platform-views]
updated: 2026-08-30
---

Flutter는 자체 렌더링 엔진으로 화면을 그리기 때문에 UI 층에서는 OS에 의존하지 않는다. 그 대가로 배터리 잔량, 블루투스, 생체 인증, 카메라 권한 같은 OS 기능에는 Dart 표준 라이브러리만으로 접근할 수 없다. 이 경계를 넘는 통로가 플랫폼 채널이다. 채널이 없으면 플러그인이 지원하지 않는 API는 포기해야 한다.

## 핵심 개념

플랫폼 채널은 이름이 붙은 비동기 메시지 파이프다. Dart 쪽이 클라이언트, 네이티브 쪽(Kotlin/Java, Swift/Objective-C, C++)이 호스트 역할을 하며 메시지는 바이너리로 직렬화되어 오간다. Spring 기준으로 보면 프로세스 안에서 동작하는 RPC 스텁에 해당하고, 메서드 이름 문자열이 URL, 코덱이 HttpMessageConverter에 해당한다.

채널은 용도에 따라 세 종류로 나뉜다.

| 채널 | 방향 | 용도 |
|---|---|---|
| MethodChannel | 요청·응답 | 네이티브 함수 호출, 가장 흔한 형태 |
| EventChannel | 네이티브 → Dart 스트림 | 센서·위치·연결 상태처럼 계속 흘러오는 이벤트 |
| BasicMessageChannel | 양방향 메시지 | 코덱을 직접 지정하는 저수준 통신 |

기본 코덱 `StandardMessageCodec`은 null·bool·int·double·String·List·Map·바이트 배열을 자동 변환한다. 이 범위를 벗어나는 객체는 직접 Map으로 풀어 보내야 한다.

스레드 규칙이 중요하다. 채널 핸들러는 기본적으로 플랫폼 메인 스레드(Android UI 스레드, iOS 메인 스레드)에서 실행된다. 무거운 작업을 핸들러 안에서 그대로 돌리면 네이티브 UI가 멈추므로, `makeBackgroundTaskQueue()`로 생성한 TaskQueue를 채널에 넘겨 백그라운드에서 처리하거나 핸들러 안에서 별도 스레드로 넘기고 결과만 메인 스레드로 되돌린다. Dart 쪽도 마찬가지로 루트 isolate 외의 isolate에서는 `BackgroundIsolateBinaryMessenger.ensureInitialized`를 먼저 호출해야 채널을 쓸 수 있다.

메서드 이름을 문자열로 맞추는 방식은 타입 검사를 받지 못한다. Pigeon은 Dart로 인터페이스를 선언하면 양쪽 코드를 생성해 주는 도구로, 문자열 오타와 타입 불일치를 컴파일 단계에서 잡는다.

앱 코드에 직접 채널을 박는 대신 플러그인 패키지로 분리하면 여러 앱에서 재사용할 수 있다. 플러그인은 pubspec의 `flutter.plugin.platforms`에 플랫폼별 `pluginClass`를 선언하고, 규모가 커지면 앱 대면 패키지·플랫폼 인터페이스·플랫폼별 구현 패키지로 나누는 연합(federated) 구조를 택한다. 플랫폼 인터페이스와 구현의 관계는 Spring의 서비스 인터페이스와 프로파일별 빈에 대응한다. 순수 C 라이브러리를 부를 때는 채널 대신 `dart:ffi` 기반 FFI 패키지가 권장된다.

권한은 채널이 다루는 대표 사례다. Flutter 프레임워크에는 권한 API가 없으며, AndroidManifest와 Info.plist에 사용 목적을 선언한 뒤 네이티브에서 런타임 요청을 수행하고 결과를 채널로 돌려주는 구조다.

## 코드

Dart 쪽에서 채널을 열고 네이티브 메서드를 호출한다. 실패는 `PlatformException`으로 도착한다.

```dart
import 'package:flutter/services.dart';

class BatteryService {
  static const _channel = MethodChannel('samples.flutter.dev/battery');

  Future<int?> level() async {
    try {
      return await _channel.invokeMethod<int>('getBatteryLevel');
    } on PlatformException catch (e) {
      // e.code == 'UNAVAILABLE' 등 네이티브가 지정한 코드
      return null;
    } on MissingPluginException {
      // 해당 플랫폼에 핸들러가 등록되지 않은 경우
      return null;
    }
  }
}
```

Android 쪽 핸들러는 `configureFlutterEngine`에서 같은 이름의 채널에 등록한다. 모르는 메서드는 `notImplemented()`로 응답한다.

```kotlin
class MainActivity : FlutterActivity() {
  private val channelName = "samples.flutter.dev/battery"

  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
      .setMethodCallHandler { call, result ->
        when (call.method) {
          "getBatteryLevel" -> {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            if (level >= 0) result.success(level)
            else result.error("UNAVAILABLE", "Battery level not available.", null)
          }
          else -> result.notImplemented()
        }
      }
  }
}
```

네이티브 이벤트를 스트림으로 받을 때는 EventChannel을 쓴다. Dart는 `receiveBroadcastStream()`으로 구독하고, 네이티브는 `StreamHandler`의 `onListen`/`onCancel`에서 리스너를 붙였다 뗀다.

```dart
class ConnectivityWatcher {
  static const _events = EventChannel('samples.flutter.dev/connectivity');

  Stream<bool> get online =>
      _events.receiveBroadcastStream().map((e) => e as bool);
}
```

## 실무에서 걸리는 지점

- 핸들러를 메인 스레드에서 동기로 오래 돌리면 네이티브 UI가 끊긴다. 파일 I/O나 네트워크는 TaskQueue나 코루틴으로 빼고, `result`는 정확히 한 번만 호출한다. ==빠뜨리면 Dart 쪽 Future가 영원히 대기한다.==
- 채널 이름과 메서드 이름은 문자열이라 오타가 런타임에야 드러난다. 플랫폼 하나에 핸들러 등록을 빠뜨리면 `MissingPluginException`이 발생한다. 채널이 서너 개를 넘어가면 Pigeon으로 넘기는 편이 유지보수 비용이 낮다.
- 숫자 타입이 플랫폼마다 다르게 도착한다. ==Dart의 int가 값 크기에 따라 `Int`와 `Long`으로 갈리므로 Kotlin에서 `as Int` 캐스팅이 간헐적으로 실패한다.== `Number`로 받아 변환하는 편이 안전하다.
- Android 플랫폼 뷰는 렌더링 방식 선택이 성능을 좌우한다. ==하이브리드 컴포지션은 접근성과 표시 정확도가 완전하지만 래스터 스레드가 플랫폼 스레드와 합쳐져 프레임이 떨어지고, 텍스처 레이어 방식(`AndroidView`)은 Flutter 성능은 유지되나 빠른 스크롤에서 끊기고 SurfaceView 접근성이 깨진다.==
- 권한은 거부 이후 흐름까지 설계해야 한다. Android 13 이상의 알림 권한, iOS의 "다시 묻지 않음" 상태처럼 OS 버전별 분기가 많고, 설정 화면으로 보내는 경로도 채널을 통해야 한다.

## 관련 글

- [네트워크·JSON 직렬화](/notes/flutter/networking-json-serialization/)
- [로컬 저장 — SharedPreferences·SQLite·파일](/notes/flutter/local-storage-sqlite/)
- [빌드·배포·성능 프로파일링](/notes/flutter/build-deploy-performance/)
