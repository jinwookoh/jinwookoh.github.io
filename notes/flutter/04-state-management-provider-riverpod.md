---
title: "상태 관리 — setState·InheritedWidget·Provider·Riverpod"
series: flutter
part: "위젯과 상태"
order: 4
summary: "상태를 어디에 두고 누가 다시 그릴지를 setState·InheritedWidget·Provider·Riverpod 단계별로 정리한다"
tags: [Flutter, State Management, Provider, Riverpod, ChangeNotifier]
sources: [https://docs.flutter.dev/data-and-backend/state-mgmt/intro, https://docs.flutter.dev/data-and-backend/state-mgmt/simple, https://riverpod.dev/docs/introduction/why_riverpod]
updated: 2026-08-30
---

Flutter의 위젯은 불변이고, 상태가 바뀌면 그 상태를 읽는 서브트리를 다시 만든다. 화면 한 곳에서만 쓰는 값은 `setState`로 충분하지만, 로그인 정보나 장바구니처럼 여러 화면이 공유하는 값을 `setState`로 다루면 생성자 인자로 상태와 콜백을 몇 단계씩 내려보내게 되고, 값이 바뀔 때 어느 위젯이 다시 그려지는지도 흐려진다. 상태 관리 도구는 상태의 위치와 리빌드 범위를 명시적으로 다루기 위한 장치다.

## 핵심 개념

### 임시 상태와 앱 상태

공식 문서는 상태를 둘로 나눈다. 임시 상태는 탭 인덱스, 입력값, 애니메이션 진행도처럼 위젯 하나 안에서 끝나는 값으로 `State` 객체에 두고 `setState`로 갱신한다. 앱 상태는 세션, 장바구니처럼 여러 화면이 함께 읽고 쓰는 값으로, 그것을 쓰는 위젯들보다 위쪽에 올려 두고 아래에서 읽어 내려간다.

### setState와 InheritedWidget

`setState`는 `State`의 필드를 바꾼 뒤 그 `State`가 소유한 서브트리 전체를 다음 프레임에 다시 빌드하도록 표시한다. 리빌드 단위가 크고, 상태가 위젯에 묶여 다른 화면에서 접근할 수 없다.

`InheritedWidget`은 트리 위쪽에 값을 두고 하위 위젯이 `BuildContext`로 가장 가까운 조상을 찾아 읽는 내장 메커니즘이다. `dependOnInheritedWidgetOfExactType`로 읽으면 의존이 등록되어, `updateShouldNotify`가 `true`일 때 그 값을 읽은 위젯만 리빌드된다. 값을 갱신하려면 `StatefulWidget`으로 감싸 새 인스턴스를 만들어야 해서 직접 쓰는 일은 드물다.

### Provider와 ChangeNotifier

`provider` 패키지는 `InheritedWidget`을 감싼 얇은 계층이다. `ChangeNotifier`는 상태를 담는 일반 클래스로, 변경 후 `notifyListeners()`를 호출하면 리스너가 실행된다. `ChangeNotifierProvider`는 인스턴스를 생성해 트리에 공급하고 위젯이 사라질 때 `dispose`까지 호출한다. `Consumer<T>`나 `context.watch<T>()`는 값을 읽으면서 의존을 등록해 값이 바뀌면 그 위젯만 리빌드하고, 메서드만 호출할 때는 `context.read<T>()`를 쓴다.

Spring으로 대응시키면 `ChangeNotifierProvider`는 빈을 등록하는 `@Configuration`, `context.read<T>()`는 `ApplicationContext.getBean(T.class)`에 가깝다.

### Riverpod

==Provider는 타입으로 값을 찾기 때문에 같은 타입의 provider를 둘 수 없고, 공급자가 없으면 런타임에 `ProviderNotFoundException`이 난다.== Riverpod는 provider를 위젯 트리가 아닌 전역 상수로 선언해 이를 해결한다. 저장소는 앱 루트의 `ProviderScope`이고, 위젯은 `ConsumerWidget`의 `WidgetRef`로, provider끼리는 `Ref`로 서로를 읽는다.

Riverpod 3.x에서는 상태와 변경 로직을 `Notifier` 서브클래스의 `build()`와 메서드로 묶고 `NotifierProvider`로 노출한다. 비동기 초기화는 `AsyncNotifier`가 맡고 상태가 `AsyncValue`로 감싸진다. `@riverpod` 코드 생성을 쓰면 화면을 벗어날 때 자동 폐기되는 `autoDispose`가 기본이다. Spring 관점에서 `ProviderScope`는 `ApplicationContext`, provider는 지연 초기화 싱글턴 빈, `ProviderScope(overrides:)`는 테스트에서 빈을 교체하는 `@MockBean`에 해당한다.

## 코드

`provider`로 장바구니를 앱 상태로 올리고, 총액 텍스트만 리빌드되게 한 예제다.

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CartModel extends ChangeNotifier {
  final List<String> _items = [];

  List<String> get items => List.unmodifiable(_items);
  int get total => _items.length * 1000;

  void add(String item) {
    _items.add(item);
    notifyListeners();
  }
}

void main() {
  runApp(
    ChangeNotifierProvider(
      create: (_) => CartModel(),
      child: const MaterialApp(home: CartPage()),
    ),
  );
}

class CartPage extends StatelessWidget {
  const CartPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Consumer<CartModel>(
          builder: (_, cart, __) => Text('합계 ${cart.total}원'),
        ),
      ),
      body: Center(
        child: ElevatedButton(
          onPressed: () => context.read<CartModel>().add('apple'),
          child: const Text('담기'),
        ),
      ),
    );
  }
}
```

같은 기능을 Riverpod 3.x의 `Notifier`로 옮긴 예제다. provider는 전역 상수이고 파생 상태는 `ref.watch`로 연결한다.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class CartNotifier extends Notifier<List<String>> {
  @override
  List<String> build() => const [];

  void add(String item) => state = [...state, item];
}

final cartProvider = NotifierProvider<CartNotifier, List<String>>(
  CartNotifier.new,
);

final cartTotalProvider = Provider<int>((ref) {
  return ref.watch(cartProvider).length * 1000;
});

void main() {
  runApp(const ProviderScope(child: MaterialApp(home: CartPage())));
}

class CartPage extends ConsumerWidget {
  const CartPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final total = ref.watch(cartTotalProvider);
    return Scaffold(
      appBar: AppBar(title: Text('합계 $total원')),
      body: Center(
        child: ElevatedButton(
          onPressed: () => ref.read(cartProvider.notifier).add('apple'),
          child: const Text('담기'),
        ),
      ),
    );
  }
}
```

