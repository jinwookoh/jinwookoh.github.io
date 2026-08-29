# 기술 노트 사이트 골격 + Java/Spring 시리즈 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `notes/<series>/*.md` 원고를 `docs/notes/` 정적 HTML로 빌드하는 Node 도구를 만들고, 첫 시리즈 Java/Spring 40편을 원본 102편에서 통합·재작성해 사이트에 올린다.

**Architecture:** 원고는 front matter가 있는 마크다운, 빌드는 `build/build.mjs` 하나가 로드→검증→렌더→쓰기를 순서대로 수행한다. 라이브러리 모듈(`build/lib/*.mjs`)은 순수 함수로 두어 `node --test`로 검증한다. 글 재작성은 매핑 파일 한 행 = 서브에이전트 1회로 수행하고, 5편 단위로 빌드·검증·커밋한다.

**Tech Stack:** Node 24 (ESM, `node:test`), `marked` (마크다운), `gray-matter` (front matter), `highlight.js` (코드 하이라이트), `js-yaml` (시리즈 메타). 사이트는 GitHub Pages `main`/`docs`.

**Spec:** `planning/specs/2026-08-29-study-notes-archive-design.md`

## Global Constraints

- 저장소: `/Users/jinwookoh/Project/jinwookoh.github.io`. 모든 경로는 이 저장소 루트 기준.
- 원본 위치: `/Users/jinwookoh/Project/Coupang/posts/study/` (읽기 전용. 절대 수정·삭제하지 않는다).
- 글 형식(스펙 3절): 1,500~2,500자(코드 제외), "~한다"체, 비유·구어체·이모지·시리즈 안내문 금지, 구조 = 한 줄 요약 → 왜 필요한가 → 핵심 개념 → 코드 1~3개(Spring Boot 3.x, Java 21) → 실무에서 걸리는 지점 → 관련 글.
- 금지 문자열: `smartlifen4n`, `coupang`, `쿠팡`, 이모지(U+1F300–U+1FAFF, U+2600–U+27BF).
- 내부 링크 형식: `/notes/<series>/<slug>/` 만 허용.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. 커밋 시 `-c user.name=jinwookoh -c user.email=jinwookoh@gmail.com`.
- 푸시는 하지 않는다 (사용자 승인 후 별도).
- `docs/index.html`·`docs/style.css`(프로필)는 Task 4에서 지정한 두 곳 외에는 손대지 않는다.

---

## 파일 구조

```
package.json                    # type: module, scripts.build / scripts.test
build/build.mjs                 # CLI 진입점: 로드→검증→렌더→docs/notes 쓰기
build/lib/load.mjs              # notes/ 스캔, front matter 파싱, 시리즈 메타 로드
build/lib/validate.mjs          # 필수 키·order 중복·글자 수·금지 문자열·내부 링크 검증
build/lib/render.mjs            # 마크다운→HTML, 페이지 템플릿 (notes index / series / post), sitemap
build/test/load.test.mjs
build/test/validate.test.mjs
build/test/render.test.mjs
build/test/fixtures/notes/demo/_series.yml
build/test/fixtures/notes/demo/01-hello.md
build/test/fixtures/notes/demo/02-world.md
docs/.nojekyll
docs/notes/notes.css            # 노트 전용 스타일 (프로필 토큰 재사용)
notes/java-spring/_series.yml
notes/java-spring/NN-<slug>.md  # 40편
planning/mapping/java-spring.md # 목표 글 ← 원본 파일 매핑 (40행)
planning/prompts/rewrite-post.md# 서브에이전트용 재작성 지시문 템플릿
```

---

### Task 1: Node 프로젝트 초기화 + 로더

**Files:**
- Create: `package.json`, `build/lib/load.mjs`, `build/test/load.test.mjs`, `build/test/fixtures/notes/demo/_series.yml`, `build/test/fixtures/notes/demo/01-hello.md`, `build/test/fixtures/notes/demo/02-world.md`, `.gitignore`

**Interfaces:**
- Produces: `loadSite(notesDir) → { series: Series[] }`
  - `Series = { slug, name, description, parts: string[], posts: Post[] }`
  - `Post = { slug, file, title, series, part, order, summary, tags: string[], sources: string[], updated: string, body: string }`
  - `posts`는 `order` 오름차순 정렬. `slug`는 파일명에서 `NN-` 접두를 뗀 값.

- [ ] **Step 1: package.json과 .gitignore 작성**

```json
{
  "name": "jinwookoh-notes",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build/build.mjs",
    "test": "node --test build/test/"
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "highlight.js": "^11.10.0",
    "js-yaml": "^4.1.0",
    "marked": "^14.1.0"
  }
}
```

`.gitignore`:
```
node_modules/
.playwright-mcp/
```

Run: `cd /Users/jinwookoh/Project/jinwookoh.github.io && npm install`
Expected: `node_modules/` 생성, `package-lock.json` 생성.

- [ ] **Step 2: 픽스처 작성**

`build/test/fixtures/notes/demo/_series.yml`:
```yaml
name: 데모 시리즈
description: 테스트용 시리즈.
parts:
  - 기초
  - 심화
```

`build/test/fixtures/notes/demo/01-hello.md`:
```markdown
---
title: "첫 글"
series: demo
part: "기초"
order: 1
summary: "첫 번째 데모 글."
tags: [Demo]
sources: [demo/a.md]
updated: 2026-08-29
---

첫 글의 본문이다. [둘째 글](/notes/demo/world/)을 참고한다.

```java
System.out.println("hi");
```
```

`build/test/fixtures/notes/demo/02-world.md`:
```markdown
---
title: "둘째 글"
series: demo
part: "심화"
order: 2
summary: "두 번째 데모 글."
tags: [Demo]
sources: [demo/b.md]
updated: 2026-08-29
---

둘째 글의 본문이다.
```

- [ ] **Step 3: 실패하는 테스트 작성**

`build/test/load.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSite } from '../lib/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const notesDir = path.join(here, 'fixtures/notes');

test('loadSite reads series meta and posts sorted by order', () => {
  const site = loadSite(notesDir);
  assert.equal(site.series.length, 1);
  const demo = site.series[0];
  assert.equal(demo.slug, 'demo');
  assert.equal(demo.name, '데모 시리즈');
  assert.deepEqual(demo.parts, ['기초', '심화']);
  assert.deepEqual(demo.posts.map(p => p.slug), ['hello', 'world']);
  assert.equal(demo.posts[0].title, '첫 글');
  assert.equal(demo.posts[0].order, 1);
  assert.match(demo.posts[0].body, /첫 글의 본문/);
});

test('loadSite attaches file path and series slug to each post', () => {
  const site = loadSite(notesDir);
  const p = site.series[0].posts[1];
  assert.equal(p.series, 'demo');
  assert.match(p.file, /02-world\.md$/);
});
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/load.mjs'`

- [ ] **Step 5: 로더 구현**

