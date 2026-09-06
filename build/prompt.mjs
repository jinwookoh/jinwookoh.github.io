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
const isUrl = s => /^https?:\/\//.test(s);
// T/<id> = 옛 티스토리 글(planning/sources/tistory/<id>.md 로 내려받아 둔 원문)
const isTistory = s => /^T\/\d+$/.test(s);
const tistoryUrl = s => `https://jinwookoh.tistory.com/${s.slice(2)}`;
const docsMode = row.sources.every(isUrl);
const fulltext = docsMode
  ? row.sources.map(u => `- ${u}`).join('\n')
  : row.sources.map(s => {
      if (isTistory(s)) {
        const txt = fs.readFileSync(path.join(root, 'planning/sources/tistory', `${s.slice(2)}.md`), 'utf8');
        return `\n\n----- 원본: ${tistoryUrl(s)} -----\n${txt}`;
      }
      const rel = resolve(s);
      const txt = fs.readFileSync(path.join(STUDY, rel), 'utf8');
      return `\n\n----- 원본: ${rel} -----\n${txt}`;
    }).join('');

const toc = rows.map(r => `- ${r.order}. ${r.title} → /notes/${series}/${r.slug}/`).join('\n');
const nn = String(order).padStart(2, '0');
const outPath = `notes/${series}/${nn}-${row.slug}.md`;
const today = new Date().toISOString().slice(0, 10);

const tpl = fs.readFileSync(path.join(root, 'planning/prompts', docsMode ? 'rewrite-post-docs.md' : 'rewrite-post.md'), 'utf8');
const out = tpl
  .replaceAll('{OUT_PATH}', outPath)
  .replaceAll('{TITLE}', row.title)
  .replaceAll('{SERIES}', series)
  .replaceAll('{PART}', row.part)
  .replaceAll('{ORDER}', String(order))
  .replaceAll('{SOURCES}', row.sources.map(x => isUrl(x) ? x : isTistory(x) ? tistoryUrl(x) : resolve(x)).join(', '))
  .replaceAll('{TODAY}', today)
  .replaceAll('{TOC}', toc)
  .replaceAll('{SOURCES_FULLTEXT}', fulltext);
process.stdout.write(out);
