import type { TranscriptRow } from './types';

// Build a rich, structured summary of a single transcript that the LLM
// can cite verbatim. All fields are read off the transcript row — no
// extra AI calls. Missing sections are silently dropped to keep cards
// dense.
export function formatProfileCard(t: TranscriptRow): string {
  const isAdvisor = !t.lead_id;
  const date = (t.created_at || '').slice(0, 10);
  const sentiment = t.ai_sentiment ? `Sentiment: ${t.ai_sentiment}` : '';
  const interest = t.ai_interest_level ? `Interest: ${t.ai_interest_level}` : '';
  const meta = [sentiment, interest].filter(Boolean).join(' | ');

  const sections: string[] = [];
  if (isAdvisor) {
    // Advisor / misc call — no lead, use participant fields.
    const tag = t.kind === 'misc' ? 'MISC' : 'ADVISOR';
    const who = t.participant_name || 'Unknown';
    const ctx = t.participant_context ? ` — ${t.participant_context}` : '';
    sections.push(`=== [${tag}] ${who}${ctx} — ${date} [id:${t.id}] ===`);
  } else {
    const name = t.lead_contact_name || 'Unknown';
    const company = t.lead_company_name || 'Unknown';
    const stage = t.lead_stage ? ` | stage: ${t.lead_stage}` : '';
    sections.push(`=== ${name} @ ${company} — ${date}${stage} [id:${t.id}] ===`);
  }
  if (meta) sections.push(meta);
  if (t.ai_summary) sections.push(`Summary: ${t.ai_summary}`);

  if (t.ai_pain_points?.length) {
    sections.push(
      `Pain points:\n${t.ai_pain_points
        .map(p => `  - [${p.severity}] ${p.pain_point}`)
        .join('\n')}`,
    );
  }

  if (t.ai_product_feedback?.length) {
    sections.push(
      `Product feedback:\n${t.ai_product_feedback
        .map(f => `  - [${f.category}] ${f.feedback}`)
        .join('\n')}`,
    );
  }

  if (t.ai_key_quotes?.length) {
    sections.push(
      `Key quotes:\n${t.ai_key_quotes
        .map(q => `  - "${q.quote}" — ${q.speaker} (${q.context})`)
        .join('\n')}`,
    );
  }

  if (t.ai_follow_up_suggestions?.length) {
    sections.push(
      `Follow-up suggestions:\n${t.ai_follow_up_suggestions
        .map(s => `  - ${s.action} (${s.timing}) — ${s.reason}`)
        .join('\n')}`,
    );
  }

  if (t.ai_next_steps) sections.push(`Next steps: ${t.ai_next_steps}`);

  return sections.join('\n');
}

export function formatProfileCards(rows: TranscriptRow[]): string {
  if (!rows.length) return '(no transcripts retrieved for this query)';
  return rows.map(formatProfileCard).join('\n\n');
}
