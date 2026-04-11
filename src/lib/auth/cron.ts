import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Verify a cron request's authorization. Accepts three header shapes to match
 * common external-cron-service defaults:
 *   - Authorization: Bearer <secret>   (cron-job.org with custom header set)
 *   - Authorization: <secret>          (bare token, some services)
 *   - X-Cron-Secret: <secret>          (alternative custom header name)
 *
 * Uses constant-time comparison via node:crypto.timingSafeEqual so the route
 * doesn't leak whether the header was wrong vs. missing via response timing.
 */
export function verifyCronAuth(req: NextRequest): { ok: boolean } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: false };

  const candidates: string[] = [];
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    candidates.push(authHeader);
    if (authHeader.startsWith('Bearer ')) candidates.push(authHeader.slice(7));
  }
  const xCron = req.headers.get('x-cron-secret');
  if (xCron) candidates.push(xCron);

  const expectedBuf = Buffer.from(expected);
  for (const c of candidates) {
    const cBuf = Buffer.from(c);
    if (cBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(cBuf, expectedBuf)) return { ok: true };
  }
  return { ok: false };
}
