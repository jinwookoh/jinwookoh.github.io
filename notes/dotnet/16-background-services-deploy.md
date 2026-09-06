---
title: "백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT"
series: dotnet
part: "운영"
order: 16
summary: "BackgroundService의 시작·종료·예외 규칙과 컨테이너 이미지·Native AOT 발행에서 확인해야 할 기준을 정리한다"
tags: [IHostedService, BackgroundService, Docker, Native AOT, ASP.NET Core]
sources: [https://learn.microsoft.com/en-us/dotnet/core/extensions/workers, https://learn.microsoft.com/en-us/dotnet/core/docker/build-container, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot]
updated: 2026-09-06
---

API 프로세스 안에서 주기 작업이나 큐 소비를 `Task.Run`으로 던져 두면 호스트 종료 시 작업이 잘리고, 예외는 관찰되지 않은 채 사라지며, DI 스코프가 없어 `DbContext` 같은 scoped 서비스를 쓸 수 없다. 배포도 마찬가지다. SDK 이미지를 그대로 런타임에 쓰면 이미지가 수백 MB로 불고 root로 실행되며, JIT 워밍업 때문에 첫 요청이 늦다.

## 핵심 개념

`IHostedService`는 `StartAsync`와 `StopAsync`로 이루어진 수명 주기 계약이다. 호스트는 시작 시 등록 순서대로 `StartAsync`를, 종료 시 역순으로 `StopAsync`를 호출한다. .NET 8부터는 `IHostedLifecycleService`로 앞뒤 단계에도 개입할 수 있다. Spring의 `SmartLifecycle`에 해당하고, `HostOptions.ShutdownTimeout`은 `spring.lifecycle.timeout-per-shutdown-phase`와 같은 역할이다.

`BackgroundService`는 이 계약을 구현한 추상 클래스로, 상속 측은 `ExecuteAsync(CancellationToken)` 하나만 채운다. `StartAsync`가 `ExecuteAsync`를 호출하고 첫 `await`에서 제어가 돌아오면 다음 서비스로 넘어간다. 따라서 ==`ExecuteAsync`가 첫 `await`에 도달하기 전까지 동기적으로 오래 일하면 호스트 시작이 블록되어 요청 수신과 헬스 체크가 모두 지연된다==. `StopAsync`는 토큰을 취소한 뒤 `ExecuteAsync`가 끝나기를 `ShutdownTimeout`(.NET 8부터 기본 30초) 동안 기다린다.

==.NET 6 이후 `ExecuteAsync`에서 잡히지 않은 예외는 로그만 남기는 것이 아니라 호스트 전체를 정지시킨다==. `BackgroundServiceExceptionBehavior`를 `Ignore`로 바꾸면 프로세스는 살아남지만 서비스는 죽은 채 남아 장애가 감지되지 않는다. 루프 한 회차 단위로 예외를 잡는 쪽이 안전하다. 호스팅 서비스는 싱글턴이므로 scoped 서비스는 `IServiceScopeFactory`로 회차마다 스코프를 만들어 꺼낸다.

Worker 템플릿은 `Host.CreateApplicationBuilder`를 쓰고, 웹 앱은 `WebApplication.CreateBuilder`에 `AddHostedService`만 더하면 같은 모델로 동작한다. 컨테이너화는 `sdk:10.0`으로 빌드하고 `aspnet:10.0`으로 실행하는 다단계 Dockerfile이 기본이며, `dotnet publish /t:PublishContainer`로 Dockerfile 없이 이미지를 만들 수도 있다. ==.NET 8 이후 공식 `aspnet` 이미지는 80이 아니라 8080 포트에서 수신하고, `APP_UID`로 비루트 실행을 지원한다==.

Native AOT는 `PublishAot`로 켜며, IL을 네이티브 코드로 미리 컴파일해 런타임 없는 단일 실행 파일을 만든다. 시작 시간·메모리·이미지 크기가 줄지만 리플렉션이 불가능하므로 `System.Text.Json`은 `JsonSerializerContext` 소스 생성기를 통해야 하고, `CreateSlimBuilder`로 HTTPS·HTTP/3·IIS 통합을 뺀다. Minimal API·gRPC·Worker는 지원하지만 MVC·Blazor Server·세션은 지원하지 않는다.

## 코드

미처리 주문을 주기적으로 정리하는 워커다. 회차마다 스코프를 만들어 `DbContext`를 꺼내고, 예외는 회차 단위로 잡는다.

```csharp
public sealed class OrderCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderCleanupWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<ShopDbContext>();

                var expired = DateTimeOffset.UtcNow.AddHours(-1);
                var count = await db.Orders
                    .Where(o => o.Status == OrderStatus.Pending && o.CreatedAt < expired)
                    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Expired),
                                        stoppingToken);

                logger.LogInformation("Expired {Count} orders", count);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order cleanup failed; retrying next tick");
            }
        }
    }
}
```

AOT 발행을 전제로 한 `Program.cs`다. 슬림 빌더와 JSON 소스 생성 컨텍스트, 종료 대기 시간을 설정한다.

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

builder.Services.Configure<HostOptions>(o =>
{
    o.ShutdownTimeout = TimeSpan.FromSeconds(25);
    o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.StopHost;
});

builder.Services.AddDbContext<ShopDbContext>();
builder.Services.AddHostedService<OrderCleanupWorker>();
builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");
app.MapGet("/orders/{id:int}", async (int id, ShopDbContext db) =>
    await db.Orders.FindAsync(id) is { } order
        ? Results.Ok(new OrderDto(order.Id, order.Status.ToString()))
        : Results.NotFound());

app.Run();

public record OrderDto(int Id, string Status);

[JsonSerializable(typeof(OrderDto))]
internal partial class AppJsonContext : JsonSerializerContext;
```

다단계 Dockerfile이다. 최종 이미지는 비루트로 8080에서 실행한다.

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Shop.Api/Shop.Api.csproj Shop.Api/
RUN dotnet restore Shop.Api/Shop.Api.csproj
COPY . .
RUN dotnet publish Shop.Api/Shop.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

## 실무에서 걸리는 지점

- ==Kubernetes의 `terminationGracePeriodSeconds` 기본값도 30초라서 `ShutdownTimeout`을 그대로 두면 정리 작업이 끝나기 전에 SIGKILL이 먼저 온다==. `ShutdownTimeout`을 몇 초 짧게 잡고, `ENTRYPOINT`는 exec 형식 배열로 써서 셸이 PID 1을 차지해 SIGTERM을 삼키지 않게 한다.
- 복제본이 둘 이상이면 같은 `BackgroundService`가 동시에 돈다. 배치성 작업은 분산 락으로 한 인스턴스만 실행하거나, 큐 소비 모델로 바꿔 중복 실행이 무해하도록 설계한다.
- 취소 토큰을 무시하는 호출이 하나라도 있으면 `StopAsync`는 타임아웃까지 기다렸다가 포기한다. `Task.Delay`·EF Core 쿼리·`HttpClient` 호출에 모두 `stoppingToken`을 넘긴다.
- `PublishAot`를 켜도 `dotnet run`은 JIT로 동작하므로 로컬에서 잘 돌던 코드가 발행 후에만 실패한다. 리플렉션 기반 라이브러리, `JsonSerializerContext`에 없는 응답 타입, 정규식 라우트 제약이 대표 원인이다. CI에서 AOT 경고를 빌드 실패로 취급한다.
- AOT 발행은 타깃 OS에서만 가능하다. Linux 이미지는 빌드 단계 `sdk` 이미지에 `clang`과 `zlib1g-dev`를 설치해야 하며, 최종 이미지는 `aspnet` 대신 `runtime-deps`로 바꿔야 크기 이점을 얻는다.

## 관련 글

- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
- [로깅과 관측성 — ILogger·OpenTelemetry·헬스 체크](/notes/dotnet/logging-observability/)
