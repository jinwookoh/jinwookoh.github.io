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
  const i기초 = html.indexOf('<h2>기초</h2>'), i심화 = html.indexOf('<h2>심화</h2>');
  assert.ok(i기초 > 0 && i심화 > i기초);
  assert.match(html, /href="\/notes\/demo\/hello\/"/);
});

test('notes index lists series with post count', () => {
  const html = renderNotesIndex({ site });
  assert.match(html, /데모 시리즈/);
  assert.match(html, /2편/);
});

test('sitemap lists only the profile; notes are noindex', () => {
  const xml = renderSitemap({ site, baseUrl: 'https://jinwookoh.github.io' });
  assert.match(xml, /<loc>https:\/\/jinwookoh\.github\.io\/<\/loc>/);
  assert.doesNotMatch(xml, /\/notes\//);
  const html = renderPostPage({ site, series, post: series.posts[0], prev: null, next: null });
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});
