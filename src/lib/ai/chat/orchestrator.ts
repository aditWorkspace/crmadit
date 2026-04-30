import { createAdminClient } from '@/lib/supabase/admin';
import { classifyQuestion } from './router';
import { retrieveTranscripts } from './retriever';
import { buildLeadIndex } from './lead-index';
import { formatProfileCards } from './profile-card';
import { runAdvocate } from './advocate';
import { runJudge } from './judge';
import { runLookup } from './lookup';
import { runFilter } from './filter';
import type { HistoryMessage } from './types';

interface AnswerArgs {
  question: string;
  history?: HistoryMessage[];
}

export async function answerChat({ question, history = [] }: AnswerArgs): Promise<string> {
  const trimmedHistory = history.slice(-12);

  // Classify first. Filter and clarify don't need FTS retrieval at all —
  // skip the parallel fetch when the router routes to those buckets.
  const routed = await classifyQuestion(question);

  if (routed.kind === 'clarify') {
    return `Before I answer — ${routed.clarify_question}`;
  }

  if (routed.kind === 'filter') {
    return runFilter({ filter: routed.filter });
  }

  // lookup / scope still need knowledge docs + lead index + retrieval.
  const [knowledgeDocs, leadIndex, transcripts] = await Promise.all([
    fetchKnowledgeDocs(),
    buildLeadIndex(),
    retrieveTranscripts(routed.search_terms, 8),
  ]);
  const retrievedCards = formatProfileCards(transcripts);

  if (routed.kind === 'lookup') {
    return runLookup({
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    });
  }

  // routed.kind === 'scope'
  const [forArg, againstArg] = await Promise.all([
    runAdvocate({
      side: 'for',
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    }),
    runAdvocate({
      side: 'against',
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    }),
  ]);

  return runJudge({
    question,
    history: trimmedHistory,
    advocates: [forArg, againstArg],
    leadIndex,
    retrievedCards,
  });
}

async function fetchKnowledgeDocs(): Promise<string> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content')
    .order('doc_type');
  if (!data?.length) return '(no knowledge docs on file)';
  return data
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');
}
