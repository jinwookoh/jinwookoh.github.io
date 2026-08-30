---
title: "Mapping과 Field Type"
series: elasticsearch
part: "인덱스와 매핑"
order: 6
summary: "Mapping은 한 번 색인되면 타입을 바꿀 수 없으므로 strict·multi-field·타입 명시를 처음부터 잡아야 한다"
tags: [Elasticsearch, Mapping, Dynamic Mapping, Multi-field, Field Type]
sources: [elasticsearch/2026-05-19-elasticsearch-mapping-deep.md, elasticsearch/2026-05-19-elasticsearch-field-types-deep.md, 2026-05-03-es-mapping.md]
updated: 2026-08-29
---

Mapping은 인덱스의 각 필드가 어떤 타입으로 색인되는지 정의하는 스키마다. RDBMS와 달리 이미 색인된 필드의 타입을 바꾸는 명령이 없다. 문자열을 `text`로 잡으면 집계가 안 되고 `keyword`로 잡으면 부분 검색이 안 되며, 고치려면 전체를 재색인해야 한다. Mapping 없이 문서를 넣으면 타입을 자동 추론해 필드를 추가하는데, 이 동작이 운영에서 필드 수 폭증과 오추론 사고를 만든다.

## 핵심 개념

### Static과 Dynamic Mapping

Static Mapping은 `mappings.properties`에 필드와 타입을 직접 선언한다. Dynamic Mapping은 처음 보는 필드를 추론해 추가하는 기본 동작으로, 문자열은 `text` + `keyword` multi-field, 정수는 `long`, 실수는 `float`가 된다. 첫 문서가 타입을 고정한다.

| `dynamic` | 새 필드 동작 | 용도 |
|---|---|---|
| `true` | 추론해 추가 | 기본값, 실험용 |
| `false` | `_source`에만 보관, 검색 불가 | 조용한 실패 |
| `strict` | 문서 거부 | 운영 표준 |

운영 인덱스는 `strict`로 잠그고 `index.mapping.total_fields.limit`(기본 1000)을 2차 방벽으로 둔다. 필드를 미리 알 수 없는 로그성 데이터는 `dynamic_templates`로 규칙(`match_mapping_type`, `match`)을 정해 허용한다.

### text vs keyword와 Multi-field

`text`는 analyzer를 거쳐 토큰으로 역색인되므로 full-text 검색에 쓰고, 정렬·집계는 불가능하다. `keyword`는 원본 그대로 한 토큰이 되어 정확 일치·정렬·집계에 쓴다. 둘 다 필요하면 `fields`로 하위 필드를 두는 multi-field로 `title`은 `text`, `title.keyword`는 `keyword`로 동시 색인한다. `ignore_above: 256`은 그 길이를 넘는 값을 keyword 색인에서 제외한다. 하위 필드마다 디스크가 늘어나므로 필요한 필드에만 둔다.

### 숫자·날짜

숫자는 값 범위에 맞춰 작은 타입으로 잡되 PK처럼 커질 수 있는 값은 `long`으로 둔다. 가격·평점처럼 소수 자릿수가 고정된 값은 `scaled_float`로 정수 저장한다. `date`는 epoch millis로 저장되며 복수 포맷은 `format`에 `||`로 나열한다. 타임존이 없으면 UTC로 해석하므로 클라이언트는 UTC + `Z`로 통일한다.

### object · nested · flattened

`object`는 중첩 JSON을 평면 키로 푼다. 배열 객체를 `object`로 두면 각 키가 독립 배열로 평탄화되어 짝이 사라지고 `first=A AND last=Y` 같은 잘못된 조합이 매치된다. `nested`는 각 객체를 별도 Lucene 문서로 색인해 짝을 보존하지만 비용이 커진다. `flattened`는 키를 미리 알 수 없는 JSON을 한 필드로 압축해 Mapping Explosion을 막는 대신 하위 키별 집계가 제한된다.

### Runtime Field와 Mapping 변경

Runtime Field는 쿼리 시점에 스크립트로 계산하는 가상 필드로, reindex 없이 파생 값을 다루지만 느리므로 자주 쓰이면 정식 필드로 옮긴다. 변경 가능한 것은 필드 추가, 하위 필드 추가, runtime field 정도다. 기존 필드의 타입·analyzer 변경, 필드 삭제, `object`↔`nested` 전환은 불가능하며 새 인덱스 → `_reindex` → alias 전환으로 처리한다. 애플리케이션은 alias만 바라봐야 무중단 전환이 된다.

