// NEW-REFERENCE-PHOTO acceptance test (standalone, read-only — touches NO prod data).
//
// Purpose: before we swap the founders' base whiteboard photo in Supabase, prove the
// NEW photo edits as well or better than the CURRENT one — on BOTH paths:
//   • single-image path  (prod buildImagePrompt)        — one board per call
//   • batch-2 path        (prod buildPairImagePrompt)     — the "stitch two copies,
//     edit both boards in one call, crop the result in half" cost trick.
//
// It reuses the EXACT prod prompt builders, 2-up crop, and two-model text validator
// (whiteboardNeedsRedo) so results transfer 1:1. The only test-only code is the
// OpenRouter call (adds usage:{include:true} to read the REAL $ cost prod discards)
// and reading the references from LOCAL files instead of Supabase Storage (so nothing
// in prod changes and no image is uploaded).
//
// Same lead set runs through every path, so the gallery can show, per lead:
//   [current-ref single] | [new-ref single] | [current-ref batch] | [new-ref batch]
//
// Run:  npx tsx scripts/new-ref-test.ts
// Env:  NEWREF_LEADS=10 (even)  NEWREF_CAP_USD=6  NEWREF_CONCURRENCY=4
//       NEWREF_BATCH_BASELINE=1 (also run current-ref batch)  DRYRUN=1 (no API calls)

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  buildImagePrompt,
  buildPairImagePrompt,
  cropPairHalves,
  expectedBoard,
  spellOut,
  boardName,
  compressImage,
  whiteboardNeedsRedo,
} from '@/lib/ai/visual-draft';
import {
  VISUAL_IMAGE_MODEL,
  VISUAL_IMAGE_FALLBACKS,
  IMAGE_GEN_COST_USD,
} from '@/lib/email-tool/cold-constants';

// ── env: load .env.local so OPENROUTER_API_KEY is available however invoked ────
function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal();

// ── config ─────────────────────────────────────────────────────────────────
const OUT_DIR = path.join(process.cwd(), 'new-ref-test-output');
const NEW_REF = '/tmp/wb-test/new_founders.png';       // resized to 872 wide (matches pipeline)
const CUR_REF = '/tmp/wb-test/current_founders.png';   // 872x1280 live prod reference
let LEADS = Number(process.env.NEWREF_LEADS ?? 10);
if (LEADS % 2 !== 0) LEADS += 1;                         // even, so batch pairs are clean
const CAP_USD = Number(process.env.NEWREF_CAP_USD ?? 6);
const CONCURRENCY = Number(process.env.NEWREF_CONCURRENCY ?? 4);
const BATCH_BASELINE = process.env.NEWREF_BATCH_BASELINE !== '0';
const DRYRUN = process.env.DRYRUN === '1';
const STRENGTH = 0.35;                                   // same as prod
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── tiny utils ────────────────────────────────────────────────────────────
const slugify = (s: string) => (s || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lead';
const dataUrlToBuffer = (u: string) => Buffer.from(u.replace(/^data:[^;]+;base64,/, ''), 'base64');
const bufToDataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

interface Lead { first: string; company: string; slug: string }

// ── fixture: hardest leads from the pitchbook CSV (long/multi-word companies) ──
function loadLeads(): Lead[] {
  const csv = path.join(process.cwd(), 'pitchbook_cleaned_final.csv');
  const lines = readFileSync(csv, 'utf8').split('\n').slice(1).filter(Boolean);
  const seen = new Set<string>();
  const rows: Lead[] = [];
  for (const line of lines) {
    const parts = line.split(',');         // parse from the right (email/first/contact have no commas)
    if (parts.length < 4) continue;
    parts.pop();                            // email
    const first = boardName(parts.pop() || '');
    parts.pop();                            // contact (full name)
    const company = boardName(parts.join(','));
    if (!first || !company) continue;
    const key = `${first}|${company}`.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    rows.push({ first, company, slug: slugify(`${first}-${company}`) });
  }
  // Hardest first: more words + longer company = more chances for the model to slip.
  rows.sort((a, b) => (b.company.split(' ').length * 10 + b.company.length) - (a.company.split(' ').length * 10 + a.company.length));
  return rows.slice(0, LEADS);
}

async function buildMontage2(base: Buffer): Promise<Buffer> {
  const m = await sharp(base).metadata(); const w = m.width!, h = m.height!;
  return sharp({ create: { width: 2 * w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: base, left: 0, top: 0 }, { input: base, left: w, top: 0 }]).png().toBuffer();
}

// ── OpenRouter image call with REAL cost (usage.include + generation fallback) ──
let spent = 0;
interface GenResult { dataUrl: string; cost: number; model: string; dims: string }
async function genImage(prompt: string, referenceDataUrl: string): Promise<GenResult> {
  let lastErr: Error | null = null;
  for (const model of [VISUAL_IMAGE_MODEL, ...VISUAL_IMAGE_FALLBACKS]) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Proxi new-ref-test',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: referenceDataUrl } },
          ] }],
          modalities: ['image', 'text'],
          image_config: { strength: STRENGTH },
          usage: { include: true },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const e = new Error(`API error ${res.status}: ${body.slice(0, 120)}`);
        if (/^(429|5\d\d)/.test(String(res.status))) { lastErr = e; continue; }
        throw e;
      }
      const data = await res.json();
      const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) { lastErr = new Error(`no image (model=${model})`); continue; }
      let cost = Number(data.usage?.cost ?? NaN);
      if (!Number.isFinite(cost) && data.id) {
        try {
          const r = await fetch(`https://openrouter.ai/api/v1/generation?id=${data.id}`, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } });
          if (r.ok) cost = Number((await r.json()).data?.total_cost ?? NaN);
        } catch { /* keep NaN */ }
      }
      if (!Number.isFinite(cost)) cost = IMAGE_GEN_COST_USD;
      const dims = await sharp(dataUrlToBuffer(url)).metadata().then(m => `${m.width}x${m.height}`).catch(() => '??');
      return { dataUrl: url, cost, model, dims };
    } catch (err) { lastErr = err instanceof Error ? err : new Error(String(err)); }
  }
  throw lastErr ?? new Error('image gen failed (all models)');
}

