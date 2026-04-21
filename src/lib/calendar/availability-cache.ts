import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy } from '@/lib/google/calendar';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface CachedAvailability {
  memberId: string;
  memberName: string;
  busy: { start: string; end: string }[];
  cachedAt: string;
  rangeStart: string;
  rangeEnd: string;
}

/**
 * Get cached availability for all connected team members.
 * Returns cached data if fresh, otherwise fetches live and updates cache.
 */
export async function getCachedAvailability(
  rangeStart: Date,
  rangeEnd: Date
): Promise<{ data: CachedAvailability[]; fromCache: boolean; failedCount: number }> {
  const supabase = createAdminClient();
  const now = Date.now();

  // Get all connected members
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return { data: [], fromCache: false, failedCount: 0 };
  }

  // Check cache for each member
  const rangeKey = `${rangeStart.toISOString()}_${rangeEnd.toISOString()}`;
  const { data: cached } = await supabase
    .from('availability_cache')
    .select('*')
    .eq('range_key', rangeKey)
    .in('member_id', members.map(m => m.id));

  const cachedMap = new Map<string, CachedAvailability>();
  const staleIds: string[] = [];

  for (const c of cached ?? []) {
    const age = now - new Date(c.cached_at).getTime();
    if (age < CACHE_TTL_MS) {
      cachedMap.set(c.member_id, {
        memberId: c.member_id,
        memberName: members.find(m => m.id === c.member_id)?.name ?? '',
        busy: c.busy_blocks,
        cachedAt: c.cached_at,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
      });
    } else {
      staleIds.push(c.member_id);
    }
  }

  // Find members not in cache or stale
  const needsFetch = members.filter(m => !cachedMap.has(m.id) || staleIds.includes(m.id));

  let failedCount = 0;
  if (needsFetch.length > 0) {
    // Fetch live for missing/stale members
    const results = await Promise.allSettled(
      needsFetch.map(m => getFreeBusy(m.id, rangeStart, rangeEnd))
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const member = needsFetch[i];

      if (r.status === 'fulfilled') {
        const entry: CachedAvailability = {
          memberId: member.id,
          memberName: member.name,
          busy: r.value.busy,
          cachedAt: new Date().toISOString(),
          rangeStart: rangeStart.toISOString(),
          rangeEnd: rangeEnd.toISOString(),
        };
        cachedMap.set(member.id, entry);

        // Upsert to cache
        await supabase
          .from('availability_cache')
          .upsert({
            member_id: member.id,
            range_key: rangeKey,
            busy_blocks: r.value.busy,
            cached_at: entry.cachedAt,
          }, {
            onConflict: 'member_id,range_key',
          });
      } else {
        failedCount++;
        console.error(`[availability-cache] FreeBusy failed for ${member.name}:`, r.reason);
      }
    }
  }

  return {
    data: Array.from(cachedMap.values()),
    fromCache: needsFetch.length === 0,
    failedCount,
  };
}

/**
 * Pre-warm availability cache for the next 2 months.
 * Called by cron job every 15 minutes.
 */
export async function warmAvailabilityCache(): Promise<{ warmed: number; failed: number }> {
  const supabase = createAdminClient();
  const now = new Date();

  // Cache for current month and next month
  const ranges = [
    { start: startOfMonth(now), end: endOfMonth(now) },
    { start: startOfMonth(addMonths(now, 1)), end: endOfMonth(addMonths(now, 1)) },
  ];

  let warmed = 0;
  let failed = 0;

  for (const range of ranges) {
    const result = await getCachedAvailability(range.start, range.end);
    warmed += result.data.length;
    failed += result.failedCount;
  }

  // Cleanup old cache entries (older than 1 day)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await supabase
    .from('availability_cache')
    .delete()
    .lt('cached_at', yesterday.toISOString());

  return { warmed, failed };
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}
