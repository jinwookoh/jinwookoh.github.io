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
