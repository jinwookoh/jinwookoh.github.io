---
title: "마무리 — 결정 트리와 체크리스트"
series: elasticsearch
part: "통합과 클라우드"
order: 22
summary: "Elasticsearch 도입 여부와 배포 형태를 결정하는 질문 순서, 운영 30일 점검 항목, 반복되는 사고 유형을 한 페이지로 정리한다."
tags: [Elasticsearch, OpenSearch, 결정 트리, 운영 체크리스트, ILM]
sources: [elasticsearch/2026-05-19-elasticsearch-series-conclusion.md]
updated: 2026-08-29
---

Elasticsearch는 검색·로그·관측·벡터를 하나의 엔진으로 처리할 수 있지만, 그만큼 도입 판단과 초기 설정에서 갈림길이 많다. 기준 없이 도입하면 RDBMS FULLTEXT로 충분한 규모에 클러스터 운영비를 지불하거나, 규모가 커진 뒤 Dynamic Mapping·샤드 수·Snapshot 같은 초기 결정을 되돌리지 못해 재색인을 반복하게 된다. 도입 결정 트리, 운영 30일 체크리스트, 반복 사고 유형 세 가지로 정리한다.

## 핵심 개념

도입 결정은 여섯 개 질문을 순서대로 답하면 배포 형태까지 정해진다.

1. 검색·로그·관측·벡터 중 하나라도 필요한가. 아니면 PostgreSQL·Redis·Kafka로 충분하다.
2. 데이터 규모는 어느 정도인가. 10만 행 미만, QPS 10 미만이면 PostgreSQL tsvector나 MySQL FULLTEXT가 운영비 대비 유리하다.
3. 주 용도는 무엇인가. 풀텍스트 검색이면 ES와 Nori, 로그·관측이면 ES와 Beats·Logstash·Kibana, 벡터·RAG면 dense_vector·kNN·hybrid search가 표준이다. 둘 이상이 섞이면 검색 클러스터와 로그 클러스터를 분리한다.
4. 라이선스와 클라우드 환경은 어떠한가. AWS 단일 환경에 Apache 2.0이 필요하면 AWS OpenSearch Service, 멀티 클라우드거나 Elastic 최신 기능이 필요하면 Elastic Cloud, 온프레미스면 자체 운영이며 Kubernetes 환경이면 ECK를 쓴다.
5. 벡터 검색만 사용하는가. 100만 벡터 미만이고 검색·로그와 함께 쓰면 ES가 유리하다. 벡터만 1억 개 이상이면 Qdrant·Milvus·Weaviate 같은 전용 Vector DB가 앞선다.
6. 매니지드와 자체 운영 중 무엇인가. DevOps 인력이 2명 미만이면 Elastic Cloud Serverless 또는 OpenSearch Serverless, 인력이 있고 비용에 민감하면 ECK, 온프레미스가 강제되면 Terraform·Helm·ECK Operator로 자체 운영한다.

운영 30일 체크리스트는 시점별로 나눈다.

| 시점 | 영역 | 핵심 항목 |
|---|---|---|
| D+1 | 클러스터 | master-eligible 3대와 data 2대 이상 분리, `cluster.initial_master_nodes` 명시, heap은 메모리의 50% 이하이며 31GB 이하, `cluster.name` 고유 지정 |
| D+3 | 인덱스 | 모든 인덱스를 alias 뒤에 배치, `dynamic: strict`, `total_fields.limit` 설정, 시계열은 ILM과 Rollover, shard 당 10~50GB 기준 |
| D+7 | 보안 | xpack.security 활성화, 빌트인 계정 비밀번호 교체, transport·http TLS, 애플리케이션별 API key와 role 분리 |
| D+14 | 관측 | `_cluster/health`·`_nodes/stats` 수집, slow log 임계값, red·디스크 20% 미만·heap 75% 초과 알림 |
| D+21 | 백업 | Snapshot Repository 등록, SLM 정책, 보존 기간 차등, 복구 리허설로 RTO 측정 |
| D+30 | 튜닝 | request cache 적중률, circuit breaker 빈도, thread pool rejected, Nori 사용자 사전, alias 전환 절차 문서화 |

