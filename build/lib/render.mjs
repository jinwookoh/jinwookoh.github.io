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
  <meta name="robots" content="noindex, nofollow">
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
  const ordered = [...site.series].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const cards = ordered.map(s => `<li><a href="/notes/${s.slug}/"><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p><span class="count">${s.posts.length}편</span></a></li>`).join('\n');
  const body = `<header class="series-head"><h1>Notes</h1><p>주제별로 정리한 기술 노트.</p></header>\n<ul class="series-cards">${cards}</ul>`;
  return layout({ title: 'Notes · 오진욱', description: '주제별 기술 노트 아카이브.', url: '/notes/', body });
}

export function renderSitemap({ site, baseUrl }) {
  // 노트 페이지는 검색 엔진 색인 대상이 아니므로 sitemap에는 프로필만 넣는다.
  const urls = ['/'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
}
