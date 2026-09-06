---
title: "예외 처리와 ProblemDetails — 미들웨어·필터"
series: dotnet
part: "웹 API"
order: 9
summary: "예외 처리 미들웨어·IExceptionHandler·예외 필터가 예외를 잡는 위치와 ProblemDetails로 오류 응답을 통일하는 방법을 정리한다"
tags: [ProblemDetails, IExceptionHandler, "ASP.NET Core", 예외 필터, 미들웨어]
sources: [https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling, https://learn.microsoft.com/en-us/aspnet/core/web-api/handle-errors, https://learn.microsoft.com/en-us/aspnet/core/mvc/controllers/filters]
updated: 2026-09-06
---

예외를 처리하는 공통 층이 없으면 각 액션이 try/catch로 오류 본문을 직접 만들고 같은 오류가 엔드포인트마다 다른 모양으로 나간다. 미처리 예외는 본문 없는 500으로 나가 원인을 알 수 없고, 개발용 예외 페이지가 운영에 노출되면 스택 트레이스가 새어 나간다. ASP.NET Core는 이를 예외 처리 미들웨어, RFC 9457 ProblemDetails, MVC 필터의 조합으로 해결한다.

## 핵심 개념

**ProblemDetails**는 `type`·`title`·`status`·`detail`·`instance`와 임의 확장 필드를 갖는 표준 오류 본문이다. `AddProblemDetails()`를 호출하면 `IProblemDetailsService`가 등록되고, 예외 처리·상태 코드 페이지·개발자 예외 페이지 미들웨어가 본문이 비어 있는 오류 응답을 이 형식으로 채운다. 기본 writer는 `Accept`가 JSON 계열이나 와일드카드일 때만 쓰고 `text/html`·`application/xml`만 받는 요청에는 아무것도 쓰지 않는다. `CustomizeProblemDetails`로 traceId 같은 확장 필드를 전역으로 덧붙인다.

**예외 처리 미들웨어**(`UseExceptionHandler`)는 뒤쪽 파이프라인에서 올라온 예외를 잡아 응답을 대신 만든다. 확장 지점은 `IExceptionHandler`다. `TryHandleAsync`가 `true`를 반환하면 처리가 끝나고 `false`면 등록 순서대로 다음 핸들러로 넘어가며, 전부 `false`면 미들웨어에 설정된 폴백(오류 경로·ProblemDetails·람다)이 동작한다. ==`AddExceptionHandler<T>()`로 등록만 하고 `UseExceptionHandler()`를 호출하지 않으면 그 핸들러는 한 번도 실행되지 않는다.== `ExceptionHandlerOptions.StatusCodeSelector`로 예외 타입별 상태 코드를 정한다.

**상태 코드 페이지 미들웨어**(`UseStatusCodePages`)는 예외가 아니라 본문 없는 4xx·5xx 응답을 대상으로 한다. 라우팅에 실패한 404나 `Results.BadRequest()`처럼 빈 채로 돌아온 응답에 ProblemDetails 본문을 채운다.

**필터**는 MVC 컨트롤러 전용 파이프라인이다. 인가, 리소스, 액션, 예외, 결과 필터 순서로 실행되고 전역·컨트롤러·액션 범위로 등록한다. 예외 필터는 모델 바인딩·액션 필터·액션에서 던진 예외만 잡고 결과 실행 단계의 예외는 잡지 못한다. `[ApiController]`는 모델 검증 실패 시 자동으로 `ValidationProblemDetails` 400을 반환하며, `ControllerBase.Problem()`으로 직접 결과를 만든다. Minimal API에는 필터 대신 엔드포인트 필터와 `TypedResults.Problem`이 있다.

Spring과 대응시키면 `IExceptionHandler`와 예외 필터 ≈ `@ControllerAdvice` + `@ExceptionHandler`, ProblemDetails ≈ Spring 6의 `ProblemDetail`, 미들웨어 ≈ Servlet Filter, MVC 필터 ≈ `HandlerInterceptor`다. 미들웨어는 MVC 밖에서 동작해 Minimal API·라우팅 실패까지 한 층에서 다루므로 전역 정책은 미들웨어에, 컨트롤러별 규칙은 예외 필터에 둔다.

## 코드

ProblemDetails 서비스·커스텀 핸들러·상태 코드 페이지를 구성한 Program.cs다. 개발 환경은 개발자 예외 페이지가 기본으로 켜지므로 운영 환경에서만 예외 처리 미들웨어를 등록한다.

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = ctx =>
        ctx.ProblemDetails.Extensions["traceId"] =
            ctx.HttpContext.TraceIdentifier);
