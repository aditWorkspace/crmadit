'use client';

import { useState, useEffect, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { TeamMember } from '@/types';
import { Loader2, ArrowLeft, Eye, EyeOff } from 'lucide-react';

type Screen = 'pick' | 'create-pin' | 'enter-pin';

const AVATAR_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500'];

/** SHA-256 hash of the PIN, returned as hex string. Runs in the browser via Web Crypto. */
async function hashPin(pin: string): Promise<string> {
  const encoded = new TextEncoder().encode(pin);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pinStorageKey(memberId: string) {
  return `proxi_crm_pin_${memberId}`;
}

function getStoredPinHash(memberId: string): string | null {
  try { return localStorage.getItem(pinStorageKey(memberId)); } catch { return null; }
}

function storePinHash(memberId: string, hash: string) {
  try { localStorage.setItem(pinStorageKey(memberId), hash); } catch { /* ignore */ }
}

export function UserSelectorModal() {
  const { user, setUser, isLoading } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [fetching, setFetching] = useState(true);
  const [screen, setScreen] = useState<Screen>('pick');
  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/team/members')
      .then(r => r.json())
      .then(d => setMembers(d.members || []))
      .finally(() => setFetching(false));
  }, []);

  useEffect(() => {
    if (screen !== 'pick') setTimeout(() => pinRef.current?.focus(), 100);
  }, [screen]);

  if (isLoading || fetching || user) return null;

  const reset = () => { setScreen('pick'); setError(''); setPin(''); setConfirmPin(''); setSelected(null); };

  const handleSelectMember = (member: TeamMember) => {
    setSelected(member);
    setError('');
    setPin('');
    setConfirmPin('');
    const stored = getStoredPinHash(member.id);
    setScreen(stored ? 'enter-pin' : 'create-pin');
  };

  const handleCreatePin = async () => {
    if (pin.length !== 4) { setError('PIN must be 4 digits'); return; }
    if (pin !== confirmPin) { setError("PINs don't match — try again"); setConfirmPin(''); confirmRef.current?.focus(); return; }
    setError('');
    setLoading(true);
    try {
      const hash = await hashPin(pin);
      storePinHash(selected!.id, hash);
      setUser({ team_member_id: selected!.id, name: selected!.name });
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPin = async () => {
    if (pin.length !== 4) { setError('Enter your 4-digit PIN'); return; }
    setError('');
    setLoading(true);
    try {
      const stored = getStoredPinHash(selected!.id);
      if (!stored) { setScreen('create-pin'); return; }
      const hash = await hashPin(pin);
      if (hash !== stored) {
        setPin('');
        setError('Incorrect PIN. Try again.');
        pinRef.current?.focus();
        return;
      }
      setUser({ team_member_id: selected!.id, name: selected!.name });
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const PinDots = ({ value }: { value: string }) => (
    <div className="flex gap-4 justify-center my-5">
      {[0,1,2,3].map(i => (
        <div key={i} className={`h-3.5 w-3.5 rounded-full border-2 transition-all duration-150 ${
          i < value.length ? 'bg-gray-900 border-gray-900 scale-110' : 'bg-transparent border-gray-300'
        }`} />
      ))}
    </div>
  );

  if (screen === 'pick') {
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

  const isCreate = screen === 'create-pin';
  const colorIndex = members.findIndex(m => m.id === selected?.id);
  const showConfirm = isCreate && pin.length === 4;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
      <div className="w-full max-w-xs px-6">
        <button onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-8 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        <div className="text-center mb-6">
          <div className={`h-20 w-20 rounded-full ${AVATAR_COLORS[colorIndex >= 0 ? colorIndex : 0]} flex items-center justify-center text-3xl font-semibold text-white mx-auto mb-4 shadow-lg`}>
            {selected?.name[0]}
          </div>
          <h2 className="text-xl font-semibold text-gray-900">{selected?.name}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {isCreate ? (showConfirm ? 'Confirm your PIN' : 'Create a 4-digit PIN') : 'Enter your PIN'}
          </p>
        </div>

        <PinDots value={showConfirm ? confirmPin : pin} />
        <div className="relative">
          <input
            ref={showConfirm ? confirmRef : pinRef}
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={showConfirm ? confirmPin : pin}
            onChange={e => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 4);
              setError('');
              if (showConfirm) setConfirmPin(v);
              else setPin(v);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') isCreate ? handleCreatePin() : handleVerifyPin();
            }}
            className="w-full text-center text-3xl tracking-[0.6em] rounded-xl border border-gray-200 px-4 py-3.5 outline-none focus:border-gray-900 focus:ring-2 focus:ring-gray-100 font-mono transition-colors"
            placeholder="····"
            autoComplete="off"
          />
          <button onClick={() => setShowPin(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
            {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {showConfirm && (
          <button onClick={() => { setConfirmPin(''); setPin(''); }} className="text-xs text-gray-400 hover:text-gray-600 mt-2 mx-auto block">← Re-enter PIN</button>
        )}

        {error && <p className="text-sm text-red-500 text-center mt-3 font-medium">{error}</p>}

        <button
          onClick={isCreate ? handleCreatePin : handleVerifyPin}
          disabled={loading || (!showConfirm && pin.length < 4) || (showConfirm && confirmPin.length < 4)}
          className="w-full mt-5 py-3.5 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-sm"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : isCreate ? 'Set PIN & Enter' : 'Unlock'}
        </button>

        {!isCreate && (
          <p className="text-xs text-gray-400 text-center mt-4">Forgot your PIN? Clear your browser data to reset it.</p>
        )}
      </div>
    </div>
  );
}
