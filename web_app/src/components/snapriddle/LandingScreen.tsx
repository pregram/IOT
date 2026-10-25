'use client';

import { useState } from 'react';
import {
  Crown,
  Loader2,
  Lock,
  MonitorPlay,
  Plus,
  LogIn,
  Smartphone,
  Zap,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ENVIRONMENTS, PLAYSTYLES, DEFAULT_PLAYSTYLE_ID, type EnvironmentId } from '@/lib/environments';

export interface CreateGameConfig {
  name: string;
  rounds: number;
  /** demo = UI-viewing room (simulated feed + fixed judging, no board) */
  demo?: boolean;
  /** free hint tokens per player (host picks in the lobby, 0-3) */
  hintTokens?: number;
  /** The ONE environment the host picks (replaces categories) */
  environment?: EnvironmentId;
  /** The ONE playstyle the host picks (proof-method mix) */
  playstyle?: string;
  /** Countdown Capture seconds (default 3) */
  countdownSecs?: number;
}

interface LandingScreenProps {
  /** PIN of the room currently holding the hardware camera lock */
  hardwareBusyPin: string | null;
  onCreate: (cfg: CreateGameConfig) => void;
  onGoJoin: () => void;
  onQuickDemo: () => void;
  demoBusy?: boolean;
}

