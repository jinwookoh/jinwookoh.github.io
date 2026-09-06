---
title: "프로젝트 구조와 CLI — csproj·SDK·NuGet·솔루션"
series: dotnet
part: "기초"
order: 3
summary: "SDK 스타일 csproj·global.json·NuGet 중앙 버전 관리·slnx 솔루션이 .NET 10 빌드를 어떻게 구성하는지 정리한다"
tags: [.NET SDK, csproj, MSBuild, NuGet, "dotnet CLI"]
sources: [https://learn.microsoft.com/en-us/dotnet/core/tools/, https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview, https://learn.microsoft.com/en-us/nuget/consume-packages/overview-and-workflow]
updated: 2026-09-06
---


빌드 정의가 프로젝트마다 제각각이면 CI와 개발 머신의 결과가 달라지고, 같은 라이브러리가 프로젝트마다 다른 버전으로 박힌다. .NET은 SDK 스타일 프로젝트 파일, `dotnet` CLI, NuGet, 솔루션으로 이를 표준화하며, 넷이 맞물리는 방식을 알아야 빌드 오류와 의존성 충돌을 읽어 낼 수 있다.

## 핵심 개념

### SDK 스타일 프로젝트 파일

`.csproj`는 MSBuild XML이다. 루트 `<Project Sdk="Microsoft.NET.Sdk">`의 `Sdk` 속성이 컴파일·패킹·게시 타깃 묶음을 지정하고 MSBuild가 이를 암묵적으로 import하므로 파일에는 차이점만 남는다. 웹은 `Microsoft.NET.Sdk.Web`, 워커는 `Microsoft.NET.Sdk.Worker`를 쓴다.

SDK는 `Compile`(`**/*.cs`)·`EmbeddedResource`(`**/*.resx`)·`None`(나머지)을 글로브로 자동 수집한다. ==이미 잡힌 `.cs`를 `<Compile Include>`로 다시 선언하면 같은 파일이 두 번 포함되어 NETSDK1022 오류가 난다.== 조정은 `Remove`·`Update`로 한다. Spring 관점에서 `.csproj`는 `build.gradle`, `Sdk` 속성은 Spring Boot Gradle 플러그인에 해당한다.

### Directory.Build.props와 global.json

`Directory.Build.props`는 하위 프로젝트 전체에 자동 import되어 공통 속성을 모은다. `UseArtifactsOutput`을 켜면 출력이 루트 `artifacts/`로 모인다.

`global.json`은 런타임 타깃과 별개로 SDK 버전을 고른다. 없으면 설치된 최신 SDK를 쓰고, 있으면 `sdk.version`과 `rollForward`로 범위를 정한다. ==`rollForward`를 생략하면 기본값 `patch`가 적용되어, 지정한 feature band(10.0.1xx)가 없는 머신에서는 상위 밴드가 있어도 실패한다.== CI에서는 `latestFeature`처럼 범위를 명시한다.

### NuGet

패키지는 `<PackageReference>`로 기록되고 저장소에는 참조만 커밋된다. `restore`가 전역 패키지 폴더에 내려받아 `obj/project.assets.json`에 그래프를 쓰며, `build`·`run`·`publish`는 restore를 먼저 수행한다.

프로젝트가 많으면 Central Package Management(CPM)를 쓴다. 루트 `Directory.Packages.props`에 `ManagePackageVersionsCentrally`를 켜고 `<PackageVersion>`으로 버전을 모으면 각 `<PackageReference>`에서는 `Version`을 뺀다. 예외는 `VersionOverride`로 둔다. Maven `dependencyManagement`에 대응한다.

### 솔루션과 CLI

솔루션은 여러 프로젝트를 묶는 빌드·테스트 단위다. .NET 10 SDK의 `dotnet new sln`은 XML 기반 `.slnx`를 만들고 기존 `.sln`은 `dotnet sln migrate`로 변환한다.

.NET 10 CLI는 `dotnet package add`·`dotnet reference add` 같은 명사 우선 형식을 권장하고, 단일 `.cs`에 `#:package` 지시문을 적어 `dotnet run app.cs`로 실행하는 file-based app을 지원한다.

## 코드

Web SDK 프로젝트 파일. CPM이라 `PackageReference`에 버전이 없다.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" />
    <ProjectReference Include="../Orders.Domain/Orders.Domain.csproj" />
  </ItemGroup>
</Project>
```

루트 `Directory.Packages.props`. 패키지 버전을 여기서 정한다.

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.0" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.0" />
  </ItemGroup>
</Project>
```

솔루션·프로젝트·참조·패키지를 CLI로 연결하는 순서.

```bash
dotnet new sln --name Orders
dotnet new buildprops --use-artifacts
dotnet new packagesprops
dotnet new classlib --output src/Orders.Domain
dotnet new webapi --output src/Orders.Api
dotnet sln add src/Orders.Domain src/Orders.Api
dotnet reference add ../Orders.Domain/Orders.Domain.csproj --project src/Orders.Api
dotnet package add Microsoft.EntityFrameworkCore.Sqlite --project src/Orders.Api
dotnet build && dotnet run --project src/Orders.Api
```

프로젝트 파일 없이 EF Core를 쓰는 file-based app. `dotnet run query.cs`로 실행한다.

```csharp
#:package Microsoft.EntityFrameworkCore.Sqlite@10.0.0
#:property PublishAot=false

using Microsoft.EntityFrameworkCore;

await using var db = new OrdersDb();
await db.Database.EnsureCreatedAsync();
db.Orders.Add(new Order(0, "keyboard", 89_000m));
await db.SaveChangesAsync();

foreach (var order in await db.Orders.AsNoTracking().ToListAsync())
{
    Console.WriteLine($"{order.Id}: {order.Product} {order.Amount:N0}");
}

record Order(int Id, string Product, decimal Amount);

class OrdersDb : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=orders.db");
}
```

## 실무에서 걸리는 지점

- **CPM 파일 탐색 규칙.** ==`Directory.Packages.props`는 프로젝트에서 가장 가까운 파일 하나만 자동 import되고 상위 파일은 무시된다.== 하위 폴더에 두 번째 파일을 두면 루트 버전이 조용히 빠지므로 `GetPathOfFileAbove`로 부모를 import한다.
- **transitive pinning의 다운그레이드.** `CentralPackageTransitivePinningEnabled` 상태에서 의존성이 요구하는 버전보다 낮게 고정하면 NU1109로 restore가 실패한다. 라이브러리를 pack하면 고정된 전이 의존성이 직접 의존성으로 승격된다.
- **여러 패키지 소스와 NU1507.** CPM에서 소스가 둘 이상이면 경고가 나고, 사내 피드와 nuget.org에 같은 ID가 있으면 선택이 보장되지 않는다. package source mapping으로 소스를 묶는다.
- **pruning으로 바뀌는 deps.json.** .NET 10 SDK는 런타임이 제공하는 패키지 참조를 restore에서 잘라내므로 `deps.json`에서 항목이 사라지는 것은 정상이다. 배포 스크립트가 이 파일에 의존하면 `RestoreEnablePackagePruning=false`로 되돌린다.

## 관련 글

- [.NET이란 무엇인가 — Framework·Core·통합 .NET과 SDK·런타임](/notes/dotnet/what-is-dotnet/)
- [구성과 Options 패턴 — appsettings·환경·비밀 관리](/notes/dotnet/configuration-options/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
