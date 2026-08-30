---
title: "DTO 매핑 — MapStruct"
series: java-spring
part: "운영·통합"
order: 36
summary: "Entity와 DTO 사이 변환 코드를 컴파일 시점에 생성해 반복과 누락을 없애는 MapStruct 표준 패턴"
tags: [MapStruct, DTO, Lombok, Spring Boot]
sources: [spring/2026-05-17-mapstruct.md]
updated: 2026-08-29
---

Entity를 API 응답으로 그대로 노출하지 않으려면 DTO로 변환하는 코드가 필요하다. 이 변환을 손으로 작성하면 Entity 하나당 정적 팩토리 메서드 하나, 필드 20개면 20줄이 붙는다. 문제는 분량보다 유지보수다. Entity에 필드가 추가됐을 때 변환 메서드를 갱신하지 않으면 응답에서 값이 조용히 빠지고, `getAmount()`를 `setAmount()`가 아닌 다른 setter에 넣는 실수는 컴파일러가 잡아 주지 않는다. 런타임 리플렉션 기반 매퍼(ModelMapper 등)는 코드를 줄여 주지만 필드 이름이 어긋나도 실행 전까지 알 수 없고, 매 호출마다 리플렉션 비용이 든다. MapStruct는 이 두 문제를 컴파일 시점 코드 생성으로 해결한다.

## 핵심 개념

MapStruct는 어노테이션 프로세서다. 개발자는 `@Mapper`가 붙은 인터페이스에 메서드 시그니처만 선언하고, 컴파일러가 그 시그니처를 매핑 규칙으로 읽어 구현 클래스를 `build/generated/sources` 아래에 생성한다. 생성된 코드는 getter와 setter를 직접 호출하는 평범한 자바 코드이므로 실행 성능은 수동 매핑과 같고, 디버거로 한 줄씩 따라갈 수 있다.

매핑 규칙의 기본은 이름 일치다. 소스 객체의 프로퍼티와 대상 객체의 프로퍼티 이름이 같으면 자동으로 연결된다. 이름이 다르거나 중첩 객체의 값을 끌어와야 하면 `@Mapping(source, target)`으로 명시하고, `source`에는 `user.name` 같은 점 표기로 중첩 경로를 적을 수 있다. 대상 필드를 건너뛰려면 `ignore = true`, 소스가 null일 때 채울 값은 `defaultValue`, 날짜와 문자열 사이 변환은 `dateFormat`으로 지정한다.

`componentModel = "spring"`을 주면 생성 클래스에 `@Component`가 붙어 일반 Bean처럼 주입받는다. Spring Boot 3 기준으로 `MappingConstants.ComponentModel.SPRING` 상수를 써도 된다.

안전 장치로 가장 중요한 옵션은 `unmappedTargetPolicy = ReportingPolicy.ERROR`다. 대상 DTO에 매핑되지 않은 필드가 하나라도 남으면 컴파일이 실패하므로, Entity나 DTO에 필드를 추가하고 매퍼를 갱신하지 않는 실수가 빌드 단계에서 드러난다. ==기본값은 WARN이라 경고가 로그에 묻히기 쉬우므로 프로젝트 전체에 ERROR를 적용하는 편이 낫다.==

이 밖에 `@MappingTarget`은 새 객체를 만들지 않고 기존 객체의 필드를 덮어쓰는 업데이트 매핑에 쓰이고, `uses`는 다른 매퍼를 위임 대상으로 등록해 중첩 객체 그래프를 자동 변환하게 한다. `List<Order>`를 `List<OrderResponse>`로 바꾸는 컬렉션 매핑은 단일 객체 메서드가 있으면 시그니처만 선언해도 생성된다.

ModelMapper와의 차이는 다음과 같다.

| 항목 | ModelMapper | MapStruct |
|---|---|---|
| 동작 방식 | 런타임 리플렉션 | 컴파일 시 코드 생성 |
| 성능 | 호출마다 리플렉션 비용 | 수동 매핑과 동일 |
| 누락 검증 | 실행 시점 | 컴파일 시점 |
| 디버깅 | 라이브러리 내부 추적 | 생성된 소스 그대로 |

## 코드

Gradle 의존성. ==Lombok을 함께 쓰면 `lombok-mapstruct-binding`이 없을 때 MapStruct가 Lombok이 생성한 getter/setter를 보지 못하므로 반드시 추가한다.==

