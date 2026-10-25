'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowLeft, BookOpen, Copy, Lightbulb, MonitorPlay, Play, Share2, Timer, UserMinus, Users, Volume2, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Player, Room, SoundCueId } from '@/lib/types';
import { ENVIRONMENT_MAP, PLAYSTYLE_MAP } from '@/lib/environments';
import { SOUND_CUES } from '@/lib/sfx';
import { toast } from 'sonner';
import RulesDialog from './RulesDialog';

interface HostLobbyProps {
  room: Room;
  /** players (with their DB ids) in join order */
  players: Array<{ id: string; player: Player }>;
  maxPlayers: number;
  /** Start gating: true while the camera board heartbeat is fresh */
  hardwareReady: boolean;
  /** 🔗 host override for the player join-URL base (Settings drawer) */
  joinUrlBase?: string;
  onBack: () => void;
  onStart: () => void;
  /** host moderation - remove a player from the lobby */
  onKick: (playerId: string, name: string) => void;
  /** 🎺 lobby sound board - call the crew to the table */
  onSoundCue: (sound: SoundCueId) => void;
  /** 💡 free hint tokens per player (0-3, default 2) */
  onHintTokens: (n: number) => void;
  /** ⏱ Countdown Capture seconds (1-10, default 3) */
  onCountdownSecs: (n: number) => void;
}

/** a player heartbeat older than this shows "Reconnecting…" */
const SEEN_STALE_MS = 12000;

