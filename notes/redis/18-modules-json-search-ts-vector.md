---
title: "확장 모듈 — JSON·Search·TimeSeries·Vector"
series: redis
part: "확장 모듈"
order: 18
summary: "기본 자료구조로 흉내내던 문서·검색·시계열·벡터 워크로드를 Redis 모듈이 어떻게 1급으로 처리하는지 정리한다"
tags: [Redis, RedisJSON, RediSearch, TimeSeries, Vector Search]
sources: [data-infra/2026-05-17-redis-json.md, data-infra/2026-05-17-redis-search-query.md, data-infra/2026-05-17-redis-timeseries.md, data-infra/2026-05-17-redis-vector-database.md]
updated: 2026-08-29
---

기본 자료구조만으로 JSON 객체, 조건 검색, 시계열, 벡터 검색을 흉내내면 중첩 필드 하나를 바꾸려고 객체 전체를 다시 쓰고, 세컨더리 인덱스를 손으로 유지하고, Sorted Set 시계열이 메모리를 잠식하고, 벡터 거리를 애플리케이션에서 전수 계산하게 된다. RedisJSON·RediSearch·Time Series·Vector Search 모듈은 이를 서버 안에서 네이티브 타입과 인덱스로 처리한다. Redis 8부터 기본 포함이고, 7 이하는 `redis-stack-server` 이미지나 `loadmodule`로 올린다.

## 핵심 개념

### RedisJSON

`JSON.SET key $ '{...}'`로 문서를 저장하고 JSONPath(`$.field`, `$.arr[0]`, `$..field` 재귀, `$.arr[?(@.price > 100)]` 필터)로 하위 경로에 접근한다. 핵심은 부분 갱신이다. `JSON.SET user:42 $.address.city '"Busan"'`은 중첩 필드 하나만 원자적으로 바꾸고, `JSON.NUMINCRBY`·`JSON.ARRAPPEND`·`JSON.DEL`은 카운터·배열·경로 단위로 조작한다. `JSON.GET`의 경로 결과는 항상 배열로 감싸여 온다. SQL 조인·다중 행 ACID·영구 보관은 PostgreSQL JSONB가 맡고, 자주 읽고 쓰는 작은 문서만 RedisJSON에 둔다.

### RediSearch

`FT.CREATE idx ON HASH|JSON PREFIX 1 "product:" SCHEMA ...`로 인덱스를 선언하면 해당 접두사의 키가 쓰일 때마다 자동 색인된다. 필드 타입은 TEXT(전문 검색, BM25 점수, `@name:laptop`), NUMERIC(범위, `@price:[100 500]`), TAG(정확 매칭, `@category:{a|b}`), GEO, VECTOR 다섯 가지다. 공백이 AND, `|`가 OR, `-`가 NOT이다. JSON 인덱스는 `$.name AS name TEXT`처럼 별칭을 붙이고, `FT.AGGREGATE ... GROUPBY 1 @category REDUCE AVG 1 @price`가 SQL GROUP BY를 대신한다.

### Time Series

`TS.CREATE key RETENTION <ms> LABELS k v`로 시리즈를 만들고 `TS.ADD key * value`로 샘플을 넣는다. `TS.RANGE key - + AGGREGATION avg 300000`은 5분 평균, `TS.MRANGE - + FILTER region=us-east`는 라벨 조회다. `RETENTION`이 오래된 샘플을 자동 삭제하고 `TS.CREATERULE src dest AGGREGATION avg 60000`이 1분 평균을 대상 시리즈에 누적하므로, 원본은 짧게 집계는 길게 보관한다. 기본 `COMPRESSED` 인코딩은 Gorilla 압축으로 16바이트 샘플을 1~3바이트로 줄인다.

### Vector Search

임베딩은 텍스트·이미지를 N차원 float 배열로 바꾼 값이며 의미가 가까울수록 거리가 짧다. VECTOR 필드는 `TYPE FLOAT32 DIM 768 DISTANCE_METRIC COSINE` 속성과 FLAT 또는 HNSW를 받는다. FLAT은 전수 조사라 정확하지만 O(N)이고, ==HNSW는 그래프 근사 탐색으로 수백만 벡터에서도 밀리초 응답을 내되 recall이 90~99%다.== 메트릭은 텍스트 임베딩이면 COSINE, 비정규화 벡터면 L2다. `@price:[100 500] =>[KNN 5 @vec $q AS score]`는 사전 필터 뒤에 KNN을 적용하는 하이브리드 검색이며, RAG는 이렇게 찾은 문서 chunk를 LLM 프롬프트에 넣는 흐름이다.

## 코드

