---
title: "구성과 Options 패턴 — appsettings·환경·비밀 관리"
series: dotnet
part: "웹 API"
order: 7
summary: "여러 소스를 IConfiguration 하나로 합치고, Options 패턴으로 타입·검증·리로드를 다루며 비밀은 저장소 밖에 둔다"
tags: [Configuration, "Options 패턴", appsettings, "User Secrets", IOptionsMonitor]
sources: [https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration, https://learn.microsoft.com/en-us/dotnet/core/extensions/options, https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets]
updated: 2026-09-06
---

연결 문자열·API 키가 코드에 박혀 있으면 환경이 바뀔 때마다 다시 빌드해야 하고, 비밀이 저장소 이력에 남는다. 각 클래스가 파일을 직접 읽으면 소스 간 우선순위가 제각각이 되고, 키 오타는 런타임에 `null`로만 드러난다. .NET은 여러 소스를 하나의 키-값 뷰로 합치는 구성 시스템과, 그 값을 타입 있는 클래스로 묶어 주입·검증하는 Options 패턴으로 이 문제를 다룬다.

## 핵심 개념

### 소스 합성과 우선순위

`WebApplication.CreateBuilder(args)`는 `appsettings.json` → `appsettings.{Environment}.json` → User Secrets(Development일 때만) → 환경 변수 → 명령줄 인수 순으로 프로바이더를 등록하고, 같은 키는 나중 소스가 이긴다. 결과는 읽기 전용 `IConfiguration` 하나로 노출된다. 환경 이름은 `ASPNETCORE_ENVIRONMENT`로 정하고 기본값은 `Production`이다.

키는 콜론으로 계층을 표현한다. `Db:Timeout`은 JSON 중첩 객체에 대응하고, 배열은 `Hosts:0`처럼 인덱스가 키가 된다. 환경 변수에서는 `__`(밑줄 두 개)가 콜론으로 치환된다.

Spring으로 보면 `appsettings.{Environment}.json`은 `application-{profile}.yml`, Options 클래스는 `@ConfigurationProperties`, `ValidateDataAnnotations`는 `@Validated`에 가깝다.

### 바인딩

`GetSection("Db").Get<DbOptions>()`가 섹션을 객체로 만들고, `GetValue<int>("Db:Timeout")`는 단일 값을 변환한다. 바인더는 public setter가 있는 프로퍼티만 채우며, 단일 매개변수 생성자를 가진 record도 지원한다.

### Options 인터페이스 세 가지

| 인터페이스 | DI 수명 | 재로드 | 명명 옵션 |
| --- | --- | --- | --- |
| `IOptions<T>` | Singleton | 없음 | 미지원 |
| `IOptionsSnapshot<T>` | Scoped | 스코프마다 재계산 | 지원 |
| `IOptionsMonitor<T>` | Singleton | `CurrentValue`·`OnChange` | 지원 |

부팅 후 바뀌지 않는 설정은 `IOptions<T>`, 요청 단위 일관성이 필요하면 `IOptionsSnapshot<T>`, 싱글턴이 최신 값을 봐야 하면 `IOptionsMonitor<T>`를 쓴다. 재로드는 파일 프로바이더에서만 일어난다.

### 검증

`AddOptions<T>().BindConfiguration(section).ValidateDataAnnotations().Validate(predicate, message)` 체인으로 규칙을 붙인다. 기본 검증은 `Value`를 처음 읽는 요청에서 `OptionsValidationException`으로 터지고, `ValidateOnStart()`를 붙이면 호스트 시작 시 검증한다. DataAnnotations는 최상위 프로퍼티만 보므로 중첩 객체에는 `[ValidateObjectMembers]`, 컬렉션에는 `[ValidateEnumeratedItems]`가 필요하다.

### 비밀 관리

개발 비밀은 Secret Manager가 맡는다. `dotnet user-secrets init`이 csproj에 `UserSecretsId`를 넣고, 값은 프로젝트 트리 밖 `~/.microsoft/usersecrets/<id>/secrets.json`에 평문으로 저장되며 Development에서만 로드된다. 운영 비밀은 환경 변수나 Azure Key Vault 프로바이더로 주입하고, 어느 소스든 읽는 코드는 같다.

## 코드

`appsettings.json`의 섹션을 Options 클래스에 바인딩하고 검증을 부팅 시점에 실행하도록 등록한다.

```csharp
// appsettings.json
// { "Db": { "ConnectionString": "", "Timeout": 30, "Replicas": ["r1", "r2"] } }

using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

public sealed class DbOptions
{
    public const string Section = "Db";

    [Required, MinLength(1)]
    public string ConnectionString { get; set; } = "";

    [Range(1, 300)]
    public int Timeout { get; set; } = 30;

    public List<string> Replicas { get; set; } = [];
}

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddOptions<DbOptions>()
    .BindConfiguration(DbOptions.Section)
    .ValidateDataAnnotations()
    .Validate(o => o.Replicas.Count <= 5, "Replicas must be 5 or fewer.")
    .ValidateOnStart();

var app = builder.Build();
app.MapGet("/db", (IOptions<DbOptions> db) => new { db.Value.Timeout, db.Value.Replicas });
app.Run();
```

싱글턴은 `IOptionsMonitor<T>`로 최신 값을, 스코프 서비스는 `IOptionsSnapshot<T>`로 요청 동안 고정된 값을 읽는다.

```csharp
public sealed class ConnectionPool(IOptionsMonitor<DbOptions> monitor) : IDisposable
{
    private readonly IDisposable? _sub = monitor.OnChange(o =>
        Console.WriteLine($"Timeout changed to {o.Timeout}"));

    public int CurrentTimeout => monitor.CurrentValue.Timeout;
    public void Dispose() => _sub?.Dispose();
}

public sealed class OrderService(IOptionsSnapshot<DbOptions> snapshot)
{
    // 한 요청 안에서는 같은 인스턴스를 본다.
    public int Timeout => snapshot.Value.Timeout;
}

builder.Services.AddSingleton<ConnectionPool>();
builder.Services.AddScoped<OrderService>();
```

개발 비밀은 User Secrets에, 운영 비밀은 환경 변수에 둔다.

```bash
# 개발: 프로젝트 디렉터리에서 실행. csproj에 UserSecretsId가 추가된다.
dotnet user-secrets init
dotnet user-secrets set "Db:ConnectionString" "Host=localhost;Password=dev-only"
dotnet user-secrets list

# 운영: 콜론 대신 __ 를 쓴다. 배열 원소도 인덱스로 덮어쓴다.
export Db__ConnectionString="Host=prod-db;Password=..."
export Db__Replicas__0="prod-r1"
```

## 실무에서 걸리는 지점

- **Scoped 옵션을 싱글턴에 넣는 실수.** ==`IOptionsSnapshot<T>`를 싱글턴 생성자에 주입하면 Development에서는 DI 스코프 검증 예외로 부팅이 실패하고, 검증이 꺼진 운영에서는 최초 값이 영원히 고정된다.==
- **컨테이너에서 리로드가 오지 않는 문제.** ==Docker 볼륨·네트워크 공유에서는 파일 변경 알림이 누락될 수 있으므로 `DOTNET_USE_POLLING_FILE_WATCHER=1`을 설정해 4초 주기 폴링으로 전환해야 한다.==
- **환경 변수로 배열 덮어쓰기.** ==환경 변수로 배열을 덮어쓰면 인덱스가 겹치는 원소만 교체되고 JSON에 남은 나머지 원소는 그대로 합쳐진다.== 원소 수를 줄이려면 JSON 쪽을 비워야 한다.
- **비밀이 저장소로 새는 경로.** `appsettings.Development.json`은 커밋 대상이므로 여기에 비밀을 넣으면 User Secrets를 쓰는 의미가 없다. 섹션 이름과 클래스 이름은 무관하므로 `nameof(DbOptions)`로 찾았는데 JSON 키가 `Db`이면 예외 없이 빈 객체가 바인딩된다.

## 관련 글

- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
