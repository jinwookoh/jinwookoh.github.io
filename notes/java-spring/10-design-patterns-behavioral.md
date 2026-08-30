---
title: "디자인 패턴 — 행위·조합"
series: java-spring
part: "자바 기초·모던 자바"
order: 10
summary: "행위 패턴 9가지의 역할 분담 원칙과 Observer·Strategy·Mediator를 한 시스템에 조합하는 기준을 정리한다"
tags: [Design Pattern, Observer, Strategy, Mediator, Command]
sources: [2026-05-03-design-patterns-behavioral.md, 2026-05-03-design-patterns-combinations.md]
updated: 2026-08-29
---

객체 생성과 구조를 정리해도 객체 사이의 통신과 책임 분배를 규칙 없이 두면 문제가 남는다. 결제 방식이 늘 때마다 `if-else` 분기가 자라고, 상태 변경을 알려야 할 대상이 늘 때마다 호출 코드가 흩어지며, 객체들이 서로를 직접 참조하면서 N×N 결합이 만들어진다. 한 클래스 수정이 여러 클래스에 번지고 테스트 격리도 어려워진다. GoF 행위 패턴은 이 문제에 대한 답이고, 실제 시스템에서는 여러 패턴이 동시에 결합된 형태로 나타난다.

## 핵심 개념

행위 패턴 중 자주 쓰는 아홉 가지는 다음처럼 구분한다.

| 패턴 | 목적 |
|:---|:---|
| Strategy | 알고리즘을 캡슐화해 런타임에 교체 |
| State | 내부 상태에 따라 행동 변경, 전환 로직 포함 |
| Observer | Subject 상태 변경 시 Observer에 자동 통지 |
| Mediator | 객체 간 직접 통신을 중재자 경유로 치환 |
| Command | 요청을 객체로 캡슐화해 큐잉·로깅·undo 지원 |
| Memento | 내부 상태 스냅샷을 저장·복원 |
| Template Method | 골격은 상위 클래스, 일부 단계는 하위 클래스 |
| Iterator | 내부 구조 노출 없이 순회 |
| Chain of Responsibility | 처리 가능한 핸들러까지 요청 전달 |

구조가 닮아 혼동하는 쌍은 의도로 구분한다. Strategy와 State는 둘 다 인터페이스에 행위를 위임하고 Context가 구현체를 보관하지만, Strategy는 클라이언트가 명시적으로 고르는 선택의 문제이고 State는 이벤트에 따라 내부에서 전환되는 전이의 문제다. Observer와 Mediator는 둘 다 직접 참조를 제거하지만, Observer는 Subject에서 Observer로 흐르는 1:N 단방향 통지이고 Mediator는 N:N 통신을 한 곳에서 라우팅하는 양방향 구조다. Command와 Memento는 둘 다 undo에 쓰이는데, Command는 동작을 저장해 역으로 실행하고 Memento는 상태를 저장해 직접 복원한다. Template Method는 컴파일 타임에 상속으로 단계를 고정하고, Strategy는 런타임에 객체 주입으로 알고리즘 전체를 바꾼다.

Strategy가 가장 자주 쓰이는 이유는 SOLID 세 원칙을 동시에 만족하기 때문이다. 알고리즘별로 클래스가 분리되니 SRP, Context가 인터페이스에만 의존하니 DIP, 새 전략 추가 시 기존 코드를 수정하지 않으니 OCP다. 자바에서는 `Comparator`와 람다가 이 패턴의 표준 형태이고, 단일 메서드 전략은 함수형 인터페이스로 대체하면 클래스 수가 줄어든다.

패턴 조합은 한 시스템 안에서 자연스럽게 발생한다. 승차 공유 도메인이라면 요금 정책은 Strategy, 탑승 상태 변경 통지는 Observer, 승객·운전자·탑승 객체 사이의 매칭과 통신은 Mediator가 맡는다. 자주 함께 쓰는 조합으로 Observer+Mediator(채팅·이벤트 시스템), Strategy+Factory(전략 생성 위치 집중), Composite+Visitor(트리 순회), Proxy+Decorator(접근 제어와 기능 추가 병행)가 있다. Spring에서는 `ApplicationEventPublisher`와 `@EventListener`가 Observer, `JdbcTemplate`이 Template Method, 서블릿 Filter 체인이 Chain of Responsibility에 해당한다.

## 코드

요금 정책을 Strategy로 분리하고 차량별 단가는 다형성으로 처리해 `if-else`를 제거한다. `sealed`와 `record`로 전략 집합을 컴파일 타임에 닫는다.

