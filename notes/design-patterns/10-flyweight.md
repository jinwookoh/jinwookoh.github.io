---
title: "플라이웨이트 — 공유 상태 분리로 메모리 절약"
series: design-patterns
part: "구조"
order: 10
summary: "비슷한 객체를 수십만 개 만들 때 불변 데이터를 하나로 공유하고 가변 데이터만 개별 보관해 메모리를 줄이는 방법"
tags: [Flyweight, 구조 패턴, 캐싱, Integer cache, String pool]
sources: [https://jinwookoh.tistory.com/224]
updated: 2026-09-06
---

렌더링할 나무 객체 하나가 메시·텍스처·좌표를 모두 들고 있고 그 크기가 1KB라면, 100만 그루를 배치하는 순간 1GB가 필요하다. 나무 종류는 수십 가지뿐인데 메시와 텍스처를 100만 번 복제하는 셈이다. 서버에서도 같은 문제가 반복된다. 주문 100만 건을 메모리에 올릴 때 각 주문이 상품 마스터 정보(이름·카테고리·이미지 URL)를 필드로 복사해 가지면, 실제로 다른 값은 주문번호·수량·시각뿐인데 힙은 상품 정보 사본으로 채워진다. 플라이웨이트 패턴은 객체의 데이터를 공유 가능한 부분과 개별적인 부분으로 나눠, 공유 가능한 부분을 단 하나의 인스턴스로 유지하고 참조만 나눠 갖게 한다.

## 핵심 개념

객체의 상태를 두 종류로 분리한다.

| 구분 | 정의 | 예 | 보관 위치 |
|---|---|---|---|
| 내부 상태(intrinsic) | 문맥에 관계없이 같고 공유 가능한 값 | 나무의 종류·메시·텍스처, 글자의 폰트·크기 | 플라이웨이트 객체 내부, 불변 |
| 외부 상태(extrinsic) | 문맥마다 달라 공유할 수 없는 값 | 나무의 좌표, 글자의 위치 | 클라이언트 측 객체 또는 메서드 인자 |

플라이웨이트 객체는 내부 상태만 가지며 불변이어야 한다. 외부 상태는 플라이웨이트가 저장하지 않고, 동작이 필요할 때 인자로 받는다. `draw(x, y)`처럼 메서드 시그니처에 외부 상태가 드러나는 이유다.

공유 인스턴스는 팩토리가 관리한다. 팩토리는 내부 상태를 키로 하는 캐시를 두고, 같은 키로 요청이 오면 기존 인스턴스를 돌려주고 없을 때만 새로 만든다. 클라이언트는 `new`를 직접 호출하지 않고 항상 팩토리를 거친다. 메모리 사용량은 `N × (무거운 데이터)`에서 `종류 수 × (무거운 데이터) + N × (참조 + 가벼운 외부 상태)`로 바뀐다.

JDK에도 같은 구조가 들어 있다. 문자열 리터럴은 String pool에 한 번만 저장되어 같은 리터럴은 같은 인스턴스를 가리키고, `Integer.valueOf()`는 -128부터 127까지의 값을 미리 만들어 둔 캐시에서 반환한다. `Boolean.valueOf()`, `Character.valueOf()`(0~127)도 같은 방식이다. ==`Integer` 비교에 `==`를 쓰면 -128~127 범위에서만 true가 나오고 그 밖에서는 같은 값이라도 false가 되므로, 박싱 타입 비교는 반드시 `equals()`로 한다.== 캐시 상한은 `-XX:AutoBoxCacheMax`로 늘릴 수 있지만 하한은 고정이다.

## 코드

내부 상태만 가지는 불변 플라이웨이트와, 캐시로 인스턴스를 공유하는 팩토리다. 팩토리 캐시는 여러 스레드가 동시에 접근할 수 있으므로 `ConcurrentHashMap`을 쓴다.

```java
public record TreeModel(String type, byte[] mesh, byte[] texture) {
    public void draw(int x, int y) {
        System.out.printf("%s at (%d, %d)%n", type, x, y);
    }
}

public final class TreeModelFactory {
    private static final Map<String, TreeModel> CACHE = new ConcurrentHashMap<>();

    private TreeModelFactory() {}

    public static TreeModel of(String type) {
        return CACHE.computeIfAbsent(type, t -> new TreeModel(t, loadMesh(t), loadTexture(t)));
    }

    static int cachedCount() {
        return CACHE.size();
    }

    private static byte[] loadMesh(String type) { return new byte[512]; }
    private static byte[] loadTexture(String type) { return new byte[512]; }
}
```

외부 상태(좌표)를 가지는 클라이언트 객체다. 무거운 데이터는 참조로만 들고 있고, 그릴 때 좌표를 플라이웨이트에 넘긴다.

```java
public record Tree(int x, int y, TreeModel model) {
    public static Tree plant(int x, int y, String type) {
        return new Tree(x, y, TreeModelFactory.of(type));
    }

    public void render() {
        model.draw(x, y);
    }
}

// 사용
List<Tree> forest = new ArrayList<>();
String[] types = {"oak", "pine", "birch"};
for (int i = 0; i < 1_000_000; i++) {
    forest.add(Tree.plant(i % 1000, i / 1000, types[i % 3]));
}
System.out.println(TreeModelFactory.cachedCount()); // 3
```

Spring Boot에서 마스터성 데이터를 공유하는 예다. 상품 정보를 캐시된 불변 객체로 두고, 주문 항목은 상품 ID와 수량만 보관한다.

```java
@Service
public class ProductCatalog {
    private final ProductRepository repository;

    public ProductCatalog(ProductRepository repository) {
        this.repository = repository;
    }

    @Cacheable(cacheNames = "products", key = "#id")
    public ProductView find(long id) {
        return repository.findById(id)
                .map(p -> new ProductView(p.getId(), p.getName(), p.getCategory(), p.getImageUrl()))
                .orElseThrow(() -> new NoSuchElementException("product " + id));
    }
}

public record ProductView(long id, String name, String category, String imageUrl) {}

public record OrderLine(long productId, int quantity) {
    public String describe(ProductCatalog catalog) {
        ProductView view = catalog.find(productId);
        return view.name() + " x " + quantity;
    }
}
```

## 실무에서 걸리는 지점

- **가변 필드가 섞이면 공유가 곧 버그가 된다.** 플라이웨이트에 setter가 하나라도 있으면 한 클라이언트의 변경이 같은 인스턴스를 참조하는 모든 클라이언트에 전파된다. `record`나 `final` 필드로 불변을 강제하고, 배열·컬렉션 필드는 방어적 복사 또는 `List.copyOf()`로 감싼다.
- **캐시 키가 무한하면 캐시가 곧 누수다.** 종류가 유한한 내부 상태만 키로 삼아야 한다. ==사용자 ID나 요청 파라미터처럼 값 공간이 열려 있는 것을 키로 쓰면 팩토리 캐시가 계속 자라 OOM으로 이어진다.== 그런 값은 외부 상태이며, 키로 써야 한다면 Caffeine 같은 크기 제한·만료가 있는 캐시를 쓴다.
- **`HashMap`을 캐시로 쓰면 동시성 문제가 생긴다.** 동시 `put`은 맵 내부 구조를 깨뜨릴 수 있고, `computeIfAbsent` 없이 get-null-put 순서로 짜면 같은 키의 플라이웨이트가 두 개 만들어져 공유 전제가 무너진다. `ConcurrentHashMap.computeIfAbsent`를 쓰되, ==그 매핑 함수 안에서 같은 맵을 다시 수정하면 무한 루프나 `IllegalStateException`이 발생한다.==
- **객체 100개 수준에서는 손해다.** 팩토리 조회와 외부 상태 전달 비용이 절약분보다 크고, 코드 구조도 복잡해진다. 힙 덤프에서 같은 클래스 인스턴스가 수만 개 이상 보이고 그 필드 대부분이 중복 값일 때 도입한다.
- **동일성 비교에 의존하지 않는다.** 캐시를 거쳤으니 `==`로 비교해도 된다고 가정한 코드는 캐시 정책이 바뀌거나 역직렬화된 인스턴스가 섞이는 순간 깨진다. `Integer` 캐시와 마찬가지로 `equals()`를 기준으로 짠다.

## 관련 글

- [싱글톤 — 인스턴스 하나를 안전하게 보장하는 다섯 가지 구현](/notes/design-patterns/singleton/)
- [팩토리 — Simple Factory·Factory Method·Abstract Factory](/notes/design-patterns/factory/)
- [프록시 — 접근 제어·지연 로딩·Spring 동적 프록시](/notes/design-patterns/proxy/)
