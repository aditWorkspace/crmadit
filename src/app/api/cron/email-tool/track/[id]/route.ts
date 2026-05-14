// GET /api/cron/email-tool/track/[id].png — open-tracking pixel.
//
// Recipients' email clients fetch this URL when they load the 1×1
// transparent PNG embedded at the bottom of the HTML part of every
// cold email (and every email-tool follow-up). The `[id]` segment is
// the email_send_queue row UUID — supplied verbatim from the queue
// row at send time.
//
// Two-layer filtering of "open" signal (because pixels are noisy):
//
//   1. Apple Mail Privacy Protection (default on every iPhone since
//      iOS 15) pre-fetches every image on delivery from Apple's proxy.
//      That happens within seconds of the message arriving. We reject
//      any hit where `now - sent_at < 90 seconds` as "definitely not
//      a human" — humans don't open emails 30 seconds after they're
//      sent.
//
//   2. Scanner/proxy User-Agents (corporate antivirus, Google Image
//      Proxy, Outlook's image proxy, Bing/Yandex bots). We reject any
//      hit whose UA matches a known scanner pattern.
//
// `open_count` is incremented on EVERY hit (raw count, useful for
// "did anyone load this at all" gut-checks). `opened_at` is only set
// to now() when the hit passes the filter — that's the column the
// follow-up selector reads.
//
// Lives under /api/cron/* per project convention (Vercel deployment-
// protection HTML-404 workaround). This route requires NO auth —
// it's hit by random recipients who don't have our session cookie.
export const maxDuration = 10;
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// 41-byte transparent 1×1 PNG. Inlined as a base64 string so the route
// doesn't have to read from disk. Generated via:
//   python -c "import base64; print(base64.b64encode(open('1x1.png','rb').read()))"
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TRANSPARENT_PNG = Buffer.from(TRANSPARENT_PNG_BASE64, 'base64');

// UAs that we discount as definitely-not-a-human. The pattern is
// case-insensitive and matches anywhere in the UA string.
const SCANNER_UA_RE = /GoogleImageProxy|ggpht\.com|Outlook[^a-z]?ImageProxy|bingbot|Googlebot|YandexBot|Baiduspider|Symantec|Mimecast|Proofpoint|Barracuda|MailScanner|Sophos|TrendMicro|Avast|McAfee|Microsoft Office Protection|AntiVirus|Linkfilter|MailMarshal|Forcepoint|FortiMail|Spam(?:Title|Assassin)|Cloudflare-MTA/i;

// Minimum elapsed time between send and open for the hit to count as
// "likely human". Apple MPP delivery pre-fetch is usually within ~10s,
// but we leave a generous buffer.
const MIN_HUMAN_AGE_MS = 90_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pixelResponse(): NextResponse {
  return new NextResponse(new Uint8Array(TRANSPARENT_PNG), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(TRANSPARENT_PNG.length),
      // Re-fetches matter: humans re-open emails. With `no-store` we
      // force the client to GET the pixel every time the message
      // renders, so open_count reflects actual views.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteParams) {
  const { id: rawId } = await ctx.params;
  // Strip `.png` (and any other extension) so the route accepts
  // `/track/<uuid>` and `/track/<uuid>.png` identically.
  const id = rawId.replace(/\.[a-z0-9]+$/i, '');

  // Always return the pixel — even on malformed ids, even when the
  // queue row is missing. We don't want to give a scanner any signal
  // about which ids are valid.
  if (!UUID_RE.test(id)) return pixelResponse();

  // Vercel serverless functions terminate pending promises once the
  // response is sent — so the DB write must complete BEFORE we return.
  // The ~50–100ms PostgREST round-trip is negligible to the recipient's
  // email client and we never want to drop an open. Errors are swallowed
  // so a slow DB doesn't fail the GET; the pixel still ships.
  try {
    await recordOpen(id, req);
  } catch (err) {
    console.error('[email-tool/track] DB write failed', { id, err: (err as Error)?.message });
  }

  return pixelResponse();
}

async function recordOpen(id: string, req: NextRequest): Promise<void> {
  const supabase = createAdminClient();

  // Pull just enough to apply the filter — sent_at + the current
  // opened_at so we can decide whether this is the first accepted
  // open.
  const { data: row, error: lookupErr } = await supabase
    .from('email_send_queue')
    .select('id, sent_at, opened_at, open_count')
    .eq('id', id)
    .maybeSingle();
  if (lookupErr || !row) return;

  const ua = req.headers.get('user-agent') ?? '';
  const sentAt = row.sent_at ? new Date(row.sent_at).getTime() : 0;
  const ageMs = sentAt > 0 ? Date.now() - sentAt : Number.POSITIVE_INFINITY;
  const tooEarly = sentAt > 0 && ageMs < MIN_HUMAN_AGE_MS;
  const looksLikeScanner = SCANNER_UA_RE.test(ua);
  const accept = !tooEarly && !looksLikeScanner;

  // Always bump open_count (raw signal). Only set opened_at when the
  // hit passes the filter AND opened_at is still NULL (first accepted
  // open wins; subsequent opens just bump the counter).
  const updates: Record<string, unknown> = {
    open_count: (row.open_count ?? 0) + 1,
  };
  if (accept && !row.opened_at) {
    updates.opened_at = new Date().toISOString();
  }
  await supabase.from('email_send_queue').update(updates).eq('id', id);
}
