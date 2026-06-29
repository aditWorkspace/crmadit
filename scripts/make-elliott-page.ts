// One-off: build a single calproduct.com landing page for Elliott Potter, CEO of
// Linq. Runs the EXACT prod visual-outreach engine — industry lookup + verified
// per-person whiteboard image + landing_pages row — but sends NO email and creates
// NO cold_email_drafts row (draft_id stays null = hand-made page). The page goes
// live at calproduct.com/elliott-potter as soon as the row is `active`.
//
// Run:  npx tsx scripts/make-elliott-page.ts

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { regenerateLeadWhiteboard } from '@/lib/ai/visual-draft';
import { CAL_BOOKING_URL } from '@/lib/email-tool/cold-constants';

// ── env: load .env.local so the API keys are present however invoked ──────────
function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal();

const R = {
  first: 'Elliott',
  company: 'Linq',
  email: 'elliott@linqapp.com',
  domain: 'linqapp.com',
  sender: 'Adit',
  slug: 'elliott-potter',
  industry: 'conversational AI', // chosen over the classifier's "communications apis"
};

async function main() {
  const supabase = createAdminClient();

  const industry = R.industry;
  console.log('1/2  industry (fixed) =', JSON.stringify(industry));

  console.log('2/2  generating + verifying whiteboard image …');
  const imageUrl = await regenerateLeadWhiteboard(supabase, {
    first: R.first, company: R.company, slug: R.slug, tries: 3,
    onCost: (c) => console.log('     image attempt ~$' + c.toFixed(3)),
  });
  if (!imageUrl) throw new Error('no clean whiteboard image after retries — aborting (no half-built page)');
  console.log('     image_url =', imageUrl);

  console.log('     upserting landing_pages row …');
  const headline = `Hey ${R.first}, we're looking to help ${industry} teams with product work.`;
  const blurb = `We're Adit and Asim, students at Berkeley who are talking to lots of leaders in this field, like yourself, to understand how they do lots of product work, including their biggest challenges. We're not pitching anything; we just want to learn how your team decides what to build next.`;

  const { error } = await supabase.from('landing_pages').upsert({
    slug: R.slug,
    draft_id: null,                 // hand-made page, not from the cold-email worker
    recipient_email: R.email,
    first_name: R.first,
    company: R.company,
    industry,
    image_url: imageUrl,
    headline,
    subline: '',
    blurb,
    cal_url: CAL_BOOKING_URL,
    sender_name: R.sender,
    status: 'active',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'slug' });
  if (error) throw new Error('landing_pages upsert failed: ' + error.message);

  console.log('\n✅ DONE — live at https://calproduct.com/' + R.slug);
  console.log('   (ISR revalidate = 30s, so allow up to ~30s for first paint)');
}

main().catch((e) => { console.error('\n❌ FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
