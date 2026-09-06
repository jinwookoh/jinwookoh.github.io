---
title: "EF Core 기본 — DbContext·마이그레이션·LINQ 쿼리"
series: dotnet
part: "데이터"
order: 11
summary: "DbContext는 요청 단위 작업 세션, 스키마는 마이그레이션, 조회는 LINQ의 SQL 번역으로 다룬다"
tags: [EF Core, DbContext, Migrations, LINQ, ASP.NET Core]
sources: [https://learn.microsoft.com/en-us/ef/core/, https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/, https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/, https://learn.microsoft.com/en-us/ef/core/querying/]
updated: 2026-09-06
---

ADO.NET으로 SQL을 직접 다루면 문자열 쿼리와 행-객체 매핑 코드를 저장소마다 반복하게 되고, 엔티티에 속성을 추가했을 때 어느 환경의 DB에 반영됐는지 추적할 수단이 없어 배포마다 수작업 DDL이 따라온다. EF Core는 이를 DbContext(변경 추적과 저장), 마이그레이션(모델과 스키마의 버전 동기화), LINQ 번역(타입 검사를 받는 C# 식을 SQL로 변환)으로 나눠 맡는다. EF Core 10은 .NET 10 런타임에서만 동작하는 LTS 버전이다.

## 핵심 개념

### DbContext와 단위 작업

DbContext는 데이터베이스 세션 하나를 표현하고 DbSet<T> 속성으로 엔티티 집합을 노출한다. 생성 → 쿼리·Add로 엔티티 추적 → 변경 → SaveChangesAsync → Dispose가 한 단위 작업이다. JPA의 EntityManager와 영속성 컨텍스트에 해당하고, DbSet<T>는 Spring Data Repository와 비슷한 진입점이며, 변경 추적기는 Hibernate의 dirty checking 역할을 한다.

ASP.NET Core에서는 Program.cs에서 AddDbContext<T>로 등록하며 기본 수명은 scoped다. HTTP 요청 하나가 단위 작업 하나가 되고 요청이 끝나면 컨테이너가 Dispose한다. 컨텍스트는 DbContextOptions<T>를 받는 public 생성자를 노출해야 하며, 제네릭 옵션 타입으로 컨텍스트별 설정이 구분된다.

DbContext는 스레드 안전하지 않다. ==같은 인스턴스에서 앞선 비동기 호출을 await하지 않고 다음 작업을 시작하면 "A second operation started on this context" 예외가 나고, 감지되지 않으면 데이터가 조용히 깨진다.== 요청 스코프와 수명이 맞지 않는 경우에는 AddDbContextFactory<T>로 만들고 직접 Dispose한다.

### 마이그레이션

모델이 바뀌면 dotnet ef migrations add로 마이그레이션을 추가한다. EF는 현재 모델과 저장된 모델 스냅샷을 비교해 Up/Down 코드를 생성하고, 적용 이력은 DB의 __EFMigrationsHistory 테이블에 기록한다. Flyway·Liquibase와 달리 SQL을 손으로 쓰지 않고 모델 diff로 생성한다.

적용 방식은 넷이다. dotnet ef database update는 SDK와 소스가 필요해 로컬 개발용이고, 자동 배포에는 SDK 없이 실행되는 단일 파일 번들(efbundle)을, DBA 검토가 필요하면 --idempotent SQL 스크립트를 권한다. 런타임 MigrateAsync는 앱 계정에 DDL 권한을 요구한다. 스크립트를 제외한 세 방식은 EF Core 9부터 DB 전역 잠금을 잡고 실행하므로 여러 인스턴스가 동시에 시도해도 충돌하지 않는다.

### LINQ 쿼리

DbSet<T>에 붙인 LINQ 연산자는 식 트리로 쌓였다가 ToListAsync·SingleAsync 같은 종단 연산에서 프로바이더가 SQL로 번역한다. 결과 엔티티가 이미 추적 중이더라도 쿼리는 항상 DB를 거친다. JPQL·QueryDSL에 해당하지만 문자열이 아닌 컴파일러 검사 식이다. 조회 전용이면 AsNoTracking으로 추적 비용을 없애고, Select 투영으로 필요한 컬럼만 읽으며, 대량 갱신·삭제는 엔티티를 로드하지 않고 ExecuteUpdateAsync·ExecuteDeleteAsync로 SQL 한 번을 보낸다.

EF Core 10에서는 LeftJoin·RightJoin이 번역되고, 쿼리 필터에 이름을 붙여 선택 해제할 수 있으며, ExecuteUpdateAsync가 일반 람다를 받아 조건부 SetProperty가 가능하다.

## 코드

Program.cs 등록. 연결 문자열은 구성에서 읽는다.

```csharp
var builder = WebApplication.CreateBuilder(args);

var cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("ConnectionStrings:Default 누락");

builder.Services.AddDbContext<ShopContext>(options =>
    options.UseNpgsql(cs, npgsql => npgsql.EnableRetryOnFailure()));

var app = builder.Build();
```

컨텍스트와 엔티티 정의. 주 생성자로 DbContextOptions<T>를 받고, 모델 구성은 OnModelCreating에 둔다.

```csharp
using Microsoft.EntityFrameworkCore;

public sealed class ShopContext(DbContextOptions<ShopContext> options) : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Customer>(b => b.Property(c => c.Name).HasMaxLength(100));

        modelBuilder.Entity<Order>(b =>
        {
            b.Property(o => o.Total).HasPrecision(18, 2);
            b.ComplexProperty(o => o.ShippingAddress);          // 같은 테이블의 컬럼으로 분할
            b.HasQueryFilter("SoftDelete", o => !o.IsDeleted);  // 이름 있는 전역 필터
        });
    }
}

public sealed class Customer
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
    public required Address ShippingAddress { get; set; }
    public bool IsDeleted { get; set; }
}

public sealed class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string ZipCode { get; set; }
}
```

마이그레이션 명령. 로컬은 database update, 배포는 CI에서 만든 번들을 배포 잡에서 한 번 실행한다.

```bash
dotnet tool install --global dotnet-ef        # 최초 1회, EF Core 패키지와 같은 메이저 버전
dotnet ef migrations add InitialCreate
dotnet ef database update                     # 로컬 개발용

dotnet ef migrations has-pending-model-changes                      # CI: 누락 마이그레이션 검출
dotnet ef migrations script --idempotent -o artifacts/migrations.sql
ASPNETCORE_ENVIRONMENT=Production \
  dotnet ef migrations bundle --self-contained --target-runtime linux-x64 -o artifacts/efbundle
./efbundle --connection "$DEPLOYMENT_CONNECTION_STRING"             # 배포 잡에서 1회 실행
```

Minimal API 조회·갱신. 추적 없는 투영, LeftJoin, 람다 기반 ExecuteUpdateAsync를 사용한다.

```csharp
app.MapGet("/customers/{id:int}/orders", async (int id, ShopContext db, CancellationToken ct) =>
    await db.Orders
        .AsNoTracking()
        .Where(o => o.CustomerId == id)
        .OrderByDescending(o => o.Id)
        .Select(o => new OrderSummary(o.Id, o.Total, o.ShippingAddress.City))
        .ToListAsync(ct));

// 주문이 없는 고객도 포함 — LEFT JOIN 으로 번역
app.MapGet("/customers/with-orders", async (ShopContext db, CancellationToken ct) =>
    await db.Customers
        .LeftJoin(db.Orders, c => c.Id, o => o.CustomerId,
            (c, o) => new { c.Name, OrderId = (int?)o.Id, Total = (decimal?)o.Total })
        .ToListAsync(ct));

// 엔티티를 로드하지 않고 UPDATE 한 번, 조건부 SetProperty
app.MapPost("/orders/{id:int}/cancel", async (int id, bool clearTotal, ShopContext db, CancellationToken ct) =>
{
    var affected = await db.Orders
        .Where(o => o.Id == id)
        .ExecuteUpdateAsync(s =>
        {
            s.SetProperty(o => o.IsDeleted, true);
            if (clearTotal) s.SetProperty(o => o.Total, 0m);
        }, ct);
    return affected == 0 ? Results.NotFound() : Results.NoContent();
});

app.Run();

record OrderSummary(int Id, decimal Total, string City);
```

## 실무에서 걸리는 지점

- **시작 시 MigrateAsync**: 잠금 덕에 동시 실행은 막히지만 앱 계정에 DDL 권한이 필요하고 롤백 경로가 없다. ==EF Core 9부터 Migrate()는 마지막 마이그레이션 이후 모델 변경이 남아 있으면 PendingModelChangesWarning으로 예외를 던진다.== CI에서 has-pending-model-changes로 걸러낸다. EnsureCreatedAsync를 먼저 부르면 이력 테이블이 없어 MigrateAsync가 실패한다.
- **생성된 마이그레이션을 읽지 않고 적용**: ==속성 이름만 바꾼 변경을 EF가 컬럼 삭제 후 추가로 해석할 수 있고, 그대로 적용하면 해당 컬럼 데이터가 사라진다.== Up과 Down 모두 검토하고 운영 데이터 복제본에서 먼저 실행한다.
- **기본 컬럼 타입**: string은 nvarchar(max), decimal은 (18, 2)로 생성된다. 운영 데이터가 쌓이면 바꾸기 어려우므로 HasMaxLength·HasPrecision을 미리 정한다.
- **EF Core 10의 json 타입 전환**: ==SQL Server 2025 호환성 수준 170 이상이거나 UseAzureSql을 쓰면 기존 nvarchar JSON 컬럼이 다음 마이그레이션에서 json 타입으로 바뀐다.== 의도가 아니면 컬럼 타입을 nvarchar(max)로 명시한다.

## 관련 글

- [C# 핵심 — record·패턴 매칭·nullable·LINQ](/notes/dotnet/csharp-essentials/)
- [의존성 주입 — 수명 주기·등록·키 서비스](/notes/dotnet/dependency-injection/)
- [EF Core 성능·트랜잭션·동시성 — 추적·N+1·낙관적 동시성](/notes/dotnet/ef-core-performance/)
