# spring-batch 매핑 (20편)

B = batch/ 폴더, R = 루트(posts/study/ 바로 아래). 날짜 접두는 실제 파일명 그대로.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | what-is-spring-batch | Spring Batch란 — 아키텍처와 도메인 언어 | 개념 | batch/2026-05-17-batch-intro.md, batch/2026-05-17-batch-architecture.md, batch/2026-05-17-batch-domain-language.md, R/2026-05-03-spring-batch-basics.md |
| 2 | first-job-infrastructure | 첫 Job — Infrastructure 설정과 v5/v6 변경 사항 | 개념 | batch/2026-05-17-batch-whats-new-v6.md, batch/2026-05-17-batch-infrastructure.md, R/2026-05-03-spring-batch-5-migration.md |
| 3 | configuring-job | Job 설정 — JobBuilder·Validator·Listener | Job과 실행 | batch/2026-05-17-batch-configuring-job.md, R/2026-05-03-spring-batch-job-config.md |
| 4 | job-repository-schema | JobRepository와 메타데이터 스키마 | Job과 실행 | batch/2026-05-17-batch-job-repository.md, batch/2026-05-17-batch-meta-data-schema.md |
| 5 | running-jobs | Job 실행 — JobLauncher·JobOperator·JobExplorer | Job과 실행 | batch/2026-05-17-batch-job-operator.md, batch/2026-05-17-batch-running-job.md, batch/2026-05-17-batch-advanced-metadata.md |
| 6 | step-chunk-tasklet | Step — Chunk 지향과 Tasklet·Commit Interval | Step | batch/2026-05-17-batch-step-overview.md, batch/2026-05-17-batch-chunk-configuring.md, batch/2026-05-17-batch-tasklet-step.md, R/2026-05-03-spring-batch-chunk.md |
| 7 | step-restart-itemstream | Step 재시작과 ItemStream | Step | batch/2026-05-17-batch-step-restart.md, batch/2026-05-17-batch-item-stream-registering.md, batch/2026-05-17-batch-item-stream.md |
| 8 | flow-control-late-binding | Flow 제어 — Decision·Split·Late Binding | Step | batch/2026-05-17-batch-controlling-flow.md, batch/2026-05-17-batch-late-binding.md, R/2026-05-03-spring-batch-job-flow.md |
| 9 | step-listeners | Step Listener | Step | batch/2026-05-17-batch-step-listeners.md |
| 10 | skip-retry | Skip과 Retry | 오류 처리와 트랜잭션 | batch/2026-05-17-batch-skip-logic.md, batch/2026-05-17-batch-retry-logic.md, batch/2026-05-17-batch-retry.md, R/2026-05-03-spring-batch-error-handling.md |
| 11 | transaction-attributes-repeat | 트랜잭션 속성과 Repeat | 오류 처리와 트랜잭션 | batch/2026-05-17-batch-transaction-attributes.md, batch/2026-05-17-batch-repeat.md |
| 12 | reader-writer-interfaces | ItemReader·ItemWriter 인터페이스와 구현체 카탈로그 | Reader·Processor·Writer | batch/2026-05-17-batch-item-reader.md, batch/2026-05-17-batch-item-writer.md, batch/2026-05-17-batch-reader-writer-impls.md |
| 13 | flat-file-reader-writer | Flat File Reader·Writer | Reader·Processor·Writer | batch/2026-05-17-batch-flat-files-overview.md, batch/2026-05-17-batch-field-set.md, batch/2026-05-17-batch-flat-file-reader.md, batch/2026-05-17-batch-flat-file-writer.md, R/2026-05-03-spring-batch-readers.md |
| 14 | xml-json-multifile | XML·JSON·Multi-file 입출력 | Reader·Processor·Writer | batch/2026-05-17-batch-xml-reader-writer.md, batch/2026-05-17-batch-json-reader-writer.md, batch/2026-05-17-batch-multi-file-input.md |
| 15 | database-reader-writer | Database Reader·Writer — Cursor vs Paging | Reader·Processor·Writer | batch/2026-05-17-batch-database-reader-writer.md, R/2026-05-03-spring-batch-writers.md |
| 16 | item-processor-custom | ItemProcessor·서비스 재사용·커스텀 구현 | Reader·Processor·Writer | batch/2026-05-17-batch-item-processor.md, batch/2026-05-17-batch-reusing-services.md, batch/2026-05-17-batch-custom-reader-writer.md |
| 17 | scaling-partitioning | Scaling — Multi-thread·Partitioning·Remote Chunking | 확장과 운영 | batch/2026-05-17-batch-scaling-parallel.md, batch/2026-05-17-batch-async-externalization.md |
| 18 | spring-batch-integration | Spring Batch Integration — 메시지로 Job 실행 | 확장과 운영 | batch/2026-05-17-batch-integration-overview.md, batch/2026-05-17-batch-launching-via-messages.md |
| 19 | testing-observability | 테스트와 관측성 — @SpringBatchTest·Micrometer·JFR | 확장과 운영 | batch/2026-05-17-batch-testing.md, batch/2026-05-17-batch-observability-micrometer.md, batch/2026-05-17-batch-observability-jfr.md |
| 20 | operations-patterns-faq | 운영 패턴과 FAQ | 확장과 운영 | batch/2026-05-17-batch-common-patterns.md, batch/2026-05-17-batch-faq-and-wrapup.md |
