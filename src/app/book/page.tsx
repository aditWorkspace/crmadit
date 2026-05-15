'use client';

// Public booking page. As of 2026-05-15 this is just a Cal.com inline
// embed pointing at adit-mittal/30min — replaces the in-house calendar
// widget that lived here previously. Kept under the same /book path
// purely as a fallback for old emails / bookmarks that still point at
// pmcrminternal.vercel.app/book. All new outbound links go directly to
// cal.com/adit-mittal/30min (see src/lib/constants.ts BOOKING_URL).
//
// The legacy API routes (/api/calendar/book, /availability, /reschedule)
// still serve in case an in-flight reschedule link from a pre-cutover
// confirmation email lands — they're effectively dead code but harmless.

import { useEffect } from 'react';

// Minimal shape of the Cal global the embed script installs. We type it
// loosely because the embed's actual API surface is large and we only
// touch the namespace-scoped methods.
type CalApi = ((command: string, ...args: unknown[]) => void) & {
  ns: Record<string, (command: string, options: unknown) => void>;
  loaded?: boolean;
};

declare global {
  interface Window {
    Cal?: CalApi;
  }
}

const CAL_LINK = 'adit-mittal/30min';
const CAL_NAMESPACE = '30min';
const CONTAINER_ID = 'my-cal-inline-30min';

export default function BookPage() {
  useEffect(() => {
    // Bootstrap loader (verbatim from cal.com's official embed snippet,
    // ported to a TypeScript-safe IIFE). Idempotent: re-running on hot
    // reload is fine because `cal.loaded` short-circuits the second
    // <script> append.
    (function bootCal(C: Window, A: string, L: string) {
      const p = function (a: unknown, ar: IArguments) {
        (a as { q: IArguments[] }).q.push(ar);
      };
      const d = C.document;
      const Cal = (C.Cal = (C.Cal ?? (function (this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const cal = C.Cal as CalApi;
        // eslint-disable-next-line prefer-rest-params
        const ar = arguments as unknown as IArguments;
        if (!cal.loaded) {
          cal.ns = {};
          (cal as unknown as { q: IArguments[] }).q = (cal as unknown as { q?: IArguments[] }).q ?? [];
          d.head.appendChild(d.createElement('script')).setAttribute('src', A);
          cal.loaded = true;
        }
        if (ar[0] === L) {
          const api = function (this: unknown) {
            // eslint-disable-next-line prefer-rest-params
            p(api, arguments);
          } as unknown as { q: IArguments[] };
          const namespace = ar[1] as string;
          api.q = api.q ?? [];
          if (typeof namespace === 'string') {
            cal.ns[namespace] = (cal.ns[namespace] ?? (api as unknown as (command: string, options: unknown) => void));
            p(cal.ns[namespace], ar);
            p(cal, ['initNamespace', namespace] as unknown as IArguments);
          } else {
            p(cal, ar);
          }
          return;
        }
        p(cal, ar);
      }) as unknown as CalApi)) as CalApi;
      void Cal;
    })(window, 'https://app.cal.com/embed/embed.js', 'init');

    const Cal = window.Cal!;
    Cal('init', CAL_NAMESPACE, { origin: 'https://app.cal.com' });
    Cal.ns[CAL_NAMESPACE]('inline', {
      elementOrSelector: `#${CONTAINER_ID}`,
      config: { layout: 'month_view', useSlotsViewOnSmallScreen: 'true' },
      calLink: CAL_LINK,
    });
    Cal.ns[CAL_NAMESPACE]('ui', {
      hideEventTypeDetails: false,
      layout: 'month_view',
    });
  }, []);

  return (
    <div
      id={CONTAINER_ID}
      style={{ width: '100%', minHeight: '100vh', overflow: 'auto', background: '#111' }}
    />
  );
}
