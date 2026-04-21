'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { toast } from 'sonner';
import { formatDate } from '@/lib/utils';
import { Mail, CheckCircle, XCircle, RefreshCw, Loader2, Calendar, Fingerprint } from '@/lib/icons';
import { startRegistration } from '@simplewebauthn/browser';

interface MemberGmailStatus {
  id: string;
  name: string;
  email: string;
  gmail_connected: boolean;
  last_gmail_sync: string | null;
}

export default function SettingsPage() {
  const { user } = useSession();
  const [members, setMembers] = useState<MemberGmailStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [registeringPasskey, setRegisteringPasskey] = useState(false);

  const fetchMembers = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/settings/gmail-status', {
        headers: { 'x-team-member-id': user.team_member_id },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setMembers(data.members || []);
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    if (!user) return;
    fetch(`/api/auth/passkey/status?memberId=${user.team_member_id}`)
      .then(r => r.json())
      .then(d => setHasPasskey(d.hasPasskey ?? false))
      .catch(() => {});
  }, [user]);

  const handleRegisterPasskey = async () => {
    if (!user) return;
    setRegisteringPasskey(true);
    try {
      const optRes = await fetch('/api/auth/passkey/register', {
        headers: { 'x-team-member-id': user.team_member_id },
      });
      const options = await optRes.json();
      if (!optRes.ok) throw new Error(options.error || 'Failed to start registration');

      const credential = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch('/api/auth/passkey/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': user.team_member_id,
        },
        body: JSON.stringify(credential),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyData.error || 'Registration failed');

      setHasPasskey(true);
      toast.success('Touch ID registered! You can now use it for login.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to register Touch ID');
    } finally {
      setRegisteringPasskey(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'true') {
      toast.success('Gmail connected successfully!');
      window.history.replaceState({}, '', '/settings');
      fetchMembers();
    } else if (params.get('error')) {
      const errMap: Record<string, string> = {
        gmail_denied: 'Gmail access was denied.',
        gmail_invalid: 'Invalid OAuth response.',
        gmail_state_mismatch: 'Security check failed. Please try again.',
        gmail_db_error: 'Failed to save Gmail tokens.',
        gmail_token_error: 'Failed to exchange authorization code.',
      };
      toast.error(errMap[params.get('error')!] || 'Gmail connection failed.');
      window.history.replaceState({}, '', '/settings');
    }
  }, [fetchMembers]);

  const handleConnect = (memberId: string) => {
    window.location.href = `/api/gmail/connect?member_id=${memberId}`;
  };

  const handleDisconnect = async (memberId: string) => {
    if (!user) return;
    setDisconnecting(memberId);
    try {
      const res = await fetch('/api/gmail/disconnect', {
        method: 'POST',
        headers: { 'x-team-member-id': user.team_member_id },
      });
      if (!res.ok) throw new Error('Failed to disconnect');
      toast.success('Gmail disconnected');
      await fetchMembers();
    } catch {
      toast.error('Failed to disconnect Gmail');
    } finally {
      setDisconnecting(null);
    }
  };

  const handleManualSync = async (memberId: string) => {
    if (!user) return;
    setSyncing(memberId);
    try {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'x-team-member-id': user.team_member_id },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      toast.success(`Sync complete — ${data.synced ?? 0} emails synced`);
      await fetchMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(null);
    }
  };

  const handleCalendarSync = async () => {
    if (!user) return;
    setSyncingCalendar(true);
    try {
      const res = await fetch('/api/gmail/sync-calendar', {
        method: 'POST',
        headers: { 'x-team-member-id': user.team_member_id },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Calendar sync failed');
      const { leads_created, leads_updated, events_scanned } = data.result;
      toast.success(`Calendar sync done — ${events_scanned} events scanned, ${leads_created} leads created, ${leads_updated} updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Calendar sync failed');
    } finally {
      setSyncingCalendar(false);
    }
  };

  const isCurrentUser = (memberId: string) => user?.team_member_id === memberId;

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-8 py-5 flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage integrations and team preferences.</p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6 max-w-3xl space-y-6">
        {/* Touch ID Section */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
            <Fingerprint className="h-5 w-5 text-gray-500" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Touch ID / Biometric Login</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Enable Touch ID as a second factor after password for secure login.
              </p>
            </div>
          </div>
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {hasPasskey ? (
                <>
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-green-600 font-medium">Touch ID enabled</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-gray-300" />
                  <span className="text-sm text-gray-500">Touch ID not set up</span>
                </>
              )}
            </div>
            {!hasPasskey && (
              <button
                onClick={handleRegisterPasskey}
                disabled={registeringPasskey}
                className="flex items-center gap-1.5 text-xs text-white bg-gray-900 hover:bg-gray-700 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                {registeringPasskey ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Fingerprint className="h-3.5 w-3.5" />
                )}
                {registeringPasskey ? 'Registering...' : 'Set Up Touch ID'}
              </button>
            )}
          </div>
        </div>

        {/* Gmail Section */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
            <Mail className="h-5 w-5 text-gray-500" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Gmail & Calendar Integration</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Connect Gmail to sync outreach emails. Calendar sync imports Proxi calls where another founder is co-attending.
              </p>
            </div>
          </div>

          <div className="divide-y divide-gray-50">
            {members.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-gray-400">No team members found.</div>
            )}
            {members.map((member) => {
              const isSelf = isCurrentUser(member.id);
              const isSyncing = syncing === member.id;
              const isDisconnecting = disconnecting === member.id;

              return (
                <div key={member.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="h-9 w-9 rounded-full bg-gray-900 flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
                    {member.name[0]?.toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{member.name}</span>
                      {isSelf && (
                        <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">You</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{member.email}</p>
                    {member.gmail_connected && member.last_gmail_sync && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Last synced {formatDate(member.last_gmail_sync)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {member.gmail_connected ? (
                      <>
                        <CheckCircle className="h-4 w-4 text-green-500" />
                        <span className="text-xs text-green-600 font-medium">Connected</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4 text-gray-300" />
                        <span className="text-xs text-gray-400">Not connected</span>
                      </>
                    )}
                  </div>

                  {isSelf && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {member.gmail_connected ? (
                        <>
                          <button
                            onClick={handleCalendarSync}
                            disabled={syncingCalendar}
                            className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            <Calendar className={`h-3.5 w-3.5 ${syncingCalendar ? 'animate-spin' : ''}`} />
                            {syncingCalendar ? 'Syncing...' : 'Sync Calendar'}
                          </button>
                          <button
                            onClick={() => handleManualSync(member.id)}
                            disabled={isSyncing}
                            className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                            {isSyncing ? 'Syncing...' : 'Sync Email'}
                          </button>
                          <button
                            onClick={() => handleDisconnect(member.id)}
                            disabled={isDisconnecting}
                            className="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleConnect(member.id)}
                          className="flex items-center gap-1.5 text-xs text-white bg-gray-900 hover:bg-gray-700 rounded-lg px-3 py-1.5 transition-colors"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          Connect Gmail
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
