'use client';

import { useState } from 'react';
import { Transcript } from '@/types';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface AiInsightsProps {
  transcript: Transcript;
}

export function AiInsights({ transcript }: AiInsightsProps) {
  const [showQuotes, setShowQuotes] = useState(false);

  const sentimentColor = {
    very_positive: 'bg-green-100 text-green-800',
    positive: 'bg-emerald-100 text-emerald-800',
    neutral: 'bg-gray-100 text-gray-700',
    negative: 'bg-red-100 text-red-800',
  }[transcript.ai_sentiment || 'neutral'] || 'bg-gray-100 text-gray-700';

  const interestColor = {
    high: 'bg-blue-100 text-blue-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-gray-100 text-gray-600',
  }[transcript.ai_interest_level || 'medium'] || 'bg-gray-100 text-gray-700';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('px-2.5 py-1 rounded-full text-xs font-medium', sentimentColor)}>
          {transcript.ai_sentiment?.replace('_', ' ') || '—'}
        </span>
        <span className={cn('px-2.5 py-1 rounded-full text-xs font-medium', interestColor)}>
          {transcript.ai_interest_level ? `${transcript.ai_interest_level} interest` : '—'}
        </span>
      </div>

      {(transcript.ai_pain_points as { pain_point: string; severity: string }[] | undefined)?.length && (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1.5">Pain Points</p>
          <div className="space-y-1">
            {(transcript.ai_pain_points as { pain_point: string; severity: string }[]).map((p, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 mt-0.5',
                  p.severity === 'high' ? 'bg-red-100 text-red-700' :
                  p.severity === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-600'
                )}>{p.severity}</span>
                <span className="text-gray-700">{p.pain_point}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(transcript.ai_product_feedback as { feedback: string; category: string }[] | undefined)?.length && (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1.5">Product Feedback</p>
          <div className="space-y-1">
            {(transcript.ai_product_feedback as { feedback: string; category: string }[]).map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 mt-0.5',
                  f.category === 'positive' ? 'bg-green-100 text-green-700' :
                  f.category === 'concern' ? 'bg-red-100 text-red-700' :
                  f.category === 'suggestion' ? 'bg-blue-100 text-blue-700' :
                  'bg-gray-100 text-gray-600'
                )}>{f.category}</span>
                <span className="text-gray-700">{f.feedback}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(transcript.ai_key_quotes as { quote: string; context: string; speaker: string }[] | undefined)?.length && (
        <div>
          <button
            onClick={() => setShowQuotes(!showQuotes)}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            Key Quotes ({(transcript.ai_key_quotes as unknown[]).length})
            {showQuotes ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {showQuotes && (
            <div className="space-y-2 mt-2">
              {(transcript.ai_key_quotes as { quote: string; context: string; speaker: string }[]).map((q, i) => (
                <div key={i} className="p-3 rounded-lg border border-gray-100 bg-gray-50">
                  <p className="text-sm italic text-gray-700">&ldquo;{q.quote}&rdquo;</p>
                  <p className="text-xs text-gray-400 mt-1">{q.speaker}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
