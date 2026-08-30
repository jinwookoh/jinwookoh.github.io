---
title: "XML·JSON·Multi-file 입출력"
series: spring-batch
part: "Reader·Processor·Writer"
order: 14
summary: "XML·JSON도 fragment·object 단위로 스트리밍하고, 여러 파일은 delegate 하나로 묶어 재시작 위치까지 추적한다"
tags: [Spring Batch, StaxEventItemReader, JsonItemReader, MultiResourceItemReader, Jackson]
sources: [batch/2026-05-17-batch-xml-reader-writer.md, batch/2026-05-17-batch-json-reader-writer.md, batch/2026-05-17-batch-multi-file-input.md]
updated: 2026-08-29
---

수 GB짜리 XML이나 JSON을 DOM 파서나 `ObjectMapper.readValue(file, List.class)`로 읽으면 파일 크기에 비례하는 힙이 필요하고, 중간에 실패하면 처음부터 다시 돌려야 한다. 일자별로 쪼개 들어오는 파일을 파일마다 Step으로 만들면 Step 수가 파일 수만큼 는다. Spring Batch는 XML·JSON을 record 단위로 스트리밍하는 Reader/Writer와, 여러 파일을 하나의 stream으로 합치는 `MultiResourceItemReader`로 이 문제를 처리한다.

## 핵심 개념

### XML — fragment 단위 StAX 스트리밍

DOM은 전체 트리를 메모리에 올리고 SAX는 push 방식이라 제어권이 파서에 있다. StAX는 pull 파서라 `ItemReader.read()` 계약과 맞물린다.

XML에서는 fragment가 record 단위다. `StaxEventItemReader`는 `addFragmentRootElements("trade")`로 지정한 element를 만나면 그 fragment를 standalone XML로 감싸 Spring OXM `Unmarshaller`에 넘긴다. OXM 구현은 JAXB와 Jackson XML 모듈이 주 선택지이고, ==XStream은 역직렬화 취약점 이력 때문에 신뢰할 수 없는 입력에는 쓰지 않는다==.

`StaxEventItemWriter`는 `rootTagName`으로 wrapper를 열고 item마다 Marshaller가 만든 fragment를 쌓은 뒤 닫는다. 기본이 transactional이라 chunk commit 시점에 flush되고 rollback 시 파일 변경도 취소된다.

### JSON — object 단위 스트리밍

`JsonItemReader`는 입력이 JSON object의 array라고 가정하고 원소 하나를 item 하나로 읽는다. 파싱은 `JsonObjectReader<T>`에 위임하며, `JacksonJsonObjectReader`·`GsonJsonObjectReader`는 streaming API로 원소를 하나씩 꺼내므로 메모리가 일정하다. Spring Boot가 구성한 `ObjectMapper`를 넘기면 `JavaTimeModule`과 record 인식이 따라온다.

`JsonFileItemWriter`는 `JsonObjectMarshaller<T>`로 직렬화한 item을 `[`와 `]` 사이에 comma로 구분해 쓴다. NDJSON은 지원하지 않으므로 `FlatFileItemReader`에 Jackson `LineMapper`를 끼워 읽는다.

### 여러 파일 — MultiResourceItemReader

`Resource[]`와 delegate Reader 하나를 받아, 첫 resource를 delegate에 주입해 읽다가 `read()`가 null이면 다음 resource로 전환하고 마지막까지 끝나면 null을 돌려준다. delegate는 `ResourceAwareItemReaderItemStream` 구현체여야 하며 빈에 `resource`를 지정하지 않는다.

ExecutionContext에는 현재 resource index와 delegate 위치가 함께 저장돼 재시작 시 같은 파일의 같은 위치부터 이어간다. resource 순서가 실행 간에 같아야 성립하므로 `Comparator`로 순서를 고정한다. 포맷이 다른 Reader의 순차 연결은 Spring Batch 6의 `CompositeItemReader`가 맡는다.

## 코드

JAXB 기반 XML Reader/Writer. `jakarta.xml.bind-api`와 `jaxb-runtime` 의존성이 필요하다.

```java
@XmlRootElement(name = "trade")
@XmlAccessorType(XmlAccessType.FIELD)
public class Trade {
    private String isin;
    private long quantity;
    private BigDecimal price;
    private String customer;
    // getter/setter
}

@Configuration
public class XmlTradeConfig {

    @Bean
    public Jaxb2Marshaller tradeMarshaller() {
        Jaxb2Marshaller marshaller = new Jaxb2Marshaller();
        marshaller.setClassesToBeBound(Trade.class);
        return marshaller;
    }

    @Bean
    @StepScope
    public StaxEventItemReader<Trade> xmlTradeReader(
            @Value("#{jobParameters['input.file']}") Resource resource,
            Jaxb2Marshaller marshaller) {
        return new StaxEventItemReaderBuilder<Trade>()
                .name("xmlTradeReader")
                .resource(resource)
                .addFragmentRootElements("trade")
                .unmarshaller(marshaller)
                .build();
    }

    @Bean
    @StepScope
    public StaxEventItemWriter<Trade> xmlTradeWriter(
            @Value("#{jobParameters['output.file']}") WritableResource resource,
            Jaxb2Marshaller marshaller) {
        return new StaxEventItemWriterBuilder<Trade>()
                .name("xmlTradeWriter")
                .resource(resource)
                .marshaller(marshaller)
                .rootTagName("trades")
                .overwriteOutput(true)
                .build();
    }
}
```

