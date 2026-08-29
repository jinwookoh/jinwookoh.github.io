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
    order: Number(meta.order ?? 999),
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
    updated: data.updated ? String(data.updated instanceof Date ? data.updated.toISOString() : data.updated).slice(0, 10) : '',
    body: content.trim(),
  };
}