export default function HostLobby({
  room,
  players,
  maxPlayers,
  hardwareReady,
  joinUrlBase,
  onBack,
  onStart,
  onKick,
  onSoundCue,
  onHintTokens,
  onCountdownSecs,
}: HostLobbyProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // In-lobby rules panel; opens only from its button, never automatically.
  const [rulesOpen, setRulesOpen] = useState(false);
  const envName = ENVIRONMENT_MAP[(room.environment ?? '') as keyof typeof ENVIRONMENT_MAP]?.name;
  const psName = PLAYSTYLE_MAP[room.playstyle ?? '']?.name;
  /* 🔗 join URL: Settings override → NEXT_PUBLIC_JOIN_URL_BASE (baked at
     build time for GitHub Pages) → this page's own origin (localhost play). */
  const envBase = (process.env.NEXT_PUBLIC_JOIN_URL_BASE ?? '').trim();
  const base = (joinUrlBase || envBase || window.location.origin).replace(/\/+$/, '');
  const joinUrl = `${base}/?pin=${room.pin}`;

  useEffect(() => {
    if (!joinUrl || !room.pin) return;
    QRCode.toDataURL(joinUrl, {
      width: 512,
      margin: 1,
      color: { dark: '#0b1120', light: '#ffffff' },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [joinUrl, room.pin]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success('Join link copied to clipboard!');
    } catch {
      toast.error('Could not copy — scan the QR code instead.');
    }
  };

  /** native share sheet on phones, clipboard fallback on desktops */
  const shareLink = async () => {
    const data = {
      title: 'SnapRiddle',
      text: `Join my SnapRiddle match! Room PIN ${room.pin} 📸`,
      url: joinUrl,
    };
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(joinUrl);
      toast.info('Sharing not supported here — join link copied instead!');
    } catch (err) {
      // user dismissed the share sheet - not an error
      if ((err as DOMException)?.name !== 'AbortError') {
        toast.error('Could not share — scan the QR code instead.');
      }
    }
  };

  return (
    <div className="w-full max-w-5xl space-y-4">
      {/* Top bar */}
      <div className="sr-glass flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-9 w-9 items-center justify-center rounded-xl sr-well text-sr-2 transition hover:text-fg"
            aria-label="Close lobby"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="font-display text-lg font-bold text-fg">{room.game_name}</h2>
            <p className="text-xs text-amber-400">
              {room.num_rounds} Rounds
              {envName ? ` · ${envName}` : ''}
              {psName ? ` · ${psName}` : ''} ·{' '}
              {room.demo ? (
                <span className="inline-flex items-center gap-1">
                  <MonitorPlay className="inline h-3 w-3" /> Demo — simulated camera
                </span>
              ) : hardwareReady ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <Wifi className="inline h-3 w-3" /> Camera board connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <WifiOff className="inline h-3 w-3 animate-pulse" /> Waiting for camera…
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {/* Rules button next to Start Match */}
            <Button
              variant="secondary"
              onClick={() => setRulesOpen(true)}
              className="px-4 py-2.5 text-xs font-bold"
              aria-label="Open game rules"
            >
              <BookOpen className="mr-1.5 h-4 w-4" /> Rules
            </Button>
            <Button
              onClick={onStart}
              disabled={players.length === 0 || (!room.demo && !hardwareReady)}
              className="bg-gradient-to-r from-emerald-500 to-teal-600 px-6 py-2.5 text-xs font-bold shadow-lg shadow-emerald-600/30 hover:from-emerald-400 hover:to-teal-500"
            >
              <Play className="mr-1.5 h-4 w-4" />
              {!room.demo && !hardwareReady ? 'Waiting for hardware…' : 'Start Match'}
            </Button>
          </div>
          {!room.demo && !hardwareReady && (
            <span className="text-[10px] font-semibold text-sr-3">
              The camera board must check in before the match can start.
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* PIN + QR */}
        <div className="sr-glass space-y-4 rounded-2xl border-2 border-amber-500/25 p-6 text-center">
          <span className="inline-block rounded-full bg-amber-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">
            Room PIN
          </span>
          <div
            className="sr-well rounded-xl border-2 py-4 font-mono text-5xl font-extrabold tracking-widest text-fg md:text-6xl"
            style={{ borderColor: 'var(--sr-line)' }}
          >
            {room.pin}
          </div>
          <div className="mx-auto flex h-40 w-40 items-center justify-center rounded-xl bg-white p-2 shadow-lg">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={`QR code to join room ${room.pin}`} className="h-full w-full" />
            ) : (
              <div className="flex h-full w-full animate-pulse items-center justify-center rounded bg-slate-200">
                <span className="text-[10px] font-semibold text-slate-500">Generating QR…</span>
              </div>
            )}
          </div>
          <p className="text-xs text-sr-3">
            Scan the QR code or open the web app and enter PIN{' '}
            <strong className="text-amber-400">{room.pin}</strong> on your phone.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[10px] font-semibold text-sr-2 transition hover:text-fg"
              style={{ borderColor: 'var(--sr-line)' }}
            >
              <Copy className="h-3 w-3" /> Copy join link
            </button>
            <button
              type="button"
              onClick={shareLink}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[10px] font-semibold text-amber-600 transition hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              title="Share the join link from your device"
            >
              <Share2 className="h-3 w-3" /> Share
            </button>
          </div>
        </div>

        {/* Players */}
        <div className="sr-glass space-y-4 rounded-2xl p-6 lg:col-span-2">
          <div
            className="flex items-center justify-between border-b pb-3"
            style={{ borderColor: 'var(--sr-line)' }}
          >
            <h3 className="font-display flex items-center gap-2 text-base font-bold text-fg">
              <Users className="h-4 w-4 text-amber-400" /> Joined Players ({players.length}/{maxPlayers})
            </h3>
            <span className="text-xs text-sr-3">Waiting in lobby…</span>
          </div>
          {players.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Users className="h-10 w-10 animate-bounce text-sr-3" />
              <p className="text-sm font-semibold text-sr-2">No players yet</p>
              <p className="text-xs text-sr-3">
                Share the PIN <strong className="text-amber-400">{room.pin}</strong> or the QR code
                so friends can join from their phones.
              </p>
            </div>
          ) : (
            <div className="grid max-h-80 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
              {players.map(({ id, player: p }, idx) => {
                const stale = !p.is_bot && typeof p.last_seen === 'number' && Date.now() - p.last_seen > SEEN_STALE_MS;
                return (
                  <div
                    key={id}
                    className="animate-fade-up group flex items-center justify-between rounded-xl border p-3 transition hover:border-amber-500/30"
                    style={{ animationDelay: `${idx * 60}ms`, borderColor: 'var(--sr-line)' }}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
                        style={{ background: `${p.color ?? '#f59e0b'}26`, color: p.color ?? '#f59e0b' }}
                      >
                        {p.name?.charAt(0).toUpperCase() ?? '?'}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-fg">{p.name}</div>
                        <div className="text-[10px] text-sr-3">Tier: {p.tier}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {stale ? (
                        <span
                          className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                          title="Phone has not synced recently"
                        >
                          <WifiOff className="h-3 w-3" /> Reconnecting…
                        </span>
                      ) : (
                        <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                          Ready
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Remove ${p.name} from the lobby?`)) onKick(id, p.name);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-sr-3 opacity-60 transition hover:bg-rose-500/15 hover:text-rose-400 hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Remove ${p.name} from the lobby`}
                        title={`Remove ${p.name}`}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 💡 hint tokens + ⏱ countdown length + 🎺 lobby sound board */}
      <div className="sr-glass flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-sr-3">
            <Lightbulb className="h-3.5 w-3.5" /> Free hints per player
          </span>
          <Select
            value={String(room.hint_tokens_per_player ?? 2)}
            onValueChange={(v) => onHintTokens(Number(v))}
          >
            <SelectTrigger className="w-[190px] rounded-lg border-2 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0 — hints halve the solve</SelectItem>
              <SelectItem value="1">1 free hint</SelectItem>
              <SelectItem value="2">2 free hints (default)</SelectItem>
              <SelectItem value="3">3 free hints</SelectItem>
            </SelectContent>
          </Select>
          <span className="hidden text-[10px] text-sr-3 lg:inline">
            Solving after a hint pays 50 % of the points
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-sr-3">
            <Timer className="h-3.5 w-3.5" /> Capture countdown
          </span>
          <Select
            value={String(room.countdown_secs ?? 3)}
            onValueChange={(v) => onCountdownSecs(Number(v))}
          >
            <SelectTrigger className="w-[200px] rounded-lg border-2 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 8, 10].map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s} seconds{s === 3 ? ' (default)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="hidden text-[10px] text-sr-3 lg:inline">
            Time to step into frame before the photo fires (double-press on the board)
          </span>
        </div>
      </div>
      <div className="sr-glass flex flex-wrap items-center justify-center gap-2 rounded-2xl px-4 py-3">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-sr-3">
          <Volume2 className="h-3.5 w-3.5" /> Call the crew
        </span>
        <span className="h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden />
        {SOUND_CUES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSoundCue(s.id)}
            title={`${s.label} — plays on the TV and every joined phone`}
            aria-label={`Play ${s.label} sound`}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-extrabold transition hover:-translate-y-0.5 hover:shadow-lg active:scale-95 ${s.chipCls}`}
          >
            <span className="text-sm leading-none" aria-hidden>
              {s.emoji}
            </span>
            {s.label}
          </button>
        ))}
      </div>

      {/* The rules panel (shared RulesDialog). */}
      <RulesDialog open={rulesOpen} onOpenChange={setRulesOpen} numRounds={room.num_rounds} audience="host" />
    </div>
  );
}
