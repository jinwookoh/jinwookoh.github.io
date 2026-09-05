---
title: "온톨로지와 지식 그래프 모델링 — RDF·OWL·프로퍼티 그래프"
series: rag
part: "그래프와 온톨로지"
order: 8
summary: "RDF·OWL의 트리플과 공리, 프로퍼티 그래프의 레이블·관계를 비교해 어느 쪽으로 지식 그래프를 설계할지 정리한다"
tags: [RDF, OWL, SPARQL, Neo4j, Cypher, Knowledge Graph]
sources: [https://www.w3.org/TR/rdf11-primer/, https://www.w3.org/TR/owl2-primer/, https://neo4j.com/docs/getting-started/data-modeling/]
updated: 2026-09-05
---

문서를 청크로만 쌓아 두면 "재무팀이 승인한 계약 중 개정 정책 시행 이후 갱신된 건"처럼 개체 사이 관계를 두세 단계 따라가야 답이 나오는 질문에서 막힌다. 임베딩 유사도는 표현이 비슷한 문장을 찾을 뿐이라 같은 회사를 "㈜가나", "가나", "GANA Corp."로 적은 세 문서를 하나의 개체로 묶지 못하고, "정책 개정 이후"라는 시간 조건도 텍스트 유사도로는 걸러지지 않는다. 개체와 관계에 이름을 붙이고 규칙을 선언하는 작업이 온톨로지 모델링이고, 그 결과로 만들어진 질의 가능한 데이터가 지식 그래프다.

## 핵심 개념

계열이 둘이다. RDF는 모든 사실을 주어·술어·목적어 세 칸짜리 트리플로 쪼갠다. 주어와 술어는 전역 식별자인 IRI이고, 목적어는 IRI이거나 데이터타입·언어 태그를 가진 리터럴이다. 이름을 붙일 필요가 없는 중간 개체는 빈 노드로 두고, 여러 그래프를 이름 붙여 묶으면 데이터셋이 된다. 트리플에는 관계 자체에 값을 붙일 자리가 없어서 "2024년에 근무했다"처럼 관계에 기간이 필요하면 그 관계를 별도 노드로 승격해야 한다.

RDFS와 OWL은 이 트리플 위에 어휘와 공리를 얹는다. `rdfs:subClassOf`로 클래스 계층을, `rdfs:domain`과 `rdfs:range`로 술어가 잇는 타입을, OWL의 `owl:TransitiveProperty`·`owl:FunctionalProperty`·`owl:disjointWith`로 관계의 성질과 배타성을 선언한다. 추론기는 이 공리에서 명시되지 않은 사실을 유도하고, 표현력과 추론 비용의 균형을 위해 EL·QL·RL 세 프로파일이 나뉜다.

프로퍼티 그래프는 반대 방향에서 출발한다. 노드에 레이블을 여러 개 붙이고, 관계는 타입과 방향을 가지며 노드와 관계 양쪽에 키-값 속성을 그대로 얹는다. 스키마는 선언적 공리가 아니라 유일성·존재 제약과 인덱스로 표현되고, 숨은 사실을 추론하는 대신 Cypher로 경로를 직접 순회한다. 모델링 절차도 도메인과 유스케이스를 먼저 적고, 그 질의가 잘 도는지 시험한 뒤 리팩터링하는 순서를 권한다.

Spring 경험에 대응시키면 OWL 공리는 JPA 엔티티 매핑보다 Drools 같은 규칙 엔진에 가깝다. 스키마가 데이터를 거부하는 게 아니라 사실을 더 만들어 낸다. 반대로 프로퍼티 그래프의 제약과 인덱스는 `@Column(unique = true)` + DDL 인덱스에 대응하고, Cypher의 가변 길이 경로 패턴은 재귀 CTE로 짜던 계층 조회를 대신한다.

| 기준 | RDF·OWL | 프로퍼티 그래프 |
|---|---|---|
| 식별자 | 전역 IRI | 내부 ID + 유일 제약 |
| 관계에 속성 | 노드로 승격 필요 | 관계에 직접 부여 |
| 스키마 역할 | 추론 공리 | 제약·인덱스 |

기관 사이 데이터 교환, 표준 어휘 재사용, 규칙 기반 추론이 목적이면 RDF 계열이 맞다. 애플리케이션 내부에서 질의 지연과 개발 속도가 우선이면 프로퍼티 그래프가 낫다.

## 코드

계약 도메인을 Turtle로 선언한다. 어휘와 인스턴스를 같은 문법으로 쓴다.

```turtle
@prefix : <https://example.com/kb/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

:Contract  a owl:Class .
:Team      a owl:Class ; rdfs:subClassOf :Org .
:approvedBy a owl:ObjectProperty ;
    rdfs:domain :Contract ; rdfs:range :Team .
:supersedes a owl:ObjectProperty , owl:TransitiveProperty .
:signedOn  a owl:DatatypeProperty ; rdfs:range xsd:date .

:c-1041 a :Contract ;
    :approvedBy :team-finance ;
    :signedOn "2026-03-11"^^xsd:date ;
    :supersedes :c-0880 .
```

SPARQL로 전이 관계를 따라 이전 버전 전체를 모은다. `supersedes`가 전이적이어도 추론기 없이 조회하려면 경로 연산자 `+`를 쓴다.

```sparql
PREFIX : <https://example.com/kb/>
SELECT ?old ?date WHERE {
  :c-1041 :supersedes+ ?old .
  OPTIONAL { ?old :signedOn ?date }
}
ORDER BY DESC(?date)
```

같은 도메인을 Neo4j로 옮기면 제약을 먼저 걸고 `MERGE`로 멱등하게 적재한다.

```cypher
CREATE CONSTRAINT contract_id IF NOT EXISTS
FOR (c:Contract) REQUIRE c.id IS UNIQUE;

MERGE (c:Contract {id: 'c-1041'})
  SET c.signedOn = date('2026-03-11')
MERGE (t:Team {id: 'team-finance'})
MERGE (c)-[r:APPROVED_BY]->(t)
  SET r.approvedAt = datetime();

MATCH (c:Contract {id: 'c-1041'})-[:SUPERSEDES*1..5]->(old:Contract)
RETURN old.id, old.signedOn ORDER BY old.signedOn DESC;
```

## 실무에서 걸리는 지점

`rdfs:domain`과 `rdfs:range`는 검증 규칙이 아니다. ==타입이 맞지 않는 값을 넣으면 오류가 나는 대신 주어에 그 클래스가 추론으로 부여되어 잘못된 분류가 조용히 쌓인다.== 실제로 입력을 거부하려면 SHACL 같은 별도 제약 언어를 얹어야 한다.

OWL은 열린 세계 가정과 고유 이름 없음 위에서 동작한다. ==명시되지 않은 사실은 거짓이 아니라 미지로 다루므로 카디널리티 공리를 데이터 검증기로 쓰면 위반이 잡히지 않는다.== 게다가 함수형 속성에 값이 둘 들어오면 오류 대신 두 값이 같은 개체라고 추론되어 개체가 병합된다.

추론 비용은 프로파일 선택에 달려 있다. 완전한 OWL 2 DL 추론은 그래프가 커지면 응답 시간을 예측하기 어렵고, 대규모 분류가 목적이면 EL, 대용량 데이터 질의가 목적이면 QL, 규칙 기반 물질화가 목적이면 RL로 범위를 좁히는 편이 안전하다.

프로퍼티 그래프에서는 관계 타입 설계가 성능을 좌우한다. ==모든 관계를 `RELATED_TO` 하나로 만들고 속성으로 종류를 구분하면 트래버설이 타입으로 가지치기를 못 해 이웃 전체를 훑는다.== 자주 거르는 축은 타입 이름 자체에 넣는다.

IRI 체계와 개체 해소 규칙은 되돌리기 가장 어려운 결정이다. ==한번 발급한 IRI가 외부 데이터셋이나 캐시에 인용되기 시작하면 나중에 규칙을 바꿔도 과거 데이터를 전부 다시 쓸 수 없다.== 초기에 네임스페이스와 식별자 생성 방식을 문서로 고정한다.

## 관련 글

- [GraphRAG — 지식 그래프 기반 검색 증강](/notes/rag/graph-rag/)
- [청킹과 인덱싱 전략](/notes/rag/chunking-indexing/)
- [RAG 평가 — 검색 품질과 생성 품질을 따로 잰다](/notes/rag/rag-evaluation/)
