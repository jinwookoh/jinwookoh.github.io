---
title: "Elasticsearch 검색과 S3 업로드"
series: sns-project
part: "데이터와 검색"
order: 5
summary: "DB를 진실의 원천으로 두고 검색 인덱싱과 파일 업로드를 트랜잭션 바깥으로 분리하는 방법"
tags: [Elasticsearch, nori, S3, Presigned URL, LocalStack]
sources: [2026-05-04-javaex-sns-elasticsearch-s3.md]
updated: 2026-08-29
---

게시글 검색을 PostgreSQL의 `LIKE '%검색어%'`로 구현하면 세 가지 문제가 동시에 나타난다. B-tree 인덱스를 타지 못해 전체 테이블을 스캔하고, "자동차"로 검색해도 "자동차 정비"가 조사·어미 처리 없이 매칭되지 않으며, 검색어와의 연관도(relevance)로 정렬할 수 없다. 파일 업로드도 비슷하다. 서버가 multipart로 받아 다시 S3에 올리는 방식은 파일이 서버 메모리를 한 번 거치고 네트워크를 두 번 타기 때문에, 대용량 파일이나 동시 업로드가 늘어나면 서버 인스턴스를 함께 늘려야 한다. 두 문제 모두 전용 인프라에 넘기되, 그 인프라의 실패가 핵심 흐름을 막지 않도록 분리하는 것이 해법이다.

## 핵심 개념

### 역색인과 nori 형태소 분석

Elasticsearch는 문서를 단어 단위로 쪼개 "단어 → 문서 목록" 형태의 역색인(inverted index)을 만든다. "자동차 수리 전문점", "자동차 보험 추천", "오토바이 수리" 세 문서가 있으면 `자동차 → [1, 2]`, `수리 → [1, 3]` 같은 목록이 미리 생성되고, "자동차 수리" 검색은 두 목록의 교집합 `[1]`을 구하는 집합 연산으로 끝난다. 문서 수가 수백만이어도 상위 결과를 꺼내는 비용이 검색어 수에 비례할 뿐 문서 수에 비례하지 않는다.

한국어는 공백만으로 단어가 분리되지 않으므로 형태소 분석기가 필요하다. nori 토크나이저는 "서울역 근처 맛집"을 `["서울역", "근처", "맛집"]`으로 쪼개고 조사 같은 의미 없는 토큰을 걸러낸다. ==nori는 기본 내장 분석기가 아니라 `analysis-nori` 플러그인으로 별도 설치해야 하며, 설치 후 재시작하지 않으면 인덱스 생성 시 analyzer not found 오류가 난다.==

### 인덱싱과 트랜잭션의 분리

게시글 저장과 ES 인덱싱을 같은 트랜잭션 안에서 처리하면 두 가지 문제가 생긴다. DB가 롤백됐는데 ES에는 문서가 남거나, ES 장애가 게시글 저장 자체를 실패시킨다. 이 프로젝트는 DB를 진실의 원천(source of truth)으로 두고 인덱싱을 `afterCommit()` 시점으로 미룬 뒤, 인덱싱 실패는 예외를 던지지 않고 로그만 남긴다. ES가 잠시 내려가도 게시글은 정상 저장되고 검색 결과에서만 잠시 빠지며, 누락분은 별도 동기화 작업으로 채운다.

### Presigned URL 직접 업로드

Presigned URL은 "이 키에 대해 제한 시간 동안 PUT을 허용한다"는 서명이 붙은 URL이다. 서버는 URL을 발급만 하고, 브라우저가 S3에 직접 PUT한다. 파일 바이트가 서버를 전혀 거치지 않으므로 파일 크기와 무관하게 서버 부담이 일정하다. 업로드는 네 단계로 진행된다.

| 단계 | 요청 | 서버 처리 |
|---|---|---|
| 1 | `POST /v1/media/presigned-url` | 키 `media/{userId}/{uuid}/{fileName}` 생성, 5분 만료 PUT URL 발급 |
| 2 | `PUT {presignedUrl}` (브라우저 → S3) | 서버 관여 없음 |
| 3 | `POST /v1/media/complete` | 키 소유권 검증, HeadObject로 존재·크기 확인, 썸네일 생성, DB 저장 |
| 4 | `POST /v1/posts` (mediaIds 포함) | `post_media.post_id` 갱신 |

키에 userId를 prefix로 넣기 때문에 complete 단계에서 `key.startsWith("media/" + userId + "/")` 검사만으로 다른 사용자의 키를 첨부하려는 시도를 403으로 차단할 수 있다. 별도 권한 테이블이 필요 없다.

## 코드

Spring Data Elasticsearch 도큐먼트 정의. 인덱스 설정과 매핑은 리소스 파일로 분리한다.

```java
@Document(indexName = "posts")
@Setting(settingPath = "elasticsearch/settings.json")
@Mapping(mappingPath = "elasticsearch/mappings.json")
public class PostDocument {
    @Id
    private String id;
    private Long postId;
    private Long userId;
    private String title;
    private String content;
    private Long likeCount;
    private Long viewCount;
    private LocalDateTime createdAt;
}
```

