// Visual-outreach IMAGE-BATCHING cost test (standalone, read-only on prod data).
//
// Question: can we cut the ~$75-100/day whiteboard-image bill by asking Gemini to
// render 2-4 leads' boards in ONE image (one montage of the founders photo, N edits
// at once) and cropping the result back into per-lead images? Output image tokens are
// billed ~flat per returned image, so one call with N boards should cost ~1 image
// instead of N — IF text fidelity survives. This harness measures both.
//
// It changes NOTHING in prod: no DB writes, no Supabase Storage uploads, no emails.
// It reuses the EXACT prod prompt (buildImagePrompt), target-text formula
// (expectedBoard/spellOut), validator (whiteboardNeedsRedo) and compressor
// (compressImage) so results transfer 1:1. The only test-only code is the OpenRouter
// call, which adds `usage:{include:true}` to read the REAL dollar cost prod discards.
//
// Run:  npx tsx scripts/visual-batch-test.ts
// Env (all optional): BATCH_LEADS=12 BATCH_RUNS=2 BATCH_CAP_USD=10
//                     BATCH_SIZES=1,2,3,4 DRYRUN=1 (no API calls — pipeline smoke test)
//
// Reads OPENROUTER_API_KEY + SUPABASE_* from .env.local (loaded below) or the shell.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  whiteboardNeedsRedo,
  compressImage,
  buildImagePrompt,
  expectedBoard,
  spellOut,
  boardName,
} from '@/lib/ai/visual-draft';
import {
  VISUAL_IMAGE_MODEL,
  VISUAL_IMAGE_FALLBACKS,
  OUTREACH_IMAGE_BUCKET,
  OUTREACH_REFERENCE_KEY,
  IMAGE_GEN_COST_USD,
} from '@/lib/email-tool/cold-constants';

// ── env: load .env.local so the script works however it's invoked ────────────
function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val; // real shell env wins
  }
}
loadEnvLocal();

