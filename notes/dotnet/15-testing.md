---
title: "테스트 — xUnit·WebApplicationFactory 통합 테스트"
series: dotnet
part: "운영"
order: 15
summary: "xUnit v3로 단위 테스트를 쓰고 WebApplicationFactory로 실제 파이프라인을 인메모리에서 검증하는 방법을 정리한다"
tags: [xUnit, WebApplicationFactory, "Microsoft.Testing.Platform", "EF Core", "ASP.NET Core"]
sources: [https://learn.microsoft.com/en-us/dotnet/core/testing/, https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-csharp-with-xunit, https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests]
updated: 2026-09-06
---

서비스 클래스만 단위 테스트하면 라우팅·모델 바인딩·인증 미들웨어처럼 요청이 실제로 통과하는 경로는 검증되지 않아, `[Authorize]`가 빠졌거나 라우트 템플릿이 틀린 상황은 배포 후 첫 요청에서야 드러난다. 반대로 Kestrel을 띄우고 실제 DB에 붙는 테스트는 느리고 환경에 묶인다. `WebApplicationFactory`는 실제 `Program.cs`를 그대로 부팅하되 소켓 없이 인메모리 `TestServer`로 요청을 흘려보내 이 사이를 메운다.

## 핵심 개념

.NET 테스트는 테스트를 발견·실행하는 플랫폼(VSTest, 신형 Microsoft.Testing.Platform=MTP)과 `[Fact]` 같은 특성·Assert API를 제공하는 프레임워크(xUnit·NUnit·MSTest)로 나뉜다. .NET 10 SDK의 `dotnet test`는 기본이 VSTest 모드이고, `global.json`에 `"test": { "runner": "Microsoft.Testing.Platform" }`를 넣으면 MTP 모드가 되어 `--solution`·`--project` 옵션으로 대상을 지정한다.

xUnit은 v3가 주 버전이며 패키지는 `xunit.v3`, 테스트 프로젝트는 자체 진입점을 가진 실행 파일로 빌드된다. `[Fact]`는 단일 테스트, `[Theory]`+`[InlineData]`는 여러 입력으로 돌리는 매개변수 테스트다. 테스트 메서드마다 클래스 인스턴스가 새로 만들어지므로 생성자가 setup, `IAsyncLifetime`이 teardown이다. 비싼 객체를 클래스 안에서 공유하려면 `IClassFixture<T>`, 여러 클래스가 공유하려면 `ICollectionFixture<T>`를 쓴다.

통합 테스트는 `Microsoft.AspNetCore.Mvc.Testing`의 `WebApplicationFactory<Program>`이 담당한다. 진입점 어셈블리로 실제 호스트를 구성하고, `CreateClient()`가 주는 `HttpClient`는 `TestServer`에 직접 연결되어 포트를 열지 않는다. `ConfigureWebHost`로 환경·서비스를 바꾸고, 개별 테스트만 다른 구성이 필요하면 `WithWebHostBuilder`로 파생 팩토리를 만든다. 서비스 교체는 앱 등록이 끝난 뒤 실행되는 `ConfigureTestServices`에서 해야 마지막 등록이 이기는 DI 규칙에 따라 테스트용 구현이 선택된다.

Spring 대응: xUnit ≈ JUnit 5(`[Fact]` ≈ `@Test`, `[Theory]` ≈ `@ParameterizedTest`), `WebApplicationFactory` ≈ `@SpringBootTest`+`MockMvc`, `ConfigureTestServices` ≈ `@TestConfiguration`·`@MockitoBean`.

## 코드

xUnit v3 테스트 프로젝트 설정과 단위 테스트다.

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3" Version="3.*" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.*" />
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.*" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.*" />
    <ProjectReference Include="../Shop.Api/Shop.Api.csproj" />
  </ItemGroup>
</Project>
```

```csharp
public class PriceCalculatorTests
{
    private readonly PriceCalculator _sut = new();

    [Fact]
    public void Discount_IsNotApplied_BelowThreshold()
        => Assert.Equal(9_000m, _sut.Total(9_000m, memberYears: 0));

    [Theory]
    [InlineData(1, 9_500)]
    [InlineData(3, 9_000)]
    [InlineData(10, 8_000)]
    public void Discount_Grows_WithMemberYears(int years, decimal expected)
        => Assert.Equal(expected, _sut.Total(10_000m, years));
}
```

실제 DB 대신 SQLite 인메모리로 `DbContext`를 바꿔 끼우는 커스텀 팩토리다. `Program.cs` 끝에는 `public partial class Program { }`가 있어야 한다.

```csharp
public sealed class ShopApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IDbContextOptionsConfiguration<ShopDbContext>>();
            services.RemoveAll<DbConnection>();
            services.RemoveAll<IHostedService>();

            services.AddSingleton<DbConnection>(_ =>
            {
                var conn = new SqliteConnection("DataSource=:memory:");
                conn.Open();
                return conn;
            });
            services.AddDbContext<ShopDbContext>((sp, options) =>
                options.UseSqlite(sp.GetRequiredService<DbConnection>()));
        });
    }
}

