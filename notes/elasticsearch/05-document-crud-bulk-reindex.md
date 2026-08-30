---
title: "Document CRUD·Bulk·Reindex·Versioning"
series: elasticsearch
part: "인덱스와 매핑"
order: 5
summary: "Elasticsearch 문서 쓰기는 near-realtime·불변 세그먼트·낙관적 동시성 제어 위에서 Bulk 단위로 설계해야 한다"
tags: [Elasticsearch, Bulk API, Reindex, Optimistic Concurrency Control, NDJSON]
sources: [elasticsearch/2026-05-19-elasticsearch-document-crud-versioning.md, elasticsearch/2026-05-19-elasticsearch-bulk-api.md, 2026-05-03-es-bulk-api.md]
updated: 2026-08-29
---

Elasticsearch의 문서 API는 RDBMS의 INSERT·UPDATE·DELETE와 이름이 같지만 동작 모델이 다르다. 색인 직후 검색에 보이지 않고, 부분 갱신이 실제로는 재색인이며, 행 단위 락이 없고, 단건 API로 대량 데이터를 넣으면 클러스터가 먼저 무너진다. 이 차이를 모르면 "저장했는데 검색이 안 된다" 같은 장애가 반복된다.

## 핵심 개념

### RDBMS와 다른 점

검색은 **near-realtime**이다. 색인된 문서는 `refresh_interval`(기본 1초)마다 segment로 내려가며 그 전에는 `_search`에 잡히지 않는다. 반면 Get API는 translog를 읽으므로 refresh와 무관하게 최신 값을 돌려준다.

segment는 불변이므로 **in-place update가 없다**. `_update`는 원본 조회 → 병합 → 재색인 → 옛 문서 tombstone 순서로 동작하고, 삭제된 공간은 segment merge 때 회수된다.

락 대신 **Optimistic Concurrency Control**을 쓴다. 모든 문서는 `_seq_no`(primary shard 안에서 단조 증가하는 일련번호)와 `_primary_term`(primary 재선출마다 증가하는 임기 번호)을 가진다. `if_seq_no`·`if_primary_term`을 붙인 쓰기는 두 값이 일치할 때만 반영되고, 아니면 409 `version_conflict_engine_exception`이 돌아온다. `_version` 단독 조건부 쓰기는 primary 교체 시 정확하지 않아 8.x에서 권장되지 않는다. `version_type=external`은 외부 순번이 저장된 값보다 클 때만 받아들이므로 CDC에서 늦게 도착한 옛 이벤트가 최신 데이터를 덮는 사고를 막는다.

### 단건 API

`PUT /idx/_doc/{id}`는 없으면 생성하고 있으면 덮어쓰며, `PUT /idx/_create/{id}`는 이미 있으면 409를 낸다. `POST /idx/_update/{id}`는 `doc` 병합·`script`·`doc_as_upsert` 세 모드를 가진다. 쓰기 API 공통의 `refresh` 파라미터는 `false`(기본), `wait_for`(다음 refresh까지 응답을 미룸), `true`(즉시 강제 refresh) 세 값이다.

### Bulk API

본문은 **NDJSON**이다. action 라인과 source 라인이 짝을 이루고, 마지막 줄도 `\n`으로 끝나야 하며, `Content-Type: application/x-ndjson`을 보낸다. action은 `index`(upsert, 멱등), `create`(중복 시 항목 단위 409), `update`(부분 갱신), `delete`(source 라인 없음) 네 가지다.

요청 크기는 건수가 아니라 **바이트**로 잡으며 권장은 요청당 5~15MB다. 응답은 HTTP 200이어도 **부분 실패**를 담을 수 있으므로 `errors`가 true면 `items`를 순회해 각 `status`를 본다. 4xx는 재시도 대상이 아니고, 429(write thread pool 큐 포화)와 503은 backoff 후 재시도한다.

### Reindex·by-query

`_reindex`는 source를 scroll로 읽어 dest에 내부 Bulk로 쓴다. `source.query`로 일부만 복사하고, `script`로 값을 변환하며, `requests_per_second`로 속도를 제한하고, `wait_for_completion=false`로 받은 task ID를 `GET /_tasks/{id}`로 확인한다. `_update_by_query`·`_delete_by_query`도 같은 방식이라 매칭 수에 비례해 비싸며, 대량 삭제는 인덱스 drop이 훨씬 싸다.

## 코드

Java API Client로 Bulk 요청을 조립하고 부분 실패를 재시도 가능 여부로 나누는 서비스.

