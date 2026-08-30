---
title: "캐싱·큐(BullMQ)·스케줄링"
series: nestjs
part: "데이터와 인프라"
order: 8
summary: "요청 경로에서 빼야 할 세 가지 일 — 반복 조회는 캐시로, 느린 작업은 큐로, 주기 작업은 스케줄러로 옮기는 방법"
tags: [NestJS, cache-manager, BullMQ, Redis, "@nestjs/schedule"]
sources: [https://docs.nestjs.com/techniques/caching, https://docs.nestjs.com/techniques/queues, https://docs.nestjs.com/techniques/task-scheduling]
updated: 2026-08-30
---

HTTP 요청 핸들러 안에서 모든 일을 끝내려 하면 세 가지 문제가 나타난다. 같은 결과를 돌려주는 조회가 매번 DB를 때리고, 메일 발송처럼 수 초 걸리는 작업이 요청을 붙잡아 타임아웃을 만들며, 정산처럼 정해진 시각에 돌아야 하는 작업을 넣을 자리가 없다. Node는 단일 이벤트 루프라 긴 작업 하나가 다른 요청까지 느리게 만든다. NestJS는 이 세 문제를 각각 `@nestjs/cache-manager`, `@nestjs/bullmq`, `@nestjs/schedule`로 분리한다.

## 핵심 개념

**캐싱.** `CacheModule`은 `cache-manager` 라이브러리를 감싼 모듈이다. `cache-manager` 5.x부터 스토어가 Keyv 기반이라 Redis는 `@keyv/redis` 어댑터를 `stores` 배열에 넣어 붙이고, 여러 개를 넣으면 앞쪽부터 조회하며 뒤쪽을 폴백으로 쓴다. TTL 단위는 밀리초, 기본값 0은 만료 없음이다. 사용 방식은 두 갈래다. `CACHE_MANAGER` 토큰으로 `Cache` 인스턴스를 주입받아 `get`·`set`·`del`을 직접 호출하는 방식과, 컨트롤러에 `CacheInterceptor`를 걸어 GET 응답을 URL 기준으로 자동 캐시하는 방식이다. 후자는 `@CacheKey()`·`@CacheTTL()`로 메서드별 키와 만료를 덮어쓴다. Spring의 `CacheManager` 빈 직접 호출과 GET 전용 `@Cacheable`에 각각 대응한다.

**큐.** `@nestjs/bullmq`는 Redis 기반 잡 큐 BullMQ를 모듈화한 것이다. `BullModule.forRoot()`로 Redis 연결을 잡고, `registerQueue({ name })`으로 큐를 선언하면 `@InjectQueue('name')`으로 `Queue` 인스턴스를 받아 `add(jobName, data, opts)`로 잡을 넣는다. 소비자는 `@Processor('name')`을 붙인 클래스가 `WorkerHost`를 상속하고 `process(job)` 하나를 구현한다. 예전 Bull과 달리 잡 이름별 데코레이터 없이 `job.name`으로 분기한다. 잡 옵션으로 `attempts`·`backoff`·`delay`·`priority`·`removeOnComplete`·`repeat`를 지정하고, 워커 이벤트는 `@OnWorkerEvent`로 받는다. 부모-자식 잡을 묶는 `registerFlowProducer()`와 핸들러를 별도 프로세스로 띄우는 `processors` 옵션도 있다. Spring의 `@JmsListener` 컨슈머에 재시도 정책이 내장된 형태로 보면 되고, 브로커가 Redis라는 점이 다르다.

**스케줄링.** `ScheduleModule.forRoot()`를 올리면 `@Cron`·`@Interval`·`@Timeout`이 붙은 프로바이더 메서드를 부트스트랩 시점(`onApplicationBootstrap`)에 수집해 등록한다. `@Cron`은 초 단위까지 포함한 6필드 표현식을 받고, 옵션으로 `name`, `timeZone`, 이전 실행이 끝날 때까지 다음 실행을 미루는 `waitForCompletion`, `disabled`가 있다. 런타임에 잡을 추가·삭제하려면 `SchedulerRegistry`를 주입해 `addCronJob`·`deleteCronJob`을 쓴다. Spring의 `@Scheduled(cron=...)`과 `TaskScheduler`에 대응한다.

## 코드

Redis를 스토어로 쓰는 캐시 모듈 등록과, 서비스에서 캐시를 직접 읽고 쓰는 예제다.

```typescript
import { Module, Injectable, Inject } from '@nestjs/common';
import { CacheModule, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import KeyvRedis from '@keyv/redis';
import { Keyv } from 'keyv';

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        ttl: 60_000, // ms
        stores: [new Keyv({ store: new KeyvRedis('redis://localhost:6379') })],
      }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class ProductService {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async findOne(id: string) {
    const key = `product:${id}`;
    const hit = await this.cache.get<Product>(key);
    if (hit) return hit;
    const product = await this.repo.findOneBy({ id });
    await this.cache.set(key, product, 300_000);
    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    const saved = await this.repo.save({ id, ...dto });
    await this.cache.del(`product:${id}`);
    return saved;
  }
}
```

BullMQ 큐에 잡을 넣는 프로듀서와, `job.name`으로 분기하며 재시도 옵션을 받는 컨슈머다.

```typescript
import { Module, Injectable } from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';

@Module({
  imports: [
    BullModule.forRoot({ connection: { host: 'localhost', port: 6379 } }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
  providers: [MailService, MailConsumer],
})
export class MailModule {}

@Injectable()
export class MailService {
  constructor(@InjectQueue('mail') private readonly queue: Queue) {}

  async sendWelcome(userId: string) {
    await this.queue.add(
      'welcome',
      { userId },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }
}

@Processor('mail', { concurrency: 5 })
export class MailConsumer extends WorkerHost {
  async process(job: Job<{ userId: string }>) {
    switch (job.name) {
      case 'welcome':
        await this.mailer.send(job.data.userId, 'welcome');
        return { sentAt: Date.now() };
      default:
        throw new Error(`unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.warn(`job ${job.id} failed (${job.attemptsMade}): ${err.message}`);
  }
}
```

크론 잡을 선언하고, 같은 서비스에서 `SchedulerRegistry`로 런타임에 잡을 추가하는 예제다.

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

@Injectable()
export class CleanupService {
  constructor(private readonly registry: SchedulerRegistry) {}

  @Cron('0 0 3 * * *', {
    name: 'purge-expired',
    timeZone: 'Asia/Seoul',
    waitForCompletion: true,
  })
  async purgeExpired() {
    await this.repo.deleteExpired();
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { disabled: process.env.NODE_ENV === 'test' })
  async refreshStats() {
    await this.stats.rebuild();
  }

  scheduleReport(name: string, cronTime: string) {
    const job = new CronJob(cronTime, () => this.reports.generate(name));
    this.registry.addCronJob(name, job);
    job.start();
  }

  cancelReport(name: string) {
    this.registry.deleteCronJob(name);
  }
}
```

