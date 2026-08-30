---
title: "DI와 모듈 시스템"
series: nestjs
part: "기초"
order: 2
summary: "NestJS 모듈이 프로바이더의 가시성을 어떻게 가르고, 커스텀 프로바이더와 스코프가 인스턴스 생성을 어떻게 바꾸는지 정리한다"
tags: [NestJS, Dependency Injection, Module, Provider, Injection Scope]
sources: [https://docs.nestjs.com/modules, https://docs.nestjs.com/fundamentals/custom-providers, https://docs.nestjs.com/fundamentals/injection-scopes]
updated: 2026-08-30
---

서비스 클래스가 다른 서비스를 직접 `new`로 만들기 시작하면 의존 관계가 코드 곳곳에 굳어진다. 테스트에서 DB 클라이언트를 가짜로 바꾸려 해도 생성 지점을 모두 찾아야 하고, 설정값이나 커넥션처럼 한 번만 만들어야 하는 객체가 여러 개 생기는 문제도 따라온다. NestJS는 클래스 생성을 프레임워크가 대신 맡는 DI 컨테이너를 두고, 그 컨테이너에 등록된 객체가 어디까지 보이는지를 모듈 단위로 통제한다.

## 핵심 개념

Nest의 DI는 생성자 주입이 기본이다. 클래스에 `@Injectable()`을 붙이고 모듈의 `providers` 배열에 등록하면, 컨테이너가 생성자 파라미터의 타입 메타데이터를 읽어 필요한 인스턴스를 넣어 준다. 이 메타데이터는 TypeScript의 `emitDecoratorMetadata` 옵션으로 만들어지므로 인터페이스 타입은 주입 토큰이 될 수 없고, 클래스이거나 `@Inject()`로 토큰을 명시해야 한다.

Spring 개발자 기준으로 보면 `@Module()`은 빈 정의를 모아 둔 `@Configuration`에 가깝고, `@Injectable()`은 `@Component`에 해당한다. 다만 Spring이 컴포넌트 스캔으로 애플리케이션 전체를 하나의 컨텍스트에 담는 반면, Nest는 모듈마다 독립된 스코프를 두고 `exports`로 명시한 프로바이더만 바깥에 노출한다. Spring의 프로토타입 빈이나 request 스코프 빈에 대응하는 개념은 Nest의 injection scope다.

모듈 데코레이터가 받는 네 속성은 역할이 분명하다.

| 속성 | 역할 |
|---|---|
| `providers` | 이 모듈이 생성하고 소유하는 프로바이더 |
| `controllers` | 이 모듈이 인스턴스화할 컨트롤러 |
| `imports` | 가져올 모듈. 그 모듈이 export한 프로바이더가 이 모듈에서 주입 가능해진다 |
| `exports` | 다른 모듈에 공개할 프로바이더나 모듈 |

모듈은 기본적으로 싱글턴이므로 여러 모듈이 같은 모듈을 import해도 인스턴스는 하나다. 어디서나 쓰이는 설정이나 로거 같은 모듈에는 `@Global()`을 붙여 매번 import하지 않게 할 수 있지만, 공식 문서는 이를 남용하지 말고 import를 통해 의존 관계를 드러내라고 권한다. 두 모듈이 서로를 import해야 할 때는 `forwardRef()`로 순환을 풀 수 있으나, 대개 공통 부분을 세 번째 모듈로 뽑는 편이 낫다.

프로바이더는 클래스만 가능한 것이 아니다. 등록 항목은 결국 토큰과 그 토큰을 해석하는 방법의 쌍이며, 방법에 따라 네 가지로 나뉜다. `useValue`는 미리 만든 객체나 상수를 그대로 넣고, `useClass`는 환경에 따라 구현 클래스를 바꿔 끼우며, `useFactory`는 다른 프로바이더를 `inject`로 받아 계산한 결과를 등록한다. `useExisting`은 같은 인스턴스에 별칭 토큰을 하나 더 붙인다. 토큰에는 클래스 외에 문자열이나 `Symbol`도 쓸 수 있고, 클래스가 아닌 토큰은 주입 시 `@Inject(TOKEN)`으로 지정한다. 팩토리는 비동기 함수여도 된다.

스코프는 인스턴스 수명을 정한다. 기본값인 `Scope.DEFAULT`는 애플리케이션 전체에 하나가 생성되어 공유된다. `Scope.REQUEST`는 들어오는 요청마다 새 인스턴스를 만들고 요청이 끝나면 버리며, `Scope.TRANSIENT`는 주입받는 소비자마다 전용 인스턴스를 만든다. 주의할 점은 스코프가 의존 체인을 따라 위로 번진다는 것이다. 요청 스코프 프로바이더를 주입받는 서비스와 컨트롤러도 요청 스코프가 되므로, 하나의 요청 스코프 객체가 그래프 전체를 요청마다 새로 만들게 할 수 있다. 이 전파를 막고 싶다면 `durable: true`를 준 뒤 `ContextIdStrategy`로 테넌트 같은 키마다 인스턴스를 재사용하는 방법이 있다.

## 코드

모듈 경계를 세우는 기본 형태다. `CatsService`는 export되었으므로 `AppModule`에서 주입할 수 있지만, `CatsRepository`는 모듈 안에서만 보인다.

```typescript
import { Module, Injectable } from '@nestjs/common';

@Injectable()
export class CatsRepository {
  findAll() {
    return [{ id: 1, name: 'Tom' }];
  }
}

@Injectable()
export class CatsService {
  constructor(private readonly repo: CatsRepository) {}
  findAll() {
    return this.repo.findAll();
  }
}

@Module({
  providers: [CatsService, CatsRepository],
  exports: [CatsService],
})
export class CatsModule {}

@Module({
  imports: [CatsModule],
})
export class AppModule {}
```

커스텀 프로바이더 네 종류를 한 모듈에 모은 예다. 문자열 토큰과 `Symbol` 토큰은 `@Inject()`로 받는다.

```typescript
import { Inject, Injectable, Module } from '@nestjs/common';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DB_CONNECTION = 'DB_CONNECTION';

export abstract class Notifier {
  abstract send(to: string, body: string): Promise<void>;
}

@Injectable()
class SlackNotifier extends Notifier {
  async send(to: string, body: string) {
    /* ... */
  }
}

@Injectable()
class LogNotifier extends Notifier {
  async send(to: string, body: string) {
    console.log(to, body);
  }
}

@Injectable()
export class OrderService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: { region: string },
    @Inject(DB_CONNECTION) private readonly db: { query(sql: string): Promise<unknown> },
    private readonly notifier: Notifier,
  ) {}
}

@Module({
  providers: [
    { provide: APP_CONFIG, useValue: { region: 'ap-northeast-2' } },
    {
      provide: Notifier,
      useClass: process.env.NODE_ENV === 'production' ? SlackNotifier : LogNotifier,
    },
    {
      provide: DB_CONNECTION,
      useFactory: async (config: { region: string }) => {
        const conn = { query: async (sql: string) => sql, region: config.region };
        return conn;
      },
      inject: [APP_CONFIG],
    },
    { provide: 'NOTIFIER_ALIAS', useExisting: Notifier },
    OrderService,
  ],
  exports: [OrderService],
})
export class OrderModule {}
```

요청 스코프 프로바이더가 현재 요청을 읽는 예다. 이 서비스를 주입받는 컨트롤러도 요청마다 새로 만들어진다.

```typescript
import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';

@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  constructor(@Inject(REQUEST) private readonly request: Request) {}

  get tenantId(): string {
    return this.request.headers['x-tenant-id'] as string;
  }
}
```

## 실무에서 걸리는 지점

- 인터페이스를 생성자 타입으로 두고 `@Inject()`를 빠뜨리면 런타임에 "Nest can't resolve dependencies" 오류가 난다. 컴파일은 통과하므로 원인을 찾기 어렵다. 추상 클래스를 토큰으로 쓰면 타입과 토큰을 함께 얻을 수 있다.
- 프로바이더를 다른 모듈에서 쓰려면 `exports`에 넣고, 소비하는 쪽은 `imports`에 모듈을 넣어야 한다. 같은 클래스를 두 모듈의 `providers`에 각각 등록하면 인스턴스가 둘로 갈라져 상태가 공유되지 않는다.
- 요청 스코프는 성능 비용이 있다. 요청마다 의존 그래프를 다시 만들고 소비자까지 스코프가 번지므로, 요청 컨텍스트가 정말 필요한 지점으로 좁히거나 `AsyncLocalStorage` 기반 접근으로 대체하는 편이 낫다.
- 요청 스코프 컨트롤러 안에서 `@Inject(REQUEST)`를 쓰면 되지만, 요청 스코프 프로바이더를 싱글턴이 직접 붙들어 쓰려면 `ModuleRef.resolve()`와 컨텍스트 ID를 거쳐야 한다.
- `forwardRef()`는 순환 import를 통과시킬 뿐 설계를 고치지 않는다. 순환이 늘어나면 모듈 초기화 순서에 따라 `undefined`가 주입되는 경우가 생기므로, 공통 의존을 별도 모듈로 분리하는 것이 안전하다.

## 관련 글

- [NestJS란 — 모듈·컨트롤러·프로바이더](/notes/nestjs/what-is-nestjs/)
- [Pipes·검증·DTO](/notes/nestjs/pipes-validation-dto/)
- [설정·환경·로깅](/notes/nestjs/config-logging/)
