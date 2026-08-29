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

test('bare URL in related section is an error', () => {
  const r = validateSite(site([post(), post({ slug: 'b', file: 'notes/demo/02-b.md', order: 2, body: '본문 '.repeat(400) + '\n\n## 관련 글\n\n- /notes/demo/a/\n' })]));
  assert.ok(r.errors.some(e => e.includes('맨주소')));
});
