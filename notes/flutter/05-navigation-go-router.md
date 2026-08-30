---
title: "내비게이션 — Navigator·go_router"
series: flutter
part: "위젯과 상태"
order: 5
summary: "명령형 Navigator와 선언적 go_router의 차이, 그리고 딥링크·리다이렉트·탭 셸을 URL 기반으로 다루는 방법을 정리한다."
tags: [Flutter, Navigator, go_router, deep linking, ShellRoute]
sources: [https://docs.flutter.dev/ui/navigation, https://docs.flutter.dev/ui/navigation/deep-linking, https://pub.dev/documentation/go_router/latest/topics/Get%20started-topic.html]
updated: 2026-08-30
---

화면이 서너 개인 앱은 `Navigator.push`만으로 충분하다. 문제는 앱이 커지면서 생긴다. 푸시 알림이나 웹 URL로 상세 화면에 바로 들어가야 하고, 미로그인 사용자는 어느 경로로 오든 로그인 화면으로 보내야 하며, 하단 탭마다 독립 스택을 유지해야 한다. 명령형 API로는 현재 스택 상태가 코드 곳곳의 호출 이력에 흩어져 있어 이런 요구를 일관되게 처리하기 어렵다. 경로를 URL로 정의하고 그로부터 스택을 계산하는 방식이 필요해지는 지점이다.

## 핵심 개념

Flutter의 내비게이션 API는 두 층으로 나뉜다.

**Navigator 1.0(명령형)** 은 `Navigator.of(context).push(...)`, `pop()` 으로 스택을 직접 조작한다. `MaterialApp`이 루트 `Navigator`를 만들고 각 화면은 `Route` 객체로 쌓인다. ==`pushNamed` 방식은 딥링크 진입 시 중간 스택을 복원하지 못해 공식 문서도 새 프로젝트에는 권장하지 않는다.==

**Router API(선언적)** 는 `RouterDelegate`·`RouteInformationParser` 조합으로 앱 상태에서 페이지 목록을 계산한다. URL·뒤로가기·딥링크가 한 경로로 수렴하지만 직접 구현하면 보일러플레이트가 많다.

**go_router**는 Router API 위에 얹힌 공식 지원 패키지로, 라우트 정의만 하면 파서와 델리게이트를 대신 만든다.

| 요소 | 역할 |
| --- | --- |
| `GoRouter` | 라우트 트리·리다이렉트·에러 화면 설정. `MaterialApp.router(routerConfig:)`에 넘긴다 |
| `GoRoute` | `path`와 `builder` 한 쌍. `routes:`로 중첩해 `/users/:id` 계층을 만든다 |
| `ShellRoute` | 하위 라우트를 공통 UI(앱바·바텀바) 안에 렌더링한다 |
| `StatefulShellRoute` | 탭별 독립 `Navigator` 스택을 유지·보존한다 |
| `redirect` | 라우팅 직전에 경로를 바꾸는 훅 |
| `refreshListenable` | 외부 `Listenable` 변경 시 리다이렉트를 재평가한다 |

이동 API는 두 가지다. `context.go('/a/b')`는 라우트 트리에 맞춰 스택을 재구성하고, `context.push('/x')`는 현재 스택 위에 화면 하나를 추가한다.

**딥링크**는 OS가 URL을 앱에 전달하는 메커니즘이다. Android는 `AndroidManifest.xml`의 intent-filter, iOS는 Universal Links(`apple-app-site-association`)와 `Info.plist`의 `FlutterDeepLinkingEnabled`를 설정한다. 들어온 URL은 Router API로 전달되므로 go_router 라우트만 맞으면 추가 코드 없이 화면이 열린다. 자체 스킴(`myapp://`)은 누구나 등록할 수 있어 공식 문서는 App Links·Universal Links를 권장한다.

Spring 기준으로 `GoRoute`의 `path`·`:id`·중첩 구조는 `@RequestMapping` 계층과 `@PathVariable`에, `redirect`는 Security Filter의 인증 리다이렉트에 대응한다.

## 코드

라우트 트리와 인증 리다이렉트를 정의하고 `MaterialApp.router`에 연결한다.

```dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final authState = ValueNotifier<bool>(false); // 로그인 여부

final router = GoRouter(
  initialLocation: '/',
  refreshListenable: authState,
  redirect: (context, state) {
    final loggedIn = authState.value;
    final goingToLogin = state.matchedLocation == '/login';
    if (!loggedIn && !goingToLogin) {
      return '/login?from=${Uri.encodeComponent(state.uri.toString())}';
    }
    if (loggedIn && goingToLogin) return '/';
    return null; // 그대로 진행
  },
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'users/:id',
          builder: (context, state) =>
              UserScreen(id: state.pathParameters['id']!),
        ),
      ],
    ),
    GoRoute(
      path: '/login',
      builder: (context, state) =>
          LoginScreen(from: state.uri.queryParameters['from']),
    ),
  ],
  errorBuilder: (context, state) => NotFoundScreen(uri: state.uri),
);

void main() => runApp(MaterialApp.router(routerConfig: router));
```

화면 안에서는 `BuildContext` 확장 메서드로 이동한다. `go`는 `/users/42`의 부모인 `/`까지 스택을 구성하므로 딥링크로 들어와도 뒤로가기가 홈으로 돌아간다.

```dart
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        children: [
          ListTile(
            title: const Text('User 42'),
            onTap: () => context.go('/users/42'),
          ),
          ListTile(
            title: const Text('설정(모달)'),
            onTap: () async {
              final saved = await context.push<bool>('/settings');
              if (saved == true && context.mounted) {
                ScaffoldMessenger.of(context)
                    .showSnackBar(const SnackBar(content: Text('저장됨')));
              }
            },
          ),
        ],
      ),
    );
  }
}
```

탭별 독립 스택은 `StatefulShellRoute.indexedStack`으로 만든다. 각 브랜치가 자체 `Navigator`를 가져 탭을 오가도 하위 화면이 보존된다.

```dart
final tabRouter = GoRouter(
  initialLocation: '/feed',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) => Scaffold(
        body: navigationShell,
        bottomNavigationBar: NavigationBar(
          selectedIndex: navigationShell.currentIndex,
          onDestinationSelected: (i) => navigationShell.goBranch(
            i,
            initialLocation: i == navigationShell.currentIndex,
          ),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.home), label: 'Feed'),
            NavigationDestination(icon: Icon(Icons.person), label: 'Me'),
          ],
        ),
      ),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/feed',
            builder: (_, __) => const FeedScreen(),
            routes: [
              GoRoute(
                path: ':postId',
                builder: (_, s) => PostScreen(id: s.pathParameters['postId']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(path: '/me', builder: (_, __) => const ProfileScreen()),
        ]),
      ],
    ),
  ],
);
```

## 실무에서 걸리는 지점

- **`go`와 `push`를 섞어 쓰면 스택이 예측 불가능해진다.** `push`로 쌓은 화면 위에서 `go`를 호출하면 스택이 재구성되어 사용자 이력이 사라진다. URL이 바뀌는 이동은 `go`, 결과를 돌려받는 일시적 화면은 `push`로 기준을 정해 둔다.
- **`redirect`는 매 이동마다 실행되므로 무거운 작업을 넣지 않는다.** 인증 상태는 메모리에서 동기적으로 판정하고 변화는 `refreshListenable`로 알린다. ==리다이렉트가 서로를 가리키면 `redirectLimit`(기본 5) 초과로 에러 화면에 떨어진다.==
- **딥링크 장애는 플랫폼 설정 누락이 대부분이다.** Android는 `adb shell am start -a android.intent.action.VIEW -d <url>`, iOS는 `xcrun simctl openurl booted <url>`로 검증한다. Universal Links는 도메인에 AASA 파일이 배포되어야 하므로 로컬만으로는 확인이 끝나지 않는다.
- **`GoRouter`를 `build` 안에서 만들면 안 된다.** ==리빌드마다 새 라우터가 생겨 스택이 초기화된다.== 전역 또는 Riverpod 싱글턴으로 한 번만 생성한다.
- **웹은 `usePathUrlStrategy()`와 서버 설정이 한 세트다.** 이를 호출해야 `#/` 없는 경로가 되며, ==서버가 모든 경로를 `index.html`로 돌려줘야 새로고침 시 404가 나지 않는다==. 전환 애니메이션은 `pageBuilder`에서 `CustomTransitionPage`를 반환해 바꾼다.

## 관련 글

- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
- [위젯과 레이아웃 — Stateless/Stateful·Row/Column/Stack](/notes/flutter/widgets-layout/)
- [플랫폼 채널과 네이티브 연동·권한](/notes/flutter/platform-channels-native/)
