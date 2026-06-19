// Duo (batch-2) PROMPT comparison. The 2-up approach is chosen; the open problem
// is style drift — the model sometimes re-letters the whole board (looks AI),
// neatens it, or makes the ink darker/bolder/wrong-color. This harness tries 5
// prompt variants that each push hard on two rules: (1) change ONLY 4 things
// (name1, name2, company1, company2) and (2) match the ORIGINAL handwriting
// (color, weight, messiness). Same 3 duos through every prompt → apples-to-apples.
//
// 5 prompts × 3 duos = 15 image calls (~$1), no validation calls (you judge by eye).
// Output → prompt-test-output/prompt-N/  (grids + split boards + the prompt text).
//
// Run: npx tsx scripts/visual-prompt-test.ts

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createAdminClient } from '@/lib/supabase/admin';
import { compressImage, expectedBoard, spellOut, boardName } from '@/lib/ai/visual-draft';
import { VISUAL_IMAGE_MODEL, VISUAL_IMAGE_FALLBACKS, OUTREACH_IMAGE_BUCKET, OUTREACH_REFERENCE_KEY, IMAGE_GEN_COST_USD } from '@/lib/email-tool/cold-constants';

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();

const OUT_DIR = path.join(process.cwd(), 'prompt-test-output');
const CACHE_BASE = path.join(process.cwd(), 'batch-test-output', '_founders.png'); // reuse the cached photo
const CAP_USD = Number(process.env.PROMPT_CAP_USD ?? 4);
const CONCURRENCY = Number(process.env.PROMPT_CONCURRENCY ?? 4);
const STRENGTH = 0.35;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const slugify = (s: string) => (s || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'lead';
const dataUrlToBuffer = (u: string) => Buffer.from(u.replace(/^data:[^;]+;base64,/, ''), 'base64');
const bufToDataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

interface Lead { first: string; company: string; slug: string }
type Duo = [Lead, Lead];

// ── fixture: 6 leads spread across hardness, paired long+short per duo ──────────
function loadDuos(): Duo[] {
  const lines = readFileSync(path.join(process.cwd(), 'pitchbook_cleaned_final.csv'), 'utf8').split('\n').slice(1).filter(Boolean);
  const seen = new Set<string>(); const rows: Lead[] = [];
  for (const line of lines) {
    const parts = line.split(','); if (parts.length < 4) continue;
    parts.pop(); const first = boardName(parts.pop() || ''); parts.pop(); const company = boardName(parts.join(','));
    if (!first || !company) continue;
    const key = `${first}|${company}`.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    rows.push({ first, company, slug: slugify(`${first}-${company}`) });
  }
  rows.sort((a, b) => (b.company.split(' ').length * 10 + b.company.length) - (a.company.split(' ').length * 10 + a.company.length));
  const M = rows.length;
  const pick = (k: number) => rows[Math.round((k * (M - 1)) / 5)]; // spread hardest→easiest
  const six = [pick(0), pick(1), pick(2), pick(3), pick(4), pick(5)];
  return [[six[0], six[5]], [six[1], six[4]], [six[2], six[3]]]; // each duo = harder + easier
}

// ── the 5 prompt variants ──────────────────────────────────────────────────────
const tgt = (g: Lead) => expectedBoard(g.first, g.company);
const spell = (g: Lead) => spellOut(boardName(g.company));
const PLACEHOLDER = 'Hey Bob, We are students interested in learning how product work is done at Acme Corp. Thank You!';

const PROMPTS: { id: string; label: string; build: (d: Duo) => string }[] = [
  {
    id: '1', label: 'surgical-swap',
    build: ([L, R]) => `This image shows two side-by-side copies (LEFT and RIGHT) of the SAME photo: two students holding a small whiteboard. Both boards currently read: "${PLACEHOLDER}".
This is a surgical text swap, NOT a rewrite. Leave every existing pen stroke exactly as it is. Only erase and re-write 4 short spans — the name after "Hey" and the company after "at", on each board — and write the new words in the SAME handwriting: same dry-erase marker color, same stroke thickness, same casual uneven slant, same slightly-messy baseline. Do not re-letter, bold, darken, neaten, or recolor any word.
- LEFT board must read EXACTLY: "${tgt(L)}" (company spelled letter-for-letter: ${spell(L)})
- RIGHT board must read EXACTLY: "${tgt(R)}" (company spelled letter-for-letter: ${spell(R)})
Change ONLY those 4 things. Keep all other words (including "done" and "at") exactly as already written, and keep both people, the marker, and the room identical.`,
  },
  {
    id: '2', label: 'same-hand-style',
    build: ([L, R]) => `Two copies of one photo, LEFT and RIGHT — two students holding a whiteboard that reads "${PLACEHOLDER}".
Personalize each whiteboard, but it must look like the SAME person wrote it in the SAME sitting. Match the original handwriting precisely: the dark grey dry-erase marker color (not pure black, not bold), the thin uneven strokes, the relaxed messy print, the slightly crooked lines. The replaced words must be indistinguishable in style from the words around them — a little sloppy and hand-drawn, never typed, neat, or darker.
Only 4 values change: name1, name2, company1, company2.
- LEFT reads EXACTLY: "${tgt(L)}"  (spell company: ${spell(L)})
- RIGHT reads EXACTLY: "${tgt(R)}"  (spell company: ${spell(R)})
Everything else on both boards stays the exact same handwriting, and the two people and room are unchanged.`,
  },
  {
    id: '3', label: 'negatives-first',
    build: ([L, R]) => `Two side-by-side copies (LEFT, RIGHT) of the same student whiteboard photo. Current note on both: "${PLACEHOLDER}".
DO NOT: retype the board in a clean or neat font; make the ink bolder, darker, or a different color; straighten or tidy the lines; or rewrite any word that isn't changing. The handwriting must stay messy, thin, and human, in the original marker color.
DO: change only these 4 spans — name1, name2 (after "Hey") and company1, company2 (after "at") — writing them in that same loose handwriting.
- LEFT must read EXACTLY: "${tgt(L)}"  (company letter-for-letter: ${spell(L)})
- RIGHT must read EXACTLY: "${tgt(R)}"  (company letter-for-letter: ${spell(R)})
Keep "done", "at", and every other word exactly as handwritten, and keep the people and scene unchanged.`,
  },
  {
    id: '4', label: 'template-fields',
    build: ([L, R]) => `The image is two copies (LEFT and RIGHT) of one photo of two students holding a small whiteboard. The whiteboard text is a fixed template with only 4 fill-in fields across the two boards:
"Hey {NAME}, We are students interested in learning how product work is done at {COMPANY}. Thank You!"
Fill the fields for each copy and change NOTHING else. The {NAME} and {COMPANY} you write must copy the existing handwriting style exactly — same marker color, same thin uneven weight, same casual messy slant — so they blend in. Do not bold, darken, neaten, or restyle the text.
- LEFT: NAME = ${boardName(L.first)}, COMPANY = ${boardName(L.company)} → reads EXACTLY "${tgt(L)}" (spell: ${spell(L)})
- RIGHT: NAME = ${boardName(R.first)}, COMPANY = ${boardName(R.company)} → reads EXACTLY "${tgt(R)}" (spell: ${spell(R)})
Only those 4 fields differ from the original. Keep the rest of the handwriting, the two people, and the room identical.`,
  },
  {
    id: '5', label: 'combined-strongest',
    build: ([L, R]) => `Two side-by-side copies (LEFT and RIGHT) of the SAME photo: two students holding a small whiteboard reading "${PLACEHOLDER}".
Make a minimal, surgical edit — exactly 4 changes total: the name after "Hey" and the company after "at", on EACH board. Write the new words in the identical handwriting already on the board: same dry-erase marker color (dark grey, not black or bold), same thin and slightly shaky strokes, same relaxed messy hand, same crooked baseline. The result must look photographed, not AI-generated — no clean fonts, no bold or darker ink, no recoloring, no re-lettering of untouched words.
- LEFT board reads EXACTLY: "${tgt(L)}"  (company spelled letter-for-letter: ${spell(L)})
- RIGHT board reads EXACTLY: "${tgt(R)}"  (company spelled letter-for-letter: ${spell(R)})
Keep every other word (especially "done" and "at"), both people, the marker, and the room exactly as in the original.`,
  },
];

// ── 2-up montage (built once) ──────────────────────────────────────────────────
async function buildMontage2(base: Buffer): Promise<Buffer> {
  const m = await sharp(base).metadata(); const w = m.width!, h = m.height!;
  return sharp({ create: { width: 2 * w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: base, left: 0, top: 0 }, { input: base, left: w, top: 0 }]).png().toBuffer();
}
async function cropHalves(returned: Buffer): Promise<[Buffer, Buffer]> {
  const m = await sharp(returned).metadata(); const W = m.width!, H = m.height!; const cw = Math.floor(W / 2);
  const left = await sharp(returned).extract({ left: 0, top: 0, width: cw, height: H }).png().toBuffer();
  const right = await sharp(returned).extract({ left: cw, top: 0, width: W - cw, height: H }).png().toBuffer();
  return [await compressImage(left), await compressImage(right)];
}

// ── OpenRouter image call with real cost ────────────────────────────────────────
let spent = 0;
async function genImage(prompt: string, referenceDataUrl: string): Promise<{ dataUrl: string; cost: number; dims: string }> {
  for (const model of [VISUAL_IMAGE_MODEL, ...VISUAL_IMAGE_FALLBACKS]) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'Proxi prompt-test' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: referenceDataUrl } }] }], modalities: ['image', 'text'], image_config: { strength: STRENGTH }, usage: { include: true } }),
      });
      if (!res.ok) { if (/^(429|5\d\d)/.test(String(res.status))) continue; throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 120)}`); }
      const data = await res.json();
      const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) continue;
      let cost = Number(data.usage?.cost ?? NaN);
      if (!Number.isFinite(cost) && data.id) { try { const r = await fetch(`https://openrouter.ai/api/v1/generation?id=${data.id}`, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } }); if (r.ok) cost = Number((await r.json()).data?.total_cost ?? NaN); } catch {} }
      if (!Number.isFinite(cost)) cost = IMAGE_GEN_COST_USD;
      const dims = await sharp(dataUrlToBuffer(url)).metadata().then(m => `${m.width}x${m.height}`).catch(() => '??');
      return { dataUrl: url, cost, dims };
    } catch (e) { /* try next model */ }
  }
  throw new Error('image gen failed (all models)');
}

