import type { Cta, FlowPage, FlowSession } from '@mokie/shared';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const COLORS: Record<Cta['color'], [string, string]> = {
  green: ['#1f9d55', '#ffffff'],
  red: ['#d64545', '#ffffff'],
  orange: ['#e08a1e', '#ffffff'],
  blue: ['#3b6fd8', '#ffffff'],
  gray: ['#e7e7ea', '#222222'],
};

const MARK = `<svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true" style="vertical-align:-3px;margin-right:6px">
<path d="M6 22 Q50 12 94 22 L92 31 Q50 23 8 31 Z" fill="#E03131"/><g fill="currentColor"><rect x="16" y="40" width="68" height="8" rx="2"/>
<rect x="46" y="28" width="8" height="12"/><rect x="24" y="28" width="10" height="62" rx="2"/><rect x="66" y="28" width="10" height="62" rx="2"/></g>
<path d="M34 48 L50 70 L66 48" fill="none" stroke="currentColor" stroke-width="9" stroke-linejoin="round"/></svg>`;

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#E03131"/>' +
      '<g fill="#fff" transform="translate(14 14) scale(0.72)"><path d="M4 18 Q50 6 96 18 L94 32 Q50 22 6 32 Z"/>' +
      '<rect x="20" y="28" width="16" height="64" rx="2"/><rect x="64" y="28" width="16" height="64" rx="2"/>' +
      '<path d="M34 44 L50 68 L66 44" fill="none" stroke="#fff" stroke-width="15" stroke-linejoin="round"/></g></svg>',
  );

const layout = (title: string, inner: string) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Mokie</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>
  :root { color-scheme: light dark; --bg:#f4f4f6; --card:#fff; --fg:#1c1c22; --muted:#6b6b76; --line:#e3e3e8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151518; --card:#1f1f24; --fg:#ececf1; --muted:#9a9aa6; --line:#33333b; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--fg);
         min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:32px; width:100%; max-width:460px;
          box-shadow:0 8px 30px rgba(0,0,0,.06); }
  .badge { display:inline-block; font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted);
           border:1px dashed var(--line); border-radius:999px; padding:2px 10px; margin-bottom:16px; }
  h1 { font-size:22px; margin:0 0 8px; }
  p.desc { color:var(--muted); margin:0 0 24px; white-space:pre-line; }
  form { margin:0 0 10px; }
  button { width:100%; border:0; border-radius:10px; padding:13px 16px; font-size:16px; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.07); }
  button small { display:block; font-weight:400; opacity:.8; font-size:12px; }
  details { margin-top:22px; font-size:13px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  td { border-top:1px solid var(--line); padding:4px 6px; vertical-align:top; word-break:break-all; }
  td:first-child { white-space:nowrap; font-weight:600; width:1%; }
</style></head>
<body><main class="card"><span class="badge">${MARK}Mokie · pagina simulata</span>${inner}</main></body></html>`;

export function renderFlowPage(page: FlowPage, session: FlowSession, basePath: string): string {
  const buttons = page.ctas.length
    ? page.ctas
        .map((c) => {
          const [bg, fg] = COLORS[c.color] ?? COLORS.blue;
          return `<form method="post" action="${esc(basePath)}/cta/${encodeURIComponent(c.id)}">
  <button type="submit" style="background:${bg};color:${fg}">${esc(c.label)}${c.outcome ? `<small>${esc(c.outcome)}</small>` : ''}</button>
</form>`;
        })
        .join('\n')
    : `<p class="desc">Nessuna azione configurata per questa pagina.</p>`;
  const rows = Object.entries(session.context)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
    .join('');
  return layout(
    page.title,
    `<h1>${esc(page.title)}</h1>
<p class="desc">${esc(page.description)}</p>
${buttons}
<details><summary>Dettagli sessione</summary><table>
<tr><td>sessione</td><td>${esc(session.token)}</td></tr>
<tr><td>pagina</td><td>${esc(page.slug)}</td></tr>${rows}</table></details>`,
  );
}

export function renderResultPage(page: FlowPage, cta: Cta, error?: string): string {
  return layout(
    page.title,
    `<h1>Azione registrata: ${esc(cta.label)}</h1>
<p class="desc">${esc(cta.outcome)}</p>
${error ? `<p class="desc">⚠️ ${esc(error)}</p>` : ''}`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="desc">${esc(message)}</p>`);
}
