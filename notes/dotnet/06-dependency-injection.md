---
title: "의존성 주입 — 수명 주기·등록·키 서비스"
series: dotnet
part: "웹 API"
order: 6
summary: "Transient·Scoped·Singleton 수명과 등록 방식, 키 서비스, 스코프 검증으로 포획 의존성을 막는 기준"
tags: [Dependency Injection, IServiceCollection, Scoped, Keyed Services, "[FromKeyedServices]"]
sources: [https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/dependency-injection, https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines]
updated: 2026-09-06
---

클래스가 협력 객체를 `new`로 직접 만들면 구현을 바꿀 때 사용하는 쪽을 고쳐야 하고, 테스트에서 가짜 구현을 끼울 자리가 없다. 웹 서버에서는 `DbContext`처럼 요청마다 만들고 끝나면 정리해야 하는 객체의 생성·폐기 시점을 코드마다 제각기 관리하게 되어 연결이 새거나 다른 요청의 상태가 섞인다. .NET은 등록·해석·폐기를 내장 DI 컨테이너에 맡기고, 사용하는 쪽은 생성자 매개변수로 인터페이스만 받는다.

## 핵심 개념

서비스를 `IServiceCollection`에 등록하면 `builder.Build()`가 `IServiceProvider`(컨테이너)를 만들고, 컨테이너가 생성자 매개변수 타입을 보고 의존성 그래프를 재귀적으로 해석한다. `WebApplication.CreateBuilder(args)`가 프레임워크 서비스를 미리 등록하므로 `ILogger<T>`·`IOptions<T>`는 별도 등록 없이 주입된다. Spring으로 치면 등록 코드가 `@Configuration`의 `@Bean`, `IServiceProvider`가 `ApplicationContext`에 해당한다. 기본 컨테이너는 컴포넌트 스캔과 필드 주입이 없고 public 생성자 주입만 지원한다.

수명 주기는 세 가지이며, Spring과 달리 등록마다 수명을 명시한다.

| 수명 | 인스턴스 생성 | 폐기 시점 | 전형적 용도 |
|---|---|---|---|
| Transient | 요청받을 때마다 새로 | 해석된 스코프 종료 시 | 상태 없는 가벼운 서비스 |
| Scoped | 스코프(HTTP 요청)당 하나 | 스코프 종료 시 | `DbContext` |
| Singleton | 앱 전체에 하나 | 컨테이너 폐기 시 | 캐시, 비싼 클라이언트 |

수명 조합에서 가장 흔한 사고가 포획 의존성(captive dependency)이다. Singleton이 Scoped를 생성자로 받으면 첫 요청의 인스턴스가 앱이 끝날 때까지 붙잡힌다. ==개발 환경에서는 `CreateBuilder`가 `ValidateScopes`와 `ValidateOnBuild`를 켜서 이 조합을 시작 시점에 예외로 잡지만, 운영 환경 기본값은 꺼져 있어서 하나의 `DbContext`를 모든 요청이 조용히 공유하게 된다.== 미들웨어의 Scoped 의존성을 생성자가 아니라 `InvokeAsync` 매개변수로 받는 것도 같은 이유다.

등록 API는 `AddTransient`·`AddScoped`·`AddSingleton`이 기본이고, 각각 타입 쌍·팩터리 람다·인스턴스를 받는 오버로드가 있다. 같은 서비스 타입을 여러 번 등록하면 단일 해석은 마지막 등록을, `IEnumerable<T>`는 등록 순서대로 전부 돌려준다. `TryAdd*` 계열은 이미 등록된 타입을 덮어쓰지 않는다.

키 서비스(keyed services)는 같은 인터페이스의 구현을 키로 구분해 등록·해석한다. `AddKeyedScoped`류로 등록하고 `[FromKeyedServices("card")]` 특성으로 받는다. Spring의 `@Qualifier`에 해당한다. 키는 `Equals`를 구현한 어떤 객체든 되고, `KeyedService.AnyKey`로 등록하면 명시적 키가 없는 요청의 폴백이 된다.

## 코드

Program.cs의 수명별 등록과 키 서비스 해석. 키가 요청 경로에서 결정되면 `GetRequiredKeyedService`로 꺼낸다.

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<ShopDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Shop")));

builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddTransient<IReceiptFormatter, ReceiptFormatter>();

builder.Services.AddKeyedScoped<IPaymentGateway, CardGateway>("card");
builder.Services.AddKeyedScoped<IPaymentGateway, BankTransferGateway>("bank");

builder.Services.AddHostedService<OrderExpiryWorker>();

var app = builder.Build();

app.MapPost("/orders/card", async (
    OrderRequest req,
    IOrderService orders,
    [FromKeyedServices("card")] IPaymentGateway gateway) =>
{
    var id = await orders.PlaceAsync(req, gateway);
    return Results.Created($"/orders/{id}", new { id });
});

app.MapPost("/orders/{method}", async (
    string method,
    OrderRequest req,
    IOrderService orders,
    IServiceProvider sp) =>
{
    var gateway = sp.GetRequiredKeyedService<IPaymentGateway>(method);
    var id = await orders.PlaceAsync(req, gateway);
    return Results.Created($"/orders/{id}", new { id });
});

app.Run();
```

서비스는 주 생성자로 의존성을 받는다. `ShopDbContext`가 Scoped이므로 `OrderService`도 Scoped여야 한다.

```csharp
public sealed class OrderService(
    ShopDbContext db,
    IClock clock,
    ILogger<OrderService> logger) : IOrderService
{
    public async Task<Guid> PlaceAsync(OrderRequest req, IPaymentGateway gateway)
    {
        var order = new Order(req.Items, clock.UtcNow);
        await gateway.ChargeAsync(order.Total);
        db.Orders.Add(order);
        await db.SaveChangesAsync();
        logger.LogInformation("Order {OrderId} placed", order.Id);
        return order.Id;
    }
}
```

호스티드 서비스는 Singleton이라 Scoped를 생성자로 받을 수 없다. `IServiceScopeFactory`로 반복마다 스코프를 만들고 끝나면 폐기한다.

```csharp
public sealed class OrderExpiryWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderExpiryWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ShopDbContext>();
            var cutoff = DateTime.UtcNow.AddHours(-1);
            var expired = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending && o.CreatedAt < cutoff)
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Expired),
                    stoppingToken);
            logger.LogInformation("Expired {Count} orders", expired);
        }
    }
}
```

## 실무에서 걸리는 지점

- 스코프는 계층이 없다. 한 스코프에서 해석한 `DbContext`를 다른 스코프의 작업에 넘기면 추적 상태와 폐기 시점이 어긋난다. 작업 단위 하나에 스코프 하나를 대응시킨다.
- ==`IDisposable`을 구현한 Transient를 루트 컨테이너(`app.Services`)에서 직접 해석하면 컨테이너가 폐기를 위해 참조를 붙들고 있어 앱이 끝날 때까지 메모리가 누적된다.== 루트에서 만들어야 한다면 스코프를 열거나 `ActivatorUtilities.CreateInstance`로 컨테이너 밖에서 생성하고 직접 폐기한다.
- `AddSingleton(new Service())`처럼 인스턴스를 넘겨 등록하면 폐기도 컨테이너가 하지 않는다. 반대로 주입받은 의존성을 직접 `Dispose`하면 같은 스코프의 다른 사용자가 폐기된 객체를 쓰게 된다.
- 팩터리 람다 안에서 `Task.Result`로 비동기 결과를 기다리면 교착이 난다. 등록 도중 `BuildServiceProvider()`를 호출하면 컨테이너가 두 벌 생겨 Singleton이 갈라지므로 `IServiceProvider`를 받는 팩터리 오버로드를 쓴다.
- ==.NET 10부터 `GetKeyedService<T>(KeyedService.AnyKey)`로 단일 서비스를 해석하면 `InvalidOperationException`이 발생한다.== 복수 조회 `GetKeyedServices<T>(KeyedService.AnyKey)`만 허용되고, 이 결과에 AnyKey 폴백 자체는 포함되지 않는다.

## 관련 글

- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [구성과 Options 패턴 — appsettings·환경·비밀 관리](/notes/dotnet/configuration-options/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