// ── config ───────────────────────────────────────────────────────────────────
const OUT_DIR = path.join(process.cwd(), 'batch-test-output');
const LEADS = Number(process.env.BATCH_LEADS ?? 12);
const RUNS = Number(process.env.BATCH_RUNS ?? 2);
const CAP_USD = Number(process.env.BATCH_CAP_USD ?? 10);
const SIZES = (process.env.BATCH_SIZES ?? '1,2,3,4').split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 4);
const DRYRUN = process.env.DRYRUN === '1';
const STRENGTH = 0.35; // same as prod
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── tiny utils ────────────────────────────────────────────────────────────────
const slugify = (s: string) => (s || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lead';
const dataUrlToBuffer = (u: string) => Buffer.from(u.replace(/^data:[^;]+;base64,/, ''), 'base64');
const bufToDataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

interface Lead { first: string; company: string; slug: string }

// ── fixture: hardest leads from the pitchbook CSV (long/multi-word companies) ──
function loadLeads(): Lead[] {
  const csv = path.join(process.cwd(), 'pitchbook_cleaned_final.csv');
  const lines = readFileSync(csv, 'utf8').split('\n').slice(1).filter(Boolean);
  const seen = new Set<string>();
  const rows: Lead[] = [];
  for (const line of lines) {
    // Parse from the right — email/first/contact have no commas; company might.
    const parts = line.split(',');
    if (parts.length < 4) continue;
    parts.pop();                       // email
    const first = boardName(parts.pop() || '');   // "First Name"
    parts.pop();                       // contact (full name)
    const company = boardName(parts.join(','));    // company (cleaned like prod)
    if (!first || !company) continue;
    const key = `${first}|${company}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ first, company, slug: slugify(`${first}-${company}`) });
  }
  // Hardest first: more words + longer name = more chances for the model to slip.
  rows.sort((a, b) => (b.company.split(' ').length * 10 + b.company.length) - (a.company.split(' ').length * 10 + a.company.length));
  return rows.slice(0, LEADS);
}

// ── montage geometry: cell labels + proportional crop rects per batch size ─────
function layout(n: number): { cols: number; rows: number; labels: string[]; gridDesc: string } {
  if (n === 1) return { cols: 1, rows: 1, labels: ['the photo'], gridDesc: 'a single copy' };
  if (n === 2) return { cols: 2, rows: 1, labels: ['the LEFT photo', 'the RIGHT photo'], gridDesc: 'two side-by-side copies (left, right)' };
  if (n === 3) return { cols: 3, rows: 1, labels: ['the LEFT photo', 'the MIDDLE photo', 'the RIGHT photo'], gridDesc: 'three side-by-side copies (left, middle, right)' };
  return { cols: 2, rows: 2, labels: ['the TOP-LEFT photo', 'the TOP-RIGHT photo', 'the BOTTOM-LEFT photo', 'the BOTTOM-RIGHT photo'], gridDesc: 'four copies in a 2-by-2 grid' };
}
const cellIndex = (i: number, cols: number) => ({ row: Math.floor(i / cols), col: i % cols });

// Build an N-up montage of the base photo (sharp composite).
async function buildMontage(base: Buffer, n: number): Promise<Buffer> {
  if (n === 1) return base;
  const { cols, rows } = layout(n);
  const meta = await sharp(base).metadata();
  const w = meta.width!, h = meta.height!;
  const composites = [];
  for (let i = 0; i < n; i++) {
    const { row, col } = cellIndex(i, cols);
    composites.push({ input: base, left: col * w, top: row * h });
  }
  return sharp({ create: { width: cols * w, height: rows * h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(composites).png().toBuffer();
}

// Crop the returned grid into per-cell buffers BY PROPORTION of the real returned
// dimensions (the model may resize), then compress like prod (720px JPEG).
async function cropCells(returned: Buffer, n: number): Promise<Buffer[]> {
  if (n === 1) return [await compressImage(returned)];
  const { cols, rows } = layout(n);
  const meta = await sharp(returned).metadata();
  const W = meta.width!, H = meta.height!;
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const { row, col } = cellIndex(i, cols);
    const left = col * cw, top = row * ch;
    const width = Math.min(cw, W - left), height = Math.min(ch, H - top);
    const cell = await sharp(returned).extract({ left, top, width, height }).png().toBuffer();
    out.push(await compressImage(cell));
  }
  return out;
}

// ── prompt for an N-board montage (mirrors the single-board prompt's strictness) ─
function buildMontagePrompt(group: Lead[]): string {
  const { gridDesc, labels } = layout(group.length);
  const edits = group.map((g, i) =>
    `- In ${labels[i]}, the whiteboard must read EXACTLY: "${expectedBoard(g.first, g.company)}" (spell the company letter for letter: ${spellOut(boardName(g.company))})`
  ).join('\n');
  return `This image contains ${gridDesc} of the SAME photo: two students holding a small whiteboard whose note currently reads "Hey Bob, We are students interested in learning how product work is done at Acme Corp. Thank You!".
Edit ONLY the whiteboard text in each copy. Change nothing else — same two people, room, handwriting style, marker, size, and layout. Each copy is independent: do NOT let one board's text appear on another, and keep all ${group.length} copies in the same positions.
Make these exact edits:
${edits}
Keep every other word on every board EXACTLY as written — do not drop, merge, add, or misspell any word (keep the words "done" and "at").`;
}

// ── OpenRouter image call with REAL cost (usage.include + generation fallback) ──
let spent = 0;
interface GenResult { dataUrl: string; cost: number; model: string; dims: string }

async function genImage(prompt: string, referenceDataUrl: string): Promise<GenResult> {
  const models = [VISUAL_IMAGE_MODEL, ...VISUAL_IMAGE_FALLBACKS];
  let lastErr: Error | null = null;
  for (const model of models) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Proxi CRM batch-test',
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
        if (/^(429|5\d\d)/.test(String(res.status))) { lastErr = e; continue; } // fall through ladder
        throw e;
      }
      const data = await res.json();
      const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) { lastErr = new Error(`no image (model=${model})`); continue; }
      let cost = Number(data.usage?.cost ?? NaN);
      if (!Number.isFinite(cost) && data.id) cost = await fetchGenerationCost(String(data.id));
      if (!Number.isFinite(cost)) cost = IMAGE_GEN_COST_USD; // last-resort estimate (flagged in report)
      const dims = await sharp(dataUrlToBuffer(url)).metadata().then(m => `${m.width}x${m.height}`).catch(() => '??');
      return { dataUrl: url, cost, model, dims };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('image gen failed');
}

async function fetchGenerationCost(id: string): Promise<number> {
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/generation?id=${id}`, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    if (!r.ok) return NaN;
    const j = await r.json();
    return Number(j.data?.total_cost ?? NaN);
  } catch { return NaN; }
}

// ── per-batch-size accumulator ─────────────────────────────────────────────────
interface Stat { size: number; calls: number; genCost: number; boards: number; correct: number; fails: { lead: string; reason: string }[]; dims: Set<string> }
const stats = new Map<number, Stat>();
const stat = (n: number): Stat => {
  if (!stats.has(n)) stats.set(n, { size: n, calls: 0, genCost: 0, boards: 0, correct: 0, fails: [], dims: new Set() });
  return stats.get(n)!;
};

function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

// ── process one group (N leads) for one run ────────────────────────────────────
async function processGroup(base: Buffer, baseDataUrl: string, group: Lead[], run: number, gi: number): Promise<void> {
  const n = group.length;
  const s = stat(n);
  const dir = path.join(OUT_DIR, `batch-${n}`);
  ensureDir(dir);

  let returned: Buffer;
  if (DRYRUN) {
    returned = await buildMontage(base, n); // stand-in grid — proves crop/validate plumbing for $0
  } else {
    // cap guard: reserve a generous per-call estimate before spending
    if (spent + 0.30 > CAP_USD) { console.log(`  [cap] would exceed $${CAP_USD} (spent $${round2(spent)}) — stopping`); throw new Error('SPEND_CAP'); }
    const prompt = n === 1 ? buildImagePrompt(group[0].first, group[0].company) : buildMontagePrompt(group);
    const reference = n === 1 ? baseDataUrl : bufToDataUrl(await buildMontage(base, n));
    const g = await genImage(prompt, reference);
    spent += g.cost;
    s.calls++; s.genCost += g.cost; s.dims.add(g.dims);
    returned = dataUrlToBuffer(g.dataUrl);
    writeFileSync(path.join(dir, `_raw_g${gi}_run${run}.png`), returned);
    console.log(`  batch-${n} run${run} g${gi} → ${g.model.split('/').pop()} ${g.dims} $${round4(g.cost)} | total $${round2(spent)}`);
  }

  const cells = await cropCells(returned, n);
  for (let i = 0; i < n; i++) {
    const lead = group[i];
    writeFileSync(path.join(dir, `${lead.slug}_run${run}.jpg`), cells[i]);
    s.boards++;
    if (DRYRUN) continue; // no vision spend in dry run
    const v = await whiteboardNeedsRedo(bufToDataUrl(cells[i], 'image/jpeg'), lead.first, lead.company);
    if (v.redo) s.fails.push({ lead: `${lead.first} @ ${lead.company}`, reason: v.reason });
    else s.correct++;
  }
}

// ── report ─────────────────────────────────────────────────────────────────────
function writeReport(leads: Lead[]) {
  const baseline = stats.get(1);
  const baseCostPerBoard = baseline && baseline.boards ? baseline.genCost / baseline.boards : IMAGE_GEN_COST_USD;
  const lines: string[] = [];
  lines.push('# Visual-outreach image-batching test\n');
  lines.push(`Model: \`${VISUAL_IMAGE_MODEL}\` · leads: ${leads.length} · runs: ${RUNS} · spent: **$${round2(spent)}** / cap $${CAP_USD}${DRYRUN ? ' · **DRY RUN (no API calls)**' : ''}\n`);
  lines.push(`Baseline (batch-1) real cost/board: **$${round4(baseCostPerBoard)}** → that's $${round2(baseCostPerBoard * 600)}/day at 600 imgs/day.\n`);
  lines.push('| batch | calls | boards | correct | correct % | $/call | $/board (gen) | net $/correct board¹ | proj $/day @600 | vs baseline |');
  lines.push('|------:|------:|-------:|--------:|----------:|-------:|--------------:|---------------------:|----------------:|------------:|');
  for (const n of [...stats.keys()].sort((a, b) => a - b)) {
    const s = stats.get(n)!;
    const pct = s.boards ? (100 * s.correct / s.boards) : 0;
    const perCall = s.calls ? s.genCost / s.calls : 0;
    const perBoard = s.boards ? s.genCost / s.boards : 0;
    const fails = s.boards - s.correct;
    const net = s.boards ? (s.genCost + fails * baseCostPerBoard) / s.boards : 0; // +1 single-image retry per failed board
    const proj = net * 600;
    const vs = baseCostPerBoard ? `${round2(net / baseCostPerBoard)}x` : '—';
    const flag = DRYRUN ? '' : (pct >= 99 ? ' ✅' : pct >= 95 ? ' ⚠️' : ' ❌');
    lines.push(`| ${n}${flag} | ${s.calls} | ${s.boards} | ${s.correct} | ${round2(pct)}% | $${round4(perCall)} | $${round4(perBoard)} | $${round4(net)} | $${round2(proj)} | ${vs} |`);
  }
  lines.push('\n¹ net = generation cost + one single-image retry (at baseline cost) for every failed board, i.e. the true cost to ship an all-correct batch. Lower than baseline = real savings.\n');
  lines.push('Returned image dimensions per batch size: ' + [...stats.keys()].sort((a, b) => a - b).map(n => `b${n}=[${[...stats.get(n)!.dims].join(', ') || '—'}]`).join(' · ') + '\n');
  if (!DRYRUN) {
    lines.push('## Failures (eyeball these crops in batch-<n>/ before trusting the validator)\n');
    let any = false;
    for (const n of [...stats.keys()].sort((a, b) => a - b)) {
      for (const f of stats.get(n)!.fails) { lines.push(`- batch-${n}: **${f.lead}** — ${f.reason}`); any = true; }
    }
    if (!any) lines.push('_none — every board passed both validators._');
  }
  lines.push('\n## Read it\n1. The vision validator can mis-grade — open `batch-2|3|4/*.jpg` and confirm by eye, especially anything flagged.\n2. Pick the largest batch size that clears ~99% correct AND beats baseline on net $/correct board.\n3. `_raw_g*_run*.png` are the full grids Gemini returned — check it actually honored the layout.\n');
  const report = lines.join('\n');
  writeFileSync(path.join(OUT_DIR, 'report.md'), report);
  console.log('\n' + report);
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  ensureDir(OUT_DIR);
  if (!DRYRUN && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set (in .env.local or shell)');

  // base photo — cache locally so reruns are offline
  const basePath = path.join(OUT_DIR, '_founders.png');
  let base: Buffer;
  if (existsSync(basePath)) {
    base = readFileSync(basePath);
    console.log('[base] using cached _founders.png');
  } else {
    console.log('[base] downloading founders.png from Supabase…');
    const supabase = createAdminClient();
    const { data, error } = await supabase.storage.from(OUTREACH_IMAGE_BUCKET).download(OUTREACH_REFERENCE_KEY);
    if (error || !data) throw new Error(`could not download reference photo: ${error?.message}`);
    base = Buffer.from(await data.arrayBuffer());
    writeFileSync(basePath, base);
  }
  const bMeta = await sharp(base).metadata();
  const baseDataUrl = bufToDataUrl(base, 'image/png');
  console.log(`[base] ${bMeta.width}x${bMeta.height}`);

  const leads = loadLeads();
  console.log(`[fixture] ${leads.length} leads (hardest companies first): ${leads.map(l => l.company).join(' | ')}`);

  // Order: run-by-run, all batch sizes per run — so even if the cap stops run 2,
  // run 1 already holds a complete dataset across every batch size.
  try {
    for (let run = 1; run <= RUNS; run++) {
      for (const n of SIZES) {
        const groups = Math.floor(leads.length / n);
        const used = groups * n;
        if (used < leads.length) console.log(`  [batch-${n}] dropping ${leads.length - used} leftover lead(s) (not divisible by ${n})`);
        for (let gi = 0; gi < groups; gi++) {
          await processGroup(base, baseDataUrl, leads.slice(gi * n, gi * n + n), run, gi);
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'SPEND_CAP') console.log('[stopped early at spend cap — reporting what we have]');
    else throw e;
  }

  writeReport(leads);
}

main().catch(err => { console.error(err); process.exit(1); });
