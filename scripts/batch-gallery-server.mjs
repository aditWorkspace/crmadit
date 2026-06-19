// Tiny zero-dep static gallery for the visual-batch-test output. Scans
// batch-test-output/ on every page load (so it reflects the live run), shows the
// full grids Gemini returned grouped by batch size, renders report.md when ready,
// and auto-refreshes every 15s. Run: node scripts/batch-gallery-server.mjs
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'batch-test-output');
const PORT = Number(process.env.PORT ?? 3001);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function liveStatus() {
  const log = path.join(ROOT, 'run.log');
  if (!existsSync(log)) return { spent: '—', calls: 0, done: false };
  const txt = readFileSync(log, 'utf8');
  const totals = [...txt.matchAll(/total \$([0-9.]+)/g)];
  const calls = (txt.match(/batch-[0-9] run/g) || []).length;
  const done = existsSync(path.join(ROOT, 'report.md')) || /EXIT 0|stopped early|every board passed|## Read it/.test(txt);
  return { spent: totals.length ? totals[totals.length - 1][1] : '0', calls, done };
}

// All real grids for a batch size, newest first. (_raw_* is only written on real
// API calls, never the dry run, so these are always genuine outputs.)
function gridsFor(n) {
  const dir = path.join(ROOT, `batch-${n}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('_raw_g') && f.endsWith('.png'))
    .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => `batch-${n}/${x.f}`);
}

// Earliest real grid mtime = when the real run started. Per-lead crops older than
// this are leftover dry-run placeholders, so we exclude them automatically.
function realRunStart() {
  let min = Infinity;
  for (const n of [1, 2, 3, 4]) {
    const dir = path.join(ROOT, `batch-${n}`);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('_raw_g') && f.endsWith('.png')) min = Math.min(min, statSync(path.join(dir, f)).mtimeMs);
    }
  }
  return min;
}

// The cropped per-lead boards (what actually ships), real ones only, sorted.
function splitsFor(n, since) {
  const dir = path.join(ROOT, `batch-${n}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('_raw') && f.endsWith('.jpg') && statSync(path.join(dir, f)).mtimeMs >= since)
    .sort()
    .map((f) => `batch-${n}/${f}`);
}

function gallery() {
  const st = liveStatus();
  const started = realRunStart();
  const reportPath = path.join(ROOT, 'report.md');
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  let body = '';
  for (const n of [1, 2, 3, 4]) {
    const grids = gridsFor(n);
    if (!grids.length) continue;
    const label = n === 1 ? 'single board (baseline)' : n === 4 ? '2×2 grid' : `${n}-up strip`;
    body += `<section><h2>batch-${n} <span class="tag">${label} · ${grids.length} grid(s)</span></h2>`;
    body += `<h3>full grids — Gemini output (crop lines fall on the cell boundaries)</h3><div class="grids">`;
    for (const g of grids) {
      body += `<figure><img loading="lazy" src="/${esc(g)}"><figcaption>${esc(g.split('/').pop())}</figcaption></figure>`;
    }
    body += `</div>`;
    const splits = splitsFor(n, started);
    if (splits.length) {
      body += `<h3>split boards — the cropped per-lead images that actually ship (${splits.length})</h3><div class="splits">`;
      for (const s of splits) {
        body += `<figure><img loading="lazy" src="/${esc(s)}"><figcaption>${esc(s.split('/').pop())}</figcaption></figure>`;
      }
      body += `</div>`;
    }
    body += `</section>`;
  }
  if (!body) body = `<p class="empty">No real grids yet.</p>`;
  return `<!doctype html><html><head><meta charset="utf8"><title>Visual batch test</title>
<style>
  :root{color-scheme:dark}
  body{background:#0b0b0c;color:#e7e7e9;font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px 28px}
  h1{margin:0 0 4px;font-size:20px}
  .status{color:#9aa;margin-bottom:20px}
  .status b{color:#7dd3a0}
  section{margin:0 0 34px}
  h2{font-size:16px;border-bottom:1px solid #222;padding-bottom:6px}
  .tag{color:#889;font-weight:400;font-size:12px}
  h3{font-size:12px;color:#9ab;font-weight:600;margin:18px 0 0;text-transform:uppercase;letter-spacing:.04em}
  .grids{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px}
  .splits{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}
  .splits figure{max-width:240px}
  figure{margin:0;max-width:520px}
  img{max-width:100%;border:1px solid #222;border-radius:8px;display:block;background:#fff}
  figcaption{color:#778;font-size:11px;margin-top:6px;font-family:ui-monospace,monospace}
  pre{background:#111;border:1px solid #222;border-radius:8px;padding:16px;overflow:auto;font-size:12px;white-space:pre-wrap}
  .empty{color:#889;font-style:italic}
</style></head>
<body>
  <h1>Visual batch test — image batching</h1>
  <div class="status">spent <b>$${esc(st.spent)}</b> · ${st.calls} gen calls · <b>calls stopped</b> · static page — reload manually (⌘R) to pick up changes</div>
  ${report ? `<section><h2>report.md</h2><pre>${esc(report)}</pre></section>` : ''}
  ${body}
</body></html>`;
}

http.createServer((req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(gallery());
    }
    const target = path.normalize(path.join(ROOT, url));
    if (!target.startsWith(ROOT) || !existsSync(target) || statSync(target).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : ext === '.md' ? 'text/plain' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(target));
  } catch (e) {
    res.writeHead(500); res.end('err: ' + e.message);
  }
}).listen(PORT, () => console.log(`gallery → http://localhost:${PORT}`));
