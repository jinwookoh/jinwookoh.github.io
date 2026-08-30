---
title: "Elasticsearch란 — Index·Document·Shard·Replica"
series: elasticsearch
part: "기초"
order: 1
summary: "Elasticsearch는 Lucene 위의 분산 검색 엔진이며, Index·Document·Shard·Replica·Mapping 다섯 단위로 데이터를 나누고 복제한다."
tags: [Elasticsearch, Lucene, Shard, Replica, Mapping]
sources: [elasticsearch/2026-05-19-elasticsearch-welcome.md, elasticsearch/2026-05-19-elasticsearch-core-concepts.md, 2026-05-03-es-core-concepts.md]
updated: 2026-08-29
---

RDBMS의 `LIKE '%검색어%'`는 인덱스를 타지 못해 전체 스캔을 하고, 형태소 분석·오타 허용·관련도 정렬을 제공하지 않는다. 대량 로그를 필드 단위로 필터하거나 임베딩 벡터로 유사 문서를 찾는 요구도 RDBMS·Redis·Kafka만으로는 풀리지 않는다. ==Elasticsearch는 JSON 문서를 넣으면 자동 색인하고, 풀텍스트 검색·집계·벡터 검색을 하나의 REST API로 처리한다.==

## 핵심 개념

Elasticsearch는 단일 머신용 자바 검색 라이브러리인 Apache Lucene 위에 클러스터링·REST API·운영 도구를 얹은 검색·분석 엔진이다. 검색의 본질은 단어에서 문서 목록을 찾는 역색인(Inverted Index)이다.

| 측면 | RDBMS | Elasticsearch |
|---|---|---|
| 핵심 용도 | 트랜잭션·정합성 | 검색·분석 |
| 인덱스 구조 | B+Tree | 역색인 |
| 관계 | JOIN·FK | 비정규화 |
| 일관성 | ACID | Near Real-Time |

==Elasticsearch는 운영 데이터의 단일 진실 원천이 아니다.== 원본은 RDBMS에 두고 검색·로그·분석용으로 병행한다. 데이터는 Cluster → Node → Index → Shard → Document 계층으로 나뉘며, 운영 환경은 master-eligible 노드를 3개 이상 두어 quorum 선출이 가능하게 한다.

**Index**는 같은 종류의 문서가 모이는 논리 컬렉션이다. 설정은 `_settings`(샤드·replica 수, refresh 주기)와 `_mappings`(필드 타입)로 나뉜다. `number_of_shards`는 생성 시점에만 정하는 static 설정이고 `number_of_replicas`·`refresh_interval`은 운영 중 바꿀 수 있다. 애플리케이션은 실제 인덱스 이름 대신 alias로 접근한다. 매핑 변경은 새 인덱스에 reindex한 뒤 alias를 교체하는 방식으로만 가능하기 때문이다.

**Document**는 인덱스에 저장되는 JSON 한 건이며 `_id`가 PK 역할을 한다. ID를 지정한 PUT은 반복해도 update가 되어 멱등성이 확보되고, ID 없는 POST는 매번 새 문서를 만든다. `_source`는 색인 시 받은 원본 JSON으로, 끄면 reindex와 update API를 쓸 수 없다. `_routing`은 샤드를 결정하는 해시 입력값으로 기본은 `_id`이며, tenant_id로 바꾸면 같은 고객의 문서가 한 샤드에 모인다. 동시성 제어는 `if_seq_no`와 `if_primary_term`을 함께 보내는 방식이 표준이다.

**Shard**는 인덱스를 쪼갠 물리 단위이며 각 샤드가 독립된 Lucene 인덱스다. Primary Shard가 쓰기를 먼저 받고 성공하면 Replica로 동기 복제된다. Primary 수는 생성 후 바꿀 수 없다. `_split`은 정수배로만 늘리고 `_shrink`는 조건이 까다로워 실제로는 reindex와 alias 교체로 푼다. 샤드 하나는 30~50GB, Primary 수는 데이터 노드 수의 1.5~3배가 기준이다.

**Replica**는 Primary의 동기 사본으로 고가용성과 읽기 분산을 담당한다. `number_of_replicas: 1`은 Primary마다 사본 1개라는 뜻이므로 Primary 5개면 총 샤드는 10개다. Replica는 Primary와 다른 노드에만 배치되므로 단일 노드에서는 unassigned로 남아 클러스터가 yellow가 된다. Replica는 백업이 아니며, 인덱스를 삭제하면 함께 사라지므로 백업은 Snapshot으로 뜬다.

**Mapping**은 필드 타입과 analyzer를 정의하는 스키마다. 매핑 없이 문서를 넣으면 첫 문서 기준으로 타입을 추론한다. `dynamic`은 `true`(자동 추가), `false`(`_source`에만 보존), `strict`(거부) 세 모드가 있고 운영 인덱스는 `strict`가 기본이다.

색인된 문서는 refresh 주기(기본 1초)가 지나야 검색되는 Near Real-Time 모델이다.

## 코드

인덱스 생성 시 샤드·replica 수와 strict 매핑을 지정하고 alias `products`를 붙인다.

```json
PUT /products_v1
{
  "settings": { "number_of_shards": 3, "number_of_replicas": 1 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "name":  { "type": "text", "analyzer": "nori",
                 "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "price": { "type": "integer" },
      "tags":  { "type": "keyword" }
    }
  },
  "aliases": { "products": {} }
}
```

Spring Boot 3.x의 `spring-boot-starter-data-elasticsearch`가 자동 구성하는 `ElasticsearchClient`를 주입받아 alias 이름으로 색인·검색한다.

```java
@Service
public class ProductIndexer {

    private final ElasticsearchClient client;

    public ProductIndexer(ElasticsearchClient client) {
        this.client = client;
    }

    public record Product(String name, int price, List<String> tags) {}

    public void index(String sku, Product product) throws IOException {
        client.index(i -> i.index("products").id(sku).document(product));
    }

    public List<Product> search(String keyword) throws IOException {
        SearchResponse<Product> res = client.search(s -> s
                .index("products")
                .query(q -> q.match(m -> m.field("name").query(keyword))),
                Product.class);
        return res.hits().hits().stream().map(Hit::source).toList();
    }
}
```

매핑 변경 시 `products_v2`에 reindex한 뒤 alias를 원자적으로 교체한다.

```json
POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}
```

## 실무에서 걸리는 지점

- ==**Mapping Explosion.** 임의의 키가 들어오는 로그 인덱스에 `dynamic: true`가 켜져 있으면 필드 수가 수천 개로 늘어 힙이 고갈된다.== `strict`로 잠그고 `index.mapping.total_fields.limit`을 1,000 수준으로 건다.
- **Primary Shard 수 미설계.** 너무 적으면 수평 확장이 막히고 너무 많으면 오버헤드가 커진다. 초기에 6처럼 `_split`이 유연한 값을 잡는다.
- **Replica 0 운영.** 데이터 노드 한 대가 죽는 순간 해당 샤드를 잃고 red가 된다. replica 1과 데이터 노드 2대가 하한이다.
- **alias 없이 인덱스 이름 직접 호출.** 매핑 변경마다 다운타임이 따라온다. 인덱스가 하나여도 alias로 노출한다.
- **`_source` 비활성화.** reindex와 partial update가 막힌다. `_source.excludes`로 큰 필드만 제외한다.

## 관련 글

- [Lucene 내부 — Segment·역색인·Posting List](/notes/elasticsearch/lucene-internals/)
- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
