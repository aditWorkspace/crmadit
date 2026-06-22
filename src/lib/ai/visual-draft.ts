// Visual-outreach v2 engine. One call = one draft, end to end:
//
//   1. light industry lookup (Firecrawl homepage if available, else model-only)
//   2. per-person whiteboard image (edit the founders' reference photo: change
//      only the name/company text) → upload to public Storage
//   3. build the short HTML email + the landing_pages row (headline/blurb/CTA)
//
// Reuses the existing draft worker / queue / tick / send infra unchanged — it
// only swaps content generation. Keeps the DraftOutcome contract so the worker
// persist path stays the same (plus the new image_url/page_slug/email_html/
// industry fields). Provider failures return { kind: 'retry' }, never a silent
// half-built draft.

import sharp from 'sharp';
import { createAdminClient } from '@/lib/supabase/admin';
import { callAIMessages, generateImage, callVision } from './openrouter';
import { tolerantJsonParse } from './json';
import { scrapeUrl, FirecrawlError } from '@/lib/external/firecrawl';
import { deriveDomain, type DraftInput, type DraftOutcome } from './cold-research';
import {
  FIRECRAWL_SCRAPE_COST_USD,
  LLM_INDUSTRY_COST_USD,
  IMAGE_GEN_COST_USD,
  VISUAL_IMAGE_MODEL,
  VISUAL_IMAGE_FALLBACKS,
  WHITEBOARD_DETECTOR_PRIMARY,
  WHITEBOARD_DETECTOR_CONFIRM,
  VISUAL_INDUSTRY_MODEL,
  VISUAL_INDUSTRY_FALLBACKS,
  OUTREACH_IMAGE_BUCKET,
  OUTREACH_REFERENCE_KEY,
  CAL_BOOKING_URL,
  VISUAL_SUBJECT,
} from '@/lib/email-tool/cold-constants';

type Supa = ReturnType<typeof createAdminClient>;

// ── Small pure helpers ──────────────────────────────────────────────────────

export function firstName(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || full;
}

/** The OTHER founder's first name (only Adit + Asim send). */
export function partnerFirstName(senderName: string): string {
  const f = firstName(senderName).toLowerCase();
  if (f === 'adit') return 'Asim';
  if (f === 'asim') return 'Adit';
  return 'Asim'; // safe default; only Adit/Asim are active senders
}

export function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Clean `{first}-{last}` slug. Idempotent per recipient (re-runs reuse the same
 *  slug + landing_pages row). On a genuine collision with a DIFFERENT recipient,
 *  appends -2, -3, … (the table itself is not publicly readable and the page
 *  exposes no email, so guessability is low-risk). */
async function buildSlug(supabase: Supa, first: string, last: string, email: string): Promise<string> {
  const base = slugify(`${first} ${last}`.trim()) || slugify(first) || 'there';
  const emailLc = email.toLowerCase();
  for (let n = 1; n <= 20; n++) {
    const cand = n === 1 ? base : `${base}-${n}`;
    const { data } = await supabase.from('landing_pages').select('recipient_email').eq('slug', cand).maybeSingle();
    if (!data || (data as { recipient_email: string }).recipient_email.toLowerCase() === emailLc) return cand;
  }
  return `${base}-${emailLc.split('@')[0]}`; // extreme fallback (20 same-named collisions)
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(b64, 'base64');
}

function pagesBaseUrl(): string {
  return (process.env.LANDING_PAGES_BASE_URL || 'https://pages.example.com').replace(/\/$/, '');
}

async function setStatus(supabase: Supa, id: string, status: string): Promise<void> {
  await supabase.from('cold_email_drafts').update({ status }).eq('id', id);
}

// ── 1) Industry lookup ──────────────────────────────────────────────────────

const INDUSTRY_SYSTEM = `You identify the SPECIFIC industry/vertical a company serves. Your answer fills two cold-outreach lines:
  "we're trying to understand how {industry} teams like {company} decide what to build next"
  "we've been talking to product leaders in {industry}"
Return ONLY JSON: {"industry": string, "descriptor": string}.

"industry": a specific lowercase vertical, 1-3 words, that reads naturally before "teams" and after "in". Usually <domain> + software/tech/apps. Examples:
construction software, food delivery, fintech, developer tools, healthtech, legal tech, real estate software, logistics, cybersecurity, e-commerce, hr software, insurance tech, video editing, gaming, ad tech, supply chain, biotech, edtech, climate tech, robotics, sales software, marketing automation, customer support software, data infrastructure, crypto, manufacturing software, hospitality tech, travel tech, accounting software, property management, telehealth, fitness apps, agtech, energy software, govtech, design tools, restaurant software, fleet management, recruiting software.
Rules:
- NEVER answer with a bare generic word: not "product", "software", "technology", "tech", "saas", "platform", "app", "startup", "business", "tools", or "services". Always name the actual domain they serve.
- Keep it short and natural before "teams": say "telehealth", not "telehealth platforms"; "crypto", not "crypto rewards".
- Use the website text first; if it is thin or missing, infer from the company name + domain.
- Only return "" if you genuinely cannot make a reasonable guess.

"descriptor": one plain factual sentence about what the company does. No marketing fluff.`;

