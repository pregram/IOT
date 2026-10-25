'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Camera,
  CheckCircle2,
  Lightbulb,
  Loader2,
  Lock,
  LogOut,
  MessageCircle,
  PartyPopper,
  PauseCircle,
  Send,
  Smartphone,
  Sparkles,
  Timer,
  XCircle,
} from 'lucide-react';
import type { FeedEvent, PhotoMoment, Room, SoundCueId } from '@/lib/types';
import type { RankedPlayer } from '@/utils/gameLogic';
import { buttonLock } from '@/utils/gameLogic';
import FeedTicker from './FeedTicker';
import RulesDialog from './RulesDialog';
import Scoreboard from './Scoreboard';
import { toast } from 'sonner';
import { loadSettings } from '@/lib/settings';
import { sfxRally, sfxSoundBoard, SOUND_CUES } from '@/lib/sfx';

interface PlayerControllerProps {
  room: Room;
  myId: string;
  ranked: RankedPlayer[];
  localTimeRemaining: number;
  feed: FeedEvent[];
  /** host spotlight hype (null when off) */
  spotlight: { player_id: string; ts: number } | null;
  /** most recent captured proof photo (shown on MY result card) */
  lastMoment: PhotoMoment | null;
  /** ⏸ true while the host has frozen the countdown */
  isPaused: boolean;
  onHint: () => void;
  /** ⏱ Countdown Capture (active player only) */
  onCountdown: () => void;
  /** send an emoji reaction to the host TV (combo = same-emoji streak) */
  onReact: (emoji: string, combo?: number) => void;
  /** 💬 caption my accepted proof photo (one line, shown in the gallery) */
  onCaption: (momentId: string, text: string) => void;
  onLeave: () => void;
}

/** tap-to-react emoji set (44px+ touch targets) */
const REACTIONS = ['🔥', '👏', '😂', '😱', '🎉', '💀'] as const;
/** same-emoji taps within this window build a combo streak */
const COMBO_WINDOW_MS = 8000;

interface LocalBurst {
  key: number;
  emoji: string;
  dx: number;
  rot: number;
  big: boolean;
}

interface ComboChip {
  key: number;
  emoji: string;
  n: number;
}

/**
 * Player phone controller - mirrors the room FSM with a mobile-optimized
 * layout: locked waiting view, glowing "your turn" card, hint token button,
 * evaluation feedback, hype reactions (with combo streaks) and live scoreboard.
 */
