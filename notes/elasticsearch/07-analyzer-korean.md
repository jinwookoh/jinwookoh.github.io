---
title: "Analyzer와 한국어 분석 (Nori)"
series: elasticsearch
part: "인덱스와 매핑"
order: 7
summary: "text 필드가 역색인에 들어가기까지의 3단계 분석 파이프라인과, 한국어 검색에서 Nori 토크나이저를 어떻게 구성해야 하는지 정리한다."
tags: [Elasticsearch, Analyzer, Nori, Tokenizer, synonym_graph]
sources: [elasticsearch/2026-05-19-elasticsearch-analyzer-deep.md, elasticsearch/2026-05-19-elasticsearch-korean-analyzer.md, 2026-05-03-es-analyzer.md]
updated: 2026-08-29
---

Elasticsearch의 풀텍스트 검색은 문자열을 그대로 비교하지 않는다. ==색인 시 본문을 토큰으로 쪼개 역색인에 저장하고, 검색어도 같은 규칙으로 쪼개 매칭하므로 쪼개는 규칙이 곧 검색 결과를 결정한다.== 규칙을 지정하지 않으면 `text` 필드는 `standard` analyzer로 처리되는데, 영어에서는 `running`으로 색인된 문서가 `run`으로 검색되지 않고, 한국어에서는 `신촌에서`가 한 토큰으로 들어가 `신촌`으로 검색되지 않는다. 한국어는 띄어쓰기가 느슨하고 조사·어미가 어절에 붙으며 복합명사가 흔해 공백 분리만으로는 검색이 성립하지 않는다.

## 핵심 개념

모든 analyzer는 세 단계로 동작한다. **Character Filter**는 토큰화 전에 원문 문자열을 손본다(`html_strip`, `mapping`, `pattern_replace`). **Tokenizer**는 문자열을 토큰 배열로 쪼갠다(`standard`, `whitespace`, `ngram`, `edge_ngram`, `nori_tokenizer`). **Token Filter**는 쪼개진 토큰을 변환·삭제·추가한다(`lowercase`, `stop`, `stemmer`, `synonym_graph`). Character Filter와 Token Filter는 0개 이상을 순서대로 체인할 수 있고, Tokenizer는 정확히 하나만 온다. 빌트인 analyzer(`standard`, `simple`, `whitespace`, `stop`, `keyword`, `pattern`, 언어별)는 이 조합을 미리 묶어 둔 것이며, 부족하면 `settings.analysis`에서 직접 조립해 custom analyzer를 만든다.

색인 시 analyzer와 검색 시 analyzer는 기본적으로 동일하다. `search_analyzer`를 따로 두는 경우는 자동완성처럼 비대칭이 필요한 자리뿐이다. 색인은 `edge_ngram`으로 prefix 토큰을 만들고, 검색은 `standard`로 둔다.

==한국어 형태소 분석은 `analysis-nori` 플러그인이 표준이다.== Nori는 mecab-ko-dic 사전을 Lucene 인메모리 구조로 재가공해 JVM 안에서 동작하므로 별도 데몬이 필요 없다. 과거 표준이던 mecab-ko(seunjeon)는 사전 배포 비용이 크고 갱신이 멈춰 기존 인덱스 유지보수용으로만 남았다. Nori의 품질을 결정하는 옵션은 세 가지다.

| 옵션 | 역할 | 권장 |
|---|---|---|
| `decompound_mode` | 복합명사 분해 방식. `none`(분해 안 함), `discard`(조각만, 기본값), `mixed`(원본+조각) | 상품·콘텐츠 검색은 `mixed` |
| `user_dictionary` | 브랜드·모델명·인명 등 기본 사전에 없는 단어 등록 | 5천~1만 항목 이내 |
| `nori_part_of_speech`의 `stoptags` | 조사·어미·부호 등 무의미한 품사 제거 | 기본값에서 도메인에 맞춰 조정 |

동의어는 형태소 분석으로 풀 수 없는 영역이다. `synonym_graph` 필터에 `신촌, 신촌역`처럼 양방향, `노트북 => 랩탑`처럼 단방향 규칙을 등록한다. 색인 시점에 넣으면 표를 바꿀 때마다 재색인이 필요하므로, `search_analyzer`에 `updateable: true`로 붙이고 `_reload_search_analyzers` API로 무중단 갱신한다. 8.10 이상은 synonyms set API로 규칙을 인덱스 밖에서 관리한다.

