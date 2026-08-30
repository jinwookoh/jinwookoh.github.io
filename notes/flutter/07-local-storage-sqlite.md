---
title: "로컬 저장 — SharedPreferences·SQLite·파일"
series: flutter
part: "데이터와 플랫폼"
order: 7
summary: "설정값은 shared_preferences, 구조화 데이터는 sqflite, 큰 덩어리는 path_provider 파일로 나눠 저장한다"
tags: [Flutter, shared_preferences, sqflite, path_provider, 로컬 저장]
sources: [https://docs.flutter.dev/cookbook/persistence/key-value, https://docs.flutter.dev/cookbook/persistence/sqlite, https://docs.flutter.dev/cookbook/persistence/reading-writing-files]
updated: 2026-08-30
---

앱이 메모리에만 상태를 들고 있으면 프로세스가 종료되는 순간 모든 것이 사라진다. 사용자가 고른 테마, 로그인 토큰, 마지막으로 보던 화면, 오프라인에서 봐야 하는 목록까지 매번 서버에서 다시 받아야 하고, 네트워크가 끊기면 아무것도 보여줄 수 없다. Flutter는 저장할 데이터의 성격에 따라 세 가지 수단을 제공한다. 작은 키-값은 `shared_preferences`, 관계형 조회가 필요한 데이터는 `sqflite`, 그 외 텍스트·바이너리 덩어리는 `path_provider`와 `dart:io`로 직접 파일에 쓴다.
## 핵심 개념

세 방식은 저장 위치와 접근 방식이 다르다.

| 수단 | 데이터 형태 | 지원 타입 | 적합한 용도 |
|---|---|---|---|
| shared_preferences | 키-값 | int·double·bool·String·List\<String\> | 설정, 플래그, 소량 캐시 |
| sqflite | 관계형 테이블 | SQL 스키마 | 목록·검색·정렬이 필요한 데이터 |
| path_provider + File | 임의 바이트 | 제한 없음 | 다운로드 파일, 로그, JSON 덤프 |

`shared_preferences`는 플랫폼별 네이티브 저장소(Android의 SharedPreferences, iOS의 NSUserDefaults)를 감싼 플러그인이다. `getInstance()`는 비동기이며 한 번 로드한 뒤 값을 메모리에 캐시하므로 이후의 getter는 동기로 동작한다. 기본 타입만 넣을 수 있고, 저장된 값의 타입과 다른 getter를 호출하면 예외가 난다. 대량 데이터용으로 설계된 것이 아니며, 공식 문서도 영속성을 완전히 보장하지 않는다고 명시한다.

`sqflite`는 기기 내장 SQLite를 사용한다. `openDatabase`에 파일 경로와 `version`, `onCreate` 콜백을 넘기면 첫 실행 때 스키마를 만들고, 이후 버전을 올리면 `onUpgrade`에서 마이그레이션을 수행한다. `insert`·`query`·`update`·`delete` 헬퍼는 SQL을 직접 쓰지 않고도 CRUD를 처리하며, 조건은 `where`와 `whereArgs`로 파라미터 바인딩한다. 반환값은 `List<Map<String, Object?>>`이므로 모델 클래스의 `toMap`·`fromMap`으로 변환하는 계층이 필요하다.

파일 저장은 `path_provider`로 플랫폼별 디렉터리를 얻는 데서 시작한다. `getTemporaryDirectory()`는 OS가 언제든 비울 수 있는 캐시 영역이고, `getApplicationDocumentsDirectory()`는 앱 삭제 전까지 유지되는 영역이다. 경로를 얻은 뒤에는 `dart:io`의 `File`로 `writeAsString`·`readAsString`·`writeAsBytes`를 호출한다.

Spring/Java 관점에서 보면 `shared_preferences`는 `java.util.prefs.Preferences`나 프로퍼티 파일에 가깝고, `sqflite`는 JPA 없이 `JdbcTemplate`으로 SQLite를 다루는 것에 대응한다. `onCreate`·`onUpgrade` 버전 관리는 Flyway의 버전 마이그레이션과 같은 역할을 한다.

## 코드

카운터 값을 키-값 저장소에 읽고 쓰는 최소 예제다. 저장이 완료되기 전에 화면을 갱신하지 않도록 `await`를 붙인다.

```dart
import 'package:shared_preferences/shared_preferences.dart';

class CounterStore {
  static const _key = 'counter';

  Future<int> load() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt(_key) ?? 0;
  }

  Future<void> save(int value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_key, value);
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
```

`sqflite`로 테이블을 만들고 CRUD를 수행하는 저장소 클래스다. 데이터베이스 핸들은 한 번만 열어 재사용하고, 조건절은 반드시 `whereArgs`로 바인딩한다.

```dart
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

class Dog {
  final int id;
  final String name;
  final int age;

  const Dog({required this.id, required this.name, required this.age});

  Map<String, Object?> toMap() => {'id': id, 'name': name, 'age': age};

  factory Dog.fromMap(Map<String, Object?> m) =>
      Dog(id: m['id'] as int, name: m['name'] as String, age: m['age'] as int);
}

class DogRepository {
  Database? _db;

  Future<Database> get _database async {
    return _db ??= await openDatabase(
      join(await getDatabasesPath(), 'doggie.db'),
      version: 2,
      onCreate: (db, version) => db.execute(
        'CREATE TABLE dogs(id INTEGER PRIMARY KEY, name TEXT, age INTEGER)',
      ),
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute('ALTER TABLE dogs ADD COLUMN breed TEXT');
        }
      },
    );
  }

  Future<void> insert(Dog dog) async {
    final db = await _database;
    await db.insert('dogs', dog.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<List<Dog>> findAll() async {
    final db = await _database;
    final rows = await db.query('dogs', orderBy: 'age DESC');
    return rows.map(Dog.fromMap).toList();
  }

  Future<void> update(Dog dog) async {
    final db = await _database;
    await db.update('dogs', dog.toMap(), where: 'id = ?', whereArgs: [dog.id]);
  }

  Future<void> delete(int id) async {
    final db = await _database;
    await db.delete('dogs', where: 'id = ?', whereArgs: [id]);
  }
}
```

문서 디렉터리에 텍스트 파일을 쓰고 읽는 예제다. 파일이 없을 때 `readAsString`이 예외를 던지므로 기본값으로 복구한다.

```dart
import 'dart:io';
import 'package:path_provider/path_provider.dart';

class NoteFile {
  Future<File> get _file async {
    final dir = await getApplicationDocumentsDirectory();
    return File('${dir.path}/note.txt');
  }

  Future<void> write(String text) async {
    final file = await _file;
    await file.writeAsString(text, flush: true);
  }

  Future<String> read() async {
    try {
      return await (await _file).readAsString();
    } on FileSystemException {
      return '';
    }
  }
}
```

## 실무에서 걸리는 지점

- **shared_preferences에 큰 JSON을 넣는 관행.** 문자열로 직렬화한 목록 전체를 키 하나에 넣으면 앱 시작 시 파일 전체를 메모리에 올리고, 값 하나를 바꿔도 전체를 다시 쓴다. 수백 KB를 넘어가면 sqflite나 파일로 옮긴다. 토큰 같은 민감값은 평문으로 저장되므로 `flutter_secure_storage` 계열로 분리한다.
- **플랫폼 지원 범위.** `sqflite`는 Android·iOS·macOS만 지원한다. 웹이나 Windows·Linux 데스크톱을 타깃에 넣으면 `sqflite_common_ffi` 같은 대체 구현으로 팩토리를 교체해야 하고, `dart:io` 기반 파일 접근은 웹에서 아예 동작하지 않는다.
- **스키마 버전 관리 누락.** `version`을 올리지 않고 `onCreate`의 SQL만 고치면 기존 설치 기기에서는 아무 변화가 없다. 컬럼 추가는 반드시 `onUpgrade`의 버전 분기로 처리하고, 첫 배포부터 마이그레이션 함수를 버전별로 누적한다.
- **데이터베이스 핸들 중복 오픈.** 호출마다 `openDatabase`를 실행하면 파일 핸들이 늘어나고 동시 쓰기 시 잠금 오류가 난다. 싱글턴 또는 DI 컨테이너에서 한 번만 열고, 대량 삽입은 `batch()`나 `transaction()`으로 묶어 디스크 동기화 횟수를 줄인다.
- **캐시 디렉터리와 문서 디렉터리 혼동.** `getTemporaryDirectory()`에 둔 파일은 저장 공간 부족 시 OS가 지운다. 반대로 재생성 가능한 캐시를 문서 디렉터리에 두면 iOS에서 iCloud 백업 대상이 되어 심사나 용량 문제가 생긴다. 파일의 수명에 따라 디렉터리를 고른다.

## 관련 글

- [네트워크·JSON 직렬화](/notes/flutter/networking-json-serialization/)
- [상태 관리 — setState·InheritedWidget·Provider·Riverpod](/notes/flutter/state-management-provider-riverpod/)
- [플랫폼 채널과 네이티브 연동·권한](/notes/flutter/platform-channels-native/)