function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

async function main() {
  ensureDir(OUT_DIR);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');

  let base: Buffer;
  if (existsSync(CACHE_BASE)) { base = readFileSync(CACHE_BASE); console.log('[base] using cached founders.png'); }
  else { console.log('[base] downloading…'); const sb = createAdminClient(); const { data, error } = await sb.storage.from(OUTREACH_IMAGE_BUCKET).download(OUTREACH_REFERENCE_KEY); if (error || !data) throw new Error('reference download failed'); base = Buffer.from(await data.arrayBuffer()); ensureDir(path.dirname(CACHE_BASE)); writeFileSync(CACHE_BASE, base); }

  const referenceDataUrl = bufToDataUrl(await buildMontage2(base));
  const duos = loadDuos();
  console.log('[duos] (same 3 across all prompts):');
  duos.forEach((d, i) => console.log(`  duo${i}: ${d[0].first}/${d[0].company}  +  ${d[1].first}/${d[1].company}`));

  // write each prompt's text (using duo0) + leads manifest for the gallery
  for (const p of PROMPTS) { const dir = path.join(OUT_DIR, `prompt-${p.id}`); ensureDir(dir); writeFileSync(path.join(dir, '_prompt.txt'), `[P${p.id} — ${p.label}]\n\n${p.build(duos[0])}`); }

  // task list: every (prompt, duo); run with a small concurrency pool + cap
  const tasks: { p: typeof PROMPTS[number]; d: Duo; di: number }[] = [];
  for (const p of PROMPTS) for (let di = 0; di < duos.length; di++) tasks.push({ p, d: duos[di], di });
  const estTotal = tasks.length * 0.08;
  console.log(`[plan] ${tasks.length} images, ~$${round2(estTotal)} est (cap $${CAP_USD}), concurrency ${CONCURRENCY}`);
  if (estTotal > CAP_USD) throw new Error('estimate exceeds cap — raise PROMPT_CAP_USD');

  let next = 0, done = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++; const { p, d, di } = tasks[i];
      if (spent + 0.30 > CAP_USD) { console.log(`  [cap] stop (spent $${round2(spent)})`); return; }
      try {
        const g = await genImage(p.build(d), referenceDataUrl);
        spent += g.cost; done++;
        const dir = path.join(OUT_DIR, `prompt-${p.id}`);
        const grid = dataUrlToBuffer(g.dataUrl);
        writeFileSync(path.join(dir, `duo${di}_grid.png`), grid);
        const [left, right] = await cropHalves(grid);
        writeFileSync(path.join(dir, `duo${di}_L_${d[0].slug}.jpg`), left);
        writeFileSync(path.join(dir, `duo${di}_R_${d[1].slug}.jpg`), right);
        console.log(`  [${done}/${tasks.length}] P${p.id}/${p.label} duo${di} ${g.dims} $${round4(g.cost)} | total $${round2(spent)}`);
      } catch (e) { console.log(`  P${p.id} duo${di} FAILED: ${e instanceof Error ? e.message : e}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
  console.log(`\n[done] ${done} images · spent $${round2(spent)} → prompt-test-output/`);
}

main().catch(e => { console.error(e); process.exit(1); });
