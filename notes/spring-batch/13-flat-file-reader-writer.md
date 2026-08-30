---
title: "Flat File Reader·Writer"
series: spring-batch
part: "Reader·Processor·Writer"
order: 13
summary: "CSV·고정 길이 파일을 Tokenizer→FieldSet→Mapper 3단계로 읽고 역방향으로 쓰는 구조와 재시작·트랜잭션 함정"
tags: [Spring Batch, FlatFileItemReader, FlatFileItemWriter, FieldSet, LineAggregator]
sources: [batch/2026-05-17-batch-flat-files-overview.md, batch/2026-05-17-batch-field-set.md, batch/2026-05-17-batch-flat-file-reader.md, batch/2026-05-17-batch-flat-file-writer.md, 2026-05-03-spring-batch-readers.md]
updated: 2026-08-29
---

정산·결제·파트너 인터페이스 같은 대량 데이터 교환은 여전히 CSV나 고정 길이 텍스트 파일로 오간다. 이 파일을 직접 읽으면 header 건너뛰기, 따옴표 안의 구분자, 셀 안의 줄바꿈, 인코딩, 타입 변환, 중단 지점부터의 재시작을 job마다 다시 구현하게 된다. `FlatFileItemReader`와 `FlatFileItemWriter`는 이 과정을 교체 가능한 컴포넌트로 표준화하고 `ItemStream`으로 재시작 위치까지 관리한다.

## 핵심 개념

Flat file은 구분자로 필드를 나누는 Delimited와 position으로 자르는 Fixed length 두 형태다.

Reader는 한 줄을 세 단계로 객체로 바꾼다. `FlatFileItemReader`가 한 줄 `String`을 읽고, `LineTokenizer`가 `FieldSet`으로 분리하고, `FieldSetMapper`가 객체로 매핑한다. 뒤의 둘을 묶는 표준 구현이 `DefaultLineMapper`다.

`LineTokenizer`는 `DelimitedLineTokenizer`, `FixedLengthTokenizer`(`Range` 배열, 1-based inclusive), `PatternMatchingCompositeLineTokenizer`(줄 prefix별로 다른 tokenizer)가 있다. `FieldSetMapper`는 `BeanWrapperFieldSetMapper`(setter 매칭), `RecordFieldSetMapper`(record component 매칭), 직접 구현이 있으며 `.targetType(Class)`가 대상 타입에 맞는 mapper를 자동 적용한다.

`FieldSet`은 JDBC `ResultSet`과 같은 모델로 한 줄을 다루는 추상화다. index나 name으로 접근하고 `readInt`·`readBigDecimal`·`readDate` 계열이 타입 변환을 맡는다. `readInt("count", 0)`처럼 default를 주면 빈 셀을 안전하게 처리하고, 변환 실패는 `IllegalArgumentException`이라 Skip 정책이 흡수한다. `readDate`는 `java.util.Date`를 반환하므로 `LocalDate`가 필요하면 `readString` 후 직접 parse한다.

Writer는 정확히 역방향이다. `FieldExtractor`가 객체에서 `Object[]`를 뽑고, `LineAggregator`가 한 줄로 합치며, `FlatFileItemWriter`가 파일에 쓴다.

| 단계 | Reader | Writer |
|:---|:---|:---|
| 분리·추출 | `LineTokenizer` | `FieldExtractor` |
| 중간 표현 | `FieldSet` | `Object[]` |
| 변환·조립 | `FieldSetMapper` | `LineAggregator` |

`FieldExtractor`는 `BeanWrapperFieldExtractor`(getter 매칭)와 `RecordFieldExtractor`, `LineAggregator`는 `DelimitedLineAggregator`와 `FormatterLineAggregator`(printf 스타일 고정 폭)가 대표적이며 Builder의 `.delimited()`·`.formatted()`가 각 조합을 자동 구성한다.

## 코드

Late Binding으로 입력 파일을 받는 표준 CSV reader. record를 대상으로 하면 setter 없이 불변 객체로 매핑된다.

