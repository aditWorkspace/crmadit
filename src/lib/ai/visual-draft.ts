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
import { callAIMessages, generateImage } from './openrouter';
import { tolerantJsonParse } from './json';
import { scrapeUrl, FirecrawlError } from '@/lib/external/firecrawl';
import { deriveDomain, type DraftInput, type DraftOutcome } from './cold-research';
import {
  FIRECRAWL_SCRAPE_COST_USD,
  LLM_INDUSTRY_COST_USD,
  IMAGE_GEN_COST_USD,
  VISUAL_IMAGE_MODEL,
  VISUAL_IMAGE_FALLBACKS,
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
async function loadReferenceImage(supabase: Supa): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(OUTREACH_IMAGE_BUCKET).download(OUTREACH_REFERENCE_KEY);
    if (!error && data) {
      const buf = Buffer.from(await data.arrayBuffer());
      return `data:image/png;base64,${buf.toString('base64')}`;
    }
  } catch { /* fall through to env */ }
  const url = process.env.OUTREACH_REFERENCE_URL;
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    } catch { /* none */ }
  }
  return null;
}

function buildImagePrompt(first: string, company: string): string {
  // Keep the prompt clean if a name/company has odd characters.
  const clean = (s: string) => s.replace(/["'\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const name = clean(first);
  const co = clean(company);
  // Direct, minimal edit: swap only the name (Bob) and company (Acme Corp) on
  // the whiteboard; keep the person, handwriting, and everything else identical.
  return `Hey, only edit the name (Bob) and the company name (Acme Corp) on the whiteboard for this lead. Keep the person, the handwriting style, and everything else exactly the same.\nName: ${name}\nCompany: ${co}`;
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

// ── 3) Email + landing copy ─────────────────────────────────────────────────

function buildEmailIntro(p: { first: string; industry: string; pageUrl: string }): string {
  const ind = (p.industry || 'product').trim();
  return `Hi ${p.first}!\n\nI came across your profile through our mutual LinkedIn connections. Me and another Berkeley student are developing a new product for ${ind} eng teams. We made this quick page for you: ${p.pageUrl}`;
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
export function composeEmail(p: { first: string; senderName: string; industry: string; pageSlug: string; imageUrl: string | null }): { subject: string; body: string; emailHtml: string } {
  const senderFirst = firstName(p.senderName);
  const pageUrl = pageUrlForSlug(p.pageSlug);
  const intro = buildEmailIntro({ first: p.first, industry: p.industry, pageUrl });
  const signoff = `Best,\n${senderFirst}`;
  const body = `${intro}\n\n${signoff}`;
  return { subject: VISUAL_SUBJECT, body, emailHtml: renderEmailHtml(intro, p.imageUrl, pageUrl, signoff) };
}

function buildBlurb(): string {
  return `We're Adit and Asim, students at Berkeley who are talking to lots of leaders in this field, like yourself, to understand how they do lots of product work, including their biggest challenges. We're not pitching anything; we just want to learn how your team decides what to build next.`;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function processVisualDraftRow(input: DraftInput, supabase: Supa): Promise<DraftOutcome> {
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

    // 2) slug + image
    await setStatus(supabase, input.id, 'writing');
    const nameParts = (input.full_name || '').trim().split(/\s+/).filter(Boolean);
    const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    const slug = await buildSlug(supabase, first, last, input.email);

    let imageUrl: string | null = null;
    const reference = await loadReferenceImage(supabase);
    if (reference) {
      const dataUrl = await generateImage({
        prompt: buildImagePrompt(first, company),
        referenceImages: [reference],
        model: VISUAL_IMAGE_MODEL,
        fallbackModels: VISUAL_IMAGE_FALLBACKS,
        strength: 0.35,
        timeoutMs: 90_000,
      });
      cost += IMAGE_GEN_COST_USD;
      imageUrl = await uploadImage(supabase, `${slug}.jpg`, await compressImage(dataUrlToBuffer(dataUrl)));
    }

    // 3) email + landing copy
    const { subject, body, emailHtml } = composeEmail({ first, senderName: input.sender_name, industry, pageSlug: slug, imageUrl });
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
