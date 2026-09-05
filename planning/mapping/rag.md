# rag 매핑 (10편) — 공식 문서 기반

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | what-is-rag | RAG란 무엇인가 — LLM의 한계와 검색 증강 생성 | 기초 | https://platform.openai.com/docs/guides/retrieval, https://docs.claude.com/en/docs/build-with-claude/embeddings |
| 2 | embeddings-vector-search | 임베딩과 벡터 유사도 검색 | 기초 | https://platform.openai.com/docs/guides/embeddings, https://docs.claude.com/en/docs/build-with-claude/embeddings |
| 3 | vector-databases | 벡터 데이터베이스 — pgvector·전용 벡터 스토어 선택 | 기초 | https://github.com/pgvector/pgvector, https://qdrant.tech/documentation/overview/, https://www.elastic.co/docs/solutions/search/vector |
| 4 | chunking-indexing | 청킹과 인덱싱 전략 | 검색 파이프라인 | https://docs.llamaindex.ai/en/stable/module_guides/loading/node_parsers/, https://python.langchain.com/docs/concepts/text_splitters/ |
| 5 | hybrid-search-rerank | 하이브리드 검색과 리랭킹 | 검색 파이프라인 | https://www.elastic.co/docs/solutions/search/hybrid-search, https://qdrant.tech/documentation/concepts/hybrid-queries/, https://docs.cohere.com/docs/rerank-overview |
| 6 | query-transformation | 쿼리 변환 — 멀티 쿼리·HyDE·라우팅 | 검색 파이프라인 | https://docs.llamaindex.ai/en/stable/optimizing/advanced_retrieval/query_transformations/, https://python.langchain.com/docs/how_to/MultiQueryRetriever/ |
| 7 | graph-rag | GraphRAG — 지식 그래프 기반 검색 증강 | 그래프와 온톨로지 | https://microsoft.github.io/graphrag/, https://neo4j.com/docs/neo4j-graphrag-python/current/ |
| 8 | ontology-knowledge-graph | 온톨로지와 지식 그래프 모델링 — RDF·OWL·프로퍼티 그래프 | 그래프와 온톨로지 | https://www.w3.org/TR/rdf11-primer/, https://www.w3.org/TR/owl2-primer/, https://neo4j.com/docs/getting-started/data-modeling/ |
| 9 | rag-evaluation | RAG 평가 — 검색 품질과 생성 품질을 따로 잰다 | 운영 | https://docs.ragas.io/en/stable/concepts/metrics/, https://docs.llamaindex.ai/en/stable/module_guides/evaluating/ |
| 10 | production-rag | 프로덕션 RAG — 캐싱·비용·보안·에이전틱 패턴 | 운영 | https://platform.openai.com/docs/guides/retrieval, https://docs.claude.com/en/docs/build-with-claude/prompt-caching, https://microsoft.github.io/graphrag/ |
