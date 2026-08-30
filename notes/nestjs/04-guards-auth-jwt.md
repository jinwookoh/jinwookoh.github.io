---
title: "Guards·인증 — Passport·JWT"
series: nestjs
part: "요청 처리"
order: 4
summary: "Guard는 핸들러 실행 전 요청의 자격을 판정하는 단일 지점이며, JWT 인증과 역할 인가를 여기서 분리해 처리한다."
tags: [NestJS, Guard, JWT, Passport, Authorization]
sources: [https://docs.nestjs.com/guards, https://docs.nestjs.com/security/authentication, https://docs.nestjs.com/security/authorization]
updated: 2026-08-30
---

인증 로직을 컨트롤러 메서드 안에 두면 같은 토큰 검증 코드가 핸들러마다 반복되고, 새 엔드포인트를 추가할 때 한 줄만 빠뜨려도 보호되지 않은 API가 열린다. 미들웨어로 끌어올리면 반복은 줄지만, 미들웨어는 다음에 어떤 핸들러가 실행될지 모르므로 핸들러 단위 정책을 적용할 수 없다. NestJS의 Guard는 실행 컨텍스트를 알고 있는 상태에서 핸들러 직전에 개입하는 구성 요소이며, 인증(누구인가)과 인가(무엇을 할 수 있는가)를 선언적으로 분리할 수 있게 한다.

## 핵심 개념

Guard는 `@Injectable()` 클래스가 `CanActivate` 인터페이스를 구현한 것이다. 유일한 메서드 `canActivate(context: ExecutionContext)`는 `boolean | Promise<boolean> | Observable<boolean>`을 반환하고, false이면 Nest가 `ForbiddenException`을 던진다. 실행 순서는 미들웨어 → Guard → Interceptor → Pipe → 핸들러로 고정되어 있어, Guard가 거부한 요청은 Pipe의 검증이나 Interceptor의 로깅에 도달하지 않는다.

`ExecutionContext`는 `ArgumentsHost`를 확장한 객체로, `switchToHttp().getRequest()`로 요청 객체를 꺼내는 것 외에 `getHandler()`와 `getClass()`로 곧 실행될 메서드와 컨트롤러 클래스 참조를 제공한다. 미들웨어와 결정적으로 다른 지점이 여기다. 핸들러 참조가 있으면 데코레이터로 붙여 둔 메타데이터를 `Reflector`로 읽어 정책을 분기할 수 있다.

메타데이터는 두 가지 방식으로 붙인다. `SetMetadata(key, value)`로 만든 커스텀 데코레이터를 쓰거나, `Reflector.createDecorator<T>()`로 타입이 붙은 데코레이터를 생성한다. 읽는 쪽에서는 `reflector.get(Roles, context.getHandler())`처럼 한 대상만 조회하거나, `getAllAndOverride(key, [handler, class])`로 메서드 메타데이터가 클래스 메타데이터를 덮어쓰도록 조회한다.

Guard는 `@UseGuards()`로 메서드·컨트롤러 단위에 붙이거나, 모듈 provider에 `APP_GUARD` 토큰으로 등록해 전역 적용한다. 전역 등록을 `app.useGlobalGuards()` 대신 `APP_GUARD`로 하는 이유는 DI 컨테이너 안에서 생성되어야 `JwtService` 같은 의존성을 주입받을 수 있기 때문이다.

인증 구현은 두 갈래다. 공식 문서의 기본 경로는 `@nestjs/jwt`만으로 `JwtService.signAsync()`로 발급하고 `verifyAsync()`로 검증하는 방식이다. OAuth·세션·다중 전략이 필요하면 `@nestjs/passport`를 얹어 `PassportStrategy(Strategy)`를 상속한 클래스의 `validate()`에 검증 로직을 두고 `AuthGuard('jwt')`로 연결한다. 어느 쪽이든 검증이 끝난 사용자 정보는 `request.user`에 실려 이후 Guard와 핸들러가 공유한다.

Spring과 대응시키면 Guard는 Security Filter와 `@PreAuthorize`를 합친 위치에 있고, `Reflector`는 `HandlerMethod`에서 애너테이션을 읽는 동작, `PassportStrategy.validate()`는 `AuthenticationProvider.authenticate()`에 해당한다.

## 코드

전역 JWT Guard. `@Public()`이 붙은 핸들러는 통과시키고, 나머지는 Bearer 토큰을 검증해 `request.user`를 채운다.

```typescript
import {
  CanActivate, ExecutionContext, Injectable,
  SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) throw new UnauthorizedException();

    try {
      request['user'] = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
```

모듈 등록과 토큰 발급. `JwtModule`을 `global: true`로 올리면 다른 모듈에서 import 없이 `JwtService`를 주입받는다.

```typescript
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}

export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  async signIn(userId: string, roles: string[]) {
    const payload = { sub: userId, roles };
    return { access_token: await this.jwtService.signAsync(payload) };
  }
}
```

역할 기반 인가 Guard. `Reflector.createDecorator`로 타입이 붙은 `@Roles()`를 만들고, 앞선 Guard가 채운 `request.user.roles`와 대조한다.

```typescript
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const Roles = Reflector.createDecorator<string[]>();

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest();
    return required.some((role) => user?.roles?.includes(role));
  }
}

// 사용 예
// @Roles(['admin'])
// @Delete(':id')
// remove(@Param('id') id: string) {}
```

## 실무에서 걸리는 지점

- **Guard 실행 순서는 등록 순서다.** `APP_GUARD`를 여러 개 등록하면 provider 배열 순서대로 실행되므로 `JwtAuthGuard`가 `RolesGuard`보다 앞에 와야 `request.user`가 채워진 상태로 역할 검사가 이루어진다. ==순서가 뒤집히면 모든 요청이 403으로 떨어진다.==
- **false 반환과 예외 던지기는 응답 코드가 다르다.** false를 반환하면 Nest가 403 `ForbiddenException`으로 바꾸고, 토큰이 없거나 만료된 경우는 직접 `UnauthorizedException`(401)을 던져야 클라이언트가 재로그인과 권한 부족을 구분한다.
- **Guard는 Pipe보다 먼저 실행된다.** ==따라서 Guard 안에서 본문 DTO가 검증·변환됐다고 가정하면 안 된다.== 요청 본문에 의존하는 인가 판단은 raw 값을 직접 다루거나 Interceptor 이후 계층으로 옮긴다.
- **Passport 경로에서는 `validate()`의 반환값이 곧 `request.user`다.** ==여기서 DB 조회를 하면 모든 보호 요청마다 쿼리가 발생한다.== 토큰 payload만으로 충분한 정보를 담거나, 조회가 필요하면 캐시를 앞에 두는 것이 일반적이다.

## 관련 글

- [Pipes·검증·DTO](/notes/nestjs/pipes-validation-dto/)
- [Interceptors·Exception Filters·Middleware](/notes/nestjs/interceptors-filters-middleware/)
- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
