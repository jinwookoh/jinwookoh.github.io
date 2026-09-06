---
title: "EF Core 성능·트랜잭션·동시성 — 추적·N+1·낙관적 동시성"
series: dotnet
part: "데이터"
order: 12
summary: "읽기 경로는 추적을 끄고 N+1·카티전 폭발은 로딩 전략으로, 쓰기는 트랜잭션 경계와 동시성 토큰으로 지킨다"
tags: [EF Core, "Change Tracking", "N+1", "Optimistic Concurrency", Transactions]
sources: [https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying, https://learn.microsoft.com/en-us/ef/core/change-tracking/, https://learn.microsoft.com/en-us/ef/core/saving/transactions, https://learn.microsoft.com/en-us/ef/core/saving/concurrency]
updated: 2026-09-06
---

EF Core는 LINQ를 SQL로 바꿔 주기 때문에 코드 한 줄이 SQL을 몇 번 보내는지 드러나지 않는다. 데이터가 적은 개발 DB에서는 멀쩡하다가 운영에서 엔티티마다 쿼리가 나가는 N+1과 읽기 전용인데도 스냅샷을 찍는 추적 비용이 드러난다. 트랜잭션 경계를 모르면 부분 커밋이 남고, 동시성 토큰이 없으면 나중 요청이 먼저 저장된 변경을 경고 없이 덮어쓴다.

## 핵심 개념

### 변경 추적과 스냅샷

`DbContext`는 쿼리로 돌려준 엔티티와 `Add`·`Attach`·`Update`로 붙인 엔티티를 추적한다. 엔티티는 `Added`·`Unchanged`·`Modified`·`Deleted` 등의 `EntityState`를 가지며, `SaveChanges`는 이 상태를 보고 바뀐 컬럼만 담은 문을 만든다. 추적 쿼리의 비용은 둘이다. 같은 행을 같은 객체로 돌려주는 동일성 해석과, 스냅샷을 떠 두었다가 저장 시점에 비교하는 변경 감지다.

읽기 경로는 `AsNoTracking()`으로 두 비용을 없앤다. 다만 비추적은 동일성 해석도 건너뛰어 같은 Blog를 참조하는 Post 100개가 Blog 인스턴스 100개를 만들며, 중복 제거가 필요하면 `AsNoTrackingWithIdentityResolution()`을 쓴다. DTO 프로젝션은 추적 자체가 없다.

### 로딩 전략과 N+1

지연 로딩은 탐색 속성에 접근할 때마다 쿼리를 보내므로 Blog 목록을 돌며 `blog.Posts`를 읽으면 Blog 수만큼 라운드트립이 붙는다. 공식 문서는 지연 로딩 대신 `Include` 또는 프로젝션으로 즉시 로딩하라고 권한다. `Include`는 JOIN 하나로 가져오지만 일대다 컬렉션을 여러 개 포함하면 부모 행이 자식 수의 곱만큼 복제되는 카티전 폭발이 생기며, 이때 `AsSplitQuery()`로 컬렉션별 쿼리를 분리한다.

### 트랜잭션 경계

`SaveChanges` 한 번은 하나의 트랜잭션이며 전부 성공하거나 전부 롤백된다. 여러 `SaveChanges`와 조회를 묶으려면 `Database.BeginTransactionAsync()`로 열고 `CommitAsync()`로 닫는다. 트랜잭션 안에서 `SaveChanges`를 부르면 EF가 저장 전에 세이브포인트를 자동으로 만들어 실패 시 그 지점까지만 되돌린다. 여러 컨텍스트가 한 트랜잭션을 공유하려면 `UseTransactionAsync()`로 등록한다.

### 낙관적 동시성

EF Core는 잠금 대신 동시성 토큰을 쓴다. 토큰 프로퍼티는 UPDATE·DELETE의 WHERE 절에 원본 값으로 들어가고, 영향 받은 행이 0이면 `DbUpdateConcurrencyException`이 난다. SQL Server에서는 `[Timestamp]`(`IsRowVersion()`)로 `rowversion` 컬럼을 매핑하고, SQLite처럼 자동 갱신 타입이 없으면 `[ConcurrencyCheck]`(`IsConcurrencyToken()`)로 애플리케이션 관리 토큰을 둔다. ==애플리케이션 관리 토큰은 저장할 때마다 코드가 새 값을 직접 넣어야 하며, 넣지 않으면 WHERE 절이 항상 통과해 충돌을 잡지 못한다.== 충돌은 예외의 `Entries`에서 현재 값과 `GetDatabaseValuesAsync()`를 비교해 병합하고 `OriginalValues`를 DB 값으로 바꾼 뒤 재시도한다.

Spring 대응: `DbContext` ≈ JPA `EntityManager`, 스냅샷 변경 감지 ≈ Hibernate dirty checking, `Include` ≈ fetch join, `BeginTransactionAsync` ≈ `@Transactional` 경계, `[Timestamp]` ≈ `@Version`, `DbUpdateConcurrencyException` ≈ `OptimisticLockException`.

## 코드

읽기 전용 목록은 추적을 끄고 컬렉션은 분리 쿼리로, 대량 결과는 프로젝션과 스트리밍으로 가져온다.

```csharp
app.MapGet("/blogs", async (BlogContext db, CancellationToken ct) =>
{
    var blogs = await db.Blogs
        .AsNoTracking()
        .Where(b => b.Rating >= 3)
        .Include(b => b.Posts.OrderByDescending(p => p.CreatedAt).Take(5))
        .Include(b => b.Tags)
        .AsSplitQuery()
        .OrderBy(b => b.Id)
        .Take(50)
        .ToListAsync(ct);

    return Results.Ok(blogs);
});

app.MapGet("/posts/export", (BlogContext db) =>
{
    // 프로젝션은 추적·스냅샷이 없고, AsAsyncEnumerable은 한 행씩 넘긴다
    var rows = db.Posts
        .Where(p => p.Title.StartsWith("EF"))
        .Select(p => new PostRow(p.Id, p.Title))
        .AsAsyncEnumerable();

    return Results.Ok(rows);
});

public record PostRow(int Id, string Title);
```

두 번의 쓰기를 한 트랜잭션으로 묶되, 재시도 실행 전략과 함께 쓰기 위해 `ExecuteAsync`로 감싼다.

```csharp
app.MapPost("/orders", async (CreateOrder dto, ShopContext db, CancellationToken ct) =>
{
    var strategy = db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        db.Orders.Add(new Order { Sku = dto.Sku, Qty = dto.Qty });
        await db.SaveChangesAsync(ct); // 트랜잭션 안이므로 세이브포인트가 자동 생성된다

        // ExecuteUpdate는 변경 추적기를 거치지 않고 바로 UPDATE를 보낸다
        await db.Inventory
            .Where(i => i.Sku == dto.Sku && i.Qty >= dto.Qty)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.Qty, i => i.Qty - dto.Qty), ct);

        await tx.CommitAsync(ct);
    });

    return Results.Created();
});

public record CreateOrder(string Sku, int Qty);
```

무상태 HTTP에서는 클라이언트가 읽은 시점의 토큰을 원본 값으로 되돌려 놓고 저장한다.

```csharp
public class Product
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] Version { get; set; } = null!;
}

app.MapPut("/products/{id:int}", async (int id, UpdateProduct dto, ShopContext db, CancellationToken ct) =>
{
    var product = await db.Products.FindAsync([id], ct);
    if (product is null) return Results.NotFound();

    db.Entry(product).Property(p => p.Version).OriginalValue = dto.Version;
    product.Price = dto.Price;

    try
    {
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
    catch (DbUpdateConcurrencyException ex)
    {
        var dbValues = await ex.Entries.Single().GetDatabaseValuesAsync(ct);

        return dbValues is null
            ? Results.NotFound()                                       // 그 사이 삭제됨
            : Results.Conflict(new { current = dbValues.ToObject() }); // 최신 값으로 재시도 유도
    }
});

public record UpdateProduct(decimal Price, byte[] Version);
```

## 실무에서 걸리는 지점

- ==재시도 실행 전략(`EnableRetryOnFailure`)이 켜진 상태에서 `BeginTransactionAsync`를 직접 호출하면 예외가 난다.== `CreateExecutionStrategy().ExecuteAsync` 안에서 열고 닫는다. 재시도 전략은 결과를 내부 버퍼링하므로 `ToListAsync`와 겹치면 메모리에 두 번 올라간다.
- ==SQL Server 연결에 MARS가 켜져 있으면 세이브포인트가 생성되지 않아, 트랜잭션 안의 `SaveChanges`가 실패하면 트랜잭션이 알 수 없는 상태로 남는다.== 옵션만 켜져 있어도 같다.
- ==`Database.AutoTransactionBehavior`를 `Never`로 두면 `SaveChanges`가 여러 문을 보내다 중간에 실패했을 때 앞선 문은 커밋된 채 남는다.== 기본값 `WhenNeeded`를 유지한다.
- INSERT는 `DbUpdateConcurrencyException`을 던지지 않고 고유 제약 위반은 공급자별 예외로 나온다. `ExecuteUpdate`·`ExecuteDelete`도 추적기를 우회해 토큰 검사가 없다.
- 배치 루프에서 컨텍스트 하나로 수만 건을 추적하면 `DetectChanges` 비용이 선형으로 는다. 주기적으로 `ChangeTracker.Clear()`를 부른다.

## 관련 글

- [EF Core 기본 — DbContext·마이그레이션·LINQ 쿼리](/notes/dotnet/ef-core-basics/)
- [async/await와 Task — 비동기 모델과 취소](/notes/dotnet/async-await/)
- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
