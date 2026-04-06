'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createClient } from '@/lib/supabase/client';
import { useSession } from '@/hooks/use-session';
import { TeamMember, LeadStage } from '@/types';
import { STAGE_LABELS, ACTIVE_STAGES } from '@/lib/constants';

interface LeadFormModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface FormData {
  contact_name: string;
  contact_email: string;
  company_name: string;
  contact_role: string;
  owned_by: string;
  sourced_by: string;
  stage: LeadStage;
}

const EMPTY_FORM: FormData = {
  contact_name: '',
  contact_email: '',
  company_name: '',
  contact_role: '',
  owned_by: '',
  sourced_by: '',
  stage: 'replied',
};

export function LeadFormModal({ open, onClose, onSuccess }: LeadFormModalProps) {
  const { user } = useSession();
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Fetch team members once on mount
  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('team_members')
      .select('id, name, email, gmail_connected, created_at')
      .order('name')
      .then(({ data }) => {
        if (data) setTeamMembers(data as TeamMember[]);
      });
  }, []);

  // Pre-fill owned_by / sourced_by with current user once members load
  useEffect(() => {
    if (user && teamMembers.length > 0) {
      const match = teamMembers.find((m) => m.id === user.team_member_id);
      if (match) {
        setForm((prev) => ({
          ...prev,
          owned_by: prev.owned_by || match.id,
          sourced_by: prev.sourced_by || match.id,
        }));
      }
    }
  }, [user, teamMembers]);

  function handleChange(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleClose() {
    setForm(EMPTY_FORM);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      toast.error('Not logged in');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': user.team_member_id,
        },
        body: JSON.stringify(form),
      });

      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || 'Failed to create lead');
        return;
      }

      if (json.duplicate_warning) {
        toast.warning(
          `Possible duplicate: ${json.duplicate_warning.contact_name} at ${json.duplicate_warning.company_name} already exists.`
        );
      } else {
        toast.success(`Lead created: ${json.lead.contact_name}`);
      }

      handleClose();
      onSuccess();
    } catch {
      toast.error('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Lead</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="contact_name">
                Contact Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="contact_name"
                value={form.contact_name}
                onChange={(e) => handleChange('contact_name', e.target.value)}
                placeholder="Jane Smith"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact_email">
                Email <span className="text-red-500">*</span>
              </Label>
              <Input
                id="contact_email"
                type="email"
                value={form.contact_email}
                onChange={(e) => handleChange('contact_email', e.target.value)}
                placeholder="jane@acme.com"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="company_name">
                Company <span className="text-red-500">*</span>
              </Label>
              <Input
                id="company_name"
                value={form.company_name}
                onChange={(e) => handleChange('company_name', e.target.value)}
                placeholder="Acme Inc."
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact_role">Role</Label>
              <Input
                id="contact_role"
                value={form.contact_role}
                onChange={(e) => handleChange('contact_role', e.target.value)}
                placeholder="CTO"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Owned By</Label>
              <Select
                value={form.owned_by}
                onValueChange={(v) => v && handleChange('owned_by', v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select owner" />
                </SelectTrigger>
                <SelectContent>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Sourced By</Label>
              <Select
                value={form.sourced_by}
                onValueChange={(v) => v && handleChange('sourced_by', v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select sourcer" />
                </SelectTrigger>
                <SelectContent>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Stage</Label>
            <Select
              value={form.stage}
              onValueChange={(v) => v && handleChange('stage', v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select stage" />
              </SelectTrigger>
              <SelectContent>
                {ACTIVE_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
