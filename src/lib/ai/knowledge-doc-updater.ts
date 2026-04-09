import { createAdminClient } from '@/lib/supabase/admin';
import { AiPainPoint, AiProductFeedback, AiKeyQuote, AiFollowUpSuggestion } from '@/types';

interface KnowledgeDocParams {
  leadName: string;
  companyName: string;
  date: string; // e.g. "2026-04-08"
  painPoints: AiPainPoint[];
  productFeedback: AiProductFeedback[];
  keyQuotes: AiKeyQuote[];
  followUpSuggestions: AiFollowUpSuggestion[];
}

/**
 * Appends extracted transcript insights to the 3 living knowledge documents.
 * Pure formatting + DB append — no AI calls.
 *
 * Called synchronously from the transcript PATCH endpoint on "Save & Apply"
 * to guarantee knowledge docs are always up to date.
 */
export async function appendToKnowledgeDocs(params: KnowledgeDocParams): Promise<void> {
  const { leadName, companyName, date, painPoints, productFeedback, keyQuotes, followUpSuggestions } = params;
  const supabase = createAdminClient();
  const header = `\n---\n### ${date} — ${leadName} (${companyName})\n`;

  // ── Problems doc ──────────────────────────────────────────────────────────
  if (painPoints.length > 0) {
    const lines = painPoints.map(p => `- **[${p.severity}]** ${p.pain_point}`);
    const content = header + lines.join('\n') + '\n';
    await supabase.rpc('append_knowledge_doc', { p_doc_type: 'problems', p_content: content });
  }

  // ── Product feedback doc ──────────────────────────────────────────────────
  if (productFeedback.length > 0 || keyQuotes.length > 0) {
    const parts: string[] = [];

    if (productFeedback.length > 0) {
      parts.push(...productFeedback.map(f => `- **[${f.category}]** ${f.feedback}`));
    }

    // Include relevant quotes (customer voice adds context)
    const customerQuotes = keyQuotes.filter(q =>
      q.speaker.toLowerCase() !== 'proxi' &&
      q.speaker.toLowerCase() !== 'adit' &&
      q.speaker.toLowerCase() !== 'srijay' &&
      q.speaker.toLowerCase() !== 'asim'
    );
    if (customerQuotes.length > 0) {
      parts.push('');
      parts.push('**Key quotes:**');
      parts.push(...customerQuotes.slice(0, 3).map(q => `> "${q.quote}" — *${q.speaker}* (${q.context})`));
    }

    if (parts.length > 0) {
      const content = header + parts.join('\n') + '\n';
      await supabase.rpc('append_knowledge_doc', { p_doc_type: 'product_feedback', p_content: content });
    }
  }

  // ── Solutions doc ─────────────────────────────────────────────────────────
  if (followUpSuggestions.length > 0) {
    const lines = followUpSuggestions.map(s => `- **${s.action}** (${s.timing}) — ${s.reason}`);
    const content = header + lines.join('\n') + '\n';
    await supabase.rpc('append_knowledge_doc', { p_doc_type: 'solutions', p_content: content });
  }
}
