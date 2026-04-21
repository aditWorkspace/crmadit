'use client';

import { useState, useEffect, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { TeamMember } from '@/types';
import { Loader2, ArrowLeft, Fingerprint } from '@/lib/icons';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

const AVATAR_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500'];

export function UserSelectorModal() {
  const { user, setUser, isLoading } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [fetching, setFetching] = useState(true);
  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [step, setStep] = useState<'password' | '2fa' | 'register'>('password');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/team/members')
      .then(r => r.json())
      .then(d => setMembers(d.members || []))
      .finally(() => setFetching(false));
  }, []);

  useEffect(() => {
    if (selected && step === 'password') {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [selected, step]);

  if (isLoading || fetching || user) return null;

  const reset = () => { setSelected(null); setPin(''); setError(''); setStep('password'); };

  const handleSelectMember = (member: TeamMember) => {
    setSelected(member);
    setPin('');
    setError('');
    setStep('password');
  };

  const handleVerify = async () => {
    if (pin.length < 1) { setError('Enter your password'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: selected!.id, memberName: selected!.name, password: pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPin('');
        setError((data.error ?? 'Incorrect password') + (data.debug ? ` (${data.debug})` : ''));
        setCooldown(3);
        const interval = setInterval(() => {
          setCooldown(prev => {
            if (prev <= 1) { clearInterval(interval); inputRef.current?.focus(); return 0; }
            return prev - 1;
          });
        }, 1000);
        return;
      }

      // Check if localhost - skip Touch ID on localhost (doesn't work reliably)
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

      if (isLocalhost) {
        // Localhost: password only, complete login
        setUser({ team_member_id: selected!.id, name: selected!.name });
        return;
      }

      // Production: require Touch ID
      const statusRes = await fetch(`/api/auth/passkey/status?memberId=${selected!.id}`);
      const statusData = await statusRes.json();

      if (statusData.hasPasskey) {
        setStep('2fa');
      } else {
        setStep('register');
      }
      setPin('');
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleTouchID = async () => {
    setError('');
    setLoading(true);
    try {
      // Get authentication options
      const optRes = await fetch(`/api/auth/passkey/login?memberId=${selected!.id}`);
      const options = await optRes.json();
      if (!optRes.ok) throw new Error(options.error || 'Failed to start');

      // Prompt for Touch ID
      const credential = await startAuthentication({ optionsJSON: options });

      // Verify with server
      const verifyRes = await fetch('/api/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credential, flowId: options.flowId }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed');

      setUser({ team_member_id: selected!.id, name: selected!.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Touch ID failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterTouchID = async () => {
    setError('');
    setLoading(true);
    try {
      // Get registration options (need temp session for this)
      const optRes = await fetch('/api/auth/passkey/register', {
        headers: { 'x-team-member-id': selected!.id },
      });
      const options = await optRes.json();
      if (!optRes.ok) throw new Error(options.error || 'Failed to start registration');

      // Prompt for Touch ID registration
      const credential = await startRegistration({ optionsJSON: options });

      // Save credential to server
      const saveRes = await fetch('/api/auth/passkey/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': selected!.id,
        },
        body: JSON.stringify(credential),
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData.error || 'Failed to save');

      // Registration complete - now verify to complete login
      setStep('2fa');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Touch ID setup failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Member picker ─────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
        <div className="w-full max-w-lg px-8">
          <div className="mb-12 text-center">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-gray-900 mb-5">
              <span className="text-white text-2xl font-bold">P</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Proxi CRM</h1>
            <p className="mt-2 text-gray-500 text-sm">Select your account to continue</p>
          </div>
          <div className="flex gap-4 justify-center">
            {members.map((member, i) => (
              <button
                key={member.id}
                onClick={() => handleSelectMember(member)}
                className="flex flex-col items-center gap-3 rounded-2xl border border-gray-200 p-8 hover:border-gray-400 hover:shadow-lg transition-all cursor-pointer w-40 group"
              >
                <div className={`h-16 w-16 rounded-full ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center text-2xl font-semibold text-white group-hover:scale-105 transition-transform shadow-md`}>
                  {member.name[0]}
                </div>
                <span className="text-base font-medium text-gray-900">{member.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── PIN entry or 2FA ───────────────────────────────────────────────────────
  const colorIndex = members.findIndex(m => m.id === selected.id);

  // Register step - Set up Touch ID (mandatory)
  if (step === 'register') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
        <div className="w-full max-w-xs px-6">
          <button onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-8 transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          <div className="text-center mb-6">
            <div className={`h-20 w-20 rounded-full ${AVATAR_COLORS[colorIndex >= 0 ? colorIndex : 0]} flex items-center justify-center text-3xl font-semibold text-white mx-auto mb-4 shadow-lg`}>
              {selected.name[0]}
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Set Up Touch ID</h2>
            <p className="text-sm text-gray-500 mt-1">Touch ID is required for login security</p>
          </div>

          <button
            onClick={handleRegisterTouchID}
            disabled={loading}
            className="w-full py-4 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-3 text-base"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <Fingerprint className="h-6 w-6" />
                Register Touch ID
              </>
            )}
          </button>

          {error && <p className="text-sm text-red-500 text-center mt-3 font-medium">{error}</p>}
        </div>
      </div>
    );
  }

  // 2FA step - Touch ID
  if (step === '2fa') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
        <div className="w-full max-w-xs px-6">
          <button onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-8 transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          <div className="text-center mb-6">
            <div className={`h-20 w-20 rounded-full ${AVATAR_COLORS[colorIndex >= 0 ? colorIndex : 0]} flex items-center justify-center text-3xl font-semibold text-white mx-auto mb-4 shadow-lg`}>
              {selected.name[0]}
            </div>
            <h2 className="text-xl font-semibold text-gray-900">{selected.name}</h2>
            <p className="text-sm text-gray-500 mt-1">Use Touch ID to continue</p>
          </div>

          <button
            onClick={handleTouchID}
            disabled={loading}
            className="w-full py-4 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-3 text-base"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <Fingerprint className="h-6 w-6" />
                Verify with Touch ID
              </>
            )}
          </button>

          {error && <p className="text-sm text-red-500 text-center mt-3 font-medium">{error}</p>}
        </div>
      </div>
    );
  }

  // Password step
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
      <div className="w-full max-w-xs px-6">
        <button onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-8 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        <div className="text-center mb-6">
          <div className={`h-20 w-20 rounded-full ${AVATAR_COLORS[colorIndex >= 0 ? colorIndex : 0]} flex items-center justify-center text-3xl font-semibold text-white mx-auto mb-4 shadow-lg`}>
            {selected.name[0]}
          </div>
          <h2 className="text-xl font-semibold text-gray-900">{selected.name}</h2>
          <p className="text-sm text-gray-500 mt-1">Enter your password</p>
        </div>

        <input
          ref={inputRef}
          type="password"
          value={pin}
          onChange={e => { setPin(e.target.value); setError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') handleVerify(); }}
          className="w-full rounded-xl border border-gray-200 px-4 py-3.5 outline-none focus:border-gray-900 focus:ring-2 focus:ring-gray-100 text-base transition-colors"
          placeholder="Password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />

        {error && <p className="text-sm text-red-500 text-center mt-3 font-medium">{error}</p>}

        <button
          onClick={handleVerify}
          disabled={loading || pin.length < 1 || cooldown > 0}
          className="w-full mt-5 py-3.5 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-sm"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : cooldown > 0 ? `Try again in ${cooldown}s` : 'Continue'}
        </button>
      </div>
    </div>
  );
}
