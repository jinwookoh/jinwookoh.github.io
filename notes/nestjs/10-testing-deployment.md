---
title: "테스트와 배포"
series: nestjs
part: "운영"
order: 10
summary: "TestingModule로 의존성을 교체해 단위·e2e 테스트를 짜고, 빌드 산출물을 컨테이너로 안전하게 종료·배포하는 방법을 정리한다."
tags: [NestJS, Testing, Jest, Docker, Deployment]
sources: [https://docs.nestjs.com/fundamentals/testing, https://docs.nestjs.com/deployment]
updated: 2026-08-30
---

DI 컨테이너 위에 올라간 코드를 `new`로 직접 조립해 테스트하면 데코레이터 메타데이터, 모듈 스코프, 요청 스코프 프로바이더가 전부 빠진 상태로 검증하게 된다. 통과한 테스트가 실제 부트스트랩과 다른 그래프를 보고 있으므로 신뢰도가 낮고, 데이터베이스나 외부 API 같은 무거운 의존성을 떼어낼 표준 방법도 없어 테스트가 느리고 불안정해진다. 배포 쪽도 마찬가지로, `ts-node`로 소스를 그대로 띄우거나 종료 신호를 처리하지 않으면 컨테이너 재시작 때마다 진행 중인 요청과 DB 커넥션이 끊긴다. NestJS는 테스트용 모듈 빌더와 종료 훅, 빌드 산출물 실행 규약으로 이 두 문제를 프레임워크 차원에서 다룬다.

## 핵심 개념

`@nestjs/testing`의 `Test.createTestingModule()`은 일반 `@Module()`과 같은 메타데이터(controllers·providers·imports)를 받아 테스트 전용 컨테이너를 만든다. `compile()`이 그래프를 해석해 `TestingModule`을 돌려주고, 여기서 `get()`으로 싱글턴 인스턴스를, `resolve()`로 요청·transient 스코프 인스턴스를 꺼낸다. 스프링의 `@SpringBootTest` + `@MockBean` 조합에 대응한다.

의존성 교체는 `compile()` 전에 체이닝으로 선언한다.

| 메서드 | 용도 |
|---|---|
| `overrideProvider(T).useValue / useClass / useFactory` | 특정 프로바이더를 목으로 교체 |
| `overrideGuard / overrideInterceptor / overridePipe / overrideFilter` | 인핸서 교체 (예: 인증 가드를 항상 통과시키기) |
| `overrideModule(A).useModule(B)` | 모듈 단위 교체 |
| `useMocker(fn)` | 선언하지 않은 나머지 의존성을 토큰 기준으로 자동 목 생성 |

요청 스코프 프로바이더는 `get()`으로 꺼낼 수 없다. `ContextIdFactory.create()`로 컨텍스트 ID를 만들고, `ContextIdFactory.getByRequest`를 spy로 고정한 뒤 `resolve(Token, contextId)`로 얻는다.

e2e 테스트는 `moduleRef.createNestApplication()`으로 실제 HTTP 어댑터까지 올린 뒤 `supertest`로 요청을 보낸다. 이때 `main.ts`에서 적용한 전역 파이프·프리픽스는 자동으로 붙지 않으므로 테스트 쪽에서 동일하게 설정해야 한다. 스프링의 `MockMvc` 또는 `WebTestClient`에 대응한다.

배포는 `nest build`가 만든 `dist/main.js`를 Node LTS로 직접 실행하는 것이 기본이다. `NODE_ENV=production`을 설정해야 의존 라이브러리들의 프로덕션 최적화가 켜지고, 포트·시크릿은 환경 변수로만 주입한다. 종료 신호는 `app.enableShutdownHooks()`를 켜야 `OnModuleDestroy`·`BeforeApplicationShutdown`·`OnApplicationShutdown` 훅이 SIGTERM에 반응한다. 상태 점검은 `@nestjs/terminus`가 DB·메모리·디스크 인디케이터를 제공하며, 스프링 액추에이터의 `/actuator/health`에 해당한다.

## 코드

컨트롤러 단위 테스트. 서비스를 직접 등록한 뒤 메서드를 spy로 덮는다.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CatsController } from './cats.controller';
import { CatsService } from './cats.service';

describe('CatsController', () => {
  let controller: CatsController;
  let service: CatsService;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CatsController],
      providers: [CatsService],
    }).compile();

    service = moduleRef.get(CatsService);
    controller = moduleRef.get(CatsController);
  });

  it('findAll은 서비스 결과를 그대로 돌려준다', async () => {
    const result = [{ id: 1, name: 'nabi' }];
    jest.spyOn(service, 'findAll').mockResolvedValue(result);
    await expect(controller.findAll()).resolves.toBe(result);
  });
});
```

e2e 테스트. 모듈을 통째로 올리되 서비스와 가드를 교체하고, 전역 파이프는 `main.ts`와 같게 맞춘다.

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CatsModule } from '../src/cats/cats.module';
import { CatsService } from '../src/cats/cats.service';
import { AuthGuard } from '../src/auth/auth.guard';

describe('Cats (e2e)', () => {
  let app: INestApplication;
  const catsService = { findAll: () => [{ id: 1, name: 'nabi' }] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatsModule],
    })
      .overrideProvider(CatsService).useValue(catsService)
      .overrideGuard(AuthGuard).useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /cats', () =>
    request(app.getHttpServer())
      .get('/cats')
      .expect(200)
      .expect(catsService.findAll()));
});
```

프로덕션 부트스트랩과 멀티스테이지 Dockerfile. 종료 훅을 켜고, 런타임 이미지에는 빌드 산출물과 프로덕션 의존성만 넣는다.

```typescript
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

## 실무에서 걸리는 지점

- **전역 설정 누락**: ==`useGlobalPipes`·`setGlobalPrefix`·`useGlobalFilters`는 `main.ts`에 있으므로 e2e에서 다시 적용하지 않으면 검증 에러가 200으로 통과한다.== 부트스트랩 설정을 별도 함수로 뽑아 `main.ts`와 테스트가 공유하게 만드는 편이 안전하다.
- **`app.close()` 생략**: e2e에서 앱을 닫지 않으면 DB 풀·타이머·큐 커넥션이 남아 Jest가 종료되지 않거나 다음 테스트 파일과 포트가 충돌한다. `afterAll`에서 반드시 닫는다.
- **`overrideProvider` 토큰 불일치**: `@Inject('CACHE')`처럼 문자열·심볼 토큰으로 주입한 프로바이더는 클래스가 아닌 그 토큰으로 override해야 한다. ==클래스로 지정하면 조용히 실패하고 실제 구현이 로드된다.==
- **종료 훅 미활성화**: `enableShutdownHooks()`를 켜지 않으면 SIGTERM에서 `OnApplicationShutdown`이 실행되지 않아 롤링 배포 중 진행 요청이 잘린다. ==`npm start`로 띄우면 시그널이 npm에 머무르므로 Node를 직접 실행한다.==
- **헬스체크와 readiness 분리**: ==Terminus 엔드포인트 하나를 liveness와 readiness에 같이 쓰면 DB 일시 장애 때 파드가 재시작 루프에 빠진다.== DB 인디케이터는 readiness에만 두고 liveness는 프로세스 생존만 본다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [Guards·인증 — Passport·JWT](/notes/nestjs/guards-auth-jwt/)
- [설정·환경·로깅](/notes/nestjs/config-logging/)
