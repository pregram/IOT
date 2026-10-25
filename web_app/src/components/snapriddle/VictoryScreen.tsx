'use client';

import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Crown,
  Download,
  Home,
  ImageOff,
  Medal,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Share2,
  Trophy,
  ZoomIn,
} from 'lucide-react';
import type { PhotoMoment } from '@/lib/types';
import type { RankedPlayer } from '@/utils/gameLogic';
import { MEDALS } from '@/utils/gameLogic';
import { loadSettings } from '@/lib/settings';
import { sfxShutter } from '@/lib/sfx';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import CaptionEditor from './CaptionEditor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface VictoryScreenProps {
  ranked: RankedPlayer[];
  badges: Record<string, string>;
  isHost: boolean;
  myId?: string | null;
  /** captured proof snapshots for the polaroid gallery */
  moments?: PhotoMoment[];
  /** ✏️ host-only caption moderation - save (string) or clear (null) */
  onEditCaption?: (momentId: string, text: string | null) => void;
  onExit: () => void;
}

const VERDICT_META: Record<PhotoMoment['verdict'], { emoji: string; label: string; cls: string }> = {
  pass: { emoji: '✅', label: 'Accepted', cls: 'text-emerald-600' },
  fail: { emoji: '❌', label: 'Rejected', cls: 'text-rose-500' },
  unclear: { emoji: '⚠️', label: 'Unclear', cls: 'text-amber-500' },
  timeout: { emoji: '⏰', label: 'Timeout', cls: 'text-slate-500' },
};

function fireVictoryConfetti() {
  const colors = ['#F59E0B', '#10B981', '#EAB308', '#8B5CF6', '#EF4444'];
  confetti({ particleCount: 130, spread: 80, origin: { y: 0.6 }, colors });
  setTimeout(
    () => confetti({ particleCount: 90, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors }),
    250,
  );
  setTimeout(
    () => confetti({ particleCount: 90, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors }),
    450,
  );
}

/* slideshow pacing */
const SLIDE_MS = 3000;

/** convert a data URL to a File so the Web Share API level-2 can attach it */
function dataUrlToFile(dataUrl: string, filename: string): File | null {
  try {
    const [head, b64] = dataUrl.split(',');
    const mime = /^:(.*?);/.exec(head)?.[1] ?? 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  } catch {
    return null;
  }
}

function fileBaseName(m: PhotoMoment): string {
  return `snapriddle-${m.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-r${m.round}.jpg`;
}

