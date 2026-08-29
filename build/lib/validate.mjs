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
      const rel = p.body.split(/^## 관련 글/m)[1];
      if (rel !== undefined) {
        for (const line of rel.split('\n')) {
          if (/\/notes\//.test(line) && !/\]\(\/notes\//.test(line)) errors.push(`${at}: 관련 글에 제목 없는 맨주소 링크: ${line.trim()}`);
        }
      }
      const n = countBodyChars(p.body);
      if (n < MIN || n > MAX) warnings.push(`${at}: 본문 ${n}글자 (권장 ${MIN}~${MAX})`);
    }
  }
  return { errors, warnings };
}