interface IndustryResult { industry: string; descriptor: string; scrapeUsed: boolean; }

const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const GENERIC_INDUSTRY = new Set(['product', 'software', 'technology', 'tech', 'saas', 'platform', 'app', 'apps', 'startup', 'business', 'tools', 'services', 'unknown', '']);

// Pull the useful text out of raw homepage HTML: <title>, meta/og descriptions,
// then de-tagged body. Enough signal for an industry classifier.
function htmlToText(html: string): string {
  const pick = (re: RegExp) => { const m = html.match(re); return m ? m[1].trim() : ''; };
  const title = pick(/<title[^>]*>([^<]+)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  const og = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return [title && `Title: ${title}`, desc && `Meta: ${desc}`, og && `OG: ${og}`, body.slice(0, 3800)]
    .filter(Boolean).join('\n');
}

// Homepage text for grounding: Firecrawl first (renders JS), then a free plain
// fetch fallback (works for most static / meta-rich sites). Either may come back
// empty — the classifier then infers from the company name + domain.
async function fetchHomepageText(domain: string): Promise<{ text: string; used: boolean }> {
  if (!domain) return { text: '', used: false };
  try {
    const md = await scrapeUrl(`https://${domain}`);
    if (md && md.trim().length > 80) return { text: md.slice(0, 6000), used: true };
  } catch (err) {
    console.warn('[visual-draft] firecrawl scrape failed, trying plain fetch:', err instanceof Error ? err.message.slice(0, 100) : String(err));
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`https://${domain}`, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': FETCH_UA } });
      if (res.ok) {
        const text = htmlToText(await res.text());
        if (text.trim().length > 40) return { text: text.slice(0, 6000), used: true };
      }
    } finally { clearTimeout(timer); }
  } catch { /* ignore — fall through to name/domain inference */ }
  return { text: '', used: false };
}

async function classifyIndustry(company: string, domain: string, text: string): Promise<{ industry: string; descriptor: string }> {
  const user = `Company: ${company || 'unknown'}\nDomain: ${domain || 'unknown'}\n\nWebsite text:\n${text || '(none — infer from the company name + domain)'}`;
  const raw = await callAIMessages({
    model: VISUAL_INDUSTRY_MODEL,
    fallbackModels: VISUAL_INDUSTRY_FALLBACKS,
    jsonMode: true,
    maxTokens: 200,
    timeoutMs: 30_000,
    messages: [{ role: 'system', content: INDUSTRY_SYSTEM }, { role: 'user', content: user }],
  });
  const parsed = tolerantJsonParse(raw) as { industry?: string; descriptor?: string };
  let industry = String(parsed.industry ?? '').toLowerCase().trim().slice(0, 40);
  if (GENERIC_INDUSTRY.has(industry)) industry = ''; // reject the generic fallbacks outright
  const descriptor = String(parsed.descriptor ?? '').trim().slice(0, 240);
  return { industry, descriptor };
}

// opts.refresh bypasses the per-domain cache (used by the industry backfill).
export async function resolveIndustry(supabase: Supa, domain: string, company: string, opts: { refresh?: boolean } = {}): Promise<IndustryResult> {
  // Cache hit (per domain). A cached value is always a real, specific industry —
  // we never cache the empty fallback, so a past failure re-tries next time.
  if (domain && !opts.refresh) {
    const { data: cached } = await supabase
      .from('company_research_cache').select('industry').eq('domain', domain).maybeSingle();
    const ind = (cached as { industry?: string } | null)?.industry;
    if (ind && !GENERIC_INDUSTRY.has(ind.toLowerCase().trim())) return { industry: ind, descriptor: '', scrapeUsed: false };
  }

  const { text, used } = await fetchHomepageText(domain);

  // Classify with one retry. A transient model failure must NOT silently become
  // the generic "product" fallback — that was the bug that made ~1/5 of leads
  // read "product leaders in product".
  let industry = '';
  let descriptor = '';
  for (let attempt = 0; attempt < 2 && !industry; attempt++) {
    try {
      const r = await classifyIndustry(company, domain, text);
      industry = r.industry; descriptor = r.descriptor;
    } catch (err) {
      console.warn(`[visual-draft] industry classify attempt ${attempt + 1} failed:`, err instanceof Error ? err.message.slice(0, 100) : String(err));
    }
  }

  // Cache only a real result, so a failure retries next time instead of sticking.
  if (domain && industry) {
    await supabase.from('company_research_cache').upsert(
      { domain, industry, cached_at: new Date().toISOString() }, { onConflict: 'domain' },
    );
  }
  return { industry, descriptor, scrapeUsed: used };
}

