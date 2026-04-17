'use client';

import { useState, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { TeamMember, AiActionItem, AiKeyQuote, AiPainPoint, AiProductFeedback, AiFollowUpSuggestion } from '@/types';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Upload, FileText, Loader2, CheckCircle2, X, Plus,
  Brain, Target, Quote, AlertTriangle, Sparkles,
} from '@/lib/icons';
import { cn } from '@/lib/utils';

interface UploadModalProps {
  open: boolean;
  leadId: string;
  onClose: () => void;
  onSuccess?: () => void;
  members?: TeamMember[];
}

interface ReviewData {
  transcriptId: string;
  summary: string;
  next_steps: string;
  sentiment: string;
  interest_level: string;
  action_items: Array<{
    _uid: string;
    text: string;
    assigned_to: string | null;
    due_date: string;
    urgency: 'high' | 'medium' | 'low';
  }>;
  key_quotes: AiKeyQuote[];
  pain_points: AiPainPoint[];
  product_feedback: AiProductFeedback[];
  follow_up_suggestions: AiFollowUpSuggestion[];
}

type ModalStep = 'upload' | 'processing' | 'review';

const PROCESSING_STEPS = [
  { label: 'Uploading', done: false },
  { label: 'AI Analysis', done: false },
  { label: 'Review', done: false },
];

