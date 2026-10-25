'use client';

import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp';
import type { Tier } from '@/lib/types';
import { toast } from 'sonner';

const TIERS: Array<{ id: Tier; desc: string }> = [
  { id: 'Casual', desc: 'Easy → Med' },
  { id: 'Standard', desc: 'Easy → Hard' },
  { id: 'Expert', desc: 'Med → Hard' },
];

export interface JoinForm {
  pin: string;
  name: string;
  tier: Tier;
}

interface JoinGameScreenProps {
  initialPin?: string;
  onBack: () => void;
  onJoin: (form: JoinForm) => void;
}

// Nicknames are read aloud by the Voice Master and shown on the TV/feed -
// restrict to alphanumeric + '@' '#' + space so TTS/display never has to
// cope with arbitrary Unicode or markup-ish punctuation.
const NAME_MAX = 30;
const sanitizeName = (v: string) => v.replace(/[^a-zA-Z0-9@# ]/g, '').slice(0, NAME_MAX);

export default function JoinGameScreen({ initialPin = '', onBack, onJoin }: JoinGameScreenProps) {
  const [pin, setPin] = useState(initialPin.slice(0, 4));
  const [name, setName] = useState('');
  const [tier, setTier] = useState<Tier>('Standard');

  const submit = () => {
    if (pin.length !== 4) {
      toast.error('Enter the 4-digit Room PIN from the Host TV screen.');
      return;
    }
    if (!name.trim()) {
      toast.error('Please enter a valid player nickname.');
      return;
    }
    onJoin({ pin, name: sanitizeName(name.trim()), tier });
  };

  return (
    <div className="sr-glass w-full max-w-lg space-y-6 rounded-3xl border-2 p-6 shadow-2xl" style={{ borderColor: 'var(--sr-line)' }}>
      <div className="space-y-1 text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-400">
          <Smartphone className="h-6 w-6" />
        </div>
        <h2 className="font-display text-2xl font-bold text-fg">Join SnapRiddle Room</h2>
        <p className="text-xs text-sr-3">
          Enter the Room PIN, pick your nickname & difficulty tier.
        </p>
      </div>

      <div className="space-y-5 text-xs">
        {/* PIN */}
        <div className="space-y-1.5">
          <label className="block font-semibold text-sr-2">Room PIN</label>
          <div className="flex justify-center">
            <InputOTP maxLength={4} value={pin} onChange={(v) => setPin(v.replace(/\D/g, ''))}>
              <InputOTPGroup>
                <InputOTPSlot index={0} className="h-12 w-11 border-2 text-xl font-bold" />
                <InputOTPSlot index={1} className="h-12 w-11 border-2 text-xl font-bold" />
                <InputOTPSeparator />
                <InputOTPSlot index={2} className="h-12 w-11 border-2 text-xl font-bold" />
                <InputOTPSlot index={3} className="h-12 w-11 border-2 text-xl font-bold" />
              </InputOTPGroup>
            </InputOTP>
          </div>
        </div>

        {/* Nickname */}
        <div>
          <label className="mb-1 block font-semibold text-sr-2" htmlFor="join-name">
            Your Nickname
          </label>
          <Input
            id="join-name"
            value={name}
            onChange={(e) => setName(sanitizeName(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Alex"
            maxLength={NAME_MAX}
            className="rounded-xl border-2"
          />
          {/* Nicknames are unique per room and are called out loud by
             the Voice Master, so duplicates are refused at join time. */}
          <p className="mt-1 text-[10px] text-sr-3">
            Nicknames are unique per room — the Voice Master calls you by name.
          </p>
        </div>

        {/* Tier */}
        <div>
          <label className="mb-2 block font-semibold text-sr-2">Select Game Difficulty Tier</label>
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTier(t.id)}
                className={`rounded-xl border-2 p-2.5 text-center transition ${
                  tier === t.id
                    ? 'border-violet-500 bg-violet-600/25 text-violet-700 dark:text-violet-200'
                    : 'border-black/10 bg-black/5 text-sr-3 hover:border-black/20 dark:border-white/10 dark:bg-black/20 dark:hover:border-white/20'
                }`}
              >
                <div className="text-xs font-bold">{t.id}</div>
                <div className="mt-0.5 text-[9px]">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="sr-well w-1/3 rounded-xl py-3 text-xs font-semibold text-sr-2 transition hover:text-fg"
          style={{ border: '1px solid var(--sr-line)' }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={submit}
          className="flex-1 rounded-xl bg-gradient-to-r from-violet-600 to-violet-500 py-3 text-xs font-bold text-white shadow-lg shadow-violet-600/30 transition hover:from-violet-500 hover:to-violet-400"
        >
          Join Game Controller
        </button>
      </div>
    </div>
  );
}