export default function VictoryScreen({
  ranked,
  badges,
  isHost,
  myId = null,
  moments = [],
  onEditCaption,
  onExit,
}: VictoryScreenProps) {
  const firedRef = useRef(false);
  const [lightbox, setLightbox] = useState<PhotoMoment | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);
  const [replayPaused, setReplayPaused] = useState(false);
  /* ✏️ host caption moderation dialog */
  const [editMoment, setEditMoment] = useState<PhotoMoment | null>(null);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    fireVictoryConfetti();
    const id = window.setInterval(
      () => confetti({ particleCount: 45, spread: 70, origin: { y: 0.65 }, colors: ['#F59E0B', '#10B981', '#EAB308'] }),
      3500,
    );
    return () => window.clearInterval(id);
  }, []);

  const first = ranked[0];
  const second = ranked[1];
  const third = ranked[2];
  const myRank = ranked.find((r) => r.id === myId)?.rank;

  /* match highlights */
  let fastest: { player: RankedPlayer['player']; time: number } | null = null;
  let mostSolves: { player: RankedPlayer['player']; count: number } | null = null;
  let sharp: { player: RankedPlayer['player']; pct: number } | null = null;
  for (const { player } of ranked) {
    /* defensive: zombie heartbeat nodes may carry players without stats */
    const s = player.stats ?? {
      solves: 0,
      fails: 0,
      timeouts: 0,
      hard_solves: 0,
      hints_used: 0,
      doom_survives: 0,
      best_time_sec: null as number | null,
    };
    if (typeof s.best_time_sec === 'number' && (!fastest || s.best_time_sec < fastest.time)) {
      fastest = { player, time: s.best_time_sec };
    }
    if (!mostSolves || s.solves > mostSolves.count) mostSolves = { player, count: s.solves };
    const attempts = s.solves + s.fails + s.timeouts;
    if (attempts >= 2) {
      const pct = Math.round((s.solves / attempts) * 100);
      if (!sharp || pct > sharp.pct) sharp = { player, pct };
    }
  }

  const podiumOrder = [second, first, third];

  /* 👑 Best Moment - the most valuable accepted proof (tie → earliest) */
  const bestMoment =
    moments
      .filter((m) => m.verdict === 'pass' && m.points > 0)
      .sort((a, b) => b.points - a.points || a.ts - b.ts)[0] ?? null;

  const openReplay = () => {
    setReplayIdx(0);
    setReplayPaused(false);
    setReplayOpen(true);
  };

  /* The cinematic auto-open is REMOVED - the
     existing Replay button is now the only trigger. The in-reel
     auto-advance slideshow below is untouched. */

  /* auto-advance the highlights slideshow (wraps around) */
  useEffect(() => {
    if (!replayOpen || replayPaused || moments.length === 0) return;
    const id = window.setInterval(() => {
      setReplayIdx((i) => (i + 1) % moments.length);
    }, SLIDE_MS);
    return () => window.clearInterval(id);
  }, [replayOpen, replayPaused, moments.length]);

  /* camera-shutter sting on every slide change */
  useEffect(() => {
    if (!replayOpen) return;
    sfxShutter(loadSettings().muted);
  }, [replayOpen, replayIdx]);

  /* 🎹 keyboard control: ←/→ navigate · Space pause/resume · Esc closes
     (Dialog already handles Escape; we only swallow Space/arrow scrolls) */
  useEffect(() => {
    if (!replayOpen || moments.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setReplayIdx((i) => (i + 1) % moments.length);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setReplayIdx((i) => (i - 1 + moments.length) % moments.length);
      } else if (e.key === ' ') {
        e.preventDefault();
        setReplayPaused((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replayOpen, moments.length]);

  const downloadMoment = (m: PhotoMoment) => {
    const a = document.createElement('a');
    a.href = m.photo;
    a.download = fileBaseName(m);
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success('Photo saved to downloads!');
  };

  /* 📦 download the whole gallery as a batch (staggered so browsers
     don't block the multi-download); files keep keyword-based names */
  const [savingAll, setSavingAll] = useState(false);
  const downloadAllMoments = () => {
    if (savingAll || moments.length === 0) return;
    setSavingAll(true);
    moments.forEach((m, i) => {
      window.setTimeout(() => {
        const a = document.createElement('a');
        a.href = m.photo;
        a.download = `snapriddle-${String(i + 1).padStart(2, '0')}-${fileBaseName(m).replace(/^snapriddle-/, '')}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (i === moments.length - 1) {
          setSavingAll(false);
          toast.success(`Saved all ${moments.length} photo${moments.length === 1 ? '' : 's'}!`);
        }
      }, i * 350);
    });
  };

  const shareMoment = async (m: PhotoMoment) => {
    const file = dataUrlToFile(m.photo, fileBaseName(m));
    const canShareFiles =
      Boolean(file) &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file as File] });
    if (file && canShareFiles) {
      try {
        await navigator.share({
          files: [file],
          title: 'SnapRiddle proof',
          text: `${m.player_name} proved “${m.keyword}” for ${m.points >= 0 ? '+' : ''}${m.points} pts!`,
        });
        return; // shared - no fallback needed
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return; // user closed the share sheet
      }
    }
    downloadMoment(m);
    toast.info('Sharing not supported here — photo downloaded instead.');
  };

  /* 📤 share the final standings - Web Share API, clipboard fallbacks.
     Includes the 💬 photo captions so the share artifact carries the jokes. */
  const shareResults = async () => {
    const medals = ['🥇', '🥈', '🥉'];
    const podium = ranked
      .slice(0, 3)
      .map(({ player }, i) => `${medals[i]} ${player.name} — ${player.score} pts`)
      .join('\n');
    const rest =
      ranked.length > 3
        ? '\n' +
          ranked
            .slice(3)
            .map(({ player }, i) => `${i + 4}. ${player.name} — ${player.score} pts`)
            .join('\n')
        : '';
    const captioned = moments.filter((m) => m.caption);
    const captionBlock = captioned.length
      ? `\n💬 Photo captions:\n${captioned
          .map((m) => `“${m.caption}” — ${m.player_name} (${m.keyword})`)
          .join('\n')}\n`
      : '';
    const text = `🏆 SnapRiddle — Match Results!\n${first ? `\n👑 Champion: ${first.player.name} (${first.player.score} pts)\n\n${podium}${rest}\n` : ''}${captionBlock}\nBuilt for living-room showdowns 🎉`;

    /* execCommand fallback - works even when the async clipboard API is
       blocked (document focus / permission policies) */
    const copyViaExecCommand = (): boolean => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    };
    const copyText = async (): Promise<boolean> => {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through to the legacy path */
      }
      return copyViaExecCommand();
    };

    try {
      if (
        typeof navigator.share === 'function' &&
        (!navigator.canShare || navigator.canShare({ text }))
      ) {
        await navigator.share({ title: 'SnapRiddle Results', text });
        return;
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return; // share sheet closed
      /* fall through to clipboard */
    }
    const copied = await copyText();
    if (copied) {
      toast.success('Results copied to clipboard!');
      return;
    }
    /* last resort - save the standings as a text file */
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'snapriddle-results.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast.info('Sharing unavailable here — results saved as a text file.');
    } catch {
      toast.error('Could not share or copy results.');
    }
  };

  return (
    <div className="w-full max-w-4xl space-y-7 text-center">
      <div className="space-y-2">
        <span className="inline-block rounded-full bg-amber-500/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-400">
          Match Complete
        </span>
        <h2 className="font-display text-4xl font-extrabold text-fg md:text-6xl">
          Victory Standings!
        </h2>
        {myRank && (
          <p className="text-sm text-sr-2">
            You finished{' '}
            <strong className="text-amber-400">
              {myRank === 1 ? '🥇 1st' : myRank === 2 ? '🥈 2nd' : myRank === 3 ? '🥉 3rd' : `#${myRank}`}
            </strong>
            !
          </p>
        )}

        {/* 📤 share the standings - share sheet or clipboard */}
        <button
          type="button"
          onClick={() => void shareResults()}
          className="mx-auto mt-1 flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-1.5 text-xs font-bold text-amber-600 transition hover:bg-amber-500/25 active:scale-95 dark:text-amber-400"
        >
          <Share2 className="h-3.5 w-3.5" /> Share Results
        </button>
      </div>

      {/* Podium - staggered reveal: 2nd → 3rd → 1st */}
      <div className="mx-auto grid max-w-2xl grid-cols-3 items-end gap-3 pt-4 md:gap-4">
        {/* 2nd */}
        <div
          className="sr-glass animate-scale-in flex h-44 flex-col justify-end space-y-1.5 rounded-2xl p-4"
          style={{ animationDelay: '220ms' }}
        >
          {second ? (
            <>
              <Medal className="mx-auto h-5 w-5 text-slate-300" />
              <div className="text-sm font-bold text-sr-2">{second.player.name}</div>
              <div className="font-mono text-xs text-amber-400">{second.player.score} pts</div>
              {badges[second.id] && (
                <div className="text-[10px] font-semibold text-sr-3">{badges[second.id]}</div>
              )}
              <div className="rounded-xl bg-slate-700/60 py-2 text-xs font-bold text-slate-200">
                🥈 2nd
              </div>
            </>
          ) : (
            <div className="pb-6 text-[10px] text-sr-3">—</div>
          )}
        </div>

        {/* 1st - Champion */}
        <div
          className="sr-glass neon-gold animate-scale-in relative flex h-60 flex-col justify-end space-y-1.5 overflow-hidden rounded-2xl border-2 border-amber-400 bg-gradient-to-t from-amber-500/15 to-transparent p-5"
          style={{ animationDelay: '460ms' }}
        >
          {first && (
            <>
              {/* periodic shine sweep across the champion card */}
              <div aria-hidden className="pointer-events-none absolute inset-0">
                <div className="shine-sweep absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
              </div>
              <Crown className="animate-bounce mx-auto h-8 w-8 text-amber-400" />
              <div className="font-display truncate text-lg font-extrabold text-fg">
                {first.player.name}
              </div>
              <div className="font-mono text-sm font-bold text-amber-600 dark:text-amber-300">
                {first.player.score} pts
              </div>
              {badges[first.id] && (
                <div className="text-[11px] font-semibold text-yellow-600 dark:text-yellow-300">{badges[first.id]}</div>
              )}
              <div className="rounded-xl bg-amber-500 py-2.5 text-xs font-extrabold text-slate-950">
                🏆 CHAMPION
              </div>
            </>
          )}
        </div>

        {/* 3rd */}
        <div
          className="sr-glass animate-scale-in flex h-36 flex-col justify-end space-y-1.5 rounded-2xl p-4"
          style={{ animationDelay: '80ms' }}
        >
          {third ? (
            <>
              <Medal className="mx-auto h-5 w-5 text-amber-600" />
              <div className="text-sm font-bold text-sr-2">{third.player.name}</div>
              <div className="font-mono text-xs text-amber-400">{third.player.score} pts</div>
              {badges[third.id] && (
                <div className="text-[10px] font-semibold text-sr-3">{badges[third.id]}</div>
              )}
              <div className="rounded-xl bg-amber-900/40 py-2 text-xs font-bold text-amber-500">
                🥉 3rd
              </div>
            </>
          ) : (
            <div className="pb-4 text-[10px] text-sr-3">—</div>
          )}
        </div>
      </div>

      {/* Match highlights strip */}
      <div className="mx-auto grid max-w-2xl grid-cols-3 gap-3 text-center">
        <StatChip
          icon="⚡"
          label="Fastest Solve"
          value={fastest ? `${fastest.player.name} · ${fastest.time}s` : '—'}
        />
        <StatChip
          icon="✅"
          label="Most Solves"
          value={mostSolves ? `${mostSolves.player.name} · ${mostSolves.count}` : '—'}
        />
        <StatChip
          icon="🎯"
          label="Best Accuracy"
          value={sharp ? `${sharp.player.name} · ${sharp.pct}%` : '—'}
        />
      </div>

      {/* 📸 Photo Moments - polaroid gallery of captured proofs */}
      {moments.length > 0 ? (
        <div className="sr-glass mx-auto max-w-2xl rounded-2xl p-4 text-left">
          <div
            className="mb-3 flex items-center justify-between border-b pb-2 text-xs font-bold text-sr-2"
            style={{ borderColor: 'var(--sr-line)' }}
          >
            <span className="flex items-center gap-1.5">
              <Camera className="h-3.5 w-3.5 text-amber-400" /> PHOTO MOMENTS
            </span>
            <span className="flex items-center gap-2">
              <span className="text-sr-3">
                {moments.length} snap{moments.length === 1 ? '' : 's'} captured
              </span>
              <button
                type="button"
                onClick={openReplay}
                className="flex items-center gap-1 rounded-lg border border-amber-400/30 bg-amber-500/15 px-2 py-1 text-[10px] font-extrabold text-amber-600 transition hover:bg-amber-500/30 active:scale-95 dark:text-amber-400"
              >
                <Play className="h-3 w-3 fill-amber-400" /> Replay
              </button>
              {moments.length >= 2 && (
                <button
                  type="button"
                  onClick={downloadAllMoments}
                  disabled={savingAll}
                  title="Download every captured proof photo"
                  className="flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-500/15 px-2 py-1 text-[10px] font-extrabold text-emerald-500 transition hover:bg-emerald-500/30 active:scale-95 disabled:opacity-60 dark:text-emerald-400"
                >
                  <Download className={`h-3 w-3 ${savingAll ? 'animate-bounce' : ''}`} />
                  {savingAll ? 'Saving…' : 'Save all'}
                </button>
              )}
            </span>
          </div>
          <div className="moments-strip flex snap-x gap-4 overflow-x-auto px-1 pb-3 pt-2">
            {moments.map((m, i) => {
              const meta = VERDICT_META[m.verdict];
              return (
                <div key={m.id} className="relative shrink-0 snap-center">
                  <button
                    type="button"
                    onClick={() => setLightbox(m)}
                    aria-label={`Open photo proof by ${m.player_name}: ${meta.label} ${m.keyword}`}
                    className={`polaroid group relative text-left ${
                      bestMoment?.id === m.id
                        ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-amber-500/10'
                        : ''
                    }`}
                    style={{ '--tilt': `${((i * 37) % 9) - 4}deg` } as React.CSSProperties}
                  >
                    {bestMoment?.id === m.id && (
                      <span className="absolute -left-1.5 -top-2.5 z-10 flex -rotate-6 items-center gap-1 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wide text-slate-950 shadow-lg shadow-amber-500/50">
                        👑 Best Moment
                      </span>
                    )}
                    <span className="polaroid-tape" aria-hidden />
                    <span className="polaroid-frame">
                      <img src={m.photo} alt={`Proof of “${m.keyword}” by ${m.player_name}`} className="h-24 w-40 object-cover" loading="lazy" />
                      <span className="polaroid-zoom" aria-hidden>
                        <ZoomIn className="h-4 w-4" />
                      </span>
                    </span>
                    <span className="block px-2.5 pb-2.5 pt-1.5">
                      <span className="flex items-center gap-1.5 text-[11px] font-extrabold text-slate-800">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.player_color }} aria-hidden />
                        {m.player_name}
                        <span className={`ml-auto ${meta.cls}`}>{meta.emoji}</span>
                      </span>
                      <span className="mt-0.5 flex items-baseline justify-between gap-2 font-mono text-[9px] text-slate-500">
                        <span className="truncate lowercase">“{m.keyword}” · R{m.round}</span>
                        <span className={m.points >= 0 ? 'font-bold text-emerald-600' : 'font-bold text-rose-500'}>
                          {m.points >= 0 ? '+' : ''}
                          {m.points}
                        </span>
                      </span>
                      {m.caption && <span className="polaroid-caption mt-1 block text-center">“{m.caption}”</span>}
                    </span>
                  </button>
                  {/* ✏️ host caption moderation - sibling chip (never nested in the polaroid button) */}
                  {isHost && onEditCaption && (
                    <button
                      type="button"
                      onClick={() => setEditMoment(m)}
                      aria-label={m.caption ? `Edit the caption on ${m.player_name}'s photo` : `Add a caption to ${m.player_name}'s photo`}
                      title={m.caption ? 'Edit caption' : 'Add caption'}
                      className={`absolute -right-1.5 -top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-violet-400/60 bg-[#101827] text-violet-300 shadow-lg shadow-violet-900/40 transition hover:scale-110 hover:bg-violet-500/30 active:scale-95 ${
                        m.caption ? '' : 'caption-invite'
                      }`}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="sr-glass mx-auto flex max-w-2xl items-center justify-center gap-2 rounded-2xl p-4 text-xs text-sr-3">
          <ImageOff className="h-3.5 w-3.5" />
          No photos captured this match — every turn timed out!
        </div>
      )}

      {/* Full leaderboard */}
      <div className="sr-glass mx-auto max-w-2xl space-y-2 rounded-2xl p-4 text-left">
        <div className="flex items-center justify-between border-b pb-2 text-xs font-bold text-sr-2" style={{ borderColor: 'var(--sr-line)' }}>
          <span className="flex items-center gap-1.5">
            <Trophy className="h-3.5 w-3.5 text-amber-400" /> FULL LEADERBOARD
          </span>
          <span className="text-sr-3">{ranked.length} players</span>
        </div>
        <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
          {ranked.map(({ id, player, rank }) => (
            <div
              key={id}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs ${
                id === myId
                  ? 'border border-violet-500/30 bg-violet-500/10'
                  : 'bg-black/10 dark:bg-white/[0.04]'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className={`w-8 font-bold ${rank <= 3 ? 'text-amber-400' : 'text-sr-3'}`}>
                  {MEDALS[rank] ?? `#${rank}`}
                </span>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: player.color ?? '#94a3b8' }}
                  aria-hidden
                />
                <span className="truncate font-semibold text-fg">{player.name}</span>
                <span className="hidden shrink-0 rounded bg-black/25 px-1.5 py-0.5 text-[9px] font-semibold text-sr-3 sm:inline dark:bg-white/5">
                  {player.tier}
                </span>
                {badges[id] && (
                  <span className="shrink-0 text-[10px] font-semibold text-yellow-600 dark:text-yellow-400">
                    {badges[id]}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[10px] text-sr-3">
                <span>✅ {player.stats?.solves ?? 0}</span>
                <span>❌ {(player.stats?.fails ?? 0) + (player.stats?.timeouts ?? 0)}</span>
                <span className="font-mono font-bold text-amber-600 dark:text-amber-300">{player.score} pts</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Lightbox for a single polaroid */}
      <Dialog open={Boolean(lightbox)} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent className="dark-dialog max-w-md border-amber-500/30 bg-[#101827] p-0">
          {lightbox && (
            <div className="space-y-3 p-4">
              <DialogHeader className="space-y-1 text-left">
                <DialogTitle className="flex flex-wrap items-center gap-2 text-sm font-extrabold text-fg">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: lightbox.player_color }}
                    aria-hidden
                  />
                  {lightbox.player_name}
                  <span className={`ml-1 ${lightbox.verdict === 'pass' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {VERDICT_META[lightbox.verdict].emoji} {VERDICT_META[lightbox.verdict].label}
                  </span>
                  {bestMoment?.id === lightbox.id && (
                    <span className="rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-950 shadow">
                      👑 Best Moment
                    </span>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs text-sr-3">
                  Round {lightbox.round} · {lightbox.difficulty} · proved “{lightbox.keyword}” ·{' '}
                  <strong className={lightbox.points >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {lightbox.points >= 0 ? '+' : ''}
                    {lightbox.points} pts
                  </strong>
                </DialogDescription>
              </DialogHeader>
              <img
                src={lightbox.photo}
                alt={`Enlarged proof of “${lightbox.keyword}” by ${lightbox.player_name}`}
                className="w-full rounded-xl border-4 border-white/90 bg-white shadow-xl"
              />
              {lightbox.caption && (
                <p className="flex items-center justify-center gap-1.5 text-center font-display text-sm font-bold italic text-amber-200">
                  <MessageCircle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                  “{lightbox.caption}”
                </p>
              )}
              {/* keep the memory: download or native share (falls back gracefully) */}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => downloadMoment(lightbox)}
                  className="flex-1 gap-1.5 text-xs font-bold"
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </Button>
                {isHost && onEditCaption && (
                  <Button
                    variant="outline"
                    onClick={() => setEditMoment(lightbox)}
                    className="flex-1 gap-1.5 border-violet-500/40 bg-violet-500/10 text-xs font-bold text-violet-300 hover:bg-violet-500/25 hover:text-violet-200"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Caption
                  </Button>
                )}
                <Button
                  onClick={() => void shareMoment(lightbox)}
                  className="flex-1 gap-1.5 bg-amber-500 text-xs font-bold text-slate-950 shadow-amber-500/30 hover:bg-amber-400"
                >
                  <Share2 className="h-3.5 w-3.5" /> Share
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 🎞 Replay Highlights - auto-advancing slideshow of the match's snaps.
          Opened ONLY via the Replay button (auto-open retired). */}
      <Dialog
        open={replayOpen}
        onOpenChange={(o) => {
          setReplayOpen(o);
        }}
      >
        <DialogContent
          className="max-w-lg overflow-hidden border-amber-500/30 bg-black/95 p-0"
        >
          {/* a11y: radix requires a named dialog even for a purely visual reel */}
          <DialogTitle className="sr-only">Match Highlights Replay</DialogTitle>
          <DialogDescription className="sr-only">
            Auto-advancing slideshow of every proof photo captured this match.
          </DialogDescription>
          {moments.length > 0 && (() => {
            const idx = replayIdx % moments.length;
            const m = moments[idx];
            const meta = VERDICT_META[m.verdict];
            return (
              <div>
                <div className="relative aspect-video overflow-hidden bg-black">
                  <img
                    key={`${m.id}-${idx}`}
                    src={m.photo}
                    alt={`Replay slide ${idx + 1}: proof of “${m.keyword}” by ${m.player_name}`}
                    className="animate-kenburns h-full w-full object-cover"
                  />
                  {/* verdict stamp */}
                  <div
                    className={`absolute right-3 top-3 rotate-6 rounded-lg border-2 px-2.5 py-1 font-mono text-sm font-black backdrop-blur-sm ${
                      m.verdict === 'pass'
                        ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                        : 'border-rose-400 bg-rose-500/20 text-rose-300'
                    }`}
                    aria-hidden
                  >
                    {meta.emoji} {m.points >= 0 ? '+' : ''}
                    {m.points}
                  </div>
                  {/* gradient caption */}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-4 pb-3 pt-10 text-left">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: m.player_color }}
                        aria-hidden
                      />
                      <span className="text-sm font-extrabold text-white">{m.player_name}</span>
                      <span className="rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white/70">
                        R{m.round} · {m.difficulty}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-white/85">
                      proved <span className="font-semibold lowercase">“{m.keyword}”</span>
                      <strong className={m.points >= 0 ? 'ml-2 text-emerald-300' : 'ml-2 text-rose-300'}>
                        {m.points >= 0 ? '+' : ''}
                        {m.points} pts
                      </strong>
                    </div>
                    {m.caption && (
                      <div className="mt-0.5 flex items-center gap-1.5 font-display text-[13px] font-bold italic text-amber-200">
                        <span aria-hidden>💬</span>“{m.caption}”
                      </div>
                    )}
                  </div>
                </div>
                {/* slide progress bar */}
                <div className="h-0.5 w-full bg-white/15">
                  {replayPaused ? (
                    <div className="h-full w-full bg-white/30" />
                  ) : (
                    <div
                      key={`${idx}-run`}
                      className="animate-slide-progress h-full origin-left bg-gradient-to-r from-amber-400 to-emerald-400"
                    />
                  )}
                </div>
                {/* transport controls */}
                <div className="space-y-1 px-4 py-2.5">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setReplayIdx((i) => (i - 1 + moments.length) % moments.length)}
                      aria-label="Previous photo"
                      className="rounded-lg p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white active:scale-90"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <div className="flex items-center gap-1.5">
                      {moments.map((mm, i) => (
                        <button
                          key={mm.id}
                          type="button"
                          onClick={() => setReplayIdx(i)}
                          aria-label={`Jump to photo ${i + 1}`}
                          className={`h-1.5 rounded-full transition-all ${
                            i === idx ? 'w-4 bg-amber-400' : 'w-1.5 bg-white/30 hover:bg-white/50'
                          }`}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="mr-1 font-mono text-[10px] text-white/40">
                        {idx + 1}/{moments.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setReplayPaused((p) => !p)}
                        aria-label={replayPaused ? 'Resume slideshow' : 'Pause slideshow'}
                        className="rounded-lg p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white active:scale-90"
                      >
                        {replayPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setReplayIdx((i) => (i + 1) % moments.length)}
                        aria-label="Next photo"
                        className="rounded-lg p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white active:scale-90"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  {/* keyboard hint */}
                  <p className="flex items-center justify-center gap-1.5 text-[9px] text-white/35">
                    <kbd className="kbd">←</kbd>
                    <kbd className="kbd">→</kbd> navigate
                    <span aria-hidden>·</span>
                    <kbd className="kbd">Space</kbd> pause
                    <span aria-hidden>·</span>
                    <kbd className="kbd">Esc</kbd> close
                  </p>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ✏️ host caption moderation dialog */}
      {onEditCaption && (
        <CaptionEditor
          key={editMoment?.id ?? 'closed'}
          moment={editMoment}
          onClose={() => setEditMoment(null)}
          onSave={(momentId, text) => onEditCaption(momentId, text)}
        />
      )}

      {/* Actions - Play Again is REMOVED (a match simply
          ends); Exit is the only action. */}
      <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
        {isHost ? (
          <Button variant="secondary" onClick={onExit} className="px-6 py-3 text-xs font-bold">
            <Home className="mr-1.5 h-4 w-4" /> Exit to Main Menu
          </Button>
        ) : (
          <p className="text-xs text-sr-3">The match has ended — thanks for playing!</p>
        )}
      </div>
    </div>
  );
}

function StatChip({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="sr-glass animate-fade-up rounded-2xl p-3 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-500/10">
      <div className="text-base">{icon}</div>
      <div className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-sr-3">{label}</div>
      <div className="truncate text-xs font-bold text-fg">{value}</div>
    </div>
  );
}
