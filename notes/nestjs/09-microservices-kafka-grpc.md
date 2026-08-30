---
title: "마이크로서비스 — Kafka·gRPC"
series: nestjs
part: "운영"
order: 9
summary: "NestJS 마이크로서비스 추상화 위에서 Kafka 이벤트와 gRPC 호출을 어떻게 나눠 쓰고 어디서 걸리는지 정리한다"
tags: [NestJS, Microservices, Kafka, gRPC, ClientProxy]
sources: [https://docs.nestjs.com/microservices/basics, https://docs.nestjs.com/microservices/kafka, https://docs.nestjs.com/microservices/grpc]
updated: 2026-08-30
---

서비스를 여러 개로 쪼개면 HTTP만으로 연결하기 어려운 지점이 생긴다. 주문 생성 뒤 재고·알림·정산이 각각 반응해야 하는데 REST로 순차 호출하면 한 서비스 장애가 전체 요청을 끌어내리고, 내부 동기 호출을 JSON으로 처리하면 직렬화 비용과 스키마 불일치가 누적된다. `@nestjs/microservices`는 이런 통신을 전송 계층과 분리된 하나의 모델로 묶는다.

## 핵심 개념

마이크로서비스는 `NestFactory.createMicroservice()`로 독립 실행하거나, HTTP 앱에 `app.connectMicroservice()`로 붙여 하이브리드로 운영한다. 전송 방식은 `Transport` 열거형으로 고르며 핸들러 코드는 전송 방식에 거의 의존하지 않는다.

메시지 스타일은 두 가지다. `@MessagePattern()`은 요청-응답으로 핸들러 반환값이 호출자에게 돌아간다. `@EventPattern()`은 발행-구독으로 응답 없이 같은 이벤트의 핸들러가 병렬 실행된다. 클라이언트는 `ClientProxy`가 담당한다. `send()`는 구독 시점에 요청을 보내는 cold Observable, `emit()`은 즉시 발행하는 hot Observable을 반환한다. `ClientsModule.register()`로 등록해 토큰으로 주입하고, `@Payload()`와 `@Ctx()`로 본문과 전송 계층별 컨텍스트(파티션·오프셋·메타데이터)를 꺼낸다.

Spring에 대응시키면 `@EventPattern` + Kafka는 `@KafkaListener`, `ClientProxy.emit()`은 `KafkaTemplate.send()`에 가깝다. `@GrpcMethod()`는 grpc-spring-boot-starter의 `@GrpcService` 구현 메서드, `RpcException`은 `StatusRuntimeException`에 해당한다.

| 항목 | Kafka | gRPC |
|---|---|---|
| 통신 모델 | 비동기 메시지 | 동기 RPC·스트리밍 |
| 계약 | 토픽 + 자체 스키마 | `.proto` |
| 용도 | 이벤트 전파, 재처리 | 서비스 간 조회·명령 |

Kafka 트랜스포터는 `options.client.brokers`와 `options.consumer.groupId`로 브로커·컨슈머 그룹을 지정한다. 요청-응답을 쓰려면 클라이언트가 `onModuleInit()`에서 `subscribeToResponseOf(pattern)`을 호출해 응답 토픽을 미리 구독해야 한다. 발행만 하는 서비스는 `producerOnlyMode: true`로 컨슈머 등록을 건너뛴다. 핸들러 반환값을 `{ key, value, headers }` 형태로 주면 파티션 키와 헤더를 제어한다.

gRPC 트랜스포터는 `package`와 `protoPath`가 필수다. 서버는 `@GrpcMethod(service, method)`로 단항 호출을, `@GrpcStreamMethod()`로 Observable 스트리밍을, `@GrpcStreamCall()`로 Node 스트림을 직접 다룬다. 클라이언트는 `ClientGrpc.getService<T>(name)`로 proto 서비스 인터페이스를 얻고 각 메서드는 Observable을 반환한다. 예외는 `GrpcNotFoundException`처럼 상태 코드별 클래스가 있고 `GrpcExceptionFilter`를 전역 등록해 gRPC 상태로 변환한다.

## 코드

Kafka 하이브리드 앱을 구성하고 이벤트를 수신하는 예제다. 오프셋을 수동 커밋하도록 `run.autoCommit`을 끈다.

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: 'order', brokers: ['localhost:9092'] },
      consumer: { groupId: 'order-consumer' },
      run: { autoCommit: false },
    },
  });
  await app.startAllMicroservices();
  await app.listen(3000);
}
bootstrap();

// order.consumer.ts
import { Controller } from '@nestjs/common';
import {
  Ctx, EventPattern, KafkaContext, KafkaRetriableException, Payload,
} from '@nestjs/microservices';

interface OrderCreated { orderId: string; amount: number }

