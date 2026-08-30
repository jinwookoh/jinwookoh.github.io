---
title: "Dart 핵심 — null safety·async·컬렉션"
series: flutter
part: "기초"
order: 2
summary: "Dart 3의 sound null safety·Future/Stream 비동기·컬렉션 리터럴을 Flutter 코드 읽기에 필요한 만큼 정리한다"
tags: [Dart, null safety, async, Future, Stream]
sources: [https://dart.dev/language, https://dart.dev/null-safety, https://dart.dev/libraries/async/async-await, https://dart.dev/language/collections]
updated: 2026-08-30
---

Flutter 코드는 위젯 트리를 만드는 Dart 표현식과 비동기 데이터 처리로 이루어진다. Dart를 Java와 비슷하다고 넘기면 `?`·`!`·`late`가 붙은 타입, `async*` 함수, 컬렉션 리터럴 안의 `if`와 `for`를 읽지 못해 위젯 코드가 막힌다. null safety를 모른 채 `!`를 남발하면 컴파일은 통과하지만 런타임에 `Null check operator used on a null value`로 앱이 죽는다.

## 핵심 개념

### Sound null safety

Dart 3부터 null safety는 언어의 기본이다. 모든 타입은 null을 허용하지 않으며, null이 들어갈 자리는 `String?`처럼 `?`를 붙여 명시한다. "sound"는 non-nullable 값에 실제로 null이 들어올 수 없음을 타입 시스템이 보장한다는 뜻이며, 덕분에 컴파일러가 null 체크를 제거한다.

null 처리 도구는 `x?.foo`(null이면 전체가 null), `x ?? y`(null이면 대체값), `x ??= y`(null일 때만 대입), `x!`(null 아님 단언, 틀리면 예외), `late T x`(첫 사용 전 초기화 약속), `required`(named 파라미터 필수화)다.

Flow analysis도 중요하다. `if (x != null)` 분기 안에서는 지역 변수 `x`가 자동으로 non-nullable로 승격된다. 승격은 지역 변수와 Dart 3.2부터 private final 필드에만 적용되고, getter나 public 필드는 중간에 값이 바뀔 수 있어 승격되지 않는다. 이 경우 지역 변수로 복사한 뒤 검사한다. Java와 비교하면 `T?`는 `Optional<T>`보다 Kotlin의 nullable 타입에 가깝다.

### 비동기 — Future와 Stream

Dart는 단일 스레드 이벤트 루프 위에서 동작한다. 하나의 값을 나중에 돌려주는 연산은 `Future<T>`, 여러 값을 순차적으로 내보내는 것은 `Stream<T>`다. `async` 함수는 반드시 `Future`를 반환하고, `await`를 만나면 해당 Future가 끝날 때까지 실행을 양보한 뒤 이벤트 루프가 이어서 재개한다.

`Stream`은 `await for`로 순회하거나 `listen`으로 구독한다. `async*` 함수는 `yield`로 값을 하나씩 내보내는 Stream 생성기이며, 구독자가 없으면 실행되지 않는다. 예외는 `try/catch`로 동기 코드와 같게 잡는다.

Java 대응은 `Future` ≈ `CompletableFuture`, `Stream` ≈ Reactor의 `Flux`다. 단, Dart의 Future는 별도 스레드가 아니라 같은 isolate의 이벤트 큐에서 처리되므로 CPU 집약 작업은 `Isolate.run`으로 다른 isolate에 넘겨야 UI가 멈추지 않는다.

### 컬렉션

기본 컬렉션은 `List`, `Set`, `Map`이며 리터럴 `[]`, `{}`, `{k: v}`로 만든다. 빈 `{}`는 Map으로 추론되므로 빈 Set은 `<int>{}`로 쓴다. 스프레드 `...`, null-aware 스프레드 `...?`, collection if, collection for를 조합하면 조건에 따라 위젯 목록을 만드는 코드가 한 표현식으로 끝나며, Flutter의 `children: [...]`에서 매우 자주 쓰인다.

Dart 3의 레코드 `(int, String)`과 패턴 매칭도 함께 쓰인다. `sealed class`와 `switch` 식을 조합하면 컴파일러가 모든 하위 타입을 다뤘는지 검사한다. Java 17의 sealed interface + record + switch 패턴 매칭과 같은 역할이다.

## 코드

null safety의 승격·`late`·`required`를 한 클래스에 모은 예제다.

```dart
class User {
  final String name;
  final String? email;
  late final String displayName;

  User({required this.name, this.email}) {
    displayName = email == null ? name : '$name <$email>';
  }

  int emailLength() {
    final e = email; // 필드는 승격되지 않으므로 지역 변수로 복사
    if (e != null) return e.length; // 여기서 e는 String
    return 0;
  }
}

void main() {
  final u = User(name: 'jinwoo');
  print(u.email?.toUpperCase() ?? 'no email'); // no email
  print(u.emailLength()); // 0
  print(u.displayName); // jinwoo
}
```

`async/await`, `async*` Stream, `Isolate.run`을 함께 쓰는 예제다.

```dart
import 'dart:isolate';

Future<int> fetchCount() async {
  await Future<void>.delayed(const Duration(milliseconds: 100));
  return 3;
}

Stream<int> countDown(int from) async* {
  for (var i = from; i > 0; i--) {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    yield i;
  }
}

int heavy(int n) => List.generate(n, (i) => i).fold(0, (a, b) => a + b);

Future<void> main() async {
  try {
    final n = await fetchCount();
    await for (final v in countDown(n)) {
      print('tick $v');
    }
    final sum = await Isolate.run(() => heavy(10_000_000));
    print('sum $sum');
  } on Exception catch (e) {
    print('failed: $e');
  }
}
```

컬렉션 리터럴 안의 if/for/스프레드와 레코드·패턴 매칭 예제다.

```dart
sealed class Shape {}
class Circle extends Shape { final double r; Circle(this.r); }
class Rect extends Shape { final double w, h; Rect(this.w, this.h); }

double area(Shape s) => switch (s) {
  Circle(:final r) => 3.14159 * r * r,
  Rect(:final w, :final h) => w * h,
};

(int min, int max) range(List<int> xs) =>
    (xs.reduce((a, b) => a < b ? a : b), xs.reduce((a, b) => a > b ? a : b));

void main() {
  const isAdmin = true;
  List<String>? extra;
  final menu = [
    'home',
    if (isAdmin) 'admin',
    for (final i in [1, 2]) 'item$i',
    ...?extra,
  ];
  print(menu); // [home, admin, item1, item2]

  final (lo, hi) = range([4, 1, 9]);
  print('$lo..$hi'); // 1..9
  print(area(Rect(2, 3))); // 6.0
}
```

## 실무에서 걸리는 지점

- **`!` 남용.** 분석기 경고를 없애려고 `!`를 붙이면 null safety의 이점이 런타임 크래시로 바뀐다. `?.`·`??`·지역 변수 승격으로 풀리지 않을 때만 쓰고, 왜 null이 아닌지 주석으로 근거를 남긴다.
- **`late` 초기화 누락.** 초기화 전에 읽으면 `LateInitializationError`가 난다. `initState`의 조건 분기에서 초기화가 빠지기 쉬우므로 가능하면 nullable로 선언한다.
- **await 누락.** `Future`를 `await` 없이 호출하면 예외가 잡히지 않고 unhandled error로 흘러간다. 린트 `unawaited_futures`를 켜고, 의도적으로 기다리지 않을 때는 `unawaited()`로 감싼다.
- **Stream 구독 해제.** `listen`으로 만든 `StreamSubscription`을 `dispose`에서 `cancel`하지 않으면 위젯이 사라진 뒤에도 콜백이 실행되어 누수와 `setState() called after dispose()`가 발생한다. `StreamBuilder`는 구독을 자동 관리한다.
- **이벤트 루프 블로킹.** JSON 파싱처럼 수십 ms 이상 걸리는 동기 작업을 메인 isolate에서 돌리면 프레임이 끊긴다. `async`를 붙여도 동기 계산은 같은 스레드에서 돌기 때문에 `Isolate.run`이나 `compute`로 분리한다.

## 관련 글

- [Flutter란 — 위젯 트리와 렌더링](/notes/flutter/what-is-flutter-widget-tree/)
- [위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack](/notes/flutter/widgets-layout/)
- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
