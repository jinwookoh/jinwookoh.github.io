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
fs.writeFileSync(path.join(path.dirname(outDir), 'sitemap.xml'), renderSitemap({ site, baseUrl: BASE }));
console.log(`built ${site.series.length} series, ${count} posts → ${path.relative(root, outDir)}`);