비동기 초기화는 `AsyncNotifier`로 처리하고 위젯은 `AsyncValue`를 패턴 매칭으로 분기한다.

```dart
class ProfileNotifier extends AsyncNotifier<String> {
  @override
  Future<String> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return 'jinwoo';
  }
}

final profileProvider =
    AsyncNotifierProvider<ProfileNotifier, String>(ProfileNotifier.new);

class ProfileView extends ConsumerWidget {
  const ProfileView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(profileProvider)) {
      AsyncData(:final value) => Text(value),
      AsyncError(:final error) => Text('오류: $error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

## 실무에서 걸리는 지점

- ==`build` 안에서 `read`로 읽은 값은 바뀌어도 위젯이 갱신되지 않는다.== 표시할 값은 `watch`, 핸들러 안에서 한 번 쓰는 값은 `read`로 구분한다.
- `notifyListeners()`는 어떤 필드가 바뀌었는지 구분하지 않아 모델이 커지면 무관한 위젯까지 리빌드된다. `context.select`나 `ref.watch(provider.select(...))`로 필요한 필드만 구독한다.
- ==`autoDispose` provider를 `ref.read`로만 읽으면 구독자가 없다고 판단해 즉시 폐기되고 다음 접근 때 재초기화된다.== 유지가 필요하면 `ref.keepAlive()`를 쓴다.
- ==`Notifier.build()`는 의존 provider가 바뀔 때마다 다시 실행되어 상태가 초기값으로 돌아간다.== 입력 중인 값이 사라지는 버그의 흔한 원인이므로 `watch`할 대상과 `listen`으로 처리할 이벤트를 구분한다.

## 관련 글

- [위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack](/notes/flutter/widgets-layout/)
- [내비게이션 — Navigator·go_router](/notes/flutter/navigation-go-router/)
- [테스트 — 단위·위젯·통합](/notes/flutter/testing/)
