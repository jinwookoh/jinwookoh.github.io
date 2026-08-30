---
title: "Pipes·검증·DTO"
series: nestjs
part: "요청 처리"
order: 3
summary: "Pipe는 핸들러 진입 직전에 인자를 변환·검증하는 계층이며, ValidationPipe와 DTO 조합이 입력 검증의 표준이다"
tags: [NestJS, Pipe, ValidationPipe, DTO, class-validator]
sources: [https://docs.nestjs.com/pipes, https://docs.nestjs.com/techniques/validation]
updated: 2026-08-30
---

HTTP 요청 값은 전부 문자열이거나 형태를 보장할 수 없는 JSON이다. 경로 파라미터 `:id`는 `"abc"`일 수 있고, 본문에는 정의하지 않은 필드가 섞여 들어온다. 컨트롤러마다 `if` 문으로 걸러내면 검증이 비즈니스 로직과 뒤섞이고, 누락된 검증 하나가 서비스 계층까지 잘못된 값을 흘려보낸다. NestJS는 이 문제를 Pipe 계층으로 분리한다.

## 핵심 개념

Pipe는 `PipeTransform`을 구현한 `@Injectable()` 클래스로, 라우트 핸들러 직전에 실행된다. 역할은 변환(문자열 `"42"`를 숫자 `42`로)과 검증(조건 불만족 시 예외) 두 가지다. 예외는 Exception Filter가 응답으로 바꾸므로 핸들러는 정제된 값만 받는다.

`transform(value, metadata)`의 `ArgumentMetadata`에는 인자 출처(`type`), 타입 정보(`metatype`), 데코레이터 인자(`data`)가 담긴다. `metatype`은 컴파일 시점 메타데이터라 인터페이스·제네릭은 런타임에 사라진다. DTO를 클래스로 선언해야 하는 이유다.

Spring과 대응시키면 DTO 검증은 `@Valid` + Bean Validation, `ParseIntPipe` 같은 변환 Pipe는 `Converter`·`@RequestParam` 타입 바인딩에 해당한다.

내장 Pipe는 `ValidationPipe`, `ParseIntPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`, `ParseEnumPipe`, `ParseDatePipe`, `ParseFilePipe`, `DefaultValuePipe` 등이 있고, Zod·Valibot 같은 Standard Schema 호환 스키마를 받는 `StandardSchemaValidationPipe`도 추가됐다. 바인딩 범위는 파라미터·메서드(`@UsePipes`)·컨트롤러·전역 네 단계다. 전역 등록은 `app.useGlobalPipes()`와 `APP_PIPE` 프로바이더 두 방식이 있으며, 후자만 DI 컨테이너 안에서 생성되므로 다른 프로바이더를 주입받는 Pipe는 `APP_PIPE`로 등록한다.

`ValidationPipe`는 `class-validator`와 `class-transformer`를 사용하며 두 패키지는 직접 설치한다. plain object를 DTO 인스턴스로 변환한 뒤 데코레이터 규칙을 검사한다.

| 옵션 | 동작 |
|---|---|
| `whitelist` | 데코레이터가 없는 속성을 제거한다 |
| `forbidNonWhitelisted` | 제거 대신 400 예외를 던진다 |
| `transform` | 검증 후 DTO 인스턴스와 기본 타입 변환 결과를 핸들러에 넘긴다 |
| `transformOptions.enableImplicitConversion` | 타입 메타데이터 기준으로 문자열을 number·boolean으로 암묵 변환한다 |
| `stopAtFirstError` | 속성별로 첫 실패에서 검사를 멈춘다 |
| `exceptionFactory` | 에러 배열을 받아 커스텀 예외로 바꾼다 |

DTO 파생 타입은 `@nestjs/mapped-types`의 `PartialType`, `PickType`, `OmitType`, `IntersectionType`으로 만든다. 검증 데코레이터까지 상속되므로 규칙을 두 번 적지 않아도 된다.

## 코드

전역 ValidationPipe를 `APP_PIPE`로 등록하고, DTO에 검증 규칙을 선언한다.

```ts
// app.module.ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
  ],
})
export class AppModule {}

// create-cat.dto.ts
import { IsInt, IsString, Length, Min } from 'class-validator';

export class CreateCatDto {
  @IsString()
  @Length(1, 50)
  name: string;

  @IsInt()
  @Min(0)
  age: number;
}

// update-cat.dto.ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateCatDto } from './create-cat.dto';

export class UpdateCatDto extends PartialType(CreateCatDto) {}
```

경로·쿼리 파라미터는 전용 Parse Pipe로 변환한다. `DefaultValuePipe`는 값이 없을 때 기본값을 채운 뒤 다음 Pipe로 넘긴다.

```ts
import {
  Controller, DefaultValuePipe, Get, HttpStatus,
  Param, ParseArrayPipe, ParseIntPipe, Query,
} from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('ids', new ParseArrayPipe({ items: Number, separator: ',', optional: true }))
    ids?: number[],
  ) {
    return { page, ids };
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE }))
    id: number,
  ) {
    return { id };
  }
}
```

클래스 기반 데코레이터 대신 Zod 스키마로 검증하려면 `PipeTransform`을 직접 구현한다.

```ts
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z, ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return result.data;
  }
}

export const createCatSchema = z.object({
  name: z.string().min(1).max(50),
  age: z.number().int().nonnegative(),
});
export type CreateCat = z.infer<typeof createCatSchema>;

// 사용: @Post() @UsePipes(new ZodValidationPipe(createCatSchema)) create(@Body() dto: CreateCat)
```

## 실무에서 걸리는 지점

- **`whitelist` 없이 운영하면 mass assignment가 열린다.** 본문에 `isAdmin: true`가 섞여 들어와도 그대로 서비스로 넘어간다. `whitelist: true`를 기본으로 두고, 계약을 엄격히 지키려면 `forbidNonWhitelisted`까지 켠다.
- **`enableImplicitConversion`은 boolean에서 함정이 있다.** `class-transformer`는 `"false"` 문자열을 `Boolean("false")`, 즉 `true`로 바꾼다. 쿼리의 boolean 값은 `ParseBoolPipe`나 `@Transform`으로 명시 변환해야 한다.
- **배열 본문은 타입 정보가 없다.** `@Body() dtos: CreateCatDto[]`는 런타임 `metatype`이 `Array`로만 남아 검증이 통과되지 않는다. 배열을 감싸는 래퍼 DTO를 만들거나 `ParseArrayPipe({ items: CreateCatDto })`를 쓴다.
- **중첩 객체는 `@ValidateNested()`와 `@Type()`을 함께 붙여야 한다.** 둘 중 하나라도 빠지면 중첩 객체가 plain object로 남아 내부 규칙이 검사되지 않는다.
- **에러 응답 형식은 `exceptionFactory`로 통일한다.** 기본 400 응답은 `message` 배열에 문자열만 나열되어 필드별 매핑이 어렵다. `ValidationError[]`를 `{ field, constraints }` 구조로 바꾸는 팩토리를 전역 Pipe에 넣는다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [Guards·인증 — Passport·JWT](/notes/nestjs/guards-auth-jwt/)
- [Interceptors·Exception Filters·Middleware](/notes/nestjs/interceptors-filters-middleware/)
