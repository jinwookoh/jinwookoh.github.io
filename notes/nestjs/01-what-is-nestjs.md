---
title: "NestJS란 — 모듈·컨트롤러·프로바이더"
series: nestjs
part: "기초"
order: 1
summary: "NestJS는 모듈·컨트롤러·프로바이더 세 축과 DI 컨테이너로 Node 서버에 Spring식 구조를 부여한다"
tags: [NestJS, TypeScript, Node.js, DI, Controller]
sources: [https://docs.nestjs.com/first-steps, https://docs.nestjs.com/controllers, https://docs.nestjs.com/providers]
updated: 2026-08-30
---

Express나 Fastify만으로 서버를 만들면 라우팅·비즈니스 로직·DB 접근이 한 파일에 섞이고, 의존 객체를 어디서 생성해 어떻게 넘길지가 팀마다 달라진다. 테스트에서 의존성을 갈아 끼우기 어렵고, 서비스가 커질수록 핸들러의 의존 관계를 코드에서 읽어낼 수 없게 된다. NestJS는 이 문제를 강제된 구조로 해결한다. 모듈로 경계를 긋고, 컨트롤러가 HTTP를 받고, 프로바이더가 로직을 담당하며, 이 셋의 결합은 IoC 컨테이너가 맡는다. Spring Boot를 써 본 개발자라면 구조가 낯설지 않다.

## 핵심 개념

NestJS 애플리케이션은 `NestFactory.create(AppModule)`로 루트 모듈을 읽어 의존성 그래프를 구성하고, `app.listen()`으로 HTTP 서버를 띄운다. 기본 HTTP 어댑터는 Express이며 Fastify로 교체할 수 있다. 실행에는 Node 20.19 이상 또는 22.12 이상이 필요하다.

**모듈**은 `@Module()` 데코레이터가 붙은 클래스로, `controllers`·`providers`·`imports`·`exports` 네 항목으로 구성 단위를 선언한다. 루트 모듈 하나는 반드시 있어야 하고, 기능 단위로 하위 모듈을 나눠 `imports`로 연결한다. 프로바이더는 기본적으로 모듈 내부에 캡슐화되며, 다른 모듈에서 쓰려면 `exports`에 올려야 한다. Spring의 `@Configuration` + 컴포넌트 스캔 범위를 명시적으로 적어 놓은 것에 가깝다.

**컨트롤러**는 `@Controller('cats')`로 경로 접두사를 갖고, 메서드에 `@Get()`·`@Post()` 등 HTTP 메서드 데코레이터를 붙여 라우트를 정의한다. 요청 데이터는 `@Param()`·`@Query()`·`@Body()`·`@Headers()` 같은 파라미터 데코레이터로 꺼낸다. 핸들러가 객체를 반환하면 JSON으로 직렬화되고, 원시값은 그대로 전송된다. 상태 코드는 GET 200, POST 201이 기본이며 `@HttpCode()`로 바꾼다. `Promise`나 RxJS `Observable`을 반환해도 프레임워크가 해소한다. Spring의 `@RestController` + `@GetMapping` + `@PathVariable`·`@RequestBody`에 대응한다.

**프로바이더**는 `@Injectable()`이 붙은 클래스로, 서비스·리포지토리·팩토리·헬퍼 등 주입 가능한 모든 것을 가리킨다. 생성자 파라미터의 타입을 보고 컨테이너가 인스턴스를 만들어 넣어 주며, 기본 스코프는 싱글턴이다. 요청마다 새 인스턴스가 필요하면 `Scope.REQUEST`를 지정한다. 의존성이 없어도 되는 경우 `@Optional()`을, 토큰을 직접 지정할 때는 `@Inject()`를 쓴다. Spring의 `@Service`·`@Component`와 생성자 주입에 대응한다.

| 요소 | 데코레이터 | 역할 | Spring 대응 |
|---|---|---|---|
| 모듈 | `@Module()` | 구성 단위·캡슐화 경계 | `@Configuration`, 패키지 스캔 범위 |
| 컨트롤러 | `@Controller()` | HTTP 라우팅·요청 파싱·응답 | `@RestController` |
| 프로바이더 | `@Injectable()` | 비즈니스 로직·주입 대상 | `@Service`, `@Component` |

## 코드

프로바이더는 상태를 가진 서비스로 정의하고 `@Injectable()`을 붙인다.

```typescript
// cats.service.ts
import { Injectable } from '@nestjs/common';

export interface Cat {
  id: number;
  name: string;
  age: number;
}

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [];
  private seq = 1;

  create(input: Omit<Cat, 'id'>): Cat {
    const cat: Cat = { id: this.seq++, ...input };
    this.cats.push(cat);
    return cat;
  }

  findAll(): Cat[] {
    return this.cats;
  }

  findOne(id: number): Cat | undefined {
    return this.cats.find((c) => c.id === id);
  }
}
```

컨트롤러는 생성자 주입으로 서비스를 받고, 파라미터 데코레이터로 요청 데이터를 꺼낸다. 숫자 경로 변수는 `ParseIntPipe`로 변환한다.

```typescript
// cats.controller.ts
import {
  Body, Controller, Get, HttpCode, NotFoundException,
  Param, ParseIntPipe, Post,
} from '@nestjs/common';
import { CatsService, Cat } from './cats.service';

class CreateCatDto {
  name: string;
  age: number;
}

@Controller('cats')
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateCatDto): Cat {
    return this.catsService.create(dto);
  }

  @Get()
  findAll(): Cat[] {
    return this.catsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Cat {
    const cat = this.catsService.findOne(id);
    if (!cat) throw new NotFoundException(`cat ${id} not found`);
    return cat;
  }
}
```

모듈이 둘을 등록하고, 루트 모듈이 이를 가져온 뒤 `main.ts`에서 부트스트랩한다.

```typescript
// cats.module.ts
import { Module } from '@nestjs/common';
import { CatsController } from './cats.controller';
import { CatsService } from './cats.service';

@Module({
  controllers: [CatsController],
  providers: [CatsService],
  exports: [CatsService],
})
export class CatsModule {}

// app.module.ts
import { Module } from '@nestjs/common';
import { CatsModule } from './cats/cats.module';

@Module({ imports: [CatsModule] })
export class AppModule {}

// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

## 실무에서 걸리는 지점

- **`emitDecoratorMetadata` 의존.** 생성자 타입 기반 주입은 TypeScript가 데코레이터 메타데이터를 내보내야 동작한다. `tsconfig`에서 `experimentalDecorators`·`emitDecoratorMetadata`가 꺼져 있거나, esbuild·SWC 같은 트랜스파일러가 메타데이터를 생략하면 `Nest can't resolve dependencies` 오류가 난다. 인터페이스 타입은 런타임에 사라지므로 토큰 주입이 필요하다.
- **모듈 경계를 넘는 주입 실패.** 다른 모듈의 프로바이더를 `exports`에 올리지 않고 주입하면 같은 오류가 발생한다. 흔한 우회가 프로바이더를 두 모듈에 중복 등록하는 것인데, 이 경우 인스턴스가 두 개 생겨 싱글턴 가정이 깨진다.
- **`@Res()` 직접 사용의 부작용.** 라이브러리 응답 객체를 주입하면 인터셉터·직렬화·`@HttpCode()`가 무력화되고, 응답을 수동으로 끝내지 않으면 요청이 걸린다. 쿠키나 헤더만 만지려면 `@Res({ passthrough: true })`를 쓰고 반환값은 프레임워크에 맡긴다.
- **요청 스코프의 전파.** `Scope.REQUEST` 프로바이더를 하나 주입하면 그것을 참조하는 컨트롤러와 상위 프로바이더까지 전부 요청 스코프로 승격된다. 요청마다 인스턴스 그래프를 새로 만들므로 지연 시간이 늘고, 무엇이 승격됐는지 코드에서 드러나지 않는다.
- **v11 라우트 와일드카드 문법.** Express 5 기반으로 바뀌면서 `'cats/*'` 형태가 아니라 `'cats/*splat'`처럼 이름 있는 와일드카드를 써야 한다. v10 예제를 그대로 옮기면 라우트 등록 시 예외가 난다.

## 관련 글

- [DI와 모듈 시스템](/notes/nestjs/di-modules/)
- [Pipes·검증·DTO](/notes/nestjs/pipes-validation-dto/)
- [Interceptors·Exception Filters·Middleware](/notes/nestjs/interceptors-filters-middleware/)