`build/lib/load.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

export function loadSite(notesDir) {
  const seriesDirs = fs.readdirSync(notesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();
  const series = seriesDirs.map(slug => loadSeries(notesDir, slug));
  return { series };
}

function loadSeries(notesDir, slug) {
  const dir = path.join(notesDir, slug);
  const metaPath = path.join(dir, '_series.yml');
  const meta = fs.existsSync(metaPath) ? yaml.load(fs.readFileSync(metaPath, 'utf8')) : {};
  const posts = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => loadPost(path.join(dir, f), slug))
    .sort((a, b) => a.order - b.order);
  return {
    slug,
    name: meta.name ?? slug,
    description: meta.description ?? '',
    parts: meta.parts ?? [],
    posts,
  };
}

function loadPost(file, seriesSlug) {
  const raw = fs.readFileSync(file, 'utf8');
  const { data, content } = matter(raw);
  const base = path.basename(file, '.md');
  const slug = base.replace(/^\d+-/, '');
  return {
    slug,
    file,
    title: data.title ?? '',
    series: data.series ?? seriesSlug,
    part: data.part ?? '',
    order: Number(data.order ?? 0),
    summary: data.summary ?? '',
    tags: data.tags ?? [],
    sources: data.sources ?? [],
    updated: data.updated ? String(data.updated).slice(0, 10) : '',
    body: content.trim(),
  };
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test`
Expected: `# pass 2`

- [ ] **Step 7: 커밋**

```bash
git add package.json package-lock.json .gitignore build/
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "feat(build): Node 프로젝트 초기화 + notes 로더

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 검증기

**Files:**
- Create: `build/lib/validate.mjs`, `build/test/validate.test.mjs`

**Interfaces:**
- Consumes: `Series`, `Post` (Task 1)
- Produces: `validateSite(site) → { errors: string[], warnings: string[] }`
  - `countBodyChars(body) → number` (코드 블록·공백 제외 글자 수, 테스트에서 직접 호출)

- [ ] **Step 1: 실패하는 테스트 작성**

`build/test/validate.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSite, countBodyChars } from '../lib/validate.mjs';

const post = (over = {}) => ({
  slug: 'a', file: 'notes/demo/01-a.md', title: 'A', series: 'demo', part: '기초', order: 1,
  summary: 's', tags: ['x'], sources: ['demo/a.md'], updated: '2026-08-29',
  body: '본문 '.repeat(400), ...over,
});
const site = (posts) => ({ series: [{ slug: 'demo', name: 'D', description: '', parts: ['기초'], posts }] });

test('countBodyChars ignores fenced code and whitespace', () => {
  const body = '가나다 라마\n\n```java\nint x = 1;\n```\n\n바사';
  assert.equal(countBodyChars(body), 7);
});

test('missing required front matter is an error', () => {
  const r = validateSite(site([post({ summary: '' })]));
  assert.ok(r.errors.some(e => e.includes('summary')));
});

test('duplicate order within a series is an error', () => {
  const r = validateSite(site([post(), post({ slug: 'b', file: 'notes/demo/02-b.md' })]));
  assert.ok(r.errors.some(e => e.includes('order')));
});

test('unknown part is an error', () => {
  const r = validateSite(site([post({ part: '없는파트' })]));
  assert.ok(r.errors.some(e => e.includes('part')));
});

test('forbidden strings and emoji are errors', () => {
  const r1 = validateSite(site([post({ body: '본문 '.repeat(400) + ' https://smartlifen4n.com/x' })]));
  assert.ok(r1.errors.some(e => e.includes('smartlifen4n')));
  const r2 = validateSite(site([post({ body: '본문 '.repeat(400) + ' 좋다 🚀' })]));
  assert.ok(r2.errors.some(e => e.includes('이모지')));
});

test('broken internal link is an error, valid one passes', () => {
  const bad = validateSite(site([post({ body: '본문 '.repeat(400) + ' [x](/notes/demo/none/)' })]));
  assert.ok(bad.errors.some(e => e.includes('/notes/demo/none/')));
  const ok = validateSite(site([post(), post({ slug: 'b', file: 'notes/demo/02-b.md', order: 2, body: '본문 '.repeat(400) + ' [a](/notes/demo/a/)' })]));
  assert.equal(ok.errors.length, 0);
});

test('body length outside 1200..3000 is a warning, not an error', () => {
  const r = validateSite(site([post({ body: '짧다' })]));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some(w => w.includes('글자')));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/validate.mjs'`

- [ ] **Step 3: 검증기 구현**

`build/lib/validate.mjs`:
```js
const REQUIRED = ['title', 'series', 'part', 'order', 'summary', 'updated'];
const FORBIDDEN = [/smartlifen4n/i, /coupang/i, /쿠팡/];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const LINK = /\]\((\/notes\/[^)\s]+)\)/g;
const MIN = 1200, MAX = 3000;

export function countBodyChars(body) {
  return body.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, '').length;
}

export function validateSite(site) {
  const errors = [], warnings = [];
  const known = new Set();
  for (const s of site.series) for (const p of s.posts) known.add(`/notes/${s.slug}/${p.slug}/`);

  for (const s of site.series) {
    const seen = new Map();
    for (const p of s.posts) {
      const at = `${p.file}`;
      for (const k of REQUIRED) {
        const v = p[k];
        if (v === undefined || v === '' || Number.isNaN(v)) errors.push(`${at}: front matter '${k}' 누락`);
      }
      if (seen.has(p.order)) errors.push(`${at}: order ${p.order} 중복 (${seen.get(p.order)})`);
      seen.set(p.order, p.file);
      if (s.parts.length && !s.parts.includes(p.part)) errors.push(`${at}: part '${p.part}' 가 _series.yml parts 에 없음`);
      for (const re of FORBIDDEN) if (re.test(p.body) || re.test(p.title)) errors.push(`${at}: 금지 문자열 ${re.source}`);
      if (EMOJI.test(p.body) || EMOJI.test(p.title)) errors.push(`${at}: 이모지 포함`);
      for (const m of p.body.matchAll(LINK)) {
        const href = m[1].endsWith('/') ? m[1] : m[1] + '/';
        if (!known.has(href)) errors.push(`${at}: 깨진 내부 링크 ${m[1]}`);
      }
      const n = countBodyChars(p.body);
      if (n < MIN || n > MAX) warnings.push(`${at}: 본문 ${n}글자 (권장 ${MIN}~${MAX})`);
    }
  }
  return { errors, warnings };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: `# pass 9` (Task 1의 2개 + 7개)

- [ ] **Step 5: 커밋**

```bash
git add build/lib/validate.mjs build/test/validate.test.mjs
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "feat(build): 원고 검증기 (필수 키·order·part·금지 문자열·내부 링크·글자 수)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 렌더러 + 빌드 CLI + 노트 스타일

**Files:**
- Create: `build/lib/render.mjs`, `build/test/render.test.mjs`, `build/build.mjs`, `docs/notes/notes.css`, `docs/.nojekyll`

**Interfaces:**
- Consumes: `loadSite`, `validateSite`
- Produces:
  - `renderMarkdown(md) → string` (highlight.js 적용 HTML)
  - `renderPostPage({ site, series, post, prev, next }) → string`
  - `renderSeriesPage({ site, series }) → string`
  - `renderNotesIndex({ site }) → string`
  - `renderSitemap({ site, baseUrl }) → string`
  - CLI: `node build/build.mjs [--notes notes] [--out docs/notes]` — 검증 에러 시 exit 1, 경고는 stderr 출력 후 진행.

- [ ] **Step 1: 실패하는 테스트 작성**

`build/test/render.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSite } from '../lib/load.mjs';
import { renderMarkdown, renderPostPage, renderSeriesPage, renderNotesIndex, renderSitemap } from '../lib/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = loadSite(path.join(here, 'fixtures/notes'));
const series = site.series[0];

