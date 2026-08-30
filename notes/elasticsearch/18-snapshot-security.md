---
title: "Snapshot·Restore와 보안 (RBAC)"
series: elasticsearch
part: "운영"
order: 18
summary: "Replica는 백업이 아니다. S3 Repository·SLM으로 시점 백업을 자동화하고, API Key·Role·FLS/DLS·TLS로 접근을 통제한다."
tags: [Elasticsearch, Snapshot, SLM, RBAC, API Key]
sources: [elasticsearch/2026-05-19-elasticsearch-snapshot-restore.md, elasticsearch/2026-05-19-elasticsearch-security-rbac.md, 2026-05-03-es-security.md]
updated: 2026-08-29
---

Replica는 노드 한 대의 장애를 넘기는 고가용성 장치이지 백업이 아니다. 운영자가 `DELETE /orders`를 잘못 실행하면 그 변경은 replica에도 즉시 전파되고, AZ 전체 장애나 랜섬웨어도 마찬가지다. 클러스터 바깥에 시점 단위로 데이터를 떠 두는 Snapshot이 없으면 복구 수단이 없다. 접근 통제도 같은 층위다. 7.x까지는 Security가 옵션이라 노출된 클러스터가 통째로 삭제되는 사고가 잦았고, 8.0부터 Security by Default로 바뀌었다.

## 핵심 개념

**Repository**는 snapshot 저장 위치의 추상이다. 운영은 S3 계열(AWS S3, MinIO)이 표준이며, 자격 증명은 노드의 IAM Role로 처리하고 등록 직후 `POST /_snapshot/{repo}/_verify`로 모든 데이터 노드가 쓰기 가능한지 확인한다. 최소 권한은 버킷에 `ListBucket`·`GetBucketLocation`·`ListBucketMultipartUploads`, 객체에 `GetObject`·`PutObject`·`DeleteObject`·`AbortMultipartUpload` 7개다.

**Snapshot**은 Lucene segment 파일을 물리적으로 복사하는 증분 백업이다. segment별 참조 수를 추적하므로 오래된 snapshot을 지워도 최신 snapshot은 깨지지 않는다. 일부 shard만 성공한 `PARTIAL`은 백업으로 인정하지 않는다.

**Restore**는 `rename_pattern`·`rename_replacement`로 원본 옆에 다른 이름으로 복원한 뒤 alias를 교체하는 방식이 무중단 복원의 기본이다. `include_global_state`는 템플릿·ILM·클러스터 설정까지 덮어쓰므로 운영에서는 false로 두고, tier 구성이 다른 클러스터로 옮길 때는 `ignore_index_settings`에 `_tier_preference`를 넣는다.

**SLM**은 클러스터 내부의 백업 스케줄러다. retention의 `expire_after`·`min_count`·`max_count`는 동시에 적용되어, 백업이 며칠 멈춰도 `min_count`만큼은 남고 `max_count`를 넘으면 기한과 무관하게 오래된 것부터 지운다. **Searchable Snapshot**은 S3를 주 저장소로 두고 로컬 디스크를 캐시로만 쓰는 인덱스 형태로, ILM의 cold·frozen phase와 결합된다.

보안은 인증·인가·감사·암호화 네 축이다. 인증은 basic auth·API Key·PKI·LDAP·SAML/OIDC를 동시에 활성화할 수 있고, 인가는 cluster·index·application privilege를 묶은 Role로 표현하며 기본은 거부다. Transport TLS(9300)는 8.x에서 클러스터 형성 자체에 필수이고 HTTP TLS(9200)는 클라이언트 구간을 보호한다.

서비스 간 호출은 API Key가 표준이다. 발급자 권한의 부분집합만 위임되며 `expiration`을 반드시 지정한다. Field-level Security는 role의 `field_security.grant`로 노출 필드를 제한하고, Document-level Security는 role의 `query`를 모든 검색에 필터로 강제한다. ==둘 다 Platinum 이상에서 동작한다.==

