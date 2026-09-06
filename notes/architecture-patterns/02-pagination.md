---
title: "페이지네이션 — 오프셋과 커서"
series: architecture-patterns
part: "데이터"
order: 2
summary: "오프셋은 건너뛴 행을 모두 읽어 뒤로 갈수록 느려지고, 커서는 인덱스 범위 조건으로 페이지 위치와 무관하게 일정한 비용을 낸다."
tags: [Pagination, Offset, Keyset, Cursor, Spring Data JPA]
sources: [https://jinwookoh.tistory.com/231]
updated: 2026-09-06
---

주문 목록 수백만 건을 한 번에 응답하면 DB는 전체를 읽고 애플리케이션은 결과를 메모리에 올린다. 그래서 목록 조회는 일정 크기로 잘라 반환한다. 문제는 자르는 방법이다. 가장 흔한 OFFSET/LIMIT는 첫 페이지와 만 번째 페이지의 비용이 다르다. 같은 API인데 페이지 번호가 커질수록 응답 시간이 선형으로 늘어나고, 모바일 피드처럼 끝없이 스크롤하는 화면에서는 조회 도중 새 행이 삽입될 때마다 같은 행이 두 번 보이거나 빠진다. 페이지네이션 방식은 깊은 페이지의 비용과 조회 중 변경에 대한 일관성, 이 두 가지를 어떻게 다루느냐로 갈린다.

## 핵심 개념

오프셋 방식은 정렬된 결과에서 앞의 N행을 건너뛰고 M행을 가져온다. SQL의 `LIMIT M OFFSET N`이고, Spring Data JPA의 `PageRequest.of(page, size)`가 이것을 만든다. 페이지 번호로 임의 위치에 접근할 수 있고, 전체 건수를 함께 세면 번호 목록 형태의 UI를 만들 수 있다. 비용이 문제다. DB는 OFFSET을 인덱스로 건너뛰지 못한다. ==OFFSET 1000000 LIMIT 10은 1,000,010행을 읽은 뒤 1,000,000행을 버리므로 조회 비용이 페이지 번호에 비례해 커진다.== 인덱스를 타더라도 엔트리를 그만큼 순회해야 하고, 인덱스에 없는 컬럼을 조회하면 행마다 테이블을 다시 찾아간다.

커서(키셋) 방식은 "몇 번째"가 아니라 "마지막으로 본 행의 다음"을 요청한다. 클라이언트가 이전 페이지 마지막 행의 정렬 키를 커서로 보내면, 서버는 `WHERE id < :cursor ORDER BY id DESC LIMIT 10`처럼 범위 조건으로 조회한다. 인덱스에서 커서 위치를 찾아 그 지점부터 10행만 읽으므로 페이지 위치와 무관하게 비용이 O(log N)이다. 건너뛰는 행이 없으니 조회 중에 앞쪽에 행이 삽입되어도 다음 페이지가 밀리지 않는다.

대신 임의 페이지 접근이 없다. 다음과 이전만 가능하고, 전체 페이지 수를 보여주려면 별도 COUNT가 필요하다. 정렬 키에도 조건이 붙는다. 유일해야 하고, 조회 사이에 값이 바뀌지 않아야 한다. 생성 시각처럼 중복 가능한 컬럼으로 정렬하면 같은 값이 페이지 경계에 걸쳤을 때 일부가 건너뛰어지므로 (created_at, id)처럼 유일한 컬럼을 덧붙여 복합 커서를 만들고, 조건도 `created_at < :t OR (created_at = :t AND id < :id)` 형태로 쓴다. 수정 시각이나 좋아요 수처럼 값이 움직이는 컬럼은 커서 자체가 이동하므로 키셋 정렬 키로 쓸 수 없다.

| 구분 | 오프셋 | 커서(키셋) |
|---|---|---|
| 조회 조건 | LIMIT M OFFSET N | WHERE key < cursor LIMIT M |
| 깊은 페이지 비용 | 페이지 번호에 비례 | 일정 |
| 임의 페이지 이동 | 가능 | 불가, 다음·이전만 |
| 삽입·삭제 중 조회 | 중복·누락 발생 | 커서 기준으로 안정 |
| 정렬 키 조건 | 제약 없음 | 유일하고 불변인 키 필요 |
| 맞는 화면 | 관리자 목록, 게시판 | 무한 스크롤 피드, 대량 조회 API |

## 코드

오프셋 방식이다. Spring Data JPA는 `Pageable`을 받으면 LIMIT/OFFSET 쿼리와 COUNT 쿼리를 함께 실행하고, 반환 타입을 `Slice`로 바꾸면 COUNT를 생략한다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {
    Page<Order> findByStatus(OrderStatus status, Pageable pageable);
    Slice<Order> findByCustomerId(Long customerId, Pageable pageable);
}

// 호출부: 0부터 시작하는 페이지 번호, 페이지 크기 상한 강제
Pageable pageable = PageRequest.of(page, Math.min(size, 100), Sort.by("id").descending());
Page<Order> result = orderRepository.findByStatus(OrderStatus.PAID, pageable);
```

키셋 방식이다. 유일 키 id를 커서로 쓰고, size + 1건을 조회해 다음 페이지 존재 여부를 판단한다. 첫 요청은 커서가 null이므로 조건 없는 메서드로 분기한다. `Limit`은 Spring Data 3.2부터 제공된다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByStatusOrderByIdDesc(OrderStatus status, Limit limit);
    List<Order> findByStatusAndIdLessThanOrderByIdDesc(OrderStatus status, Long cursor, Limit limit);
}

public record OrderPage(List<OrderResponse> items, Long nextCursor) {}

@Service
public class OrderQueryService {

    private static final int MAX_SIZE = 100;
    private final OrderRepository orderRepository;

    public OrderQueryService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(readOnly = true)
    public OrderPage findPaid(Long cursor, int size) {
        int limit = Math.min(size, MAX_SIZE);
        List<Order> rows = cursor == null
                ? orderRepository.findByStatusOrderByIdDesc(OrderStatus.PAID, Limit.of(limit + 1))
                : orderRepository.findByStatusAndIdLessThanOrderByIdDesc(OrderStatus.PAID, cursor, Limit.of(limit + 1));

        boolean hasNext = rows.size() > limit;
        List<Order> page = hasNext ? rows.subList(0, limit) : rows;
        Long nextCursor = hasNext ? page.getLast().getId() : null;
        return new OrderPage(page.stream().map(OrderResponse::from).toList(), nextCursor);
    }
}
```

복합 커서다. 생성 시각으로 정렬하되 id를 타이브레이커로 붙인다. 필터 컬럼을 앞에, 정렬 키를 뒤에 둔 복합 인덱스 (status, created_at, id)가 있어야 범위 조회로 끝난다.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    @Query("""
            select o from Order o
            where o.status = :status
              and (o.createdAt < :createdAt
                   or (o.createdAt = :createdAt and o.id < :id))
            order by o.createdAt desc, o.id desc
            """)
    List<Order> findNextByCreatedAt(OrderStatus status, Instant createdAt, Long id, Limit limit);
}
```

## 실무에서 걸리는 지점

- COUNT 쿼리 비용. `Page`는 요청마다 count 쿼리를 함께 실행한다. 수백만 건 테이블에 필터 조건이 붙으면 count가 본 쿼리보다 오래 걸리는 경우가 많다. 총 건수가 화면에 필요 없으면 `Slice`나 커서를 쓰고, 필요하면 캐시하거나 근사치로 대체한다.
- 정렬 키와 인덱스 불일치. 커서 조건과 ORDER BY가 같은 인덱스를 타야 한다. ==커서 조건 컬럼과 정렬 컬럼이 인덱스 컬럼 순서와 다르면 DB가 범위 조회 뒤 별도 정렬을 수행하므로 키셋을 써도 비용이 오프셋과 같아진다.== 실행 계획에서 정렬 단계가 사라졌는지 확인한다.
- 유일하지 않은 커서. ==created_at 하나로만 커서를 잡으면 같은 시각에 생성된 행이 페이지 경계에 걸릴 때 오류 없이 누락된다.== 반드시 유일한 컬럼을 타이브레이커로 덧붙이고, 행 비교 구문 `(created_at, id) < (:t, :id)`는 DB에 따라 인덱스를 타지 않을 수 있으니 실행 계획을 본다.
- 커서 노출. id를 그대로 내려주면 클라이언트가 순번을 유추하고 임의 값을 조작한다. 정렬 기준과 키를 함께 Base64 같은 불투명 토큰으로 인코딩해 내려주고, 파싱에 실패하거나 정렬 조건이 현재 요청과 다르면 400으로 거부한다.
- 페이지 크기 상한. 커서 방식이라도 size를 클라이언트가 정하면 한 번에 수십만 행을 읽는 요청이 들어온다. 서버가 상한을 강제하고, 그 이상은 반복 호출로 처리하게 한다.

## 관련 글

- [동시성 제어 — 비관적 락과 낙관적 락](/notes/architecture-patterns/optimistic-pessimistic-lock/)
- [ORM — Active Record와 Repository](/notes/architecture-patterns/orm-active-record-repository/)
- [캐싱 — Look-aside·Write-through·Write-behind](/notes/architecture-patterns/caching/)
