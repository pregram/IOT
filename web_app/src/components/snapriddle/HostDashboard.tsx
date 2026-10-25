'use client';

import { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Dices, Flag, Hourglass, Lightbulb, Loader2, Pencil, PauseCircle, PlayCircle, RotateCcw, Scale, Search, Sparkles, Star, Timer, Volume2, XCircle, PenLine, Hand } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PhotoMoment, Room, SoundCueId, SpecialRoundType } from '@/lib/types';
import type { RankedPlayer } from '@/utils/gameLogic';
import { SPECIAL_LABEL, buttonLock, BUTTON_LOCK_MSG } from '@/utils/gameLogic';
import { SOUND_CUES } from '@/lib/sfx';
import CameraFeed, { type FeedStatus } from './CameraFeed';
import CaptionEditor from './CaptionEditor';
import FeedTicker from './FeedTicker';
import FullScreenBanner from './FullScreenBanner';
import Scoreboard from './Scoreboard';
import type { CameraMode, FeedEvent, Player } from '@/lib/types';

export interface ActivePlayerRef {
  id: string;
  player: Player;
}

interface HostDashboardProps {
  room: Room;
  ranked: RankedPlayer[];
  activePlayer: ActivePlayerRef | null;
  /** host-local smooth countdown (kept fresh by the engine) */
  localTimeRemaining: number;
  frozenUrl: string | null;
  snapSeq: number;
  /** demo rooms render the simulated feed; real rooms the board stream */
  isDemo: boolean;
  /** board IP - auto-discovered from the firmware heartbeat */
  cameraIp: string;
  /** true while the board heartbeat is fresh (drives Waiting-for-camera) */
  hardwareOnline: boolean;
  /** board boot epoch from the heartbeat - a change reopens the stream */
  espBoot: number;
  /** true while the ESP32 firmware is running the Gemini Vision judging */
  espJudging: boolean;
  /** 🎁 CALLOUT banner switches to the bonus style for a bonus mini-turn */
  bonusActive: boolean;
  feed: FeedEvent[];
  onSnap: () => void;
  onJudgeOverride: (v: 'pass' | 'fail' | 'unclear') => void;
  onContinue: () => void;
  onRetake: () => void;
  onEndGame: () => void;
  /** ⏸/▶ freeze or release the ACTIVE_TURN countdown (TV + phones) */
  onPauseToggle: () => void;
  /** true while the countdown is frozen */
  isPaused: boolean;
  /** host hype spotlight */
  spotlightId: string | null;
  onSpotlight: (playerId: string, name: string) => void;
  /** most recent captured proof photo (shown in the result card) */
  lastMoment: PhotoMoment | null;
  /** ✏️ host caption moderation - save (string) or clear (null) a caption */
  onEditCaption: (momentId: string, text: string | null) => void;
  /** 🎺 host sound board - blast a party jingle on TV + all phones */
  onSoundCue: (sound: SoundCueId) => void;
  /** ⏱ Countdown Capture (pause clock → auto capture at 0) */
  onCountdown: () => void;
  /** 🖐 Pivot to Paper (accept drawings / written answers) */
  onPivotPaper: () => void;
  /** 🙋 Overrule AI (accept the proof after a wrong verdict) */
  onOverrule: () => void;
  /** Continue is waiting for the voice to finish */
  continueBusy: boolean;
  /** 🔍 Host Check: highlighted after repeated unclear photos */
  hostCheckSuggested: boolean;
  /** 🔍 open (true) / cancel (false) the Host Check panel (marks the room) */
  onHostReview: (open: boolean) => void;
  /** 🔍 the host's decision on an UNCLEAR photo: accept awards, reject fails */
  onHostCheck: (accept: boolean) => void;
}

