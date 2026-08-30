---
title: "성능 튜닝"
series: elasticsearch
part: "운영"
order: 19
summary: "Heap·Thread Pool·Cache·Fielddata·Circuit Breaker 다섯 자리를 측정 기반으로 조정해 응답 시간과 색인 처리량을 끌어올린다"
tags: [Elasticsearch, JVM Heap, Thread Pool, Query Cache, Circuit Breaker]
sources: [elasticsearch/2026-05-19-elasticsearch-performance-tuning.md]
updated: 2026-08-29
---

응답이 느려지거나 처리량이 나오지 않을 때 원인은 대부분 다섯 자리에 몰려 있다. Heap 크기가 맞지 않아 GC pause가 길어지고, Thread Pool 대기열이 차서 요청이 거절되며, 캐시가 동작하지 않아 같은 필터가 매번 재계산되고, text 필드 집계가 Fielddata를 Heap에 올리며, 그 끝에서 Circuit Breaker가 요청을 끊는다. `_nodes/stats`·`_cat/thread_pool`·Profile API로 병목을 확인한 뒤 변수 하나만 바꾸고 다시 측정한다.

## 핵심 개념

### JVM Heap

Heap은 물리 RAM의 50%까지만 할당하고 나머지는 Lucene 세그먼트를 mmap으로 읽는 OS Page Cache에 남긴다. 또 JVM은 Heap이 32GB 미만일 때만 Compressed Oops로 포인터를 압축하므로 상한은 31GB 이하로 두고, 더 필요하면 노드 수를 늘린다. `Xms`와 `Xmx`는 같은 값으로 고정하며, 지정하지 않으면 8.x가 RAM의 50%(최대 31GB)를 자동으로 잡는다.

### Thread Pool

요청 종류별로 별도 풀을 운영해 검색 부하가 색인을 막지 못하게 한다. `search` 풀은 `int(CPU × 3 / 2) + 1`에 queue 1,000, `write` 풀은 CPU 수에 queue 10,000이 기본이다. queue가 차면 `EsRejectedExecutionException`(HTTP 429)이 발생한다. 대응은 bulk 크기 축소, 동시성 축소, refresh_interval 연장, 노드 추가 순서이고 queue 확대는 마지막 수단이다.

### Query Cache와 Request Cache

| | Query Cache | Request Cache |
|---|---|---|
| 단위 | 노드 | 샤드 |
| 대상 | filter context의 term·range 등 비-scoring 쿼리 | `size=0` 집계 요청 |
| 기본 크기 | Heap 10% | Heap 1% |

`bool.must`의 쿼리는 score 계산 때문에 캐시되지 않고 `bool.filter`의 쿼리만 캐시된다. Request Cache는 더 이상 쓰이지 않는 시간 기반 인덱스의 대시보드 집계에서 적중률이 높다.

### Fielddata와 doc_values

text 필드에 `fielddata: true`를 켜면 역색인을 검색 시점에 뒤집어 Heap에 올리므로 데이터에 비례해 메모리가 소진된다. 집계·정렬이 필요한 필드는 `keyword`로 매핑하고, 색인 시점에 디스크에 저장돼 Page Cache가 관리하는 doc_values를 쓴다. `text`와 `keyword` 서브필드를 함께 두는 multi-field가 표준이다.

### Circuit Breaker

메모리 폭주 직전에 요청을 거절해 프로세스를 살리는 방어선이다. `parent`(Heap 95%) 아래 `fielddata`(40%)·`request`(60%)·`in_flight_requests`·`accounting`이 있다. `circuit_breaking_exception`이 보이면 원인 breaker부터 본다. fielddata면 매핑, request면 대형 집계, in_flight_requests면 bulk 크기가 의심 대상이다. 한도 상향은 마지막 선택이다.

### 색인·검색 체크리스트

쓰기는 refresh_interval을 30s 이상으로 늘리거나 일회성 bulk 동안 `-1`로 끄고, 초기 적재 시 replica를 0으로 두었다가 복구하며, bulk 한 건을 5~15MB로 유지한다. 읽기는 `track_total_hits`를 `false`나 임계값으로 두고, `_source`를 필요한 필드로 제한하며, `preference`로 같은 사용자를 같은 복제본에 라우팅한다.

