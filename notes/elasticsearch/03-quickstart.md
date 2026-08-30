---
title: "Quickstart — Docker Compose·첫 요청·Kibana Dev Tools"
series: elasticsearch
part: "기초"
order: 3
summary: "Docker Compose로 ES와 Kibana를 띄우고 색인·조회·검색 한 사이클을 curl과 Dev Tools로 돌린다"
tags: [Elasticsearch, Kibana, Docker Compose, Dev Tools, curl]
sources: [elasticsearch/2026-05-19-elasticsearch-quickstart.md]
updated: 2026-08-29
---

Inverted Index와 Shard 구조를 글로만 이해하면 검색 DSL, Mapping, ILM 같은 뒤쪽 주제가 추상적으로 남는다. 문서 한 건을 직접 색인하고 `_search` 응답에 점수와 함께 돌아오는 것을 확인해야 개념이 API 동작과 연결된다. 문제는 그 앞의 환경 설정이다. Elasticsearch 8.x는 기본으로 보안과 HTTPS가 켜져 있고, 커널 파라미터·JVM heap·포트 충돌에서 첫 요청 전에 시간을 잃기 쉽다. single-node와 보안 비활성이라는 학습 전용 조합으로 마찰을 줄인 뒤 curl과 Kibana Dev Tools로 첫 사이클을 돌린다.

## 핵심 개념

### 사전 조건

Docker 엔진에 메모리 4GB 이상을 할당한다. 기본값 2GB에서는 컨테이너가 OOMKilled로 종료되기 쉽다. Linux 호스트는 `vm.max_map_count`가 262144 이상이어야 한다. segment 파일을 mmap으로 매핑하면서 이 값을 요구하며, 기본값 65530인 배포판에서는 bootstrap check 실패로 기동하지 못한다. `sysctl -w`로 적용하고 `/etc/sysctl.conf`에 남긴다. macOS와 Windows는 Docker Desktop VM이 처리한다.

### Compose 옵션의 의미

`discovery.type=single-node`는 마스터 선출 없이 노드 한 대로 클러스터를 구성하며, development mode가 켜져 bootstrap check가 완화된다. `xpack.security.enabled=false`는 8.x 기본 활성인 인증·HTTPS·자동 비밀번호 생성을 끈다. `ES_JAVA_OPTS=-Xms1g -Xmx1g`는 JVM heap 고정이며 ==운영 기준은 컨테이너 메모리의 50%, 31GB 이하다==. `bootstrap.memory_lock`과 `ulimits.memlock`은 heap이 swap으로 밀려 응답이 초 단위로 악화되는 것을 막는다.

### `_cat` API와 health 상태

`_cat` 엔드포인트 묶음은 JSON 대신 텍스트 표를 반환하는 진단용 API로, `?v`를 붙이면 헤더가 출력된다. health status의 green은 모든 primary와 replica shard가 할당된 상태, yellow는 replica만 미할당된 상태, red는 primary 일부가 미할당되어 해당 데이터의 읽기·쓰기가 불가능한 상태다. single-node에서 replica가 1인 인덱스는 yellow가 되며, 학습 환경에서는 정상이다.

### 첫 색인과 Dynamic Mapping

인덱스 없이 `PUT /my-index/_doc/1`로 문서를 넣으면 인덱스가 생성되고 필드 타입이 추론된다. 문자열은 `text`와 `keyword` 서브필드의 multi-field로, 날짜 형식 문자열은 `date`로 잡힌다. 응답의 `result: created`와 `_version: 1`이 성공 신호다. 조회 응답의 `_source`에는 원본 JSON이 저장되어 있고, 검색은 별도의 Inverted Index를 사용한다. `match` 쿼리의 `_score`는 BM25가 계산한 값이다.

### Kibana Dev Tools

`http://localhost:5601`에서 Management → Dev Tools로 들어가면 에디터와 응답 창으로 나뉜 Console이 열린다. HTTP 메서드·경로·본문만 쓰면 호스트·헤더·인증은 Kibana가 붙인다. Ctrl+Enter(macOS는 Cmd+Enter)로 실행, Ctrl+/로 줄 주석, Ctrl+I로 JSON 정렬이다. Request History가 최근 요청을 보존하고 Copy as cURL이 curl 명령으로 변환한다.

