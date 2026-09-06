---
title: "HttpClient — IHttpClientFactory와 복원력 파이프라인"
series: dotnet
part: "데이터"
order: 13
summary: "HttpClient를 매번 new 하지도 싱글턴으로 붙들지도 않고, 팩터리와 표준 복원력 핸들러로 외부 호출을 안전하게 만드는 법"
tags: [HttpClient, IHttpClientFactory, Polly, "Microsoft.Extensions.Http.Resilience", DelegatingHandler]
sources: [https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory, https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience, https://learn.microsoft.com/en-us/dotnet/core/resilience/]
updated: 2026-09-06
---

`HttpClient`를 요청마다 `new` 해서 `using`으로 감싸면 닫힌 소켓이 TIME_WAIT 상태로 쌓여 포트가 고갈된다. 반대로 하나를 정적으로 두고 프로세스 내내 쓰면 열린 연결이 유지돼 DNS 변경을 반영하지 못한다. `IHttpClientFactory`는 핸들러 수명을 대신 관리하고, `Microsoft.Extensions.Http.Resilience`는 그 위에 Polly 기반 복원력 파이프라인을 얹는다.

## 핵심 개념

### 팩터리가 관리하는 것은 핸들러다

`CreateClient()`는 매번 새 `HttpClient`를 반환하지만, 실제 소켓을 쥔 `HttpMessageHandler`는 클라이언트 이름별로 캐시되어 재사용된다. 핸들러 수명은 기본 2분이며 `SetHandlerLifetime`으로 조정한다. 만료된 핸들러는 쓰는 클라이언트가 사라질 때 폐기되므로, 팩터리가 만든 `HttpClient`는 `Dispose` 해도 소켓이 고갈되지 않는다. ==팩터리가 만든 HttpClient는 짧게 쓰고 버리는 것이 전제이고, 필드에 오래 붙잡아 두면 핸들러 교체가 일어나지 않아 DNS 변경을 다시 놓친다.==

소비 패턴은 셋이다. 기본은 `AddHttpClient()` 후 `IHttpClientFactory.CreateClient()`로 얻고, 명명 클라이언트는 `AddHttpClient("name", cfg)`로 설정을 이름에 묶어 `CreateClient("name")`으로 얻으며, 형식화 클라이언트는 `AddHttpClient<TClient>(cfg)`로 등록해 생성자에서 `HttpClient`를 받는 `TClient`를 transient로 주입받는다. Spring으로 치면 형식화 클라이언트는 `RestClient`를 감싼 `@Service` 하나에 해당한다.

### DelegatingHandler 파이프라인

`AddHttpMessageHandler<T>`로 등록한 `DelegatingHandler`는 나가는 요청의 미들웨어다. 등록 순서대로 바깥에서 안쪽으로 감싸이고, 맨 안쪽의 primary handler(`HttpClientHandler` 또는 `SocketsHttpHandler`)가 실제 전송을 맡는다. Spring의 `ClientHttpRequestInterceptor` 체인과 같은 자리다. 복원력 핸들러도 이 층 가운데 하나다.

### 표준 복원력 핸들러

`AddStandardResilienceHandler()`는 바깥부터 다섯 전략을 순서대로 쌓는다.

1. 속도 제한 — 동시 요청 1,000, 큐 0
2. 전체 타임아웃 — 재시도를 포함한 총 30초
3. 재시도 — 최대 3회, 지수 백오프, 지터, 기본 지연 2초
4. 서킷 브레이커 — 실패율 10%, 최소 처리량 100, 샘플링 30초, 차단 5초
5. 시도별 타임아웃 — 10초

재시도와 서킷 브레이커는 5xx·408·429 응답과 `HttpRequestException`·`TimeoutRejectedException`을 실패로 본다. 더 세밀한 제어가 필요하면 `AddResilienceHandler("name", builder => ...)`로 Polly 파이프라인을 직접 조립한다. Resilience4j의 `@Retry`·`@CircuitBreaker`를 메서드가 아니라 클라이언트 등록 단위로 붙이는 셈이다.

## 코드

형식화 클라이언트에 표준 핸들러를 붙이고, 비멱등 메서드는 재시도에서 제외한다.

```csharp
using Microsoft.Extensions.Http.Resilience;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient<CatalogClient>(client =>
    {
        client.BaseAddress = new Uri(builder.Configuration["Catalog:BaseUrl"]!);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("orders-api/1.0");
    })
    .AddStandardResilienceHandler(options =>
    {
        options.Retry.MaxRetryAttempts = 4;
        options.Retry.DisableForUnsafeHttpMethods();
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(5);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(20);
        options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(15);
    });

var app = builder.Build();

app.MapGet("/orders/{id:int}/items",
    async (int id, CatalogClient catalog, CancellationToken ct) =>
        Results.Ok(await catalog.GetItemsAsync(id, ct)));

app.Run();

public sealed class CatalogClient(HttpClient http)
{
    public Task<CatalogItem[]?> GetItemsAsync(int orderId, CancellationToken ct) =>
        http.GetFromJsonAsync<CatalogItem[]>($"orders/{orderId}/items", ct);
}

public sealed record CatalogItem(int Id, string Name, decimal Price);
```

명명 클라이언트에 커스텀 핸들러와 직접 조립한 파이프라인을 붙이고, 연결 회전은 `SocketsHttpHandler`에 맡겨 싱글턴 워커에서 쓴다.

```csharp
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

builder.Services.Configure<PaymentsOptions>(builder.Configuration.GetSection("Payments"));
builder.Services.AddTransient<ApiKeyHandler>();

builder.Services.AddHttpClient("payments", client =>
        client.BaseAddress = new Uri("https://payments.internal/"))
    .AddHttpMessageHandler<ApiKeyHandler>()
    .UseSocketsHttpHandler((handler, _) =>
        handler.PooledConnectionLifetime = TimeSpan.FromMinutes(5))
    .SetHandlerLifetime(Timeout.InfiniteTimeSpan)
    .AddResilienceHandler("payments-pipeline", pipeline =>
    {
        pipeline.AddRetry(new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            BackoffType = DelayBackoffType.Exponential,
            UseJitter = true,
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Result?.StatusCode is HttpStatusCode.ServiceUnavailable
                    or HttpStatusCode.TooManyRequests)
        });
        pipeline.AddTimeout(TimeSpan.FromSeconds(3));
    });

builder.Services.AddHostedService<SettlementWorker>();

public sealed class ApiKeyHandler(IOptions<PaymentsOptions> options) : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        request.Headers.TryAddWithoutValidation("X-Api-Key", options.Value.ApiKey);
        return base.SendAsync(request, ct);
    }
}

public sealed class SettlementWorker(IHttpClientFactory factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            var client = factory.CreateClient("payments");
            using var response = await client.GetAsync("settlements/pending", stoppingToken);
            response.EnsureSuccessStatusCode();
        }
    }
}

public sealed class PaymentsOptions
{
    public required string ApiKey { get; init; }
}
```

## 실무에서 걸리는 지점

- **싱글턴에 형식화 클라이언트 주입.** ==형식화 클라이언트를 싱글턴 서비스에 주입하면 내부 HttpClient가 핸들러 하나에 영구히 묶여 DNS 변경을 반영하지 못한다.== 싱글턴에서는 `IHttpClientFactory`로 그때그때 `CreateClient`를 부르거나, `SocketsHttpHandler.PooledConnectionLifetime`으로 연결 회전을 핸들러에 맡긴다.
- **비멱등 요청 재시도.** 표준 핸들러는 기본값으로 모든 메서드를 재시도한다. ==POST로 주문을 만드는 요청이 시도별 타임아웃 뒤 재시도되면 서버에는 주문이 두 건 생긴다.== `DisableForUnsafeHttpMethods()`로 끄거나 멱등성 키를 서버와 합의한다.
- **타임아웃 값의 상호 제약.** 시도별 타임아웃은 전체 타임아웃보다 짧아야 하고, 서킷 브레이커 샘플링 기간은 시도별 타임아웃의 2배 이상이어야 한다. 어기면 시작 시점에 옵션 검증이 실패한다. Polly 타임아웃은 `TimeoutException`이 아니라 `TimeoutRejectedException`을 던진다.
- **핸들러 스코프.** `DelegatingHandler`는 요청 스코프와 분리된 스코프에서 핸들러 수명 동안 산다. `HttpContext`에서 얻은 사용자 정보를 핸들러 필드에 저장하면 다른 사용자의 요청으로 새어 나가므로, 요청별 값은 `HttpRequestMessage.Options`나 헤더로 매번 실어 보낸다.
- **복원력 핸들러 중첩.** `ConfigureHttpClientDefaults`로 전역 적용한 뒤 개별 클라이언트에 또 붙이면 두 층이 겹쳐 재시도가 곱해진다. 개별 설정은 `RemoveAllResilienceHandlers()` 뒤에 붙인다.

## 관련 글

- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
- [async/await와 Task — 비동기 모델과 취소](/notes/dotnet/async-await/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
