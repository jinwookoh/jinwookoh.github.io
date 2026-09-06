---
title: "메시징 — Point-to-Point와 Pub/Sub, 소비 모델"
series: architecture-patterns
part: "서비스 통신"
order: 11
summary: "메시지 하나를 소비자 하나가 가져갈지 구독자 전원이 받을지가 큐와 토픽을 가르고, 컨슈머 그룹이 둘을 한 구조에 담는다"
tags: [Messaging, Point-to-Point, Pub/Sub, Kafka, RabbitMQ]
sources: [https://jinwookoh.tistory.com/252]
updated: 2026-09-06
---

회원 가입 처리 하나에 환영 메일 발송, 쿠폰 지급, 통계 적재를 동기 호출로 이어 붙이면 가입 API의 응답 시간은 후속 작업 전체의 합이 되고, 메일 서버 장애가 가입 실패로 번진다. 후속 작업을 하나 추가할 때마다 가입 코드를 고쳐야 하며, 순간 트래픽이 몰리면 처리 능력이 가장 낮은 하위 시스템이 전체 처리량을 끌어내린다. 메시징은 생산자와 소비자 사이에 브로커를 두어 시간·부하·장애를 분리한다. 다만 브로커를 도입하는 것만으로 설계가 끝나지는 않는다. 메시지 하나를 소비자 하나만 가져갈지, 구독자 전원이 받을지를 정하는 소비 모델이 시스템의 동작을 결정한다.

## 핵심 개념

### Point-to-Point (큐)

생산자가 큐에 메시지를 넣으면 여러 소비자 중 하나만 그 메시지를 가져가 처리하고, 처리 확인(ack)이 오면 큐에서 제거된다. 소비자들은 같은 큐를 두고 경쟁하므로 경쟁적 소비자(Competing Consumers) 모델이라고 부른다. 소비자를 늘리면 처리량이 늘어나는 수평 확장이 가능하고, 이미지 리사이징이나 동영상 인코딩 같은 무거운 작업을 워커 풀에 분배하는 용도에 맞는다. RabbitMQ의 큐, AWS SQS, ActiveMQ 큐가 이 모델이다.

한계는 기능 확장에서 드러난다. 같은 메시지로 새로운 후속 처리를 붙이려고 소비자를 하나 더 연결하면, 새 소비자는 기존 워커의 일감을 나눠 가질 뿐 두 처리가 모두 실행되지는 않는다. ==큐 하나에 목적이 다른 소비자를 붙이면 메시지가 둘 중 한쪽에만 전달되어 요청의 일부가 오류 없이 누락된다.==

### Publish-Subscribe (토픽)

생산자가 토픽에 메시지를 발행하면 그 토픽을 구독하는 모든 소비자가 같은 메시지의 사본을 받는다. 생산자는 구독자가 몇이고 누구인지 알지 못하며, 통계 기능이 필요하면 기존 코드를 손대지 않고 구독자를 하나 더 붙이면 된다. 이벤트 기반 아키텍처의 기본 전달 방식이고, Kafka 토픽, AWS SNS, Redis Pub/Sub가 대표적이다.

Pub/Sub의 어려움은 부하 분산이다. 구독자마다 사본이 가는 구조에서 메일 서비스 인스턴스를 세 대로 늘리면 세 대가 모두 같은 메시지를 받아 메일이 세 통 나간다. 서비스 단위로는 브로드캐스트하되 서비스 내부의 인스턴스 사이에서는 큐처럼 나눠 처리하는 장치가 별도로 필요하다.

### 컨슈머 그룹 — 두 모델의 결합

Kafka는 토픽을 파티션으로 나누고 소비자를 컨슈머 그룹으로 묶어 두 모델을 한 구조에 담는다. 그룹이 다르면 각 그룹이 토픽의 모든 메시지를 받고(Pub/Sub), 같은 그룹 안에서는 파티션이 인스턴스에 하나씩 배정되어 메시지가 나뉜다(Point-to-Point). 메일 서비스와 쿠폰 서비스가 서로 다른 group.id로 구독하면 둘 다 가입 이벤트를 받고, 메일 서비스 인스턴스 세 대가 같은 group.id를 쓰면 파티션을 나눠 갖는다. RabbitMQ도 exchange를 fanout으로 두고 서비스마다 큐를 하나씩 바인딩하면 같은 형태가 된다. 차이는 메시지 수명이다. RabbitMQ는 큐마다 복사된 메시지를 소비 후 삭제하고, Kafka는 소비 여부와 무관하게 보존 기간 동안 로그를 유지하므로 그룹별 오프셋만 되돌리면 재처리가 가능하다.

| 구분 | Point-to-Point | Pub/Sub |
|---|---|---|
| 수신자 | 소비자 하나 | 구독자 전원 |
| 소비자 추가 효과 | 처리량 증가 | 기능 추가 |
| 메시지 수명 | 소비 후 삭제 | 구독자별 사본, Kafka는 보존 기간까지 유지 |
| 용도 | 작업 분배, 비동기 명령 | 이벤트 전파, 알림, CDC |

## 코드

Spring Kafka 생산자. 사용자 ID를 키로 주어 같은 사용자의 이벤트가 같은 파티션에 순서대로 들어가게 한다.

```java
@Service
public class SignupEventPublisher {

    private final KafkaTemplate<String, SignupEvent> kafkaTemplate;

    public SignupEventPublisher(KafkaTemplate<String, SignupEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(SignupEvent event) {
        kafkaTemplate.send("user-signup", String.valueOf(event.userId()), event);
    }
}
```

두 소비자. groupId가 다르므로 두 서비스가 모두 이벤트를 받고, 각 서비스를 여러 인스턴스로 띄우면 같은 groupId 안에서 파티션을 나눠 갖는다.

```java
@Component
public class SignupEventConsumers {

    @KafkaListener(topics = "user-signup", groupId = "mail-service")
    public void sendWelcomeMail(SignupEvent event) {
        // 환영 메일 발송
    }

    @KafkaListener(topics = "user-signup", groupId = "coupon-service")
    public void issueCoupon(SignupEvent event) {
        // 쿠폰 지급
    }
}
```

RabbitMQ 작업 큐. prefetch를 1로 두어 워커가 처리 중인 메시지 외에는 미리 가져오지 않게 하고, 처리가 끝난 시점에 ack가 나가도록 수동 확인 모드를 쓴다.

```java
@Configuration
public class ImageQueueConfig {

    @Bean
    public Queue imageQueue() {
        return QueueBuilder.durable("image-resize").build();
    }

    @Bean
    public SimpleRabbitListenerContainerFactory imageListenerFactory(ConnectionFactory cf) {
        var factory = new SimpleRabbitListenerContainerFactory();
        factory.setConnectionFactory(cf);
        factory.setPrefetchCount(1);
        factory.setAcknowledgeMode(AcknowledgeMode.MANUAL);
        return factory;
    }
}

@Component
public class ImageResizeWorker {

    @RabbitListener(queues = "image-resize", containerFactory = "imageListenerFactory")
    public void resize(String imageKey, Channel channel,
                       @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        try {
            // 리사이징 수행
            channel.basicAck(tag, false);
        } catch (Exception e) {
            channel.basicNack(tag, false, false);
        }
    }
}
```

## 실무에서 걸리는 지점

- **중복 소비**: 브로커는 대부분 at-least-once를 보장한다. 소비자가 처리는 마쳤지만 ack 전에 죽으면 같은 메시지가 다시 전달된다. ==소비자는 같은 메시지를 두 번 받아도 결과가 같도록 멱등하게 만들어야 하며, 쿠폰 지급처럼 되돌리기 어려운 작업은 이벤트 ID로 처리 여부를 먼저 조회한다.==
- **파티션 수와 병렬도**: Kafka에서 한 파티션은 그룹 내 소비자 하나만 읽는다. ==컨슈머 인스턴스를 파티션 수보다 많이 띄우면 초과분은 아무 메시지도 받지 못한 채 유휴 상태로 남는다.== 파티션 수는 늘릴 수만 있고 줄일 수 없으며, 늘리는 순간 키 기반 배정이 바뀌어 같은 키의 순서 보장이 그 시점 전후로 끊긴다.
- **독 메시지와 DLQ**: 역직렬화 실패나 항상 예외를 던지는 메시지를 재시도만 반복하면 그 파티션 또는 큐 전체가 멈춘다. 재시도 횟수를 정하고 초과분은 DLQ로 보내 격리한 뒤 별도로 처리한다.
- **Redis Pub/Sub의 유실**: Redis Pub/Sub는 메시지를 저장하지 않으므로 발행 시점에 연결되어 있지 않은 구독자는 그 메시지를 받지 못한다. 유실이 허용되지 않으면 Redis Streams나 Kafka를 쓴다.
- **소비 지연 감시**: 소비자가 느려도 생산자는 정상이므로 장애로 드러나지 않는다. 컨슈머 랙(마지막 오프셋과 커밋 오프셋의 차이)을 지표로 두고 임계값 알림을 건다.

## 관련 글

- [이벤트 소싱 — 상태 대신 이벤트를 저장하기](/notes/architecture-patterns/event-sourcing/)
- [트랜잭셔널 아웃박스 — 이중 쓰기 문제 해결](/notes/architecture-patterns/transactional-outbox/)
- [비동기 요청-응답 — 오래 걸리는 작업과 폴링](/notes/architecture-patterns/async-request-reply/)