builder.Services.AddExceptionHandler<DomainExceptionHandler>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(new ExceptionHandlerOptions
    {
        StatusCodeSelector = ex => ex is TimeoutException
            ? StatusCodes.Status503ServiceUnavailable
            : StatusCodes.Status500InternalServerError
    });
}
app.UseStatusCodePages();

app.MapControllers();
app.MapGet("/orders/{id:int}", (int id) =>
    id <= 0
        ? Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["id"] = ["id는 1 이상이어야 한다."]
        })
        : Results.Ok(new { id }));

app.Run();
```

도메인 예외를 상태 코드로 매핑하는 `IExceptionHandler`다. 모르는 예외는 `false`로 폴백에 맡기고, 아는 예외는 `TryWriteAsync`로 본문을 쓴 뒤 그 결과를 반환한다.

```csharp
public sealed class NotFoundException(string entity, object key)
    : Exception($"{entity} {key} 을(를) 찾을 수 없다.");

public sealed class DomainExceptionHandler(
    IProblemDetailsService problemDetails,
    ILogger<DomainExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        (int status, string? title) = exception switch
        {
            NotFoundException => (StatusCodes.Status404NotFound, "리소스 없음"),
            ArgumentException => (StatusCodes.Status400BadRequest, "잘못된 요청"),
            _ => (0, null)
        };
        if (status == 0)
        {
            return false;
        }

        logger.LogWarning(exception, "도메인 예외 {Status}", status);
        httpContext.Response.StatusCode = status;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails =
            {
                Status = status,
                Title = title,
                Detail = exception.Message
            }
        });
    }
}
```

EF Core의 낙관적 동시성 충돌을 409로 바꾸는 전역 예외 필터다. `Order`를 크게 잡아 다른 필터가 먼저 실행되게 한다.

```csharp
public sealed class ConcurrencyExceptionFilter : IExceptionFilter, IOrderedFilter
{
    public int Order => int.MaxValue - 10;

    public void OnException(ExceptionContext context)
    {
        if (context.Exception is not DbUpdateConcurrencyException)
        {
            return;
        }

        context.Result = new ConflictObjectResult(new ProblemDetails
        {
            Status = StatusCodes.Status409Conflict,
            Title = "동시 수정 충돌",
            Detail = "다른 요청이 먼저 저장했다. 최신 데이터를 다시 읽어 재시도한다.",
            Instance = context.HttpContext.Request.Path
        });
        context.ExceptionHandled = true;
    }
}

// Program.cs
builder.Services.AddControllers(options =>
    options.Filters.Add<ConcurrencyExceptionFilter>());
```

## 실무에서 걸리는 지점

- **true를 반환했는데 응답을 안 쓴 경우.** ==`TryHandleAsync`가 `true`를 반환하면서 상태 코드도 본문도 쓰지 않으면 응답은 404로 끝난다.== `true`를 돌려주는 경로에서는 반드시 `StatusCode`를 설정하고 본문을 쓰거나 `TryWriteAsync`에 위임한다.
- **.NET 10의 진단 억제.** ==.NET 10부터 핸들러가 `true`를 반환한 예외는 예외 처리 미들웨어가 로그와 메트릭을 남기지 않는다.== 핸들러 안에서 직접 로깅하지 않으면 예외가 관측 시스템에서 사라진다. 이전 동작은 `SuppressDiagnosticsCallback = _ => false`로 되돌린다.
- **응답이 이미 시작된 뒤의 예외.** ==응답 헤더가 전송된 뒤 발생한 예외는 어떤 핸들러나 필터도 처리하지 못하고 서버가 연결을 끊는다.== 스트리밍 응답 도중에는 상태 코드 변경이 불가능하므로 검증과 조회는 본문 쓰기 전에 끝낸다.
- **필터가 삼킨 예외는 미들웨어에 도달하지 않는다.** 예외 필터가 `ExceptionHandled = true`를 설정하면 `IExceptionHandler`는 그 예외를 보지 못하므로 필터에서 처리한 예외는 별도로 기록한다.

## 관련 글

- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [Minimal API와 컨트롤러 — 라우팅·바인딩·검증](/notes/dotnet/minimal-apis-controllers/)
- [로깅과 관측성 — ILogger·OpenTelemetry·헬스 체크](/notes/dotnet/logging-observability/)
