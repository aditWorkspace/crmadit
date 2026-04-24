import { createAdminClient } from '@/lib/supabase/admin';
import { classifyQuestion } from './router';
import { retrieveTranscripts } from './retriever';
import { buildLeadIndex } from './lead-index';
import { formatProfileCards } from './profile-card';
import { runAdvocate } from './advocate';
import { runJudge } from './judge';
import { runLookup } from './lookup';
import type { HistoryMessage } from './types';

interface AnswerArgs {
  question: string;
  history?: HistoryMessage[];
}

// Top-level entry point for the insights chat. Routes the question through
// either a single-call lookup path or the FOR/AGAINST/JUDGE debate.
export async function answerChat({ question, history = [] }: AnswerArgs): Promise<string> {
  // Cap history to last 6 turns (12 messages) so we don't blow up context
  // on long threads. Most scope-question context lives in retrieved cards,
  // not in chat history.
  const trimmedHistory = history.slice(-12);

  // 1. Fetch knowledge docs + build lead index + classify in parallel.
  const [knowledgeDocs, leadIndex, routed] = await Promise.all([
    fetchKnowledgeDocs(),
    buildLeadIndex(),
    classifyQuestion(question),
  ]);

  // 2. Retrieve profile cards by FTS on the router-emitted terms.
  const transcripts = await retrieveTranscripts(routed.search_terms, 8);
  const retrievedCards = formatProfileCards(transcripts);

  // 3. Route.
  if (routed.kind === 'lookup') {
    return runLookup({
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    });
  }

  // Scope question -> parallel advocates -> judge.
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
