---
title: "Ingest Pipeline과 수집기 (Logstash·Beats·Fluentd)"
series: elasticsearch
part: "수집"
order: 16
summary: "색인 전 가공은 ES 안의 Ingest Pipeline이 맡고, 수집·전송은 Beats·Fluent Bit·Logstash·Vector 중 규모에 맞게 고른다"
tags: [Elasticsearch, Ingest Pipeline, Logstash, Filebeat, Fluentd]
sources: [elasticsearch/2026-05-19-elasticsearch-ingest-pipeline.md, elasticsearch/2026-05-19-elasticsearch-logstash-beats-fluentd.md]
updated: 2026-08-29
---

현실의 로그는 ES가 바로 받을 수 있는 JSON으로 오지 않는다. nginx access log는 한 줄 텍스트이고 Kubernetes Pod 로그는 노드 파일 시스템에 흩어져 있다. 필드로 쪼개고 타임스탬프를 맞추고 민감 필드를 지우는 작업을 클라이언트마다 구현하면 파싱 규칙이 분산되고 규칙 변경마다 배포가 따라붙는다. 그래서 수집 경로는 서버에서 ES까지 데이터를 옮기는 외부 수집기와, 색인 직전 문서를 가공하는 ES 내장 Ingest Pipeline 두 층으로 나눈다.

## 핵심 개념

Ingest Pipeline은 색인 직전의 전처리 단계를 클러스터 단위 리소스로 정의한 것이다. `PUT _ingest/pipeline/{name}`으로 만들며 `processors` 배열이 순차 실행되고, 실패 시 `on_failure` 블록이 대신 실행된다. 8.x에서는 역할을 명시하지 않은 노드가 모두 ingest 역할을 가지며, 대규모 환경에서는 `node.roles: [ingest]` 전용 노드를 분리한다.

자주 쓰는 processor는 `grok`(alias 정규식 추출, Logstash와 문법 동일), `dissect`(구분자 기반 파서), `set`, `remove`, `rename`, `convert`(grok이 문자열로 뽑은 값의 타입 변환), `date`(여러 포맷을 순서대로 시도해 `@timestamp`로 정규화, `timezone` 필수), `script`(Painless)다. 모든 processor에 공통 `if` 옵션이 있어 Painless 표현식으로 실행 여부를 분기한다.

적용 방법은 요청의 `?pipeline=` 파라미터, 인덱스 설정 `index.default_pipeline`, default 뒤에 마지막으로 도는 `index.final_pipeline` 세 갈래다. 공통 메타데이터 주입이나 PII 마스킹은 인덱스 템플릿과 final_pipeline 조합으로 둔다. `_ingest/pipeline/_simulate`는 샘플 문서를 흘려 결과를 확인하며 `?verbose=true`로 단계별 변화를 본다.

외부 수집기는 ES 앞단에서 읽기와 전송을 맡으며 메모리 부담과 가공 기능의 두께로 갈린다.

| 도구 | 언어 | 메모리 | 역할 |
|---|---|---|---|
| Logstash | JRuby (JVM) | 1~2GB | 중앙 ETL, persistent queue |
| Filebeat / Metricbeat | Go | 10~80MB | 서버별 로그·메트릭 shipper |
| Fluentd | Ruby+C | 40~100MB | CNCF ETL, plugin 800+ |
| Fluent Bit | C | 1~5MB | Kubernetes DaemonSet 표준 |
| Vector | Rust | 30~80MB | 통합 ETL, VRL |

1단 구조는 경량 shipper가 ES로 직접 보내고 파싱은 Ingest Pipeline이 맡는다. 2단 구조는 shipper가 중앙의 Logstash·Fluentd·Vector로 모으고 거기서 가공과 디스크 버퍼링을 한 뒤 ES로 보내며, 초당 1만 건 이상이거나 여러 소스를 합쳐야 할 때 택한다. Elastic 중심이면 Beats + Logstash(ELK), Kubernetes 중심이면 Fluent Bit + Fluentd(EFK)가 표준이다.

## 코드

