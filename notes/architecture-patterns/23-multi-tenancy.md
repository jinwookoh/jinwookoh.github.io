---
title: "멀티테넌시 — 테넌트별 데이터 격리 전략"
series: architecture-patterns
part: "API·운영"
order: 23
summary: "하나의 애플리케이션이 여러 고객사를 서비스할 때 데이터를 어느 계층에서 어떤 강도로 격리할지 세 방식으로 비교한다"
tags: [Multi-tenancy, Hibernate, AbstractRoutingDataSource, SaaS]
sources: [https://jinwookoh.tistory.com/250]
updated: 2026-09-06
---

SaaS 형태로 여러 고객사에 같은 애플리케이션을 제공하면, 고객사 A의 사용자가 고객사 B의 데이터를 조회할 수 없어야 한다는 요구가 처음부터 따라온다. 이 요구를 설계 단계에서 정하지 않으면 두 방향으로 문제가 생긴다. 고객사마다 서버와 DB를 통째로 복제하면 고객사 수에 비례해 인프라 비용과 배포 횟수가 늘어나고, 반대로 모든 데이터를 한 테이블에 넣고 컬럼 하나로 구분하면 조건 하나가 빠진 쿼리가 곧바로 타 고객사 데이터 유출로 이어진다. 멀티테넌시는 하나의 애플리케이션 인스턴스가 여러 테넌트를 처리하되, 테넌트 간 데이터 격리를 어느 계층에서 어떤 강도로 보장할지 결정하는 패턴이다.

## 핵심 개념

테넌트(tenant)는 데이터와 설정을 공유하는 단위이며, 보통 고객사 하나가 테넌트 하나에 대응한다. 격리 전략은 데이터를 어디까지 공유하는지에 따라 세 단계로 나뉜다.

| 방식 | 격리 수준 | 비용 | 스키마 변경 | 적합한 경우 |
|---|---|---|---|---|
| Database per Tenant | 물리적 격리 | 테넌트 수에 비례 | 테넌트 수만큼 반복 | 규제 산업, 고단가 B2B |
| Schema per Tenant | 같은 인스턴스 안에서 스키마 분리 | 중간 | 스키마 수만큼 반복 | 테넌트 수백 개 이하 B2B |
| Shared Schema | 논리적 격리, 컬럼으로 구분 | 고정 | 한 번 | B2C, 저가형 SaaS, 테넌트가 많은 경우 |

Database per Tenant는 테넌트마다 독립된 DB 인스턴스를 둔다. 한 테넌트의 데이터가 다른 테넌트의 쿼리 결과에 나타날 경로 자체가 없고, 특정 테넌트의 부하(noisy neighbor)가 다른 테넌트의 성능에 영향을 주지 않으며, 테넌트 단위 백업·복구·삭제가 단순하다. 대신 DB 인스턴스 비용이 테넌트 수만큼 늘고 커넥션 풀도 테넌트마다 따로 유지해야 한다.

Schema per Tenant는 하나의 DB 인스턴스 안에 테넌트별 스키마를 두는 절충안이다. 인스턴스 비용은 아끼면서 테이블 수준의 분리는 유지하지만, 마이그레이션은 여전히 스키마 수만큼 반복된다.

Shared Schema는 모든 테넌트가 같은 테이블을 쓰고 각 행에 tenant_id 컬럼을 두어 구분한다. 인프라 비용이 가장 낮고 DDL 한 번으로 전 테넌트에 반영되지만, 격리가 전적으로 애플리케이션 코드의 WHERE 조건에 의존한다.

어느 방식이든 공통으로 필요한 것이 테넌트 식별과 전파다. 요청의 서브도메인, 헤더, 또는 인증 토큰의 클레임에서 테넌트 ID를 추출해 요청 범위 컨텍스트에 저장하고, 데이터 접근 계층이 이 값을 읽어 DB를 고르거나 조건을 붙인다. 클라이언트가 임의로 보낸 헤더 값을 그대로 믿으면 테넌트 ID만 바꿔 다른 고객사 데이터를 읽을 수 있으므로, 인증된 주체가 그 테넌트에 속하는지 검증한 값만 컨텍스트에 넣어야 한다.

## 코드

인증 토큰의 클레임에서 테넌트 ID를 읽어 컨텍스트에 저장하고, 요청이 끝나면 반드시 비우는 필터다.

```java
@Component
public class TenantFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken jwtAuth)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED);
            return;
        }
        String tenantId = jwtAuth.getToken().getClaimAsString("tenant_id");
        try {
            TenantContext.set(tenantId);
            chain.doFilter(request, response);
        } finally {
            TenantContext.clear();
        }
    }
}

public final class TenantContext {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    public static void set(String tenantId) { CURRENT.set(tenantId); }
    public static String get() { return CURRENT.get(); }
    public static void clear() { CURRENT.remove(); }
}
```

Database per Tenant 방식에서 컨텍스트의 테넌트 ID로 DataSource를 고르는 라우팅 설정이다.

```java
public class TenantRoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return TenantContext.get();
    }
}

@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(TenantDataSourceProperties props) {
        Map<Object, Object> targets = new HashMap<>();
        props.tenants().forEach((id, cfg) ->
                targets.put(id, DataSourceBuilder.create()
                        .url(cfg.url())
                        .username(cfg.username())
                        .password(cfg.password())
                        .build()));

        TenantRoutingDataSource routing = new TenantRoutingDataSource();
        routing.setTargetDataSources(targets);
        routing.setLenientFallback(false);
        routing.afterPropertiesSet();
        return routing;
    }
}
```

Shared Schema 방식에서 Hibernate 6의 `@TenantId`로 조회 조건과 삽입 값을 자동 처리하는 엔티티와 리졸버다.

```java
@Entity
@Table(name = "orders")
public class Order {
    @Id @GeneratedValue
    private Long id;

    private String productName;

    @TenantId
    @Column(name = "tenant_id", nullable = false)
    private String tenantId;
}

@Component
public class TenantResolver
        implements CurrentTenantIdentifierResolver<String>, HibernatePropertiesCustomizer {

    @Override
    public String resolveCurrentTenantIdentifier() {
        return TenantContext.get();
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return true;
    }

    @Override
    public void customize(Map<String, Object> hibernateProperties) {
        hibernateProperties.put(AvailableSettings.MULTI_TENANT_IDENTIFIER_RESOLVER, this);
    }
}
```

`orderRepository.findAll()`을 호출하면 Hibernate가 `WHERE tenant_id = ?`를 붙이고, `save()` 시에는 컨텍스트의 값을 tenant_id에 채운다.

## 실무에서 걸리는 지점

- ==`@TenantId`의 자동 조건은 JPQL과 Criteria 쿼리에만 붙고 네이티브 SQL과 JDBC 직접 호출에는 적용되지 않는다.== 통계나 배치용 네이티브 쿼리는 tenant_id 조건을 직접 써야 하며, 이 경로를 테스트로 강제하지 않으면 유출은 조용히 일어난다. DB 계층에 row-level security를 추가로 걸어 이중 방어를 두는 편이 안전하다.
- ThreadLocal 기반 컨텍스트는 요청 스레드를 벗어나는 순간 사라진다. ==`@Async`, 스케줄러, 메시지 리스너로 넘긴 작업에서는 테넌트 ID를 명시적으로 전달하지 않으면 null 테넌트로 실행되거나 잘못된 DB로 라우팅된다.== 필터의 finally에서 clear를 빠뜨리면 스레드 풀이 재사용되는 다음 요청이 이전 테넌트를 물려받는다.
- Database per Tenant는 테넌트마다 커넥션 풀을 따로 가진다. 테넌트가 500개이고 풀 최소 크기가 10이면 유휴 커넥션만 5,000개가 되므로, 풀 최소 크기를 0에 가깝게 잡고 유휴 타임아웃을 두거나 오래 쓰지 않은 테넌트의 DataSource를 지연 생성·해제하는 구조가 필요하다.
- 스키마 마이그레이션은 테넌트 수만큼 반복된다. Flyway나 Liquibase를 각 DataSource에 대해 순회 실행하는 단계를 애플리케이션 기동이 아닌 별도 배포 단계로 분리해야 하며, ==일부 테넌트만 마이그레이션이 실패한 상태에서 새 코드가 배포되면 테넌트별로 스키마 버전이 갈라져 되돌리기 어렵다.==
- Shared Schema에서 tenant_id는 대부분의 조회 조건에 들어가므로 복합 인덱스의 선두 컬럼으로 둔다. 특정 테넌트가 전체 행의 대부분을 차지하면 다른 테넌트의 쿼리 계획까지 영향을 받으므로, 그 테넌트를 별도 DB로 분리하거나 tenant_id 기준으로 샤딩할 시점이다.

## 관련 글

- [샤딩 — 수평 분할과 샤드 키 선택](/notes/architecture-patterns/sharding/)
- [인증 상태 관리 — 세션과 JWT](/notes/architecture-patterns/session-vs-jwt/)
- [벌크헤드 — 스레드 풀·세마포어로 자원 격리](/notes/architecture-patterns/bulkhead/)
