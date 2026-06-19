// Static gallery for the duo PROMPT comparison. Serves prompt-test-output/,
// grouped by prompt, each prompt's text shown above its 3 duo grids + split
// boards. No auto-refresh (reload manually). Run: node scripts/prompt-gallery-server.mjs
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'prompt-test-output');
const PORT = Number(process.env.PORT ?? 3001);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function promptDirs() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT).filter((d) => /^prompt-/.test(d) && statSync(path.join(ROOT, d)).isDirectory()).sort();
}
function filesIn(dir, pred) {
  return readdirSync(path.join(ROOT, dir)).filter(pred).sort().map((f) => `${dir}/${f}`);
}

function gallery() {
  const dirs = promptDirs();
  let body = '';
  let totalImgs = 0;
  for (const dir of dirs) {
    const txt = existsSync(path.join(ROOT, dir, '_prompt.txt')) ? readFileSync(path.join(ROOT, dir, '_prompt.txt'), 'utf8') : dir;
    const head = txt.split('\n')[0];
    const grids = filesIn(dir, (f) => f.endsWith('_grid.png'));
    const splits = filesIn(dir, (f) => f.endsWith('.jpg'));
    totalImgs += grids.length;
    body += `<section><h2>${esc(head)} <span class="tag">${grids.length} duos</span></h2>`;
    body += `<details><summary>prompt text</summary><pre>${esc(txt)}</pre></details>`;
    body += `<h3>duo grids — full Gemini output</h3><div class="grids">`;
    for (const g of grids) body += `<figure><img loading="lazy" src="/${esc(g)}"><figcaption>${esc(g.split('/').pop())}</figcaption></figure>`;
    body += `</div>`;
    if (splits.length) {
      body += `<h3>split boards (${splits.length})</h3><div class="splits">`;
      for (const s of splits) body += `<figure><img loading="lazy" src="/${esc(s)}"><figcaption>${esc(s.split('/').pop())}</figcaption></figure>`;
      body += `</div>`;
    }
    body += `</section>`;
  }
  if (!body) body = `<p class="empty">No prompt outputs yet — the run is still generating. Reload (⌘R) when it finishes.</p>`;
  return `<!doctype html><html><head><meta charset="utf8"><title>Duo prompt comparison</title>
<style>
  :root{color-scheme:dark}
  body{background:#0b0b0c;color:#e7e7e9;font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px 28px}
  h1{margin:0 0 4px;font-size:20px}
  .status{color:#9aa;margin-bottom:22px}
  section{margin:0 0 40px;border-top:1px solid #1c1c1e;padding-top:18px}
  h2{font-size:17px;margin:0 0 6px}
  .tag{color:#889;font-weight:400;font-size:12px}
  h3{font-size:12px;color:#9ab;font-weight:600;margin:16px 0 0;text-transform:uppercase;letter-spacing:.04em}
  details{margin:6px 0 0;color:#9aa}summary{cursor:pointer;font-size:12px;color:#7a8}
  .grids{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px}
  .splits{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}
  .splits figure{max-width:230px}
  figure{margin:0;max-width:560px}
  img{max-width:100%;border:1px solid #222;border-radius:8px;display:block;background:#fff}
  figcaption{color:#778;font-size:11px;margin-top:6px;font-family:ui-monospace,monospace}
  pre{background:#111;border:1px solid #222;border-radius:8px;padding:14px;overflow:auto;font-size:12px;white-space:pre-wrap}
  .empty{color:#889;font-style:italic}
</style></head>
<body>
  <h1>Duo prompt comparison — pick the best handwriting match</h1>
  <div class="status">${dirs.length} prompts · ${totalImgs} duo images · same 3 duos in each · static page, reload (⌘R) to refresh</div>
  ${body}
</body></html>`;
}

http.createServer((req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(gallery()); }
    const target = path.normalize(path.join(ROOT, url));
    if (!target.startsWith(ROOT) || !existsSync(target) || statSync(target).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'text/plain';
    res.writeHead(200, { 'content-type': type }); res.end(readFileSync(target));
  } catch (e) { res.writeHead(500); res.end('err: ' + e.message); }
}).listen(PORT, () => console.log(`prompt gallery → http://localhost:${PORT}`));