// The match name is spoken by the Voice Master and shown on the TV/lobby -
// same charset rule as player nicknames, just a longer budget.
const GAME_NAME_MAX = 50;
const sanitizeGameName = (v: string) => v.replace(/[^a-zA-Z0-9@# ]/g, '').slice(0, GAME_NAME_MAX);

export default function LandingScreen({
  hardwareBusyPin,
  onCreate,
  onGoJoin,
  onQuickDemo,
  demoBusy = false,
}: LandingScreenProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('Friday Night Scavenger');
  const [rounds, setRounds] = useState('3');
  const [environment, setEnvironment] = useState<EnvironmentId>('house');
  const [playstyle, setPlaystyle] = useState(DEFAULT_PLAYSTYLE_ID);

  const busy = Boolean(hardwareBusyPin);

  const submitCreate = () => {
    setCreateOpen(false);
    onCreate({
      name: sanitizeGameName(name.trim()) || 'SnapRiddle Challenge',
      rounds: parseInt(rounds, 10) || 3,
      environment,
      playstyle,
    });
  };

  return (
    <div className="w-full max-w-4xl space-y-8 text-center">
      {/* Hero */}
      <div className="relative space-y-4">
        {/* drifting aurora orbs */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="animate-aurora absolute -left-2 -top-10 h-56 w-56 rounded-full bg-violet-600/20 blur-3xl" />
          <div className="animate-aurora-delayed absolute -right-2 top-8 h-64 w-64 rounded-full bg-amber-500/15 blur-3xl" />
          <div
            className="absolute inset-x-10 top-0 h-40 opacity-[0.35]"
            style={{
              backgroundImage:
                'radial-gradient(rgba(148,163,184,0.35) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
              maskImage: 'linear-gradient(to bottom, black, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
            }}
          />
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
          </span>
          Single ESP32 Camera · Hardware Lock System
        </div>
        {/* Owner wording (replaces "AI-powered physical riddle scavenger hunt") */}
        <h2 className="font-display text-4xl font-extrabold tracking-tight text-fg md:text-6xl">
          The Voice-Guided AI Arena for
          <br />
          <span className="text-shimmer bg-gradient-to-r from-amber-400 via-rose-400 to-violet-400 bg-clip-text text-transparent">
            Physical Riddles, Sketches, and Proofs
          </span>
        </h2>
        <p className="mx-auto max-w-xl text-sm text-sr-2 md:text-base">
          Point your physical ESP32 camera, solve riddles in real-time, and let Gemini AI judge
          your visual object proof!
        </p>
        {/* Environment parade (the six arenas replace the 8 theme chips) */}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {ENVIRONMENTS.map((env, i) => (
            <span
              key={env.id}
              className="animate-fade-up inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold text-sr-2"
              style={{
                animationDelay: `${i * 70}ms`,
                borderColor: 'var(--sr-line)',
                background: 'var(--sr-well)',
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
              {env.name}
            </span>
          ))}
        </div>
      </div>

      {/* Action cards */}
      <div className="mx-auto grid max-w-2xl grid-cols-1 gap-4 pt-2 md:grid-cols-2">
        {/* Host */}
        <div className="sr-glass group relative overflow-hidden rounded-3xl border-2 border-amber-500/25 p-6 text-left shadow-2xl transition hover:border-amber-500/60">
          <div className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-amber-500/10 blur-2xl transition group-hover:bg-amber-500/25" />
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/15 text-amber-400">
            <Crown className="h-6 w-6" />
          </div>
          <h3 className="font-display mb-1 text-xl font-bold text-fg">Create New Game</h3>
          <p className="mb-6 text-xs text-sr-3">
            Host on a TV screen, claim the camera lock & run the score loop.
          </p>
          {busy ? (
            <div className="space-y-2">
              <button
                type="button"
                disabled
                className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-slate-800/80 py-3 text-xs font-bold text-slate-500"
              >
                <Lock className="h-3.5 w-3.5" /> Game in Progress (Hardware Locked)
              </button>
              {/* The live room's PIN is no longer shown here (privacy:
                 anyone glancing at the landing page must not learn the PIN of
                 a match in progress; joining already requires the host's QR). */}
              <p className="text-center text-[10px] text-amber-400">
                Another match is using the camera right now.
              </p>
            </div>
          ) : (
            <Button
              onClick={() => setCreateOpen(true)}
              className="w-full bg-amber-500 py-3 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/30 hover:bg-amber-400"
            >
              <Plus className="mr-1.5 h-4 w-4" /> Launch Host Lobby
            </Button>
          )}
        </div>

        {/* Player */}
        <div className="sr-glass group relative overflow-hidden rounded-3xl border-2 border-violet-500/25 p-6 text-left shadow-2xl transition hover:border-violet-500/60">
          <div className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-violet-500/10 blur-2xl transition group-hover:bg-violet-500/25" />
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-500/15 text-violet-400">
            <Smartphone className="h-6 w-6" />
          </div>
          <h3 className="font-display mb-1 text-xl font-bold text-fg">Join Game PIN</h3>
          <p className="mb-6 text-xs text-sr-3">
            Enter the Room PIN from the Host TV screen and pick your tier.
          </p>
          <Button
            onClick={onGoJoin}
            className="w-full bg-violet-600 py-3 text-xs font-bold shadow-lg shadow-violet-600/30 hover:bg-violet-500"
          >
            <LogIn className="mr-1.5 h-4 w-4" /> Enter Room PIN
          </Button>
        </div>
      </div>

      {/* Demo shortcut */}
      <div className="mx-auto flex max-w-md items-center justify-between border-t pt-5 text-xs text-sr-3" style={{ borderColor: 'var(--sr-line)' }}>
        <span className="flex items-center gap-1.5">
          <MonitorPlay className="h-3.5 w-3.5" />
          Tested for ESP32-S3 + MAX98357
        </span>
        <button
          type="button"
          onClick={onQuickDemo}
          disabled={demoBusy}
          className="flex items-center gap-1 font-semibold text-amber-400 transition hover:underline disabled:opacity-50"
        >
          {demoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          Fast Demo Launch →
        </button>
      </div>

      {/* Create game modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sr-card max-w-md gap-4 rounded-3xl border-2 p-6" style={{ borderColor: 'var(--sr-line)' }}>
          <DialogHeader>
            <DialogTitle className="font-display text-lg text-fg">Configure Host Match</DialogTitle>
            <DialogDescription className="text-xs text-sr-3">
              Claim the camera lock and open a joinable lobby.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-xs">
            <div>
              <label className="mb-1 block font-semibold text-sr-2" htmlFor="game-name">
                Match Name
              </label>
              <Input
                id="game-name"
                value={name}
                onChange={(e) => setName(sanitizeGameName(e.target.value))}
                placeholder="e.g. Friday Night Scavenger"
                maxLength={GAME_NAME_MAX}
                className="rounded-xl border-2 font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block font-semibold text-sr-2">Total Game Rounds</label>
              <Select value={rounds} onValueChange={setRounds}>
                <SelectTrigger className="w-full rounded-xl border-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 Rounds (Fast · ~10 min)</SelectItem>
                  <SelectItem value="5">5 Rounds (Standard · ~20 min)</SelectItem>
                  <SelectItem value="10">10 Rounds (Marathon)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Environment (host picks ONE; anchors Gemini's answers) */}
            <div>
              <label className="mb-1 block font-semibold text-sr-2">
                Environment
                <span className="ml-1.5 font-normal text-sr-3">where the riddle answers live</span>
              </label>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as EnvironmentId)}>
                <SelectTrigger className="w-full rounded-xl border-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENVIRONMENTS.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Playstyle (host picks ONE; proof-method mix, rolled in code) */}
            <div>
              <label className="mb-1 block font-semibold text-sr-2">Playstyle</label>
              <div className="grid grid-cols-1 gap-1.5">
                {PLAYSTYLES.map((ps) => {
                  const selected = playstyle === ps.id;
                  const mix = ps.distribution
                    .map((d) => `${d.pct}% ${d.method}`)
                    .join(' · ');
                  return (
                    <button
                      key={ps.id}
                      type="button"
                      onClick={() => setPlaystyle(ps.id)}
                      className={`rounded-xl border-2 p-2.5 text-left transition ${
                        selected
                          ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-200'
                          : 'border-black/10 bg-black/5 text-sr-3 hover:border-black/20 dark:border-white/10 dark:bg-black/20 dark:hover:border-white/20'
                      }`}
                    >
                      <div className="text-xs font-bold">
                        {ps.name}
                        {ps.id === DEFAULT_PLAYSTYLE_ID && (
                          <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-500">
                            recommended
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[9px]">{ps.desc}</div>
                      <div className="mt-0.5 text-[9px] font-semibold opacity-80">{mix}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="rounded-xl border p-3 text-[11px] leading-snug text-sr-3" style={{ borderColor: 'var(--sr-line)', background: 'var(--sr-well)' }}>
              📸 The camera board announces itself automatically — power it on
              and keep it on your WiFi. The lobby&apos;s Start button lights up as
              soon as the camera checks in.
            </p>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="secondary"
              className="w-1/2 rounded-xl text-xs"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              className="w-1/2 rounded-xl bg-amber-500 text-xs font-bold text-slate-950 hover:bg-amber-400"
            >
              Create Room
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