// ── results ─────────────────────────────────────────────────────────────────
type Kind = 'single-cur' | 'single-new' | 'batch-cur' | 'batch-new';
interface Cell { file: string; pass: boolean; reason: string; cost: number; dims: string }
interface LeadResult { lead: Lead; cells: Partial<Record<Kind, Cell>> }
const results = new Map<string, LeadResult>();
function leadResult(lead: Lead): LeadResult {
  if (!results.has(lead.slug)) results.set(lead.slug, { lead, cells: {} });
  return results.get(lead.slug)!;
}

async function gradeAndSave(jpeg: Buffer, lead: Lead, kind: Kind, cost: number, dims: string): Promise<void> {
  const rel = `${kind}/${lead.slug}.jpg`;
  ensureDir(path.join(OUT_DIR, kind));
  writeFileSync(path.join(OUT_DIR, rel), jpeg);
  const v = await whiteboardNeedsRedo(bufToDataUrl(jpeg, 'image/jpeg'), lead.first, lead.company);
  leadResult(lead).cells[kind] = { file: rel, pass: !v.redo, reason: v.reason, cost, dims };
  const tag = v.redo ? `❌ ${v.reason}`.slice(0, 70) : '✅';
  console.log(`  [${kind}] ${lead.first} @ ${lead.company} — ${tag}  ($${round4(cost)})`);
}

function capHit(): boolean {
  if (spent + 0.30 > CAP_USD) { console.log(`  [cap] stop — spent $${round2(spent)} / $${CAP_USD}`); return true; }
  return false;
}

// ── jobs ─────────────────────────────────────────────────────────────────────
interface SingleJob { type: 'single'; kind: 'single-cur' | 'single-new'; lead: Lead; refDataUrl: string }
interface BatchJob { type: 'batch'; kind: 'batch-cur' | 'batch-new'; pair: [Lead, Lead]; montageDataUrl: string; gi: number }
type Job = SingleJob | BatchJob;

async function runSingle(j: SingleJob): Promise<void> {
  if (capHit()) return;
  const g = await genImage(buildImagePrompt(j.lead.first, j.lead.company), j.refDataUrl);
  spent += g.cost;
  await gradeAndSave(await compressImage(dataUrlToBuffer(g.dataUrl)), j.lead, j.kind, g.cost, g.dims);
}

