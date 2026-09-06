---
title: "async/await와 Task — 비동기 모델과 취소"
series: dotnet
part: "기초"
order: 4
summary: "Task와 await가 스레드를 점유하지 않고 I/O를 기다리는 원리와 CancellationToken으로 작업을 협조적으로 멈추는 방법"
tags: [async/await, Task, CancellationToken, ValueTask, Thread Pool]
sources: [https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/, https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-scenarios, https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads]
updated: 2026-09-06
---

웹 서버가 요청 하나를 처리하는 동안 DB 응답이나 외부 HTTP 응답을 기다리는 시간은 CPU를 쓰는 시간보다 훨씬 길다. 동기 코드에서는 그 대기 시간 동안 스레드가 점유되고, 동시 요청이 스레드 풀 크기를 넘는 순간 나머지 요청은 큐에서 밀린다. ASP.NET Core는 요청당 스레드를 고정 배정하지 않고 풀 스레드를 요청 사이에서 공유하므로, 대기 중에 스레드를 붙잡는 코드 한 곳이 서버 전체 처리량을 깎는다. `async`/`await`는 이 대기를 스레드 없이 표현하는 언어 기능이고, `CancellationToken`은 필요 없어진 작업을 멈추는 표준 수단이다.

## 핵심 개념

`Task`는 아직 끝나지 않았을 수 있는 작업 한 건을 나타내고, 결과가 있으면 `Task<T>`를 쓴다. Java의 `CompletableFuture`에 해당하지만 `thenApply` 체인 대신 언어가 이어 쓰기를 지원한다. `async` 한정자가 붙은 메서드를 컴파일러는 상태 머신으로 변환하고, `await` 지점에서 대상 작업이 아직 완료되지 않았으면 현재 스레드를 호출자에게 돌려준다. 작업이 완료되면 남은 코드가 이어서 실행되며, 이때 스레드는 원래 스레드와 다를 수 있다.

I/O 바운드 작업과 CPU 바운드 작업은 쓰는 방법이 다르다. DB 조회·HTTP 호출·파일 읽기는 `*Async` 메서드를 그대로 `await`하고 `Task.Run`을 끼우지 않는다. 완료 통지가 올 때까지 어떤 스레드도 소비하지 않기 때문이다. 무거운 계산은 `Task.Run`으로 스레드 풀에 넘겨야 호출 스레드가 풀려나지만, 서버에서는 요청 스레드가 이미 풀 스레드이므로 처리량이 늘지는 않는다.

여러 작업을 동시에 돌리려면 `Task`를 먼저 받아 두고 `Task.WhenAll`(전부 완료)이나 `Task.WhenAny`(하나 완료)로 모아서 `await`한다. 작업 안에서 던져진 예외는 그 `Task`에 저장되고 `await`하는 순간 다시 던져진다. `Task.Exception`은 `AggregateException`이지만 `await`는 첫 번째 내부 예외를 풀어서 던지므로 동기 코드와 같은 `try`/`catch`로 처리한다. 대부분 동기적으로 완료되는 핫 패스 메서드는 `ValueTask<T>`로 힙 할당을 피할 수 있으나 한 번만 `await`할 수 있다.

취소는 협조적이다. `CancellationTokenSource`가 요청 주체이고 여기서 꺼낸 `CancellationToken`(값 타입)을 작업마다 인자로 전달한다. 소스에서 `Cancel()`을 부르면 토큰의 `IsCancellationRequested`가 `true`가 되고, 각 작업이 이를 확인해 스스로 멈춘다. 루프에서는 폴링하고, `ThrowIfCancellationRequested()`로 `OperationCanceledException`을 던져 상위에 알리며, 블로킹 API에는 `Register` 콜백으로 깨운다. `CancelAfter`는 타임아웃을, `CreateLinkedTokenSource`는 외부 토큰과 내부 토큰을 하나로 묶는다. Java에서는 `Thread.interrupt()`가 가장 가깝지만 토큰은 스레드가 아니라 작업 단위에 묶인다. ASP.NET Core는 엔드포인트 매개변수의 `CancellationToken`을 `HttpContext.RequestAborted`에 바인딩하므로 클라이언트가 연결을 끊으면 취소가 자동 전파된다.