```json
{
  "analysis": {
    "tokenizer": { "nori_tokenizer": { "type": "nori_tokenizer" } },
    "analyzer": {
      "korean": { "type": "custom", "tokenizer": "nori_tokenizer" }
    }
  }
}
```

게시글 저장 후 커밋 시점에만 인덱싱하고, 실패는 흡수한다.

```java
@Transactional
public Post create(CreatePostCommand cmd) {
    Post post = postRepository.save(Post.of(cmd));
    PostDocument doc = PostDocument.from(post);

    TransactionSynchronizationManager.registerSynchronization(
        new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    postSearchRepository.save(doc);
                } catch (Exception e) {
                    log.warn("ES 인덱싱 실패: postId={}", post.getId(), e);
                }
            }
        });
    return post;
}

// 검색 — 메서드 이름으로 multi_match 쿼리가 생성된다
List<PostDocument> findByTitleContainingOrContentContaining(String title, String content);
```

AWS SDK v2로 LocalStack에 연결하고 Presigned PUT URL을 발급한다. `S3Presigner`는 `S3Client`와 별개 객체다.

```java
@Configuration
public class S3Config {
    @Bean
    public S3Presigner s3Presigner() {
        return S3Presigner.builder()
            .endpointOverride(URI.create("http://localhost:4566"))
            .region(Region.US_EAST_1)
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create("test", "test")))
            .serviceConfiguration(S3Configuration.builder()
                .pathStyleAccessEnabled(true).build())
            .build();
    }
}

public PresignedUrlResponse generatePresignedUrl(Long userId, PresignedUrlRequest req) {
    String key = "media/" + userId + "/" + UUID.randomUUID() + "/" + req.fileName();
    PutObjectRequest put = PutObjectRequest.builder()
        .bucket("sns-media").key(key).contentType(req.contentType()).build();
    PresignedPutObjectRequest presigned = s3Presigner.presignPutObject(
        PutObjectPresignRequest.builder()
            .signatureDuration(Duration.ofSeconds(300))
            .putObjectRequest(put).build());
    return new PresignedUrlResponse(key, presigned.url().toString(), 300);
}

public MediaResponse complete(Long userId, MediaCompleteRequest req) {
    if (!req.key().startsWith("media/" + userId + "/")) {
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "접근 권한 없음");
    }
    HeadObjectResponse head = s3Client.headObject(
        HeadObjectRequest.builder().bucket("sns-media").key(req.key()).build());
    // 썸네일 생성 후 PostMedia 저장
    ...
}
```

## 실무에서 걸리는 지점

- **`forcePathStyle` 누락.** SDK 기본값은 `https://{bucket}.s3.amazonaws.com` 형태의 가상 호스트 방식인데 LocalStack은 `http://localhost:4566/{bucket}` 경로 방식만 받는다. 이 설정이 빠지면 연결 자체가 실패한다. 운영 전환 시에는 `endpointOverride`를 제거하고 자격증명을 IAM Role 기반 기본 프로바이더로 바꾸면 된다.
- **S3 버킷 CORS.** 브라우저가 `localhost:3000`에서 `localhost:4566`으로 PUT을 보내려면 버킷에 PUT·HEAD를 허용하는 CORS 규칙이 있어야 한다. ==없으면 브라우저가 preflight 단계에서 요청을 차단하고, 서버 로그에는 아무것도 남지 않아 원인 찾기가 어렵다.==
- **Presigned URL의 Content-Type 불일치.** ==발급 시 서명에 포함한 Content-Type과 실제 PUT 헤더가 다르면 S3가 SignatureDoesNotMatch로 거부한다.== 클라이언트가 보내는 헤더를 발급 요청 값과 동일하게 맞춰야 한다.
- **고아 파일.** 1~2단계까지만 진행하고 complete를 호출하지 않으면 DB에 기록되지 않은 파일이 S3에 남는다. 업로드 prefix에 수명 주기 규칙을 걸거나, 주기적으로 DB와 대조해 정리하는 작업이 필요하다.
- **ES 힙과 인덱싱 누락.** 학습 환경에서 기본 힙으로 컨테이너를 띄우면 OOM으로 exit 137이 나므로 `-Xms128m -Xmx128m`으로 제한한다. ==afterCommit 인덱싱은 실패를 흡수하므로 재인덱싱 배치를 함께 두지 않으면 DB와 ES의 불일치가 누적된다.==

## 관련 글

- [게시물 서비스 — Redisson 분산 락과 동시성](/notes/sns-project/post-service-distributed-lock/)
- [Kafka 이벤트 흐름·Outbox·Redis 활용 패턴](/notes/sns-project/kafka-outbox-redis-patterns/)
- [서비스 분해와 아키텍처](/notes/sns-project/microservices-architecture/)