```java
package com.example.search;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.BulkRequest;
import co.elastic.clients.elasticsearch.core.BulkResponse;
import co.elastic.clients.elasticsearch.core.bulk.BulkResponseItem;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

@Service
public class ProductIndexer {

    private final ElasticsearchClient client;
    private final FailedItemSink failedItemSink;

    public ProductIndexer(ElasticsearchClient client, FailedItemSink failedItemSink) {
        this.client = client;
        this.failedItemSink = failedItemSink;
    }

    public void bulkIndex(List<Product> products) throws IOException {
        BulkRequest.Builder br = new BulkRequest.Builder().index("products");
        for (Product p : products) {
            br.operations(op -> op.index(idx -> idx.id(p.id()).document(p)));
        }

        BulkResponse response = client.bulk(br.build());
        if (!response.errors()) {
            return;
        }

        List<Product> retryable = new ArrayList<>();
        List<BulkResponseItem> items = response.items();
        for (int i = 0; i < items.size(); i++) {
            BulkResponseItem item = items.get(i);
            if (item.error() == null) continue;
            int status = item.status();
            if (status == 429 || status >= 500) {
                retryable.add(products.get(i));
            } else {
                failedItemSink.deadLetter(products.get(i), item.error().reason());
            }
        }
        if (!retryable.isEmpty()) {
            failedItemSink.scheduleRetry(retryable);
        }
    }
}
```

flush 정책·동시성 제어는 `BulkIngester`에 맡긴다. 구 High Level REST Client의 `BulkProcessor` 대체재다.

```java
package com.example.search;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._helpers.bulk.BulkIngester;
import co.elastic.clients.elasticsearch._helpers.bulk.BulkListener;
import co.elastic.clients.elasticsearch.core.BulkRequest;
import co.elastic.clients.elasticsearch.core.BulkResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;
import java.util.concurrent.TimeUnit;

@Configuration
public class BulkIngesterConfig {

    @Bean(destroyMethod = "close")
    public BulkIngester<Void> bulkIngester(ElasticsearchClient client) {
        return BulkIngester.of(b -> b
            .client(client)
            .maxOperations(2_000)
            .maxSize(5L * 1024 * 1024)
            .flushInterval(1, TimeUnit.SECONDS)
            .maxConcurrentRequests(4)
            .listener(new BulkListener<Void>() {
                @Override
                public void beforeBulk(long id, BulkRequest req, List<Void> ctx) { }

                @Override
                public void afterBulk(long id, BulkRequest req, List<Void> ctx, BulkResponse res) {
                    if (res.errors()) {
                        res.items().stream()
                            .filter(it -> it.error() != null)
                            .forEach(it -> System.err.println(it.id() + " " + it.error().reason()));
                    }
                }

                @Override
                public void afterBulk(long id, BulkRequest req, List<Void> ctx, Throwable t) {
                    System.err.println("bulk " + id + " failed: " + t.getMessage());
                }
            }));
    }
}
```

재고 차감에 OCC를 적용하는 예. 조회 시 받은 `_seq_no`·`_primary_term`을 조건으로 붙이고, 409면 다시 시도한다.

```java
public void decreaseStock(String productId, int qty) throws IOException {
    for (int attempt = 0; attempt < 5; attempt++) {
        var got = client.get(g -> g.index("products").id(productId), Product.class);
        Product current = got.source();
        if (current == null) throw new IllegalStateException("not found: " + productId);

        Product updated = current.withStock(current.stock() - qty);
        try {
            client.index(i -> i.index("products").id(productId)
                .ifSeqNo(got.seqNo())
                .ifPrimaryTerm(got.primaryTerm())
                .document(updated));
            return;
        } catch (co.elastic.clients.elasticsearch._types.ElasticsearchException e) {
            if (e.status() != 409) throw e;
        }
    }
    throw new IllegalStateException("version conflict retry exhausted: " + productId);
}
```

## 실무에서 걸리는 지점

- **`refresh=true`를 운영에 끌고 오는 경우.** 요청마다 segment가 생기고 merge가 CPU를 점유해 검색 지연이 수십 배로 뛴다. 즉시 조회는 `wait_for` 또는 Get API로 풀고, `true`는 테스트로 한정한다.
- **부분 실패를 예외로 잡으려는 코드.** Bulk는 항목이 실패해도 예외를 던지지 않는다. `errors()` 검사와 `items()` 순회가 필수다.
- **4xx와 5xx를 같은 재시도 큐에 넣는 경우.** `create`의 409는 정상 케이스이고 400은 매핑 버그라 재시도해도 결과가 같다. 429·503만 exponential backoff로 재시도하고, 429를 받으면 동시 요청 수를 줄인다.
- **초기 적재와 운영 설정을 구분하지 않는 경우.** `refresh_interval: -1`, `number_of_replicas: 0`은 적재 처리량을 수 배 올리지만 운영 인덱스에 적용하면 가용성이 사라진다. 신규 인덱스에만 쓰고 완료 후 원복한다.
- **카운터를 script update로 처리하는 경우.** 같은 문서에 요청이 몰리면 409가 폭증한다. 경합이 큰 값은 Redis에 두고 집계 결과만 반영한다.

## 관련 글

- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [검색 문서 모델링과 무중단 재색인](/notes/elasticsearch/document-modeling-reindex/)
- [Spring Data Elasticsearch](/notes/elasticsearch/spring-data-elasticsearch/)