function SpecialBadge({ special }: { special: SpecialRoundType }) {
  if (special === 'NONE') return null;
  const isDoom = special === 'DOUBLE_OR_DOOM';
  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-bold ${
        isDoom
          ? 'animate-doom-pulse border-rose-500/40 bg-rose-500/20 text-rose-600 dark:text-rose-300'
          : 'border-yellow-500/40 bg-yellow-500/20 text-yellow-600 dark:text-yellow-300'
      }`}
    >
      {SPECIAL_LABEL[special]}
    </span>
  );
}

export default function HostDashboard({
  room,
  ranked,
  activePlayer,
  localTimeRemaining,
  frozenUrl,
  snapSeq,
  isDemo,
  cameraIp,
  hardwareOnline,
  espBoot,
  espJudging,
  bonusActive,
  feed,
  onSnap,
  onJudgeOverride,
  onContinue,
  onRetake,
  onEndGame,
  onPauseToggle,
  isPaused,
  spotlightId,
  onSpotlight,
  lastMoment,
  onEditCaption,
  onSoundCue,
  onCountdown,
  onPivotPaper,
  onOverrule,
  continueBusy,
  hostCheckSuggested,
  onHostReview,
  onHostCheck,
}: HostDashboardProps) {
  const st = room.state;
  const evalRes = room.last_evaluation;
  // 🔍 The Host Check panel is open while host_review is set
  const reviewing = st === 'ROUND_RESULTS' && Boolean(evalRes?.error) && Boolean(room.host_review);
  const spotPlayer = spotlightId ? room.players?.[spotlightId] ?? null : null;

  /* ⏱ Countdown Capture overlay clock (counts the live window)
     The number is CLAMPED to the window length: the overlay can
     never show more seconds than the countdown has (stale-timestamp /
     clock-skew inputs die here instead of flashing a bogus big number
     before the real "3" lands). */
  const cd = room.countdown ?? null;
  const [cdNow, setCdNow] = useState(0);
  useEffect(() => {
    if (!cd) return undefined;
    const iv = window.setInterval(() => setCdNow(Date.now()), 200);
    return () => window.clearInterval(iv);
  }, [cd?.ts, cd?.secs]);
  // The countdown overlay also covers the unclear-RETAKE window
  // (a double press there used to show only a small toast)
  const retakeWindow = st === 'ROUND_RESULTS' && Boolean(room.last_evaluation?.error);
  const cdVisible = Boolean(cd) && (st === 'ACTIVE_TURN' || retakeWindow);
  const cdLeft = cd
    ? Math.min(
        cd.secs,
        Math.max(0, Math.ceil((cd.ts + cd.secs * 1000 - (cdNow || Date.now())) / 1000)),
      )
    : 0;

  /* ⏸ pause failsafe - after 45 s frozen, gently remind the host to resume.
     (Hooks live above the banner early-return to keep order stable.) */
  const pausedAt = room.paused?.at ?? null;
  const [pauseNow, setPauseNow] = useState(0);
  useEffect(() => {
    if (!isPaused || !pausedAt) return undefined;
    const iv = window.setInterval(() => setPauseNow(Date.now()), 500);
    return () => window.clearInterval(iv);
  }, [isPaused, pausedAt]);
  const pauseSecs =
    isPaused && pausedAt ? Math.max(0, Math.floor(((pauseNow || Date.now()) - pausedAt) / 1000)) : 0;
  const pauseHint = pauseSecs >= 45;
  const pauseClock = `${Math.floor(pauseSecs / 60)}:${String(pauseSecs % 60).padStart(2, '0')}`;

  /* 🌟 Spotlight auto-suggest - one-tap nudge when the active player is on a
     2+ streak. Re-arms per (player, streak) event, dismissible. */
  const [dismissedSuggest, setDismissedSuggest] = useState<string | null>(null);
  const streak = activePlayer?.player.streak ?? 0;
  const suggestKey = `${room.active_player_id}:${streak}`;
  const showSuggest =
    st === 'ACTIVE_TURN' &&
    streak >= 2 &&
    !spotlightId &&
    dismissedSuggest !== suggestKey &&
    Boolean(activePlayer);

  /* ✏️ caption moderation dialog state (result polaroid) */
  const [editMoment, setEditMoment] = useState<PhotoMoment | null>(null);

  /* ── Full-screen state flashes ─────────────────────────────────────── */
  if (st === 'INTRO' || st === 'ROUND_FLASH' || st === 'CALLOUT') {
    let kind: 'get-ready' | 'round' | 'bonus' | 'bonus-callout' | 'doom' | 'callout' = 'round';
    if (st === 'INTRO') kind = 'get-ready';
    else if (st === 'CALLOUT') kind = bonusActive ? 'bonus-callout' : 'callout';
    else if (room.special_round_type === 'BONUS') kind = 'bonus';
    else if (room.special_round_type === 'DOUBLE_OR_DOOM') kind = 'doom';

    return (
      <div className="flex w-full flex-1 items-center justify-center">
        <FullScreenBanner
          kind={kind}
          round={room.current_round}
          total={room.num_rounds}
          gameName={room.game_name}
          playerName={activePlayer?.player.name}
          playerInitial={activePlayer?.player.name?.charAt(0).toUpperCase()}
          playerColor={activePlayer?.player.color}
          score={activePlayer?.player.score}
          streak={activePlayer?.player.streak}
        />
      </div>
    );
  }

  /* ── Board (ACTIVE_TURN / EVALUATING / ROUND_RESULTS) ──────────────── */
  const feedStatus: FeedStatus =
    st === 'ACTIVE_TURN'
      ? 'live'
      : st === 'EVALUATING'
        ? 'judging'
        : st === 'ROUND_RESULTS' && evalRes
          ? evalRes.passed
            ? 'passed'
            : evalRes.error
              ? /* unclear → show the LIVE feed so the player can reposition
                   the object for the retake (user requirement) */
                'live'
              : 'failed'
          : 'idle';

  const timerLow = localTimeRemaining <= 5.05 && room.turn_timer.is_active;
  /* ⏱ Proportional urgency (whole-second floors): amber at ≤ T/3,
     pulsing red at ≤ T/6. The host's only time control is pause. */
  const limit = room.current_riddle?.time_limit_sec ?? 0;
  const amberAt = Math.floor(limit / 3);
  const redAt = Math.floor(limit / 6);
  const urgency: 'idle' | 'normal' | 'amber' | 'red' =
    !room.turn_timer.is_active || limit <= 0
      ? 'idle'
      : isPaused
        ? 'idle'
        : localTimeRemaining <= redAt
          ? 'red'
          : localTimeRemaining <= amberAt
            ? 'amber'
            : 'normal';
  const riddlePending = st === 'ACTIVE_TURN' && !room.current_riddle;

  return (
    <div className="w-full max-w-6xl space-y-4">
      {/* Status header */}
      <div className="sr-glass flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-amber-500/30 bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-700 dark:text-amber-300">
            Round {room.current_round}/{room.num_rounds}
          </span>
          <span className="text-xs font-semibold text-sr-2">
            Active Player: <strong className="text-fg">{activePlayer?.player.name ?? '—'}</strong>
          </span>
          <SpecialBadge special={room.special_round_type} />
          {/* 🔥 hot-streak lives in the status row now */}
          {st === 'ACTIVE_TURN' && (activePlayer?.player.streak ?? 0) >= 2 && (
            <span
              role="status"
              className="animate-pop flex items-center gap-1.5 rounded-full border border-orange-400/50 bg-gradient-to-r from-orange-500/80 to-rose-500/80 px-3 py-1 text-[11px] font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              <span aria-hidden>🔥</span>
              {activePlayer?.player.name} · {activePlayer?.player.streak} WIN STREAK
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Timer
              className={`h-4 w-4 ${
                isPaused
                  ? 'text-sky-600 dark:text-sky-400'
                  : urgency === 'red'
                    ? 'animate-pulse text-rose-500 dark:text-rose-400'
                    : urgency === 'amber'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400'
              }`}
            />
            {riddlePending ? (
              <span className="flex items-center gap-2 font-mono text-sm font-bold text-sr-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> preparing…
              </span>
            ) : cdVisible ? (
              /* During a countdown-capture window the raw riddle
                 clock reads as a random big number ("143" flash before the
                 "3" overlay) - show the capture state instead. */
              <span className="flex items-center gap-2 font-mono text-sm font-bold text-emerald-600 dark:text-emerald-300">
                ⏱ capture window…
              </span>
            ) : (
              <span
                className={`font-mono text-xl font-bold ${
                  isPaused
                    ? 'text-sky-600 dark:text-sky-400'
                    : urgency === 'red'
                      ? 'animate-pulse text-rose-500 dark:text-rose-400'
                      : urgency === 'amber'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {Math.max(0, Math.ceil(localTimeRemaining))}s
              </span>
            )}
          </div>
          {/* ⏸/▶ pause - the host's ONLY time control */}
          {st === 'ACTIVE_TURN' &&
            (isPaused ? (
              <button
                type="button"
                onClick={onPauseToggle}
                title="Resume the countdown (P)"
                className="animate-pop flex items-center gap-1 rounded-lg border border-sky-400/70 bg-sky-500/25 px-2.5 py-1.5 text-[10px] font-extrabold text-sky-700 shadow-lg shadow-sky-500/25 transition active:scale-95 dark:text-sky-200"
              >
                <PlayCircle className="h-3.5 w-3.5" /> Resume{pauseHint ? ` · ${pauseClock}` : ''}
              </button>
            ) : (
              <button
                type="button"
                onClick={onPauseToggle}
                title="Freeze the countdown — doorbell, snack or chaos break (P)"
                className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-[10px] font-extrabold text-sky-600 transition hover:border-sky-400 hover:bg-sky-500/20 active:scale-95 dark:text-sky-400"
              >
                <PauseCircle className="h-3.5 w-3.5" /> Pause
              </button>
            ))}
          <button
            type="button"
            onClick={onEndGame}
            className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold text-sr-3 transition hover:border-rose-500/40 hover:text-rose-600 dark:hover:text-rose-300"
            style={{ borderColor: 'var(--sr-line)' }}
            title="End the match early and show victory standings — also the escape hatch while a riddle is stuck generating"
          >
            <Flag className="h-3 w-3" /> End Match
          </button>
        </div>
      </div>

      {/* Timer progress bar */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20 dark:bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-linear ${
            isPaused
              ? 'bg-sky-400'
              : urgency === 'red'
                ? 'animate-pulse bg-rose-500'
                : urgency === 'amber'
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-emerald-500 to-teal-500'
          }`}
          style={{
            width: `${Math.max(0, Math.min(100, (localTimeRemaining / (room.current_riddle?.time_limit_sec || 1)) * 100))}%`,
          }}
        />
      </div>

      {/* 🎺 Host sound board - one-tap party jingles on the TV + every phone
          (hotkeys 1-4; each hit gets its own color family + glow) */}
      <div className="sr-glass flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-sr-3">
          <Volume2 className="h-3 w-3" /> Sound Board
        </span>
        <span className="hidden h-4 w-px bg-black/10 sm:block dark:bg-white/10" aria-hidden />
        {SOUND_CUES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSoundCue(s.id)}
            title={`${s.label} — plays on the TV and every phone (key ${i + 1})`}
            aria-label={`Play ${s.label} sound`}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-extrabold transition hover:-translate-y-0.5 hover:shadow-lg active:scale-95 ${s.chipCls}`}
          >
            <span className="text-sm leading-none" aria-hidden>
              {s.emoji}
            </span>
            {s.label}
          </button>
        ))}
        {pauseHint && isPaused && (
          <span
            role="status"
            className="animate-pop ml-auto flex items-center gap-1.5 rounded-lg border border-sky-400/50 bg-sky-500/15 px-2.5 py-1.5 text-[10px] font-bold text-sky-700 dark:text-sky-300"
          >
            <PauseCircle className="h-3 w-3 animate-pulse" /> Paused for {pauseClock} — press
            <kbd className="kbd">P</kbd> to resume
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Camera column */}
        <div className="space-y-4 lg:col-span-2">
          <div className="relative">
            <CameraFeed
              mode={isDemo ? 'mock' : 'real'}
              espIp={cameraIp}
              hardwareOnline={hardwareOnline}
              espBoot={espBoot}
              status={feedStatus}
              frozenUrl={frozenUrl}
              snapSeq={snapSeq}
              judgeName={activePlayer?.player.name ?? null}
              className="sr-shadow"
            />
            {/* ⏸ Slim paused banner: the photo/frame stays
                fully visible - a glass pill at the top reports the frozen
                clock instead of the old full-screen PAUSED slab. */}
            {isPaused && st === 'ACTIVE_TURN' && (
              <div
                role="status"
                aria-label="Countdown paused"
                className="animate-pop absolute left-1/2 top-3 z-30 flex max-w-[94%] -translate-x-1/2 items-center gap-2.5 rounded-full border border-sky-400/40 bg-slate-950/75 px-4 py-2 shadow-lg shadow-sky-500/20 backdrop-blur-md"
              >
                <PauseCircle className="h-4 w-4 shrink-0 animate-pulse text-sky-300" />
                <span className="whitespace-nowrap text-xs font-bold text-sky-100">
                  Paused — press Resume
                </span>
                {pauseHint && (
                  <span className="hidden shrink-0 items-center sm:flex">
                    <span className="animate-pop rounded-full border border-sky-400/40 bg-sky-500/15 px-2.5 py-0.5 text-[10px] font-bold text-sky-200">
                      ⏸ {pauseClock} — press <kbd className="kbd">P</kbd> to resume
                    </span>
                  </span>
                )}
              </div>
            )}
            {/* Host spotlight: golden vignette + floating chip over the feed */}
            {spotPlayer && (
              <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
                <div
                  className="animate-spot absolute inset-0 rounded-2xl"
                  style={{
                    background:
                      'radial-gradient(ellipse at center, transparent 40%, rgba(245,158,11,0.32) 100%)',
                  }}
                />
                <div className="animate-pop absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-amber-400/50 bg-black/55 px-3.5 py-1.5 text-xs font-bold text-amber-300 shadow-lg shadow-amber-500/30 backdrop-blur-sm">
                  🌟 {spotPlayer.name} in the Spotlight
                </div>
              </div>
            )}

            {/* ⏱ Countdown Capture overlay: big number + hint that
                the riddle clock is frozen for the window */}
            {cdVisible && (
              <div
                role="status"
                aria-live="assertive"
                className="animate-pop absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-slate-950/45 backdrop-blur-[2px]"
              >
                <span
                  key={cdLeft}
                  className="animate-pop font-display text-8xl font-extrabold text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)]"
                >
                  {Math.max(1, cdLeft)}
                </span>
                <span className="rounded-full border border-white/25 bg-black/55 px-3.5 py-1.5 text-xs font-bold text-white/90">
                  {retakeWindow
                    ? `Retaking in ${Math.max(1, cdLeft)}s — timer stays frozen`
                    : `Capturing in ${Math.max(1, cdLeft)}s — timer paused`}
                </span>
              </div>
            )}

            {/* 🤖 ESP32 Vision judging chip - the board's own Gemini call */}
            {st === 'EVALUATING' && espJudging && (
              <div
                role="status"
                className="animate-pop absolute left-3 top-3 z-30 flex items-center gap-2 rounded-xl border border-emerald-400/50 bg-black/65 px-3 py-2 shadow-lg shadow-emerald-500/25 backdrop-blur-md"
              >
                <span className="flex h-2 w-2 shrink-0">
                  <span className="absolute h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                <span className="text-[11px] font-semibold text-white/90">
                  ESP32 Vision is judging the photo…
                </span>
              </div>
            )}

            {/* 🔥 Hot-streak chip moved into the status row
 - the feed overlays stay calm: pause, judging, spotlight. */}

            {/* 🌟 Auto-suggest: player on a hot streak → one-tap spotlight */}
            {showSuggest && activePlayer && (
              <div
                role="status"
                className="animate-pop absolute bottom-3 left-3 z-30 flex items-center gap-2 rounded-xl border border-amber-400/50 bg-black/65 px-3 py-2 shadow-lg shadow-amber-500/25 backdrop-blur-md"
              >
                <Sparkles className="h-4 w-4 shrink-0 animate-pulse text-amber-300" />
                <span className="text-[11px] font-semibold text-white/90">
                  {activePlayer.player.name} is on a <strong className="text-amber-300">{streak}🔥 streak</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onSpotlight(activePlayer.id, activePlayer.player.name)}
                  className="flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-[10px] font-extrabold text-slate-950 shadow transition hover:bg-amber-400 active:scale-95"
                >
                  <Star className="h-3 w-3 fill-slate-950" /> Spotlight!
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedSuggest(suggestKey)}
                  aria-label="Dismiss spotlight suggestion"
                  className="rounded-md px-1 text-xs text-white/50 transition hover:text-white"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="sr-glass flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 text-xs">
            <span className="text-sr-3">
              Dual control: ESP32 GPIO physical button <em>or</em> web GUI
            </span>
            {st === 'ACTIVE_TURN' &&
              (room.current_riddle ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Capture is LOCKED while the riddle is read aloud,
                      the host paused the turn, or a hint is being read */}
                  {buttonLock(room) ? (
                    <span
                      role="status"
                      aria-live="polite"
                      className="flex items-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2 text-[11px] font-bold text-sky-700 dark:text-sky-300"
                    >
                      <Volume2 className="h-3.5 w-3.5 animate-pulse" /> {BUTTON_LOCK_MSG[buttonLock(room)!]}
                    </span>
                  ) : (
                  <button
                    type="button"
                    onClick={onSnap}
                    className="flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition hover:bg-amber-400 active:scale-95"
                  >
                    <Camera className="h-4 w-4" /> Snap Photo Proof
                  </button>
                  )}
                  {/* ⏱ Countdown Capture (no live window yet) */}
                  {!room.countdown && !isPaused && !buttonLock(room) && (
                    <button
                      type="button"
                      onClick={onCountdown}
                      title="Give the player a few seconds to step into frame — the clock is paused for the window"
                      className="flex items-center gap-2 rounded-xl border-2 border-emerald-500/50 bg-emerald-500/10 px-4 py-2.5 font-bold text-emerald-700 transition hover:bg-emerald-500/20 active:scale-95 dark:text-emerald-300"
                    >
                      <Timer className="h-4 w-4" /> Countdown Capture
                    </button>
                  )}
                  {/* 🖐 Pivot to Paper (once per turn) */}
                  {!room.paper_mode && (
                    <button
                      type="button"
                      onClick={onPivotPaper}
                      title="No object in the room? Accept a drawing or a written answer on paper instead"
                      className="flex items-center gap-2 rounded-xl border-2 border-violet-500/50 bg-violet-500/10 px-4 py-2.5 font-bold text-violet-700 transition hover:bg-violet-500/20 active:scale-95 dark:text-violet-300"
                    >
                      <PenLine className="h-4 w-4" /> Pivot to Paper
                    </button>
                  )}
                  {room.paper_mode && (
                    <span
                      role="status"
                      className="animate-pop flex items-center gap-1.5 rounded-xl border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-[11px] font-bold text-violet-700 dark:text-violet-300"
                    >
                      <Hand className="h-3.5 w-3.5" /> Paper mode — drawings & written answers count
                    </span>
                  )}
                </div>
              ) : (
                /* Capture is LOCKED while the riddle is still being
                   written: a photo with no riddle can never be judged. */
                <span
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[11px] font-bold text-amber-700 dark:text-amber-300"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Camera locked — riddle still generating
                </span>
              ))}
            {st === 'EVALUATING' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                  <Scale className="h-3 w-3" /> Judge override:
                </span>
                <button
                  type="button"
                  onClick={() => onJudgeOverride('pass')}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-emerald-500"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Pass
                </button>
                <button
                  type="button"
                  onClick={() => onJudgeOverride('fail')}
                  className="flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-rose-500"
                >
                  <XCircle className="h-3.5 w-3.5" /> Fail
                </button>
                <button
                  type="button"
                  onClick={() => onJudgeOverride('unclear')}
                  className="flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-2 text-[11px] font-bold text-slate-950 transition hover:bg-amber-400"
                >
                  <Hourglass className="h-3.5 w-3.5" /> Unclear
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Riddle + scoreboard column */}
        <div className="space-y-4">
          <div className="sr-glass space-y-3 rounded-2xl border-2 border-amber-500/25 p-6">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                Active Riddle ({room.current_riddle?.difficulty ?? '—'})
              </span>
              <span className="sr-well rounded px-2 py-0.5 text-[9px] font-semibold text-sr-3">
                {room.current_riddle?.proof_method ?? ''}
              </span>
            </div>
            {riddlePending ? (
              /* 🎲 The board's Gemini is writing the riddle; the game
                 never advances until it lands (End Match is the escape). */
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"
              >
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-amber-400" />
                <div>
                  <p className="text-sm font-bold text-amber-700 dark:text-amber-300">Preparing riddle…</p>
                  <p className="text-[11px] text-sr-3">
                    The camera board is asking Gemini for a fresh riddle — this usually takes a few seconds.
                  </p>
                </div>
              </div>
            ) : (
              <h3 className="font-display text-lg font-extrabold leading-snug text-fg">
                “{room.current_riddle?.text ?? 'Loading riddle…'}”
              </h3>
            )}

            {/* 🎲 The next riddle is already staged (board finished
                the prefetch) but stays HIDDEN until Continue is pressed -
                shown only as a status chip, never as text. */}
            {st === 'ROUND_RESULTS' && room.next_riddle && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2"
              >
                <Dices className="h-4 w-4 shrink-0 text-emerald-400" />
                <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  Next riddle ready — it stays secret until you press Continue.
                </p>
              </div>
            )}

            {/* 💡 hint chip - the board already SPOKE this to the whole room */}
            {room.hint && st === 'ACTIVE_TURN' && (
              <div
                role="status"
                className="animate-pop flex items-start gap-2 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3"
              >
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" />
                <p className="text-xs text-yellow-700 dark:text-yellow-200">
                  <strong className="font-bold">Hint for {room.hint.player_name}:</strong> {room.hint.text}
                  <span className="mt-0.5 block text-[10px] font-semibold text-yellow-600 dark:text-yellow-500/80">
                    A used hint halves this turn's points.
                  </span>
                </p>
              </div>
            )}

            {/* Evaluation result */}
            {st === 'ROUND_RESULTS' && evalRes && (
              <div
                key={`res-${room.phase_started_at}`}
                className={`space-y-2 ${
                  !evalRes.passed && !evalRes.error && room.special_round_type === 'DOUBLE_OR_DOOM'
                    ? 'animate-shake'
                    : ''
                }`}
              >
                <div
                  className={`space-y-2 rounded-xl border p-3 text-xs ${
                    evalRes.passed
                      ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                      : evalRes.error
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        : 'border-rose-500/40 bg-rose-500/20 text-rose-700 dark:text-rose-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-bold">
                    {evalRes.passed ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {evalRes.passed ? 'ACCEPTED!' : evalRes.error ? 'IMAGE UNCLEAR' : 'REJECTED!'}
                  </div>
                  <p>{evalRes.feedback}</p>
                  {evalRes.points_earned !== 0 && (
                    <div
                      className={`font-mono text-sm font-bold ${
                        evalRes.points_earned > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {evalRes.points_earned > 0 ? '+' : ''}
                      {evalRes.points_earned} Points Earned!
                    </div>
                  )}
                </div>

                {/* 📸 the captured proof, polaroid-style */}
                {lastMoment && (
                  <div className="flex justify-center">
                    <div className="polaroid polaroid-static relative w-40 -rotate-2">
                      <span className="polaroid-tape" aria-hidden />
                      {/* ✏️ host caption moderation - edit/clear the player's line */}
                      <button
                        type="button"
                        onClick={() => setEditMoment(lastMoment)}
                        aria-label={lastMoment.caption ? 'Edit the photo caption' : 'Add a photo caption'}
                        title={lastMoment.caption ? 'Edit caption' : 'Add caption'}
                        className={`absolute -right-2 -top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-violet-400/60 bg-[#101827] text-violet-300 shadow-lg shadow-violet-900/40 transition hover:scale-110 hover:bg-violet-500/30 active:scale-95 ${
                          lastMoment.caption ? '' : 'caption-invite'
                        }`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <span className="polaroid-frame block">
                        <img
                          src={lastMoment.photo}
                          alt={`Captured proof snapshot of “${lastMoment.keyword}”`}
                          className="h-24 w-full object-cover"
                        />
                      </span>
                      <span className="block px-2 pb-2 pt-1 text-center font-mono text-[9px] text-slate-500">
                        📸 the proof · “{lastMoment.keyword}”
                      </span>
                      {lastMoment.caption && (
                        <span className="polaroid-caption block px-2 pb-2 text-center">“{lastMoment.caption}”</span>
                      )}
                    </div>
                  </div>
 )}

                {evalRes.error && (
                  <button
                    type="button"
                    onClick={onRetake}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 py-2 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Retake Photo Now — Timer Stays Frozen
                  </button>
                )}
                {/* The pivot survives an unclear photo: say so here,
                    the ACTIVE_TURN badge is not on screen during the retake */}
                {evalRes.error && room.paper_mode && (
                  <p
                    role="status"
                    className="flex items-center justify-center gap-1.5 text-center text-[10px] font-bold text-violet-700 dark:text-violet-300"
                  >
                    <Hand className="h-3 w-3" /> Paper mode still on — the retake accepts drawings &amp; written answers
                  </p>
                )}

                {/* 🔍 Host Check: the host decides an UNCLEAR photo
                    (bad light rarely fixes itself on retakes) */}
                {evalRes.error && (
                  <div className="space-y-1">
                    {hostCheckSuggested && (
                      <p className="text-center text-[10px] font-bold text-sky-700 dark:text-sky-300">
                        Unclear again — you can check the photo yourself.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => onHostReview(true)}
                      title="Look at the photo and the answer, then accept or reject it yourself"
                      className={`flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-sky-500/50 bg-sky-500/10 py-2 text-xs font-bold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300 ${
                        hostCheckSuggested ? 'animate-pulse' : ''
                      }`}
                    >
                      <Search className="h-3.5 w-3.5" /> Host Check — Decide It Yourself
                    </button>
                  </div>
                )}

                {/* 🙋 Overrule AI: the host's final word when the
                    vision judge rejected a proof that actually matched. */}
                {/* Not after a timeout: there is no photo to accept */}
                {!evalRes.passed && !evalRes.error && !evalRes.timed_out && (
                  <button
                    type="button"
                    onClick={onOverrule}
                    title="The AI is wrong — accept this proof and award the points manually"
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-emerald-500/50 bg-emerald-500/10 py-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Overrule AI — Award the Points
                  </button>
                )}

                <button
                  type="button"
                  onClick={onContinue}
                  disabled={continueBusy}
                  aria-busy={continueBusy}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/25 transition hover:from-amber-400 hover:to-orange-400 disabled:cursor-wait disabled:opacity-70"
                >
                  {continueBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Finishing the voice line…
                    </>
                  ) : (
                    <>
                      <PlayCircle className="h-4 w-4" /> Continue to Next Turn →
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          <Scoreboard
            ranked={ranked}
            activePlayerId={room.active_player_id}
            spotlightId={spotlightId}
            onSpotlight={onSpotlight}
          />
          <FeedTicker events={feed} />
        </div>
      </div>

      {/* ✏️ host caption moderation dialog */}
      <CaptionEditor
        key={editMoment?.id ?? 'closed'}
        moment={editMoment}
        onClose={() => setEditMoment(null)}
        onSave={(momentId, text) => onEditCaption(momentId, text)}
      />

      {/* 🔍 Host Check panel: the photo, the riddle and every
          accepted answer; the host's call is final for this photo */}
      <Dialog open={reviewing} onOpenChange={(open) => { if (!open) onHostReview(false); }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2 text-lg text-fg">
              <Search className="h-5 w-5 text-sky-500" /> Host Check
            </DialogTitle>
            <DialogDescription className="text-xs text-sr-3">
              The AI could not read this photo. Look at it and decide — the clock stays frozen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs text-sr-2">
            {frozenUrl && frozenUrl !== 'mock' ? (
              <img
                src={frozenUrl}
                alt="The unclear proof photo"
                className="max-h-64 w-full rounded-lg border border-[var(--sr-line)] object-contain"
              />
            ) : (
              <p className="rounded-lg border border-dashed border-[var(--sr-line)] p-3 text-center">
                No photo preview — check the camera feed on the TV.
              </p>
            )}
            {room.current_riddle && (
              <>
                <p>
                  <span className="font-bold text-fg">Riddle:</span> {room.current_riddle.text}
                </p>
                <p>
                  <span className="font-bold text-fg">Accepted answer(s):</span>{' '}
                  {room.current_riddle.target_keyword.split('|').map((a) => a.trim()).filter(Boolean).join(' · ')}
                  {room.current_riddle.proof_method ? ` (${room.current_riddle.proof_method})` : ''}
                </p>
              </>
            )}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => onHostCheck(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2.5 text-xs font-bold text-white transition hover:bg-emerald-500"
              >
                <CheckCircle2 className="h-4 w-4" /> Accept — award points
              </button>
              <button
                type="button"
                onClick={() => onHostCheck(false)}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 py-2.5 text-xs font-bold text-white transition hover:bg-rose-500"
              >
                <XCircle className="h-4 w-4" /> Reject — no match
              </button>
            </div>
            <button
              type="button"
              onClick={() => onHostReview(false)}
              className="w-full rounded-lg border border-[var(--sr-line)] py-2 text-xs font-bold text-sr-2 transition hover:bg-[var(--sr-well)]"
            >
              Cancel — back to retake
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
