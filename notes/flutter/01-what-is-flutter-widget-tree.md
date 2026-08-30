---
title: "Flutter란 — 위젯 트리와 렌더링"
series: flutter
part: "기초"
order: 1
summary: "Flutter가 플랫폼 UI 컴포넌트 대신 자체 렌더러와 위젯·엘리먼트·렌더 세 트리로 화면을 그리는 구조를 정리한다"
tags: [Flutter, Dart, Widget, Element, RenderObject]
sources: [https://docs.flutter.dev/resources/architectural-overview, https://docs.flutter.dev/ui/widgets-intro, https://docs.flutter.dev/get-started/fundamentals]
updated: 2026-08-30
---

iOS와 Android에 같은 화면을 내려면 두 벌의 UI 코드를 유지하거나, 네이티브 컴포넌트를 브리지로 감싸야 한다. 전자는 비용이 두 배로 들고, 후자는 브리지 직렬화 비용과 플랫폼별 동작 차이가 남는다. ==Flutter는 플랫폼의 UI 컴포넌트를 아예 쓰지 않고, 자체 렌더링 엔진이 픽셀 단위로 화면을 그리는 쪽을 선택했다.== 동일한 Dart 코드가 모바일·웹·데스크톱에서 같은 모양으로 동작하고, UI 코드와 엔진 사이에 브리지가 없다.

## 핵심 개념

### 계층 구조

Flutter는 세 계층으로 나뉜다. Embedder는 플랫폼별 진입점으로 렌더 서피스·입력 이벤트·스레드를 OS에서 받아 엔진에 넘긴다. Engine은 C++로 작성됐고 래스터화, 텍스트 레이아웃, 플랫폼 채널, Dart 런타임을 포함하며, 렌더러는 셰이더를 빌드 시점에 미리 컴파일하는 Impeller가 기본이다. Framework는 Dart 라이브러리 묶음으로 foundation·rendering·widgets 계층 위에 Material·Cupertino가 올라간다. 애플리케이션 코드는 대부분 widgets 계층 이상만 만진다.

Spring 개발자 관점에서 Embedder는 서블릿 컨테이너, Framework는 Spring 컨텍스트에 해당한다. 애플리케이션이 컨테이너 API를 직접 호출하지 않듯, Flutter 앱도 Engine을 직접 다루지 않는다.

### 모든 것이 위젯

Flutter UI는 위젯의 트리다. 버튼이나 텍스트뿐 아니라 여백(`Padding`), 정렬(`Center`), 제스처 감지(`GestureDetector`)까지 전부 위젯이다. 위젯은 불변 객체이며 UI의 특정 부분이 어떤 설정으로 보여야 하는지를 선언한다. 상태가 바뀌면 위젯을 수정하지 않고 새 트리를 만들며, 프레임워크가 이전 트리와 비교해 바뀐 부분만 반영한다.

위젯 자체는 상태를 갖지 않는다. `StatelessWidget`은 설정만으로 그려지고, `StatefulWidget`은 별도의 `State` 객체를 두어 변경 가능한 값을 보관한다. `setState()`를 호출하면 프레임워크가 해당 `State`의 `build()`를 다시 실행하도록 예약한다.

### 위젯·엘리먼트·렌더 트리

실제 렌더링에는 세 개의 트리가 관여한다.

| 트리 | 역할 | 수명 |
|---|---|---|
| Widget | 불변 설정. `build()`마다 새로 생성 | 한 프레임 |
| Element | 위젯의 인스턴스화. 트리 상의 위치와 `State` 보유 | 위젯 타입·키가 같은 동안 유지 |
| RenderObject | 레이아웃·페인팅·히트 테스트 수행 | Element와 동일 |

`build()`가 새 위젯을 반환하면 프레임워크는 기존 Element의 위젯과 새 위젯을 `runtimeType`과 `key`로 비교한다. 같으면 Element를 재사용하고 RenderObject의 속성만 갱신하며, 다르면 Element를 버리고 새로 만든다. ==상태와 렌더 객체는 Element에 매달려 있으므로 위젯이 매 프레임 다시 만들어져도 보존된다.== 비교는 부모·자식 한 단계씩만 수행하므로 O(N)에 끝난다.

### 레이아웃 프로토콜

레이아웃은 한 번의 트리 순회로 끝난다. 부모가 자식에게 최소·최대 크기 제약(`BoxConstraints`)을 내려보내고, 자식은 그 범위 안에서 크기를 정해 돌려주며, 부모가 위치를 결정한다. ==제약은 아래로, 크기는 위로 흐르므로 위젯은 자기 크기를 단독으로 정할 수 없다.== `Container`에 `width: 200`을 줘도 부모가 강제 제약을 걸면 무시된다.

## 코드

가장 작은 Flutter 앱. `runApp()`이 루트 위젯을 받아 위젯 트리를 붙이고, `MaterialApp`이 내비게이션·테마·로컬라이제이션 인프라를 제공한다.

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Scaffold(
        body: Center(child: Text('Hello, Flutter')),
      ),
    );
  }
}
```

`StatefulWidget`과 `State`의 분리. 위젯은 매번 새로 생성되지만 `_count`는 `State`에 남아 있다.

```dart
class Counter extends StatefulWidget {
  const Counter({super.key});

  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  void _increment() {
    setState(() => _count++);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text('count: $_count', style: Theme.of(context).textTheme.headlineMedium),
        FilledButton(onPressed: _increment, child: const Text('+1')),
      ],
    );
  }
}
```

레이아웃 제약이 위젯 크기를 덮어쓰는 예. 바깥 `SizedBox`가 100×100 강제 제약을 내리므로 안쪽 `Container`의 200 지정은 반영되지 않는다.

```dart
SizedBox(
  width: 100,
  height: 100,
  child: Container(
    width: 200,
    height: 200,
    color: Colors.blue,
  ),
)
```

## 실무에서 걸리는 지점

- ==**`build()`는 언제든 여러 번 호출된다.**== 네트워크 요청이나 컨트롤러 생성처럼 부수효과가 있는 코드를 `build()`에 두면 리빌드마다 반복된다. 초기화는 `initState()`, 해제는 `dispose()`에 둔다.
- **리스트 항목에 `key`가 없으면 상태가 엇갈린다.** 같은 타입의 `StatefulWidget`을 순서만 바꾸면 프레임워크는 위치 기준으로 Element를 재사용하므로, 첫 번째 항목의 상태가 두 번째 항목에 붙는다. 데이터 식별자를 `ValueKey`로 넘긴다.
- **`setState()`의 범위가 넓으면 불필요한 리빌드가 늘어난다.** 화면 최상위 `State`에서 호출하면 하위 트리 전체가 다시 `build()`된다. 변하는 부분을 작은 `StatefulWidget`으로 분리하고, 고정 서브트리는 `const` 생성자로 만든다.
- **레이아웃 오류는 RenderObject 단계에서 난다.** "RenderFlex overflowed" 같은 오류는 어떤 부모가 어떤 제약을 내렸는지 DevTools의 Layout Explorer로 추적한다.
- **플랫폼 뷰는 예외다.** WebView나 지도 같은 네이티브 뷰는 Flutter 렌더러 밖에서 그려지므로 합성 비용이 커진다. 화면당 플랫폼 뷰 개수를 최소화한다.

## 관련 글

- [Dart 핵심 — null safety·async·컬렉션](/notes/flutter/dart-essentials/)
- [위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack](/notes/flutter/widgets-layout/)
- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