Spring Boot 3.x에서 `elasticsearch-java` 클라이언트로 nginx access log용 파이프라인을 등록한다. grok으로 파싱하고 date로 `@timestamp`를 만든 뒤 임시 필드를 지우며, 실패 시 색인은 유지하고 에러 필드만 남긴다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.ingest.Processor;
import co.elastic.clients.json.JsonData;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class AccessLogPipelineInitializer {

    private static final String PIPELINE = "access-log-pipeline";
    private static final String NGINX_PATTERN =
        "%{IP:client_ip} - - \\[%{HTTPDATE:ts}\\] \"%{WORD:method} %{URIPATHPARAM:path} HTTP/%{NUMBER}\" "
        + "%{NUMBER:status:int} %{NUMBER:bytes:int}";

    private final ElasticsearchClient client;

    public AccessLogPipelineInitializer(ElasticsearchClient client) {
        this.client = client;
    }

    public void register() throws java.io.IOException {
        client.ingest().putPipeline(p -> p
            .id(PIPELINE)
            .description("nginx access log 파싱 + KST 보정")
            .processors(List.of(
                Processor.of(pr -> pr.grok(g -> g.field("message").patterns(NGINX_PATTERN))),
                Processor.of(pr -> pr.date(d -> d.field("ts")
                    .formats("dd/MMM/yyyy:HH:mm:ss Z")
                    .timezone("Asia/Seoul")
                    .targetField("@timestamp"))),
                Processor.of(pr -> pr.set(s -> s.field("source").value(JsonData.of("nginx")).override(false))),
                Processor.of(pr -> pr.remove(r -> r.field(List.of("ts", "message")).ignoreMissing(true)))
            ))
            .onFailure(List.of(
                Processor.of(pr -> pr.set(s -> s.field("_ingest_failed").value(JsonData.of(true)))),
                Processor.of(pr -> pr.set(s -> s.field("_ingest_error")
                    .value(JsonData.of("{{ _ingest.on_failure_message }}"))))
            ))
        );
    }
}
```

파이프라인을 default_pipeline으로 걸면 클라이언트는 문서만 색인하고, 특정 요청은 `pipeline()` 옵션으로 덮어쓴다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.Map;

@Service
public class AccessLogIndexer {

    private final ElasticsearchClient client;

    public AccessLogIndexer(ElasticsearchClient client) {
        this.client = client;
    }

    public void bindDefaultPipeline() throws IOException {
        client.indices().putSettings(s -> s
            .index("nginx-logs")
            .settings(st -> st.defaultPipeline("access-log-pipeline")));
    }

    public void indexRawLine(String rawLine) throws IOException {
        client.index(i -> i
            .index("nginx-logs")
            .document(Map.of("message", rawLine)));
    }

    public void indexWithExplicitPipeline(String rawLine) throws IOException {
        client.index(i -> i
            .index("nginx-logs")
            .pipeline("access-log-pipeline")
            .document(Map.of("message", rawLine)));
    }
}
```

배포 전 검증은 `_simulate`로 하며, 샘플 라인을 흘려 기대 필드를 검증한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.ingest.SimulateResponse;
import co.elastic.clients.json.JsonData;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class AccessLogPipelineTest {

    @Autowired
    ElasticsearchClient client;

    @Test
    void parsesNginxLine() throws Exception {
        String line = "192.168.1.1 - - [19/May/2026:10:00:00 +0900] \"GET /api/items HTTP/1.1\" 200 1234";

        SimulateResponse res = client.ingest().simulate(s -> s
            .id("access-log-pipeline")
            .docs(d -> d.source(JsonData.of(Map.of("message", line)))));

        var source = res.docs().get(0).doc().source();
        assertThat(source.get("client_ip").to(String.class)).isEqualTo("192.168.1.1");
        assertThat(source.get("status").to(Integer.class)).isEqualTo(200);
        assertThat(source.containsKey("message")).isFalse();
    }
}
```

## 실무에서 걸리는 지점

- **파이프라인 실패가 색인 거부로 번진다.** processor 실패 시 기본 동작은 색인 거부이며 Filebeat가 재시도를 반복해 큐가 부푼다. 최상위 `on_failure`에서 실패 표식을 남기고 dead-letter 인덱스로 보내는 구성을 기본으로 둔다.
- **grok backtracking으로 CPU가 잠긴다.** `GREEDYDATA`와 중첩 alternation이 섞이면 한 줄 파싱에 수 초가 걸린다. 긴 라인은 dissect로 먼저 쪼갠 뒤 작은 조각만 grok으로 파싱하고 `timeout_millis`로 상한을 둔다.
- **script processor는 마지막 카드다.** 대량 ingest에서 Painless 한두 개가 지연을 수십 배 키운다. 치환은 `gsub`, 타입은 `convert`, 분기는 `if`로 푼다.
- **_simulate 통과가 색인 성공을 보장하지 않는다.** 매핑 검증은 실제 색인 시점에 일어나므로 테스트 인덱스에 실제 1건 색인까지 검증한다. reindex는 파이프라인을 자동으로 타지 않으므로 `dest.pipeline`을 명시한다.
- **수집기의 backpressure와 버퍼 한도.** downstream이 느려지면 Filebeat는 큐가 차고 Fluentd는 output buffer가 디스크를 채워 멈춘다. Logstash persistent queue, Fluentd `total_limit_size`·`overflow_action`으로 완충 정책을 명시하고, retention은 수집기가 아니라 ES의 ILM에서 관리한다.

## 관련 글

- [Document CRUD·Bulk·Reindex·Versioning](/notes/elasticsearch/document-crud-bulk-reindex/)
- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [Kibana·Elastic Cloud·OpenSearch·IaC](/notes/elasticsearch/kibana-cloud-opensearch-iac/)
