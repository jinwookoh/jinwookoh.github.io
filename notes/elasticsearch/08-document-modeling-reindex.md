---
title: "검색 문서 모델링과 무중단 재색인"
series: elasticsearch
part: "인덱스와 매핑"
order: 8
summary: "필드 타입은 용도에서 결정하고, 매핑 변경은 alias 전환과 증분 색인으로 다운타임 없이 반영한다"
tags: [Elasticsearch, Mapping, Alias, Reindex, Outbox]
sources: [elasticsearch/2026-05-26-elasticsearch-document-modeling.md, elasticsearch/2026-05-26-elasticsearch-reindex-pipeline.md, 2026-05-03-es-search-engine-project.md]
updated: 2026-08-29
---

Elasticsearch는 한 번 색인된 필드의 타입과 분석기를 나중에 바꿀 수 없다. 역색인이 이미 그 설정으로 만들어졌기 때문이다. 매핑을 대충 잡고 운영에 올리면 정렬이 필요한 필드가 `text`로 잡혀 집계가 막히거나, 동적 매핑이 문자열마다 멀티필드를 만들어 필드 수가 폭발한다. 이를 고치려면 새 인덱스를 만들어 전체 데이터를 다시 색인해야 하는데, 애플리케이션이 실제 인덱스 이름을 직접 부르고 있으면 코드 배포와 데이터 이관이 엮여 검색 중단이 불가피해진다. 처음부터 요구사항에서 타입을 정하고, 인덱스 이름을 alias로 감싸 두는 설계가 필요한 이유다.

## 핵심 개념

### 요구사항에서 타입을 결정한다

타입 선택은 문법이 아니라 용도의 문제다. 같은 상품명이라도 전문 검색이면 `text`, 정렬·집계·정확 일치 필터면 `keyword`가 맞다.

| 필드 용도 | 타입 | 이유 |
|:---|:---|:---|
| 전문 검색 | `text` | 분석기로 토큰화해 부분·유사 검색 |
| 정확 일치·필터·정렬·집계 | `keyword` | 분석하지 않고 값 그대로 비교 |
| 숫자 범위·정렬 | `integer`·`long`·`double` | 수치 비교 |
| 기간 필터·시계열 | `date` | 날짜 범위 |
| 검색과 정렬 둘 다 | `text` + `keyword` 멀티필드 | 한 값을 두 용도로 색인 |

멀티필드는 `name`으로 검색하고 `name.keyword`로 정렬·집계하는 패턴이다. `text` 필드에 직접 정렬·집계를 걸면 fielddata가 꺼져 있어 에러가 나고, 켜더라도 힙을 크게 소모한다.

여러 필드를 검색창 하나로 묶는 경우 `copy_to`로 `title`·`body`·`tags` 값을 `search_all` 필드에 모아 두면 쿼리가 단일 필드 질의로 단순해진다. ==`copy_to` 대상 필드는 `_source`에 저장되지 않고 색인에만 존재한다.==

운영 인덱스는 `dynamic: "strict"`로 두고 필드를 명시 선언한다. 동적 매핑은 문자열마다 `text`+`keyword` 멀티필드를 만들고, `"123"`처럼 숫자로 보이는 값이 먼저 들어오면 타입을 잘못 추론해 이후 문서에서 충돌을 일으킨다. strict는 매핑에 없는 필드를 에러로 거절해 의도치 않은 증식을 막는다. `_source`에서 큰 필드를 제외하는 최적화는 reindex와 update를 제한하므로 표시용으로 반환할 일이 없는 필드에만 적용한다.

### alias 뒤에 버전 인덱스를 둔다

애플리케이션은 `products`라는 alias만 바라보고, 실제 인덱스는 `products-v1`, `products-v2`처럼 버전을 붙인다. `_aliases` API의 `actions` 배열에 remove와 add를 함께 넣으면 전환이 원자적으로 일어나 다운타임이 없고, 문제가 생기면 같은 방법으로 즉시 되돌린다. 재색인 중에는 `is_write_index`로 쓰기 대상을 새 인덱스로 고정하는 write alias와, 읽기용 read alias를 나눠 점진 전환하는 구성도 가능하다.

### 무중단 재색인 파이프라인

DB를 단일 진실로 두고 ES는 검색 최적화 사본으로 취급한다. 재색인은 다음 순서로 진행한다.

```text
1. 바뀐 매핑·분석기로 products-v2 생성
2. number_of_replicas=0, refresh_interval=-1 로 설정
3. 풀색인 시작 시각 기록 후 Bulk API로 전체 색인
4. force_merge(선택) → replicas·refresh_interval 복원
5. 기록한 시각 이후 변경분을 증분 색인
6. alias를 products-v1 → products-v2 로 원자적 전환
7. 검색 결과 검증 후 필요 시 증분 색인 한 번 더, products-v1 삭제
```

