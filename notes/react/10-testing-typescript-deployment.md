---
title: "테스트(Testing Library)·TypeScript·배포"
series: react
part: "최신과 운영"
order: 10
summary: "React 앱을 사용자 관점 테스트·정적 타입·프로덕션 빌드로 안정적으로 운영하는 기준을 정리한다."
tags: [React, Testing Library, Vitest, TypeScript, Vite]
sources: [https://react.dev/learn/typescript, https://testing-library.com/docs/react-testing-library/intro/, https://vitest.dev/guide/, https://vite.dev/guide/build]
updated: 2026-08-30
---

컴포넌트가 늘어나면 리팩터링 후 어디가 깨졌는지 눈으로 확인하는 방식은 한계에 이른다. props 이름을 바꿨는데 호출부 하나를 빠뜨리면 런타임에야 드러나고, 내부 구현에 묶인 테스트는 DOM 구조를 조금만 바꿔도 실패한다. 빌드 산출물과 환경 변수 처리를 모르면 개발 서버에서는 되던 것이 배포 후 동작하지 않는다. 이 세 문제를 각각 Testing Library, TypeScript, Vite 프로덕션 빌드가 맡는다.

## 핵심 개념

**Testing Library**는 사용자가 쓰는 방식으로 테스트한다는 원칙을 API로 강제한다. 컴포넌트 state에 접근하는 수단을 주지 않고, 렌더된 DOM을 접근성 기준으로 조회한다. 쿼리 우선순위는 `getByRole` → `getByLabelText` → `getByText` → `getByTestId` 순이다. `getBy*`는 없으면 즉시 예외, `queryBy*`는 `null` 반환, `findBy*`는 나타날 때까지 기다리는 Promise다. 상호작용은 `fireEvent`보다 `@testing-library/user-event`를 쓴다. 클릭 하나에도 pointerdown·focus·click이 브라우저 순서대로 발생한다. Spring의 `@WebMvcTest` + MockMvc처럼 HTTP 경계에서 검증하는 위치에 해당한다.

**Vitest**는 Vite 설정을 그대로 공유하는 테스트 러너다. alias·플러그인·환경 변수 처리가 테스트에도 동일하게 적용되어 Jest처럼 변환기를 따로 맞출 필요가 없다. DOM 테스트는 `environment: 'jsdom'`을 지정하고, watch 모드는 모듈 그래프로 영향받는 테스트만 다시 돌린다.

**TypeScript**는 `.tsx` 확장자로 JSX와 함께 쓰며 타입은 `@types/react`·`@types/react-dom`에서 온다. props는 인터페이스로 선언하고, 자식은 `React.ReactNode`, 이벤트 핸들러는 `React.MouseEvent<HTMLButtonElement>` 같은 제네릭 이벤트 타입을 쓴다. 훅은 초기값에서 추론하지만 `useState<User | null>(null)`처럼 추론이 안 되면 명시한다. `useReducer`의 액션을 판별 유니온으로 정의하면 `switch` 분기마다 payload가 좁혀진다. Java의 sealed interface + pattern matching switch에 대응한다.

**Vite 프로덕션 빌드**는 `vite build`가 Rollup 기반으로 트리 셰이킹·코드 분할·해시 파일명을 적용해 `dist/`에 정적 산출물을 만든다. 기본 타깃은 `baseline-widely-available`이며 구형 브라우저는 별도 플러그인으로 대응한다. 환경 변수는 `VITE_` 접두사가 붙은 것만 번들에 주입되고 `import.meta.env`로 읽는다.

| 구분 | 역할 | Spring/Java 대응 |
|---|---|---|
| Testing Library | 렌더 결과를 사용자 관점에서 검증 | MockMvc 기반 슬라이스 테스트 |
| Vitest | 러너·단언·모킹·커버리지 | JUnit 5 + Mockito |
| TypeScript | props·state·이벤트 정적 타입 | Java 제네릭·sealed interface |
| vite build | 번들·분할·해시·환경 변수 주입 | Gradle bootJar + 프로파일 |

## 코드

Vitest를 jsdom 환경으로 설정하고 jest-dom 매처를 전역 등록한다.

```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});

// src/test/setup.ts
import '@testing-library/jest-dom/vitest';
```

타입이 붙은 카운터 컴포넌트와 이를 사용자 관점에서 검증하는 테스트다. `role`과 접근 가능한 이름으로 버튼을 찾고, `userEvent`로 실제 클릭 순서를 재현한다.

```tsx
// Counter.tsx
import { useReducer } from 'react';

type Action = { type: 'increment' } | { type: 'reset'; to: number };

function reducer(count: number, action: Action): number {
  switch (action.type) {
    case 'increment': return count + 1;
    case 'reset': return action.to;
  }
}

interface CounterProps { initial?: number; label: string }

export function Counter({ initial = 0, label }: CounterProps) {
  const [count, dispatch] = useReducer(reducer, initial);
  return (
    <section aria-label={label}>
      <output>{count}</output>
      <button onClick={() => dispatch({ type: 'increment' })}>증가</button>
      <button onClick={() => dispatch({ type: 'reset', to: initial })}>초기화</button>
    </section>
  );
}

// Counter.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Counter } from './Counter';

it('클릭한 만큼 증가하고 초기화하면 초기값으로 돌아간다', async () => {
  const user = userEvent.setup();
  render(<Counter initial={3} label="카운터" />);

  await user.click(screen.getByRole('button', { name: '증가' }));
  await user.click(screen.getByRole('button', { name: '증가' }));
  expect(screen.getByRole('status')).toHaveTextContent('5');

  await user.click(screen.getByRole('button', { name: '초기화' }));
  expect(screen.getByRole('status')).toHaveTextContent('3');
});
```

비동기 데이터는 `findBy*`로 등장을 기다리고, 네트워크는 `vi.fn`으로 대체한다.

```tsx
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { UserCard } from './UserCard';

it('로딩 후 사용자 이름을 표시한다', async () => {
  const fetchUser = vi.fn().mockResolvedValue({ id: 1, name: '오진욱' });
  render(<UserCard id={1} fetchUser={fetchUser} />);

  expect(screen.getByText('불러오는 중')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: '오진욱' })).toBeInTheDocument();
  expect(fetchUser).toHaveBeenCalledWith(1);
});
```

## 실무에서 걸리는 지점

- **`getByTestId` 남용.** `data-testid`를 기본으로 쓰면 접근성 결함이 걸러지지 않고 마크업 변경마다 테스트를 고치게 된다. 다른 쿼리가 불가능할 때만 쓴다.
- **`act` 경고.** `userEvent`·`findBy*`·`waitFor`는 내부에서 `act`를 감싸므로 직접 호출할 일이 거의 없다. 경고가 남으면 `await`가 빠진 비동기 작업이 있다는 신호다. ==`findBy*` 기본 타임아웃은 1초다.==
- **Provider 의존.** `render`의 `wrapper` 옵션으로 Provider를 주입하는 `renderWithProviders`를 만든다. QueryClient는 테스트마다 새로 만들고 `retry: false`로 설정해야 캐시와 재시도가 테스트 간에 새지 않는다.
- **타입 검사와 번들의 분리.** ==Vite와 Vitest는 esbuild로 타입을 지우기만 하고 검사하지 않는다.== `tsc -b && vite build`처럼 CI에 검사 단계를 넣지 않으면 타입 오류가 있는 코드가 그대로 배포된다.
- **환경 변수와 `base` 경로.** ==`VITE_` 접두사가 붙은 값은 공개 번들에 노출되므로 비밀 키를 넣으면 안 된다.== 서브 경로 배포 시 `base`를 빠뜨리면 자산 요청이 404가 나고, SPA는 서버에서 모든 경로를 `index.html`로 fallback 시켜야 새로고침이 동작한다.
- **청크와 캐시.** ==`manualChunks`로 vendor를 분리하지 않으면 작은 수정에도 번들 해시가 바뀌어 캐시가 무효화된다.== 500kB 경고는 라우트 단위 `lazy` 분할이 안 되어 있다는 신호다.

## 관련 글

- [React 19 — Actions·use·Server Components](/notes/react/react19-actions-use-server-components/)
- [라우팅(React Router)과 코드 분할](/notes/react/routing-code-splitting/)
- [커스텀 훅과 데이터 페칭 (TanStack Query)](/notes/react/custom-hooks-data-fetching/)