```java
public record Customer(Long id, String name, String email, String createdAt) {}

@Bean
@StepScope
public FlatFileItemReader<Customer> customerReader(
        @Value("#{jobParameters['input.file']}") Resource resource) {
    return new FlatFileItemReaderBuilder<Customer>()
        .name("customerReader")
        .resource(resource)
        .encoding("UTF-8")
        .linesToSkip(1)
        .skippedLinesCallback(line -> log.info("header: {}", line))
        .recordSeparatorPolicy(new DefaultRecordSeparatorPolicy())
        .delimited()
            .delimiter(",")
            .quoteCharacter('"')
            .names("id", "name", "email", "createdAt")
        .targetType(Customer.class)
        .build();
}
```

고정 길이 파일을 `Range`로 자르고 검증을 겸한 custom `FieldSetMapper`로 매핑하는 reader. mapper가 던진 예외는 Skip 정책으로 넘어간다.

```java
@Bean
@StepScope
public FlatFileItemReader<Order> orderReader(
        @Value("#{jobParameters['input.file']}") Resource resource) {
    return new FlatFileItemReaderBuilder<Order>()
        .name("orderReader")
        .resource(resource)
        .encoding("UTF-8")
        .fixedLength()
            .columns(new Range(1, 12), new Range(13, 15),
                     new Range(16, 20), new Range(21, 29))
            .names("isin", "quantity", "price", "customer")
            .strict(false)
        .fieldSetMapper(fs -> {
            int quantity = fs.readInt("quantity", 0);
            if (quantity <= 0) {
                throw new IllegalStateException("invalid quantity: " + quantity);
            }
            return new Order(
                fs.readString("isin").trim(),
                quantity,
                fs.readBigDecimal("price", BigDecimal.ZERO),
                fs.readString("customer").trim());
        })
        .build();
}
```

header와 통계 footer를 가진 CSV writer. `StepExecution`을 주입받아 `writeCount`를 footer에 기록한다.

```java
@Bean
@StepScope
public FlatFileItemWriter<Customer> customerWriter(
        @Value("#{jobParameters['output.file']}") WritableResource resource,
        @Value("#{stepExecution}") StepExecution stepExecution) {
    return new FlatFileItemWriterBuilder<Customer>()
        .name("customerWriter")
        .resource(resource)
        .encoding("UTF-8")
        .lineSeparator("\n")
        .shouldDeleteIfEmpty(true)
        .headerCallback(w -> w.write("id,name,email"))
        .footerCallback(w -> w.write("# total=" + stepExecution.getWriteCount()))
        .delimited()
            .delimiter(",")
            .names("id", "name", "email")
        .build();
}
```

## 실무에서 걸리는 지점

- **encoding·lineSeparator 미명시.** 기본값이 JVM 설정을 따라 환경마다 달라진다. Windows에서 저장된 UTF-8 파일은 BOM이 첫 컬럼 값에 섞이므로 전처리로 제거한다.
- **`strict`는 두 곳에 있고 의미가 다르다.** ==Reader의 `strict(false)`는 resource가 없을 때 예외 대신 0건 처리이고, Tokenizer의 `strict(false)`는 token 수·line 길이 불일치 시 `IncorrectTokenCountException` 대신 빈 값으로 padding한다.==
- **`transactional(true)`(기본)는 chunk commit까지 출력을 buffer에 쌓는다.** rollback 시 파일 변경을 취소하기 위한 장치다. ==`false`로 바꾸면 즉시 flush되지만 rollback 후 부분 데이터가 남아 재시도 시 row가 중복된다.==
- **`shouldDeleteIfExists(true)`는 재시작과 충돌한다.** ==재시작 시 `open()`은 `ExecutionContext`의 마지막 write 위치까지 파일을 truncate하고 이어서 쓰는데, 시작 시 파일을 삭제하면 이전 결과가 사라진다.== 매번 새로 쓰는 멱등 출력일 때만 `true`를 쓴다.
- **`PatternMatchingCompositeLineMapper`는 매치되지 않는 줄에서 예외를 던진다.** `*` catch-all을 마지막에 둔다.

## 관련 글

- [ItemReader·ItemWriter 인터페이스와 구현체 카탈로그](/notes/spring-batch/reader-writer-interfaces/)
- [XML·JSON·Multi-file 입출력](/notes/spring-batch/xml-json-multifile/)
- [Step 재시작과 ItemStream](/notes/spring-batch/step-restart-itemstream/)
