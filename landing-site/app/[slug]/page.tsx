import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getSupabase } from '@/lib/supabase';

export const revalidate = 30;

interface LandingPage {
  slug: string;
  first_name: string | null;
  company: string | null;
  industry: string | null;
  image_url: string | null;
  headline: string | null;
  subline: string | null;
  blurb: string | null;
  cal_url: string | null;
  sender_name: string | null;
}

// Static "about us" — the two co-founders (same on every page).
const SUPA_IMG = 'https://kwxfsilefratpbzhvcpy.supabase.co/storage/v1/object/public/outreach-images/_founders';
const FOUNDERS = [
  { name: 'Adit Mittal', img: `${SUPA_IMG}/adit.png`, lines: ['Built Mockstreetai.com', 'Offers from Citadel Securities & BlackRock', 'CS + Business @ Berkeley'] },
  { name: 'Asim Ali', img: `${SUPA_IMG}/asim.png`, lines: ['SWE Intern @ Bluejay (YC Sp25)', 'SWE Full-Time @ Commure (YC S16)', 'CS @ Berkeley'] },
];

async function getPage(slug: string): Promise<LandingPage | null> {
  const { data } = await getSupabase()
    .from('landing_pages')
    .select('slug, first_name, company, industry, image_url, headline, subline, blurb, cal_url, sender_name')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();
  return (data as LandingPage | null) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await getPage(slug);
  return { title: p?.headline ?? 'A quick hello', robots: { index: false, follow: false } };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await getPage(slug);
  if (!p) redirect('/'); // stripped/unknown slug → booking home

  const first = p.first_name || 'there';
  const cal = p.cal_url || 'https://cal.com/adit-mittal/30min';
  const headline = p.headline ?? `Hey ${first}, we're looking to help your team with product work.`;

  return (
    <main className="wrap">
      {/* ── hero ── */}
      <section className="hero">
        <div className="hero-text rise">
          <p className="eyebrow">A note for {first}</p>
          <h1 className="serif h1">{headline}</h1>
          {p.subline && <p className="sub">{p.subline}</p>}
          <a className="btn" href={cal}>Book a 30-min chat →</a>
        </div>
        {p.image_url && (
          <figure className="photo rise d2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image_url} alt={`A note for ${first}`} />
          </figure>
        )}
      </section>

      {/* ── why ── */}
      {p.blurb && (
        <section className="section rise">
          <h2 className="serif h2">Why we reached out</h2>
          <p className="lead">{p.blurb}</p>
        </section>
      )}

      {/* ── the two of us ── */}
      <section className="section rise">
        <h2 className="serif h2">The two of us</h2>
        <div className="cards">
          {FOUNDERS.map(f => (
            <div className="card" key={f.name}>
              <div className="avatar">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.img} alt={f.name} />
              </div>
              <h3 className="serif">{f.name}</h3>
              <ul>{f.lines.map(l => <li key={l}>{l}</li>)}</ul>
            </div>
          ))}
        </div>
        <p className="cap">UC Berkeley</p>
      </section>

      {/* ── CTA ── */}
      <section className="cta rise">
        <p className="cta-line serif">We aren&apos;t pitching. We just want to learn how your team decides what to build.</p>
        <a className="btn big" href={cal}>Book a 30-min chat →</a>
      </section>

      <footer className="foot">Adit &amp; Asim · UC Berkeley</footer>
    </main>
  );
}
