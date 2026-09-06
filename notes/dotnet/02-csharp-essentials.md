---
title: "C# 핵심 — record·패턴 매칭·nullable·LINQ"
series: dotnet
part: "기초"
order: 2
summary: "ASP.NET Core·EF Core 코드를 읽는 데 필요한 C# 문법 네 가지를 Java 대응 개념과 함께 정리한다"
tags: [C#, record, "pattern matching", nullable, LINQ]
sources: [https://learn.microsoft.com/en-us/dotnet/csharp/tour-of-csharp/overview, https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14, https://learn.microsoft.com/en-us/dotnet/csharp/nullable-references, https://learn.microsoft.com/en-us/dotnet/csharp/linq/]
updated: 2026-09-06
---

C#을 Java와 문법이 비슷한 언어로 보고 넘어가면 ASP.NET Core와 EF Core 코드의 절반이 읽히지 않는다. DTO는 `record`로 선언되고, 분기는 `switch` 식과 패턴으로 쓰이며, 타입 뒤의 `?`와 `!`가 컴파일 경고를 좌우하고, 데이터 접근은 LINQ 체인이다. 모르면 경고를 `!`로 덮어 런타임 `NullReferenceException`을 만들거나, SQL로 번역되지 않는 쿼리를 실행 시점에야 발견한다.

## 핵심 개념

### record — 값 동등성과 불변 복사

`record`는 컴파일러가 `Equals`·`GetHashCode`·`ToString`·해체를 합성하는 타입이다. `record class`는 참조 타입, `record struct`는 값 타입이며 위치 매개변수로 선언하면 생성자와 `init` 전용 프로퍼티가 함께 만들어진다. `with` 식은 원본을 복사해 지정한 멤버만 바꾼 새 인스턴스를 돌려준다. Java 16의 `record`와 같은 목적이지만 상속과 `with` 식이 있다.

값 동등성은 멤버를 하나씩 `Equals`로 비교한다. ==컬렉션 프로퍼티를 가진 record는 내용이 같아도 참조가 다르면 불일치로 판정되므로 테스트나 캐시 키에서 조용히 어긋난다.== 이 경우 동등성을 직접 정의한다.

### 패턴 매칭

`is`와 `switch`가 타입·프로퍼티·관계·리스트 패턴을 받는다. 타입 패턴은 검사와 변수 선언을 한 번에 하고, 프로퍼티 패턴 `{ Status: >= 500 }`은 중첩 멤버를 검사하며, 리스트 패턴 `[var first, .. var rest]`는 시퀀스를 분해한다. `switch` 식은 값을 반환하고 모든 경우를 다루지 못하면 경고가 난다. Java 21의 sealed interface + record + switch 패턴에 해당한다. `is not null`은 사용자 정의 `==`를 우회하므로 null 검사 표준이다.

### nullable 참조 타입

`string`은 null이 아닌 값, `string?`는 null이 가능한 값이라는 의도를 선언하고, 컴파일러가 흐름 분석으로 각 지점의 null 상태를 추적해 경고를 낸다. 런타임 타입은 둘 다 `System.String`이며 실행 동작은 바뀌지 않는다. Java의 `Optional<T>`가 아니라 Kotlin의 nullable 타입에 가깝다.

분석은 메서드 경계를 넘지 않으므로 검사 메서드가 호출자에게 상태를 전달하려면 `[NotNullWhen(true)]`·`[MemberNotNull]` 특성을 시그니처에 붙인다. `!`는 경고만 끄는 것이라 실제 null이면 그대로 예외가 난다. 최근 템플릿은 `<Nullable>enable</Nullable>`이 기본이다.

### LINQ — IEnumerable과 IQueryable

쿼리 구문과 메서드 구문은 컴파일 결과가 같으며, `Count`·`Max`처럼 절이 없는 연산자는 메서드로만 쓴다. 쿼리는 `foreach`나 `ToList` 같은 실체화 호출 전까지 실행되지 않는다.

핵심 차이는 대상 타입이다. `IEnumerable<T>` 쿼리는 델리게이트로 컴파일되어 메모리에서 실행되고, `IQueryable<T>` 쿼리는 식 트리로 컴파일되어 EF Core 같은 공급자가 SQL로 번역한다. Java로 보면 전자는 Stream API, 후자는 JPA Criteria나 QueryDSL이다. `DbSet<T>`는 `IQueryable<T>`이므로 `ToListAsync` 시점에 SQL 한 번으로 실행된다.

### C# 14에서 추가된 것

`field` 키워드는 백킹 필드 선언 없이 접근자 본문에서 합성 필드를 참조한다. `extension` 블록은 확장 프로퍼티·정적 확장 멤버까지 선언한다. `?.`를 대입 왼쪽에 쓸 수 있고, 왼쪽이 null이면 오른쪽 식은 평가되지 않는다.

## 코드

sealed record 계층과 `switch` 식으로 결제 결과를 HTTP 응답으로 바꾼다. 프로퍼티·관계·리스트 패턴을 함께 쓴다.

```csharp
public abstract record PaymentResult;
public sealed record Approved(string TxId, decimal Amount) : PaymentResult;
public sealed record Declined(int Code, string Reason) : PaymentResult;
public sealed record Pending(IReadOnlyList<string> Steps) : PaymentResult;

static IResult ToResponse(PaymentResult result) => result switch
{
    Approved { Amount: > 1_000_000 } a => Results.Accepted($"/payments/{a.TxId}"),
    Approved a => Results.Ok(a with { Amount = decimal.Round(a.Amount, 2) }),
    Declined { Code: >= 500 } => Results.StatusCode(StatusCodes.Status502BadGateway),
    Declined d => Results.BadRequest(new { d.Code, d.Reason }),
    Pending { Steps: [var next, ..] } => Results.Accepted(value: new { next }),
    Pending => Results.Accepted(),
    _ => throw new UnreachableException()
};
```

nullable 특성으로 호출자에게 null 상태를 전달하고, C# 14의 `field`와 null 조건부 대입을 쓴다.

```csharp
public sealed class Customer
{
    public string Email
    {
        get;
        set => field = value?.Trim().ToLowerInvariant()
                       ?? throw new ArgumentNullException(nameof(value));
    }
    public Order? LastOrder { get; set; }
}

static bool TryFind(Dictionary<int, Customer> map, int id,
                    [NotNullWhen(true)] out Customer? customer)
    => map.TryGetValue(id, out customer);

if (TryFind(customers, 42, out var c))
{
    Console.WriteLine(c.Email.Length);   // c는 not-null 상태, ! 불필요
}
c?.LastOrder = await orders.LatestAsync(42);   // c가 null이면 오른쪽은 실행되지 않는다
```

EF Core에서 `IQueryable`을 조건부로 조립하고, DTO record로 투영한 뒤 한 번에 실행한다.

```csharp
public sealed record OrderSummary(int Id, string CustomerEmail, decimal Total);

app.MapGet("/orders", async (AppDbContext db, decimal? minTotal, CancellationToken ct) =>
{
    IQueryable<Order> query = db.Orders.AsNoTracking();
    if (minTotal is { } min)
        query = query.Where(o => o.Total >= min);        // 아직 실행되지 않는다

    List<OrderSummary> items = await query
        .OrderByDescending(o => o.CreatedAt)
        .Take(50)
        .Select(o => new OrderSummary(o.Id, o.Customer.Email, o.Total))
        .ToListAsync(ct);                                  // 여기서 SQL 한 번

    return Results.Ok(items);
});
```

## 실무에서 걸리는 지점

- **번역 불가 쿼리.** ==`IQueryable` 체인에 SQL로 옮길 수 없는 사용자 메서드를 넣으면 컴파일은 통과하고 실행 시점에 `InvalidOperationException`이 난다.== 메모리 연산은 `AsEnumerable()` 이후로 옮기되, 그 앞에서 필터와 페이징을 끝낸다.
- **지연 실행 재평가.** ==지연 실행 쿼리 변수를 여러 번 순회하면 순회 횟수만큼 쿼리가 다시 실행된다.== 결과를 재사용할 때는 `ToList`로 실체화한다.
- **nullable과 EF Core 스키마.** ==EF Core는 `string`을 NOT NULL, `string?`를 NULL 허용 컬럼으로 매핑하므로 엔티티의 `?` 유무가 마이그레이션 스키마를 결정한다.== 나중에 바꾸면 데이터 이관이 따라온다. 필수 내비게이션 프로퍼티는 `= null!;`로 초기화한다.
- **record와 EF Core 엔티티.** 변경 추적기는 인스턴스를 참조로 식별하므로 `with`로 만든 새 인스턴스는 추적되지 않는다. record는 DTO·값 객체에 쓰고 엔티티는 class로 둔다.
- **struct·배열 기본값.** `default` 구조체와 `new string[n]`은 non-nullable 멤버가 null인 채로 경고 없이 만들어진다. 컬렉션 식이나 `required`로 초기화를 강제한다.

## 관련 글

- [.NET이란 무엇인가 — Framework·Core·통합 .NET과 SDK·런타임](/notes/dotnet/what-is-dotnet/)
- [async/await와 Task — 비동기 모델과 취소](/notes/dotnet/async-await/)
- [EF Core 기본 — DbContext·마이그레이션·LINQ 쿼리](/notes/dotnet/ef-core-basics/)
