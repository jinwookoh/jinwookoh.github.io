---
title: "위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack"
series: flutter
part: "위젯과 상태"
order: 3
summary: "위젯은 불변 설계도이고 상태는 State가 들고 있으며, 크기는 부모 제약이 결정한다"
tags: [Flutter, StatelessWidget, StatefulWidget, Row/Column/Stack, BoxConstraints]
sources: [https://docs.flutter.dev/ui/layout, https://docs.flutter.dev/ui/interactivity, https://docs.flutter.dev/ui/layout/constraints]
updated: 2026-08-30
---

Flutter에는 XML 레이아웃 파일이나 CSS 같은 별도의 배치 언어가 없다. 텍스트와 버튼은 물론 여백·정렬·크기 제한까지 전부 위젯 객체로 표현한다. 이 규칙을 모른 채 `Column` 안에 `ListView`를 넣으면 "unbounded height" 오류로 렌더링이 중단되고, 상태를 가질 위젯과 순수하게 그리기만 할 위젯을 구분하지 못하면 버튼을 눌러도 화면이 갱신되지 않거나 불필요한 리빌드가 반복된다.

## 핵심 개념

### StatelessWidget과 StatefulWidget

위젯은 UI의 한 조각을 기술하는 불변 객체다. 생성자 인자는 `final`이고, 변경이 필요하면 새 인스턴스로 트리를 다시 구성한다. `StatelessWidget`은 부모가 준 값만으로 `build()`를 실행하며 아이콘·라벨·정적 카드에 쓴다.

`StatefulWidget`은 위젯 자체는 불변이지만 `createState()`로 만든 `State` 객체를 트리에 붙인다. 위젯이 새 인스턴스로 교체되어도 같은 위치의 `State`는 유지되므로 사용자 입력처럼 시간에 따라 바뀌는 데이터를 보관한다. 변경을 알리는 방법은 `setState()`이며, 그 안에서 필드를 수정하면 다음 프레임에 해당 `State`의 `build()`만 다시 실행된다. `setState()` 없이 필드를 바꾸면 화면은 그대로다.

위젯 내부에서만 쓰는 상태(텍스트 필드 커서 등)는 위젯이 직접 관리하고, 부모가 알아야 하는 상태는 부모가 소유한 뒤 값과 콜백을 자식에게 내려 보낸다.

Spring과 대응시키면 `StatelessWidget`은 입력이 같으면 출력이 같은 뷰 템플릿이고, `State`는 요청 사이에 살아 있는 세션 스코프 빈, `setState()`는 뷰 갱신을 유발하는 이벤트 발행에 해당한다.

### 레이아웃 위젯

`Container`·`Padding`·`Center`·`SizedBox`·`Expanded`는 자식 하나를 감싸 여백·정렬·크기를 조정하고, `Row`·`Column`·`Stack`·`ListView`·`GridView`는 자식 여럿을 받는다.

| 위젯 | 배치 방향 | 주요 속성 |
|---|---|---|
| Row | 가로 | mainAxisAlignment, crossAxisAlignment |
| Column | 세로 | mainAxisAlignment, crossAxisAlignment |
| Stack | 겹침(z축) | alignment, Positioned 자식 |
| ListView | 스크롤 목록 | scrollDirection, builder |

`Row`와 `Column`은 주축과 교차축 기준으로 자식을 정렬하고, 주축 공간을 나눠야 하면 `Expanded`·`Flexible`의 `flex` 값으로 비율을 정한다. `Stack`은 자식을 순서대로 쌓으며 `Positioned`로 감싼 자식만 좌표를 직접 지정한다.

### 제약이 크기를 결정한다

핵심 규칙은 하나다. 제약은 아래로 내려가고, 크기는 위로 올라가며, 위치는 부모가 정한다. 부모는 최소·최대 너비와 높이를 담은 `BoxConstraints`를 자식에게 전달하고, 자식은 그 범위 안에서 크기를 골라 보고하며, 부모가 그 크기를 보고 위치를 정한다.

따라서 위젯은 자기 크기를 마음대로 정할 수 없다. `Container(width: 100)`이라 써도 부모가 tight 제약으로 화면 전체를 강제하면 100은 무시된다. 반대로 `Column`은 세로로 무한(unbounded) 제약을 주므로 자식이 최대로 커지려 하면 오류가 난다. `Center`·`Align`은 loose 제약을 주어 자식이 원하는 크기를 갖게 한다. 어떤 위젯이 제약을 조이고 푸는지 알면 대부분의 레이아웃 오류를 해석할 수 있다.

## 코드

카운터 상태를 `State`가 보관하고 `setState()`로 갱신하는 기본형이다.

```dart
import 'package:flutter/material.dart';

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
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text('Count: $_count'),
        const SizedBox(width: 12),
        FilledButton(onPressed: _increment, child: const Text('+')),
      ],
    );
  }
}
```

부모가 상태를 소유하고, 자식 `StatelessWidget`은 값과 콜백만 받는 형태다.

```dart
class TapBox extends StatelessWidget {
  const TapBox({super.key, required this.active, required this.onChanged});

  final bool active;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => onChanged(!active),
      child: Container(
        width: 120,
        height: 120,
        color: active ? Colors.lightGreen : Colors.grey,
        alignment: Alignment.center,
        child: Text(active ? 'Active' : 'Inactive'),
      ),
    );
  }
}

class ParentWidget extends StatefulWidget {
  const ParentWidget({super.key});

  @override
  State<ParentWidget> createState() => _ParentWidgetState();
}

class _ParentWidgetState extends State<ParentWidget> {
  bool _active = false;

  @override
  Widget build(BuildContext context) {
    return TapBox(
      active: _active,
      onChanged: (value) => setState(() => _active = value),
    );
  }
}
```

`Column` 안에 스크롤 목록을 넣을 때 `Expanded`로 높이 제약을 유한하게 만들고, `Stack`으로 배지를 겹치는 예다.

```dart
Widget buildScreen(List<String> items) {
  return Column(
    children: [
      Stack(
        alignment: Alignment.center,
        children: [
          const Icon(Icons.notifications, size: 48),
          Positioned(
            top: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.all(4),
              decoration: const BoxDecoration(
                color: Colors.red,
                shape: BoxShape.circle,
              ),
              child: Text('${items.length}'),
            ),
          ),
        ],
      ),
      Expanded(
        child: ListView.builder(
          itemCount: items.length,
          itemBuilder: (context, index) => ListTile(title: Text(items[index])),
        ),
      ),
    ],
  );
}
```

## 실무에서 걸리는 지점

- **unbounded 제약 오류.** `Column` 안의 `ListView`, `Row` 안의 `TextField`처럼 무한 제약 아래에 최대로 커지려는 위젯을 두면 예외가 난다. `Expanded`로 감싸 남은 공간을 배정하거나 `shrinkWrap`·`SizedBox`로 크기를 고정한다.
- **오버플로 경고.** `Row` 안에 긴 `Text`를 그대로 넣으면 노란 줄무늬 오버플로가 표시된다. `Expanded`나 `Flexible`로 감싸야 줄바꿈되며, 경고는 디버그 빌드에서만 보여 놓치기 쉽다.
- **State 재사용과 Key.** 같은 타입의 `StatefulWidget`을 리스트에서 순서만 바꾸면 프레임워크는 위치 기준으로 `State`를 재사용해 데이터가 엉킨다. 항목별 `ValueKey`를 지정해 위젯과 `State`의 대응을 고정한다.
- **불필요한 리빌드.** 최상위 `State`에서 `setState()`를 호출하면 하위 트리 전체가 다시 빌드된다. 상태를 바뀌는 위젯 가까이로 내리고, 불변 서브트리는 `const` 생성자로 만들어 빌드를 건너뛴다.
- **Container의 조건부 동작.** `Container`는 자식이 없으면 최대로 커지고 있으면 자식에 맞추는 등 제약 해석이 상황마다 다르다. 의도와 다른 크기가 나오면 `SizedBox`·`ConstrainedBox`처럼 역할이 하나인 위젯으로 바꾼다.

## 관련 글

- [Flutter란 — 위젯 트리와 렌더링](/notes/flutter/what-is-flutter-widget-tree/)
- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
- [Dart 핵심 — null safety·async·컬렉션](/notes/flutter/dart-essentials/)
