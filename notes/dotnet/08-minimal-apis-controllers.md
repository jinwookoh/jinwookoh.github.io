---
title: "Minimal API와 컨트롤러 — 라우팅·바인딩·검증"
series: dotnet
part: "웹 API"
order: 8
summary: "Minimal API는 람다 하나로 엔드포인트를 만들고 바인딩·검증을 규칙으로 추론하며, 컨트롤러는 MVC 확장점이 필요할 때 고른다"
tags: [ASP.NET Core, "Minimal API", ApiController, "Parameter Binding", Validation]
sources: [https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/overview, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding, https://learn.microsoft.com/en-us/aspnet/core/web-api/, https://learn.microsoft.com/en-us/aspnet/core/fundamentals/apis]
updated: 2026-09-06
---

HTTP 요청은 경로·쿼리·헤더·본문에 흩어진 문자열 묶음이다. 핸들러마다 `HttpContext`에서 값을 꺼내 파싱하면 같은 코드가 엔드포인트 수만큼 복제되고, 형식이 틀린 입력이 400 대신 500으로 새어 나간다. ASP.NET Core는 이 구간을 라우팅·바인딩·검증 규칙으로 흡수하며, 그 규칙을 노출하는 방식이 Minimal API와 컨트롤러 두 가지다.

## 핵심 개념

Minimal API는 `WebApplication`에 라우트 템플릿과 델리게이트를 직접 등록한다. 컨트롤러는 `ControllerBase`를 상속한 클래스에 `[Route]`·`[HttpGet]` 특성을 붙이고 `AddControllers()`·`MapControllers()`로 연결한다. 둘 다 같은 엔드포인트 라우팅 위에서 동작하므로 한 앱에서 섞어 쓸 수 있다. 공식 문서는 새 프로젝트에 Minimal API를 권장하고, `IModelBinder` 확장·`IModelValidator`·애플리케이션 파트·OData가 필요할 때 컨트롤러를 고르라고 안내한다.

Spring 대응: 컨트롤러는 `@RestController`, `MapGet`은 함수형 `RouterFunction`, `[FromBody]`는 `@RequestBody`, 데이터 어노테이션 검증은 `@Valid`에 해당한다.

Minimal API의 바인딩 소스는 명시하지 않으면 다음 순서로 추론된다.

1. `[FromRoute]`·`[FromQuery]`·`[FromHeader]`·`[FromBody]`·`[FromForm]`·`[FromServices]`·`[AsParameters]` 명시 특성
2. `HttpContext`·`ClaimsPrincipal`·`CancellationToken`·`IFormFile`·`Stream` 같은 특수 타입
3. 타입에 정적 `BindAsync`가 있으면 그 메서드
4. `string`이거나 정적 `TryParse`가 있으면 라우트 템플릿에 같은 이름이 있을 때 라우트, 없으면 쿼리
5. DI 컨테이너에 등록된 서비스
6. 나머지는 본문 JSON

==GET·HEAD·OPTIONS·DELETE는 본문을 암묵 바인딩하지 않으므로, 이 메서드의 핸들러에 `TryParse`가 없는 복합 타입 파라미터를 두면 앱 시작 시점에 예외가 난다.== 폼 데이터는 `[FromForm]`을 명시해야 JSON 본문과 구분된다. 컨트롤러의 `[ApiController]`도 비슷한 추론(복합 타입은 본문, 단순 타입은 라우트·쿼리)을 적용하고 특성 라우팅을 강제하며, `ModelState` 오류 시 자동으로 400 `ValidationProblemDetails`를 반환한다.

바인딩 실패는 `TryParse` false·JSON 역직렬화 실패가 400, Content-Type 불일치가 415, `BindAsync` 예외가 500이다. ==nullable 파라미터라도 값이 형식에 맞지 않으면 기본값으로 대체되지 않고 핸들러 자체가 실행되지 않는다.==

검증은 .NET 10부터 Minimal API에 내장됐다. `builder.Services.AddValidation()`을 호출하면 소스 생성기가 데이터 어노테이션·`IValidatableObject`가 붙은 파라미터 타입을 찾아 핸들러 진입 전에 검사하고, 실패 시 400 `HttpValidationProblemDetails`를 돌려준다. 엔드포인트별로 `.DisableValidation()`으로 끌 수 있다.

응답은 `Results`보다 `TypedResults`를 권장한다. `Results<Ok<Todo>, NotFound>` 유니언 반환 타입을 쓰면 상태 코드와 스키마가 OpenAPI 메타데이터로 자동 유추된다.

## 코드

라우트 그룹·바인딩 추론·내장 검증·유니언 반환 타입을 한 번에 구성한다.

```csharp
// Program.cs
using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseInMemoryDatabase("todos"));
builder.Services.AddValidation();   // .NET 10 내장 검증
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var todos = app.MapGroup("/todos").WithTags("Todos");

// page·size는 쿼리에서, db는 DI에서 바인딩
todos.MapGet("/", async ([AsParameters] Paging paging, TodoDb db) =>
    await db.Todos.Skip((paging.Page - 1) * paging.Size)
                  .Take(paging.Size).ToListAsync());

todos.MapGet("/{id:int}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
    await db.Todos.FindAsync(id) is { } todo
        ? TypedResults.Ok(todo)
        : TypedResults.NotFound())
    .WithName("GetTodo");

// CreateTodo는 복합 타입이므로 POST 본문 JSON으로 추론, 검증 실패 시 400
todos.MapPost("/", async Task<Created<Todo>> (CreateTodo input, TodoDb db) =>
{
    var todo = new Todo { Title = input.Title, DueDate = input.DueDate };
    db.Todos.Add(todo);
    await db.SaveChangesAsync();
    return TypedResults.Created($"/todos/{todo.Id}", todo);
});

app.Run();

record struct Paging(int Page = 1, int Size = 20);
record CreateTodo([Required, StringLength(100)] string Title, DateOnly? DueDate);

class Todo
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public DateOnly? DueDate { get; set; }
}

class TodoDb(DbContextOptions<TodoDb> options) : DbContext(options)
{
    public DbSet<Todo> Todos => Set<Todo>();
}
```

같은 기능을 컨트롤러로 옮기면 `[ApiController]`가 바인딩 추론과 자동 400을 담당한다. `Program.cs`에는 `AddControllers()`·`MapControllers()`만 추가한다.

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

[ApiController]
[Route("api/[controller]")]
public class TodosController(TodoDb db) : ControllerBase
{
    [HttpGet("{id:int}")]
    public async Task<ActionResult<Todo>> Get(int id) =>
        await db.Todos.FindAsync(id) is { } todo ? todo : NotFound();

    [HttpPost]
    public async Task<ActionResult<Todo>> Create(CreateTodo input) // [FromBody] 추론
    {
        var todo = new Todo { Title = input.Title, DueDate = input.DueDate };
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return CreatedAtAction(nameof(Get), new { id = todo.Id }, todo);
    }
}
```

쿼리 문자열의 커스텀 형식은 정적 `TryParse`만 정의하면 별도 등록 없이 바인딩된다.

```csharp
public readonly record struct DateRange(DateOnly From, DateOnly To)
{
    public static bool TryParse(string? value, IFormatProvider? provider, out DateRange result)
    {
        result = default;
        if (value?.Split("..") is [var f, var t]
            && DateOnly.TryParse(f, provider, out var from)
            && DateOnly.TryParse(t, provider, out var to))
        {
            result = new DateRange(from, to);
            return true;
        }
        return false;
    }
}

// GET /todos/due?range=2026-09-01..2026-09-30
todos.MapGet("/due", (DateRange range, TodoDb db) =>
    db.Todos.Where(t => t.DueDate >= range.From && t.DueDate <= range.To));
```

## 실무에서 걸리는 지점

- ==`AddValidation()`의 소스 생성기는 호출한 어셈블리만 스캔하므로, 엔드포인트와 모델을 별도 프로젝트로 분리했다면 그 어셈블리 안에서 `AddValidation()`을 호출하는 확장 메서드를 두어야 한다.==
- .NET 10부터 본문 JSON 역직렬화가 `Stream` 대신 `PipeReader`를 사용한다. ==커스텀 `JsonConverter`가 `Utf8JsonReader.HasValueSequence`를 처리하지 않으면 버퍼 경계에 걸친 큰 본문에서만 파싱이 깨진다.==
- Minimal API의 `[FromForm]` 복합 타입은 MVC 모델 바인딩을 쓰지 않아 `[BindNever]`·`[BindRequired]`가 무시된다. 과잉 게시 방지는 허용 속성만 가진 DTO로 해결한다.
- `[ApiController]`의 자동 400은 액션 실행 전에 응답을 끝내므로 `ModelState`를 직접 다루는 코드는 도달하지 않는다. 포맷을 바꾸려면 `InvalidModelStateResponseFactory`, 끄려면 `SuppressModelStateInvalidFilter`를 쓴다.

## 관련 글

- [ASP.NET Core 기본 — 호스트·Program.cs·미들웨어 파이프라인](/notes/dotnet/aspnet-core-fundamentals/)
- [예외 처리와 ProblemDetails — 미들웨어·필터](/notes/dotnet/error-handling-filters/)
- [인증과 인가 — JWT Bearer·정책·Identity](/notes/dotnet/authentication-authorization/)