## 코드

D+3 항목을 인덱스 템플릿으로 고정한다. alias·strict mapping·필드 수 제한·ILM 정책을 한 번에 적용한다.

```json
PUT _index_template/logs-app
{
  "index_patterns": ["logs-app-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.mapping.total_fields.limit": 1000,
      "index.lifecycle.name": "logs-30d",
      "index.lifecycle.rollover_alias": "logs-app"
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "@timestamp": { "type": "date" },
        "level":      { "type": "keyword" },
        "message":    { "type": "text", "analyzer": "nori" }
      }
    }
  }
}
```

Spring Boot 3.x에서 클러스터 상태와 alias 존재 여부를 확인하는 HealthIndicator다. `elasticsearch-java` 클라이언트를 사용한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.HealthStatus;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

@Component
public class SearchClusterHealthIndicator implements HealthIndicator {

    private final ElasticsearchClient client;

    public SearchClusterHealthIndicator(ElasticsearchClient client) {
        this.client = client;
    }

    @Override
    public Health health() {
        try {
            var health = client.cluster().health();
            boolean aliasExists = client.indices()
                    .existsAlias(a -> a.name("logs-app")).value();

            if (health.status() == HealthStatus.Red || !aliasExists) {
                return Health.down()
                        .withDetail("status", health.status().jsonValue())
                        .withDetail("aliasExists", aliasExists)
                        .build();
            }
            return Health.up()
                    .withDetail("status", health.status().jsonValue())
                    .withDetail("unassignedShards", health.unassignedShards())
                    .build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
```

대량 색인 구간에서 `BulkIngester` 앞뒤로 `refresh_interval`을 조정한다.

```java
public void reindexAll(List<Product> products) throws IOException {
    client.indices().putSettings(s -> s.index("products-v2")
            .settings(x -> x.refreshInterval(t -> t.time("-1"))));
    try (BulkIngester<Void> ingester = BulkIngester.of(b -> b
            .client(client).maxOperations(1000).flushInterval(5, TimeUnit.SECONDS))) {
        for (Product p : products) {
            ingester.add(op -> op.index(i -> i.index("products-v2").id(p.id()).document(p)));
        }
    }
    client.indices().putSettings(s -> s.index("products-v2")
            .settings(x -> x.refreshInterval(t -> t.time("1s"))));
    client.indices().refresh(r -> r.index("products-v2"));
}
```

## 실무에서 걸리는 지점

- **Mapping Explosion.** Dynamic Mapping을 켠 채 임의 키 JSON을 색인하면 필드 수가 폭증해 cluster state와 heap을 잠식한다. `dynamic: strict`와 `total_fields.limit`으로 막고, 구조를 알 수 없는 데이터는 `flattened` 타입에 넣는다.
- **샤드 수 극단 설계.** Primary Shard 1개는 수평 확장이 막히고, 수백 개는 shard 오버헤드로 heap을 소모한다. shard 당 10~50GB를 기준으로 잡고 시계열은 Rollover로 통제한다.
- **Deep Pagination.** `from + size`로 깊은 페이지를 요청하면 모든 shard가 `from + size` 만큼 정렬한 뒤 coordinating 노드가 다시 합친다. `search_after`와 PIT 조합으로 대체한다.
- **fielddata 폭증.** `text` 필드에 정렬·집계를 걸면 fielddata가 heap에 올라와 circuit breaker가 발동한다. 정렬·집계는 `keyword` sub-field에서만 수행한다.
- **Red 상태와 Split-brain.** Primary Shard 미할당은 `_cluster/allocation/explain`으로 확인하며 대부분 디스크 watermark가 원인이다. master-eligible 3대와 quorum voting이 있어야 파티션 시 master가 둘로 갈리지 않는다.
- **Snapshot 부재.** 인덱스를 잘못 삭제했을 때 복구 수단이 없는 사고가 반복된다. SLM으로 자동화하고 복구 리허설로 RTO를 실측한다.

## 관련 글

- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [클러스터 운영과 Shard Allocation](/notes/elasticsearch/cluster-operations-shard-allocation/)
- [성능 튜닝](/notes/elasticsearch/performance-tuning/)
