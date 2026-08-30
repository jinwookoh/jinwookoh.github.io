---
title: "Index 관리·ILM·Rollover"
series: elasticsearch
part: "인덱스와 매핑"
order: 4
summary: "인덱스는 생성 시점에 핵심 설정이 고정되므로 alias·template·ILM으로 갈아끼우는 구조를 처음부터 만든다"
tags: [Elasticsearch, Alias, Reindex, ILM, Data Stream]
sources: [elasticsearch/2026-05-19-elasticsearch-index-management.md, elasticsearch/2026-05-19-elasticsearch-ilm-aliases-rollover.md]
updated: 2026-08-29
---

Elasticsearch 인덱스는 Primary Shard 수·analyzer·필드 타입이 생성 시점에 고정된다. 온라인 변경 경로가 없어서 잘못 만든 인덱스는 새로 만들고 데이터를 옮겨야 하는데, 앱이 실제 인덱스 이름을 직접 참조하면 이 작업이 배포와 묶여 다운타임 없이 끝낼 수 없다. 시계열 데이터를 인덱스 하나에 계속 쌓으면 샤드가 권장치 10~50GB를 넘고, 오래된 데이터 삭제가 비싸며, 자주 읽는 데이터와 보관용 데이터가 같은 고가 디스크에 놓인다.

## 핵심 개념

**Settings.** `number_of_shards`, `analysis.*`, `index.codec`은 생성 시점에만 지정한다. `number_of_replicas`, `refresh_interval`, `index.max_result_window`는 `PUT /<index>/_settings`로 운영 중 변경한다. 운영 인덱스는 settings·mappings·aliases를 한 번에 지정하고 mapping은 `dynamic: strict`로 두며, 이름에는 `products-v1`처럼 버전 접미사를 붙인다.

**Alias.** 인덱스를 가리키는 논리 이름이다. 앱은 `products`만 알고 실제로는 `products-v1`이나 `v2`를 본다. `POST /_aliases`에 remove와 add를 함께 넣으면 원자적으로 교체된다. 여러 인덱스를 가리킬 때는 `is_write_index: true`로 쓰기 대상을 하나 지정한다.

**Reindex.** `POST /_reindex`는 source 문서를 dest로 복사한다. 대형 인덱스는 `wait_for_completion=false`로 띄워 `_tasks`로 추적하고, `slices=auto`로 병렬화하며, `conflicts: proceed`로 충돌 문서를 건너뛴다. ==dest를 미리 만들지 않으면 동적 매핑으로 생성되어 analyzer가 원본과 달라진다.== 무중단 재색인은 새 인덱스 생성 → reindex → 증분 복사 → alias 원자 교체 → 옛 인덱스 3~7일 보존 순서다.

**Index Template.** 이름 패턴에 매칭되는 인덱스에 settings·mappings·aliases를 자동 적용한다. 여러 템플릿이 매칭되면 `priority`가 큰 쪽이 이긴다. `_component_template`으로 공통 조각을 만들고 `composed_of`로 조립한다.

**ILM.** 인덱스를 Hot(쓰기·rollover) → Warm(읽기 전용·forcemerge·shrink) → Cold·Frozen(저가 스토리지·searchable_snapshot) → Delete 단계로 자동 전환하는 정책 엔진이다. ==기본 10분 주기로 스캔하며 `min_age`는 rollover 완료 시점부터 계산된다.== `searchable_snapshot` 액션만 Enterprise 라이선스가 필요하다.

**Rollover.** `max_primary_shard_size`·`max_age`·`max_docs` 중 하나라도 만족하면 다음 번호 인덱스를 만들고 write alias를 옮긴다. 초기 인덱스의 `is_write_index: true` alias와 template의 `index.lifecycle.name`·`index.lifecycle.rollover_alias`가 모두 있어야 동작한다.

**Data Stream.** alias·rollover·ILM을 하나로 묶은 8.x 시계열 권장 패턴이다. template에 `data_stream: {}`을 넣으면 스트림 이름이 쓰기 대상이 되고 백킹 인덱스가 자동 생성된다. `@timestamp`가 필수이고 append-only다.

## 코드

settings·mappings·alias를 함께 지정해 운영 인덱스를 생성한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.mapping.DynamicMapping;
import co.elastic.clients.elasticsearch.indices.Alias;
import org.springframework.stereotype.Service;