풀색인 동안 새 인덱스는 검색을 받지 않으므로 복제와 refresh 부담을 꺼서 쓰기에만 집중시킨다. 풀색인이 도는 수십 분 동안 원본 DB는 계속 바뀌므로, `updated_at`이나 version 컬럼 기준으로 시작 시각 이후 변경 행만 골라 따라잡는 증분 색인이 전환 전에 반드시 들어간다. 평상시 동기화는 애플리케이션이 DB와 ES에 동시에 쓰는 dual write 대신 Transactional Outbox 또는 CDC(Debezium → Kafka → ES)로 구성한다. ==dual write는 ES 쓰기 실패 시 DB와 불일치가 남고 부분 실패를 복구할 방법이 없다.==

## 코드

명시 매핑과 `copy_to` 통합 검색 필드를 가진 인덱스 생성 요청이다.

```json
PUT /products-v2
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "-1"
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "name":       { "type": "text", "analyzer": "nori",
                      "fields": { "keyword": { "type": "keyword" } },
                      "copy_to": "search_all" },
      "brand":      { "type": "keyword", "copy_to": "search_all" },
      "price":      { "type": "long" },
      "updatedAt":  { "type": "date" },
      "search_all": { "type": "text", "analyzer": "nori" }
    }
  }
}
```

Java 클라이언트로 풀색인 후 설정을 복원하고 alias를 원자적으로 전환하는 서비스다. `ElasticsearchClient`는 Spring Boot 3.x의 `spring-boot-starter-data-elasticsearch`가 자동 구성한다.

```java
@Service
public class ReindexService {

    private final ElasticsearchClient es;

    public ReindexService(ElasticsearchClient es) {
        this.es = es;
    }

    public void restoreSettings(String index) throws IOException {
        es.indices().putSettings(s -> s.index(index)
                .settings(b -> b.numberOfReplicas("1").refreshInterval(t -> t.time("1s"))));
        es.indices().forcemerge(f -> f.index(index).maxNumSegments(1L));
    }

    public void switchAlias(String alias, String from, String to) throws IOException {
        es.indices().updateAliases(u -> u
                .actions(a -> a.remove(r -> r.index(from).alias(alias)))
                .actions(a -> a.add(ad -> ad.index(to).alias(alias))));
    }
}
```

풀색인 시작 시각 이후 변경된 행만 골라 새 인덱스에 반영하는 증분 색인이다.

```java
@Service
public class IncrementalIndexer {

    private final ProductRepository repo;
    private final ElasticsearchClient es;

    public IncrementalIndexer(ProductRepository repo, ElasticsearchClient es) {
        this.repo = repo;
        this.es = es;
    }

    public void catchUp(String index, Instant since) throws IOException {
        List<Product> changed = repo.findByUpdatedAtAfter(since);
        if (changed.isEmpty()) return;
        BulkRequest.Builder bulk = new BulkRequest.Builder();
        for (Product p : changed) {
            bulk.operations(op -> op.index(i -> i.index(index).id(p.id()).document(p)));
        }
        BulkResponse res = es.bulk(bulk.build());
        if (res.errors()) {
            throw new IllegalStateException("bulk 일부 실패: " + res.items().size());
        }
    }
}
```

## 실무에서 걸리는 지점

- **replicas·refresh_interval 복원 누락.** 복원을 잊으면 복제본 0개에 검색 결과가 갱신되지 않는 인덱스가 서비스에 올라간다. 복원은 별도 단계가 아니라 풀색인 절차의 마지막에 묶어 둔다.
- **alias 없이 시작한 서비스.** 실제 인덱스 이름이 코드에 박혀 있으면 첫 재색인이 코드 배포와 묶여 무중단 전환이 불가능하다. 인덱스를 처음 만드는 날부터 alias로 감싼다.
- **재색인 중 신규 데이터.** ==풀색인과 전환 사이의 변경분이 가장 자주 빠지는 지점이다.== 시작 시각을 먼저 기록하고 증분 색인을 최소 한 번, 전환 뒤 한 번 더 돌린다. CDC를 쓰면 새 인덱스를 sink 대상에 추가하는 것으로 대체된다.
- **동적 매핑 방치.** 로그처럼 스키마가 자유로운 데이터가 아니라면 dynamic은 필드 폭발과 타입 충돌의 원인이 된다. strict로 막고 필드 추가는 매핑 변경 PR로 관리한다.
- **`_source` 제외의 대가.** 저장 공간을 줄이려고 `_source`에서 필드를 빼면 `_reindex` API와 부분 update, highlight가 그 필드에 대해 동작하지 않는다. 용량 이득보다 재색인 불가가 더 큰 비용이 되는 경우가 많다.

## 관련 글

- [Document CRUD·Bulk·Reindex·Versioning](/notes/elasticsearch/document-crud-bulk-reindex/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