test('renderMarkdown highlights fenced code', () => {
  const html = renderMarkdown('```java\nint x = 1;\n```');
  assert.match(html, /<pre><code class="hljs language-java">/);
  assert.match(html, /hljs-/);
});

test('post page has title, breadcrumb, summary, prev/next', () => {
  const html = renderPostPage({ site, series, post: series.posts[0], prev: null, next: series.posts[1] });
  assert.match(html, /<title>첫 글 · 데모 시리즈<\/title>/);
  assert.match(html, /href="\/notes\/demo\/">데모 시리즈</);
  assert.match(html, /<meta name="description" content="첫 번째 데모 글\.">/);
  assert.match(html, /href="\/notes\/demo\/world\/"[^>]*>[\s\S]*둘째 글/);
  assert.doesNotMatch(html, /class="prev"/);
});

test('series page groups posts by part in order', () => {
  const html = renderSeriesPage({ site, series });
  const i기초 = html.indexOf('기초'), i심화 = html.indexOf('심화');
  assert.ok(i기초 > 0 && i심화 > i기초);
  assert.match(html, /href="\/notes\/demo\/hello\/"/);
});

test('notes index lists series with post count', () => {
  const html = renderNotesIndex({ site });
  assert.match(html, /데모 시리즈/);
  assert.match(html, /2편/);
});