```java
public interface Vehicle {
    double farePerKm();
}

public record Car() implements Vehicle {
    public double farePerKm() { return 20.0; }
}

public record Bike() implements Vehicle {
    public double farePerKm() { return 10.0; }
}

public sealed interface FareStrategy permits StandardFare, SharedFare, LuxuryFare {
    double calculate(Vehicle vehicle, double distanceKm);
}

public record StandardFare() implements FareStrategy {
    public double calculate(Vehicle v, double d) { return v.farePerKm() * d; }
}

public record SharedFare() implements FareStrategy {
    public double calculate(Vehicle v, double d) { return v.farePerKm() * d * 0.5; }
}

public record LuxuryFare() implements FareStrategy {
    public double calculate(Vehicle v, double d) { return v.farePerKm() * d * 1.5; }
}
```

탑승 상태 변경 통지는 Spring 이벤트 인프라를 Observer로 사용한다. 발행자는 리스너를 알지 못한다.

```java
public enum RideStatus { SCHEDULED, ONGOING, COMPLETED }

public record RideStatusChanged(Long rideId, Long passengerId, Long driverId, RideStatus status) {}

@Service
public class RideService {
    private final ApplicationEventPublisher publisher;

    public RideService(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    @Transactional
    public void updateStatus(Ride ride, RideStatus next) {
        ride.changeStatus(next);
        publisher.publishEvent(new RideStatusChanged(
                ride.getId(), ride.getPassengerId(), ride.getDriverId(), next));
    }
}

@Component
public class RideNotificationListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(RideStatusChanged event) {
        // 승객·운전자에게 푸시 발송
    }
}
```

매칭 시스템은 Mediator 역할을 맡아 승객과 운전자가 서로를 직접 참조하지 않게 한다. 가용 운전자 목록을 한 곳에서 관리해 중복 배정을 막는다.

```java
@Service
public class RideMatchingSystem {
    private final Map<Long, Driver> availableDrivers = new ConcurrentHashMap<>();
    private final RideService rideService;

    public RideMatchingSystem(RideService rideService) {
        this.rideService = rideService;
    }

    public void addDriver(Driver driver) {
        availableDrivers.put(driver.getId(), driver);
    }

    public Optional<Ride> requestRide(Passenger passenger, double distanceKm, FareStrategy fare) {
        Optional<Driver> nearest = availableDrivers.values().stream()
                .min(Comparator.comparingDouble(
                        d -> d.getLocation().distanceTo(passenger.getLocation())));
        if (nearest.isEmpty()) {
            return Optional.empty();
        }
        Driver driver = nearest.get();
        if (availableDrivers.remove(driver.getId()) == null) {
            return Optional.empty(); // 다른 요청이 먼저 배정
        }
        Ride ride = new Ride(passenger, driver, distanceKm,
                fare.calculate(driver.getVehicle(), distanceKm));
        rideService.updateStatus(ride, RideStatus.ONGOING);
        return Optional.of(ride);
    }

    public void complete(Ride ride) {
        rideService.updateStatus(ride, RideStatus.COMPLETED);
        availableDrivers.put(ride.getDriver().getId(), ride.getDriver());
    }
}
```

## 실무에서 걸리는 지점

- **Observer 재진입 루프.** 리스너 안에서 Subject 상태를 다시 바꾸면 통지가 재귀적으로 발생한다. 커밋 이후 처리해야 하는 리스너는 `@TransactionalEventListener`로 분리한다.
- **Mediator의 God Object화.** 모든 통신이 중재자를 지나면 비즈니스 로직까지 그곳으로 모인다. 중재자는 라우팅과 조정만 맡고 도메인 규칙은 각 Colleague에 둔다.
- **Command·Memento의 비용.** 단순 호출까지 Command로 감싸면 클래스 수가 폭발하고, 모든 변경마다 Memento를 저장하면 메모리가 무한히 자란다. undo·큐잉·로깅 요구가 있을 때만 도입하고 히스토리는 `ArrayDeque`로 크기를 제한한다.
- **Iterator 순회 중 수정.** `for-each` 안에서 컬렉션을 수정하면 `ConcurrentModificationException`이 발생한다. `Iterator.remove()`나 `removeIf()`를 쓴다.
- **Chain의 종단 처리 누락.** ==끝까지 처리자가 없을 때의 동작을 정의하지 않으면 요청이 조용히 사라진다.== 기본 처리자를 두거나 예외를 던지고, 처리한 핸들러를 로그에 남긴다.
- **패턴 과잉 적용.** 변경 가능성이 없는 코드에 패턴을 먼저 넣으면 오버엔지니어링이 된다. 큰 `if-else`, 흩어진 `new`, 강한 참조망 같은 코드 냄새가 보일 때 그 부분부터 점진적으로 리팩토링한다.

## 관련 글

- [디자인 패턴 — 생성·구조](/notes/java-spring/design-patterns-creational-structural/)
- [인터페이스·다형성·SOLID](/notes/java-spring/interface-polymorphism-solid/)
- [이벤트·비동기·스케줄링](/notes/java-spring/events-async-scheduling/)