export function TranscriptUploadModal({ open, leadId, onClose, onSuccess, members = [] }: UploadModalProps) {
  const { user } = useSession();
  const [step, setStep] = useState<ModalStep>('upload');
  const [pasteText, setPasteText] = useState('');
  const [granolaUrl, setGranolaUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [saving, setSaving] = useState(false);
  const [processingStage, setProcessingStage] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  const handleUpload = async (sourceType: 'txt_upload' | 'paste' | 'granola_link', file?: File) => {
    if (!user) return;
    setStep('processing');
    setProcessingStage(0);

    try {
      const formData = new FormData();
      formData.append('lead_id', leadId);
      formData.append('source_type', sourceType);

      if (sourceType === 'txt_upload' && file) {
        formData.append('file', file);
      } else if (sourceType === 'paste' || sourceType === 'granola_link') {
        formData.append('raw_text', pasteText);
        if (granolaUrl) {
          formData.append('granola_url', granolaUrl);
          formData.append('source_type', 'granola_link');
        }
      }

      // Upload transcript
      const uploadRes = await fetch('/api/transcripts/upload', {
        method: 'POST',
        headers,
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error);

      setProcessingStage(1);

      // Process with AI
      const processRes = await fetch(`/api/transcripts/${uploadData.transcript.id}/process`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      const processData = await processRes.json();
      if (!processRes.ok) throw new Error(processData.error);

      setProcessingStage(2);

      const analysis = processData.analysis;
      setReview({
        transcriptId: uploadData.transcript.id,
        summary: analysis.summary || '',
        next_steps: analysis.next_steps || '',
        sentiment: analysis.sentiment || 'neutral',
        interest_level: analysis.interest_level || 'medium',
        action_items: (analysis.action_items || []).map((item: AiActionItem) => ({
          _uid: crypto.randomUUID(),
          text: item.text,
          assigned_to: null,
          due_date: item.suggested_due_date || '',
          urgency: item.urgency || 'medium',
        })),
        key_quotes: analysis.key_quotes || [],
        pain_points: analysis.pain_points || [],
        product_feedback: analysis.product_feedback || [],
        follow_up_suggestions: analysis.follow_up_suggestions || [],
      });
      setStep('review');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
      setStep('upload');
    }
  };

  const handleSaveAndApply = async () => {
    if (!review || !user) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/transcripts/${review.transcriptId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: review.summary,
          next_steps: review.next_steps,
          sentiment: review.sentiment,
          interest_level: review.interest_level,
          action_items: review.action_items,
          follow_up_suggestions: review.follow_up_suggestions,
          apply_to_lead: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to apply');

      if (data.knowledge_docs_updated) {
        toast.success('Transcript applied — lead updated, insights added to knowledge docs');
      } else {
        toast.success('Transcript applied — lead updated, action items created');
      }
      onSuccess?.();
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setStep('upload');
    setPasteText('');
    setGranolaUrl('');
    setReview(null);
    setProcessingStage(0);
    onClose();
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'text/plain' || file?.name.endsWith('.txt') || file?.name.endsWith('.md')) {
      handleUpload('txt_upload', file);
    } else {
      toast.error('Only .txt and .md files are supported');
    }
  };

  const charCount = pasteText.length;
  const sentimentOptions = ['very_positive', 'positive', 'neutral', 'negative'];
  const interestOptions = ['high', 'medium', 'low'];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'upload' && <><Upload className="h-4.5 w-4.5 text-gray-500" /> Upload Transcript</>}
            {step === 'processing' && <><Sparkles className="h-4.5 w-4.5 text-blue-500" /> Processing...</>}
            {step === 'review' && <><CheckCircle2 className="h-4.5 w-4.5 text-green-500" /> Review AI Analysis</>}
          </DialogTitle>
        </DialogHeader>

        {/* ── Upload step ──────────────────────────────────────────────── */}
        {step === 'upload' && (
          <Tabs defaultValue="file">
            <TabsList className="w-full">
              <TabsTrigger value="file" className="flex-1">
                <Upload className="h-4 w-4 mr-2" />Upload File
              </TabsTrigger>
              <TabsTrigger value="paste" className="flex-1">
                <FileText className="h-4 w-4 mr-2" />Paste Text
              </TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="mt-4">
              <div
                className={cn(
                  'border-2 border-dashed rounded-xl p-16 text-center cursor-pointer transition-all duration-200',
                  dragOver
                    ? 'border-blue-400 bg-blue-50/50 scale-[1.01]'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/30'
                )}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className={cn(
                  'h-12 w-12 rounded-xl mx-auto mb-4 flex items-center justify-center transition-colors',
                  dragOver ? 'bg-blue-100' : 'bg-gray-100'
                )}>
                  <Upload className={cn('h-6 w-6', dragOver ? 'text-blue-500' : 'text-gray-400')} />
                </div>
                <p className="text-sm font-medium text-gray-700">
                  {dragOver ? 'Drop to upload' : 'Drop your transcript here'}
                </p>
                <p className="text-xs text-gray-400 mt-1.5">
                  Supports .txt and .md files &middot; or click to browse
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload('txt_upload', file);
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="paste" className="mt-4 space-y-3">
              {/* Optional Granola URL */}
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Granola URL (optional, for reference)</Label>
                <Input
                  placeholder="https://app.granola.ai/..."
                  value={granolaUrl}
                  onChange={e => setGranolaUrl(e.target.value)}
                  className="text-sm h-9"
                />
              </div>

              {/* Transcript text */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label>Transcript Text</Label>
                  {charCount > 0 && (
                    <span className="text-xs text-gray-400">{charCount.toLocaleString()} characters</span>
                  )}
                </div>
                <Textarea
                  placeholder="Paste your transcript from Granola, Otter, or any other source..."
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={16}
                  className="font-mono text-xs leading-relaxed"
                />
              </div>

              <Button
                className="w-full"
                disabled={!pasteText.trim()}
                onClick={() => handleUpload('paste')}
              >
                <Sparkles className="h-4 w-4 mr-2" />
                Process Transcript
              </Button>
            </TabsContent>
          </Tabs>
        )}

        {/* ── Processing step ──────────────────────────────────────────── */}
        {step === 'processing' && (
          <div className="py-12 text-center space-y-8">
            <Loader2 className="h-10 w-10 text-blue-500 animate-spin mx-auto" />

            {/* Step indicator */}
            <div className="flex items-center justify-center gap-2">
              {PROCESSING_STEPS.map((s, i) => (
                <div key={s.label} className="flex items-center gap-2">
                  <div className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                    i < processingStage ? 'bg-green-50 text-green-700' :
                    i === processingStage ? 'bg-blue-50 text-blue-700' :
                    'bg-gray-50 text-gray-400'
                  )}>
                    {i < processingStage ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : i === processingStage ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-gray-300 inline-block" />
                    )}
                    {s.label}
                  </div>
                  {i < PROCESSING_STEPS.length - 1 && (
                    <div className={cn(
                      'w-6 h-px',
                      i < processingStage ? 'bg-green-300' : 'bg-gray-200'
                    )} />
                  )}
                </div>
              ))}
            </div>

            <p className="text-xs text-gray-400">
              {processingStage === 0 && 'Uploading transcript...'}
              {processingStage === 1 && 'AI is analyzing the transcript — this takes 15-30 seconds'}
              {processingStage === 2 && 'Almost done...'}
            </p>
          </div>
        )}

        {/* ── Review step ──────────────────────────────────────────────── */}
        {step === 'review' && review && (
          <div className="space-y-6 pt-2">
            {/* Summary */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5 text-purple-500" />
                Summary
              </Label>
              <Textarea
                value={review.summary}
                onChange={e => setReview(r => r ? { ...r, summary: e.target.value } : r)}
                rows={3}
              />
            </div>

            {/* Next Steps */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5 text-blue-500" />
                Next Steps
              </Label>
              <Textarea
                value={review.next_steps}
                onChange={e => setReview(r => r ? { ...r, next_steps: e.target.value } : r)}
                rows={3}
              />
            </div>

            {/* Sentiment + Interest Level */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Sentiment</Label>
                <Select value={review.sentiment} onValueChange={v => v && setReview(r => r ? { ...r, sentiment: v } : r)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {sentimentOptions.map(s => <SelectItem key={s} value={s}>{s.replace('_', ' ')}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Interest Level</Label>
                <Select value={review.interest_level} onValueChange={v => v && setReview(r => r ? { ...r, interest_level: v } : r)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {interestOptions.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Action Items */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5 text-orange-500" />
                Action Items ({review.action_items.length})
              </Label>
              {review.action_items.map((item, i) => (
                <div key={item._uid} className="flex gap-2 items-start p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                  <div className="flex-1 space-y-2">
                    <Input
                      value={item.text}
                      onChange={e => setReview(r => {
                        if (!r) return r;
                        const items = [...r.action_items];
                        items[i] = { ...items[i], text: e.target.value };
                        return { ...r, action_items: items };
                      })}
                      className="text-sm"
                    />
                    <div className="flex gap-2">
                      <Select
                        value={item.assigned_to || 'unassigned'}
                        onValueChange={v => setReview(r => {
                          if (!r) return r;
                          const items = [...r.action_items];
                          items[i] = { ...items[i], assigned_to: v === 'unassigned' ? null : v };
                          return { ...r, action_items: items };
                        })}
                      >
                        <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Assign..." /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                          {members.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input
                        type="date"
                        value={item.due_date}
                        onChange={e => setReview(r => {
                          if (!r) return r;
                          const items = [...r.action_items];
                          items[i] = { ...items[i], due_date: e.target.value };
                          return { ...r, action_items: items };
                        })}
                        className="h-7 text-xs w-36"
                      />
                      <Select
                        value={item.urgency}
                        onValueChange={v => setReview(r => {
                          if (!r) return r;
                          const items = [...r.action_items];
                          items[i] = { ...items[i], urgency: v as 'high' | 'medium' | 'low' };
                          return { ...r, action_items: items };
                        })}
                      >
                        <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="low">Low</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <button
                    onClick={() => setReview(r => r ? { ...r, action_items: r.action_items.filter((_, j) => j !== i) } : r)}
                    className="text-gray-300 hover:text-red-400 mt-2"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setReview(r => r ? {
                  ...r,
                  action_items: [...r.action_items, { _uid: crypto.randomUUID(), text: '', assigned_to: null, due_date: '', urgency: 'medium' }]
                } : r)}
                className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Add action item
              </button>
            </div>

            {/* Key Quotes */}
            {review.key_quotes.length > 0 && (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  <Quote className="h-3.5 w-3.5 text-indigo-500" />
                  Key Quotes
                </Label>
                {review.key_quotes.slice(0, 3).map((q, i) => (
                  <div key={i} className="p-3 rounded-lg border border-gray-100 bg-gray-50">
                    <p className="text-sm italic text-gray-700">&ldquo;{q.quote}&rdquo;</p>
                    <p className="text-xs text-gray-400 mt-1">{q.speaker} &mdash; {q.context}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Pain Points */}
            {review.pain_points.length > 0 && (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                  Pain Points
                </Label>
                <div className="space-y-1">
                  {review.pain_points.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0',
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

            {/* Product Feedback */}
            {review.product_feedback.length > 0 && (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  Product Feedback
                </Label>
                <div className="space-y-1">
                  {review.product_feedback.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0',
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

            {/* Save button */}
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button onClick={handleSaveAndApply} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                Save & Apply
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
