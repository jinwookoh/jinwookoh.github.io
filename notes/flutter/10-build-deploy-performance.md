---
title: "빌드·배포·성능 프로파일링"
series: flutter
part: "운영"
order: 10
summary: "릴리스 빌드 서명·스토어 업로드 절차와 DevTools로 프레임 지연 원인을 찾는 방법을 정리한다"
tags: [Flutter, App Bundle, Xcode, DevTools, Impeller]
sources: [https://docs.flutter.dev/deployment/android, https://docs.flutter.dev/deployment/ios, https://docs.flutter.dev/perf/best-practices, https://docs.flutter.dev/tools/devtools/performance]
updated: 2026-08-30
---

`flutter run`으로 확인한 앱은 디버그 모드로 동작한다. ==JIT 컴파일과 assert, 핫 리로드용 서비스가 붙어 있어 실제보다 느리고, 이 상태로 성능을 판단하면 존재하지 않는 병목을 쫓게 된다.== 반대로 릴리스 빌드는 서명 키, 번들 ID, 스토어별 패키징 규칙이 얽혀 있어 절차를 정리해 두지 않으면 배포 직전에 막힌다. 빌드 모드의 차이, 플랫폼별 서명·업로드 절차, 프로파일 모드에서의 측정 방법을 정리한다.

## 핵심 개념

### 세 가지 빌드 모드

| 모드 | 컴파일 | 용도 |
|---|---|---|
| debug | JIT, assert 활성 | 개발·핫 리로드 |
| profile | AOT, 서비스 확장 유지 | 성능 측정 |
| release | AOT, 디버그 정보 제거 | 스토어 배포 |

==성능 측정은 profile 모드로 실제 기기에서 한다.== 에뮬레이터는 GPU·CPU 특성이 달라 프레임 시간이 의미가 없다. Spring으로 치면 debug는 devtools와 원격 디버거를 붙인 로컬 실행, release는 프로덕션 JAR에 해당한다.

### Android 배포

Play 스토어는 APK가 아니라 App Bundle(`.aab`)을 요구한다. Play가 기기별 ABI·해상도에 맞는 APK를 생성해 배포한다. 서명은 업로드 키로 하고, 최종 배포 서명은 Play App Signing이 관리한다. 업로드 키는 `keytool`로 만든 keystore에 두고, 비밀번호와 경로는 `android/key.properties`에 적어 `build.gradle.kts`의 `signingConfigs`에서 읽는다. 릴리스 빌드는 기본으로 R8 축소가 적용되며, Dart 코드 난독화는 `--obfuscate` 플래그로 켠다.

### iOS 배포

iOS는 App ID(번들 ID), 배포용 인증서, 프로비저닝 프로파일이 필요하며 Xcode에서 Runner 타깃의 팀을 지정하면 자동 서명이 관리한다. 빌드는 `flutter build ipa`가 아카이브(`.xcarchive`)와 `.ipa`를 함께 생성하고, 생성된 `.ipa`는 Transporter 앱이나 `xcrun altool`로 App Store Connect에 올린다. 버전은 `pubspec.yaml`의 `version: 1.2.0+7`에서 앞부분이 `CFBundleShortVersionString`·`versionName`, `+` 뒤가 빌드 번호(`CFBundleVersion`·`versionCode`)로 매핑된다.

### 성능 모델

Flutter는 프레임마다 UI 스레드에서 Dart 코드(build·layout·paint 기록)를 실행하고, 래스터 스레드에서 그 결과를 GPU 명령으로 변환한다. ==둘 중 하나라도 프레임 예산(60Hz 기준 약 16ms)을 넘기면 프레임이 밀리므로 병목이 어느 스레드인지 먼저 구분한다.== UI 스레드 지연은 과도한 `build`, 무거운 동기 연산, 큰 위젯 서브트리 재구성이 원인이고, 래스터 스레드 지연은 `saveLayer`를 유발하는 `Opacity`·클리핑·그림자, 과도한 오프스크린 렌더링이 원인이다. 현재 기본 렌더러 Impeller는 셰이더를 미리 컴파일하므로 Skia 시절의 첫 애니메이션 셰이더 지연은 대부분 사라졌다.

### DevTools Performance

DevTools의 Performance 뷰는 프레임 차트, 타임라인 이벤트, CPU 프로파일러로 구성된다. 프레임 차트는 프레임마다 UI·래스터 시간을 막대로 보여 주고, 예산을 넘긴 프레임은 빨간색으로 표시된다. 막대를 선택하면 해당 프레임의 타임라인이 열리고, 위젯 단위까지 보려면 Enhance Tracing에서 build·layout·paint 추적을 켠다. CPU 프로파일러 탭은 Java 진영의 async-profiler·JFR 플레임 그래프에 해당한다.

## 코드

Android 업로드 키를 `key.properties`에서 읽어 릴리스 서명에 연결한다.

```kotlin
// android/app/build.gradle.kts
import java.util.Properties
import java.io.FileInputStream

val keystoreProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) load(FileInputStream(f))
}

android {
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
            storeFile = keystoreProperties["storeFile"]?.let { file(it) }
            storePassword = keystoreProperties["storePassword"] as String
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

플랫폼별 릴리스 빌드와 프로파일 실행 명령. 난독화 시 `--split-debug-info`로 심볼 파일을 보관해야 크래시 스택을 복원할 수 있다.

```bash
# Android: Play 업로드용 번들, Dart 심볼 분리
flutter build appbundle --obfuscate --split-debug-info=build/symbols

# iOS: 아카이브 + ipa 생성 (App Store Connect 업로드용)
flutter build ipa --export-method app-store

# 성능 측정: 실기기에서 profile 모드로 실행 후 DevTools 연결
flutter run --profile
```

리스트 항목에서 흔히 잡히는 UI·래스터 병목 두 가지를 제거한 예. `Opacity` 대신 `FadeTransition`으로 `saveLayer`를 피하고, 애니메이션에 무관한 서브트리는 `child`로 분리해 재구성 범위를 줄인다.

```dart
class FadingCard extends StatefulWidget {
  const FadingCard({super.key, required this.child});
  final Widget child;

  @override
  State<FadingCard> createState() => _FadingCardState();
}

class _FadingCardState extends State<FadingCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
  )..forward();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _controller,
      child: RepaintBoundary(
        // widget.child 는 애니메이션 프레임마다 다시 build 되지 않는다
        child: widget.child,
      ),
    );
  }
}
```

## 실무에서 걸리는 지점

- ==**업로드 키 분실**: Play App Signing을 사용하면 업로드 키는 재설정을 요청할 수 있지만, 사용하지 않은 채 배포 키를 잃으면 같은 패키지 이름으로 업데이트할 방법이 없다.== keystore와 `key.properties`는 저장소 밖 비밀 관리 체계에 보관한다.
- **iOS 서명 자동화의 한계**: Xcode 자동 서명은 로컬 계정에 묶이므로 CI에서는 인증서·프로파일을 별도로 설치하거나 fastlane match 같은 도구를 쓴다.
- **난독화 후 크래시 분석 불가**: `--obfuscate`만 켜고 `--split-debug-info` 심볼을 버리면 Crashlytics 스택이 의미 없는 이름으로 남는다. 빌드 번호별 심볼 디렉터리를 아티팩트로 보관하고 `flutter symbolize`로 복원한다.
- **디버그 모드 기준 성능 판단**: 디버그 빌드의 느린 스크롤은 대부분 JIT·assert 비용이다. profile 모드에서 재현되지 않으면 문제가 아니다.
- **`Column` + `SingleChildScrollView` 목록**: 화면 밖 위젯까지 전부 build·layout 되어 UI 스레드가 밀린다. `ListView.builder`로 보이는 항목만 생성하고, 높이가 고정이면 `itemExtent`를 지정한다.

## 관련 글

- [테스트 — 단위·위젯·통합](/notes/flutter/testing/)
- [플랫폼 채널과 네이티브 연동·권한](/notes/flutter/platform-channels-native/)
- [위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack](/notes/flutter/widgets-layout/)