## 코드

ES 8.15와 Kibana를 함께 띄우는 compose 파일이다. Kibana는 healthcheck 통과 뒤 시작한다.

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    container_name: es-quickstart
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - xpack.security.http.ssl.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
      - bootstrap.memory_lock=true
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    ports:
      - "9200:9200"
    volumes:
      - es-data:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://localhost:9200/_cluster/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10

  kibana:
    image: docker.elastic.co/kibana/kibana:8.15.0
    container_name: kibana-quickstart
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    ports:
      - "5601:5601"
    depends_on:
      elasticsearch:
        condition: service_healthy

volumes:
  es-data:
```

`docker compose up -d` 후 healthy를 확인하고 상태 점검·색인·조회·검색 사이클을 curl로 보낸다.

```bash
curl -s "http://localhost:9200/_cat/health?v"
curl -s "http://localhost:9200/_cat/nodes?v"
curl -s "http://localhost:9200/_cat/indices?v"

curl -s -X PUT "http://localhost:9200/my-index/_doc/1" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Elasticsearch 입문","tags":["search","lucene"],"published_at":"2026-05-19"}'

curl -s "http://localhost:9200/my-index/_doc/1?pretty"
curl -s "http://localhost:9200/my-index/_mapping?pretty"

curl -s -X POST "http://localhost:9200/my-index/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '{"query":{"match":{"title":"입문"}}}'
```

같은 사이클을 Spring Boot 3.x에서 공식 Java 클라이언트로 보내는 예제다.

```java
@Configuration
public class EsConfig {
    @Bean
    public ElasticsearchClient elasticsearchClient() {
        RestClient rest = RestClient.builder(new HttpHost("localhost", 9200, "http")).build();
        return new ElasticsearchClient(new RestClientTransport(rest, new JacksonJsonpMapper()));
    }
}

public record Article(String title, List<String> tags, String publishedAt) {}

@Service
@RequiredArgsConstructor
public class QuickstartService {
    private final ElasticsearchClient client;

    public String healthStatus() throws IOException {
        return client.cluster().health().status().jsonValue();
    }

    public void index() throws IOException {
        var res = client.index(i -> i.index("my-index").id("1")
                .document(new Article("Elasticsearch 입문", List.of("search", "lucene"), "2026-05-19")));
        // res.result() == Result.Created, res.version() == 1
    }

    public List<Article> search(String keyword) throws IOException {
        var res = client.search(s -> s.index("my-index")
                .query(q -> q.match(m -> m.field("title").query(keyword))), Article.class);
        return res.hits().hits().stream().map(Hit::source).toList();
    }
}
```

## 실무에서 걸리는 지점

- **JVM heap과 컨테이너 한도의 불일치.** ==`-Xmx2g`인데 Docker 한도가 2GB면 off-heap과 mmap이 합산되어 OOMKilled가 반복된다.== 한도는 heap의 2배 이상으로 잡는다.
- **Kibana가 `localhost:9200`을 바라보는 설정.** 컨테이너 안에서 localhost는 Kibana 자신이다. `ELASTICSEARCH_HOSTS`는 compose 서비스 이름으로 지정한다.
- **보안 비활성 옵션 누락.** 8.x는 옵션 없이 띄우면 자체 서명 인증서로 HTTPS를 강제하고 `http://` 요청은 empty reply나 401로 실패한다. 운영은 활성 상태에서 정식 CA 인증서와 계정 비밀번호를 설정한다.
- **포트 충돌.** 9200·5601이 점유되어 있으면 `address already in use`로 실패한다. `lsof -i :9200`으로 확인하고 호스트 포트만 `9201:9200`처럼 바꾼다.
- **학습 조합을 운영에 옮기는 경우.** single-node는 quorum이 없어 split-brain을 막지 못하고, named volume 하나로는 디스크 iops를 통제할 수 없다. 운영은 master-eligible 3대 이상, NVMe bind mount, `nofile` 65536 이상이 기본이다.

## 관련 글

- [Elasticsearch란 — Index·Document·Shard·Replica](/notes/elasticsearch/what-is-elasticsearch/)
- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [Kibana·Elastic Cloud·OpenSearch·IaC](/notes/elasticsearch/kibana-cloud-opensearch-iac/)