## 코드

Spring Boot 3.x에서 자체 서명 CA를 SSL Bundle로 신뢰하는 설정이다.

```yaml
spring:
  elasticsearch:
    uris: https://es.internal:9200
    socket-timeout: 30s
    restclient:
      ssl:
        bundle: es-ca
  ssl:
    bundle:
      pem:
        es-ca:
          truststore:
            certificates: classpath:certs/es-ca.crt
```

비밀번호 대신 API Key 헤더를 쓰려면 `RestClientBuilderCustomizer`로 기본 헤더를 주입한다.

```java
import org.apache.http.Header;
import org.apache.http.HttpHeaders;
import org.apache.http.message.BasicHeader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.elasticsearch.RestClientBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class EsAuthConfig {

    @Bean
    RestClientBuilderCustomizer apiKeyCustomizer(@Value("${es.api-key.encoded}") String encoded) {
        return builder -> builder.setDefaultHeaders(new Header[] {
            new BasicHeader(HttpHeaders.AUTHORIZATION, "ApiKey " + encoded)
        });
    }
}
```

검증용 복원을 애플리케이션에서 자동화할 때는 Java API Client로 rename 복원을 호출한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.snapshot.RestoreResponse;
import org.springframework.stereotype.Service;

@Service
public class RestoreVerifier {

    private final ElasticsearchClient client;

    public RestoreVerifier(ElasticsearchClient client) {
        this.client = client;
    }

    public RestoreResponse restoreForVerification(String snapshot) throws Exception {
        return client.snapshot().restore(r -> r
            .repository("my_s3_repo")
            .snapshot(snapshot)
            .indices("products", "orders")
            .renamePattern("(.+)")
            .renameReplacement("verify_$1")
            .includeGlobalState(false)
            .includeAliases(false)
            .ignoreIndexSettings("index.routing.allocation.include._tier_preference")
            .indexSettings(s -> s.numberOfReplicas("0"))
            .waitForCompletion(true));
    }
}
```

## 실무에서 걸리는 지점

- **복원을 한 번도 안 해 본 백업.** 사고 때 처음 복원하면 권한 누락·템플릿 충돌·디스크 부족으로 RTO를 넘긴다. 분기 1회 rename 복원으로 문서 수와 샘플 검색 결과를 원본과 비교하는 절차를 runbook으로 고정한다.
- **Repository 버킷의 외부 수정.** ==S3 라이프사이클이 base_path 하위 객체를 지우면 그 segment를 참조하는 모든 snapshot이 `INCOMPATIBLE`이 된다.== 버킷은 ES만 쓰게 하고, MinIO·Ceph는 `_analyze`로 일관성을 점검한다.
- **retention 누락과 wait_for_completion.** retention이 없으면 snapshot이 영구 누적된다. 큰 클러스터에서 `wait_for_completion=true`는 HTTP timeout으로 끊기므로 비동기 시작 후 `_status`를 polling한다.
- **FLS와 `_source`의 우회.** ==FLS는 `_source` 직접 조회·집계·정렬 경로에서 완전하지 않다.== PII는 별도 인덱스로 물리 분리하고 role에서 접근을 끊는 것이 주 방어선이다.
- **superuser 일상 사용과 인증서 만료.** `elastic`은 break-glass 계정으로 봉인하고 `action.destructive_requires_name: true`로 와일드카드 삭제를 막는다. Transport 인증서가 만료되면 클러스터가 깨지므로 만료 30일 전 알람을 둔다. Audit Log는 별도 클러스터로 보내고 `emit_request_body`는 false를 유지한다.

## 관련 글

- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [클러스터 운영과 Shard Allocation](/notes/elasticsearch/cluster-operations-shard-allocation/)
- [Kibana·Elastic Cloud·OpenSearch·IaC](/notes/elasticsearch/kibana-cloud-opensearch-iac/)