export default function PlayerController({
  room,
  myId,
  ranked,
  localTimeRemaining,
  feed,
  spotlight,
  lastMoment,
  isPaused,
  onHint,
  onCountdown,
  onReact,
  onCaption,
  onLeave,
}: PlayerControllerProps) {
  const me = room.players?.[myId] ?? null;
  const activeId = room.active_player_id;
  const isMyTurn = activeId === myId;
  const activePlayer = activeId ? room.players?.[activeId] : null;
  /** hint button locks for the current turn only (derived, no effect needed) */
  const [hintSentTurn, setHintSentTurn] = useState<number | null>(null);
  /** Rules panel (shared with the host lobby) */
  const [rulesOpen, setRulesOpen] = useState(false);
  // The DB latch (hint_used_turn) now backs the local lock -
  // a page refresh used to re-enable the button and re-request a second
  // hint for the same riddle. The latch persists across an unclear
  // retake of the same riddle.
  const hintUsedThisTurn =
    room.hint_used_turn != null && room.hint_used_turn === room.turn_started_at;
  const hintSent = hintSentTurn === room.turn_started_at || hintUsedThisTurn;

  /* reaction throttle + local mini-burst feedback */
  const [bursts, setBursts] = useState<LocalBurst[]>([]);
  const lastReactRef = useRef(0);
  const [reactCooldown, setReactCooldown] = useState(false);
  const burstKeyRef = useRef(0);

  /* combo streak + per-session reaction counters */
  const lastEmojiRef = useRef<string | null>(null);
  const comboCountRef = useRef(0);
  const comboTimeRef = useRef(0);
  const [comboChip, setComboChip] = useState<ComboChip | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  /* ── 📳 Turn-start attention cue: vibrate + rally sfx + title flash ── */
  const [rallyFlash, setRallyFlash] = useState<number | null>(null);
  const lastTurnCueRef = useRef<string | null>(null);
  const TITLE_IDLE = 'SnapRiddle — AI Physical Riddle Party Game';
  useEffect(() => {
    /* fires once per turn, at the CALLOUT beat (the "step up" moment) */
    const isCue = room.state === 'CALLOUT' && activeId === myId;
    const cueKey = isCue ? `callout:${room.phase_started_at}` : null;
    if (!cueKey || lastTurnCueRef.current === cueKey) {
      if (room.state !== 'CALLOUT' && document.title !== TITLE_IDLE) {
        document.title = TITLE_IDLE;
      }
      return;
    }
    lastTurnCueRef.current = cueKey;

    /* haptic pulse (Android; silently ignored on iOS) */
    try {
      navigator.vibrate?.([180, 90, 180, 90, 320]);
    } catch {
      /* no vibration support */
    }
    /* rising rally tone on the phone itself (respects the mute setting) */
    try {
      sfxRally(loadSettings().muted);
    } catch {
      /* audio unavailable */
    }
    /* flashing banner + browser-tab title alarm for phones buried in pockets */
    setRallyFlash(Date.now());
    document.title = '👉 YOUR TURN — SnapRiddle!';
    const flashOff = window.setTimeout(() => setRallyFlash(null), 3200);
    return () => window.clearTimeout(flashOff);
  }, [room.state, room.phase_started_at, activeId, myId]);

  /* ── 🎺 Sound-cue flash: the host just fired a sound-board jingle - play it
     on this phone too (room-wide echo) + show which hit landed ── */
  const [cueFlash, setCueFlash] = useState<{ key: number; sound: SoundCueId } | null>(null);
  const lastCueTsRef = useRef(0);
  const cue = room.sfx_cue ?? null;
  useEffect(() => {
    if (!cue) return;
    if (cue.ts === lastCueTsRef.current) return;
    lastCueTsRef.current = cue.ts;
    // stale cue (joined mid-party / old room echo) - swallow silently
    if (Date.now() - cue.ts > 8000) return;
    const meta = SOUND_CUES.find((s) => s.id === cue.sound);
    setCueFlash({ key: cue.ts, sound: cue.sound });
    try {
      sfxSoundBoard(loadSettings().muted, cue.sound);
    } catch {
      /* audio unavailable */
    }
    try {
      navigator.vibrate?.(cue.sound === 'airhorn' ? [90, 60, 90, 60, 90] : 100);
    } catch {
      /* no vibration support */
    }
    if (meta) toast(`${meta.emoji} ${meta.label}!`, { icon: meta.emoji });
    const off = window.setTimeout(() => setCueFlash(null), 2600);
    return () => window.clearTimeout(off);
  }, [cue?.ts, cue?.sound]);

  /* ── 💬 Caption composer state (one per accepted proof) ── */
  const [captionText, setCaptionText] = useState('');
  const [captionSavedFor, setCaptionSavedFor] = useState<string | null>(null);

  const react = (emoji: string) => {
    const now = Date.now();
    if (now - lastReactRef.current < 900) return;
    lastReactRef.current = now;
    setReactCooldown(true);
    window.setTimeout(() => setReactCooldown(false), 900);

    /* combo streak: same emoji within the window keeps counting */
    if (lastEmojiRef.current === emoji && now - comboTimeRef.current < COMBO_WINDOW_MS) {
      comboCountRef.current += 1;
    } else {
      comboCountRef.current = 1;
    }
    lastEmojiRef.current = emoji;
    comboTimeRef.current = now;
    const combo = comboCountRef.current;

    setCounts((c) => ({ ...c, [emoji]: (c[emoji] ?? 0) + 1 }));
    onReact(emoji, combo >= 2 ? combo : undefined);

    if (combo >= 3) {
      const chip = { emoji, n: combo, key: ++burstKeyRef.current };
      setComboChip(chip);
      window.setTimeout(
        () => setComboChip((cur) => (cur && cur.key === chip.key ? null : cur)),
        1700,
      );
    }

    /* instant local feedback: emojis pop out of the bar (bigger on combo) */
    const n = combo >= 3 ? 6 : 3;
    const spawned: LocalBurst[] = Array.from({ length: n }, () => ({
      key: ++burstKeyRef.current,
      emoji,
      dx: Math.random() * (combo >= 3 ? 120 : 70) - (combo >= 3 ? 60 : 35),
      rot: Math.random() * 36 - 18,
      big: combo >= 3,
    }));
    setBursts((b) => [...b, ...spawned].slice(-16));
    window.setTimeout(
      () => setBursts((b) => b.filter((x) => !spawned.some((s) => s.key === x.key))),
      combo >= 3 ? 2000 : 1800,
    );
  };

  if (!me) {
    return (
      <div className="sr-glass w-full max-w-sm rounded-3xl p-8 text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-amber-400" />
        <p className="mt-3 text-sm text-sr-2">Rejoining room…</p>
      </div>
    );
  }

  const riddle = room.current_riddle;
  const evalRes = room.last_evaluation;
  // hint/countdown locked: riddle being read, host pause, hint playing
  const lock = buttonLock(room);
  const reading = lock !== null || Boolean(room.countdown);
  const lastWasMine = evalRes !== null && activeId === myId;
  const amSpotlighted = spotlight?.player_id === myId && room.state !== 'GAME_OVER';

  const timerPct = riddle
    ? Math.max(0, Math.min(100, (localTimeRemaining / riddle.time_limit_sec) * 100))
    : 0;
  /* ⏱ Proportional urgency on my phone too: amber ≤ T/3, red pulse ≤ T/6 */
  const limitSec = riddle?.time_limit_sec ?? 0;
  const amberAt = Math.floor(limitSec / 3);
  const redAt = Math.floor(limitSec / 6);
  const urgency: 'idle' | 'normal' | 'amber' | 'red' =
    !limitSec || !room.turn_timer?.is_active || isPaused
      ? 'idle'
      : localTimeRemaining <= redAt
        ? 'red'
        : localTimeRemaining <= amberAt
          ? 'amber'
          : 'normal';

  /* my performance stats - defensive: zombie heartbeat nodes may lack stats */
  const st = me.stats ?? {
    solves: 0,
    fails: 0,
    timeouts: 0,
    hard_solves: 0,
    hints_used: 0,
    doom_survives: 0,
    best_time_sec: null as number | null,
  };
  const attempts = st.solves + st.fails + st.timeouts;
  const acc = attempts > 0 ? `${Math.round((st.solves / attempts) * 100)}%` : '—';
  const best = st.best_time_sec != null ? `${st.best_time_sec}s` : '—';

  const requestHint = () => {
    if (room.state !== 'ACTIVE_TURN' || !isMyTurn) return;
    // Belt & suspenders - the DB latch already disables the
    // button; this guard covers a stale local render racing the DB echo.
    if (hintUsedThisTurn) {
      toast.error('One hint per riddle — already used this turn!');
      return;
    }
    // Same gate as the physical button: no riddle armed yet → no
    // hint (the board has nothing to hint about) + a visible error toast.
    if (!room.current_riddle) {
      toast.error('The riddle is still being written — hints unlock once it lands!');
      return;
    }
    setHintSentTurn(room.turn_started_at);
    onHint();
    if ((me?.hint_tokens ?? 0) > 0) {
      toast.info('Hint sent to the Voice Master!');
    } else {
      toast.info('Hint sent — solving after a hint pays 50 % of the points!');
    }
  };

  return (
    <div className="w-full max-w-sm space-y-4">
      {/* Status header */}
      <div className="sr-glass space-y-1 rounded-2xl p-4 text-center">
        <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-violet-400">
          <Smartphone className="h-3 w-3" /> Player Controller
        </div>
        <h2 className="font-display text-xl font-bold text-fg">{me.name}</h2>
        <div className="text-xs text-sr-3">
          PIN {room.pin} · Score:{' '}
          <strong className="text-amber-400">{me.score} pts</strong> · Streak: {me.streak}🔥
        </div>
        {/* Players get the rules too (same panel as the host lobby) */}
        <button
          type="button"
          onClick={() => setRulesOpen(true)}
          className="mx-auto mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold text-amber-600 transition hover:bg-amber-500/10 dark:text-amber-300"
          aria-label="Open game rules"
        >
          <BookOpen className="h-3.5 w-3.5" /> Rules
        </button>
      </div>
      <RulesDialog open={rulesOpen} onOpenChange={setRulesOpen} numRounds={room.num_rounds} audience="player" />

      {/* ── 📳 Rally flash: pulsing attention banner when it's YOUR turn ── */}
      {rallyFlash && isMyTurn && (
        <div
          key={rallyFlash}
          role="alert"
          aria-live="assertive"
          className="rally-flash animate-pop relative overflow-hidden rounded-2xl border-2 border-emerald-400/70 bg-gradient-to-r from-emerald-500/30 via-yellow-400/20 to-emerald-500/30 p-4 text-center neon-emerald"
        >
          <div className="flex items-center justify-center gap-2">
            <Smartphone className="animate-vibrate h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            <h3 className="font-display text-lg font-extrabold tracking-wide text-emerald-700 dark:text-emerald-300">
              📳 IT'S YOUR TURN!
            </h3>
          </div>
          <p className="mt-0.5 text-[10px] font-semibold text-emerald-800/90 dark:text-emerald-200/90">
            Step up to the camera — the TV is waiting for you!
          </p>
        </div>
      )}

      {/* ── 💡 Hint card - the board SPOKE this to the whole room ── */}
      {room.hint && room.state === 'ACTIVE_TURN' && (
        <div
          role="status"
          aria-live="polite"
          className="animate-pop flex items-start gap-2 rounded-xl border border-yellow-500/40 bg-yellow-500/15 px-3 py-2.5 backdrop-blur-sm"
        >
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" />
          <div>
            <p className="text-xs font-bold text-yellow-700 dark:text-yellow-200">
              Hint for {room.hint.player_name}
            </p>
            <p className="text-[11px] text-yellow-800/90 dark:text-yellow-100/90">{room.hint.text}</p>
            {room.hint.player_id === myId && (
              <p className="mt-0.5 text-[9px] font-semibold text-yellow-600 dark:text-yellow-300/70">
                Solving with a hint pays 50 % of the points.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── 🎺 Sound-cue flash: the host fired a sound-board jingle ── */}
      {cueFlash &&
        (() => {
          const meta = SOUND_CUES.find((s) => s.id === cueFlash.sound);
          if (!meta) return null;
          return (
            <div
              key={cueFlash.key}
              role="status"
              aria-live="polite"
              className="cue-flash animate-pop flex items-center justify-center gap-2 rounded-2xl border-2 border-amber-400/70 bg-gradient-to-r from-amber-500/25 via-orange-400/20 to-amber-500/25 p-3 text-center backdrop-blur-sm"
            >
              <span className="animate-vibrate text-2xl leading-none" aria-hidden>
                {meta.emoji}
              </span>
              <div className="text-left">
                <h3 className="font-display text-sm font-extrabold tracking-wide text-amber-700 dark:text-amber-300">
                  {meta.label.toUpperCase()}!
                </h3>
                <p className="text-[10px] font-semibold text-amber-800/90 dark:text-amber-200/90">
                  The host is hyping the room — hear it on the TV too!
                </p>
              </div>
            </div>
          );
        })()}

      {/* ── ⏸ Host paused the countdown - everyone's clock is frozen ── */}
      {isPaused && room.state === 'ACTIVE_TURN' && (
        <div
          role="status"
          aria-live="polite"
          className="animate-pop flex items-center justify-center gap-2 rounded-xl border border-sky-400/50 bg-sky-500/15 px-3 py-2.5 backdrop-blur-sm"
        >
          <PauseCircle className="h-4 w-4 animate-pulse text-sky-600 dark:text-sky-300" />
          <span className="text-xs font-bold text-sky-800 dark:text-sky-100">
            Host paused the timer — hold tight!
          </span>
        </div>
      )}

      {/* ── Host spotlight hype banner ──────────────────────────────── */}
      {amSpotlighted && (
        <div className="neon-gold animate-pop relative overflow-hidden rounded-2xl border-2 border-amber-400/70 bg-gradient-to-r from-amber-500/25 via-yellow-400/15 to-amber-500/25 p-4 text-center">
          <Sparkles className="animate-floaty mx-auto h-5 w-5 text-amber-500 dark:text-amber-300" />
          <h3 className="font-display mt-1 text-sm font-extrabold tracking-wide text-amber-700 dark:text-amber-300">
            THE HOST IS SPOTLIGHTING YOU!
          </h3>
          <p className="text-[10px] text-amber-800/90 dark:text-amber-200/80">
            Wave at the camera — you&apos;re on the big screen!
          </p>
        </div>
      )}

      {/* ── Turn-state display card ─────────────────────────────────── */}
      {room.state === 'LOBBY' && (
        <div className="sr-glass space-y-3 rounded-2xl border-2 p-6 text-center" style={{ borderColor: 'var(--sr-line)' }}>
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-amber-400" />
          <h3 className="font-display font-bold text-lg text-fg">Waiting for Host…</h3>
          <p className="text-xs text-sr-3">The match will start any second now. Hold tight!</p>
        </div>
      )}

      {(room.state === 'INTRO' || room.state === 'ROUND_FLASH') && (
        <div className="sr-glass animate-pop space-y-3 rounded-2xl border-2 border-violet-500/40 p-6 text-center">
          <PartyPopper className="mx-auto h-10 w-10 text-violet-400" />
          <h3 className="font-display text-2xl font-extrabold text-fg">
            Round {room.current_round}
          </h3>
          <p className="text-xs text-sr-2">Get ready! Next riddle loading…</p>
        </div>
      )}

      {room.state === 'CALLOUT' &&
        (isMyTurn ? (
          <div className="animate-pop space-y-3 rounded-2xl border-2 border-violet-500/60 bg-violet-600/20 p-6 text-center neon-violet">
            <PartyPopper className="mx-auto h-10 w-10 text-violet-700 dark:text-violet-300" />
            <h3 className="font-display text-2xl font-extrabold text-fg">YOU'RE UP!</h3>
            <p className="text-xs text-violet-700 dark:text-violet-200">Step up to the camera now!</p>
            {/* Pre-lock notice: the proof controls exist only
                once the turn is live AND the riddle has landed; this line
                explains the quiet buttons instead of leaving them a mystery. */}
            <p className="text-[10px] font-semibold text-violet-600/80 dark:text-violet-300/70">
              Camera + hints unlock when your riddle lands — get ready!
            </p>
          </div>
        ) : (
          <WaitingCard name={activePlayer?.name ?? '…'} />
        ))}

      {room.state === 'ACTIVE_TURN' &&
        (isMyTurn ? (
          <div className="animate-pop space-y-4 rounded-2xl border-2 border-emerald-500/60 bg-gradient-to-b from-emerald-500/15 to-yellow-500/10 p-6 text-center neon-emerald">
            <div className="mx-auto flex h-12 w-12 animate-vibrate items-center justify-center rounded-full bg-emerald-500/25 text-emerald-700 dark:text-emerald-300">
              <Camera className="h-6 w-6" />
            </div>
            <h3 className="font-display text-2xl font-extrabold text-fg">
              🟢 IT'S YOUR TURN!
            </h3>
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              Point at the camera and hold up your proof object!
            </p>

            {!riddle && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"
              >
                <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                <span className="text-xs font-bold text-amber-700 dark:text-amber-300">Preparing riddle…</span>
              </div>
            )}

            {riddle && (
              <div className="sr-well space-y-2 rounded-xl p-3.5 text-left">
                <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wider text-amber-400">
                  <span>Riddle · {riddle.difficulty}</span>
                  <span>{riddle.proof_method}</span>
                </div>
                <p className="font-display text-sm font-bold leading-snug text-fg">
                  “{riddle.text}”
                </p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20 dark:bg-white/10">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ease-linear ${
                      urgency === 'red'
                        ? 'animate-pulse bg-rose-500'
                        : urgency === 'amber'
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    }`}
                    style={{ width: `${timerPct}%` }}
                  />
                </div>
                <div
                  className={`text-right font-mono text-xs font-bold ${
                    urgency === 'red' ? 'animate-pulse text-rose-500 dark:text-rose-400' : urgency === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-sr-2'
                  }`}
                >
                  {/* During a countdown-capture window the raw riddle
                      clock is frozen and reads as a random big number; show
                      the capture state instead (the "143 flash" glitch). */}
                  {room.countdown ? '⏱ capture…' : `${Math.max(0, Math.ceil(localTimeRemaining))}s left`}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={requestHint}
              disabled={hintSent || !riddle || reading}
              title={
                !riddle
                  ? 'The riddle is still being written — hints unlock once it lands'
                  : reading
                    ? lock === 'reading'
                      ? 'The Voice Master is reading the riddle — hints unlock when the clock starts'
                      : 'Hints are locked right now — wait a moment'
                  : (me.hint_tokens ?? 0) > 0
                    ? 'Ask the Voice Master for a hint — free while tokens last'
                    : 'No free hints left — solving after this hint pays 50 % of the points'
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/25 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Lightbulb className="h-4 w-4" />
              {hintSent
                ? 'Hint Sent to TV!'
                : !riddle
                  ? 'Hints locked — riddle incoming'
                  : reading
                    ? lock === 'reading'
                      ? 'Hints locked — listen to the riddle'
                      : lock === 'host_paused'
                        ? 'Hints locked — game paused'
                        : 'Hints locked — wait a moment'
                    : (me.hint_tokens ?? 0) > 0
                    ? `Request Hint (${me.hint_tokens} free left)`
                    : 'Request Hint (solve pays 50 %)'}
            </button>

            {/* ⏱ Countdown Capture: step into frame, the photo fires
                by itself; the riddle clock is paused for the window */}
            {!room.countdown && riddle && !isPaused && !reading && (
              <button
                type="button"
                onClick={onCountdown}
                title="Need a moment to get into frame? The photo fires by itself after the countdown — the clock is paused meanwhile"
                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-emerald-500/50 bg-emerald-500/10 py-2.5 text-xs font-bold text-emerald-700 transition hover:bg-emerald-500/20 active:scale-95 dark:text-emerald-300"
              >
                <Timer className="h-4 w-4" /> Countdown Capture ({room.countdown_secs ?? 3}s)
              </button>
            )}
            {room.countdown && (
              <div
                role="status"
                aria-live="assertive"
                className="animate-pop flex items-center justify-center gap-2 rounded-xl border-2 border-emerald-500/60 bg-emerald-500/15 py-3"
              >
                <Timer className="h-5 w-5 animate-pulse text-emerald-600 dark:text-emerald-300" />
                <span className="font-display text-lg font-extrabold text-emerald-700 dark:text-emerald-200">
                  Capturing in {Math.max(1, room.countdown.secs)}s — timer paused!
                </span>
              </div>
            )}

          </div>
        ) : (
          <div className="sr-glass space-y-3 rounded-2xl border-2 p-6 text-center" style={{ borderColor: 'var(--sr-line)' }}>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full sr-well text-sr-3">
              <Lock className="h-6 w-6" />
            </div>
            <h3 className="font-display text-lg font-bold text-sr-2">WAIT FOR YOUR TURN</h3>
            <p className="text-xs text-sr-3">
              Currently searching:{' '}
              <strong className="text-violet-400">{activePlayer?.name ?? '…'}</strong>
            </p>
            {riddle ? (
              <div className="sr-well rounded-xl p-3 text-left">
                <div className="text-[9px] font-bold uppercase tracking-wider text-sr-3">
                  Their riddle · {riddle.difficulty}
                </div>
                <p className="mt-1 text-xs font-semibold italic text-sr-2">“{riddle.text}”</p>
              </div>
            ) : (
              <div
                role="status"
                className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                <span className="text-[11px] font-semibold text-sr-2">Preparing riddle…</span>
              </div>
            )}
          </div>
        ))}

      {room.state === 'EVALUATING' && (
        <div className="sr-glass space-y-3 rounded-2xl border-2 border-amber-500/50 p-6 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-amber-400" />
          <h3 className="font-display font-bold text-lg text-amber-600 dark:text-amber-300">
            🤖 Checking the proof…
          </h3>
          <p className="text-xs text-sr-3">
            {isMyTurn ? 'Your proof is being verified. Fingers crossed!' : `${activePlayer?.name ?? 'A player'}'s proof is being verified.`}
          </p>
        </div>
      )}

      {room.state === 'ROUND_RESULTS' &&
        (lastWasMine && evalRes ? (
          <div
            className={`animate-pop space-y-3 rounded-2xl border-2 p-6 text-center ${
              evalRes.passed
                ? 'border-emerald-500/50 bg-emerald-500/15'
                : 'border-rose-500/50 bg-rose-500/15'
            }`}
          >
            {evalRes.passed ? (
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
            ) : (
              <XCircle className="mx-auto h-10 w-10 text-rose-400" />
            )}
            <h3 className="font-display text-2xl font-extrabold text-fg">
              {evalRes.passed ? 'PROOF ACCEPTED!' : evalRes.error ? 'IMAGE UNCLEAR' : 'REJECTED!'}
            </h3>
            <p className="text-xs text-sr-2">{evalRes.feedback}</p>
            {/* 🔍 The host is deciding this unclear photo */}
            {evalRes.error && room.host_review && (
              <div
                role="status"
                aria-live="polite"
                className="animate-pop flex items-center justify-center gap-2 rounded-xl border-2 border-sky-500/60 bg-sky-500/15 py-3"
              >
                <Loader2 className="h-5 w-5 animate-spin text-sky-600 dark:text-sky-300" />
                <span className="font-display text-base font-extrabold text-sky-700 dark:text-sky-200">
                  The host is checking your photo…
                </span>
              </div>
            )}
            {/* ⏱ Countdown retake window (used to be a toast only) */}
            {evalRes.error && !room.host_review && room.countdown && (
              <div
                role="status"
                aria-live="assertive"
                className="animate-pop flex items-center justify-center gap-2 rounded-xl border-2 border-emerald-500/60 bg-emerald-500/15 py-3"
              >
                <Timer className="h-5 w-5 animate-pulse text-emerald-600 dark:text-emerald-300" />
                <span className="font-display text-lg font-extrabold text-emerald-700 dark:text-emerald-200">
                  Retaking in {Math.max(1, room.countdown.secs)}s — get in frame!
                </span>
              </div>
            )}
            {evalRes.points_earned !== 0 && (
              <div
                className={`font-mono text-xl font-bold ${
                  evalRes.points_earned > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {evalRes.points_earned > 0 ? '+' : ''}
                {evalRes.points_earned} pts
              </div>
            )}
            {/* 📸 my captured proof, polaroid-style */}
            {lastMoment && lastMoment.player_id === myId && (
              <div className="flex justify-center pt-1">
                <div className="polaroid polaroid-static w-36 -rotate-2">
                  <span className="polaroid-tape" aria-hidden />
                  <span className="polaroid-frame block">
                    <img
                      src={lastMoment.photo}
                      alt="My captured proof snapshot"
                      className="h-20 w-full object-cover"
                    />
                  </span>
                  <span className="block px-2 pb-1.5 pt-1 text-center font-mono text-[8px] text-slate-500">
                    your proof · “{lastMoment.keyword}”
                  </span>
                  {lastMoment.caption && (
                    <span className="polaroid-caption block px-2 pb-2 text-center">“{lastMoment.caption}”</span>
                  )}
                </div>
              </div>
 )}

            {/* 💬 Caption this moment - one line under my accepted proof */}
            {lastMoment &&
              lastMoment.player_id === myId &&
              lastMoment.verdict === 'pass' &&
              !lastMoment.caption &&
              (captionSavedFor === lastMoment.id ? (
                <div
                  role="status"
                  className="animate-pop flex items-center justify-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-[11px] font-bold text-violet-700 dark:text-violet-300"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Caption saved to the gallery!
                </div>
              ) : (
                <div className="sr-well space-y-1.5 rounded-xl p-2.5 text-left">
                  <label
                    htmlFor="moment-caption"
                    className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-violet-500 dark:text-violet-400"
                  >
                    <MessageCircle className="h-3 w-3" /> Caption this moment
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      id="moment-caption"
                      value={captionText}
                      onChange={(e) => setCaptionText(e.target.value.slice(0, 60))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && captionText.trim()) {
                          onCaption(lastMoment.id, captionText);
                          setCaptionSavedFor(lastMoment.id);
                          toast.success('Caption sent to the TV! 💬');
                        }
                      }}
                      maxLength={60}
                      placeholder="e.g. Me & the trusty kettle 🫖"
                      className="min-w-0 flex-1 rounded-lg border border-violet-500/40 bg-white/60 px-2.5 py-2 text-[11px] font-semibold text-fg placeholder:text-sr-3 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 dark:bg-black/25"
                    />
                    <button
                      type="button"
                      disabled={!captionText.trim()}
                      onClick={() => {
                        onCaption(lastMoment.id, captionText);
                        setCaptionSavedFor(lastMoment.id);
                        toast.success('Caption sent to the TV! 💬');
                      }}
                      aria-label="Send caption to the TV"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500 text-white shadow-lg shadow-violet-500/25 transition hover:bg-violet-400 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-right text-[8px] font-semibold text-sr-3">
                    {captionText.length}/60 · shows under your photo in the gallery
                  </p>
                </div>
              ))}
          </div>
        ) : (
          <div className="sr-glass space-y-2 rounded-2xl border-2 p-6 text-center" style={{ borderColor: 'var(--sr-line)' }}>
            <Bot className="mx-auto h-8 w-8 text-sr-3" />
            <p className="text-xs text-sr-3">Turn finished. Next player loading…</p>
          </div>
        ))}

      {/* ── Emoji reactions (fly to the host TV) ───────────────────── */}
      <div
        className="sr-glass relative overflow-visible rounded-2xl p-3"
        style={{ borderColor: 'var(--sr-line)' }}
      >
        <div className="mb-2 flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-sr-3">
          <span>Hype the TV</span>
          <span aria-hidden>✨ → 📺</span>
        </div>
        <div className="flex items-center justify-between gap-1.5">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => react(emoji)}
              disabled={reactCooldown}
              aria-label={`Send ${emoji} reaction to the TV${counts[emoji] ? ` (sent ${counts[emoji]})` : ''}`}
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-black/10 bg-black/10 text-xl shadow-sm transition hover:-translate-y-0.5 hover:border-amber-400/40 hover:bg-amber-500/10 hover:shadow-lg hover:shadow-amber-500/20 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-black/25"
            >
              {emoji}
              {counts[emoji] ? (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[8px] font-extrabold text-slate-950 shadow"
                >
                  {counts[emoji]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {/* combo streak chip */}
        {comboChip && (
          <div
            key={comboChip.key}
            aria-live="polite"
            className="animate-pop absolute left-1/2 top-1 z-10 -translate-x-1/2 rounded-full border border-amber-400/60 bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 text-[10px] font-extrabold text-slate-950 shadow-lg shadow-amber-500/40"
          >
            {comboChip.emoji} COMBO ×{comboChip.n}!
          </div>
        )}
        {/* instant local feedback: mini emojis pop out of the bar */}
        {bursts.map((b) => (
          <span
            key={b.key}
            aria-hidden
            className={`emoji-burst pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 ${
              b.big ? 'text-3xl' : 'text-2xl'
            }`}
            style={{ '--dx': `${b.dx}px`, '--rot': `${b.rot}deg`, '--dur': b.big ? '2s' : '1.6s', '--sc': 1 } as React.CSSProperties}
          >
            {b.emoji}
          </span>
        ))}
      </div>

      {/* Scoreboard + my performance + live feed */}
      <Scoreboard ranked={ranked} activePlayerId={room.active_player_id} myId={myId} compact />
      <div className="sr-glass rounded-2xl p-3" style={{ borderColor: 'var(--sr-line)' }}>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[9px] font-bold uppercase tracking-widest text-sr-3">
            My Performance
          </span>
          <span className="rounded border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-bold text-amber-700 dark:bg-white/5 dark:text-amber-400">
            {me.tier} tier · {me.current_difficulty}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 text-center">
          <StatMini icon="✅" label="Solves" value={String(st.solves)} />
          <StatMini icon="🎯" label="Accuracy" value={acc} bar={attempts > 0 ? st.solves / attempts : null} />
          <StatMini icon="⚡" label="Best" value={best} />
          <StatMini icon="💀" label="Doom" value={String(st.doom_survives)} />
        </div>
        {/* The Theme Mastery panel died with the category system:
           there are no per-player themes anymore, so there is nothing to
           master per theme. This also removes the me.themes.map crash site
           (zombie player nodes without the themes array used to throw). */}
      </div>
      <FeedTicker events={feed} compact />

      <button
        type="button"
        onClick={onLeave}
        className="mx-auto flex items-center gap-1.5 text-[11px] text-sr-3 transition hover:text-rose-600 dark:hover:text-rose-300"
      >
        <LogOut className="h-3 w-3" /> Leave Room
      </button>
    </div>
  );
}

function StatMini({
  icon,
  label,
  value,
  bar = null,
}: {
  icon: string;
  label: string;
  value: string;
  /** optional 0..1 ratio → renders a mini progress bar under the value */
  bar?: number | null;
}) {
  return (
    <div className="rounded-xl bg-black/10 p-1.5 transition hover:bg-black/15 dark:bg-white/[0.05] dark:hover:bg-white/[0.08]">
      <div className="text-sm leading-none">{icon}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] font-bold text-fg">{value}</div>
      <div className="text-[8px] font-semibold uppercase tracking-wide text-sr-3">{label}</div>
      {bar != null && (
        <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-black/20 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-[width] duration-700"
            style={{ width: `${Math.round(Math.max(0, Math.min(1, bar)) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function WaitingCard({ name }: { name: string }) {
  return (
    <div className="sr-glass space-y-3 rounded-2xl border-2 p-6 text-center" style={{ borderColor: 'var(--sr-line)' }}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full sr-well text-sr-3">
        <Lock className="h-6 w-6" />
      </div>
      <h3 className="font-display text-lg font-bold text-sr-2">WAIT FOR YOUR TURN</h3>
      <p className="text-xs text-sr-3">
        Currently stepping up: <strong className="text-violet-400">{name}</strong>
      </p>
    </div>
  );
}