@Service
public class ProductIndexService {

    private final ElasticsearchClient client;

    public ProductIndexService(ElasticsearchClient client) {
        this.client = client;
    }

    public void createProductsV1() throws java.io.IOException {
        client.indices().create(c -> c
            .index("products-v1")
            .settings(s -> s
                .numberOfShards("3")
                .numberOfReplicas("1")
                .refreshInterval(r -> r.time("5s"))
                .analysis(a -> a.analyzer("korean_nori", an -> an
                    .custom(cu -> cu.tokenizer("nori_tokenizer")))))
            .mappings(m -> m
                .dynamic(DynamicMapping.Strict)
                .properties("name", p -> p.text(t -> t.analyzer("korean_nori")))
                .properties("price", p -> p.long_(l -> l))
                .properties("category", p -> p.keyword(k -> k))
                .properties("createdAt", p -> p.date(d -> d)))
            .aliases("products", Alias.of(a -> a)));
    }
}
```

reindex를 비동기로 띄우고, 완료 후 alias를 원자적으로 교체한다.

```java
public String startReindex(String from, String to) throws java.io.IOException {
    var response = client.reindex(r -> r
        .source(s -> s.index(from).size(5000))
        .dest(d -> d.index(to))
        .conflicts(co.elastic.clients.elasticsearch._types.Conflicts.Proceed)
        .slices(s -> s.computed(co.elastic.clients.elasticsearch._types.SlicesCalculation.Auto))
        .waitForCompletion(false));
    return response.task();          // _tasks/<task_id> 로 진행률 추적
}

public void switchAlias(String alias, String from, String to) throws java.io.IOException {
    client.indices().updateAliases(u -> u
        .actions(a -> a.remove(r -> r.index(from).alias(alias)))
        .actions(a -> a.add(ad -> ad.index(to).alias(alias))));
}
```

ILM 정책과 Data Stream template을 등록한다. rollover_alias는 필요 없다.

```json
PUT _ilm/policy/logs-app-policy
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": { "max_primary_shard_size": "50gb", "max_age": "1d" },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "forcemerge": { "max_num_segments": 1 },
          "shrink": { "number_of_shards": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "delete": { "min_age": "365d", "actions": { "delete": {} } }
    }
  }
}

PUT _index_template/logs-app-template
{
  "index_patterns": ["logs-app"],
  "data_stream": {},
  "priority": 200,
  "template": {
    "settings": {
      "number_of_shards": 5,
      "number_of_replicas": 1,
      "index.lifecycle.name": "logs-app-policy"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "message": { "type": "text" }
      }
    }
  }
}
```

## 실무에서 걸리는 지점

- **실제 인덱스 이름 노출.** 앱이 `products-v1`을 직접 호출하면 mapping 변경마다 배포가 따라붙는다. 앱은 alias만 쓰도록 강제한다.
- **Template priority 충돌.** `logs-*`와 `logs-app-*`가 같은 priority면 결과를 예측할 수 없다. 100 단위로 분리하고 `_simulate_index`로 검증한다.
- **refresh_interval 원복 누락.** 대량 색인 전 `-1`로 끈 뒤 원복을 잊으면 새 문서가 검색되지 않는다. try-finally에서 원복한다.
- **rollover 침묵 실패.** ==write alias나 `rollover_alias`가 빠지면 에러 없이 인덱스가 수백 GB로 부푼다.== `GET <index>/_ilm/explain`으로 멈춘 `step`을 확인하고, ERROR면 원인 해결 후 `POST <index>/_ilm/retry`한다.
- **Data tier와 forcemerge.** `allocate`가 요구하는 `data_warm` 노드가 없으면 인덱스가 Hot에 남으므로 노드를 분리할 수 없다면 allocate를 뺀다. forcemerge는 쓰기가 멈춘 뒤 돌아야 하므로 Warm `min_age`를 1~2일 이상으로 두고, Delete 앞에 스냅샷이 먼저 잡히는지 확인한다.

## 관련 글

- [Elasticsearch란 — Index·Document·Shard·Replica](/notes/elasticsearch/what-is-elasticsearch/)
- [Document CRUD·Bulk·Reindex·Versioning](/notes/elasticsearch/document-crud-bulk-reindex/)
- [Snapshot·Restore와 보안 (RBAC)](/notes/elasticsearch/snapshot-security/)