## 실무에서 걸리는 지점

- **TTL 단위와 스토어 버전.** `cache-manager` 4.x까지는 초, 5.x부터는 밀리초다. ==옛 예제의 `ttl: 60`을 그대로 쓰면 60ms 만에 사라진다.== `cache-manager-redis-store` 같은 구 어댑터는 `@keyv/redis`로 바꿔야 한다.
- **`CacheInterceptor`의 키 범위.** ==기본 키는 요청 URL이라 사용자별로 다른 응답을 내는 GET에 그대로 걸면 다른 사용자의 데이터가 섞인다.== 사용자 ID를 키에 넣으려면 `trackBy()`를 오버라이드한 인터셉터를 만든다. GET 외 메서드와 `@Res()`를 주입한 핸들러는 캐시되지 않는다.
- **큐 워커와 웹 프로세스의 분리.** 컨슈머를 API 서버와 같은 프로세스에 두면 무거운 잡이 이벤트 루프를 점유한다. CPU 작업은 `processors`로 별도 프로세스에 두거나 워커 앱을 따로 띄우고, `concurrency`는 DB 커넥션 수에 맞춘다.
- **잡 데이터와 정리 정책.** 잡 데이터는 JSON으로 직렬화되므로 엔티티 대신 ID만 넣는다. ==`removeOnComplete`·`removeOnFail`을 지정하지 않으면 완료 잡이 Redis에 무한 누적되고, 멱등성 없는 작업에 재시도를 걸면 중복 실행이 생긴다.==
- **스케줄러의 다중 인스턴스 문제.** ==`@Cron`은 프로세스 내부 타이머라 인스턴스를 3대 띄우면 같은 잡이 3번 돈다.== 단일 실행이 필요하면 Redis 락을 잡거나, 스케줄러는 큐에 잡을 넣기만 하고 실행은 워커나 BullMQ `repeat`에 맡긴다. 긴 잡은 `waitForCompletion` 없이는 이전 실행과 겹친다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [설정·환경·로깅](/notes/nestjs/config-logging/)
- [마이크로서비스 — Kafka·gRPC](/notes/nestjs/microservices-kafka-grpc/)
