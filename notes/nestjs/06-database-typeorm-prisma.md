---
title: "데이터베이스 — TypeORM·Prisma·트랜잭션"
series: nestjs
part: "데이터와 인프라"
order: 6
summary: "NestJS에서 TypeORM과 Prisma를 DI 컨테이너에 올리는 방식과 트랜잭션 경계를 어디서 잡는지 정리한다"
tags: [NestJS, TypeORM, Prisma, Transaction, Repository]
sources: [https://docs.nestjs.com/techniques/database, https://docs.nestjs.com/recipes/prisma]
updated: 2026-08-30
---

NestJS는 데이터베이스 접근 계층을 내장하지 않는다. 서비스마다 드라이버를 직접 열면 풀 관리와 종료 시 정리가 애플리케이션 코드로 흘러 들어오고, 여러 저장소 호출을 원자 단위로 묶을 경계가 없으면 중간 실패 시 데이터가 반쯤 쓰인 채 남는다. `@nestjs/typeorm`과 Prisma 통합은 DataSource나 PrismaClient를 싱글턴 프로바이더로 올리고, 각 모듈이 필요한 리포지토리만 주입받게 하며, 트랜잭션 경계를 명시적 API로 잡는다.

## 핵심 개념

**TypeORM 통합.** `TypeOrmModule.forRoot()`가 루트 모듈에서 DataSource를 생성한다. 옵션은 TypeORM DataSource 설정에 `retryAttempts`(기본 10회), `retryDelay`(기본 3000ms), `autoLoadEntities`(기본 false)가 추가된 형태다. 설정이 비동기로 로드되면 `forRootAsync()`에 `useFactory`를 넘기고 `ConfigService`를 주입한다.

기능 모듈은 `TypeOrmModule.forFeature([User])`로 엔티티를 등록한다. 이 호출이 모듈 스코프에 `Repository<User>` 프로바이더를 만들고, 서비스는 `@InjectRepository(User)`로 받는다. `autoLoadEntities: true`면 `forFeature`의 엔티티가 루트 `entities` 목록에 자동으로 합쳐진다. DataSource 자체는 `@InjectDataSource()`로 받는다.

Spring으로 보면 `forRoot()`는 `DataSource` 빈을 만드는 `@Configuration`, `forFeature`는 `@EnableJpaRepositories`의 스캔, `Repository<User>`는 `JpaRepository<User, Long>`에 대응한다.

**트랜잭션.** `dataSource.transaction(async manager => {...})`는 콜백 안의 `manager`로 수행한 작업을 하나로 묶고, 정상 반환이면 커밋, 예외면 롤백한다. `QueryRunner`는 `startTransaction`·`commit`·`rollback`·`release`를 직접 호출하는 저수준 API다. 어느 쪽이든 주입받은 `Repository`는 기본 EntityManager에 묶여 있어 트랜잭션에 참여하지 않는다. Spring `@Transactional`처럼 프록시가 컨텍스트를 전파하는 구조가 아니므로 매니저를 인자로 내려보내거나 콜백 안에서 `manager.getRepository()`로 다시 꺼낸다.

**Prisma 통합.** Prisma는 `schema.prisma`에서 클라이언트 코드를 생성한다. `npx prisma init`으로 스키마와 `.env`를 만들고, `npx prisma migrate dev --name init`이 마이그레이션 생성·적용과 클라이언트 재생성을 한 번에 처리한다. NestJS에는 `PrismaClient`를 상속한 `PrismaService`를 프로바이더로 등록한다. Prisma 7부터는 드라이버 어댑터를 생성자에 넘기는 방식이 기본이고, 클라이언트가 ESM으로 출력되므로 NestJS의 CommonJS 빌드와 맞추려면 generator 블록에 `moduleFormat = "cjs"`를 지정한다. 트랜잭션은 `$transaction()`에 배열을 넘기면 배치, 콜백을 넘기면 `tx` 클라이언트로 조건 분기가 가능한 인터랙티브 트랜잭션이 된다.

## 코드

루트 모듈에서 환경 변수로 DataSource를 구성하고, 기능 모듈에서 리포지토리를 주입받는 기본 형태다.

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
  ],
})
export class AppModule {}

// users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

주문 생성과 재고 차감을 한 트랜잭션으로 묶는 예다. 주입된 리포지토리 대신 콜백의 `manager`를 통해 엔티티에 접근한다.

```typescript
// orders/orders.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';
import { Stock } from '../stock/stock.entity';

@Injectable()
export class OrdersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async place(productId: number, qty: number): Promise<Order> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const stock = await manager.findOneOrFail(Stock, {
        where: { productId },
        lock: { mode: 'pessimistic_write' },
      });
      if (stock.quantity < qty) {
        throw new ConflictException('insufficient stock');
      }
      stock.quantity -= qty;
      await manager.save(stock);
      return manager.save(manager.create(Order, { productId, qty }));
    });
  }
}
```

Prisma를 쓰는 경우의 서비스와 인터랙티브 트랜잭션이다. `PrismaService`는 `OnModuleDestroy`에서 커넥션을 정리한다.

```typescript
// prisma/prisma.service.ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

// orders/orders.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  place(productId: number, qty: number) {
    return this.prisma.$transaction(async (tx) => {
      const stock = await tx.stock.findUniqueOrThrow({ where: { productId } });
      if (stock.quantity < qty) {
        throw new ConflictException('insufficient stock');
      }
      await tx.stock.update({
        where: { productId },
        data: { quantity: { decrement: qty } },
      });
      return tx.order.create({ data: { productId, qty } });
    });
  }
}
```

## 실무에서 걸리는 지점

- **`synchronize: true`를 운영에 남기는 실수.** 엔티티 변경이 즉시 DDL로 반영되어 컬럼 삭제나 타입 변경이 데이터 손실로 이어진다. 운영은 마이그레이션 파일과 `migrate deploy` 류의 명시적 절차로 관리한다.
- **트랜잭션에 참여하지 않는 리포지토리.** `@InjectRepository`로 받은 객체를 `transaction()` 콜백 안에서 호출하면 별도 커넥션으로 실행되어 롤백에서 빠진다. 서비스 간 전파가 필요하면 매니저를 인자로 넘기거나 AsyncLocalStorage 기반 전파 라이브러리를 쓴다.
- **인터랙티브 트랜잭션의 타임아웃.** Prisma 콜백형 `$transaction`은 기본 5초 안에 끝나야 하고 커넥션 하나를 점유한다. 외부 API 호출을 안에 넣으면 풀이 고갈되므로 DB 작업만으로 짧게 유지한다.
- **N+1.** TypeORM `relations`나 Prisma `include`를 빠뜨리면 목록 조회에서 항목마다 추가 쿼리가 나간다. 쿼리 로그를 켜고 엔드포인트 단위로 실제 쿼리 수를 확인한다.
- **기동 순서.** `retryAttempts`·`retryDelay` 기본값이면 DB가 없을 때 30초 동안 기동이 막히므로 헬스체크 타임아웃과 맞춘다. Prisma는 첫 쿼리 시 연결하므로 기동 시점에 실패를 잡으려면 `onModuleInit`에서 `$connect()`를 호출한다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [설정·환경·로깅](/notes/nestjs/config-logging/)
- [테스트와 배포](/notes/nestjs/testing-deployment/)
