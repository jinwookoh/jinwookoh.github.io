---
title: "React란 — 컴포넌트·JSX·렌더링 모델"
series: react
part: "기초"
order: 1
summary: "React는 UI를 상태의 함수로 선언하고, 트리거·렌더·커밋 단계로 DOM을 갱신하는 라이브러리다"
tags: [React, JSX, Component, Rendering, Virtual DOM]
sources: [https://react.dev/learn/thinking-in-react, https://react.dev/learn/writing-markup-with-jsx, https://react.dev/learn/render-and-commit]
updated: 2026-08-30
---

브라우저 DOM을 직접 다루는 코드는 데이터가 바뀔 때마다 어느 노드를 찾아 어떤 속성을 고칠지 개발자가 일일이 기술해야 한다. 요소가 늘어나면 현재 DOM 상태를 추적하는 비용이 커지고 갱신 누락 버그가 늘어난다. React는 이 문제를 뒤집는다. 개발자는 "데이터가 이럴 때 화면은 이렇다"는 결과만 선언하고, 실제 DOM 조작은 라이브러리가 맡는다. 이 글은 그 선언의 단위인 컴포넌트, 선언을 적는 문법인 JSX, 그리고 선언이 실제 DOM에 반영되는 렌더링 모델을 정리한다.

## 핵심 개념

### 컴포넌트 — UI를 함수로 나눈다

React 컴포넌트는 입력(props)을 받아 UI 설명을 반환하는 순수한 JavaScript 함수다. 이름은 대문자로 시작해야 하며, 이 규칙으로 React가 일반 HTML 태그와 사용자 정의 컴포넌트를 구분한다. 공식 문서는 UI 설계를 다섯 단계로 제시한다. 목업을 컴포넌트 계층으로 쪼개고, 정적 버전을 먼저 만들고, 최소한의 상태를 찾아내고, 그 상태를 소유할 컴포넌트를 정하고, 마지막으로 역방향 데이터 흐름(자식이 부모 상태를 바꾸는 콜백)을 추가한다. 핵심은 "상태는 최소로, 나머지는 계산으로"라는 원칙이다. props로 받은 값, 다른 상태에서 유도 가능한 값, 시간이 지나도 변하지 않는 값은 상태가 아니다.

Spring 관점에서 보면 컴포넌트 트리는 빈 의존성 그래프와 닮았다. 다만 방향이 고정돼 있다. 데이터는 부모에서 자식으로만 흐르고(단방향 데이터 흐름), 자식은 콜백을 호출해 부모에게 변경을 요청한다. DI 컨테이너가 아니라 명시적인 인자 전달이라는 점이 다르다.

### JSX — JavaScript 안의 마크업

JSX는 JavaScript 표현식 안에 HTML과 유사한 마크업을 적는 확장 문법이다. 렌더링 로직과 마크업을 한 파일에 두는 이유는 둘이 항상 함께 바뀌기 때문이다. HTML과 다른 규칙이 몇 가지 있다. 컴포넌트는 반드시 하나의 루트 요소를 반환해야 하므로 여러 요소는 `<>...</>`(Fragment)로 감싼다. 모든 태그는 명시적으로 닫는다(`<img />`, `<li>...</li>`). 속성은 camelCase로 쓰고, `class`는 JavaScript 예약어이므로 `className`이 된다. 중괄호 `{}` 안에는 임의의 JavaScript 표현식을 넣을 수 있고, 속성값에도 같은 규칙이 적용된다. `style` 속성은 문자열이 아니라 객체를 받으므로 중괄호가 두 겹이 된다.

JSX는 빌드 단계에서 `jsx()` 함수 호출로 변환된다. 이 호출의 반환값은 DOM 노드가 아니라 "이런 요소를 그려 달라"는 가벼운 설명 객체(React element)다. Thymeleaf 템플릿이 서버에서 문자열로 렌더링되는 것과 달리, JSX는 타입 검사와 함께 컴파일되는 JavaScript 코드다.

### 렌더링 모델 — 트리거·렌더·커밋

React가 화면을 갱신하는 과정은 세 단계로 나뉜다.

| 단계 | 하는 일 | 발생 조건 |
|---|---|---|
| 트리거 | 렌더링 예약 | 최초 `createRoot().render()` 호출, 또는 상태 변경 |
| 렌더 | 컴포넌트 함수 호출, 반환값 계산 | 루트부터 시작하거나, 상태가 바뀐 컴포넌트와 그 하위 트리 |
| 커밋 | 이전 결과와 비교해 달라진 부분만 실제 DOM에 반영 | 렌더 결과에 차이가 있을 때 |

렌더 단계는 컴포넌트 함수를 호출하는 것 자체다. 그래서 컴포넌트는 순수해야 한다. 같은 입력이면 같은 출력을 내고, 호출 전에 존재하던 객체나 변수를 바꾸지 않아야 한다. React는 이 순수성을 전제로 렌더를 중단하거나 재시작하거나 여러 번 실행할 수 있다. 커밋 단계에서는 최초 렌더면 `appendChild()`로 전부 삽입하고, 재렌더면 렌더 사이의 차이만 최소한의 DOM 연산으로 적용한다. 따라서 부모가 재렌더돼도 자식의 출력이 같으면 해당 DOM은 건드리지 않는다. 커밋이 끝나면 브라우저가 화면을 다시 그린다.

## 코드

컴포넌트를 계층으로 나누고 props로 데이터를 내려보내는 정적 버전이다. 상태 없이 렌더링만 담당한다.

```tsx
type Product = { id: number; name: string; price: number; stocked: boolean };

function ProductRow({ product }: { product: Product }) {
  const name = product.stocked ? product.name : <span style={{ color: "red" }}>{product.name}</span>;
  return (
    <tr>
      <td>{name}</td>
      <td>{product.price.toLocaleString()}원</td>
    </tr>
  );
}

function ProductTable({ products }: { products: Product[] }) {
  return (
    <table>
      <thead>
        <tr><th>이름</th><th>가격</th></tr>
      </thead>
      <tbody>
        {products.map((p) => <ProductRow key={p.id} product={p} />)}
      </tbody>
    </table>
  );
}

export function FilterableProductTable({ products }: { products: Product[] }) {
  return (
    <>
      <h2 className="title">상품 목록</h2>
      <ProductTable products={products} />
    </>
  );
}
```

JSX 규칙을 한 번에 보여 주는 예다. 단일 루트, 자체 닫기 태그, camelCase 속성, 중괄호 표현식, 객체형 `style`을 사용한다.

```tsx
export function Profile({ name, avatarUrl, isOnline }: { name: string; avatarUrl: string; isOnline: boolean }) {
  const badgeStyle = { backgroundColor: isOnline ? "green" : "gray", borderRadius: 4 };
  return (
    <>
      <img src={avatarUrl} alt={`${name}의 프로필`} className="avatar" />
      <h1>{name}</h1>
      <span style={badgeStyle}>{isOnline ? "온라인" : "오프라인"}</span>
    </>
  );
}
```

최초 렌더를 트리거하는 진입점이다. `createRoot`가 DOM 노드를 React 트리의 루트로 등록하고, `render` 호출이 첫 렌더·커밋을 예약한다.

```tsx
import { createRoot } from "react-dom/client";
import { FilterableProductTable } from "./FilterableProductTable";

const products = [
  { id: 1, name: "사과", price: 3000, stocked: true },
  { id: 2, name: "배", price: 5000, stocked: false },
];

createRoot(document.getElementById("root")!).render(<FilterableProductTable products={products} />);
```

## 실무에서 걸리는 지점

- **렌더 중 부수 효과.** 렌더 단계에서 전역 변수를 바꾸거나 API를 호출하면 Strict Mode의 이중 호출이나 동시성 렌더의 재시작에서 두 번 실행된다. 부수 효과는 이벤트 핸들러나 `useEffect`로 옮긴다.
- **상태 중복.** 서버에서 받은 목록과 그 목록에서 필터링한 결과를 둘 다 상태로 두면 동기화 버그가 생긴다. 필터 조건만 상태로 두고 결과는 렌더 중에 계산한다.
- **`key` 누락 또는 인덱스 사용.** 배열을 렌더할 때 `key`가 없거나 배열 인덱스를 쓰면 정렬·삭제 시 React가 엉뚱한 DOM을 재사용해 입력값이 다른 행으로 옮겨 가는 문제가 생긴다. 데이터의 고유 식별자를 사용한다.
- **불필요한 재렌더 범위.** 상태를 트리 상단에 올릴수록 상태 변경 시 렌더되는 하위 트리가 넓어진다. 상태는 그것을 필요로 하는 가장 가까운 공통 조상에 둔다.
- **JSX 변환 설정.** TypeScript 5.x에서는 `tsconfig`의 `"jsx": "react-jsx"`로 두어야 파일마다 `import React`를 쓰지 않아도 된다. 구형 `"jsx": "react"` 설정은 React 17 이전 방식이다.

## 관련 글

- [Props·State·이벤트](/notes/react/props-state-events/)
- [useState·useEffect — 상태와 부수 효과](/notes/react/usestate-useeffect/)
- [useRef·useMemo·useCallback과 렌더링 성능](/notes/react/useref-usememo-usecallback-performance/)
