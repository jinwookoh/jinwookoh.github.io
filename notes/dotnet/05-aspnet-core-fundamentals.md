---
title: "ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인"
series: dotnet
part: "웹 API"
order: 5
summary: "WebApplication 호스트가 기본으로 해 주는 일과, 미들웨어 등록 순서가 요청 처리 결과를 바꾸는 방식"
tags: [ASP.NET Core, WebApplication, Middleware, Kestrel, Generic Host]
sources: [https://learn.microsoft.com/en-us/aspnet/core/fundamentals/, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/generic-host]
updated: 2026-09-06
---

HTTP 서버를 직접 띄우면 포트 바인딩, 설정 읽기, 로거 초기화, 종료 시그널 처리를 전부 애플리케이션 코드가 떠안는다. 인증·로깅·예외 처리는 핸들러마다 반복되고, 순서가 흩어지면 어떤 요청이 인증 없이 통과하는지 추적할 수 없다. ASP.NET Core는 이를 호스트와 미들웨어 파이프라인으로 나눈다. 호스트가 서버·구성·로깅·DI를 묶어 시작과 종료를 책임지고, 파이프라인이 공통 단계를 선언된 순서대로 실행한다.

## 핵심 개념

호스트는 DI 컨테이너, 구성, 로깅, `IHostedService` 목록을 담은 객체다. 시작 시 등록된 `IHostedService`의 `StartAsync`를 차례로 호출하고, 웹 앱에서는 그중 하나가 Kestrel을 띄운다. 종료 시에는 `ApplicationStopping`을 발생시킨 뒤 새 연결을 거부하고 진행 중인 요청이 끝날 때까지 기다린다. 대기 상한은 `HostOptions.ShutdownTimeout`이며 기본 30초다.

호스트는 범용 호스트(`Host.CreateApplicationBuilder`), 웹 전용 `WebApplication`, 하위 호환용 `WebHost` 세 종류이고 현재 템플릿은 모두 `WebApplication.CreateBuilder(args)`를 쓴다. `Startup` 클래스 분리는 .NET 5까지의 방식이고, 지금은 `Program.cs` 최상위 문에서 서비스 등록과 파이프라인 구성을 순서대로 적는다. Spring으로 치면 `WebApplication.CreateBuilder`가 자동 구성에, `builder.Services`가 빈 등록에, 미들웨어가 Servlet Filter 체인에 대응한다.

`CreateBuilder`는 `DOTNET_`·`ASPNETCORE_` 접두사 환경 변수와 명령줄에서 호스트 구성을 읽는다. 앱 구성은 `appsettings.json`, `appsettings.{Environment}.json`, 사용자 비밀(Development 한정), 환경 변수, 명령줄 순으로 쌓이며 뒤가 앞을 덮는다. 로깅은 Console·Debug·EventSource가 붙고 서버는 Kestrel이다. ==DI 스코프 검증과 `ValidateOnBuild`는 Development 환경에서만 켜지므로, 싱글톤이 스코프 서비스를 물고 있는 잘못된 등록은 운영 환경에서 예외 없이 지나간다.==

미들웨어는 `HttpContext`를 받아 다음 미들웨어를 호출하거나 거기서 응답을 끝내는 요청 델리게이트다. `app.Use`는 `next`를 받아 앞뒤로 작업을 넣고, `app.Run`은 `next`가 없는 종단 델리게이트다. `Map`은 경로 접두사로, `MapWhen`은 조건식으로 분기하며 분기된 가지는 본선으로 돌아오지 않는다. `UseWhen`은 분기 뒤 본선으로 합류한다. 실행은 등록 순서, 응답은 그 역순이다.

`WebApplication`은 미들웨어 일부를 자동으로 끼워 넣는다. Development에서는 개발자 예외 페이지가 맨 앞에, 엔드포인트가 있으면 `UseRouting`이 그다음에, `AddAuthentication`·`AddAuthorization`을 등록했다면 `UseAuthentication`·`UseAuthorization`이 라우팅 바로 뒤에, `UseEndpoints`가 맨 끝에 들어간다. 사용자가 적은 미들웨어는 라우팅과 엔드포인트 사이에 놓인다.

## 코드

기본 Program.cs. 서비스 등록과 파이프라인 구성이 한 파일에 순서대로 놓인다.

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddAuthentication().AddJwtBearer();
builder.Services.AddAuthorization();
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(60));

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler();
    app.UseHsts();
}

app.UseHttpsRedirection();

app.MapGet("/orders/{id:int}", (int id) => Results.Ok(new { id }))
   .RequireAuthorization();

app.Run();
```

인라인 미들웨어. 처리 시간을 응답 헤더에 넣기 위해 `OnStarting` 콜백을 쓴다.

```csharp
app.Use(async (context, next) =>
{
    var sw = Stopwatch.StartNew();
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Elapsed-Ms"] = sw.ElapsedMilliseconds.ToString();
        return Task.CompletedTask;
    });
    await next(context);
});
```

클래스 미들웨어. `IMiddleware`를 구현하면 요청마다 DI가 인스턴스를 만들어 scoped 서비스를 생성자로 받을 수 있다.

```csharp
public sealed class TenantMiddleware(ITenantResolver resolver) : IMiddleware
{
    public async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        var tenant = await resolver.ResolveAsync(context.Request.Host.Host);
        if (tenant is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        context.Items["tenant"] = tenant;
        await next(context);
    }
}

// Program.cs
builder.Services.AddTransient<TenantMiddleware>();
// ...
app.UseMiddleware<TenantMiddleware>();
```

## 실무에서 걸리는 지점

- **CORS를 쓰면 인증·인가를 직접 호출한다.** 자동 삽입된 `UseAuthentication`·`UseAuthorization`은 사용자 미들웨어보다 앞에 놓여 `UseCors`가 인가보다 늦게 돈다. ==`app.UseCors()`를 추가하면 그 뒤에 `UseAuthentication()`과 `UseAuthorization()`을 명시해야 하며, 빠뜨리면 인가가 먼저 401을 돌려보내 CORS 헤더가 빠지고 브라우저에서는 CORS 오류로 보인다.==
- **응답이 시작된 뒤에는 헤더와 상태 코드를 바꿀 수 없다.** `next`가 돌아온 시점에는 본문이 이미 전송됐을 수 있어 예외가 난다. `HasStarted`를 확인하거나 `OnStarting` 콜백에 미룬다.
- **라우팅 앞에서 돌아야 하는 미들웨어는 `UseRouting`을 직접 호출한다.** 경로 재작성처럼 엔드포인트 매칭 전에 실행돼야 하면 `app.UseRouting()`을 명시하고 그 앞에 둔다.
- **환경 이름은 환경 변수가 결정한다.** `ASPNETCORE_ENVIRONMENT`가 없으면 `Production`이다. ==`launchSettings.json`은 `dotnet run`과 IDE에서만 읽히고 publish 산출물이나 컨테이너에서는 무시되므로, 환경 변수를 넣지 않으면 개발자 예외 페이지·사용자 비밀·DI 검증이 모두 꺼진 Production으로 시작한다.==
- **종료 타임아웃은 인프라 유예 시간과 맞춘다.** `ShutdownTimeout`이 지나면 처리 중인 요청도 끊긴다. Kubernetes `terminationGracePeriodSeconds` 기본값도 30초라 긴 요청이 있으면 함께 늘린다.

## 관련 글

- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
- [구성과 Options 패턴 — appsettings·환경·비밀 관리](/notes/dotnet/configuration-options/)
- [Minimal API와 컨트롤러 — 라우팅·바인딩·검증](/notes/dotnet/minimal-apis-controllers/)
