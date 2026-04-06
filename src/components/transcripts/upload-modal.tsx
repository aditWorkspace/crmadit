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
import { Upload, Link, FileText, Loader2, CheckCircle2, X, Plus } from 'lucide-react';
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

export function TranscriptUploadModal({ open, leadId, onClose, onSuccess, members = [] }: UploadModalProps) {
  const { user } = useSession();
  const [step, setStep] = useState<ModalStep>('upload');
  const [pasteText, setPasteText] = useState('');
  const [granolaUrl, setGranolaUrl] = useState('');
  const [granolaText, setGranolaText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  const handleUpload = async (sourceType: 'txt_upload' | 'paste' | 'granola_link', file?: File) => {
    if (!user) return;
    setStep('processing');

    try {
      const formData = new FormData();
      formData.append('lead_id', leadId);
      formData.append('source_type', sourceType);

      if (sourceType === 'txt_upload' && file) {
        formData.append('file', file);
      } else if (sourceType === 'paste') {
        formData.append('raw_text', pasteText);
      } else if (sourceType === 'granola_link') {
        formData.append('raw_text', granolaText);
        if (granolaUrl) formData.append('granola_url', granolaUrl);
      }

      // Upload transcript
      const uploadRes = await fetch('/api/transcripts/upload', {
        method: 'POST',
        headers,
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error);

      // Process with AI
      const processRes = await fetch(`/api/transcripts/${uploadData.transcript.id}/process`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      const processData = await processRes.json();
      if (!processRes.ok) throw new Error(processData.error);

      const analysis = processData.analysis;
      setReview({
        transcriptId: uploadData.transcript.id,
        summary: analysis.summary || '',
        next_steps: analysis.next_steps || '',
        sentiment: analysis.sentiment || 'neutral',
        interest_level: analysis.interest_level || 'medium',
        action_items: (analysis.action_items || []).map((item: AiActionItem) => ({
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
      if (!res.ok) throw new Error('Failed to apply');
      toast.success('Transcript applied — lead updated, action items created');
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
    setGranolaText('');
    setReview(null);
    onClose();
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'text/plain' || file?.name.endsWith('.txt')) {
      handleUpload('txt_upload', file);
    } else {
      toast.error('Only .txt files are supported');
    }
  };

  const sentimentOptions = ['very_positive', 'positive', 'neutral', 'negative'];
  const interestOptions = ['high', 'medium', 'low'];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && 'Upload Transcript'}
            {step === 'processing' && 'Processing...'}
            {step === 'review' && 'Review AI Analysis'}
          </DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <Tabs defaultValue="file">
            <TabsList className="w-full">
              <TabsTrigger value="file" className="flex-1"><Upload className="h-4 w-4 mr-2" />Upload File</TabsTrigger>
              <TabsTrigger value="paste" className="flex-1"><FileText className="h-4 w-4 mr-2" />Paste Text</TabsTrigger>
              <TabsTrigger value="granola" className="flex-1"><Link className="h-4 w-4 mr-2" />Granola Link</TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="mt-4">
              <div
                className={cn(
                  'border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors',
                  dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                )}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-8 w-8 text-gray-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-600">Drop your .txt transcript here</p>
                <p className="text-xs text-gray-400 mt-1">or click to browse</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload('txt_upload', file);
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="paste" className="mt-4 space-y-3">
              <Textarea
                placeholder="Paste transcript text here..."
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={12}
                className="font-mono text-xs"
              />
              <Button
                className="w-full"
                disabled={!pasteText.trim()}
                onClick={() => handleUpload('paste')}
              >
                Process Transcript
              </Button>
            </TabsContent>

            <TabsContent value="granola" className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label>Granola URL (for reference)</Label>
                <Input
                  placeholder="https://app.granola.ai/..."
                  value={granolaUrl}
                  onChange={e => setGranolaUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Transcript Text *</Label>
                <Textarea
                  placeholder="Paste the transcript content from Granola here..."
                  value={granolaText}
                  onChange={e => setGranolaText(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                />
              </div>
              <Button
                className="w-full"
                disabled={!granolaText.trim()}
                onClick={() => handleUpload('granola_link')}
              >
                Process Transcript
              </Button>
            </TabsContent>
          </Tabs>
        )}

        {step === 'processing' && (
          <div className="py-16 text-center space-y-4">
            <Loader2 className="h-10 w-10 text-blue-500 animate-spin mx-auto" />
            <div>
              <p className="text-sm font-medium text-gray-700">Analyzing transcript with AI...</p>
              <p className="text-xs text-gray-400 mt-1">This takes 15-30 seconds</p>
            </div>
          </div>
        )}

        {step === 'review' && review && (
          <div className="space-y-6 pt-2">
            {/* Summary */}
            <div className="space-y-1.5">
              <Label>Summary</Label>
              <Textarea
                value={review.summary}
                onChange={e => setReview(r => r ? { ...r, summary: e.target.value } : r)}
                rows={3}
              />
            </div>

            {/* Next Steps */}
            <div className="space-y-1.5">
              <Label>Next Steps</Label>
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
              <Label>Action Items ({review.action_items.length})</Label>
              {review.action_items.map((item, i) => (
                <div key={i} className="flex gap-2 items-start p-3 rounded-lg border border-gray-100 bg-gray-50/50">
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
                  action_items: [...r.action_items, { text: '', assigned_to: null, due_date: '', urgency: 'medium' }]
                } : r)}
                className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Add action item
              </button>
            </div>

            {/* Key Quotes (read-only) */}
            {review.key_quotes.length > 0 && (
              <div className="space-y-2">
                <Label>Key Quotes</Label>
                {review.key_quotes.slice(0, 3).map((q, i) => (
                  <div key={i} className="p-3 rounded-lg border border-gray-100 bg-gray-50">
                    <p className="text-sm italic text-gray-700">&ldquo;{q.quote}&rdquo;</p>
                    <p className="text-xs text-gray-400 mt-1">{q.speaker} — {q.context}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Pain Points (read-only) */}
            {review.pain_points.length > 0 && (
              <div className="space-y-1.5">
                <Label>Pain Points</Label>
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
