---
title: "ORM — Active Record와 Repository"
series: architecture-patterns
part: "데이터"
order: 3
summary: "Active Record는 객체가 저장을 책임지고, Data Mapper·Repository는 도메인 객체를 DB에서 떼어 낸다. JPA는 후자다."
tags: [ORM, Active Record, Data Mapper, Repository, JPA, Spring Data]
sources: [https://jinwookoh.tistory.com/233]
updated: 2026-09-06
---

관계형 DB는 행과 컬럼으로 데이터를 저장하고, 애플리케이션은 객체 그래프로 데이터를 다룬다. 이 둘을 손으로 잇기 시작하면 서비스 코드마다 SQL 문자열과 ResultSet을 필드로 옮기는 매핑 코드가 반복되고, 컬럼 하나가 바뀌면 그 컬럼을 읽는 모든 쿼리를 찾아 고쳐야 한다. ORM은 이 매핑을 한 곳에 모아 대신 수행하는 계층이며, 매핑 책임을 어디에 둘 것인가에 따라 Active Record와 Data Mapper 두 갈래로 나뉜다.

## 핵심 개념

Active Record는 테이블 행 하나를 객체 하나로 대응시키고, 그 객체가 자신을 저장·수정·삭제하는 메서드를 직접 가진다. `member.save()`, `Member.find(id)`처럼 도메인 클래스가 곧 데이터 접근 API다. Ruby on Rails의 ActiveRecord, Django ORM, Laravel Eloquent가 이 방식이다. 테이블과 클래스가 1:1이고 로직이 단순할 때 코드가 가장 짧다. 반대로 도메인 클래스가 DB 접근 라이브러리에 직접 의존하므로 DB 없이 단위 테스트를 돌리기 어렵고, 객체 하나에 데이터 표현과 영속화라는 두 책임이 붙는다. 스키마와 모델이 1:1이라는 전제가 깨지는 순간, 즉 한 객체가 여러 테이블에 걸치거나 상속 구조를 가지면 패턴이 감당하지 못한다.

Data Mapper는 도메인 객체와 테이블 사이에 매퍼라는 별도 계층을 두고, 객체는 자신이 어떻게 저장되는지 모르게 만든다. 매퍼가 객체를 읽어 INSERT·UPDATE를 만들고, 조회 결과를 객체로 조립한다. JPA의 EntityManager, Hibernate Session이 이 매퍼다. 도메인 객체가 저장 방식과 분리되므로 객체 구조를 테이블 구조와 다르게 설계할 수 있고, 매퍼를 교체하거나 흉내 내는 방식으로 테스트할 수 있다.

Repository는 Data Mapper 위에 얹는 한 단계 더 높은 추상화다. 도메인 관점에서 애그리거트를 담는 컬렉션처럼 보이는 인터페이스를 제공하고, 내부에서 매퍼를 호출한다. 호출자는 `findByEmail(email)`이나 `save(order)`만 알고 SQL이나 EntityManager를 모른다. Spring Data JPA의 `JpaRepository`가 이 역할이며, 인터페이스만 선언하면 런타임에 프록시 구현체가 만들어진다.

| 구분 | Active Record | Data Mapper + Repository |
|---|---|---|
| 저장 호출 | `member.save()` | `memberRepository.save(member)` |
| 도메인 객체의 DB 의존 | 있음 | 없음(매핑 메타데이터만) |
| 테이블과 객체의 관계 | 1:1 고정 | 다르게 설계 가능 |
| 단위 테스트 | DB 또는 대체 드라이버 필요 | Repository를 대체 구현으로 교체 |
| 코드량 | 적음 | 엔티티·Repository·서비스 분리로 많음 |

JPA를 쓰면 Data Mapper 쪽 방식을 따르는 것이지만, 엔티티가 완전히 순수하지는 않다. 매핑 애너테이션, 기본 생성자, 지연 로딩용 프록시 생성 규칙을 엔티티가 따라야 한다. 그리고 매퍼가 영속성 컨텍스트라는 1차 캐시를 가지므로, ==트랜잭션 안에서 조회한 엔티티는 save()를 호출하지 않아도 필드를 바꾸기만 하면 커밋 시점에 변경 감지로 UPDATE가 나간다.== 조회용이라 생각한 메서드에서 엔티티를 건드리면 의도치 않은 UPDATE가 나간다.

## 코드

Active Record 방식을 Java로 옮긴 형태다. 도메인 클래스가 JdbcClient를 직접 들고 있어 저장 로직과 데이터가 한 클래스에 있다.

```java
public class Member {
    private static JdbcClient jdbc;   // 애플리케이션 시작 시 주입

    private Long id;
    private String email;
    private String name;

    public static void bind(JdbcClient client) { jdbc = client; }

    public static Optional<Member> find(Long id) {
        return jdbc.sql("SELECT id, email, name FROM member WHERE id = :id")
                .param("id", id)
                .query(Member.class)
                .optional();
    }

    public void save() {
        if (id == null) {
            KeyHolder key = new GeneratedKeyHolder();
            jdbc.sql("INSERT INTO member(email, name) VALUES (:email, :name)")
                .param("email", email).param("name", name)
                .update(key);
            id = key.getKeyAs(Long.class);
        } else {
            jdbc.sql("UPDATE member SET email = :email, name = :name WHERE id = :id")
                .param("email", email).param("name", name).param("id", id)
                .update();
        }
    }
}
```

같은 기능을 Data Mapper + Repository로 나눈 형태다. 엔티티는 매핑 정보와 상태 변경 메서드만 가지고, 저장은 Repository가 맡는다.

```java
@Entity
@Table(name = "member")
public class Member {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    private String name;

    protected Member() {}   // JPA 스펙이 요구하는 기본 생성자

    public Member(String email, String name) {
        this.email = email;
        this.name = name;
    }

    public void rename(String name) {
        this.name = name;   // 변경 감지 대상
    }

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public String getName() { return name; }
}

public interface MemberRepository extends JpaRepository<Member, Long> {
    Optional<Member> findByEmail(String email);
}
```

Repository를 쓰는 서비스다. 등록은 save()를 부르고, 이름 변경은 조회한 엔티티의 메서드만 호출한다. 두 메서드 모두 트랜잭션 커밋 시점에 SQL이 나간다.

```java
@Service
@Transactional
public class MemberService {
    private final MemberRepository memberRepository;

    public MemberService(MemberRepository memberRepository) {
        this.memberRepository = memberRepository;
    }

    public Long register(String email, String name) {
        memberRepository.findByEmail(email).ifPresent(m -> {
            throw new IllegalStateException("이미 등록된 이메일: " + email);
        });
        return memberRepository.save(new Member(email, name)).getId();
    }

    public void rename(Long id, String name) {
        Member member = memberRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("회원 없음: " + id));
        member.rename(name);   // save() 없이 커밋 시 UPDATE
    }
}
```

## 실무에서 걸리는 지점

- Spring Data의 `save()`는 새 엔티티면 persist, 아니면 merge를 호출한다. ==준영속 객체를 merge하면 DB에서 현재 행을 읽은 뒤 전달한 객체의 모든 필드로 덮어쓰므로, 일부 필드만 채운 객체를 save하면 나머지 컬럼이 null로 바뀐다.== 부분 수정은 조회한 엔티티의 메서드로 처리한다.
- 새 엔티티 판정은 `@Id`가 null인지, 또는 `Persistable.isNew()`로 한다. ==UUID처럼 애플리케이션이 id를 직접 채우는 엔티티는 항상 merge로 판정되어 INSERT 전에 SELECT가 한 번 더 나간다.== 이 경우 `Persistable`을 구현하거나 `@Version` 필드를 두어 새 엔티티임을 알려야 한다.
- Repository는 테이블 단위가 아니라 애그리거트 루트 단위로 만든다. 주문 항목마다 Repository를 두면 주문의 불변식이 여러 호출 사이로 흩어지고, 항목만 따로 저장되는 경로가 생긴다.
- 엔티티에 `@Data`나 전체 setter를 붙이면 어디서든 상태를 바꿀 수 있어 변경 감지의 출처를 추적하기 어렵다. 의미 있는 이름의 변경 메서드만 열고 setter는 만들지 않는다. equals·hashCode를 필드 전체로 생성하면 id가 채워지기 전후로 해시가 바뀌어 Set에서 사라지는 문제가 생기므로 식별자 기반으로 정의한다.
- Active Record를 Java에서 흉내 내면 static 의존성 때문에 테스트마다 DB 연결을 교체해야 하고, 연관 관계와 지연 로딩을 직접 구현해야 한다. 단순 CRUD 서비스라면 Spring Data JDBC가 엔티티 순수성을 지키면서도 JPA보다 가벼운 대안이다.

## 관련 글

- [동시성 제어 — 비관적 락과 낙관적 락](/notes/architecture-patterns/optimistic-pessimistic-lock/)
- [페이지네이션 — 오프셋과 커서](/notes/architecture-patterns/pagination/)
- [CQRS — 명령과 조회 모델 분리](/notes/architecture-patterns/cqrs/)