## 코드

대량 적재 전후로 replica·refresh를 조정하고 끝에 force_merge를 실행하는 서비스. `ElasticsearchClient`(elasticsearch-java)를 주입받는다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.indices.IndexSettings;
import org.springframework.stereotype.Service;

import java.io.IOException;

@Service
public class BulkLoadWindow {

    private final ElasticsearchClient client;

    public BulkLoadWindow(ElasticsearchClient client) {
        this.client = client;
    }

    public void open(String index) throws IOException {
        client.indices().putSettings(r -> r.index(index)
                .settings(IndexSettings.of(s -> s
                        .numberOfReplicas("0")
                        .refreshInterval(t -> t.time("-1")))));
    }

    public void close(String index) throws IOException {
        client.indices().putSettings(r -> r.index(index)
                .settings(IndexSettings.of(s -> s
                        .numberOfReplicas("1")
                        .refreshInterval(t -> t.time("30s")))));
        client.indices().forcemerge(r -> r.index(index).maxNumSegments(1L));
    }
}
```

`BulkIngester`로 bulk 크기와 동시성을 고정하는 빈. 10MB 또는 5,000건 단위로 묶어 `write` 풀 rejection과 `in_flight_requests` breaker를 피한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._helpers.bulk.BulkIngester;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.TimeUnit;

@Configuration
public class BulkIngesterConfig {

    @Bean(destroyMethod = "close")
    public BulkIngester<Void> bulkIngester(ElasticsearchClient client) {
        return BulkIngester.of(b -> b
                .client(client)
                .maxOperations(5_000)
                .maxSize(10L * 1024 * 1024)
                .maxConcurrentRequests(4)
                .flushInterval(1, TimeUnit.SECONDS));
    }
}
```

검색 비용을 줄인 조회. 필터를 `filter` 절에 두고, 총합 계산을 끄고, `_source`를 제한하며, 사용자 ID를 `preference`로 넘긴다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;

@Service
public class ProductSearchService {

    private final ElasticsearchClient client;

    public ProductSearchService(ElasticsearchClient client) {
        this.client = client;
    }

    public SearchResponse<ProductDoc> search(String keyword, String brand, long minPrice, String userId)
            throws IOException {
        return client.search(s -> s
                .index("products")
                .preference(userId)
                .trackTotalHits(t -> t.enabled(false))
                .source(src -> src.filter(f -> f.includes(List.of("id", "title", "price"))))
                .query(q -> q.bool(b -> b
                        .must(m -> m.match(mt -> mt.field("title").query(keyword)))
                        .filter(f -> f.term(t -> t.field("brand").value(brand)))
                        .filter(f -> f.range(r -> r.number(n -> n.field("price").gte((double) minPrice)))))),
                ProductDoc.class);
    }
}
```

## 실무에서 걸리는 지점

- **Heap 48GB의 역설.** ==Heap을 32GB 넘게 잡으면 Compressed Oops가 꺼지고 Page Cache도 줄어 오히려 느려진다.== 30~31GB로 낮추고 부족분은 노드 추가로 푼다.
- **queue 확대로 rejection 감추기.** ==`thread_pool.write.queue_size`를 키우면 429는 사라지지만 대기 요청이 Heap에 쌓여 OOM으로 이어진다.==
- **운영 중 force_merge.** I/O와 CPU를 동시에 점유해 검색 응답이 수십 초로 늘어난다. 쓰기가 끝난 인덱스에만 실행한다.
- **text 필드 terms 집계.** Fielddata breaker가 걸린다. `fielddata: true` 대신 `.keyword` 서브필드로 집계 대상을 바꾼다.
- **deep pagination.** `from: 100000`이면 각 샤드가 10만 건 이상을 정렬한다. `search_after`나 PIT로 전환한다.

## 관련 글

- [Document CRUD·Bulk·Reindex·Versioning](/notes/elasticsearch/document-crud-bulk-reindex/)
- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [클러스터 운영과 Shard Allocation](/notes/elasticsearch/cluster-operations-shard-allocation/)