```groovy
dependencies {
    implementation 'org.mapstruct:mapstruct:1.6.3'
    annotationProcessor 'org.mapstruct:mapstruct-processor:1.6.3'

    compileOnly 'org.projectlombok:lombok'
    annotationProcessor 'org.projectlombok:lombok'
    annotationProcessor 'org.projectlombok:lombok-mapstruct-binding:0.2.0'
}
```

주문 Entity를 응답 DTO로 변환하는 매퍼. record DTO는 생성자 매핑으로 처리되며, 중첩 필드·무시·기본값·업데이트 매핑을 한 인터페이스에 모았다.

```java
@Mapper(
        componentModel = MappingConstants.ComponentModel.SPRING,
        unmappedTargetPolicy = ReportingPolicy.ERROR,
        uses = AddressMapper.class
)
public interface OrderMapper {

    @Mapping(source = "user.name", target = "userName")
    @Mapping(source = "user.email", target = "userEmail")
    @Mapping(source = "createdAt", target = "createdAt", dateFormat = "yyyy-MM-dd HH:mm:ss")
    OrderResponse toResponse(Order entity);

    List<OrderResponse> toResponseList(List<Order> entities);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "status", constant = "PENDING")
    Order toEntity(OrderCreateRequest request);

    @BeanMapping(nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE)
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    void updateFromRequest(OrderUpdateRequest request, @MappingTarget Order entity);
}

public record OrderResponse(
        Long id, BigDecimal amount, OrderStatus status,
        String createdAt, String userName, String userEmail,
        AddressResponse address) {}
```

서비스에서는 Bean으로 주입받아 호출한다. 업데이트 매핑은 영속 상태의 Entity에 적용하면 변경 감지가 UPDATE를 발행하므로 별도 `save` 호출이 필요 없다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;
    private final OrderMapper orderMapper;

    @Transactional(readOnly = true)
    public OrderResponse findById(Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new EntityNotFoundException("order " + id));
        return orderMapper.toResponse(order);
    }

    @Transactional
    public OrderResponse update(Long id, OrderUpdateRequest request) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new EntityNotFoundException("order " + id));
        orderMapper.updateFromRequest(request, order);
        return orderMapper.toResponse(order);
    }
}
```

## 실무에서 걸리는 지점

- **Lombok 어노테이션 프로세서 순서.** `lombok-mapstruct-binding` 없이 빌드하면 "Unknown property" 또는 setter를 찾지 못한다는 오류가 난다. Gradle의 `annotationProcessor` 선언만으로는 순서가 보장되지 않으므로 바인딩 아티팩트를 반드시 넣는다.
- **`expression = "java(...)"` 남용.** 문자열 안의 자바 코드는 IDE 리팩터링과 컴파일 검증에서 빠진다. 복잡한 변환은 인터페이스에 `default` 메서드를 두거나 별도 클래스를 `uses`로 등록해 타입이 검증되는 경로로 처리한다.
- **연관 Entity와 지연 로딩.** `user.name`처럼 연관 객체를 매핑하면 트랜잭션 밖에서 `LazyInitializationException`이 나거나 컬렉션 매핑에서 N+1이 발생한다. 매핑은 트랜잭션 안에서 수행하고, 목록 조회는 fetch join으로 미리 로딩한다.
- **업데이트 매핑의 null 처리.** ==부분 수정 API에서 요청 필드가 null이면 기본 전략은 대상 필드를 null로 덮어쓴다.== `NullValuePropertyMappingStrategy.IGNORE`를 명시하지 않으면 의도치 않은 값 삭제가 DB에 반영된다.
- **생성 코드 확인 습관.** 매핑 결과가 이상하면 `build/generated/sources/annotationProcessor` 아래 `OrderMapperImpl`을 직접 연다. 어떤 필드가 어떤 getter에서 왔는지 그대로 적혀 있으므로 추측할 이유가 없다.

## 관련 글

- [계층 설계 — 서비스 레이어 분리](/notes/java-spring/layered-architecture/)
- [영속성 컨텍스트와 LazyLoading](/notes/java-spring/persistence-context-lazy-loading/)
- [연관관계·N+1·값 객체](/notes/java-spring/jpa-relations-n-plus-1/)