test('sitemap lists index, series and posts', () => {
  const xml = renderSitemap({ site, baseUrl: 'https://jinwookoh.github.io' });
  assert.match(xml, /<loc>https:\/\/jinwookoh\.github\.io\/notes\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/jinwookoh\.github\.io\/notes\/demo\/hello\/<\/loc>/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/render.mjs'`

- [ ] **Step 3: 렌더러 구현**

`build/lib/render.mjs`:
```js
import { marked } from 'marked';
import hljs from 'highlight.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const l = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const out = hljs.highlight(text, { language: l }).value;
  return `<pre><code class="hljs language-${l}">${out}</code></pre>\n`;
};
marked.use({ renderer, gfm: true });

export function renderMarkdown(md) {
  return marked.parse(md);
}

function layout({ title, description, url, body, crumbs = [] }) {
  const crumbHtml = crumbs.length
    ? `<nav class="crumbs">${crumbs.map(c => c.href ? `<a href="${c.href}">${esc(c.text)}</a>` : `<span>${esc(c.text)}</span>`).join('<span class="sep">›</span>')}</nav>`
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://jinwookoh.github.io${url}">
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
  <link rel="stylesheet" href="/notes/notes.css?v=1">
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/">오진욱</a><a class="notes-link" href="/notes/">Notes</a></div></header>
<main class="sheet">
  <div class="wrap">
    ${crumbHtml}
    ${body}
  </div>
</main>
<footer class="bottom"><div class="wrap">© 2026 Jinwook Oh</div></footer>
</body>
</html>
`;
}

export function renderPostPage({ site, series, post, prev, next }) {
  const url = `/notes/${series.slug}/${post.slug}/`;
  const nav = `<nav class="pager">
  ${prev ? `<a class="prev" href="/notes/${series.slug}/${prev.slug}/"><small>이전</small>${esc(prev.title)}</a>` : '<span></span>'}
  ${next ? `<a class="next" href="/notes/${series.slug}/${next.slug}/"><small>다음</small>${esc(next.title)}</a>` : '<span></span>'}
</nav>`;
  const body = `<article class="post">
  <p class="part">${esc(series.name)} · ${esc(post.part)}</p>
  <h1>${esc(post.title)}</h1>
  <p class="summary">${esc(post.summary)}</p>
  <div class="content">
${renderMarkdown(post.body)}
  </div>
  <p class="meta">갱신 ${esc(post.updated)}${post.tags.length ? ' · ' + post.tags.map(esc).join(', ') : ''}</p>
</article>
${nav}`;
  return layout({
    title: `${post.title} · ${series.name}`,
    description: post.summary,
    url,
    body,
    crumbs: [{ text: 'Notes', href: '/notes/' }, { text: series.name, href: `/notes/${series.slug}/` }, { text: post.title }],
  });
}

export function renderSeriesPage({ site, series }) {
  const parts = series.parts.length ? series.parts : [...new Set(series.posts.map(p => p.part))];
  const sections = parts.map(part => {
    const items = series.posts.filter(p => p.part === part)
      .map(p => `<li><a href="/notes/${series.slug}/${p.slug}/"><span class="n">${p.order}</span><span class="t">${esc(p.title)}</span><span class="s">${esc(p.summary)}</span></a></li>`)
      .join('\n');
    return `<section class="part-group"><h2>${esc(part)}</h2><ol class="toc">${items}</ol></section>`;
  }).join('\n');
  const body = `<header class="series-head"><h1>${esc(series.name)}</h1><p>${esc(series.description)}</p><p class="count">${series.posts.length}편</p></header>\n${sections}`;
  return layout({
    title: `${series.name} · Notes`,
    description: series.description,
    url: `/notes/${series.slug}/`,
    body,
    crumbs: [{ text: 'Notes', href: '/notes/' }, { text: series.name }],
  });
}

export function renderNotesIndex({ site }) {
  const cards = site.series.map(s => `<li><a href="/notes/${s.slug}/"><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p><span class="count">${s.posts.length}편</span></a></li>`).join('\n');
  const body = `<header class="series-head"><h1>Notes</h1><p>주제별로 정리한 기술 노트.</p></header>\n<ul class="series-cards">${cards}</ul>`;
  return layout({ title: 'Notes · 오진욱', description: '주제별 기술 노트 아카이브.', url: '/notes/', body });
}

export function renderSitemap({ site, baseUrl }) {
  const urls = ['/', '/notes/'];
  for (const s of site.series) {
    urls.push(`/notes/${s.slug}/`);
    for (const p of s.posts) urls.push(`/notes/${s.slug}/${p.slug}/`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: `# pass 14`

- [ ] **Step 5: 빌드 CLI 작성**

`build/build.mjs`:
```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from './lib/load.mjs';
import { validateSite } from './lib/validate.mjs';
import { renderPostPage, renderSeriesPage, renderNotesIndex, renderSitemap } from './lib/render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const notesDir = path.resolve(root, opt('--notes', 'notes'));
const outDir = path.resolve(root, opt('--out', 'docs/notes'));
const BASE = 'https://jinwookoh.github.io';

const site = loadSite(notesDir);
const { errors, warnings } = validateSite(site);
for (const w of warnings) console.error('WARN', w);
if (errors.length) {
  for (const e of errors) console.error('ERROR', e);
  console.error(`\n${errors.length} error(s). 빌드 중단.`);
  process.exit(1);
}

// docs/notes 안에서 notes.css 만 보존하고 나머지는 재생성
const keep = new Set(['notes.css']);
if (fs.existsSync(outDir)) {
  for (const name of fs.readdirSync(outDir)) {
    if (!keep.has(name)) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
}
fs.mkdirSync(outDir, { recursive: true });

const write = (rel, html) => {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
};

write('index.html', renderNotesIndex({ site }));
let count = 0;
for (const series of site.series) {
  write(path.join(series.slug, 'index.html'), renderSeriesPage({ site, series }));
  series.posts.forEach((post, i) => {
    const prev = series.posts[i - 1] ?? null;
    const next = series.posts[i + 1] ?? null;
    write(path.join(series.slug, post.slug, 'index.html'), renderPostPage({ site, series, post, prev, next }));
    count++;
  });
}
fs.writeFileSync(path.join(root, 'docs', 'sitemap.xml'), renderSitemap({ site, baseUrl: BASE }));
console.log(`built ${site.series.length} series, ${count} posts → ${path.relative(root, outDir)}`);
```

- [ ] **Step 6: 노트 스타일 작성**

`docs/notes/notes.css` (프로필 `docs/style.css`의 토큰과 동일 값 사용):
```css
:root { --page:#e9ecef; --sheet:#fff; --text:#1a1f2b; --muted:#5b6472; --line:#d9dee5; --navy:#1e3a5f; --accent:#1e3a5f; --tag:#f1f4f8; --code:#f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --page:#0f1216; --sheet:#171b21; --text:#e6e9ee; --muted:#9aa3b0; --line:#2a313b; --navy:#8fb3e0; --accent:#8fb3e0; --tag:#222831; --code:#0d1117; }
}
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:"Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif; background:var(--page); color:var(--text); line-height:1.7; word-break:keep-all; -webkit-font-smoothing:antialiased; padding:40px 16px 64px; }
@media (max-width:640px) { body { padding:0; } }
a { color:var(--accent); text-decoration:none; }
.wrap { max-width:860px; margin:0 auto; padding:0 56px; }
@media (max-width:640px) { .wrap { padding:0 24px; } }
.top, .sheet, .bottom { background:var(--sheet); max-width:860px; margin:0 auto; border-left:1px solid var(--line); border-right:1px solid var(--line); }
.top { border-top:1px solid var(--line); border-radius:4px 4px 0 0; border-bottom:3px solid var(--navy); }
.top .wrap { display:flex; justify-content:space-between; align-items:center; height:56px; }
.top .brand { font-weight:800; color:var(--navy); }
.top .notes-link { font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.sheet { padding:36px 0 48px; }
.bottom { border-bottom:1px solid var(--line); border-radius:0 0 4px 4px; padding:20px 0 28px; color:var(--muted); font-size:12.5px; box-shadow:0 12px 32px -12px rgba(0,0,0,.18); }
.crumbs { font-size:13px; color:var(--muted); margin-bottom:24px; }
.crumbs .sep { margin:0 8px; }
.series-head h1, .post h1 { font-size:30px; font-weight:800; color:var(--navy); letter-spacing:-.01em; line-height:1.25; }
.series-head p { color:var(--muted); margin-top:8px; }
.series-head .count { font-size:13px; }
.part-group { margin-top:32px; }
.part-group h2 { font-size:13px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--navy); margin-bottom:10px; display:flex; align-items:center; gap:12px; }
.part-group h2::after { content:""; flex:1; height:1px; background:var(--line); }
.toc { list-style:none; }
.toc li a { display:grid; grid-template-columns:32px 1fr; gap:2px 12px; padding:10px 0; border-bottom:1px dotted var(--line); color:var(--text); }
.toc .n { color:var(--muted); font-size:13px; grid-row:1 / span 2; padding-top:2px; }
.toc .t { font-weight:600; }
.toc .s { font-size:13.5px; color:var(--muted); }
.series-cards { list-style:none; display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:28px; }
@media (max-width:640px) { .series-cards { grid-template-columns:1fr; } }
.series-cards a { display:block; border:1px solid var(--line); padding:18px; color:var(--text); height:100%; }
.series-cards h2 { font-size:16px; font-weight:800; color:var(--navy); margin-bottom:6px; }
.series-cards p { font-size:13.5px; color:var(--muted); }
.series-cards .count { display:inline-block; margin-top:10px; font-size:12px; color:var(--muted); }
.post .part { font-size:13px; color:var(--muted); letter-spacing:.06em; margin-bottom:8px; }
.post .summary { font-size:16px; color:var(--muted); margin:14px 0 28px; padding-bottom:20px; border-bottom:1px solid var(--line); }
.content { font-size:16px; }
.content h2 { font-size:20px; font-weight:800; margin:36px 0 12px; color:var(--navy); }
.content h3 { font-size:16.5px; font-weight:700; margin:24px 0 8px; }
.content p { margin:0 0 14px; }
.content ul, .content ol { padding-left:22px; margin:0 0 14px; }
.content li { margin-bottom:4px; }
.content code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; background:var(--tag); padding:1px 5px; border-radius:3px; }
.content pre { background:var(--code); border:1px solid var(--line); border-radius:4px; padding:14px 16px; overflow-x:auto; margin:0 0 18px; }
.content pre code { background:none; padding:0; font-size:13.5px; line-height:1.6; }
.content table { border-collapse:collapse; width:100%; margin:0 0 18px; font-size:14.5px; display:block; overflow-x:auto; }
.content th, .content td { border:1px solid var(--line); padding:7px 10px; text-align:left; }
.content th { background:var(--tag); }
.content blockquote { border-left:3px solid var(--navy); padding:4px 14px; color:var(--muted); margin:0 0 14px; }
.post .meta { margin-top:32px; font-size:13px; color:var(--muted); }
.pager { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:28px; padding-top:20px; border-top:1px solid var(--line); }
.pager a { display:block; color:var(--text); font-weight:600; font-size:14.5px; }
.pager a small { display:block; font-weight:400; color:var(--muted); font-size:12px; }
.pager .next { text-align:right; }
/* highlight.js — github light / dark */
.hljs-comment,.hljs-quote{color:#6a737d}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#d73a49}.hljs-string,.hljs-attr{color:#032f62}.hljs-title,.hljs-name,.hljs-section{color:#6f42c1}.hljs-number,.hljs-literal{color:#005cc5}.hljs-built_in,.hljs-variable{color:#e36209}.hljs-meta{color:#22863a}
@media (prefers-color-scheme: dark) {
  .hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#ff7b72}.hljs-string,.hljs-attr{color:#a5d6ff}.hljs-title,.hljs-name,.hljs-section{color:#d2a8ff}.hljs-number,.hljs-literal{color:#79c0ff}.hljs-built_in,.hljs-variable{color:#ffa657}.hljs-meta{color:#7ee787}
}
```

`docs/.nojekyll`: 빈 파일 (`touch docs/.nojekyll`).

- [ ] **Step 7: 픽스처로 빌드 스모크 테스트**

Run: `node build/build.mjs --notes build/test/fixtures/notes --out /tmp/notes-smoke && ls -R /tmp/notes-smoke | head -20 && rm -rf /tmp/notes-smoke && git checkout docs/sitemap.xml 2>/dev/null; rm -f docs/sitemap.xml`
Expected: `built 1 series, 2 posts`, `demo/hello/index.html`·`demo/world/index.html`·`index.html` 존재. (sitemap은 픽스처 기준이라 삭제.)

- [ ] **Step 8: 커밋**

```bash
git add build/ docs/notes/notes.css docs/.nojekyll
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "feat(build): 렌더러·빌드 CLI·노트 스타일

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 프로필 페이지에 Notes 진입점 연결

**Files:**
- Modify: `docs/index.html` — `<nav class="nav">` 안의 `<ul>` (현재 F 디자인에서는 CSS로 숨겨져 있음)과 `<footer>`의 "Coming soon" 블록, 두 곳만.
- Modify: `docs/style.css` — `.nav { display: none; }` 한 줄을 헤더용 링크 표시로 교체.

- [ ] **Step 1: 푸터 교체**

`docs/index.html`에서 아래 블록을

```html
    <span class="soon">Coming soon</span>
    <p>Spring · PostgreSQL · Redis · Kafka · Elasticsearch · Spring Batch 등 학습 시리즈 300여 편을 이곳에 아카이브할 예정입니다.</p>
```

다음으로 교체:

```html
    <a class="soon" href="/notes/">Notes →</a>
    <p>Java/Spring · Kafka · Redis · PostgreSQL · Elasticsearch 등 주제별로 정리한 기술 노트.</p>
```

- [ ] **Step 2: 상단 내비를 Notes 링크 하나로 교체**

`docs/index.html`의 `<nav class="nav">…</nav>` 전체를 다음으로 교체:

```html
<nav class="nav">
  <div class="wrap"><a class="brand" href="/">오진욱</a><a class="notes-link" href="/notes/">Notes</a></div>
</nav>
```

`docs/style.css`에서 `.nav { display: none; }` 를 다음으로 교체:

```css
.nav { background: var(--sheet); max-width: 860px; margin: 0 auto; border: 1px solid var(--line); border-bottom: 0; border-radius: 4px 4px 0 0; }
.nav .wrap { display: flex; justify-content: space-between; align-items: center; height: 52px; }
.nav .brand { font-weight: 800; color: var(--navy); }
.nav .notes-link { font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
```

그리고 `.hero { border-top: 1px solid var(--line); border-radius: 4px 4px 0 0; }` 를 `.hero { border-radius: 0; }` 로 교체 (내비가 위에 붙으므로).

- [ ] **Step 3: 육안 확인**

Run: `cd docs && python3 -m http.server 8765 &` 후 브라우저(Playwright 또는 사용자 Chrome)로 `http://localhost:8765/` 확인.
Expected: 시트 맨 위에 "오진욱 | NOTES" 한 줄, 푸터에 "Notes →" 링크. 모바일 폭에서도 깨지지 않음.

- [ ] **Step 4: 커밋**

```bash
git add docs/index.html docs/style.css
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "feat(profile): Notes 진입점 (상단 내비·푸터)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Java/Spring 매핑 파일 + 시리즈 메타 + 재작성 지시문

**Files:**
- Create: `planning/mapping/java-spring.md`, `notes/java-spring/_series.yml`, `planning/prompts/rewrite-post.md`

**Interfaces:**
- Produces: 매핑 표 (order | slug | title | part | sources). Task 6~13이 이 표의 행을 그대로 서브에이전트 입력으로 쓴다.

- [ ] **Step 1: 시리즈 메타**

`notes/java-spring/_series.yml`:
```yaml
name: Java / Spring
description: 자바 언어 기초부터 Spring Boot 3 기반 백엔드의 코어·웹·데이터·운영까지.
parts:
  - 자바 기초·모던 자바
  - Spring 코어
  - Web MVC
  - 데이터
  - 운영·통합
```

- [ ] **Step 2: 매핑 파일**

`planning/mapping/java-spring.md` — 스펙 2절 목차를 표로 옮긴다. 원본 경로는 `/Users/jinwookoh/Project/Coupang/posts/study/` 기준 상대 경로. `spring/N` 은 Task 1에서 확인한 실제 파일명으로 적는다(아래 표 그대로 사용).

```markdown
# java-spring 매핑 (40편)

S = spring/ 폴더, R = 루트(posts/study/ 바로 아래), 날짜 접두는 실제 파일명 그대로.

| order | slug | title | part | sources |
|---|---|---|---|---|
| 1 | java-overview-oop | 자바 백엔드 개관 — JVM·객체와 클래스·OOP 4기둥 | 자바 기초·모던 자바 | S/2026-05-16-java-as-backend-standard.md, S/2026-05-16-java-object-and-class.md, R/2026-05-03-oop-principles.md |
| 2 | interface-polymorphism-solid | 인터페이스·다형성·SOLID | 자바 기초·모던 자바 | S/2026-05-16-java-interface-and-polymorphism.md, R/2026-05-03-solid-principles.md |
| 3 | collections-generics-optional | 컬렉션·제네릭·Optional | 자바 기초·모던 자바 | S/2026-05-17-java-collections.md, S/2026-05-17-java-generics.md, S/2026-05-17-java-optional.md |
| 4 | exception-handling | 예외 처리 | 자바 기초·모던 자바 | S/2026-05-17-java-exception-handling.md |
| 5 | lambda-functional-stream | 람다·함수형 인터페이스·Stream | 자바 기초·모던 자바 | S/2026-05-17-java-stream-lambda.md, R/2026-05-03-java-fp-lambda.md, R/2026-05-03-java-fp-functional-interfaces.md, R/2026-05-03-java-fp-stream.md, R/2026-05-03-java-fp-basics.md |
| 6 | modern-java | Modern Java 9~21 핵심 | 자바 기초·모던 자바 | R/2026-05-03-java-fp-modern.md, R/2026-05-03-java-fp-virtual-threads.md |
| 7 | virtual-thread-basics | Virtual Thread — 원리·API·Pinning | 자바 기초·모던 자바 | R/2026-05-03-vt-concurrency-basics.md, R/2026-05-03-vt-virtual-thread.md, R/2026-05-03-vt-api.md, R/2026-05-03-vt-pinning.md |
| 8 | virtual-thread-practice | Virtual Thread — 실전·Spring Boot·Structured Concurrency | 자바 기초·모던 자바 | R/2026-05-03-vt-patterns.md, R/2026-05-03-vt-performance.md, R/2026-05-03-vt-spring-boot.md, R/2026-05-03-vt-structured-concurrency.md |
| 9 | design-patterns-creational-structural | 디자인 패턴 — 생성·구조 | 자바 기초·모던 자바 | R/2026-05-03-design-patterns-creational.md, R/2026-05-03-design-patterns-structural.md |
| 10 | design-patterns-behavioral | 디자인 패턴 — 행위·조합 | 자바 기초·모던 자바 | R/2026-05-03-design-patterns-behavioral.md, R/2026-05-03-design-patterns-combinations.md |
| 11 | build-and-project-setup | 빌드·프로젝트 구성 — Maven/Gradle·start.spring.io·Profiles | Spring 코어 | S/2026-05-16-java-maven-gradle.md, S/2026-05-16-spring-initializr-first-project.md, S/2026-05-17-application-yml-profiles.md |
| 12 | spring-framework-boot-autoconfig | Spring Framework와 Boot 자동 구성 | Spring 코어 | S/2026-05-16-spring-framework-intro.md, S/2026-05-26-spring-boot-auto-configuration.md, R/2026-05-02-spring-boot-basics.md |
| 13 | ioc-di-application-context | IoC/DI와 ApplicationContext — Bean이란 | Spring 코어 | S/2026-05-16-spring-first-bean-hello.md, S/2026-05-16-why-dependency-injection.md, S/2026-05-16-what-is-spring-bean.md, S/2026-05-16-spring-application-context.md |
| 14 | bean-registration-injection | Bean 등록과 주입 — 어노테이션·@Component·@Configuration | Spring 코어 | S/2026-05-16-java-annotation.md, S/2026-05-16-component-autowired.md, S/2026-05-16-java-config-bean-annotation.md |
| 15 | bean-scope-lifecycle | Bean Scope와 생명주기 | Spring 코어 | S/2026-05-16-bean-scope.md, S/2026-05-16-bean-lifecycle.md |
| 16 | aop-spel | AOP와 SpEL | Spring 코어 | S/2026-05-16-spring-expression-language.md, S/2026-05-16-aop-cross-cutting-concerns.md, S/2026-05-16-spring-aspect-first-aop.md |
| 17 | layered-architecture | 계층 설계 — 서비스 레이어 분리 | Spring 코어 | S/2026-05-26-layered-architecture-service-layer.md |
| 18 | dispatcher-servlet-filter-interceptor | 요청 처리 흐름 — DispatcherServlet·Filter·Interceptor | Web MVC | S/2026-05-16-dispatcher-servlet.md, S/2026-05-17-filter-vs-interceptor.md |
| 19 | controller-request-binding | Controller와 요청 바인딩 | Web MVC | S/2026-05-16-controller-requestmapping.md, S/2026-05-16-restcontroller-json-response.md, S/2026-05-16-request-parameters.md |
| 20 | argument-resolver-upload-paging | ArgumentResolver·파일 업로드·페이징 | Web MVC | S/2026-05-17-argument-resolver.md, S/2026-05-17-file-upload.md, R/2026-05-02-spring-mvc-features.md |
| 21 | exception-handling-validation | 예외 처리와 검증 — @ControllerAdvice·Bean Validation | Web MVC | S/2026-05-16-exception-handler-controlleradvice.md, S/2026-05-16-bean-validation.md, S/2026-05-16-custom-validator.md |
| 22 | cors-security-oauth2-jwt | CORS와 Spring Security — OAuth2·JWT | Web MVC | S/2026-05-17-cors-configuration.md, S/2026-05-17-spring-security-basics.md, R/2026-05-02-spring-security.md |
| 23 | openapi-docs | API 문서화 — Springdoc OpenAPI | Web MVC | S/2026-05-17-springdoc-openapi-swagger.md, R/2026-05-02-spring-openapi-ai.md |
| 24 | jdbc-jdbctemplate | JDBC·DataSource·JdbcTemplate | 데이터 | S/2026-05-16-jdbc-datasource.md, S/2026-05-16-jdbc-template.md |
| 25 | transactional-locking | @Transactional 원리와 낙관/비관 락 | 데이터 | S/2026-05-16-transactional-annotation.md, S/2026-05-26-jpa-optimistic-pessimistic-lock.md |
| 26 | jpa-hibernate-spring-data | JPA·Hibernate·Spring Data JPA — Entity와 Repository | 데이터 | S/2026-05-16-jpa-hibernate-spring-data.md, S/2026-05-16-entity-repository.md, R/2026-05-02-spring-data-jpa.md |
| 27 | jpa-relations-n-plus-1 | 연관관계·N+1·값 객체 | 데이터 | S/2026-05-17-jpa-relations.md, S/2026-05-17-jpa-embedded-embeddable.md, R/2026-05-02-spring-jpa-relationships.md |
| 28 | jpa-queries-querydsl-auditing | 쿼리 — 메서드 이름·@Query·QueryDSL·Auditing | 데이터 | S/2026-05-16-jpa-query-methods.md, S/2026-05-17-querydsl.md, S/2026-05-17-jpa-auditing.md |
| 29 | persistence-context-lazy-loading | 영속성 컨텍스트와 LazyLoading | 데이터 | S/2026-05-16-persistence-context-lazy-loading.md |
| 30 | caching-cacheable-redis | 캐싱 — @Cacheable과 Spring Data Redis | 데이터 | S/2026-05-16-cacheable-caching.md, R/2026-05-02-spring-caching-events.md, R/2026-05-02-redis-spring-data.md, data-infra/2026-05-17-redis-spring-integration.md |
| 31 | logging-logback-slf4j | 로깅 — Logback·SLF4J | 운영·통합 | S/2026-05-17-logback-slf4j-logging.md |
| 32 | events-async-scheduling | 이벤트·비동기·스케줄링 | 운영·통합 | S/2026-05-17-application-event-listener.md, S/2026-05-17-async-completable-future.md, S/2026-05-16-scheduled-task.md |
| 33 | http-client-restclient | HTTP 클라이언트 — RestClient | 운영·통합 | S/2026-05-17-webclient-restclient.md, R/2026-05-02-spring-rest-client.md |
| 34 | testing-mockmvc-testcontainers | 테스트 — MockMvc·@SpringBootTest·Testcontainers·Flyway | 운영·통합 | S/2026-05-16-springboottest-integration-test.md, S/2026-05-16-mockmvc-controller-test.md, S/2026-05-17-testcontainers.md, R/2026-05-02-spring-database-advanced.md, R/2026-05-02-spring-mvc-rest.md |
| 35 | actuator-micrometer | Actuator와 Micrometer | 운영·통합 | S/2026-05-17-spring-actuator.md, R/2026-05-02-spring-observability.md, micrometer/2026-05-25-micrometer-spring-boot-actuator.md |
| 36 | dto-mapping-mapstruct | DTO 매핑 — MapStruct | 운영·통합 | S/2026-05-17-mapstruct.md |
| 37 | deploy-docker-buildpack | 배포 — Docker·Buildpack | 운영·통합 | R/2026-05-02-spring-containers-deployment.md, R/2026-05-02-spring-cloud-gateway-build.md |
| 38 | msa-spring-kafka-gateway | MSA 입문 — Spring Kafka·Cloud Gateway | 운영·통합 | R/2026-05-02-spring-microservices-kafka.md, R/2026-05-02-spring-cloud-gateway-build.md, data-infra/2026-05-17-kafka-spring-kafka.md |
| 39 | spring-ai | Spring AI | 운영·통합 | R/2026-05-02-spring-openapi-ai.md |
| 40 | best-practices | 베스트 프랙티스 정리 | 운영·통합 | R/2026-05-02-spring-certification-best-practices.md |
```

- [ ] **Step 3: 매핑의 원본 파일이 실제로 존재하는지 검증**

Run:
```bash
cd /Users/jinwookoh/Project/jinwookoh.github.io && python3 - <<'EOF'
import re,os
base='/Users/jinwookoh/Project/Coupang/posts/study/'
t=open('planning/mapping/java-spring.md',encoding='utf-8').read()
miss=[]
for row in re.findall(r'^\| (\d+) \|.*\| ([^|]+) \|$', t, re.M):
    for src in row[1].split(','):
        s=src.strip().replace('S/','spring/').replace('R/','')
        if not os.path.exists(base+s): miss.append((row[0],s))
print('missing:',miss)
EOF
```
Expected: `missing: []`. 하나라도 있으면 `ls`로 실제 파일명을 확인해 표를 고친다.

- [ ] **Step 4: 재작성 지시문 템플릿**

`planning/prompts/rewrite-post.md`:
```markdown
# 기술 노트 재작성 지시문

너는 아래 원본 글 N편을 읽고, 포트폴리오 사이트용 기술 노트 1편을 새로 쓴다. 결과는 마크다운 파일 하나로 저장한다.

## 출력 파일
`{OUT_PATH}` (예: notes/java-spring/13-ioc-di-application-context.md)

## Front matter (그대로 채운다)
---
title: "{TITLE}"
series: {SERIES}
part: "{PART}"
order: {ORDER}
summary: "<한 문장. 이 글이 답하는 질문 또는 핵심 결론. 40~80자>"
tags: [<핵심 키워드 2~5개, 영문 고유명사는 영문 그대로>]
sources: [{SOURCES}]
updated: {TODAY}
---

## 본문 규칙 (위반 시 빌드가 실패한다)
- 분량 1,500~2,500자 (코드 블록·공백 제외). 원본을 요약하는 게 아니라 원본들의 내용을 **합쳐서 새로 쓴다**. 두 원본이 같은 개념을 다루면 한 번만 설명하고 더 정확한 쪽을 택한다.
- 문체: "~한다"체 기술 문서. 다음은 금지 — 비유(예: "횡단보도 CCTV처럼"), 구어체·감탄("~예요", "~거든요", "!"), 이모지, "이 글은 N편 중 M편" 같은 시리즈 안내, 독자에게 말 거는 문장("따라오시면"), SEO용 반복.
- 구조 (h2 제목은 내용에 맞게 바꿔도 되지만 순서는 유지):
  1. 첫 문단: 왜 필요한가 — 이 기술이 없을 때 생기는 문제 (제목 없이 본문 시작)
  2. `## 핵심 개념` — 개념·동작 원리. 표는 비교가 필요할 때만.
  3. `## 코드` — 실제 동작하는 예제 1~3개. Java 21, Spring Boot 3.x, Jakarta 네임스페이스. 각 코드 앞에 한 줄 설명.
  4. `## 실무에서 걸리는 지점` — 함정·성능·운영 이슈 3~5개, 각 항목 1~3문장.
  5. `## 관련 글` — 같은 시리즈 글만 `/notes/{SERIES}/<slug>/` 형식으로 1~3개. 아래 목차에 있는 slug만 쓴다.
- 절대 넣지 말 것: smartlifen4n.com 링크, 쿠팡·제휴·위젯 문구, 이미지, 외부 링크(공식 문서 링크도 넣지 않는다).
- 원본에 있는 사실 오류·구버전 API(javax.*, WebSecurityConfigurerAdapter, RestTemplate 권장 등)는 최신 기준으로 바로잡는다.

## 시리즈 목차 (관련 글 링크용)
{TOC}

## 원본
{SOURCES_FULLTEXT}
```

- [ ] **Step 5: 커밋**

```bash
git add planning/mapping/java-spring.md planning/prompts/rewrite-post.md notes/java-spring/_series.yml
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "docs: java-spring 매핑 40행 + 시리즈 메타 + 재작성 지시문

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 재작성 배치 실행 스크립트

**Files:**
- Create: `build/prompt.mjs`

**Interfaces:**
- Produces: `node build/prompt.mjs <series> <order>` → 해당 행의 완성된 지시문을 stdout으로 출력 (원본 전문 포함). Task 7~14는 이 출력을 서브에이전트 프롬프트로 그대로 넘긴다.

- [ ] **Step 1: 스크립트 작성**

`build/prompt.mjs`:
```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDY = '/Users/jinwookoh/Project/Coupang/posts/study/';
const [series, orderArg] = process.argv.slice(2);
if (!series || !orderArg) { console.error('usage: node build/prompt.mjs <series> <order>'); process.exit(2); }
const order = Number(orderArg);

const mapping = fs.readFileSync(path.join(root, 'planning/mapping', `${series}.md`), 'utf8');
const rows = [...mapping.matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map(m => ({ order: Number(m[1]), slug: m[2].trim(), title: m[3].trim(), part: m[4].trim(), sources: m[5].split(',').map(s => s.trim()) }));
const row = rows.find(r => r.order === order);
if (!row) { console.error(`order ${order} not in mapping`); process.exit(2); }

const resolve = s => s.replace(/^S\//, 'spring/').replace(/^R\//, '');
const fulltext = row.sources.map(s => {
  const rel = resolve(s);
  const txt = fs.readFileSync(path.join(STUDY, rel), 'utf8');
  return `\n\n----- 원본: ${rel} -----\n${txt}`;
}).join('');

const toc = rows.map(r => `- ${r.order}. ${r.title} → /notes/${series}/${r.slug}/`).join('\n');
const nn = String(order).padStart(2, '0');
const outPath = `notes/${series}/${nn}-${row.slug}.md`;
const today = new Date().toISOString().slice(0, 10);

const tpl = fs.readFileSync(path.join(root, 'planning/prompts/rewrite-post.md'), 'utf8');
const out = tpl
  .replaceAll('{OUT_PATH}', outPath)
  .replaceAll('{TITLE}', row.title)
  .replaceAll('{SERIES}', series)
  .replaceAll('{PART}', row.part)
  .replaceAll('{ORDER}', String(order))
  .replaceAll('{SOURCES}', row.sources.map(resolve).join(', '))
  .replaceAll('{TODAY}', today)
  .replaceAll('{TOC}', toc)
  .replaceAll('{SOURCES_FULLTEXT}', fulltext);
process.stdout.write(out);
```

- [ ] **Step 2: 동작 확인**

Run: `node build/prompt.mjs java-spring 13 | head -40 && node build/prompt.mjs java-spring 13 | wc -c`
Expected: 지시문 상단에 `notes/java-spring/13-ioc-di-application-context.md`, `{` 플레이스홀더가 남아 있지 않음, 총 크기 수만 자(원본 4편 포함).

- [ ] **Step 3: 커밋**

```bash
git add build/prompt.mjs
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "feat(build): 매핑 행 → 서브에이전트 지시문 생성 스크립트

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7~14: Java/Spring 40편 재작성 (5편씩 8개 배치)

각 배치 Task의 절차는 동일하다. 배치 구성:

| Task | order 범위 | Part |
|---|---|---|
| 7 | 1~5 | 자바 기초·모던 자바 |
| 8 | 6~10 | 자바 기초·모던 자바 |
| 9 | 11~15 | Spring 코어 |
| 10 | 16~20 | Spring 코어 / Web MVC |
| 11 | 21~25 | Web MVC / 데이터 |
| 12 | 26~30 | 데이터 |
| 13 | 31~35 | 운영·통합 |
| 14 | 36~40 | 운영·통합 |

**Files (배치마다):**
- Create: `notes/java-spring/NN-<slug>.md` × 5
- Regenerate: `docs/notes/**`, `docs/sitemap.xml`

**Interfaces:**
- Consumes: `node build/prompt.mjs java-spring <order>` (Task 6), `npm run build` (Task 3)

- [ ] **Step 1: 배치의 5개 order에 대해 지시문 생성 → 서브에이전트 5개 병렬 디스패치**

각 order마다:
```bash
node build/prompt.mjs java-spring <order> > /private/tmp/claude-501/-Users-jinwookoh-Project-Coupang/c371753b-f291-4e5d-bfbd-0ca485645846/scratchpad/prompt-<order>.md
```
그 파일 내용을 프롬프트 본문으로 하여 `general-purpose` 서브에이전트를 실행한다. 서브에이전트에 추가로 지시: "출력 파일을 Write 도구로 저장한 뒤, 저장한 경로와 본문 글자 수(코드 제외)만 한 줄로 보고하라. 다른 파일은 만들거나 수정하지 않는다." 5개는 한 메시지에서 동시에 디스패치한다.

- [ ] **Step 2: 빌드로 검증**

Run: `node build/build.mjs 2>&1 | grep -v '깨진 내부 링크 /notes/java-spring/'`
Expected: 출력에 `ERROR` 0건. 설명: 지시문의 목차에 있는 slug로만 링크하므로, 아직 안 쓰인 뒤 배치 글을 가리키는 "깨진 내부 링크" 에러는 시리즈 완주 전까지 정상이다. 그래서 그 종류만 필터하고 본다(최종 확인은 Task 15). 다른 ERROR(필수 키·이모지·금지 문자열·part·order)는 즉시 해당 글을 재지시해 고친다. `WARN`(글자 수 범위 이탈)은 해당 글만 서브에이전트에 "본문을 N자로 늘려라/줄여라(코드 제외), 나머지는 유지"로 재지시 후 다시 빌드.

- [ ] **Step 3: 품질 스팟체크 (배치당 1편)**

배치의 5편 중 1편을 골라 `Read`로 전문을 읽고 다음을 확인한다: (a) "~한다"체 유지, (b) 비유·구어체 없음, (c) 코드가 Spring Boot 3 / Jakarta 기준, (d) `## 관련 글`의 slug가 매핑 표에 있음. 하나라도 어긋나면 해당 글을 재지시한다. 나머지 4편은 `grep -nE '예요|거든요|!|처럼 생각|비유' notes/java-spring/NN-*.md` 로 구어체·비유 잔재를 검색해 0건인지 확인한다.

- [ ] **Step 4: 커밋 (배치 단위)**

```bash
git add notes/java-spring docs/notes docs/sitemap.xml
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "content(java-spring): <order 시작>~<order 끝>편 재작성

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(docs/notes 는 Task 15 이전에는 링크 에러로 빌드가 exit 1 하여 생성되지 않을 수 있다. 그 경우 `notes/` 만 커밋한다.)

---

### Task 15: 시리즈 완주 검증 + 사이트 최종 확인

**Files:**
- Regenerate: `docs/notes/**`, `docs/sitemap.xml`

- [ ] **Step 1: 전체 빌드 (필터 없이)**

Run: `npm run build; echo exit=$?`
Expected: `built 1 series, 40 posts → docs/notes`, `exit=0`, ERROR 0건. 깨진 링크가 남아 있으면 해당 글의 `## 관련 글`을 고친다.

- [ ] **Step 2: 생성물 구조 확인**

Run: `ls docs/notes/java-spring | wc -l; ls -d docs/notes/java-spring/[0-9]* 2>/dev/null | wc -l; ls docs/notes/java-spring/ioc-di-application-context/`
Expected: 첫 줄 `41`(글 디렉토리 40 + index.html), 둘째 줄 `0`(`NN-` 접두 디렉토리 없음), 셋째 줄 `index.html`.

- [ ] **Step 3: 잔재 전수 검색**

Run: `grep -rlE 'smartlifen4n|쿠팡|coupang|예요|거든요' notes/ docs/notes/ ; echo "exit=$?"`
Expected: 출력 없음, `exit=1` (grep 불일치).

- [ ] **Step 4: 브라우저 확인**

Run: `cd docs && python3 -m http.server 8765 &` 후 `http://localhost:8765/notes/`, `/notes/java-spring/`, `/notes/java-spring/ioc-di-application-context/` 를 1440px와 390px 폭에서 스크린샷.
Expected: 시리즈 카드 → 목차(5개 Part 아래 40편) → 본문(코드 하이라이트, 이전/다음). 390px에서 코드 블록이 가로 스크롤 컨테이너 안에 있고 페이지 자체는 가로 스크롤 없음.

- [ ] **Step 5: 커밋**

```bash
git add docs/notes docs/sitemap.xml notes/
git -c user.name=jinwookoh -c user.email=jinwookoh@gmail.com commit -m "build: java-spring 40편 사이트 반영

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: 사용자 보고**

로컬 미리보기 주소 3개와 커밋 수를 보고하고, 푸시 승인을 요청한다. 푸시는 하지 않는다.

---

## 다음 계획 (이 계획 범위 밖)

시리즈 2~13은 각각 `planning/mapping/<series>.md` 작성 → Task 7~14와 같은 배치 재작성 → Task 15와 같은 완주 검증의 반복이다. 빌드 도구·지시문 템플릿은 그대로 재사용한다. 다음 순서: kafka → redis → postgresql → elasticsearch → reactive-spring → spring-batch → sns-project → observability → experimentation → infra → aws → braze.