async function runBatch(j: BatchJob): Promise<void> {
  if (capHit()) return;
  const g = await genImage(buildPairImagePrompt(j.pair[0], j.pair[1]), j.montageDataUrl);
  spent += g.cost;
  const grid = dataUrlToBuffer(g.dataUrl);
  ensureDir(path.join(OUT_DIR, j.kind));
  writeFileSync(path.join(OUT_DIR, j.kind, `_grid_${j.gi}.png`), grid); // raw 2-up the model returned
  const halves = await cropPairHalves(grid);                            // EXACT prod crop
  const half = g.cost / 2;                                              // one call ≈ one single-board cost
  for (let i = 0; i < 2; i++) {
    await gradeAndSave(await compressImage(halves[i]), j.pair[i], j.kind, half, g.dims);
  }
}

// ── report + gallery ──────────────────────────────────────────────────────────
function agg(kind: Kind) {
  let boards = 0, correct = 0, cost = 0; const dims = new Set<string>();
  for (const r of results.values()) {
    const c = r.cells[kind]; if (!c) continue;
    boards++; if (c.pass) correct++; cost += c.cost; if (c.dims) dims.add(c.dims);
  }
  return { boards, correct, cost, dims: [...dims] };
}

function writeReport(orderedLeads: Lead[]) {
  const kinds: Kind[] = ['single-cur', 'single-new', 'batch-cur', 'batch-new'];
  const label: Record<Kind, string> = {
    'single-cur': 'Single · CURRENT ref (baseline)',
    'single-new': 'Single · NEW ref',
    'batch-cur': 'Batch-2 · CURRENT ref (baseline)',
    'batch-new': 'Batch-2 · NEW ref',
  };
  const baseline = agg('single-cur');
  const basePerBoard = baseline.boards ? baseline.cost / baseline.boards : IMAGE_GEN_COST_USD;

  const md: string[] = [];
  md.push('# New-reference whiteboard acceptance test\n');
  md.push(`Model \`${VISUAL_IMAGE_MODEL}\` · ${orderedLeads.length} leads · spent **$${round2(spent)}** / cap $${CAP_USD}${DRYRUN ? ' · DRY RUN' : ''}\n`);
  md.push('| path | boards | correct | correct % | $/board (gen) | net $/board¹ | returned dims |');
  md.push('|------|------:|--------:|----------:|--------------:|-------------:|---------------|');
  for (const k of kinds) {
    const a = agg(k); if (!a.boards) continue;
    const pct = 100 * a.correct / a.boards;
    const perBoard = a.cost / a.boards;
    const net = (a.cost + (a.boards - a.correct) * basePerBoard) / a.boards; // +1 single retry per fail
    const flag = pct >= 99 ? '✅' : pct >= 90 ? '⚠️' : '❌';
    md.push(`| ${label[k]} | ${a.boards} | ${a.correct} | ${round2(pct)}% ${flag} | $${round4(perBoard)} | $${round4(net)} | ${a.dims.join(', ')} |`);
  }
  md.push('\n¹ net = generation cost + one single-image retry (at baseline $/board) for every failed board.\n');
  const sn = agg('single-new'), sc = agg('single-cur'), bn = agg('batch-new');
  md.push('## Headline\n');
  md.push(`- **New vs current (single):** new ${sn.boards ? round2(100*sn.correct/sn.boards) : 0}% correct vs current ${sc.boards ? round2(100*sc.correct/sc.boards) : 0}% correct.`);
  md.push(`- **Batch-2 on new ref:** ${bn.boards ? round2(100*bn.correct/bn.boards) : 0}% correct · $${round4(bn.boards ? bn.cost/bn.boards : 0)}/board gen (vs $${round4(basePerBoard)}/board single).`);
  md.push('\n## Failures (eyeball the crop before trusting the validator)\n');
  let any = false;
  for (const k of kinds) for (const r of results.values()) {
    const c = r.cells[k]; if (c && !c.pass) { md.push(`- **${k}** ${r.lead.first} @ ${r.lead.company} — ${c.reason}`); any = true; }
  }
  if (!any) md.push('_none — every board passed both validators._');
  md.push('\nOpen `index.html` (served on localhost) for the visual side-by-side.\n');
  const report = md.join('\n');
  writeFileSync(path.join(OUT_DIR, 'report.md'), report);
  console.log('\n' + report);
}

