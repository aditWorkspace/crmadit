import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Metadata } from 'next';
import { getSupabase } from '@/lib/supabase';

export const revalidate = 30;

interface LandingPage {
  slug: string;
  first_name: string | null;
  company: string | null;
  industry: string | null;
  image_url: string | null;
  cal_url: string | null;
  sender_name: string | null;
}

// Static "about us" — the two co-founders (same on every page).
const SUPA_IMG = 'https://kwxfsilefratpbzhvcpy.supabase.co/storage/v1/object/public/outreach-images/_founders';
const FOUNDERS = [
  { name: 'Adit Mittal', img: `${SUPA_IMG}/adit.png`, lines: ['Built Mockstreetai.com', 'Offers from Citadel Securities & BlackRock', 'CS @ Berkeley'] },
  { name: 'Asim Ali', img: `${SUPA_IMG}/asim.png`, lines: ['SWE Intern @ Bluejay (YC Sp25)', 'SWE Full-Time @ Commure (YC S16)', 'CS @ Berkeley'] },
];

// ─────────────────────────────────────────────────────────────────────────
//  SINGLE SOURCE OF TRUTH for every word on the page.
//  Each page row stores only raw variables (first_name / industry / company /
//  image_url). All prose is built here from those variables, so editing this
//  one function re-renders EVERY page — already-generated and new — on the
//  next revalidate. To change the wording sitewide, edit only this block.
// ─────────────────────────────────────────────────────────────────────────
function buildCopy(p: LandingPage) {
  const first = (p.first_name || 'there').trim();
  const raw = (p.industry || '').trim().toLowerCase();
  // "unknown" is the lookup's give-up value — treat it as no industry.
  const industry = raw === 'unknown' ? '' : raw;
  const company = (p.company || '').trim();

  const subject =
    industry && company ? `how ${industry} teams like ${company} decide what to build next`
    : industry ? `how ${industry} teams decide what to build next`
    : company ? `how teams like ${company} decide what to build next`
    : 'how product teams decide what to build next';

  const headline = `Hey ${first}, we're trying to understand ${subject}.`;
  const eyebrow = `A note for ${first}`;

  // The sticky note. Keeps the single "not pitching" line. Curious + human.
  // Only NAME the industry after "leaders in" when it's a specific vertical:
  // the generic "product" (68 of our ~320 leads) would read "product leaders
  // in product", so we drop the clause there (and for empty/unknown).
  const namedIndustry = industry && industry !== 'product' ? industry : '';
  const note =
    `We're Adit and Asim, two students at Berkeley. We've been talking to a bunch of product ` +
    `leaders ${namedIndustry ? `in ${namedIndustry} ` : ''}to understand how teams actually decide ` +
    `what to build, and where it gets messy. We aren't pitching anything. But if there's a ` +
    `problem you're wrestling with right now, we'd love to hear it.`;

  // "What we'd love to ask" — broad, product-flavoured, no emdashes.
  const asks = [
    { n: '01', t: 'Your biggest pain points' },
    { n: '02', t: 'How you prioritize' },
    { n: '03', t: 'What you would fix first' },
  ];

  return { first, headline, eyebrow, note, asks };
}

const getPage = cache(async (slug: string): Promise<LandingPage | null> => {
  const { data } = await getSupabase()
    .from('landing_pages')
    .select('slug, first_name, company, industry, image_url, cal_url, sender_name')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();
  return (data as LandingPage | null) ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await getPage(slug);
  const title = p ? buildCopy(p).headline : 'A quick hello';
  return { title, robots: { index: false, follow: false } };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await getPage(slug);
  if (!p) redirect('/'); // stripped/unknown slug → booking home

  const { first, headline, eyebrow, note, asks } = buildCopy(p);
  const cal = p.cal_url || 'https://cal.com/adit-mittal/30min';

  return (
    <main className="wrap">
      {/* ── hero ── */}
      <section className="hero">
        <div className="hero-text rise">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="h1">{headline}</h1>
          <a className="btn" href={cal}>Book a 30 min chat →</a>
        </div>
        {p.image_url && (
          <figure className="photo rise d2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image_url} alt={eyebrow} />
          </figure>
        )}
      </section>

      {/* ── why we reached out — sticky note (2nd, right under the hero) ── */}
      <section className="section">
        <h2 className="h2 rise">Why we reached out</h2>
        <div className="note-wrap rise">
          <div className="note">
            <span className="tape" aria-hidden="true" />
            <p className="note-body">{note}</p>
            <p className="note-sign">Adit &amp; Asim</p>
          </div>
        </div>
      </section>

      {/* ── who we are ── */}
      <section className="section">
        <h2 className="h2 rise">The two of us</h2>
        <div className="cards">
          {FOUNDERS.map((f, i) => (
            <div className="card rise" style={{ animationDelay: `${0.08 + i * 0.09}s` }} key={f.name}>
              <div className="avatar">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.img} alt={f.name} />
              </div>
              <h3>{f.name}</h3>
              <ul>{f.lines.map(l => <li key={l}>{l}</li>)}</ul>
            </div>
          ))}
        </div>
        <p className="cap">UC Berkeley</p>
      </section>

      {/* ── what we'd love to ask ── */}
      <section className="section">
        <h2 className="h2 rise">{`What we'd love to ask`}</h2>
        <ol className="asks">
          {asks.map((a, i) => (
            <li className="ask rise" style={{ animationDelay: `${0.06 + i * 0.1}s` }} key={a.n}>
              <span className="ask-n">{a.n}</span>
              <div>
                <h3 className="ask-t">{a.t}</h3>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── CTA ── */}
      <section className="cta rise">
        <p className="cta-line">{`Thirty minutes. Bring a problem you're stuck on, and we'll dig in to help.`}</p>
        <a className="btn big" href={cal}>Book a 30 min chat →</a>
      </section>
      <div style={{ height: '6rem' }} aria-hidden />
    </main>
  );
}
