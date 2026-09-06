---
title: "인증과 인가 — JWT Bearer·정책·Identity"
series: dotnet
part: "웹 API"
order: 10
summary: "JWT Bearer 스킴이 ClaimsPrincipal을 만들고 정책이 요구 사항으로 판정하며, Identity API는 자체 토큰 발급을 맡는 구조를 정리한다"
tags: [ASP.NET Core, JWT, Authorization Policy, Identity, ClaimsPrincipal]
sources: [https://learn.microsoft.com/en-us/aspnet/core/security/authentication/, https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication, https://learn.microsoft.com/en-us/aspnet/core/security/authorization/policies, https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization]
updated: 2026-09-06
---

인증을 뒤로 미루면 토큰 검증 코드가 컨트롤러마다 복사되고, 서명은 확인하지 않은 채 payload의 사용자 ID만 꺼내 쓰는 엔드포인트가 생긴다. 인가 규칙을 핸들러 안에 `if`로 흩어 두면 고칠 곳을 추적할 수 없고, 로그인·토큰 갱신을 직접 만들면 재발급 흐름에서 구멍이 난다. ASP.NET Core는 이 셋을 인증 스킴, 정책 기반 인가, Identity로 분리한다.

## 핵심 개념

**인증 스킴과 핸들러.** 인증은 요청에서 신원을 복원해 `HttpContext.User`에 `ClaimsPrincipal`을 올리는 일이다. `AddAuthentication()` 뒤에 `AddJwtBearer()`나 `AddCookie()`를 붙이면 이름·핸들러·옵션의 묶음인 스킴이 등록된다. 핸들러는 Authenticate·Challenge·Forbid 세 동작을 가지며, JWT 스킴의 Challenge는 401, Forbid는 403을 돌려준다. 스킴이 하나면 자동으로 기본이 되지만, 둘 이상이면 기본 스킴을 지정하거나 `[Authorize(AuthenticationSchemes = ...)]`로 골라야 한다. Spring Security의 `AuthenticationEntryPoint`·`AccessDeniedHandler`에 해당한다.

**JWT Bearer.** `Authority`와 `Audience`만 주면 핸들러가 OIDC 디스커버리 문서에서 JWKS를 받아 서명·발급자·대상·만료를 검증한다. 다중 발급자는 `TokenValidationParameters.ValidIssuers`로 받는다. 검증 후 `sub` 같은 짧은 클레임 이름은 기본적으로 `ClaimTypes.NameIdentifier` 형태의 URI 이름으로 바뀌므로, ==`MapInboundClaims`를 false로 끄지 않으면 `User.FindFirst("sub")`는 null을 돌려준다.== `ClockSkew` 기본값은 5분이라 만료 직후 5분간은 토큰이 통과한다. Spring의 `oauth2ResourceServer().jwt()`에 대응한다.

**정책 기반 인가.** 정책은 이름 붙은 요구 사항(`IAuthorizationRequirement`) 집합이고, `AuthorizationHandler<T>`가 `context.Succeed()`로 충족을 표시한다. 한 정책의 요구 사항은 AND, 한 요구 사항에 붙은 여러 핸들러는 OR로 평가된다. 핸들러는 순서가 보장되지 않고 인증이 실패해도 호출되며, `context.Fail()`은 거부를 확정한다. `[Authorize]`만 쓰면 `DefaultPolicy`가, 속성이 없는 엔드포인트에는 `FallbackPolicy`가 적용된다. Spring의 `AuthorizationManager`·`@PreAuthorize`에 대응한다.

**Identity API.** 외부 IdP 없이 가입·로그인을 앱이 직접 맡을 때 `AddIdentityApiEndpoints<TUser>()`와 `MapIdentityApi<TUser>()`가 `/register`·`/login`·`/refresh`·`/manage/info` 등을 만든다. `/login?useCookies=true`면 쿠키를, 아니면 액세스·리프레시 토큰을 준다. 이 토큰은 JWT가 아니라 Data Protection으로 암호화된 자체 형식이라 발급한 앱만 해독할 수 있다.

## 코드

외부 IdP가 발급한 JWT를 검증하고 정책으로 엔드포인트를 보호한다.

```csharp
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = builder.Configuration["Auth:Authority"];
        options.Audience = builder.Configuration["Auth:Audience"];
        options.MapInboundClaims = false;
        options.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
    });

builder.Services.AddAuthorizationBuilder()
    .SetFallbackPolicy(new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser().Build())
    .AddPolicy("OrderWriter", policy =>
        policy.RequireClaim("scope", "orders:write"))
    .AddPolicy("SameTeamOrAdmin", policy =>
        policy.Requirements.Add(new SameTeamRequirement()));

builder.Services.AddScoped<IAuthorizationHandler, SameTeamHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AdminOverrideHandler>();

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok()).AllowAnonymous();
app.MapPost("/orders", (ClaimsPrincipal user) =>
        Results.Created($"/orders/1", new { by = user.FindFirstValue("sub") }))
    .RequireAuthorization("OrderWriter");
app.MapGet("/teams/{teamId}/orders", (string teamId) => Results.Ok())
    .RequireAuthorization("SameTeamOrAdmin");

app.Run();
```

같은 요구 사항에 핸들러 두 개를 붙여 OR 규칙을 만든다.

```csharp
public sealed class SameTeamRequirement : IAuthorizationRequirement;

public sealed class SameTeamHandler(IHttpContextAccessor accessor)
    : AuthorizationHandler<SameTeamRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, SameTeamRequirement requirement)
    {
        var routeTeam = accessor.HttpContext?.GetRouteValue("teamId") as string;
        var userTeam = context.User.FindFirstValue("team");
        if (routeTeam is not null && routeTeam == userTeam)
            context.Succeed(requirement);
        return Task.CompletedTask;
    }
}

public sealed class AdminOverrideHandler : AuthorizationHandler<SameTeamRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, SameTeamRequirement requirement)
    {
        if (context.User.HasClaim("role", "admin"))
            context.Succeed(requirement);
        return Task.CompletedTask;
    }
}
```

Identity로 자체 로그인을 제공한다.

```csharp
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);

// Program.cs
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>(o =>
    {
        o.Password.RequiredLength = 12;
        o.SignIn.RequireConfirmedEmail = true;
    })
    .AddEntityFrameworkStores<AppDbContext>();

builder.Services.Configure<BearerTokenOptions>(
    IdentityConstants.BearerScheme,
    o => o.BearerTokenExpiration = TimeSpan.FromMinutes(15));

var app = builder.Build();
app.MapGroup("/auth").MapIdentityApi<IdentityUser>();
app.MapGet("/me", (ClaimsPrincipal user) => user.Identity?.Name)
    .RequireAuthorization();
app.Run();
```

## 실무에서 걸리는 지점

- **미들웨어 순서.** `UseAuthentication()`이 `UseAuthorization()`보다 앞에 와야 `User`가 채워진 상태로 정책이 평가된다. `WebApplication`이 둘을 자동으로 넣어 주지만, `UseRouting()`이나 CORS를 직접 호출하면 위치가 어긋날 수 있으므로 명시적으로 적는다.
- **핸들러 수명과 DbContext.** ==싱글턴 핸들러에 스코프드 `DbContext`를 주입하면 개발 환경에서는 시작 시 예외가 나고, 스코프 검증이 꺼진 운영 환경에서는 한 `DbContext`가 모든 요청에 공유된다.== DB를 읽는 핸들러는 `AddScoped`로 등록한다.
- **Identity 토큰의 키 관리.** ==Identity Bearer 토큰은 Data Protection 키로 암호화되므로, 키 링을 Redis·DB·공유 스토리지에 두지 않으면 다른 인스턴스나 재시작 뒤의 앱이 발급한 토큰은 전부 401로 거부된다.== 액세스 토큰 기본 만료는 1시간이다.
- **Identity 토큰을 다른 API에 넘기지 않는다.** 여러 서비스가 같은 사용자를 인식해야 하면 OIDC 제공자를 두고 각 API는 JWT Bearer로 검증한다. 사용자명·비밀번호로 직접 JWT를 찍어 내는 방식은 테스트 용도로만 권장된다.
- **401과 403의 경계.** 서명·`aud`·만료가 틀리면 401, 인증은 됐지만 정책이 거부하면 403이다. `FallbackPolicy`를 걸면 헬스 체크·OpenAPI 문서도 401을 받으므로 `AllowAnonymous()`를 빠뜨리지 않는다. 로컬 토큰은 `dotnet user-jwts create`로 만든다.

## 관련 글

- [Minimal API와 컨트롤러 — 라우팅·바인딩·검증](/notes/dotnet/minimal-apis-controllers/)
- [예외 처리와 ProblemDetails — 미들웨어·필터](/notes/dotnet/error-handling-filters/)
- [EF Core 기본 — DbContext·마이그레이션·LINQ 쿼리](/notes/dotnet/ef-core-basics/)