## 코드

Nori 토크나이저에 사용자 사전·품사 필터·검색 시점 동의어를 조합한 인덱스 설정이다.

```json
PUT /products
{
  "settings": {
    "analysis": {
      "tokenizer": {
        "ko_tokenizer": {
          "type": "nori_tokenizer",
          "decompound_mode": "mixed",
          "user_dictionary": "analysis/userdict_ko.txt"
        }
      },
      "filter": {
        "ko_pos": { "type": "nori_part_of_speech" },
        "ko_synonym": {
          "type": "synonym_graph",
          "synonyms_path": "analysis/synonyms_ko.txt",
          "updateable": true
        }
      },
      "analyzer": {
        "ko_index": {
          "type": "custom",
          "tokenizer": "ko_tokenizer",
          "filter": ["ko_pos", "lowercase", "nori_readingform"]
        },
        "ko_search": {
          "type": "custom",
          "tokenizer": "ko_tokenizer",
          "filter": ["ko_pos", "lowercase", "nori_readingform", "ko_synonym"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "name": {
        "type": "text",
        "analyzer": "ko_index",
        "search_analyzer": "ko_search",
        "fields": { "raw": { "type": "keyword" } }
      }
    }
  }
}
```

사용자 사전은 각 노드의 `config/analysis/`에 두며, 한 줄에 단어 하나, 분해 형태는 공백으로 이어 붙인다.

```text
카카오뱅크
다이슨V15
가정용공기청정기 가정용 공기 청정기
```

Spring Boot 3.x에서 Elasticsearch Java Client로 `_analyze`를 호출해, 운영 투입 전 대표 쿼리의 분해 결과를 검증하는 서비스다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.indices.AnalyzeResponse;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;

@Service
public class AnalyzerCheckService {

    private final ElasticsearchClient client;

    public AnalyzerCheckService(ElasticsearchClient client) {
        this.client = client;
    }

    public List<String> tokens(String index, String field, String text) throws IOException {
        AnalyzeResponse response = client.indices().analyze(a -> a
                .index(index)
                .field(field)
                .text(text));
        return response.tokens().stream()
                .map(t -> t.token())
                .toList();
    }
}
```

## 실무에서 걸리는 지점

- **플러그인 미설치 노드.** `analysis-nori`는 모든 노드에 설치하고 재시작해야 한다. 한 노드라도 빠지면 그 노드의 샤드만 분석이 달라 간헐적으로 결과가 누락된다. `_cat/plugins?v`로 확인한다.
- **사용자 사전은 인덱스 open 시점에 로딩된다.** 파일만 바꿔서는 기존 인덱스에 반영되지 않으며 `_close`/`_open` 또는 reindex가 필요하다. 사전이 수만 줄로 커지면 힙 사용량과 open 시간이 늘어나므로 도메인 단어만 남긴다. 파일 배포가 막힌 매니지드 환경에서는 `user_dictionary_rules`로 설정에 직접 넣는다.
- ==**analyzer 변경은 재색인이다.** `text` 필드의 analyzer는 매핑 생성 후 바꿀 수 없다.== `standard`로 색인한 뒤 Nori로 바꾸려면 새 인덱스를 만들고 alias를 교체한다.
- **n-gram 범위 폭주.** `min_gram=1, max_gram=20` 같은 설정은 토큰 수를 수십 배로 키워 인덱스 크기와 색인 속도를 악화시킨다. 자동완성은 `edge_ngram` 2~10 범위로 별도 multi-field에만 적용한다. `decompound_mode: mixed`도 인덱스 크기를 30~50% 늘린다.
- **오타 허용.** 완성형 한글은 한 글자 차이가 자모 하나 차이인 경우가 많아 글자 단위 fuzzy query가 잘 맞지 않는다. 자모 분리 토크나이저는 Nori에 없으므로 별도 플러그인으로 `name.jamo` multi-field를 두고 `should` 절로 함께 묶는다.

## 관련 글

- [Mapping과 Field Type](/notes/elasticsearch/mapping-field-types/)
- [검색 문서 모델링과 무중단 재색인](/notes/elasticsearch/document-modeling-reindex/)
- [Search API와 Full-text 쿼리](/notes/elasticsearch/search-api-fulltext/)