Jackson 기반 JSON Reader/Writer와 NDJSON Reader. Boot의 `ObjectMapper`를 재사용하고 도메인은 record로 둔다.

```java
public record TradeJson(String isin, long quantity, BigDecimal price, String customer) {}

@Configuration
public class JsonTradeConfig {

    @Bean
    public ObjectMapper batchObjectMapper(Jackson2ObjectMapperBuilder builder) {
        return builder.build()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    @Bean
    @StepScope
    public JsonItemReader<TradeJson> jsonTradeReader(
            @Value("#{jobParameters['input.file']}") Resource resource,
            ObjectMapper batchObjectMapper) {
        return new JsonItemReaderBuilder<TradeJson>()
                .name("jsonTradeReader")
                .resource(resource)
                .jsonObjectReader(new JacksonJsonObjectReader<>(batchObjectMapper, TradeJson.class))
                .build();
    }

    @Bean
    @StepScope
    public JsonFileItemWriter<TradeJson> jsonTradeWriter(
            @Value("#{jobParameters['output.file']}") WritableResource resource,
            ObjectMapper batchObjectMapper) {
        return new JsonFileItemWriterBuilder<TradeJson>()
                .name("jsonTradeWriter")
                .resource(resource)
                .jsonObjectMarshaller(new JacksonJsonObjectMarshaller<>(batchObjectMapper))
                .shouldDeleteIfExists(true)
                .build();
    }

    @Bean
    @StepScope
    public FlatFileItemReader<TradeJson> ndjsonReader(
            @Value("#{jobParameters['input.file']}") Resource resource,
            ObjectMapper batchObjectMapper) {
        return new FlatFileItemReaderBuilder<TradeJson>()
                .name("ndjsonReader")
                .resource(resource)
                .lineMapper((line, lineNumber) -> batchObjectMapper.readValue(line, TradeJson.class))
                .build();
    }
}
```

CSV 여러 파일을 하나의 stream으로 읽는 구성. 파일명 Comparator로 순서를 고정하고, 처리 전 입력 파일을 작업 디렉토리로 옮기는 Tasklet을 앞에 둔다.

```java
@Configuration
public class MultiCsvConfig {

    @Bean
    public FlatFileItemReader<Customer> csvDelegate() {
        return new FlatFileItemReaderBuilder<Customer>()
                .name("csvDelegate")
                .delimited().delimiter(",").names("id", "name", "email")
                .targetType(Customer.class)
                .build();
    }

    @Bean
    @StepScope
    public MultiResourceItemReader<Customer> multiCsvReader(
            @Value("#{jobParameters['input.pattern']}") Resource[] resources,
            FlatFileItemReader<Customer> csvDelegate) {
        return new MultiResourceItemReaderBuilder<Customer>()
                .name("multiCsvReader")
                .resources(resources)
                .delegate(csvDelegate)
                .comparator(Comparator.comparing(Resource::getFilename))
                .build();
    }

    @Bean
    public Step moveInputFiles(JobRepository repo, PlatformTransactionManager tx) {
        return new StepBuilder("moveInputFiles", repo)
                .tasklet((contribution, chunkContext) -> {
                    Path workDir = Files.createDirectories(Path.of("/data/working"));
                    try (Stream<Path> files = Files.list(Path.of("/data/input"))) {
                        for (Path p : files.filter(f -> f.toString().endsWith(".csv")).toList()) {
                            Files.move(p, workDir.resolve(p.getFileName()));
                        }
                    }
                    return RepeatStatus.FINISHED;
                }, tx)
                .build();
    }

    @Bean
    public Job multiFileJob(JobRepository repo, Step moveInputFiles, Step processStep, Step archiveStep) {
        return new JobBuilder("multiFileJob", repo)
                .start(moveInputFiles)
                .next(processStep)
                .next(archiveStep)
                .build();
    }
}
```

## 실무에서 걸리는 지점

- **fragment 이름 불일치.** ==`addFragmentRootElements("trade")`인데 실제 element가 `trades`이면 한 건도 읽지 못한 채 정상 종료된다.==
- **InputStreamResource는 재시작이 안 된다.** 위치 복구는 seek 가능한 resource를 전제하므로 `FileSystemResource`를 쓴다.
- **JSON Writer의 append.** `append(true)`로 두 번 실행하면 `][`가 중간에 생겨 유효한 JSON이 아니다. 누적이 필요하면 NDJSON으로 바꾼다.
- **Comparator 없는 MultiResourceItemReader.** ==파일 시스템의 반환 순서는 보장되지 않아 재시작 시 처리한 파일을 다시 읽거나 건너뛴다.== 처리 중 새 파일이 들어와도 같으므로 시작 전에 작업 디렉토리로 옮겨 snapshot을 고정한다.
- **delegate 공유와 파일 수.** singleton delegate를 두 Reader가 공유하면 상태가 섞이므로 `@StepScope`로 분리한다. wildcard가 수만 파일에 매칭되면 `MultiResourcePartitioner`로 partition을 나눈다.

## 관련 글

- [Flat File Reader·Writer](/notes/spring-batch/flat-file-reader-writer/)
- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
- [Scaling — Multi-thread·Partitioning·Remote Chunking](/notes/spring-batch/scaling-partitioning/)