Spring Data Redis에는 모듈 전용 API가 없으므로 `RedisTemplate.execute`로 원시 명령을 보낸다.

```java
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

@Component
public class RedisModuleCommands {

    private final RedisTemplate<String, String> redisTemplate;

    public RedisModuleCommands(RedisTemplate<String, String> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    private Object exec(String command, String... args) {
        byte[][] raw = Arrays.stream(args)
                .map(a -> a.getBytes(StandardCharsets.UTF_8))
                .toArray(byte[][]::new);
        return redisTemplate.execute(connection -> connection.execute(command, raw), true);
    }

    public void setUser(String id, String json) {
        exec("JSON.SET", "user:" + id, "$", json);
    }

    public void moveCity(String id, String city) {
        exec("JSON.SET", "user:" + id, "$.address.city", "\"" + city + "\"");
    }

    public String getCity(String id) {
        Object result = exec("JSON.GET", "user:" + id, "$.address.city");
        return new String((byte[]) result, StandardCharsets.UTF_8); // ["Busan"]
    }

    public long addSample(String series, double value) {
        return (Long) exec("TS.ADD", series, "*", Double.toString(value));
    }

    @SuppressWarnings("unchecked")
    public List<Object> range(String series, long fromMs, long toMs, long bucketMs) {
        return (List<Object>) exec("TS.RANGE", series, Long.toString(fromMs), Long.toString(toMs),
                "AGGREGATION", "avg", Long.toString(bucketMs));
    }
}
```

검색은 Redis OM Spring이 어노테이션으로 `FT.CREATE`를 실행하고 파생 쿼리 메서드를 `FT.SEARCH`로 번역한다(`@EnableRedisDocumentRepositories` 필요).

```java
import com.redis.om.spring.annotations.Document;
import com.redis.om.spring.annotations.Indexed;
import com.redis.om.spring.annotations.Searchable;
import com.redis.om.spring.repository.RedisDocumentRepository;
import org.springframework.data.annotation.Id;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

import java.util.Set;

@Document
public record Product(
        @Id String id,
        @Searchable String name,          // TEXT
        @Indexed Double price,            // NUMERIC SORTABLE
        @Indexed Set<String> categories   // TAG
) {}

public interface ProductRepository extends RedisDocumentRepository<Product, String> {
    Page<Product> findByName(String name, Pageable pageable);
    Page<Product> findByPriceBetween(Double min, Double max, Pageable pageable);
}
```

벡터 검색은 Spring AI `VectorStore`를 쓴다. `add`가 임베딩과 JSON 저장을, `similaritySearch`가 KNN 쿼리를 수행한다.

```java
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class DocSearchService {

    private final VectorStore vectorStore;

    public DocSearchService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public void index(String id, String text, String category) {
        vectorStore.add(List.of(new Document(id, text, Map.of("category", category))));
    }

    public List<Document> search(String question, String category) {
        return vectorStore.similaritySearch(SearchRequest.builder()
                .query(question)
                .topK(5)
                .filterExpression("category == '" + category + "'")
                .build());
    }
}
```

## 실무에서 걸리는 지점

- **문서 크기와 인덱스 메모리.** 큰 JSON은 부분 갱신도 비싸지고 RediSearch는 원본과 역인덱스를 모두 메모리에 든다. 키를 잘게 쪼개고 TEXT 필드를 최소화한다.
- **스키마 변경은 재빌드다.** `FT.DROPINDEX` 후 재생성해야 하고 데이터셋이 크면 수 분이 걸린다. 새 인덱스를 만든 뒤 `FT.ALIASUPDATE`로 교체한다.
- **TAG separator와 한국어.** TAG 기본 구분자는 `,`라 값에 콤마가 있으면 쪼개지므로 `SEPARATOR "|"`를 명시한다. 한국어 형태소 검색은 Elasticsearch nori가 낫다.
- **Time Series는 retention·compaction을 직접 건다.** ==`RETENTION 0`(기본)은 무제한 누적이고 `TS.CREATERULE` 없이는 downsampling이 돌지 않는다.== `UNCOMPRESSED`는 메모리가 수십 배 늘어 쓰지 않는다.
- **벡터 메모리와 모델 일관성.** 768차원 float32 100만 개는 벡터만 3GB다. ==색인과 쿼리의 임베딩 모델이 다르면 결과가 무의미해지므로 모델명을 메타데이터에 기록한다.==

## 관련 글

- [Secondary Index·Fanout·분산 ID](/notes/redis/secondary-index-fanout-id/)
- [Sorted Set — 랭킹과 Rate Limiter](/notes/redis/sorted-set/)
- [메모리 최적화와 클라이언트 (Jedis·Lettuce)](/notes/redis/memory-clients/)
