---
title: "컴포지트 — 개별 객체와 트리를 같은 인터페이스로"
series: design-patterns
part: "구조"
order: 7
summary: "Leaf와 Composite를 한 타입으로 다루는 두 가지 구현 방식과 sealed 타입·Spring Composite 구현체의 함정을 정리한다"
tags: [Composite, sealed interface, CompositeCacheManager, GoF]
sources: [https://jinwookoh.tistory.com/211]
updated: 2026-09-06
---

파일 하나를 지우는 것과 폴더 하나를 지우는 것은 호출자 입장에서 같은 삭제 요청이다. 그런데 파일과 폴더가 서로 다른 타입이면 호출자는 매번 `instanceof`로 분기해야 하고, 폴더 안의 폴더를 처리하는 재귀 로직이 호출자마다 중복된다. 컴포지트 패턴은 단일 객체(Leaf)와 그것들을 담는 복합 객체(Composite)를 같은 인터페이스로 묶어, 호출자가 상대가 잎인지 가지인지 모른 채 하나의 메서드만 호출하게 만든다.

## 핵심 개념

구성 요소는 셋이다. **Component**는 공통 인터페이스이고, **Leaf**는 자식을 가질 수 없는 말단 객체이며, **Composite**는 Component 목록을 자식으로 갖고 요청을 자식들에게 위임한다. Composite가 자식으로 또 다른 Composite를 가질 수 있으므로 구조는 자연스럽게 재귀 트리가 된다. 호출자는 루트에 한 번만 요청하고 재귀는 Composite 내부에 갇힌다.

설계의 갈림길은 `add`·`remove` 같은 자식 관리 메서드를 어디에 두느냐다.

| 구분 | 투명(Transparent) 방식 | 안전(Safe) 방식 |
|:---|:---|:---|
| 자식 관리 메서드 위치 | Component 인터페이스 | Composite 구현체만 |
| Leaf에서 `add` 호출 | 런타임 예외 | 컴파일 오류 |
| 호출자 코드 | 타입 구분 없이 동일 | 추가 시 타입 확인 필요 |
| 우선하는 가치 | 일관성 | 타입 안전성 |

투명 방식은 Leaf도 `add`를 갖되 `UnsupportedOperationException`을 던진다. 호출자는 단순해지지만 잘못된 호출이 컴파일러를 통과해 실행 중에야 드러난다. 안전 방식은 인터페이스에 순수한 공통 연산만 남기고 자식 관리는 Composite에만 둔다. 잘못된 호출은 컴파일 단계에서 막히지만, 자식을 추가하려는 쪽은 상대가 Composite인지 확인하고 캐스팅해야 한다.

Java 21에서는 안전 방식의 캐스팅 비용이 크게 줄었다. Component를 `sealed interface`로 선언하고 `switch`의 타입 패턴으로 분기하면 캐스팅 없이 Composite에만 `add`를 호출할 수 있고, 하위 타입이 추가되면 `default` 없는 `switch`가 컴파일 오류를 내므로 누락된 분기를 놓치지 않는다. 다만 트리 전체에 적용되는 연산은 여전히 Component의 메서드로 두고, 타입 패턴은 자식 관리처럼 Composite에만 의미 있는 연산에 한정한다.

Spring과 JDK에도 이 구조가 여럿 있다. `CompositeCacheManager`는 여러 `CacheManager`를 하나로 묶고, `CompositeHealthContributor`는 헬스 체크를 트리로 구성하며, Micrometer의 `CompositeMeterRegistry`는 여러 레지스트리에 같은 지표를 전달한다.

## 코드

안전 방식이다. 공통 연산 `size()`만 인터페이스에 두고, 자식 관리는 `Folder`에만 둔다.

```java
import java.util.ArrayList;
import java.util.List;

public sealed interface FileSystemNode permits File, Folder {
    String name();
    long size();
}

public record File(String name, long size) implements FileSystemNode {}

public final class Folder implements FileSystemNode {
    private final String name;
    private final List<FileSystemNode> children = new ArrayList<>();

    public Folder(String name) { this.name = name; }

    @Override
    public String name() { return name; }

    @Override
    public long size() {
        return children.stream().mapToLong(FileSystemNode::size).sum();
    }

    public Folder add(FileSystemNode child) {
        children.add(child);
        return this;
    }

    public List<FileSystemNode> children() { return List.copyOf(children); }
}
```

호출자다. 크기 계산은 루트가 잎이든 가지든 같은 호출이고, 자식 추가만 타입 패턴으로 분기한다.

```java
public class FileSystemClient {

    public long totalSize(FileSystemNode root) {
        return root.size();
    }

    public void attach(FileSystemNode target, FileSystemNode child) {
        switch (target) {
            case Folder folder -> folder.add(child);
            case File file -> throw new IllegalArgumentException(
                    "파일에는 하위 노드를 추가할 수 없다: " + file.name());
        }
    }
}
```

Spring의 `CompositeCacheManager`를 구성하는 예제다. 로컬 캐시와 Redis 캐시를 하나의 `CacheManager`로 노출하며, 호출하는 쪽은 단일 매니저와 구분하지 않고 사용한다.

```java
import org.springframework.cache.CacheManager;
import org.springframework.cache.support.CompositeCacheManager;
import org.springframework.cache.caffeine.CaffeineCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.connection.RedisConnectionFactory;

@Configuration
public class CacheConfig {

    @Bean
    public CacheManager cacheManager(RedisConnectionFactory factory) {
        CaffeineCacheManager local = new CaffeineCacheManager("product");
        RedisCacheManager remote = RedisCacheManager.builder(factory)
                .initialCacheNames(java.util.Set.of("order", "member"))
                .build();

        CompositeCacheManager composite = new CompositeCacheManager(local, remote);
        composite.setFallbackToNoOpCache(false);
        return composite;
    }
}
```

## 실무에서 걸리는 지점

**순환 참조.** ==Folder에 자기 자신이나 조상 노드를 `add`하면 `size()` 같은 재귀 순회가 끝나지 않아 `StackOverflowError`로 죽는다.== 사용자 입력으로 트리를 조립하는 코드라면 `add` 시점에 조상 경로를 확인하거나 방문 집합으로 순회를 보호해야 한다.

**투명 방식의 런타임 예외.** Leaf의 `add`가 던지는 `UnsupportedOperationException`은 호출자가 잡지 않으면 요청 하나를 통째로 실패시킨다. 투명 방식을 택했다면 자식 추가 경로마다 예외 처리를 두거나, sealed 타입으로 안전 방식으로 옮기는 편이 낫다.

**부모 참조와 캐시 무효화.** 깊은 트리에서 매번 재귀로 집계하면 비용이 커서 Composite에 결과를 캐시하게 되는데, 자식이 바뀌었을 때 조상들의 캐시를 함께 무효화하려면 부모 참조가 필요하다. 부모 참조를 넣는 순간 `add`·`remove`가 양쪽을 동시에 갱신해야 하고, 한쪽만 갱신하면 트리가 조용히 불일치 상태가 된다.

**JPA 자기 참조 엔티티.** 카테고리·조직도처럼 컴포지트를 `@ManyToOne parent`와 `@OneToMany children`으로 매핑하면 루트에서 재귀 순회할 때 깊이마다 쿼리가 나간다. 트리 전체가 필요하면 한 번에 조회해 메모리에서 조립하거나, 조상 경로를 별도 컬럼에 저장하는 방식으로 재귀 조회를 피한다.

**CompositeCacheManager의 조회 순서와 폴백.** `getCache(name)`은 등록한 매니저를 순서대로 물어 처음 응답한 캐시를 돌려주므로, 두 매니저에 같은 이름의 캐시가 있으면 앞쪽 매니저가 조용히 이긴다. ==`setFallbackToNoOpCache(true)`를 켜면 오타 난 캐시 이름도 예외 없이 `NoOpCache`로 처리되어 `@Cacheable`이 아무것도 캐시하지 않은 채 정상 동작하는 것처럼 보인다.== 기본값은 `false`이며 운영에서는 그대로 두는 편이 안전하다.

## 관련 글

- [데코레이터 — 상속 없이 기능을 겹겹이 추가](/notes/design-patterns/decorator/)
- [이터레이터 — 내부 구조를 감추고 순회하기](/notes/design-patterns/iterator/)
- [방문자 — 클래스 수정 없이 연산 추가하기](/notes/design-patterns/visitor/)
