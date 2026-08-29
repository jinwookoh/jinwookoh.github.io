# elasticsearch 매핑 (22편)

E = elasticsearch/ 폴더, R = 루트(posts/study/ 바로 아래). 날짜 접두는 실제 파일명 그대로.
E30(Monitoring)·E34(Observability)는 observability 시리즈로 보낸다.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | what-is-elasticsearch | Elasticsearch란 — Index·Document·Shard·Replica | 기초 | elasticsearch/2026-05-19-elasticsearch-welcome.md, elasticsearch/2026-05-19-elasticsearch-core-concepts.md, R/2026-05-03-es-core-concepts.md |
| 2 | lucene-internals | Lucene 내부 — Segment·역색인·Posting List | 기초 | elasticsearch/2026-05-19-elasticsearch-lucene-internals.md |
| 3 | quickstart | Quickstart — Docker Compose·첫 요청·Kibana Dev Tools | 기초 | elasticsearch/2026-05-19-elasticsearch-quickstart.md |
| 4 | index-management-ilm | Index 관리·ILM·Rollover | 인덱스와 매핑 | elasticsearch/2026-05-19-elasticsearch-index-management.md, elasticsearch/2026-05-19-elasticsearch-ilm-aliases-rollover.md |
| 5 | document-crud-bulk-reindex | Document CRUD·Bulk·Reindex·Versioning | 인덱스와 매핑 | elasticsearch/2026-05-19-elasticsearch-document-crud-versioning.md, elasticsearch/2026-05-19-elasticsearch-bulk-api.md, R/2026-05-03-es-bulk-api.md |
| 6 | mapping-field-types | Mapping과 Field Type | 인덱스와 매핑 | elasticsearch/2026-05-19-elasticsearch-mapping-deep.md, elasticsearch/2026-05-19-elasticsearch-field-types-deep.md, R/2026-05-03-es-mapping.md |
| 7 | analyzer-korean | Analyzer와 한국어 분석 (Nori) | 인덱스와 매핑 | elasticsearch/2026-05-19-elasticsearch-analyzer-deep.md, elasticsearch/2026-05-19-elasticsearch-korean-analyzer.md, R/2026-05-03-es-analyzer.md |
| 8 | document-modeling-reindex | 검색 문서 모델링과 무중단 재색인 | 인덱스와 매핑 | elasticsearch/2026-05-26-elasticsearch-document-modeling.md, elasticsearch/2026-05-26-elasticsearch-reindex-pipeline.md, R/2026-05-03-es-search-engine-project.md |
| 9 | search-api-fulltext | Search API와 Full-text 쿼리 | 검색 | elasticsearch/2026-05-19-elasticsearch-search-api-basic.md, elasticsearch/2026-05-19-elasticsearch-fulltext-queries.md, R/2026-05-03-es-full-text-search.md |
| 10 | term-compound-queries | Term-level·Compound 쿼리 | 검색 | elasticsearch/2026-05-19-elasticsearch-term-level-queries.md, elasticsearch/2026-05-19-elasticsearch-compound-queries.md, R/2026-05-03-es-query-dsl.md |
| 11 | search-features-suggesters | 검색 기능 — highlight·페이징·Suggester | 검색 | elasticsearch/2026-05-19-elasticsearch-search-features.md, elasticsearch/2026-05-19-elasticsearch-suggesters.md |
| 12 | aggregations-metric-bucket | 집계 — Metric·Bucket | 집계와 고급 검색 | elasticsearch/2026-05-19-elasticsearch-aggregations-metric.md, elasticsearch/2026-05-19-elasticsearch-aggregations-bucket.md, R/2026-05-03-es-aggregations.md |
| 13 | aggregations-pipeline | 집계 — Pipeline | 집계와 고급 검색 | elasticsearch/2026-05-19-elasticsearch-aggregations-pipeline.md |
| 14 | vector-search-knn | Vector Search·kNN | 집계와 고급 검색 | elasticsearch/2026-05-19-elasticsearch-vector-search-knn.md |
| 15 | rag-hybrid-search | RAG·Hybrid Search | 집계와 고급 검색 | elasticsearch/2026-05-19-elasticsearch-rag-hybrid-search.md |
| 16 | ingest-pipeline-collectors | Ingest Pipeline과 수집기 (Logstash·Beats·Fluentd) | 수집 | elasticsearch/2026-05-19-elasticsearch-ingest-pipeline.md, elasticsearch/2026-05-19-elasticsearch-logstash-beats-fluentd.md |
| 17 | cluster-operations-shard-allocation | 클러스터 운영과 Shard Allocation | 운영 | elasticsearch/2026-05-19-elasticsearch-cluster-operations.md, elasticsearch/2026-05-19-elasticsearch-shard-allocation.md |
| 18 | snapshot-security | Snapshot·Restore와 보안 (RBAC) | 운영 | elasticsearch/2026-05-19-elasticsearch-snapshot-restore.md, elasticsearch/2026-05-19-elasticsearch-security-rbac.md, R/2026-05-03-es-security.md |
| 19 | performance-tuning | 성능 튜닝 | 운영 | elasticsearch/2026-05-19-elasticsearch-performance-tuning.md |
| 20 | spring-data-elasticsearch | Spring Data Elasticsearch | 통합과 클라우드 | elasticsearch/2026-05-19-elasticsearch-spring-data-integration.md, R/2026-05-03-es-spring-integration.md |
| 21 | kibana-cloud-opensearch-iac | Kibana·Elastic Cloud·OpenSearch·IaC | 통합과 클라우드 | elasticsearch/2026-05-19-elasticsearch-kibana-elk-stack.md, elasticsearch/2026-05-19-elasticsearch-aws-opensearch.md, elasticsearch/2026-05-19-elasticsearch-elastic-cloud.md, elasticsearch/2026-05-19-elasticsearch-iac-terraform-cdk.md |
| 22 | decision-checklist | 마무리 — 결정 트리와 체크리스트 | 통합과 클라우드 | elasticsearch/2026-05-19-elasticsearch-series-conclusion.md |
