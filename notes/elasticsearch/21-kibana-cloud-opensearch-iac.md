---
title: "Kibana·Elastic Cloud·OpenSearch·IaC"
series: elasticsearch
part: "통합과 클라우드"
order: 21
summary: "Kibana로 데이터를 보고, Elastic Cloud와 AWS OpenSearch 중 하나를 고르고, 클러스터를 코드로 관리하는 기준"
tags: [Kibana, Elastic Cloud, OpenSearch, Terraform, ECK]
sources: [elasticsearch/2026-05-19-elasticsearch-kibana-elk-stack.md, elasticsearch/2026-05-19-elasticsearch-aws-opensearch.md, elasticsearch/2026-05-19-elasticsearch-elastic-cloud.md, elasticsearch/2026-05-19-elasticsearch-iac-terraform-cdk.md]
updated: 2026-08-29
---

Elasticsearch에는 사람이 보는 화면이 없어 데이터 확인마다 JSON 요청이 필요하다. 클러스터를 직접 운영하면 패치·백업·노드 교체가 전부 팀 몫이고, 매니지드도 Elastic Cloud와 AWS OpenSearch Service는 엔진 자체가 다르다. 콘솔 클릭으로 만든 클러스터는 옵션 추적이 안 되고, dev·prod 사이 analyzer나 ILM 정책이 어긋나 prod에서만 검색이 깨진다.

## 핵심 개념

### Kibana

Elasticsearch 전용 웹 UI로, Logstash·Beats와 함께 Elastic Stack(ELK)을 이룬다. Elasticsearch와 메이저·마이너 버전을 정확히 맞춰야 한다.

Discover는 Data View에 지정한 인덱스를 KQL(`status: "error" and not user_id: "test"`)로 검색한다. Lens는 8.x 표준 시각화 도구이며 TSVB는 deprecation 흐름이다. Dev Tools는 내장 REST 콘솔과 Profiler, Stack Management는 Index·ILM·Saved Object·Snapshot·Security 관리, Space는 권한 단위다.

### OpenSearch와 AWS OpenSearch Service

OpenSearch는 2021년 AWS가 Elasticsearch·Kibana 7.10.2를 fork한 Apache 2.0 프로젝트다. Elastic의 SSPL 전환이 계기이며, Elasticsearch가 구독으로 묶은 보안·Alerting·ML을 무료로 제공한다. 시각화는 OpenSearch Dashboards, ILM 대신 ISM을 쓴다.

AWS OpenSearch Service의 운영 단위는 Domain이다. Provisioned는 인스턴스를 직접 정하며 운영 환경은 Multi-AZ + Replica 1 이상 + 전용 마스터 3대가 기본이다. ==Serverless는 최소 2 OCU가 24시간 과금되어 유휴 상태에서도 월 300달러 이상이 나가므로 피크·유휴 차이가 큰 워크로드에만 쓴다.== 보안은 IAM 정책과 fine-grained access control 두 축이며 운영 도메인은 VPC에 둔다.

### Elastic Cloud

Elastic이 AWS·GCP·Azure 위에서 직접 운영한다.

| 라인 | 단위 | 과금 | 적합한 자리 |
|---|---|---|---|
| Hosted | deployment | 인스턴스 시간 | 안정 부하, Hot/Warm/Cold/Frozen 4-tier |
| Serverless | project | VCU 분 단위 | 가변 트래픽·PoC |
| ECE | 자체 DC 설치 | 구독 + 인프라 | 클라우드 반출 금지 환경 |
| ECK | Kubernetes CRD | Basic 무료 | K8s 표준 인프라 |

단가는 AWS OpenSearch보다 20~30% 높지만 ML·CCR·Frozen tier·APM이 기본 포함이라 고급 기능을 쓸수록 총비용이 역전된다. Apache 2.0 강제 또는 기본 검색·로그만이면 OpenSearch, 고급 기능·멀티 클라우드면 Elastic Cloud, K8s 표준이면 ECK다. ==region과 provider는 생성 후 불변이다.==

### IaC

클러스터·인덱스·ILM·alias를 코드로 선언하고 git을 단일 진실 원천으로 둔다. `plan`으로 drift를 잡고, 같은 모듈에 다른 변수로 환경을 복제한다. Terraform은 `hashicorp/aws`와 `elastic/ec`·`elastic/elasticstack` provider로 멀티 클라우드를 한 코드베이스에서 다루며 state는 원격 백엔드에 둔다. AWS CDK는 CloudFormation으로 컴파일되어 AWS 외 자원은 못 다룬다. ECK는 CRD를 ArgoCD·Flux로 동기화하며 `selfHeal: true`가 콘솔 수작업을 git 상태로 되돌린다.