@Controller()
export class OrderConsumer {
  @EventPattern('order.created')
  async onOrderCreated(
    @Payload() data: OrderCreated,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    const heartbeat = ctx.getHeartbeat();
    try {
      await this.reserveStock(data);
      await heartbeat();
      const { offset } = ctx.getMessage();
      await ctx.getConsumer().commitOffsets([
        { topic: ctx.getTopic(), partition: ctx.getPartition(), offset },
      ]);
    } catch (err) {
      throw new KafkaRetriableException(String(err));
    }
  }

  private async reserveStock(_: OrderCreated): Promise<void> {}
}
```

Kafka 클라이언트로 이벤트를 발행하고, 필요하면 요청-응답도 쓰는 예제다.

```typescript
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientKafkaProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class OrderPublisher implements OnModuleInit {
  constructor(@Inject('ORDER_BUS') private readonly client: ClientKafkaProxy) {}

  async onModuleInit() {
    this.client.subscribeToResponseOf('stock.check');
    await this.client.connect();
  }

  publish(orderId: string, amount: number) {
    this.client.emit('order.created', {
      key: orderId,
      value: { orderId, amount },
    });
  }

  checkStock(sku: string): Promise<{ available: boolean }> {
    return firstValueFrom(
      this.client
        .send<{ available: boolean }>('stock.check', { sku })
        .pipe(timeout(3000)),
    );
  }
}
```

gRPC 서버 핸들러와 클라이언트 호출 예제다. proto 파일의 서비스 이름과 메서드 이름이 데코레이터 인자와 일치해야 한다.

```protobuf
// proto/hero.proto
syntax = "proto3";
package hero;

service HeroesService {
  rpc FindOne (HeroById) returns (Hero) {}
}
message HeroById { int32 id = 1; }
message Hero { int32 id = 1; string name = 2; }
```

```typescript
// heroes.controller.ts
import { Controller } from '@nestjs/common';
import { GrpcMethod, GrpcNotFoundException } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';

interface HeroById { id: number }
interface Hero { id: number; name: string }

@Controller()
export class HeroesController {
  private readonly heroes: Hero[] = [{ id: 1, name: 'John' }];

  @GrpcMethod('HeroesService', 'FindOne')
  findOne(data: HeroById, metadata: Metadata): Hero {
    const hero = this.heroes.find((h) => h.id === data.id);
    if (!hero) throw new GrpcNotFoundException(`hero ${data.id}`);
    return hero;
  }
}

// hero.client.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable } from 'rxjs';

interface HeroesService {
  findOne(req: { id: number }): Observable<{ id: number; name: string }>;
}

@Injectable()
export class HeroClient implements OnModuleInit {
  private svc!: HeroesService;
  constructor(@Inject('HERO_PACKAGE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.svc = this.client.getService<HeroesService>('HeroesService');
  }

  find(id: number) {
    return this.svc.findOne({ id });
  }
}
```

## 실무에서 걸리는 지점

- **Kafka 요청-응답은 구독 누락으로 조용히 멈춘다.** `subscribeToResponseOf()`를 빠뜨리면 `send()`가 응답을 영원히 기다린다. 응답 토픽 관리 비용도 크므로 조회는 gRPC, 상태 변화 전파는 Kafka 이벤트로 나누는 편이 단순하다.
- **오프셋 커밋과 재시도 의미를 정해야 한다.** 자동 커밋에서 핸들러가 실패하면 메시지가 유실될 수 있고, 수동 커밋에서 커밋을 빠뜨리면 반복 소비한다. 이벤트 핸들러의 미처리 예외는 기본 재시도 대상이므로 핸들러를 멱등하게 쓰고, 영구 실패는 일반 예외로 구분해 DLQ로 보낸다.
- **긴 작업은 세션 타임아웃을 넘긴다.** `sessionTimeout` 안에 하트비트가 없으면 리밸런싱으로 파티션이 다른 인스턴스로 넘어간다. `ctx.getHeartbeat()`를 중간에 호출하거나 작업을 큐로 넘긴다.
- **proto 계약 관리가 서비스 경계를 결정한다.** proto 파일을 저장소마다 복사하면 버전이 어긋난다. 별도 패키지로 배포하고 `protoPath`에 배열을 넘겨 함께 로드한다. 기본 4MB 메시지 제한은 `maxReceiveMessageLength`로 조정한다.
- **하이브리드 앱은 가드·파이프 적용 범위가 다르다.** HTTP 쪽 전역 가드·인터셉터는 마이크로서비스 핸들러에 상속되지 않는다. `connectMicroservice()`에 `inheritAppConfig: true`를 명시하거나 따로 등록한다. 예외는 `RpcException` 계열을 던져야 필터가 응답 형식을 맞춘다.

## 관련 글

- [캐싱·큐(BullMQ)·스케줄링](/notes/nestjs/caching-queues-scheduling/)
- [Interceptors·Exception Filters·Middleware](/notes/nestjs/interceptors-filters-middleware/)
- [테스트와 배포](/notes/nestjs/testing-deployment/)