## 코드

운영 표준 형태의 명시 Mapping이다.

```json
PUT /orders
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "index.mapping.total_fields.limit": 1000
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "order_id":   { "type": "keyword" },
      "amount":     { "type": "scaled_float", "scaling_factor": 100 },
      "memo":       { "type": "text", "analyzer": "nori",
                      "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "items": {
        "type": "nested",
        "properties": {
          "sku":  { "type": "keyword" },
          "name": { "type": "text", "analyzer": "nori" },
          "qty":  { "type": "integer" }
        }
      },
      "ordered_at": { "type": "date",
                      "format": "strict_date_optional_time||epoch_millis" }
    }
  }
}
```

Spring Boot 3.x에서 Elasticsearch Java Client로 같은 Mapping을 생성한다.

```java
@Component
@RequiredArgsConstructor
public class OrdersIndexInitializer {

    private final ElasticsearchClient client;

    @EventListener(ApplicationReadyEvent.class)
    public void createIndexIfAbsent() throws IOException {
        if (client.indices().exists(e -> e.index("orders")).value()) {
            return;
        }
        client.indices().create(c -> c
            .index("orders")
            .settings(s -> s.numberOfShards("3").numberOfReplicas("1")
                .mapping(m -> m.totalFields(t -> t.limit(1000L))))
            .mappings(m -> m
                .dynamic(DynamicMapping.Strict)
                .properties("order_id", p -> p.keyword(k -> k))
                .properties("amount", p -> p.scaledFloat(f -> f.scalingFactor(100.0)))
                .properties("memo", p -> p.text(t -> t.analyzer("nori")
                    .fields("keyword", f -> f.keyword(k -> k.ignoreAbove(256)))))
                .properties("items", p -> p.nested(n -> n
                    .properties("sku", q -> q.keyword(k -> k))
                    .properties("name", q -> q.text(t -> t.analyzer("nori")))
                    .properties("qty", q -> q.integer(i -> i))))
                .properties("ordered_at", p -> p.date(d -> d
                    .format("strict_date_optional_time||epoch_millis")))));
    }
}
```

로그 인덱스용 Dynamic Templates다.

```json
PUT /app-logs
{
  "mappings": {
    "dynamic_templates": [
      { "ts_as_date":  { "match": "*_at", "mapping": { "type": "date" } } },
      { "ip_as_ip":    { "match": "*_ip", "mapping": { "type": "ip" } } },
      { "obj_flat":    { "match_mapping_type": "object", "mapping": { "type": "flattened" } } },
      { "str_keyword": { "match_mapping_type": "string",
                         "mapping": { "type": "keyword", "ignore_above": 256 } } }
    ]
  }
}
```

## 실무에서 걸리는 지점

- **Mapping Explosion.** `dynamic: true`에서 가변 값을 필드 이름으로 쓰는 JSON이 들어오면 필드 수가 폭증해 클러스터 메모리가 소진된다. `strict`로 막고 가변 키 덩어리는 `flattened`로 받는다.
- **keyword 하위 필드 누락.** `text`만으로 잡은 필드에 `terms` 집계를 걸면 "Fielddata is disabled on text fields"로 실패하고 해결에는 reindex가 필요하다.
- **date 포맷 불일치.** 추론된 date 필드에 다른 형식이 들어오면 `mapper_parsing_exception`으로 거부된다. `format`을 명시하되 클라이언트를 ISO 8601 UTC로 통일하는 편이 낫다.
- **nested 남용과 미사용.** `object`로 두면 짝이 깨진 조합이 매치되고, 모든 배열에 `nested`를 쓰면 색인·쿼리 비용이 1.5~3배 늘어난다. 수만 건이 붙는 관계는 별도 인덱스로 뺀다.

## 관련 글

- [Document CRUD·Bulk·Reindex·Versioning](/notes/elasticsearch/document-crud-bulk-reindex/)
- [Analyzer와 한국어 분석 (Nori)](/notes/elasticsearch/analyzer-korean/)
- [검색 문서 모델링과 무중단 재색인](/notes/elasticsearch/document-modeling-reindex/)
