---
title: "설정·환경·로깅"
series: nestjs
part: "데이터와 인프라"
order: 7
summary: "환경 변수를 검증된 타입 객체로 주입하고, 부트스트랩 로그까지 한 로거로 모으는 방법을 정리한다"
tags: [NestJS, ConfigModule, ConfigService, Logger, ConsoleLogger]
sources: [https://docs.nestjs.com/techniques/configuration, https://docs.nestjs.com/techniques/logger]
updated: 2026-08-30
---

서비스 코드에서 `process.env`를 직접 읽으면 값이 항상 `string | undefined`라 파싱과 null 체크가 반복되고, 필수 변수가 빠진 채 기동해도 해당 코드가 실행되기 전까지 오류가 나지 않는다. 로깅도 마찬가지로 `console.log`를 흩어 쓰면 레벨을 한 곳에서 조절할 수 없고, 프레임워크 부트스트랩 로그와 애플리케이션 로그의 형식이 달라 수집기 파싱이 깨진다. `@nestjs/config`와 내장 `Logger`가 이 둘을 DI 안에서 해결한다.

## 핵심 개념

Spring 대응으로 `ConfigModule` ≈ `Environment` + `@ConfigurationProperties`, `Logger` ≈ SLF4J 파사드 + Logback 구현체다.

### ConfigModule과 ConfigService

`ConfigModule.forRoot()`는 기동 시 `.env` 파일을 읽어 `process.env`에 병합하고 `ConfigService` 프로바이더로 노출한다. `isGlobal`로 전역 등록, `envFilePath`로 파일 경로(배열이면 앞쪽 우선), `ignoreEnvFile`로 파일 무시, `load`로 가공 팩토리 등록, `validate`나 `validationSchema`로 기동 시 검증, `cache`로 조회 캐시, `expandVariables`로 `${VAR}` 참조 전개를 지정한다.

`ConfigService.get<T>(key)`는 `T | undefined`를 반환한다. 제네릭 첫 번째 인자에 환경 변수 인터페이스, 두 번째에 `true`를 넘기면 `undefined`가 제외되고, `{ infer: true }`를 붙이면 키로부터 값 타입을 추론한다. `getOrThrow(key)`는 값이 없으면 즉시 예외를 던진다.

### 네임스페이스 설정과 registerAs

`registerAs('database', () => ({...}))`는 팩토리를 키 아래에 묶는다. `ConfigService.get('database.url')`처럼 점 표기로 읽거나, `@Inject(databaseConfig.KEY)`로 주입해 `ConfigType<typeof databaseConfig>` 타입을 받는다. 후자가 Spring의 `@ConfigurationProperties(prefix = "database")`에 가장 가깝다. 기능 모듈에서만 필요한 설정은 `ConfigModule.forFeature()`로 부분 등록한다.

### 검증

`validate`에는 `Record<string, unknown>`을 받아 검증된 객체를 반환하는 동기 함수를 넘긴다. `class-validator`와 `class-transformer`를 조합하면 DTO와 같은 데코레이터 방식이 되고, `validationSchema`에는 Standard Schema 호환 스키마(Zod 등)를 넘긴다. 실패 시 기동이 중단되어 잘못된 배포가 트래픽을 받기 전에 걸러진다.

### Logger와 LoggerService

`@nestjs/common`의 `Logger`는 파사드이고 실제 출력은 `ConsoleLogger`가 맡는다. `NestFactory.create()`의 `logger` 옵션으로 구현체를 교체하거나 레벨 배열(`fatal`, `error`, `warn`, `log`, `debug`, `verbose`)로 출력을 제한한다. `LoggerService`를 구현하면 pino나 winston도 끼울 수 있다. `ConsoleLogger` 옵션 중 `json: true`는 한 줄 JSON 출력, `prefix`는 접두어, `colors: false`는 stdout의 ANSI 코드를 막는다.

## 코드

환경 변수 스키마를 클래스로 선언하고 기동 시 검증한다. `enableImplicitConversion`이 있어야 문자열이 `number`로 변환된 뒤 `@IsNumber()`를 통과한다.

```typescript
// src/config/env.validation.ts
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, IsString, Max, Min, validateSync } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment;

  @IsNumber()
  @Min(0)
  @Max(65535)
  PORT: number;

  @IsString()
  DATABASE_URL: string;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validated;
}
```

네임스페이스 설정을 전역 등록하고 서비스에서 타입 안전하게 주입받는다.

```typescript
// src/config/database.config.ts
import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL!,
  poolSize: Number(process.env.DATABASE_POOL_SIZE ?? 10),
}));

// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.NODE_ENV}`, '.env'],
      load: [databaseConfig],
      validate,
      cache: true,
    }),
  ],
})
export class AppModule {}

// src/database/database.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, ConfigType } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import { EnvironmentVariables } from '../config/env.validation';

@Injectable()
export class DatabaseService {
  constructor(
    @Inject(databaseConfig.KEY)
    private readonly db: ConfigType<typeof databaseConfig>,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  describe() {
    const port = this.config.get('PORT', { infer: true }); // number
    return `${this.db.url} (pool=${this.db.poolSize}, port=${port})`;
  }
}
```

부트스트랩 로그까지 JSON 로거로 내보내고, 서비스에서는 컨텍스트를 붙여 쓴다. `bufferLogs: true`면 `useLogger()` 호출 전 로그가 버퍼에 쌓였다가 교체된 로거로 출력된다.

```typescript
// src/main.ts
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const isProd = process.env.NODE_ENV === 'production';
  app.useLogger(
    new ConsoleLogger({
      prefix: 'orders-api',
      json: isProd,
      colors: !isProd,
      logLevels: isProd ? ['fatal', 'error', 'warn', 'log'] : ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
    }),
  );

  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>('PORT'));
}
bootstrap();

// src/orders/orders.service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  create(orderId: string) {
    this.logger.log(`order created id=${orderId}`);
    try {
      // ...
    } catch (err) {
      this.logger.error(`order failed id=${orderId}`, (err as Error).stack);
      throw err;
    }
  }
}
```

## 실무에서 걸리는 지점

- **`.env` 파일은 `process.env`를 덮어쓰지 않는다.** 셸이나 컨테이너 런타임이 설정한 변수가 우선한다. 파일 수정이 반영되지 않으면 셸 변수를 먼저 의심하고, 운영에서는 `ignoreEnvFile: true`로 파일 의존을 끊는다.
- **`ConfigService`를 `forRoot()` 이전에 쓸 수 없다.** 설정에 의존하는 동적 모듈은 `TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory })` 형태로 비동기 등록해야 한다. 동기 `forRoot()`에 `process.env`를 직접 넣으면 파일이 아직 읽히지 않아 `undefined`가 들어간다.
- **`cache: true`는 런타임 변경을 반영하지 않는다.** 기동 이후 `process.env`를 바꿔도 `ConfigService`에는 보이지 않으므로, 테스트에서 변수를 바꿔 가며 검증할 때 원인이 되기 쉽다.
- **`bufferLogs` 없이 `useLogger()`를 호출하면 부트스트랩 로그는 기본 로거로 나간다.** 모듈 초기화 로그가 텍스트로 먼저 찍히고 이후부터 JSON이 되어 수집기 파싱이 깨진다. 기동 실패 시 버퍼가 비워지지 않을 수 있으므로 `catch`에서 `app.flushLogs()`를 호출한다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [데이터베이스 — TypeORM·Prisma·트랜잭션](/notes/nestjs/database-typeorm-prisma/)
- [테스트와 배포](/notes/nestjs/testing-deployment/)
