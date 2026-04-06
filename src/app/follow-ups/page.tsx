'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { FollowUp } from '@/types';
import { FollowUpCard } from '@/components/follow-ups/follow-up-card';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { RelativeTime } from '@/components/ui/relative-time';
import { SkeletonCards } from '@/components/ui/skeleton-cards';
import { Clock, CheckCheck, Bell } from 'lucide-react';

export default function FollowUpsPage() {
  const { user } = useSession();
  const [pending, setPending] = useState<FollowUp[]>([]);
  const [completed, setCompleted] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFollowUps = useCallback(async () => {
    if (!user) return;
    const headers = { 'x-team-member-id': user.team_member_id };

    const [pendingRes, completedRes] = await Promise.all([
      fetch(`/api/follow-ups?status=pending&assigned_to=${user.team_member_id}`, { headers }).then(r => r.json()),
      fetch(`/api/follow-ups?status=completed&assigned_to=${user.team_member_id}`, { headers }).then(r => r.json()),
    ]);

    // Sort pending: overdue first, then by due_at ascending
    const pendingList: FollowUp[] = pendingRes.follow_ups || [];
    pendingList.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
    setPending(pendingList);

    const completedList: FollowUp[] = completedRes.follow_ups || [];
    completedList.sort((a, b) => new Date(b.completed_at || b.due_at).getTime() - new Date(a.completed_at || a.due_at).getTime());
    setCompleted(completedList);

    setLoading(false);
  }, [user]);

  useEffect(() => { fetchFollowUps(); }, [fetchFollowUps]);

  const handleUpdate = useCallback(async (id: string, action: string, params?: Record<string, unknown>) => {
    if (!user) return;
    const res = await fetch(`/api/follow-ups/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-team-member-id': user.team_member_id,
      },
      body: JSON.stringify({ action, ...params }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Failed to update');
      return;
    }

    const actionLabels: Record<string, string> = {
      complete: 'Marked as done',
      dismiss: 'Dismissed',
      snooze: `Snoozed ${params?.snooze_days || 1} day(s)`,
    };
    toast.success(actionLabels[action] || 'Updated');
    await fetchFollowUps();
  }, [user, fetchFollowUps]);

  const overdueCount = pending.filter(f => new Date(f.due_at) < new Date()).length;

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-4 md:px-8 py-5 flex-shrink-0 pt-16 md:pt-5">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Follow-ups</h1>
          {overdueCount > 0 && (
            <Badge variant="destructive" className="text-xs">{overdueCount} overdue</Badge>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-0.5">Your pending follow-up actions.</p>
      </div>

      <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
        <Tabs defaultValue="pending">
          <TabsList className="mb-6">
            <TabsTrigger value="pending" className="gap-2">
              <Clock className="h-3.5 w-3.5" />
              Pending
              {pending.length > 0 && (
                <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-xs">{pending.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-2">
              <CheckCheck className="h-3.5 w-3.5" />
              Completed
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {loading ? (
              <SkeletonCards count={4} />
            ) : pending.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <Bell className="h-10 w-10 mx-auto mb-3 text-gray-200" />
                <p className="text-sm font-medium text-gray-700">You&apos;re all caught up!</p>
                <p className="text-xs mt-1 text-gray-400">No pending follow-ups right now.</p>
              </div>
            ) : (
              <div className="space-y-3 max-w-2xl">
                {pending.map(f => (
                  <FollowUpCard key={f.id} followUp={f} onUpdate={handleUpdate} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="history">
            {loading ? (
              <SkeletonCards count={3} />
            ) : completed.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <CheckCheck className="h-10 w-10 mx-auto mb-3 text-gray-200" />
                <p className="text-sm">No completed follow-ups yet.</p>
              </div>
            ) : (
              <div className="space-y-2 max-w-2xl">
                {completed.map(f => {
                  const lead = f.lead as { id: string; contact_name: string; company_name: string } | undefined;
                  return (
                    <div key={f.id} className="flex items-center gap-4 py-2.5 px-4 rounded-lg border border-gray-100 bg-white text-sm">
                      <CheckCheck className="h-4 w-4 text-green-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-gray-700">{lead?.contact_name || '—'}</span>
                        <span className="text-gray-400"> at {lead?.company_name || '—'}</span>
                      </div>
                      {f.completed_at && (
                        <RelativeTime date={f.completed_at} className="text-xs text-gray-400 flex-shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