## 코드

Terraform으로 AWS OpenSearch Domain을 3-AZ·전용 마스터·VPC·암호화 활성으로 선언한다.

```hcl
resource "aws_opensearch_domain" "search" {
  domain_name    = "search-${var.env}"
  engine_version = "OpenSearch_2.19"

  cluster_config {
    instance_type            = "r7g.large.search"
    instance_count           = 3
    dedicated_master_enabled = true
    dedicated_master_type    = "m6g.large.search"
    dedicated_master_count   = 3
    zone_awareness_enabled   = true
    zone_awareness_config { availability_zone_count = 3 }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = 100
  }

  encrypt_at_rest         { enabled = true }
  node_to_node_encryption { enabled = true }
  domain_endpoint_options { enforce_https = true }

  vpc_options {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.search.id]
  }

  advanced_security_options {
    enabled                        = true
    internal_user_database_enabled = false
    master_user_options { master_user_arn = aws_iam_role.search_admin.arn }
  }

  lifecycle { prevent_destroy = true }
}
```

ECK 위에 hot·warm nodeSet 클러스터를 CRD로 정의한다. Operator는 `helm install elastic-operator elastic/eck-operator`로 먼저 설치한다.

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: search-prod
  namespace: elastic
spec:
  version: 9.0.0
  nodeSets:
    - name: hot
      count: 3
      config:
        node.roles: ["master", "data_hot", "ingest"]
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              resources:
                requests: { cpu: 2, memory: 8Gi }
                limits: { memory: 8Gi }
      volumeClaimTemplates:
        - metadata: { name: elasticsearch-data }
          spec:
            accessModes: ["ReadWriteOnce"]
            resources: { requests: { storage: 200Gi } }
            storageClassName: gp3
    - name: warm
      count: 2
      config:
        node.roles: ["data_warm"]
```

Spring Boot 3.x에서 Elastic Cloud에 API Key로 접속하는 `ElasticsearchClient` 설정이다.

```java
package com.example.search.config;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.jackson.JacksonJsonpMapper;
import co.elastic.clients.transport.rest5_client.Rest5ClientTransport;
import co.elastic.clients.transport.rest5_client.low_level.Rest5Client;
import org.apache.hc.core5.http.HttpHost;
import org.apache.hc.core5.http.message.BasicHeader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ElasticCloudConfig {

    @Bean
    ElasticsearchClient elasticsearchClient(
            @Value("${elastic.cloud.endpoint}") String endpoint,
            @Value("${elastic.cloud.api-key}") String apiKey) {

        var restClient = Rest5Client.builder(HttpHost.create(endpoint))
                .setDefaultHeaders(new BasicHeader[] {
                        new BasicHeader("Authorization", "ApiKey " + apiKey)
                })
                .build();

        return new ElasticsearchClient(
                new Rest5ClientTransport(restClient, new JacksonJsonpMapper()));
    }
}
```

## 실무에서 걸리는 지점

- **Kibana 기본 시간 범위.** Discover 기본값 Last 15 minutes 때문에 과거 장애 로그가 0건으로 보인다. 운영 대시보드는 24h 이상으로 저장한다.
- **Saved Object 백업.** 대시보드는 `.kibana` 시스템 인덱스에 있으므로 export ndjson을 git에 커밋하고 정기 스냅샷에 포함한다.
- **UltraWarm 응답.** 캐시 미스 시 수십 초까지 느려져 사용자 대면 인덱스는 Hot에 둔다.
- **매니지드 스냅샷 보존.** ==AWS는 14일, Elastic Cloud Hosted는 직전 24시간만 보관한다.== 그 이전 복구는 자체 리포지토리와 SLM 정책이 필요하다.
- **인덱스 매핑 immutability.** ==`elasticstack_elasticsearch_index`의 mappings를 바꾸면 인덱스 replace로 데이터가 사라진다.== Terraform은 index template·alias를 관리하고 새 매핑은 새 인덱스로 만든다. 비밀은 Secrets Manager·Vault로 분리한다.

## 관련 글

- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [Snapshot·Restore와 보안 (RBAC)](/notes/elasticsearch/snapshot-security/)
- [Spring Data Elasticsearch](/notes/elasticsearch/spring-data-elasticsearch/)
