---
title: ".NET이란 무엇인가 — Framework·Core·통합 .NET과 SDK·런타임"
series: dotnet
part: "기초"
order: 1
summary: "Framework·Core·통합 .NET의 계보와 SDK·런타임의 역할을 구분하고, LTS 기준으로 버전을 고르는 법을 정리한다"
tags: [.NET 10, .NET Framework, .NET Core, SDK, Runtime]
sources: [https://learn.microsoft.com/en-us/dotnet/core/introduction, https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview, https://learn.microsoft.com/en-us/dotnet/core/releases-and-support]
updated: 2026-09-06
---

.NET Framework 4.8, .NET Core 3.1, .NET 5, .NET 10이 모두 "닷넷"으로 불리고, 검색하면 `Startup.cs` 시대의 글과 `Program.cs` 한 파일로 끝나는 글이 섞여 나온다. 어느 쪽이 현재 기준인지 모르면 Windows 전용 API를 새 프로젝트에 넣거나, 지원이 끝난 런타임을 컨테이너 베이스 이미지로 고르게 된다. SDK와 런타임의 차이를 모르면 운영 서버에 SDK까지 설치하는 일도 생긴다.

## 핵심 개념

.NET은 C#을 중심 언어로 하는 크로스 플랫폼 개발 플랫폼이다. 구성 요소는 코드를 실행하는 런타임(CoreCLR), 기본 라이브러리(BCL), 소스를 IL로 바꾸는 컴파일러(Roslyn), 빌드·배포를 맡는 SDK와 CLI, 그 위의 ASP.NET Core 같은 앱 스택으로 나뉜다. Java에 대응시키면 런타임은 JVM, BCL은 java.base, SDK는 JDK + Gradle, ASP.NET Core는 Spring Boot, NuGet은 Maven Central에 해당한다.

구현체는 셋이다. .NET Framework는 2002년부터 이어진 원조로 Windows 전용이며 4.8 이후 유지보수만 받는다. Mono는 이를 크로스 플랫폼으로 재구현한 커뮤니티 프로젝트다. .NET Core는 2016년 클라우드 환경을 겨냥해 다시 만든 오픈소스 구현체이고, 3.1 다음 버전에서 "Core"를 떼고 .NET 5가 되면서 유일한 주류가 됐다. 현재의 .NET 8·9·10은 모두 이 계보다. 따라서 ASP.NET Core·EF Core는 최신 스택이고, 접두사 없는 ASP.NET·Entity Framework 6는 .NET Framework 시대의 스택이다.

| 구분 | .NET Framework | .NET (Core 계보) |
|---|---|---|
| 플랫폼 | Windows 전용 | Windows·Linux·macOS, x64·Arm64 |
| 상태 | 4.8.x 유지보수만 | 매년 11월 새 메이저 릴리스 |
| 웹 스택 | ASP.NET (System.Web) | ASP.NET Core |
| 설치 | OS 컴포넌트, 머신당 하나 | 버전별 side-by-side, 자체 포함 배포 가능 |

SDK와 런타임은 별도로 설치된다. 런타임은 앱 실행에 필요한 최소 구성이고, SDK는 여기에 컴파일러·MSBuild·NuGet·`dotnet` CLI를 더한 것이다. SDK 버전은 세 번째 자리를 백 단위 feature band로 나누며, 같은 밴드의 패치는 이전 것을 대체하고 다른 밴드는 나란히 남는다. 프로젝트의 `TargetFramework`는 런타임 버전을 가리키고, `global.json`으로 SDK 버전을 고정한다. 앱은 지정한 major.minor 런타임에 묶이고 패치 버전만 자동으로 최신을 따른다. ==.NET 8을 타깃한 앱은 머신에 .NET 10만 설치돼 있으면 기본 설정에서 실행되지 않는다==. 메이저 버전으로 자동 롤포워드하지 않기 때문이다.

지원 정책은 두 트랙이 번갈아 나온다. 짝수 버전은 LTS로 최소 3년, 홀수 버전은 STS로 2년이다. .NET 10(LTS)은 2028년 11월까지, .NET 8과 .NET 9는 2026년 11월까지 지원된다. 패치는 매월 둘째 화요일에 나오고, 다음 패치가 나오면 이전 패치는 지원 대상에서 빠진다. ==SDK는 항상 최신을 설치해도 된다. 10.0.x SDK가 net8.0 타깃도 빌드하므로, 런타임 타깃과 SDK 버전을 맞출 필요가 없다==.

.NET 10에는 C# 14(`field` 키워드, `extension` 블록, `?.` 조건부 대입)가 함께 나왔고, SDK에는 csproj 없이 `dotnet run app.cs`로 실행하는 파일 기반 앱이 정식으로 들어갔다.

## 코드

설치 상태를 확인하는 명령이다. SDK와 런타임 목록이 따로 나온다.

```bash
dotnet --version          # 현재 디렉터리에서 선택되는 SDK 버전
dotnet --list-sdks        # 10.0.100 [/usr/share/dotnet/sdk]
dotnet --list-runtimes    # Microsoft.AspNetCore.App 10.0.0, Microsoft.NETCore.App 10.0.0 ...
```

.NET 10 SDK의 파일 기반 앱이다. `#:sdk` 지시문으로 웹 SDK를 고르고 `dotnet run app.cs`로 실행한다.

```csharp
#:sdk Microsoft.NET.Sdk.Web

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => new
{
    Runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    Os = System.Runtime.InteropServices.RuntimeInformation.OSDescription
});

app.Run();
```

정식 프로젝트의 csproj다. `TargetFramework`가 런타임 버전을 가리키고, `PublishAot`를 켜면 런타임 없이 실행되는 네이티브 바이너리가 나온다.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

## 실무에서 걸리는 지점

- 검색 결과의 연식을 먼저 본다. `Startup.cs`의 `ConfigureServices`·`Configure`, `IWebHostBuilder`, `Newtonsoft.Json` 기본 직렬화는 .NET Core 3.x 이하 방식이다. 지금 템플릿은 `Program.cs` 최상위 문 + `WebApplication.CreateBuilder` + `System.Text.Json`이다.
- 컨테이너 빌드 스테이지는 `dotnet/sdk:10.0`, 실행 스테이지는 `dotnet/aspnet:10.0`을 쓴다. SDK 이미지로 운영하면 이미지가 수백 MB 커지고 컴파일러까지 노출된다.
- STS 버전을 운영에 올리면 2년 뒤 강제 업그레이드가 온다. 지금 시작하는 서비스는 .NET 10을 고르고, `CheckSdkVulnerabilities`를 `true`로 두면 지원 종료된 SDK로 빌드할 때 NETSDK1239 경고가 뜬다.
- Native AOT는 리플렉션 기반 코드와 충돌한다. `System.Text.Json`은 소스 제너레이터 컨텍스트가 필요하고, 타입을 동적 로드하는 라이브러리는 트리밍 경고를 낸다. ==`PublishAot`는 프로젝트 초기에 켜서 경고를 확인해야 하며, 나중에 켜면 의존성 대부분을 갈아엎게 된다==.

## 관련 글

- [프로젝트 구조와 CLI — csproj·SDK·NuGet·솔루션](/notes/dotnet/project-sdk-cli/)
- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