function writeGallery(orderedLeads: Lead[]) {
  const cellHtml = (lead: Lead, kind: Kind) => {
    const c = leadResult(lead).cells[kind];
    if (!c) return `<div class="cell empty">—</div>`;
    const badge = c.pass ? `<span class="ok">PASS</span>` : `<span class="bad">FAIL</span>`;
    const reason = c.pass ? '' : `<div class="reason">${esc(c.reason)}</div>`;
    return `<div class="cell"><img src="${c.file}" loading="lazy"/>${badge}${reason}</div>`;
  };
  const rows = orderedLeads.map(lead => `
    <tr>
      <td class="meta"><b>${esc(lead.first)}</b><br/><span class="co">${esc(lead.company)}</span>
        <div class="target">should read:<br/>“${esc(expectedBoard(lead.first, lead.company))}”</div></td>
      <td>${cellHtml(lead, 'single-cur')}</td>
      <td>${cellHtml(lead, 'single-new')}</td>
      <td>${cellHtml(lead, 'batch-cur')}</td>
      <td>${cellHtml(lead, 'batch-new')}</td>
    </tr>`).join('');

  const statRow = (k: Kind, name: string) => {
    const a = agg(k); if (!a.boards) return '';
    const pct = round2(100 * a.correct / a.boards);
    const cls = pct >= 99 ? 'ok' : pct >= 90 ? 'warn' : 'bad';
    return `<div class="stat"><div class="statname">${name}</div><div class="statpct ${cls}">${pct}%</div><div class="statsub">${a.correct}/${a.boards} · $${round4(a.boards ? a.cost/a.boards : 0)}/board</div></div>`;
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>New-ref whiteboard test</title>
<style>
  body{font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:24px;color:#1a1a1a;background:#fafafa}
  h1{font-size:22px} h2{font-size:16px;margin-top:28px}
  .refs{display:flex;gap:20px;align-items:flex-start;margin:12px 0}
  .refs figure{margin:0;text-align:center} .refs img{height:230px;border:1px solid #ddd;border-radius:8px}
  .refs figcaption{font-size:12px;color:#555;margin-top:4px}
  .stats{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}
  .stat{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:12px 16px;min-width:150px}
  .statname{font-size:12px;color:#666} .statpct{font-size:26px;font-weight:700}
  .statsub{font-size:11px;color:#888}
  table{border-collapse:collapse;width:100%;background:#fff} td{border:1px solid #eee;padding:8px;vertical-align:top;text-align:center}
  th{position:sticky;top:0;background:#f3f3f3;border:1px solid #e3e3e3;padding:8px;font-size:13px}
  td.meta{text-align:left;width:200px;font-size:13px} .co{color:#666;font-size:12px}
  .target{margin-top:8px;font-size:11px;color:#444;background:#f7f7f7;border-radius:6px;padding:6px;line-height:1.35}
  .cell img{width:210px;border-radius:6px;border:1px solid #e5e5e5;display:block;margin:0 auto 4px}
  .cell.empty{color:#bbb;padding:40px 0}
  .ok{color:#0a7d33;font-weight:700;font-size:12px} .bad{color:#c01c2e;font-weight:700;font-size:12px}
  .warn{color:#b8860b}
  .reason{font-size:10px;color:#c01c2e;margin-top:3px;line-height:1.3}
  .note{font-size:12px;color:#666;margin:6px 0 18px}
</style></head><body>
<h1>New reference photo — whiteboard acceptance test</h1>
<div class="note">Spent $${round2(spent)} · model ${esc(VISUAL_IMAGE_MODEL)} · PASS/FAIL is the two-model text validator (it can mis-grade — trust your eyes on handwriting realism + correct text).</div>

<h2>The two base photos</h2>
<div class="refs">
  <figure><img src="references/current_founders.png"/><figcaption>CURRENT (live) — 872×1280</figcaption></figure>
  <figure><img src="references/new_founders.png"/><figcaption>NEW (candidate) — resized 872-wide</figcaption></figure>
  <figure><img src="references/new_montage2.png" style="height:230px"/><figcaption>NEW 2-up montage (what the batch-2 call edits)</figcaption></figure>
</div>

<h2>Pass rates</h2>
<div class="stats">
  ${statRow('single-cur', 'Single · CURRENT')}
  ${statRow('single-new', 'Single · NEW')}
  ${statRow('batch-cur', 'Batch-2 · CURRENT')}
  ${statRow('batch-new', 'Batch-2 · NEW')}
</div>

<h2>Per-lead comparison</h2>
<div class="note">Columns let you compare the same lead across old vs new photo, single vs batch. Hardest (longest) company names first.</div>
<table>
  <thead><tr><th>Lead / target text</th><th>Single · CURRENT</th><th>Single · NEW</th><th>Batch-2 · CURRENT</th><th>Batch-2 · NEW</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
  writeFileSync(path.join(OUT_DIR, 'index.html'), html);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  ensureDir(OUT_DIR);
  ensureDir(path.join(OUT_DIR, 'references'));
  if (!DRYRUN && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  if (!existsSync(NEW_REF)) throw new Error(`missing new reference at ${NEW_REF} (run prep first)`);
  if (!existsSync(CUR_REF)) throw new Error(`missing current reference at ${CUR_REF}`);

  const newBuf = readFileSync(NEW_REF);
  const curBuf = readFileSync(CUR_REF);
  copyFileSync(NEW_REF, path.join(OUT_DIR, 'references', 'new_founders.png'));
  copyFileSync(CUR_REF, path.join(OUT_DIR, 'references', 'current_founders.png'));
  const newMontage = await buildMontage2(newBuf);
  const curMontage = await buildMontage2(curBuf);
  writeFileSync(path.join(OUT_DIR, 'references', 'new_montage2.png'), newMontage);

  const refNew = bufToDataUrl(newBuf, 'image/png');
  const refCur = bufToDataUrl(curBuf, 'image/png');
  const monNew = bufToDataUrl(newMontage, 'image/png');
  const monCur = bufToDataUrl(curMontage, 'image/png');

  const leads = loadLeads();
  console.log(`[fixture] ${leads.length} leads (hardest first): ${leads.map(l => l.company).join(' | ')}`);
  const newMeta = await sharp(newBuf).metadata();
  console.log(`[refs] new ${newMeta.width}x${newMeta.height} · montage ${(await sharp(newMontage).metadata()).width}x${(await sharp(newMontage).metadata()).height}`);

  // Build the job list. Singles for all leads on both refs; batches over consecutive pairs.
  const jobs: Job[] = [];
  for (const lead of leads) {
    jobs.push({ type: 'single', kind: 'single-cur', lead, refDataUrl: refCur });
    jobs.push({ type: 'single', kind: 'single-new', lead, refDataUrl: refNew });
  }
  for (let i = 0; i + 1 < leads.length; i += 2) {
    const pair: [Lead, Lead] = [leads[i], leads[i + 1]];
    jobs.push({ type: 'batch', kind: 'batch-new', pair, montageDataUrl: monNew, gi: i / 2 });
    if (BATCH_BASELINE) jobs.push({ type: 'batch', kind: 'batch-cur', pair, montageDataUrl: monCur, gi: i / 2 });
  }
  const estCalls = jobs.length;
  console.log(`[plan] ${estCalls} image calls (~$${round2(estCalls * 0.07)} est, cap $${CAP_USD}), concurrency ${CONCURRENCY}`);
  if (DRYRUN) { console.log('[dryrun] skipping API calls'); writeReport(leads); writeGallery(leads); return; }

  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      try {
        if (j.type === 'single') await runSingle(j); else await runBatch(j);
      } catch (e) { console.log(`  job ${j.kind} FAILED: ${e instanceof Error ? e.message : e}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

  writeReport(leads);
  writeGallery(leads);
  console.log(`\n[done] spent $${round2(spent)} → ${OUT_DIR}/index.html`);
}

main().catch(e => { console.error(e); process.exit(1); });