## 코드

엔드포인트가 받은 토큰을 EF Core 쿼리와 HTTP 호출에 끝까지 전달하고, 독립적인 두 작업을 동시에 시작한 뒤 `Task.WhenAll`로 모은다.

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopDbContext>(o => o.UseNpgsql(builder.Configuration.GetConnectionString("Shop")));
builder.Services.AddHttpClient<PricingClient>();
var app = builder.Build();

app.MapGet("/orders/{id:int}", async (int id, ShopDbContext db, PricingClient pricing, CancellationToken ct) =>
{
    var order = await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id, ct);
    if (order is null) return Results.NotFound();

    var priceTask = pricing.GetPriceAsync(order.ProductId, ct);
    var stockTask = pricing.GetStockAsync(order.ProductId, ct);
    await Task.WhenAll(priceTask, stockTask);

    return Results.Ok(new { order.Id, Price = priceTask.Result, Stock = stockTask.Result });
});

app.Run();
```

호출자 토큰에 타임아웃을 얹어 링크 토큰을 만들고, 취소가 어디서 왔는지 구분해 응답을 나눈다.

```csharp
public sealed class PricingClient(HttpClient http)
{
    public async Task<decimal> GetPriceAsync(int productId, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            return await http.GetFromJsonAsync<decimal>($"/prices/{productId}", timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"pricing {productId} exceeded 3s");
        }
    }

    public Task<int> GetStockAsync(int productId, CancellationToken ct)
        => http.GetFromJsonAsync<int>($"/stock/{productId}", ct);
}
```

## 실무에서 걸리는 지점

- 동기 대기. `.Result`나 `.Wait()`로 `Task`를 기다리면 그 스레드는 완료까지 묶인다. ==부하가 몰릴 때 스레드 풀이 고갈되어 완료 콜백이 실행될 스레드조차 없어지는 방식으로 서버가 멈추므로, 호출 경로 전체를 `async`로 올려야 한다.== 불가피하면 예외를 감싸지 않는 `GetAwaiter().GetResult()`를 쓴다.
- `async void`. 이벤트 핸들러 외에는 쓰지 않는다. 호출자가 완료를 기다릴 수 없고, 안에서 던진 예외는 `catch`에 잡히지 않은 채 프로세스를 종료시킨다.
- DbContext 동시 사용. ==같은 `DbContext` 인스턴스로 두 쿼리를 `Task.WhenAll`에 넣으면 `InvalidOperationException`이 난다.== EF Core는 컨텍스트당 한 번에 한 작업만 허용하므로 순차로 `await`하거나 컨텍스트를 분리한다.
- LINQ 지연 실행. `ids.Select(id => FetchAsync(id))`는 열거될 때마다 작업을 새로 시작한다. `Task.WhenAll`에 넘기기 전에 `ToArray()`나 `ToList()`로 태스크를 고정한다.
- 토큰 누락과 소스 수명. 중간 계층 하나가 토큰을 빠뜨리면 클라이언트가 떠난 뒤에도 DB 쿼리가 끝까지 돈다. ==`CancellationTokenSource`는 `IDisposable`이라 `CancelAfter`를 쓴 소스를 해제하지 않으면 타이머가 남고, 한 번 취소된 토큰은 되돌릴 수 없어 재사용도 안 된다.== ASP.NET Core에는 `SynchronizationContext`가 없어 `ConfigureAwait(false)`는 라이브러리 코드에만 의미가 있다.

## 관련 글

- [C# 핵심 — record·패턴 매칭·nullable·LINQ](/notes/dotnet/csharp-essentials/)
- [EF Core 성능·트랜잭션·동시성 — 추적·N+1·낙관적 동시성](/notes/dotnet/ef-core-performance/)
- [HttpClient — IHttpClientFactory와 복원력 파이프라인](/notes/dotnet/httpclient-resilience/)