public class OrdersEndpointTests(ShopApiFactory factory)
    : IClassFixture<ShopApiFactory>
{
    [Fact]
    public async Task Post_Order_Returns201_WithLocation()
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ShopDbContext>()
            .Database.EnsureCreatedAsync(TestContext.Current.CancellationToken);

        var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false
        });

        var response = await client.PostAsJsonAsync("/orders",
            new { ProductId = 1, Quantity = 2 },
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.StartsWith("/orders/", response.Headers.Location?.OriginalString);
    }
}
```

인증이 걸린 엔드포인트는 테스트 스킴을 등록해 통과시킨다.

```csharp
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, "tester"), new Claim("scope", "orders:write")],
            "Test");
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), "Test");
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

var client = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
        s.AddAuthentication("Test")
         .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>("Test", _ => { })))
    .CreateClient();
client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Test");
```

## 실무에서 걸리는 지점

- **Program 접근성.** 최상위 문으로 작성된 `Program.cs`는 `internal` 클래스로 컴파일되어 테스트 프로젝트에서 `WebApplicationFactory<Program>`을 참조하면 컴파일 오류가 난다. ==`Program.cs` 마지막 줄에 `public partial class Program { }`를 선언하거나 csproj에 `InternalsVisibleTo`를 추가해야 한다.==
- **SQLite 인메모리 수명.** 연결 문자열만 `:memory:`로 바꾸면 `DbContext`가 연결을 열고 닫을 때마다 데이터가 사라져 두 번째 쿼리부터 테이블이 없다는 오류가 난다. ==`DbConnection`을 미리 `Open()`한 싱글턴으로 등록하고 팩토리가 폐기될 때까지 열어 두어야 한다.== EF Core 인메모리 공급자는 관계형 제약을 검증하지 않아 SQLite가 권장된다.
- **기본 환경이 Development다.** 환경을 지정하지 않으면 `Development`로 부팅해 `appsettings.Development.json`과 개발자 예외 페이지를 쓰므로 `IsDevelopment()` 분기가 운영과 달라진다. `UseEnvironment`로 명시한다.
- **클래스 간 병렬 실행.** ==xUnit은 테스트 클래스 단위로 병렬 실행하므로 `IClassFixture` 팩토리가 클래스마다 따로 뜨고, 같은 외부 리소스를 쓰면 데이터가 뒤섞인다.== 팩토리를 한 번만 띄우려면 `ICollectionFixture`로 묶고, 순차가 필요하면 `DisableParallelization = true`를 준다.
- **호스티드 서비스와 외부 호출.** 팩토리는 실제 호스트를 시작하므로 `BackgroundService`도 같이 돌아 큐를 소비하거나 외부 API를 친다. `IHostedService`를 제거하고, `IHttpClientFactory`의 외부 호출은 `ConfigurePrimaryHttpMessageHandler`로 가짜 핸들러를 넣는다. `TestServer`는 인바운드만 인메모리다.

## 관련 글

- [EF Core 기본 — DbContext·마이그레이션·LINQ 쿼리](/notes/dotnet/ef-core-basics/)
- [인증과 인가 — JWT Bearer·정책·Identity](/notes/dotnet/authentication-authorization/)
- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
