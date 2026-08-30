---
title: "Interceptors·Exception Filters·Middleware"
series: nestjs
part: "요청 처리"
order: 5
summary: "요청 파이프라인의 세 가로축 — 어디서 무엇을 자르고, 무엇을 감싸고, 예외를 어디서 받는가"
tags: [NestJS, Interceptor, ExceptionFilter, Middleware, RxJS]
sources: [https://docs.nestjs.com/interceptors, https://docs.nestjs.com/exception-filters, https://docs.nestjs.com/middleware]
updated: 2026-08-30
---

핸들러마다 로깅·응답 포장·예외 변환을 직접 쓰면 같은 코드가 모든 라우트에 복제되고, 처리되지 않은 예외는 스택 트레이스가 그대로 클라이언트로 나간다. NestJS는 이 횡단 관심사를 파이프라인의 정해진 위치에 꽂는 세 장치로 분리한다. Middleware는 라우팅 전에, Interceptor는 핸들러 앞뒤에, Exception Filter는 예외가 던져진 뒤에 개입한다.

## 핵심 개념

요청 한 건이 지나는 순서는 고정되어 있다. Middleware → Guard → Interceptor(전) → Pipe → 핸들러 → Interceptor(후) → Exception Filter. 어느 단계에서 예외가 나든 마지막 Filter가 받는다. Spring으로 치면 Middleware ≈ Servlet Filter, Interceptor ≈ HandlerInterceptor 또는 AOP @Around, Exception Filter ≈ @ControllerAdvice + @ExceptionHandler에 해당한다.

**Middleware**는 Express 미들웨어와 같은 `(req, res, next)` 시그니처를 가진다. 라우트 핸들러가 결정되기 전에 실행되므로 `ExecutionContext`가 없고, 어떤 핸들러로 갈지 알 수 없다. `NestMiddleware` 클래스형은 DI가 되고, 함수형은 `app.use()`로 전역에 붙일 수 있다. 등록은 데코레이터가 아니라 모듈의 `configure(consumer)`에서 `apply().forRoutes()`로 한다.

**Interceptor**는 `NestInterceptor`의 `intercept(context, next)`를 구현한다. `next.handle()`이 핸들러 실행을 감싼 `Observable`을 돌려주므로, 호출 전 로직은 `handle()` 앞에, 호출 후 로직은 RxJS 연산자로 붙인다. `map`으로 응답을 변환하고, `catchError`로 예외를 바꿔 던지며, `timeout`으로 제한을 걸고, `handle()`을 아예 호출하지 않고 `of(cached)`를 반환하면 핸들러를 건너뛴다.

**Exception Filter**는 `@Catch()`로 잡을 예외 타입을 선언하고 `catch(exception, host)`를 구현한다. `ArgumentsHost`는 HTTP·RPC·WebSocket 어느 컨텍스트인지 추상화한 객체이며 `switchToHttp()`로 요청·응답을 꺼낸다. 기본 내장 필터는 `HttpException`과 그 하위 타입을 상태 코드와 JSON 본문으로 변환하고, 그 외 예외는 500으로 뭉갠다. `@Catch()`를 인자 없이 쓰면 모든 예외를 받는다. 기본 동작에 덧붙이기만 하려면 `BaseExceptionFilter`를 상속한다.

세 장치 모두 적용 범위는 메서드·컨트롤러·전역 세 단계다. 전역 등록은 `app.useGlobalInterceptors()` 같은 메서드도 있지만 이 경로는 DI가 되지 않으므로, 프로바이더를 주입받아야 한다면 `APP_INTERCEPTOR`·`APP_FILTER` 토큰으로 모듈에 등록한다.

## 코드

응답을 `{ data, timestamp }`로 감싸고 실행 시간을 로깅하는 Interceptor. `handle()` 앞은 요청 전, `pipe` 안은 응답 후에 실행된다.

```ts
import {
  CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor,
} from '@nestjs/common';
import { Observable, map, tap } from 'rxjs';

interface Envelope<T> { data: T; timestamp: string }

@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T>> {
  private readonly logger = new Logger(EnvelopeInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T>> {
    const started = Date.now();
    const { method, url } = context.switchToHttp().getRequest<{ method: string; url: string }>();

    return next.handle().pipe(
      map((data) => ({ data, timestamp: new Date().toISOString() })),
      tap(() => this.logger.log(`${method} ${url} ${Date.now() - started}ms`)),
    );
  }
}
```

`HttpException`이 아닌 예외까지 받아 일관된 JSON으로 응답하는 전역 Filter. `HttpAdapterHost`를 쓰면 Express·Fastify 어느 쪽이든 같은 코드로 응답을 쓴다.

```ts
import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Module,
} from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    httpAdapter.reply(ctx.getResponse(), {
      statusCode: status,
      message,
      path: httpAdapter.getRequestUrl(ctx.getRequest()),
      timestamp: new Date().toISOString(),
    }, status);
  }
}

@Module({
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
```

요청 ID를 헤더에 심는 클래스형 Middleware와 모듈 등록. NestJS 11은 path-to-regexp 8 기반이라 와일드카드를 `*` 대신 `{*splat}`처럼 이름 있는 파라미터로 쓴다.

```ts
import {
  Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule, RequestMethod,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const id = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', id);
    next();
  }
}

@Module({ /* controllers, providers */ })
export class OrdersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes({ path: 'orders/{*splat}', method: RequestMethod.ALL });
  }
}
```

## 실무에서 걸리는 지점

- **Interceptor는 핸들러가 던진 예외를 먼저 본다.** ==`catchError`로 삼켜 버리면 Filter까지 도달하지 않아 에러 로그와 모니터링이 조용히 빠진다.== 변환만 하고 다시 던지든가, 아예 손대지 않는 편이 안전하다.
- **`handle()`을 두 번 구독하면 핸들러가 두 번 실행된다.** ==Observable은 lazy이므로 `firstValueFrom` 같은 변환을 여러 번 걸거나, 스트림을 분기해 각각 구독하면 DB 쓰기가 중복된다.== 파이프 하나로 끝내야 한다.
- ==**Middleware 예외는 Filter가 받지 못한다.**== Middleware는 라우트 결정 전이라 Nest 예외 레이어 밖에서 돈다. `next(err)`로 넘기면 Express 기본 에러 핸들러가 처리하며, 응답 형식이 Filter에서 만든 것과 달라진다. 인증처럼 라우트 정보가 필요한 판단은 Guard로 옮긴다.
- **Filter 안에서 또 예외가 나면 응답이 끊긴다.** ==응답 직렬화나 외부 로깅 호출이 Filter 안에서 실패하면 잡아 줄 상위 레이어가 없다.== Filter 내부 로직은 최소화하고, 로깅 실패는 삼킨다.
- **`useGlobal*`과 `APP_*` 토큰을 섞으면 순서가 헷갈린다.** 전역 Interceptor는 등록 순서대로 감싸고, Filter는 같은 범위에서 나중에 등록된 것이 먼저 평가된다. 전역 등록은 테스트에서 재현이 쉬운 `APP_*` 토큰 한 방식으로 통일한다.

## 관련 글

- [Guards·인증 — Passport·JWT](/notes/nestjs/guards-auth-jwt/)
- [Pipes·검증·DTO](/notes/nestjs/pipes-validation-dto/)
- [설정·환경·로깅](/notes/nestjs/config-logging/)
