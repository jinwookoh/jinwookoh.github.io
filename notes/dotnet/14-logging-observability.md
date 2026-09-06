---
title: "로깅과 관측성 — ILogger·OpenTelemetry·헬스 체크"
series: dotnet
part: "운영"
order: 14
summary: "ILogger 구조화 로그, OpenTelemetry로 로그·메트릭·추적을 한 파이프라인으로 내보내는 법, readiness와 liveness를 분리한 헬스 체크 구성"
tags: [ILogger, OpenTelemetry, ActivitySource, Health Checks, OTLP]
sources: [https://learn.microsoft.com/en-us/dotnet/core/extensions/logging, https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel, https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks]
updated: 2026-09-06
---

장애가 났을 때 남는 것은 로그와 지표뿐이다. 문자열을 이어 붙인 로그는 검색과 집계가 되지 않고, 요청이 여러 서비스를 거치면 어느 구간에서 시간이 새는지 로그만으로 알 수 없다. 오케스트레이터가 프로세스 상태를 물을 수단이 없으면 준비되지 않은 인스턴스로 트래픽이 들어간다. .NET은 이 문제를 `ILogger`, `Activity`·`Meter`, 헬스 체크로 다루고, OpenTelemetry는 앞의 둘을 표준 형식으로 내보내는 통로다.

## 핵심 개념

`ILogger<T>`는 DI 컨테이너가 `ILoggerFactory`에서 만들어 주입하는 로거이고, `T`의 정규화된 타입 이름이 카테고리가 된다. SLF4J의 `Logger`와 로거 이름에 대응한다. 레벨은 `Trace`(0)부터 `Critical`(5)에 `None`(6)을 더한 일곱 값이고, `appsettings.json`의 `Logging:LogLevel` 섹션에서 카테고리 접두사별 최소 레벨을 정한다. 규칙은 프로바이더별로 가장 긴 카테고리 접두사가 이기고, 파일 구성은 변경을 다시 읽으므로 재시작 없이 레벨을 바꿀 수 있다.

메시지는 템플릿과 인자로 나뉘어 전달된다. `"Reading {Id}"`처럼 이름 있는 자리 표시자를 쓰면 프로바이더가 `Id`를 별도 필드로 저장하며, 이것이 구조화 로깅의 근거다. ==자리 표시자 이름은 인자를 맞추는 데 쓰이지 않고 인자는 순서대로만 대응되므로, 이름 순서를 바꿔 써도 오류 없이 값이 뒤바뀐다.== 문자열 보간을 넘기면 템플릿이 매 호출마다 달라져 필드 추출이 무너지고 분석기 CA2254가 경고한다. `[LoggerMessage]` 특성을 붙인 `partial` 메서드는 소스 생성기가 본문을 만들어 박싱과 템플릿 파싱을 없애고, 레벨이 꺼져 있으면 인자 평가를 건너뛴다. `BeginScope`는 Java의 MDC에 해당하며, 콘솔 프로바이더는 `IncludeScopes`를 켜야 출력한다.

OpenTelemetry의 .NET 구현은 계측 API를 따로 제공하지 않고 런타임에 있는 `ILogger`, `ActivitySource`·`Activity`(추적), `Meter`(메트릭)를 그대로 쓴다. OTel SDK는 이 소스에서 데이터를 모아 OTLP 같은 형식으로 내보내는 계층만 맡는다. `Activity`가 스팬, `ActivitySource`가 트레이서라는 점에서 Micrometer Tracing의 `Span`·`Tracer`에, `Meter`는 `MeterRegistry`에 대응한다. `AddOpenTelemetry()`에 `WithTracing`·`WithMetrics`를 이어 붙이고 계측 패키지로 인바운드·아웃바운드 스팬을 자동으로 얻는다. `UseOtlpExporter()`는 세 신호를 한 번에 OTLP 엔드포인트로 보내며, 목적지와 서비스 이름은 `OTEL_EXPORTER_OTLP_ENDPOINT`·`OTEL_SERVICE_NAME` 환경 변수로 준다.

헬스 체크는 Spring Actuator의 `HealthIndicator`와 `/actuator/health`에 해당한다. `AddHealthChecks()`로 등록하고 `MapHealthChecks("/healthz")`로 엔드포인트 라우팅에 붙인다. 각 검사는 `IHealthCheck`를 구현해 `Healthy`·`Degraded`·`Unhealthy` 중 하나를 돌려주고, 기본 상태 코드는 앞의 둘이 200, `Unhealthy`가 503이다. 태그와 `HealthCheckOptions.Predicate`로 readiness와 liveness 엔드포인트를 분리한다.

## 코드

소스 생성 로거와 범위를 함께 쓰는 서비스다. `partial` 클래스에 특성 메서드를 선언하면 본문은 컴파일 시점에 생성된다.

```csharp
public sealed partial class OrderService(ILogger<OrderService> logger, ShopDbContext db)
{
    public async Task<Order?> GetAsync(int id, CancellationToken ct)
    {
        using var scope = logger.BeginScope(new Dictionary<string, object> { ["OrderId"] = id });
        LogReading(logger, id);

        var order = await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id, ct);
        if (order is null) LogNotFound(logger, id);
        return order;
    }

    [LoggerMessage(EventId = 1001, Level = LogLevel.Information, Message = "Reading order {Id}")]
    private static partial void LogReading(ILogger logger, int id);

    [LoggerMessage(EventId = 4001, Level = LogLevel.Warning, Message = "Order {Id} not found")]
    private static partial void LogNotFound(ILogger logger, int id);
}
```

`Program.cs`에서 로그·메트릭·추적을 OTel로 묶고, 애플리케이션 고유 `ActivitySource`와 `Meter`를 등록해 OTLP로 내보낸다.

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using OpenTelemetry.Logs;

var builder = WebApplication.CreateBuilder(args);

var meter = new Meter("Shop.Orders", "1.0.0");
var ordersCreated = meter.CreateCounter<long>("orders.created", description: "Number of created orders");
var activitySource = new ActivitySource("Shop.Orders");

builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeFormattedMessage = true;
    o.IncludeScopes = true;
});

builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter(meter.Name))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource(activitySource.Name))
    .UseOtlpExporter();

var app = builder.Build();

app.MapPost("/orders", async (CreateOrder req, OrderService svc, CancellationToken ct) =>
{
    using var activity = activitySource.StartActivity("CreateOrder");
    activity?.SetTag("order.product_id", req.ProductId);

    var order = await svc.CreateAsync(req, ct);
    ordersCreated.Add(1, new KeyValuePair<string, object?>("order.channel", req.Channel));
    return Results.Created($"/orders/{order.Id}", order);
});

app.Run();
```

DB 연결을 포함한 readiness와 프로세스 생존만 보는 liveness를 분리한 헬스 체크 구성이다.

```csharp
builder.Services.AddHealthChecks()
    .AddDbContextCheck<ShopDbContext>("database", tags: ["ready"])
    .AddCheck<PaymentGatewayHealthCheck>("payment", failureStatus: HealthStatus.Degraded, tags: ["ready"]);

app.MapHealthChecks("/healthz/ready", new HealthCheckOptions
{
    Predicate = r => r.Tags.Contains("ready")
});

app.MapHealthChecks("/healthz/live", new HealthCheckOptions
{
    Predicate = _ => false
});

public sealed class PaymentGatewayHealthCheck(IHttpClientFactory factory) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        using var client = factory.CreateClient("payment");
        using var res = await client.GetAsync("/ping", ct);
        return res.IsSuccessStatusCode
            ? HealthCheckResult.Healthy()
            : new HealthCheckResult(context.Registration.FailureStatus, $"payment returned {(int)res.StatusCode}");
    }
}
```

## 실무에서 걸리는 지점

- `Log` 계열 메서드는 동기이며 비동기 오버로드가 없다. 원격 저장소에 직접 쓰는 프로바이더는 요청 스레드를 막으므로 메모리 큐와 백그라운드 작업자로 분리한다.
- ==`AddSource`·`AddMeter`에 이름을 등록하지 않은 `ActivitySource`와 `Meter`의 데이터는 오류 없이 버려진다.== `StartActivity`는 리스너가 없으면 `null`을 돌려주므로 `activity?.` 형태로 접근한다.
- `Trace`·`Debug`를 넓게 켠 채 배포하면 로그 비용이 급증하고 민감 정보가 섞인다. 운영은 `Warning` 이상을 기본으로 하고 조사 중인 카테고리만 낮춘다.
- ==liveness 엔드포인트에 DB 같은 외부 의존성 검사를 넣으면 DB 장애 때 오케스트레이터가 정상 프로세스를 재시작 루프에 빠뜨린다.== liveness는 `Predicate = _ => false`로 응답 여부만 보고, 의존성은 readiness에서 검사해 트래픽만 빼도록 나눈다.
- 헬스 엔드포인트는 인증 없이 열리고 결과 설명에 내부 정보가 담긴다. `RequireHost`는 `Host` 헤더 스푸핑에 취약하므로 `RequireAuthorization()`을 함께 건다. 검사가 무거우면 `HealthCheckRegistration`의 `Period`로 실행 주기를 둔다.

## 관련 글

- [구성과 Options 패턴 — appsettings·환경·비밀 관리](/notes/dotnet/configuration-options/)
- [HttpClient — IHttpClientFactory와 복원력 파이프라인](/notes/dotnet/httpclient-resilience/)
- [백그라운드 서비스와 배포 — IHostedService·Docker·Native AOT](/notes/dotnet/background-services-deploy/)