// ── 2) Per-person image ─────────────────────────────────────────────────────

/** Load the founders' reference whiteboard photo as a base64 data URL.
 *  Storage key first, then an optional public URL env, else null (skip image). */
let _referenceCache: string | null = null;
async function loadReferenceImage(supabase: Supa): Promise<string | null> {
  if (_referenceCache) return _referenceCache; // static asset — cache the base64
  try {
    const { data, error } = await supabase.storage.from(OUTREACH_IMAGE_BUCKET).download(OUTREACH_REFERENCE_KEY);
    if (!error && data) {
      const buf = Buffer.from(await data.arrayBuffer());
      _referenceCache = `data:image/png;base64,${buf.toString('base64')}`;
      return _referenceCache;
    }
  } catch { /* fall through to env */ }
  const url = process.env.OUTREACH_REFERENCE_URL;
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        _referenceCache = `data:image/png;base64,${buf.toString('base64')}`;
        return _referenceCache;
      }
    } catch { /* none */ }
  }
  return null;
}

// Strip parenthetical noise ("XTECH (Recreational Goods)") + odd chars so the
// whiteboard never writes a category/ticker. Used for both the name and company.
export const boardName = (s: string) => (s || '').replace(/\s*\([^)]*\)/g, ' ').replace(/["'\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
// Spell a company letter-by-letter ("Memo Therapeutics" → "M-e-m-o   T-h-...") —
// this is what stopped the model from misspelling long company names.
export const spellOut = (s: string) => s.split(' ').filter(Boolean).map(w => w.split('').join('-')).join('   ');
// The exact text the base whiteboard should read once edited (the known formula).
export const expectedBoard = (first: string, company: string) =>
  `Hey ${boardName(first)}, We are students interested in learning how product work is done at ${boardName(company)}. Thank You!`;

// v2 prompt — Gemini 3.1 hits ~100% with this: name the two edits, give the
// EXACT target sentence, spell the company letter-for-letter, and forbid dropping
// any other word. (Tested 8/8 on the hard cases vs 3-4/8 for the old wording.)
export function buildImagePrompt(first: string, company: string): string {
  const name = boardName(first);
  const co = boardName(company);
  return `Edit this photo of two students holding a small whiteboard with a handwritten note. Make ONLY two text changes on the whiteboard, and change nothing else (same two people, room, handwriting style, marker, size, and layout):
1. Replace the first name written after "Hey" with: ${name}
2. Replace the company written after the word "at" (it currently says "Acme Corp") with: ${co}
Spell the company exactly, letter for letter: ${spellOut(co)}
Keep every other word on the board EXACTLY as written — do not drop, merge, add, or misspell any word (keep the words "done" and "at"). The whiteboard must read exactly:
"${expectedBoard(first, company)}"`;
}

// Retry prompt — a FRESH edit of the base photo (never built off the failed
// output) that states exactly what the previous attempt got wrong, plus stricter
// rules. Used only on attempt 2.
function buildRetryPrompt(first: string, company: string, reason: string): string {
  const name = boardName(first);
  const co = boardName(company);
  const note = reason ? `A previous edit was wrong (${reason}). ` : '';
  return `Edit this photo of two students holding a whiteboard. ${note}Redo it from this original photo so the whiteboard reads EXACTLY, with no missing or misspelled words:
"${expectedBoard(first, company)}"
Strict rules:
- Spell the company letter for letter: ${spellOut(co)}. Do not abbreviate, truncate, or drop any part of it.
- Replace the name after "Hey" with exactly: ${name}
- Keep EVERY other word, especially "done" and "at" — do not drop or merge words.
- Same handwriting style, same two people, same layout. Change nothing outside the whiteboard text.`;
}

// Normalize a company name for fuzzy comparison: drop common suffixes/filler
// Cheap one-shot text check: does the whiteboard match its exact expected text?
// We give a cheap vision model the target sentence and ask it to reply "done" or
// "WRONG: <what's off>". Vision reads handwriting far better than classical OCR.
// Returns the verdict + reason (the reason feeds a targeted retry). Leans toward
// "not wrong" on a vision error so a hiccup never forces a needless redo.
export async function detectWhiteboard(dataUrl: string, first: string, company: string, model: string): Promise<{ wrong: boolean; reason: string }> {
  try {
    const raw = ((await callVision({
      prompt: `The whiteboard in this image should read EXACTLY:\n"${expectedBoard(first, company)}"\n\nLook at the handwriting carefully. Reply with exactly the single word "done" if the first name and the company name are both spelled correctly and no words are missing or garbled. Ignore the word "Hey", punctuation, capitalization, and line breaks. Otherwise reply "WRONG:" followed by exactly what is misspelled, missing, or wrong.`,
      imageDataUrl: dataUrl, model, maxTokens: 60, timeoutMs: 25_000,
    })) || '').trim();
    const done = /^done\b/i.test(raw);
    return { wrong: !done, reason: raw.replace(/\n/g, ' ').slice(0, 200) };
  } catch {
    return { wrong: false, reason: '' };
  }
}

// Two independent cheap models must BOTH flag a board wrong before we redo it.
// Their false-positives don't overlap (lite trips on "UrgentIQ", flash on
// wrapped lines), so the agreement caught every real error with zero false-flags
// in calibration — important so we never needlessly skip a good lead.
export async function whiteboardNeedsRedo(dataUrl: string, first: string, company: string): Promise<{ redo: boolean; reason: string }> {
  const a = await detectWhiteboard(dataUrl, first, company, WHITEBOARD_DETECTOR_PRIMARY);
  if (!a.wrong) return { redo: false, reason: '' };
  const b = await detectWhiteboard(dataUrl, first, company, WHITEBOARD_DETECTOR_CONFIRM);
  return { redo: b.wrong, reason: [a.reason, b.reason].filter(Boolean).join(' / ') };
}

async function uploadImage(supabase: Supa, key: string, bytes: Buffer): Promise<string> {
  const contentType = /\.jpe?g$/i.test(key) ? 'image/jpeg' : 'image/png';
  const { error } = await supabase.storage.from(OUTREACH_IMAGE_BUCKET)
    .upload(key, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
  const { data } = supabase.storage.from(OUTREACH_IMAGE_BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/** Resize + JPEG-compress a model image (raw PNG is ~1.5MB) so it loads fast in
 *  the email + dashboard (~80-150KB). Falls back to the input on error. */
export async function compressImage(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input).resize({ width: 720, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  } catch { return input; }
}

/** Public URL of the founders' reference ("base") photo — shown in the dashboard
 *  regenerate panel so the sender can see what's being edited. */
export function referenceImageUrl(supabase: Supa): string {
  return supabase.storage.from(OUTREACH_IMAGE_BUCKET).getPublicUrl(OUTREACH_REFERENCE_KEY).data.publicUrl;
}

/** Regenerate the whiteboard image for a lead, optionally with extra free-text
 *  instructions from the dashboard. Uploads to `key` and returns the public URL.
 *  Does NOT touch the draft/page — the caller decides whether to apply it
 *  (so the sender can compare candidates and pick). Returns null if no reference
 *  photo is configured. */
export async function regenerateLeadImage(
  supabase: Supa,
  opts: { first: string; company: string; extraPrompt?: string; key: string },
): Promise<string | null> {
  const reference = await loadReferenceImage(supabase);
  if (!reference) return null;
  let prompt = buildImagePrompt(opts.first || 'there', opts.company || 'your company');
  if (opts.extraPrompt && opts.extraPrompt.trim()) {
    prompt += `\nExtra instructions from the sender (follow these too): ${opts.extraPrompt.trim().slice(0, 400)}`;
  }
  const dataUrl = await generateImage({
    prompt,
    referenceImages: [reference],
    model: VISUAL_IMAGE_MODEL,
    fallbackModels: VISUAL_IMAGE_FALLBACKS,
    strength: 0.35,
    timeoutMs: 90_000,
  });
  return uploadImage(supabase, opts.key, await compressImage(dataUrlToBuffer(dataUrl)));
}

/** Generate the per-lead whiteboard with a verify-and-retry loop and upload it
 *  to `${slug}.jpg`. The image model is stochastic about replacing the "Acme
 *  Corp"/"Bob" placeholder, so we read the board back after each attempt and
 *  retry until it's clean (up to `tries`). Returns the public image URL, or
 *  null if it never came clean — the caller then ships NO image rather than a
 *  broken board that still says "Acme Corp". */
export async function regenerateLeadWhiteboard(
  supabase: Supa,
  opts: { first: string; company: string; slug: string; tries?: number; onCost?: (usd: number) => void },
): Promise<string | null> {
  const reference = await loadReferenceImage(supabase);
  if (!reference) return null;
  const first = opts.first || 'there';
  const company = opts.company || 'your company';
  let reason = '';
  // Attempt 0 = the v2 prompt; a retry is a FRESH edit of the base photo with
  // the specific mistake fed back. Two cheap models must agree it's wrong before
  // we retry. Gemini 3.1 is ~100% so this rarely needs the second try.
  for (let attempt = 0; attempt < (opts.tries ?? 2); attempt++) {
    const prompt = attempt === 0 ? buildImagePrompt(first, company) : buildRetryPrompt(first, company, reason);
    const candidate = await generateImage({
      prompt, referenceImages: [reference], model: VISUAL_IMAGE_MODEL,
      fallbackModels: VISUAL_IMAGE_FALLBACKS, strength: 0.35, timeoutMs: 90_000,
    }).catch(() => null);
    if (!candidate) continue;
    opts.onCost?.(IMAGE_GEN_COST_USD);
    const v = await whiteboardNeedsRedo(candidate, first, company);
    if (!v.redo) return uploadImage(supabase, `${opts.slug}.jpg`, await compressImage(dataUrlToBuffer(candidate)));
    reason = v.reason;
  }
  return null;
}

// ── 2b) Batched per-person image (two leads, one API call) ──────────────────
// One Gemini call returns a side-by-side montage with BOTH whiteboards edited;
// we crop it into two and validate each independently. Output image tokens are
// billed ~flat per returned image (~1MP whether it holds 1 or 2 boards), so this
// halves the per-board image cost. The two students never change — only the two
// boards' name/company text — so a fixed 50/50 vertical crop recovers each lead's
// image exactly. Verified: 2-up returns the same ~1.05MP / ~$0.068 as a single.

// 2-up montage of the founders photo, cached like the single reference.
let _pairReferenceCache: string | null = null;
async function loadPairReference(supabase: Supa): Promise<string | null> {
  if (_pairReferenceCache) return _pairReferenceCache;
  const ref = await loadReferenceImage(supabase);
  if (!ref) return null;
  const base = dataUrlToBuffer(ref);
  const m = await sharp(base).metadata();
  const w = m.width ?? 0, h = m.height ?? 0;
  if (!w || !h) return null;
  const montage = await sharp({ create: { width: 2 * w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: base, left: 0, top: 0 }, { input: base, left: w, top: 0 }]).png().toBuffer();
  _pairReferenceCache = `data:image/png;base64,${montage.toString('base64')}`;
  return _pairReferenceCache;
}

// Prompt 3 ("negatives-first") — chosen in testing as the best handwriting match.
// Leads with the prohibitions (no clean font / bold / darker ink / re-lettering),
// then states the only 4 things that may change (two names + two companies).
export function buildPairImagePrompt(a: { first: string; company: string }, b: { first: string; company: string }): string {
  return `Two side-by-side copies (LEFT, RIGHT) of the same student whiteboard photo. Current note on both: "Hey Bob, We are students interested in learning how product work is done at Acme Corp. Thank You!".
DO NOT: retype the board in a clean or neat font; make the ink bolder, darker, or a different color; straighten or tidy the lines; or rewrite any word that isn't changing. The handwriting must stay messy, thin, and human, in the original marker color.
DO: change only these 4 spans — name1, name2 (after "Hey") and company1, company2 (after "at") — writing them in that same loose handwriting.
- LEFT must read EXACTLY: "${expectedBoard(a.first, a.company)}"  (company letter-for-letter: ${spellOut(boardName(a.company))})
- RIGHT must read EXACTLY: "${expectedBoard(b.first, b.company)}"  (company letter-for-letter: ${spellOut(boardName(b.company))})
Keep "done", "at", and every other word exactly as handwritten, and keep the people and scene unchanged.`;
}

// Split a returned 2-up into [left, right] by 50% of its real width (the model may
// return any resolution, so crop by proportion, not assumed pixels).
export async function cropPairHalves(returned: Buffer): Promise<[Buffer, Buffer]> {
  const m = await sharp(returned).metadata();
  const W = m.width ?? 0, H = m.height ?? 0;
  const cw = Math.floor(W / 2);
  const left = await sharp(returned).extract({ left: 0, top: 0, width: cw, height: H }).png().toBuffer();
  const right = await sharp(returned).extract({ left: cw, top: 0, width: W - cw, height: H }).png().toBuffer();
  return [left, right];
}

/** Generate BOTH leads' whiteboards in one call, crop, and validate each half
 *  with the same two-model check as the single path. Uploads only the boards that
 *  pass to `${slug}.jpg`; a board that fails comes back null so the caller can fall
 *  back to a single-image regen for just that lead. Returns the (one-call) cost so
 *  the caller can split it across the pair. No retry here — the verify lives in the
 *  caller, mirroring regenerateLeadWhiteboard's contract. */
export async function generateLeadWhiteboardPair(
  supabase: Supa,
  pair: [{ first: string; company: string; slug: string }, { first: string; company: string; slug: string }],
): Promise<{ urls: [string | null, string | null]; cost: number }> {
  const reference = await loadPairReference(supabase);
  if (!reference) return { urls: [null, null], cost: 0 };
  const dataUrl = await generateImage({
    prompt: buildPairImagePrompt(pair[0], pair[1]),
    referenceImages: [reference], model: VISUAL_IMAGE_MODEL,
    fallbackModels: VISUAL_IMAGE_FALLBACKS, strength: 0.35, timeoutMs: 90_000,
  }).catch(() => null);
  if (!dataUrl) return { urls: [null, null], cost: 0 };
  const cost = IMAGE_GEN_COST_USD; // one returned image ≈ one single-board call
  const halves = await cropPairHalves(dataUrlToBuffer(dataUrl));
  const urls: [string | null, string | null] = [null, null];
  for (let i = 0; i < 2; i++) {
    const jpeg = await compressImage(halves[i]);
    const v = await whiteboardNeedsRedo(`data:image/jpeg;base64,${jpeg.toString('base64')}`, pair[i].first, pair[i].company);
    if (!v.redo) urls[i] = await uploadImage(supabase, `${pair[i].slug}.jpg`, jpeg);
  }
  return { urls, cost };
}

// ── 3) Email + landing copy ─────────────────────────────────────────────────

export type EmailVariant = 'A' | 'B' | 'C';

/** Deterministic, ~balanced A/B/C assignment from the recipient email — the
 *  same email always lands in the same bucket, ~1/3 each across the list. */
export function assignVariant(email: string): EmailVariant {
  const e = email.toLowerCase();
  let h = 0;
  for (let i = 0; i < e.length; i++) h = (h * 31 + e.charCodeAt(i)) >>> 0;
  return (['A', 'B', 'C'] as const)[h % 3];
}

// The 3 A/B pitches: subject + intro differ; the image, sign-off, and landing
// page link are identical across variants. {industry} falls back cleanly.
function variantEmail(variant: EmailVariant, p: { first: string; industry: string; pageUrl: string }): { subject: string; intro: string } {
  const ind = (p.industry || 'product').trim();
  const spec = ind && ind !== 'product' && ind !== 'unknown' ? ind : ''; // a specific vertical only
  if (variant === 'B') {
    return {
      subject: 'how your team decides what to build',
      intro: `Hi ${p.first},\n\nI'm a student at Berkeley, and my friend and I are trying to understand how ${ind} teams actually decide what to build next. We're talking to product leaders to learn how they prioritize, and would genuinely love your take. Made you a quick page: ${p.pageUrl}`,
    };
  }
  if (variant === 'C') {
    return {
      subject: 'cal student curious about prioritization',
      intro: `Hi ${p.first},\n\nMy friend and I are two Berkeley students talking to product leaders${spec ? ` in ${spec}` : ''} about how they prioritize, and we put together a quick page for you: ${p.pageUrl}`,
    };
  }
  // A (control) — current copy
  return {
    subject: VISUAL_SUBJECT,
    intro: `Hi ${p.first}!\n\nI came across your profile through our mutual LinkedIn connections. Me and another Berkeley student are developing a new product for ${ind} eng teams. We made this quick page for you: ${p.pageUrl}`,
  };
}

/** Public page URL for a slug (base from LANDING_PAGES_BASE_URL). */
export function pageUrlForSlug(slug: string): string {
  return `${pagesBaseUrl()}/${slug}`;
}

/** Render the email: intro paragraph(s), then the image (linked to the page),
 *  then the sign-off BELOW the image. Escaped + https-only (XSS-safe). The
 *  per-send tracking pixel is injected later by send.ts. */
export function renderEmailHtml(introText: string, imageUrl: string | null, pageUrl: string | null, signoff = ''): string {
  const esc = (s: string) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const httpsOnly = (u: string | null | undefined) => (u && /^https:\/\//i.test(u) ? u : '');
  const safePage = httpsOnly(pageUrl);
  const safeImg = httpsOnly(imageUrl);

  const toHtml = (text: string) => {
    let h = esc(text).replace(/\r?\n/g, '<br/>');
    if (safePage) {
      const escFull = esc(safePage);
      const display = esc(safePage.replace(/^https:\/\//, ''));
      h = h.split(escFull).join(`<a href="${escFull}" style="color:#2563eb;text-decoration:underline">${display}</a>`);
    }
    return h;
  };

  // Plain inline photo — NOT a link (per request).
  const img = safeImg
    ? `<img src="${esc(safeImg)}" alt="" width="460" style="width:100%;max-width:460px;height:auto;border-radius:8px;border:1px solid #e5e5e5;display:block" />`
    : '';
  const intro = `<div style="margin:0 0 16px">${toHtml(introText)}</div>`;
  const sign = signoff ? `<div style="margin:16px 0 0">${toHtml(signoff)}</div>` : '';
  // Gmail-default look: Arial 14px / line-height 1.5 (matches a hand-typed email).
  return `<!doctype html><html><body><div style="max-width:520px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${intro}${img}${sign}</div></body></html>`;
}

/** Compose subject + body + HTML for a recipient given the sender. Used by the
 *  engine AND the dashboard. `industry` feeds the "{industry} eng teams" line;
 *  the sign-off ("Best, <name>") renders below the image. */
export function composeEmail(p: { first: string; senderName: string; industry: string; pageSlug: string; imageUrl: string | null; variant?: EmailVariant }): { subject: string; body: string; emailHtml: string } {
  const senderFirst = firstName(p.senderName);
  const pageUrl = pageUrlForSlug(p.pageSlug);
  const { subject, intro } = variantEmail(p.variant ?? 'A', { first: p.first, industry: p.industry, pageUrl });
  const signoff = `Best,\n${senderFirst}`;
  const body = `${intro}\n\n${signoff}`;
  return { subject, body, emailHtml: renderEmailHtml(intro, p.imageUrl, pageUrl, signoff) };
}

function buildBlurb(): string {
  return `We're Adit and Asim, students at Berkeley who are talking to lots of leaders in this field, like yourself, to understand how they do lots of product work, including their biggest challenges. We're not pitching anything; we just want to learn how your team decides what to build next.`;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function processVisualDraftRow(input: DraftInput, supabase: Supa, precomputed?: { slug: string; imageUrl: string }): Promise<DraftOutcome> {
  let cost = 0;
  if (!input.email) return { kind: 'skipped', reason: 'no_email', cost_usd: 0 };

  const domain = deriveDomain(input);
  const first = (input.first_name || '').trim() || 'there';
  const company = (input.company || '').trim() || 'your company';

  try {
    await setStatus(supabase, input.id, 'researching');

    // 1) industry
    const { industry, descriptor, scrapeUsed } = await resolveIndustry(supabase, domain, company);
    if (scrapeUsed) cost += FIRECRAWL_SCRAPE_COST_USD;
    cost += LLM_INDUSTRY_COST_USD;
    void descriptor; // reserved for richer blurb later

    // 2) slug + image. `precomputed` is supplied by the batched pair path (the
    // image was already generated + validated in one shared call); otherwise we
    // generate + verify the single whiteboard here. If no clean image, never
    // create a blank `ready` draft — return `retry` so the worker re-attempts.
    await setStatus(supabase, input.id, 'writing');
    const slug = precomputed?.slug ?? await computeSlug(supabase, input, first);
    const imageUrl = precomputed?.imageUrl
      ?? await regenerateLeadWhiteboard(supabase, { first, company, slug, onCost: (c) => { cost += c; } });
    if (!imageUrl) return { kind: 'retry', reason: 'no_clean_whiteboard_image', cost_usd: cost };

    // 3) email + landing copy (A/B variant on the email only — page unchanged)
    const variant = assignVariant(input.email);
    const { subject, body, emailHtml } = composeEmail({ first, senderName: input.sender_name, industry, pageSlug: slug, imageUrl, variant });
    const headline = `Hey ${first}, we're looking to help ${industry} teams with product work.`;
    const subline = ``;
    const blurb = buildBlurb();

    await supabase.from('landing_pages').upsert({
      slug,
      draft_id: input.id,
      recipient_email: input.email,
      first_name: input.first_name,
      company: input.company,
      industry,
      image_url: imageUrl,
      headline,
      subline,
      blurb,
      cal_url: CAL_BOOKING_URL,
      sender_name: input.sender_name,
      status: 'active',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'slug' });

    return {
      kind: 'ready',
      subject,
      body,
      opener_tier: 0,
      signal_score: 50,
      evidence_cards: [],
      selected_evidence_ids: [],
      cost_usd: cost,
      industry,
      image_url: imageUrl,
      page_slug: slug,
      email_html: emailHtml,
      variant,
    };
  } catch (err) {
    // Provider blips → retry (worker backs off / caps attempts). Everything
    // else → failed (surfaced in the admin preview, never sent half-built).
    if (err instanceof FirecrawlError && (err.kind === 'rate_limit' || err.kind === 'server')) {
      return { kind: 'retry', reason: `firecrawl_${err.kind}`, cost_usd: cost };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/credits depleted/i.test(msg) || /timed out/i.test(msg) || /API error (429|5\d\d)/.test(msg)) {
      return { kind: 'retry', reason: msg.slice(0, 100), cost_usd: cost };
    }
    return { kind: 'failed', reason: msg.slice(0, 160), cost_usd: cost };
  }
}

// Slug for a draft = clean `{first}-{last}` (deduped against landing_pages).
async function computeSlug(supabase: Supa, input: DraftInput, first: string): Promise<string> {
  const nameParts = (input.full_name || '').trim().split(/\s+/).filter(Boolean);
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  return buildSlug(supabase, first, last, input.email);
}

/** Process TWO drafts with ONE shared image call (the batched path). Generates
 *  both whiteboards in a single 2-up Gemini call, then finishes each draft
 *  (industry + email + landing) through the normal per-draft engine with the
 *  pre-made image. Safety: any board the batch can't produce cleanly falls back
 *  to the proven single-image path for just that lead, and if the whole batch
 *  call throws, BOTH drafts degrade to independent single processing — so this is
 *  never worse than the per-draft path, only cheaper when it works. The two
 *  per-draft completions run sequentially to preserve the worker's Firecrawl
 *  concurrency invariant (≤1 homepage scrape per slot at a time). */
export async function processVisualDraftPair(a: DraftInput, b: DraftInput, supabase: Supa): Promise<[DraftOutcome, DraftOutcome]> {
  const firstA = (a.first_name || '').trim() || 'there';
  const firstB = (b.first_name || '').trim() || 'there';
  const companyA = (a.company || '').trim() || 'your company';
  const companyB = (b.company || '').trim() || 'your company';

  let urls: [string | null, string | null] = [null, null];
  let batchCost = 0;
  try {
    const slugA = await computeSlug(supabase, a, firstA);
    const slugB = await computeSlug(supabase, b, firstB);
    const r = await generateLeadWhiteboardPair(supabase, [
      { first: firstA, company: companyA, slug: slugA },
      { first: firstB, company: companyB, slug: slugB },
    ]);
    urls = r.urls; batchCost = r.cost;
    const half = batchCost / 2;
    // Sequential (not Promise.all) to keep ≤1 industry scrape per slot in flight.
    const oa = urls[0]
      ? addImageCost(await processVisualDraftRow(a, supabase, { slug: slugA, imageUrl: urls[0] }), half)
      : await processVisualDraftRow(a, supabase); // batch miss → single fallback
    const ob = urls[1]
      ? addImageCost(await processVisualDraftRow(b, supabase, { slug: slugB, imageUrl: urls[1] }), half)
      : await processVisualDraftRow(b, supabase);
    return [oa, ob];
  } catch {
    // Whole batch failed (montage/crop/provider) → process both independently.
    const oa = await processVisualDraftRow(a, supabase);
    const ob = await processVisualDraftRow(b, supabase);
    return [oa, ob];
  }
}

// Attribute the shared batch-call cost onto a draft outcome (split across the pair).
function addImageCost(outcome: DraftOutcome, extra: number): DraftOutcome {
  return { ...outcome, cost_usd: (outcome.cost_usd ?? 0) + extra };
}
