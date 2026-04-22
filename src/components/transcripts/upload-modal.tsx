'use client';

import { useState, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Upload, FileText, Loader2, Sparkles } from '@/lib/icons';
import { cn } from '@/lib/utils';

interface UploadModalProps {
  open: boolean;
  leadId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function TranscriptUploadModal({ open, leadId, onClose, onSuccess }: UploadModalProps) {
  const { user } = useSession();
  const [pasteText, setPasteText] = useState('');
  const [granolaUrl, setGranolaUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  const handleUpload = async (sourceType: 'txt_upload' | 'paste' | 'granola_link', file?: File) => {
    if (!user) return;
    setUploading(true);

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

      const res = await fetch('/api/transcripts/upload', {
        method: 'POST',
        headers,
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      toast.success('Transcript uploaded! AI is processing in background.', {
        description: 'Results will auto-apply to this lead when ready.',
        duration: 5000,
      });
      onSuccess?.();
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleClose = () => {
    setPasteText('');
    setGranolaUrl('');
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4.5 w-4.5 text-gray-500" />
            Upload Transcript
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="file">
          <TabsList className="w-full">
            <TabsTrigger value="file" className="flex-1" disabled={uploading}>
              <Upload className="h-4 w-4 mr-2" />Upload File
            </TabsTrigger>
            <TabsTrigger value="paste" className="flex-1" disabled={uploading}>
              <FileText className="h-4 w-4 mr-2" />Paste Text
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-4">
            <div
              className={cn(
                'border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-200',
                uploading && 'pointer-events-none opacity-50',
                dragOver ? 'border-blue-400 bg-blue-50/50 scale-[1.01]' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/30'
              )}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => !uploading && fileInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-8 w-8 text-blue-500 animate-spin mx-auto" />
              ) : (
                <>
                  <div className={cn('h-10 w-10 rounded-xl mx-auto mb-3 flex items-center justify-center', dragOver ? 'bg-blue-100' : 'bg-gray-100')}>
                    <Upload className={cn('h-5 w-5', dragOver ? 'text-blue-500' : 'text-gray-400')} />
                  </div>
                  <p className="text-sm font-medium text-gray-700">{dragOver ? 'Drop to upload' : 'Drop your transcript here'}</p>
                  <p className="text-xs text-gray-400 mt-1">Supports .txt and .md files</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="hidden"
                disabled={uploading}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload('txt_upload', file);
                }}
              />
            </div>
          </TabsContent>

          <TabsContent value="paste" className="mt-4 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Granola URL (optional)</Label>
              <Input placeholder="https://app.granola.ai/..." value={granolaUrl} onChange={e => setGranolaUrl(e.target.value)} className="text-sm h-9" disabled={uploading} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Transcript Text</Label>
                {charCount > 0 && <span className="text-xs text-gray-400">{charCount.toLocaleString()} chars</span>}
              </div>
              <Textarea placeholder="Paste your transcript..." value={pasteText} onChange={e => setPasteText(e.target.value)} rows={12} className="font-mono text-xs leading-relaxed" disabled={uploading} />
            </div>
            <Button className="w-full" disabled={!pasteText.trim() || uploading} onClick={() => handleUpload('paste')}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
              {uploading ? 'Uploading...' : 'Upload & Process'}
            </Button>
          </TabsContent>
        </Tabs>

        <p className="text-xs text-gray-400 text-center mt-2">AI analysis runs in background. Results auto-apply to this lead.</p>
      </DialogContent>
    </Dialog>
  );
}
