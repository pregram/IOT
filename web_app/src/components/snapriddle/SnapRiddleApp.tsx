'use client';

/**
 * Root component for both roles and the host-side game state machine.
 *
 * The host device writes every FSM transition to `rooms/{pin}` and the player phones
 * mirror it. Scoring and DDA run in host memory before being committed. Data flows
 * (turn start, judging, voice) are described in Documentation/DEVELOPER_GUIDE.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import confetti from 'canvas-confetti';
import { CloudOff, RotateCcw } from 'lucide-react';

import Header from './Header';
import Footer from './Footer';
import LandingScreen, { type CreateGameConfig } from './LandingScreen';
import JoinGameScreen, { type JoinForm } from './JoinGameScreen';
import HostLobby from './HostLobby';
import HostDashboard from './HostDashboard';
import PlayerController from './PlayerController';
import VictoryScreen from './VictoryScreen';
import SettingsDrawer from './SettingsDrawer';
import VoiceMasterBanner from './VoiceMasterBanner';
import RoleModal from './RoleModal';
import FloatingReactions from './FloatingReactions';
import { captureMockFrame } from './CameraFeed';

import { sync } from '@/lib/firebase';
import { makeHint, pickRiddle, THEME_MAP } from '@/lib/riddles';
import {
  DEFAULT_PLAYSTYLE_ID,
  ENVIRONMENT_MAP,
  PLAYSTYLE_MAP,
  PROOF_METHOD_NAMES,
  pickProofMethod,
  type ProofMethodId,
} from '@/lib/environments';
import { playerColor } from '@/lib/themeIcons';
import {
  applyTheme,
  esp32SettingsPayload,
  getInitialTheme,
  loadSettings,
  pushSettingsToEsp32,
  saveSettings,
  speakDirectToEsp32,
} from '@/lib/settings';
import {
  sfxFail,
  sfxFanfare,
  sfxJoin,
  sfxPass,
  sfxPop,
  sfxShutter,
  sfxSoundBoard,
  sfxTick,
  sfxUnclear,
  sfxWhoosh,
  setSfxVolume,
  SOUND_CUES,
} from '@/lib/sfx';
import {
  computeBadges,
  computeScore,
  doomPenalty,
  buttonLock,
  BUTTON_LOCK_MSG,
  rankPlayers,
  specialForRound,
  stepDifficulty,
  tierStartDifficulty,
  TIME_LIMIT,
  BASE_POINTS,
} from '@/utils/gameLogic';
import type {
  CurrentRiddle,
  FeedEvent,
  HardwareSession,
  HardwareSettings,
  HwEspStatus,
  HwMirror,
  JudgeResult,
  LocalSession,
  PhotoMoment,
  Player,
  ReactionEvent,
  Room,
  SoundCueId,
} from '@/lib/types';

/* ── timing constants (ms) ──────────────────────────────────────────── */
const INTRO_MS = 1800;
const FLASH_MS = 3000;
const CALLOUT_MS = 2600;
/** 🗣️ TTS↔screen sync - when the board (or the browser voice) reports the
 *  phase line FINISHED, the banner advances after this tiny minimum dwell
 *  instead of waiting out the full speech ESTIMATE. If no speech-end event
 *  ever lands (old firmware, muted, board offline), the scheduler falls
 *  back to estimate + SPEECH_GRACE_MS - i.e. today's behavior + slack. */
const SPEECH_GRACE_MS = 2500;
const MIN_DWELL_MS = 1300;
const HEARTBEAT_MS = 5000;
const HW_LOCK_STALE_MS = 15000;
/** 🔌 firmware liveness : a fresh heartbeat is ≤45 s old, but a board
 *  busy on a Gemini call legitimately stalls it - one riddle/hint attempt is
 *  ≤30 s (stepped pumps) and a judge can grind for a few minutes. While the
 *  heartbeat carries gen:"riddle"/"hint"/"judge" the board counts as
 *  "alive but thinking", NOT offline. */
const ESP_ALIVE_MS = 45000;
const ESP_BUSY_ALIVE_MS = 120000;
const ESP_JUDGE_ALIVE_MS = 200000;
/** 🗺 how long after the last fresh heartbeat the laptop voice stays silent
 *  so it can never talk over the room speaker during a transient stall */
const BOARD_VOICE_GRACE_MS = 90000;
/** 🤖 The board ACKs judging via its heartbeat (state=JUDGING +
 *  gen="judge"), so the watchdog only speaks up when the board is truly
 *  quiet: first a calm heads-up at 75 s, the override pointer at ~3 min. */
const ESP_JUDGE_TIMEOUT_MS = 75000;
const ESP_JUDGE_FINAL_MS = 105000; // fires AFTER the timeout → ≈180 s total
const SESSION_KEY = 'snapriddle:session';
const HOST_DEVICE_KEY = 'snapriddle:host-device';
const SEEN_STALE_MS = 12000; // player heartbeat older than this → "reconnecting"
const MAX_PLAYERS = 8;
/** free hint tokens per player when the host has not chosen otherwise */
const DEFAULT_HINT_TOKENS = 2;
/** 💡 A hint's cost is realized as 50 % of the solve award
 *  (applyEvaluation halves it) - the old flat −100 up-front charge is gone. */
const HINT_SOLVE_PENALTY = 0.5;
/** 💡 The web forwards at most ONE hint per this window (the board
 *  enforces the same gap for the physical button). A held/bouncing long-
 *  press used to queue a second hint_request while the first was still
 *  being generated + spoken, and the room heard two hints back to back. */
const HINT_MIN_GAP_MS = 10000;
/** 🔍 Host Check is highlighted from this many consecutive unclear
 *  verdicts on the same riddle (bad light rarely fixes itself on a retake -
 *  one field turn took 7 retakes). */
const HOST_CHECK_SUGGEST_AFTER = 2;
/** 🗣 When the BOARD owns a phase line (it was written to the cmd
 *  queue), the banner scheduler waits this much LONGER than the speech
 *  estimate before falling back to fixed timings. The board legitimately
 *  sits frozen inside a Gemini call (12 s per attempt) right when the
 *  banners play - the estimate+grace fallback used to fire mid-block and
 *  the screens flashed ahead of the room speaker. */
const BOARD_LINE_PATIENCE_MS = 12000;
const BOARD_LINE_PATIENCE_OFFLINE_MS = 4000;
/** 🗣 The board echoes hardware_session/tts_start when a line's
 *  audio actually begins. A board-owned line that has NOT started yet is
 *  still queued behind earlier lines on the speaker, so the estimate
 *  fallback waits for the start echo - capped at this long after the line
 *  was queued, so a lost echo can never hang the game. */
const BOARD_QUEUE_MAX_MS = 45000;

type SpokenGate = { key: string; id: number; done: boolean; board?: boolean; startedAt?: number };

/** 🗣 Absolute time (ms) at which the speech-gate fallback may fire
 *  for a board-owned line, anchored on the board's tts_start echo instead of
 *  the moment the line was queued (queued lines used to let the turn clock
 *  start before the riddle was even spoken). null → the caller keeps its
 *  queue-time formula (offline board, browser voice). */
function boardFallbackAt(
  gate: SpokenGate | null,
  key: string,
  estMs: number,
  startEchoSupported: boolean,
  boardAlive: boolean,
): number | null {
  if (!gate || gate.key !== key || gate.done || !gate.board) return null;
  if (!startEchoSupported || !boardAlive) return null;
  if (gate.startedAt) return gate.startedAt + estMs + SPEECH_GRACE_MS;
  return gate.id + BOARD_QUEUE_MAX_MS + estMs;
}
/** ⏱ The hint pause auto-resumes after this long even if the
 *  board's tts_done echo never arrives (generation + speech worst case). */
const HINT_PAUSE_MAX_MS = 45000;
/** ⏱ A Countdown Capture window auto-resumes the clock this long
 *  after its end even if no capture followed (dead board / closed tab). */
const COUNTDOWN_SAFETY_MS = 6000;
/** 🗣 announce() skips a byte-identical line spoken within this
 *  window (the duplicated "Riddle for …" double-fire seen in testing). */
const ANNOUNCE_DEDUPE_MS = 8000;
/* Demo judging split:
   ~50 % pass / 15 % unclear / 35 % fail keeps demo streaks alive while
   still showing fails and the retake flow. */
const DEMO_PASS_RATE = 0.5;
const DEMO_UNCLEAR_SHARE = 0.15;
/* 75 s (not 30 s): a hidden host tab is timer-throttled by Chrome - after
   ~5 min backgrounded, intervals only fire once per minute. A 30 s window
   let a foreground player's reaper delete the live room out from under a
   merely-backgrounded host. 75 s covers both throttle stages while still
   cleaning crashed-host zombies within ~1.5 min. */
const REAP_STALE_MS = 75000; // rooms without a host heartbeat this long get reaped
const MOMENT_W = 320; // Photo Moments thumbnail size (kept small for RTDB)
const MOMENT_H = 180;

/**
 * Rough speech-duration estimate so banner phases outlast the Voice Master
 * line instead of talking over it (Edge TTS ≈ 155 wpm at speed 1.0, plus
 * lead-in/tail padding). The ESP32 barges a new line over the old one, so
 * the ONLY way both screens and speaker stay in sync is giving each phase
 * at least as long as its spoken line takes.
 */
export function estimateSpeechMs(text: string, speed = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return Math.round((900 + words * 390) / Math.max(0.5, Math.min(2, speed)));
}

/** 🔌 Shared freshness rule for the firmware heartbeat. Busy boards
 *  (Gemini call in progress) get an extended grace window before the UI
 *  calls them offline - this is what stops the mid-turn "firmware offline"
 *  flap and the mid-turn laptop-voice fallback. */
function espAlive(s: HwEspStatus | null | undefined): HwEspStatus | null {
  if (!s || !s.ts) return null;
  const age = Date.now() - s.ts;
  if (age < ESP_ALIVE_MS) return s;
  if (s.gen === 'judge' && age < ESP_JUDGE_ALIVE_MS) return s;
  if (s.gen && age < ESP_BUSY_ALIVE_MS) return s;
  return null;
}

/**
 * The Voice Master line for the current banner phase - the single source of
 * truth used by BOTH the announcer (phase FX effect) and the phase scheduler
 * (which now stretches each phase to fit its spoken line).
 */
function phaseLine(r: Room): string {
  const activeName = r.active_player_id
    ? (r.players?.[r.active_player_id]?.name ?? null)
    : null;
  switch (r.state) {
    case 'INTRO':
      // ROUND_FLASH is the canonical round announcement ("[Bonus
      // round! …] Round X of Y starting!"). INTRO used to repeat the round
      // number 5 s earlier - the doubled "turn announce" the room kept
      // hearing back to back.
      // Owner wording: the welcome now explains the game itself.
      return r.current_round > 1
        ? 'Here comes the next round!'
        // "visual proof" → "proof" (proofs are not only visual).
        : `Welcome to ${r.game_name}! Listen to the riddle and show your proof to the camera before time runs out. Get Ready!`;
    case 'ROUND_FLASH':
      return `${
        r.special_round_type === 'NONE'
          ? ''
          : r.special_round_type === 'BONUS'
            ? 'Bonus round! Every correct solve earns an extra riddle! '
            : 'Double or doom round! '
      }Round ${r.current_round} of ${r.num_rounds} starting!`;
    case 'CALLOUT':
      return `${activeName ?? 'Player'}, step up to the camera!`;
    case 'ACTIVE_TURN':
      // New riddle lead-in (the riddle-arrival announce
      // below must stay byte-identical for the dedupe window).
      return r.current_riddle ? `${activeName ?? 'player'}, here is your riddle: ${r.current_riddle.text}` : '';
    case 'EVALUATING':
      // Owner wording (also updated on the board's local shutter line).
      return 'Photo captured! Let\'s see if you got it right...';
    default:
      return '';
  }
}

/**
 * Downscale a full camera frame into a small JPEG data URL for the
 * Photo Moments gallery. Accepts a canvas (mock feed), an image blob
 * (real ESP32 /capture JPEG) or a data URL string.
 * Returns null when capture is impossible.
 */
async function makeMomentPhoto(source: HTMLCanvasElement | Blob | string): Promise<string | null> {
  try {
    const img = new Image();
    if (source instanceof Blob) {
      const url = URL.createObjectURL(source);
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('decode failed'));
          img.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } else if (typeof source === 'string') {
      img.src = source;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
      });
    } else {
      img.src = source.toDataURL('image/png');
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
      });
    }
    const out = document.createElement('canvas');
    out.width = MOMENT_W;
    out.height = MOMENT_H;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    /* cover-crop the source into 16:9 so real ESP32 sensors (4:3) look right */
    const sw = img.width;
    const sh = img.width * (MOMENT_H / MOMENT_W);
    const sy = Math.max(0, (img.height - sh) / 2);
    ctx.drawImage(img, 0, sy, sw, Math.min(sh, img.height), 0, 0, MOMENT_W, MOMENT_H);
    return out.toDataURL('image/jpeg', 0.55);
  } catch {
    return null;
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

function emptyStats(): Player['stats'] {
  return {
    solves: 0,
    fails: 0,
    timeouts: 0,
    hard_solves: 0,
    hints_used: 0,
    doom_survives: 0,
    best_time_sec: null,
  };
}

function burstConfetti() {
  confetti({
    particleCount: 90,
    spread: 78,
    origin: { y: 0.62 },
    colors: ['#10B981', '#F59E0B', '#EAB308'],
  });
}

function emptyPlayer(
  name: string,
  tier: Player['tier'],
  colorIdx: number,
  isBot: boolean,
  joinedAt: number,
  hintTokens: number = DEFAULT_HINT_TOKENS,
): Player {
  return {
    name,
    score: 0,
    tier,
    hint_tokens: Math.max(0, Math.min(3, hintTokens)),
    streak: 0,
    fail_streak: 0,
    current_difficulty: tierStartDifficulty(tier),
    is_bot: isBot,
    joined_at: joinedAt,
    badge: '⭐ New Challenger',
    color: playerColor(colorIdx),
    last_seen: joinedAt,
    dda_block_solved: 0, // T12 DDA 2-round blocks
    dda_block_total: 0,
    stats: emptyStats(),
  };
}

/* ──────────────────────────────────────────────────────────────────────── */

export default function SnapRiddleApp() {
  /* ── core state ─────────────────────────────────────────────────────── */
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<HardwareSettings>(() => ({
    ...loadSettings(),
    theme: getInitialTheme(),
  }));
  const [session, setSession] = useState<LocalSession | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [hw, setHw] = useState<HardwareSession | null>(null);
  const [viewIntent, setViewIntent] = useState<'host' | 'player' | null>(null);
  const [initialPin, setInitialPin] = useState('');

  /* ── ui state ───────────────────────────────────────────────────────── */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [voiceLine, setVoiceLine] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [localTimeRemaining, setLocalTimeRemaining] = useState(0);
  const [frozenUrl, setFrozenUrl] = useState<string | null>(null);
  const [snapSeq, setSnapSeq] = useState(0);
  /** 🔌 ESP32 firmware liveness (hardware_session/esp, 30 s freshness window).
   *  Its heartbeat also carries the board IP - the camera address is fully
   *  automatic (no more manual IP fields anywhere in the UI). */
  const [espStatus, setEspStatus] = useState<HwEspStatus | null>(null);
  /** ☁️ Firebase reachability - 'error' swaps every screen for the
   *  "Can't reach game services" retry screen. */
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'online' | 'error'>('connecting');

  /* ── refs ───────────────────────────────────────────────────────────── */
  const sessionRef = useRef<LocalSession | null>(null);
  const roomRef = useRef<Room | null>(null);
  const settingsRef = useRef<HardwareSettings>(settings);
  const deadlineRef = useRef<number | null>(null);
  const deadlineTurnRef = useRef<number | null>(null);
  const lastCaptureRef = useRef(0);
  const lastHintRef = useRef(0);
  const phaseFxRef = useRef<string | null>(null);
  /** The riddle-arrival announce's own once-per-riddle guard. It
   *  used to share phaseFxRef with the phase FX effect, which overwrote it
   *  with `ACTIVE_TURN:<t0>` right after the riddle was announced; the next
   *  room update re-announced the riddle, the dedupe branch caught it and
   *  released the speech gate - the turn clock armed ~1 s after the riddle
   *  was queued instead of after it was spoken. */
  const riddleFxRef = useRef<string | null>(null);
  const judgedPhaseRef = useRef<string | null>(null);
  const closedTimerRef = useRef<number | null>(null);
  const voiceHideRef = useRef<number | null>(null);
  const lastTickSecRef = useRef(0);
  /** raw frame source captured at snap time, consumed by the next evaluation */
  const pendingMomentRef = useRef<HTMLCanvasElement | Blob | string | null>(null);
  /** 🔍 The latest UNCLEAR proof frame: a Host Check verdict turns it
   *  into the turn's polaroid (unclear verdicts never store a moment). */
  const unclearFrameRef = useRef<HTMLCanvasElement | Blob | string | null>(null);
  /** 🔍 Consecutive unclear verdicts on one riddle (Host Check hint) */
  const unclearStreakRef = useRef<{ key: string; n: number }>({ key: '', n: 0 });
  const [unclearStreak, setUnclearStreak] = useState(0);
  /** Continue is mid-advance (waiting for the voice to finish) */
  const continueBusyRef = useRef(false);
  const [continueBusy, setContinueBusy] = useState(false);
  /** pending 🔥 3-streak hype line, fired after the evaluation DB commit */
  const streakMilestoneRef = useRef<string | null>(null);
  /** last processed 💬 caption request ts (dedup guard) */
  const lastCaptionRef = useRef(0);
  /** host-side lobby presence memory: id → name (drives join/leave chimes) */
  const knownPlayersRef = useRef<Map<string, string> | null>(null);
  /** 🤖 ESP32-judge wait state - keyed by phase to survive StrictMode remounts */
  const espJudgePhaseRef = useRef<number | null>(null);
  const espJudgeCleanupRef = useRef<(() => void) | null>(null);
  /** 🎲 riddle_req bookkeeping - req_id we last asked the board for.
   *  The self-heal REUSES this id (idempotent rewrite) instead of
   *  minting a new one - new ids every few seconds stacked parallel Gemini
   *  generations and swapped the riddle text mid-turn. */
  const lastReqIdRef = useRef(0);
  const lastReqSentAtRef = useRef(0);
  const lastReqPlayerRef = useRef('');
  const lastReqReasonRef = useRef<'turn' | 'bonus'>('turn');
  /** The proof method the CURRENT request was minted with. A flip
   *  (same id re-sent with publish:"now") must re-send the SAME method -
   *  re-rolling here used to hand the board a request whose proof no longer
   *  matched the riddle it had already generated. */
  const lastReqProofRef = useRef('');
  /** anti-streak memory: the last two proof methods this room has
   *  seen, so a fresh roll can never land the same method three turns in a
   *  row (the "mostly sketches in one game" feeling). Per room, reset on
   *  create/rematch/exit. */
  const lastProofsRef = useRef<{ pin: string; a: string; b: string } | null>(null);
  /** Freshest DDA difficulty per player (set by applyEvaluation the
   *  moment it commits). Riddle prefetches read through this so the bump
   *  reaches the very next mint even when the DB snapshot has not
   *  round-tripped yet - the reason every riddle stayed "Easy" in the field
   *  log. Keyed by player id; reset with the match. */
  const ddaDiffRef = useRef<Map<string, Player['current_difficulty']>>(new Map());
  /** Ts of the last hint the host forwarded to the board (web-side
   *  one-hint-per-window guard, mirrors the board's HINT_MIN_GAP_MS). */
  const lastHintForwardRef = useRef(0);
  /** The countdown effect saw this turn PAUSED on its previous run;
   *  on the next unpaused run the deadline MUST re-anchor from the frozen DB
   *  remaining (an absolute deadline silently charged every paused second to
   *  the player: the timer once dropped 30 s at once). */
  const timerWasPausedRef = useRef(false);
  /** Epoch ms when the CURRENT req id was first MINTED. The 30 s
   *  self-heal re-sends the same id (idempotent); if a full minute passes
   *  with no matching riddle AND the board is not generating, the request
   *  itself is dead (lost write / board latch) and a fresh id is minted -
   *  a new req_id re-arms the board unconditionally. */
  const lastReqArmedAtRef = useRef(0);
  /** The request behind the currently STAGED next riddle
   *  (publish:"hold"). Kept separate from lastReq* so a bonus mini-turn's
   *  own request can never orphan the staged main riddle of the turn after
   *  it - the exact scenario that deadlocked (bonus unlock cleared
   *  current_riddle, the board's done-latch never republished).
   *  Carries the room PIN: a staged record from a PREVIOUS room
   *  (lobby exited → new game created) is dead and must never block the
   *  new room's lobby prefetch (a third room once never got a riddle). */
  const stagedReqRef = useRef<{ reqId: number; player: string; reason: 'turn' | 'bonus'; pin: string } | null>(null);
  /** Object URL of the EXACT snap frame (same blob the photo
   *  moment stores). The frozen feed shows this, so what the judge saw is
   *  what the TV shows - and it stays on screen through the results. */
  const frozenObjRef = useRef<string | null>(null);
  /** Monotonic snap token; the async /capture blob swap only
   *  applies if no newer snap/retake started meanwhile. */
  const snapTokenRef = useRef(0);
  /** 🔌 last time the firmware heartbeat was FRESH - the laptop voice stays
   *  silent for BOARD_VOICE_GRACE_MS after this, even if a heartbeat stalls */
  const lastEspAliveAtRef = useRef(0);
  /** 🗺 page-mount time - room phases older than this are history and are
   *  never re-announced (stops stale "game over" lines on refresh/remount) */
  const appMountAtRef = useRef(Date.now());
  /** 📸 camera IP - auto-discovered from the board heartbeat */
  const cameraIpRef = useRef('');
  /* 🗣️ TTS↔screen sync - which spoken line gates the current banner phase.
   *  `board` marks a line the BOARD owns (it was written to the
   *  cmd queue): the schedulers give those lines extra patience before
   *  falling back to estimate timings, because the board's poller may
   *  legitimately sit frozen inside a Gemini call right now. */
  const phaseSpokenRef = useRef<SpokenGate | null>(null);
  /** The board has echoed tts_start at least once */
  const ttsStartSeenRef = useRef(false);
  const lastAnnounceIdRef = useRef(0);
  /** Announce dedupe: text + timestamp of the last line actually sent */
  const lastAnnounceTextRef = useRef('');
  const lastAnnounceTextAtRef = useRef(0);
  /** 💡 The hint pause: id of the spoken hint line we wait for
   *  (board echoes tts_done with the hint_req id) + when the pause began. */
  const hintPauseRef = useRef<{ lineId: number; startedAt: number } | null>(null);
  /** ⏱ Safety timer ids for the auto-pauses (hint / countdown) */
  const hintSafetyTimerRef = useRef<number | null>(null);
  const countdownSafetyTimerRef = useRef<number | null>(null);
  /** ⏱ Last countdown node ts consumed (dedupe across re-renders) */
  const lastCountdownTsRef = useRef(0);
  /** cmd-queue writes since the last trim (board-offline hygiene) */
  const cmdqWrittenRef = useRef(0);
  /** bumped whenever the pending phase line finishes → wakes the schedulers */
  const [speechDoneTick, setSpeechDoneTick] = useState(0);
  /** Newest tts_done id echoed by the board (monotonic). Powers
   *  waitForBoardSpeech: the results→next-phase screen flip waits for the
   *  room speaker instead of flashing ahead of the queued lines. */
  const lastTtsDoneIdRef = useRef(0);
  /** one-shot: the overrule path announces its own dedicated
   *  line; the ROUND_RESULTS FX must not ALSO announce "Correct! …"
   *  seconds later (that produced a double line after an overrule). */
  const suppressPassAnnounceRef = useRef(false);
  /** heartbeat mirror for announce() - decides whether the BOARD is the voice */
  const espStatusRef = useRef<HwEspStatus | null>(null);
  const localVoiceDoneTimerRef = useRef<number | null>(null);

  useEffect(() => {
    espStatusRef.current = espStatus;
  }, [espStatus]);

  /** The pending phase line finished (board tts_done echo, browser onend,
   *  or an immediate no-speech path). id ≥ spoken id keeps barged lines
   *  correct: a newer line ending implies the older one stopped too. */
  const markSpoken = useCallback((id: number) => {
    const p = phaseSpokenRef.current;
    if (!p || p.done) return;
    if (!id || id < p.id) return; // stale / serial line - not the one we wait for
    p.done = true;
    setSpeechDoneTick((t) => t + 1);
  }, []);

  /* speech-gated screen flips: resolve once the BOARD finished
     every line queued before this call (tts_done echo ≥ the newest announce
     id), or after maxMs. Ownership mirrors announce(): demo / laptop voice
     / muted resolve immediately; a dead board resolves via its grace window
     so the game never hard-hangs on the wait. Used by continueTurn so the
     ROUND_FLASH / CALLOUT banners appear when the speaker is done - not
     seconds before the sentence (the overrule-cascade field log). */
  const waitForBoardSpeech = useCallback(async (maxMs: number) => {
    const s = settingsRef.current;
    const demoRoom = Boolean(roomRef.current?.demo);
    const wantBoard = !demoRoom && s.esp_speaker && !s.muted;
    if (!wantBoard) return;
    if (!espStatusRef.current &&
        Date.now() - lastEspAliveAtRef.current > BOARD_VOICE_GRACE_MS) return;
    const target = lastAnnounceIdRef.current;
    if (!target || lastTtsDoneIdRef.current >= target) return;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await new Promise((res) => window.setTimeout(res, 150));
      if (lastTtsDoneIdRef.current >= target) return;
    }
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /* 🎚 keep the WebAudio master volume glued to the saved settings */
  useEffect(() => {
    setSfxVolume(settings.sfx_volume);
  }, [settings.sfx_volume]);

  /* ── voice master (board speaker first, speechSynthesis fallback) ─────
     syncKey: when given, this line GATES a banner phase / the turn clock -
     the caller (phase FX effect) passes `${state}:${phase_started_at}` and
     the schedulers wait for markSpoken() before advancing.
     opts:
       · priority  → cmd carries p:1 - the board barges current speech and
                     the offline queue (time-up / game-over sound NOW).
       · boardSpeaks → the BOARD says this line itself (e.g. the local
                     "Photo captured" line at the shutter) - the web only
                     shows the caption and never writes a duplicate cmd. */
  const announce = useCallback(
    (text: string, syncKey?: string, opts?: { priority?: boolean; boardSpeaks?: boolean }) => {
    setVoiceLine(text);
    if (voiceHideRef.current) window.clearTimeout(voiceHideRef.current);
    voiceHideRef.current = window.setTimeout(() => setVoiceLine(null), 6500);
    const s = settingsRef.current;
    const id = Date.now();
    const prevAnnounceId = lastAnnounceIdRef.current;
    lastAnnounceIdRef.current = id;
    const prevGate = phaseSpokenRef.current;
    if (syncKey) phaseSpokenRef.current = { key: syncKey, id, done: false };

    /* dedupe: the riddle-arrival effect and a phase re-fire could
       both announce the exact same line seconds apart (field log: the room
       heard "Riddle for ADE…" twice, the second cutting the first). A
       byte-identical line inside the dedupe window is caption-only: the
       speech gate for a new syncKey is released immediately so the banner
       scheduler never hangs waiting for a line that will never be spoken. */
    if (
      text === lastAnnounceTextRef.current &&
      Date.now() - lastAnnounceTextAtRef.current < ANNOUNCE_DEDUPE_MS
    ) {
      // A duplicate of the line that is STILL gating this same
      // phase keeps that gate: it must be released by the real speech end,
      // not by the duplicate (that released the turn clock mid-riddle).
      // A deduped line is never spoken, so it must not become the newest
      // announce id either (waitForBoardSpeech would wait for a ghost).
      lastAnnounceIdRef.current = prevAnnounceId;
      if (syncKey && prevGate && prevGate.key === syncKey && !prevGate.done) {
        phaseSpokenRef.current = prevGate;
      } else if (syncKey) {
        phaseSpokenRef.current = { key: syncKey, id, done: true };
        setSpeechDoneTick((t) => t + 1);
      }
      return;
    }
    lastAnnounceTextRef.current = text;
    lastAnnounceTextAtRef.current = Date.now();

    /* 🔊 hardware mode - the ESP32 room speaker is the Voice Master. The
       line rides hardware_session/cmd (newest-wins) and the board speaks
       it through the local edge-TTS relay, then echoes tts_done.
       Demo rooms have no board - the browser voice (or silence) only. */
    const demoRoom = Boolean(roomRef.current?.demo);
    const wantBoard = !demoRoom && s.esp_speaker && !s.muted;
    /* The board keeps "voice ownership" for a grace window after
       its last fresh heartbeat, so a transient Gemini stall can never hand
       the line to the laptop mid-turn (the "browser sound instead of the
       speaker" bug). */
    const boardVoiceAlive =
      Boolean(espStatusRef.current) ||
      Date.now() - lastEspAliveAtRef.current < BOARD_VOICE_GRACE_MS;
    const boardSpeaks = Boolean(opts?.boardSpeaks) && wantBoard && boardVoiceAlive;
    if (wantBoard && !boardSpeaks) {
      // "speak directly": try the fast LAN path first (POST
      // /speak on the board's control server - no Firebase round-trip, no
      // poll-cadence latency). Same direct-then-cloud-fallback shape as
      // pushSettingsToEsp32()/testConnection(): only write cmd/cmdq when
      // the direct call actually fails (board unreachable, mixed-content
      // block on an HTTPS host page, etc.), so the common case never
      // dispatches the SAME line through both paths. The board's own
      // claimCmdId() backstop (shared_state.h) still catches the rare case
      // where it does.
      const priority = Boolean(opts?.priority);
      const ip = cameraIpRef.current || settingsRef.current.esp32_ip;
      void (async () => {
        const wentDirect = await speakDirectToEsp32(ip, id, text, priority);
        if (wentDirect) return;

        // Every line ALSO lands in the cmd QUEUE (child keyed by the
        // line id). The single `cmd` slot is newest-wins: when the board's
        // poller sat frozen inside a long Gemini call, this announce burst
        // overwrote itself and middle lines were never spoken (the "skipped
        // straight to Round 1" bug, seen twice in testing). Queue
        // children each get their own slot, so nothing can overwrite anything;
        // the board speaks every entry in order; the legacy `cmd` mirror
        // only ever holds the newest line.
        // Hygiene: if the board is gone for a very long time the queue would
        // grow unbounded - wipe it at 24 queued lines (the floor logic makes
        // re-spoken old lines impossible, and boards delete what they speak).
        if (cmdqWrittenRef.current >= 24) {
          // Trim ONLY while the board is truly gone: the old counter
          // fired mid-game and its cmdq:null wiped queued-but-unspoken lines
          // (a missing banner line). An ALIVE board deletes
          // every child it speaks, so the queue cannot grow without bound; a
          // dead board's backlog is only wiped after a full offline minute.
          if (!espStatusRef.current && Date.now() - lastEspAliveAtRef.current > 60000) {
            cmdqWrittenRef.current = 0;
            void sync.update('hardware_session', { cmdq: null }).catch(() => undefined);
          }
        }
        cmdqWrittenRef.current += 1;
        const prio = priority ? { p: 1 } : {};
        // `cmdq: {[id]: line}` would patch the WHOLE cmdq node
        // (an RTDB update replaces whole subtrees), wiping every line already
        // queued behind it while the board sat frozen inside a Gemini call -
        // the exact scenario the queue was built for. Casualties were the
        // results line vs streak hype, the overrule + points pair, the bonus
        // unlock vs callout and the game-over burst. Child-path keys
        // (`cmdq/<id>`) merge PER CHILD so concurrent announces coexist; the
        // legacy `cmd` mirror stays newest-wins for old-board compat.
        void sync
          .update('hardware_session', {
            cmd: { id, say: text, ...prio },
            [`cmdq/${String(id)}`]: { id, say: text, ...prio },
          })
          .catch(() => undefined);
      })();
    }
    /* the board said (or is about to say) this line itself - caption only */
    if (boardSpeaks) {
      markSpoken(id);
      return;
    }
    /* the browser voice only backs the board up when it is NOT alive and
       speaking - otherwise TV laptop + room speaker would talk over each
       other. Fresh firmware heartbeat (or within the grace window) ⇒ the
       board owns speech and the laptop stays silent. */
    const boardHasVoice = wantBoard && boardVoiceAlive;
    if (boardHasVoice) {
      // Flag the gate as BOARD-OWNED so the banner schedulers wait
      // for the tts_done echo with extra patience instead of falling back to
      // fixed timings while the board is still thinking (otherwise the web
      // flashes ahead of the speaker).
      const gate = phaseSpokenRef.current;
      if (gate && gate.id === id) gate.board = true;
      return; // tts_done subscription will markSpoken
    }

    if (s.muted || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      markSpoken(id); // nothing audible will play - release the gate at once
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = s.voice_speed;
      u.volume = Math.min(1, s.voice_volume / 21);
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => v.name.toLowerCase().includes(s.voice_profile.toLowerCase())) ??
        voices.find((v) => v.lang.startsWith('en'));
      if (preferred) u.voice = preferred;
      /* the line itself now reports completion - exact, not estimated. */
      u.onend = () => {
        if (lastAnnounceIdRef.current === id) markSpoken(id);
      };
      u.onerror = () => {
        if (lastAnnounceIdRef.current === id) markSpoken(id);
      };
      window.speechSynthesis.speak(u);
      /* some browsers never fire onend (tab throttling, crashed voices) -
         a generous watchdog keeps the game moving on the estimate. */
      if (localVoiceDoneTimerRef.current) window.clearTimeout(localVoiceDoneTimerRef.current);
      localVoiceDoneTimerRef.current = window.setTimeout(
        () => markSpoken(id),
        estimateSpeechMs(text, s.voice_speed) + 4000,
      );
    } catch {
      markSpoken(id); // speech unsupported - caption still shows
    }
    },
    [markSpoken],
  );

  /* ── session persistence ────────────────────────────────────────────── */
  /* Release the frozen proof frame (revoke the object URL so the
     JPEG blob is actually freed). Called when the game moves past the
     results screen - the photo itself already lives in the moments gallery. */
  const clearFrozen = useCallback(() => {
    if (frozenObjRef.current) {
      try {
        URL.revokeObjectURL(frozenObjRef.current);
      } catch {
        /* already gone */
      }
      frozenObjRef.current = null;
    }
    setFrozenUrl(null);
  }, []);

  const persistSession = useCallback((s: LocalSession | null) => {
    try {
      if (s) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setRoom(null);
    persistSession(null);
    deadlineRef.current = null;
    deadlineTurnRef.current = null;
    judgedPhaseRef.current = null;
    clearFrozen();
  }, [clearFrozen, persistSession]);

  /* ── boot ───────────────────────────────────────────────────────────── */
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    applyTheme(s.theme);
    sync.start();
    const unsubHw = sync.subscribe('hardware_session', (v) => setHw((v as HardwareSession) ?? null));
    const unsubEsp = sync.subscribe('hardware_session/esp', (v) => {
      const s = (v as HwEspStatus | null) ?? null;
      // gen-aware freshness (a busy board is "thinking", not offline)
      const live = espAlive(s);
      if (s && s.ts && Date.now() - s.ts < ESP_ALIVE_MS) {
        lastEspAliveAtRef.current = Date.now();
      }
      setEspStatus(live);
    });
    /* ☁️ Firebase-only sync: when the database can't be reached the
       whole app swaps to the retry screen - there is no local fallback. */
    const unsubSync = sync.onSyncStatus(setSyncStatus);
    /* 🗣️ board echoes "line finished" → release the speech gate so banners
       and the turn clock move WITH the room speaker instead of estimates.
       Also releases the HINT pause: the hint line carries the
       hint_req id, so its tts_done means "the room heard the hint" and the
       turn clock may resume. */
    const unsubDone = sync.subscribe('hardware_session/tts_done', (v) => {
      const d = v as { id?: number; ts?: number } | null;
      if (d && typeof d.id === 'number') {
        markSpoken(d.id);
        // Feed waitForBoardSpeech (monotonic)
        if (d.id > lastTtsDoneIdRef.current) lastTtsDoneIdRef.current = d.id;
        const hp = hintPauseRef.current;
        if (hp && d.id >= hp.lineId) {
          hintPauseRef.current = null;
          if (hintSafetyTimerRef.current) {
            window.clearTimeout(hintSafetyTimerRef.current);
            hintSafetyTimerRef.current = null;
          }
          const sess = sessionRef.current;
          const r = roomRef.current;
          if (sess?.role === 'host' && sess.pin && r?.paused?.reason === 'hint') {
            const rem = Math.max(0, r.turn_timer?.time_remaining ?? 0);
            void sync
              .update(`rooms/${sess.pin}`, {
                paused: null,
                turn_timer: { time_remaining: rem, is_active: true },
              })
              .catch(() => undefined);
          }
        }
      }
    });
    /* 🗣️ Board echoes "line STARTED" (first decoded audio). The
       gate remembers when its line really began, so every estimate fallback
       counts from real speech start instead of from the queue write. A
       newer line starting means ours already went (spoken or barged). */
    const unsubStart = sync.subscribe('hardware_session/tts_start', (v) => {
      const d = v as { id?: number; ts?: number } | null;
      if (!d || typeof d.id !== 'number') return;
      ttsStartSeenRef.current = true;
      const p = phaseSpokenRef.current;
      if (p && !p.done && !p.startedAt && d.id >= p.id) {
        p.startedAt = Date.now();
        setSpeechDoneTick((t) => t + 1);
      }
    });

    // Rehydrate a same-tab session (host or player refresh).
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LocalSession;
        setSession(parsed);
        sessionRef.current = parsed;
        if (!window.localStorage.getItem(HOST_DEVICE_KEY) && parsed.hostDeviceId) {
          window.localStorage.setItem(HOST_DEVICE_KEY, parsed.hostDeviceId);
        }
      }
    } catch {
      /* ignore */
    }

    // Deep link: /?pin=1234 → open the player join screen prefilled.
    try {
      const url = new URL(window.location.href);
      const p = url.searchParams.get('pin');
      if (p && /^\d{4}$/.test(p)) {
        setInitialPin(p);
        setViewIntent('player');
      }
    } catch {
      /* ignore */
    }

    setReady(true);
    return () => {
      unsubHw();
      unsubEsp();
      unsubSync();
      unsubDone();
      unsubStart();
      if (localVoiceDoneTimerRef.current) window.clearTimeout(localVoiceDoneTimerRef.current);
    };
  }, [markSpoken]);

  /* 🔌 decay the ESP status chip when the firmware heartbeat goes stale
     (gen-aware: a busy board gets the extended grace window) */
  useEffect(() => {
    if (!espStatus) return;
    const iv = window.setInterval(() => {
      setEspStatus((cur) => espAlive(cur));
    }, 5000);
    return () => window.clearInterval(iv);
  }, [espStatus?.ts]);

  /* 📸 The camera IP is discovered, never typed: the firmware heartbeat
     (hardware_session/esp) reports it every 10 s. Until the first heartbeat
     lands the camera panel shows "Waiting for camera…". */
  useEffect(() => {
    if (espStatus?.ip) cameraIpRef.current = espStatus.ip;
  }, [espStatus?.ip]);

  /* ── room subscription (host & player) ──────────────────────────────── */
  const pin = session?.pin ?? null;
  useEffect(() => {
    if (!pin) return;
    const unsub = sync.subscribe(`rooms/${pin}`, (v) => {
      // Only well-formed rooms (carrying the denormalized pin) count. Zombie
      // leftovers created by heartbeat auto-parenting (players/{id}/last_seen
      // under a deleted room) are treated as "room gone".
      const val =
        v && typeof v === 'object' && (v as { pin?: unknown }).pin ? (v as Room) : null;
      if (val) {
        if (closedTimerRef.current) {
          window.clearTimeout(closedTimerRef.current);
          closedTimerRef.current = null;
        }
        // Host identity guard: only the owning device may drive the FSM.
        const sess = sessionRef.current;
        if (sess?.role === 'host' && val.host_device_id && val.host_device_id !== sess.hostDeviceId) {
          toast.error('Another host device already owns this room.');
          clearSession();
          return;
        }
        setRoom(val);
      } else if (!closedTimerRef.current) {
        // Room null - either still connecting, or the host deleted it.
        // Confirm against the DB before declaring the room gone (this also
        // fires for sessions that already saw the room: host exit / reaper).
        closedTimerRef.current = window.setTimeout(async () => {
          closedTimerRef.current = null;
          const check = await sync.get(`rooms/${pin}`);
          if (check == null) {
            const sess = sessionRef.current;
            toast.error(sess?.role === 'host' ? 'Your room is no longer available.' : 'Room not found — the host may have closed it.');
            clearSession();
          }
        }, 2500);
      }
    });
    return () => {
      unsub();
      if (closedTimerRef.current) {
        window.clearTimeout(closedTimerRef.current);
        closedTimerRef.current = null;
      }
    };
  }, [pin, clearSession]);

  /* ── host heartbeat (hardware lock + room liveness) ─────────────────── */
  useEffect(() => {
    if (session?.role !== 'host' || !session.pin) return;
    const beat = () => {
      const r = roomRef.current;
      if (!r) return;
      // Room liveness - keeps the stale-room reaper away while the host tab lives.
      void sync.update(`rooms/${session.pin}`, { hb: Date.now() }).catch(() => undefined);
      // Stop holding the hardware lock once the match is over.
      if (r.state === 'GAME_OVER') return;
      void sync.update('hardware_session', {
        active_room: session.pin,
        last_heartbeat: Date.now(),
      });
    };
    beat();
    const iv = window.setInterval(beat, HEARTBEAT_MS);
    /* a re-focused host tab may have been timer-throttled while hidden -
       beat immediately on visibility so the reaper never races a return */
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.role, session?.pin]);

  /* ── 🔌 ESP32 game mirror (host, real rooms) ──────────────────────
     Publishes hardware_session/hw - the compact state the firmware polls -
     plus hardware_session/esp_settings (camera+voice payload, so settings
     still reach the board even when browser→ESP HTTP is blocked).
     1 Hz refresh keeps time_left and the judge trigger fresh; every publish
     is idempotent from the ESP's viewpoint. (The B3 surgery removed the
     old preview_req flag - the board no longer uploads cloud snapshots.) */
  useEffect(() => {
    if (session?.role !== 'host' || !session.pin || !room || room.demo) return;
    let alive = true;
    const publish = () => {
      if (!alive) return;
      const r = roomRef.current;
      if (!r || r.demo) return;
      const mirror: HwMirror = {
        room: r.pin,
        state: r.state,
        seq: Date.now(),
        // SECONDS, not ms - the ESP32 parses this into a uint32; epoch-ms
        // overflows int32 and ArduinoJson's "| 0" fallback silently yields 0
        // (the "board never judges" bug).
        judge_phase: r.state === 'EVALUATING' ? Math.floor(r.phase_started_at / 1000) : 0,
        player_id: r.active_player_id ?? null,
        player: r.active_player_id ? (r.players?.[r.active_player_id]?.name ?? null) : null,
        round: r.current_round,
        rounds: r.num_rounds,
        riddle: r.current_riddle?.text ?? '',
        target: r.current_riddle?.target_keyword ?? '',
        difficulty: r.current_riddle?.difficulty ?? '',
        theme: r.current_riddle?.theme ?? '',
        // Judge context: the proof method + the host's paper pivot
        proof: r.current_riddle?.proof_method ?? '',
        allow_paper: Boolean(r.paper_mode),
        countdown: r.countdown_secs ?? 0,
        time_limit: r.current_riddle?.time_limit_sec ?? 0,
        time_left: Math.max(0, Math.round(r.turn_timer?.time_remaining ?? 0)),
        timer_running: Boolean(r.turn_timer?.is_active) && !r.paused,
        paused: Boolean(r.paused),
        special: r.special_round_type ?? 'NONE',
        unclear: r.state === 'ROUND_RESULTS' && Boolean(r.last_evaluation?.error),
        // non-empty → the board ignores every button press
        lock: buttonLock(r) ?? '',
      };
      const evaluating = r.state === 'EVALUATING';
      // force_fallback lives under hardware_session/esp_settings too (the
      // Settings drawer's own toggle writes it directly - see
      // SettingsDrawer.tsx), but it is NOT part of HardwareSettings/
      // esp32SettingsPayload(): it's a board-side-only flag that's meant to
      // "live on the board until switched off", independent of this host's
      // local camera/voice settings. Writing `esp_settings: {...}` here
      // REPLACES the whole node every second, silently dropping
      // force_fallback moments after the user turns it on - the fix is the
      // same per-child path-key merge cmdq/{id} already uses: each field
      // lands at its own `esp_settings/<field>` path, leaving any sibling
      // (force_fallback included) untouched.
      const espSettingsPatch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(esp32SettingsPayload(settingsRef.current))) {
        espSettingsPatch[`esp_settings/${k}`] = v;
      }
      void sync
        .update('hardware_session', {
          hw: mirror,
          ...espSettingsPatch,
          // explicit judge trigger - refreshed 1 Hz while EVALUATING, null
          // otherwise, so the board's pending request can never go stale
          judge_request: evaluating
            ? {
                phase: Math.floor(r.phase_started_at / 1000),
                riddle: r.current_riddle?.text ?? '',
                target: r.current_riddle?.target_keyword ?? '',
                proof: r.current_riddle?.proof_method ?? '',
                allow_paper: Boolean(r.paper_mode),
                ts: Date.now(),
              }
            : null,
        })
        .catch(() => undefined);
    };
    publish();
    const iv = window.setInterval(publish, 1000);
    return () => {
      alive = false;
      window.clearInterval(iv);
      // Going idle - tell the firmware the mirror is gone (the lock release
      // already cleared active_room; this is just extra hygiene). The
      // riddle/hint requests go too so the board's pumps go quiet.
      // force_fallback is deliberately NOT cleared here either - same
      // "lives on the board until switched off" intent, now actually
      // honored across a room exit/restart instead of only within one.
      void sync
        .update('hardware_session', {
          hw: null,
          'esp_settings/resolution': null,
          'esp_settings/quality': null,
          'esp_settings/flip_h': null,
          'esp_settings/flip_v': null,
          'esp_settings/brightness': null,
          'esp_settings/contrast': null,
          'esp_settings/awb': null,
          'esp_settings/awb_gain': null,
          'esp_settings/special_effect': null,
          'esp_settings/voice': null,
          'esp_settings/speed': null,
          'esp_settings/volume': null,
          judge_request: null,
          riddle_req: null,
          hint_req: null,
        })
        .catch(() => undefined);
    };
  }, [session?.role, session?.pin, room?.demo]);

  /* ── stale-room reaper (data hygiene for crashed/abandoned hosts) ───── */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const reap = async () => {
      try {
        const all = (await sync.get('rooms')) as Record<string, Room> | null;
        if (!all || cancelled) return;
        const now = Date.now();
        for (const [id, r] of Object.entries(all)) {
          if (!r || typeof r !== 'object') continue;
          // A room is alive only while its host keeps heartbeating. Zombie
          // leftovers (e.g. bare player-heartbeat paths without a pin field)
          // are treated as instantly stale and reaped.
          const last = r.hb ?? r.created_at ?? 0;
          const alive = Boolean(r.pin) && now - last < REAP_STALE_MS;
          if (alive) continue;
          if (sessionRef.current?.role === 'host' && sessionRef.current.pin === id) continue;
          await sync.remove(`rooms/${id}`).catch(() => undefined);
        }
      } catch {
        /* hygiene is best-effort - never block the app */
      }
    };
    void reap();
    const iv = window.setInterval(() => void reap(), 20000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [ready]);

  /* ── derived data ───────────────────────────────────────────────────── */
  const ranked = useMemo(() => rankPlayers(room?.players), [room?.players]);
  const activePlayer = useMemo(() => {
    if (!room?.active_player_id) return null;
    const p = room.players?.[room.active_player_id];
    return p ? { id: room.active_player_id, player: p } : null;
  }, [room]);
  const joinedPlayers = useMemo(
    () =>
      room?.players
        ? Object.entries(room.players)
            // Zombie heartbeat nodes (a kicked phone's last_seen
            // write used to recreate a nameless player entry) must never
            // reach the lobby/dashboard renderers - they are exactly what
            // crashed HostLobby with "cannot read charAt of undefined".
            .filter(([, player]) => Boolean(player) && typeof player === 'object' && typeof player.name === 'string')
            .map(([id, player]) => ({ id, player }))
            .sort((a, b) => a.player.joined_at - b.player.joined_at)
        : [],
    [room?.players],
  );
  const isHost = session?.role === 'host';
  const hardwareBusyPin = useMemo(() => {
    if (!hw?.active_room) return null;
    if (session?.role === 'host' && session.pin === hw.active_room) return null;
    if (Date.now() - (hw.last_heartbeat ?? 0) > HW_LOCK_STALE_MS) return null;
    return hw.active_room;
  }, [hw, session?.role, session?.pin]);
  /** Start gating: real matches need a live board heartbeat. The camera
   *  IP rides the same heartbeat - no IP is typed anywhere anymore. */
  const hardwareReady = Boolean(espStatus);
  /** 🎁 the CALLOUT banner switches to the bonus style for a bonus mini-turn */
  const bonusCallout =
    Boolean(room?.bonus_turn &&
      room.state === 'CALLOUT' &&
      room.bonus_turn.player_id === room.active_player_id);
  const bonusActive = bonusCallout;

  /* ── live event feed (host-written rolling ticker) ─────────────────── */
  const pushFeed = useCallback(async (pinLocal: string, text: string, tone: FeedEvent['tone']) => {
    try {
      const cur = (await sync.get(`rooms/${pinLocal}/feed`)) as FeedEvent[] | null;
      const arr = Array.isArray(cur) ? cur : [];
      const next = [...arr, { id: newId('f'), ts: Date.now(), text, tone }].slice(-8);
      await sync.set(`rooms/${pinLocal}/feed`, next);
    } catch {
      /* feed is cosmetic - never block the game loop */
    }
  }, []);

  /* ── 🎲 riddle generation requests (the board is the only source) ──
     The host never picks riddles anymore. It writes hardware_session/riddle_req
     and the board's Gemini call publishes rooms/{pin}/current_riddle with a
     matching req_id. Fired: at match start (first riddle), right after each
     judged turn (prefetch for the next player), and as a self-heal whenever
     a turn goes live without a matching riddle. The board retries forever,
     so the game shows "Preparing riddle…" until a riddle actually lands. */
  const writeRiddleReq = useCallback(
    async (
      reason: 'turn' | 'bonus',
      player: { id: string | null; name: string; difficulty: Player['current_difficulty'] } | null,
      reuseReqId = 0,
      publish: 'now' | 'hold' = 'now',
    ) => {
      const r = roomRef.current;
      if (!r || r.demo) return; // demo rooms draw from the local bank instead
      // reuseReqId > 0 re-sends the SAME request (idempotent): the
      // board retries forever on its own cadence, so the self-heal must never
      // mint fresh ids (that stacked parallel generations → the riddle text
      // changed several times per turn and never matched → never spoken).
      // publish:'hold' asks the board to stage the riddle into
      // rooms/{pin}/next_riddle (prefetch during results - never revealed
      // before Continue); 'now' publishes straight into current_riddle. The
      // same id can be re-sent with the OTHER publish value to flip the
      // target on the board without regenerating.
      const fresh = !reuseReqId;
      const reqId = reuseReqId || Date.now() + Math.floor(Math.random() * 500);
      lastReqIdRef.current = reqId;
      lastReqSentAtRef.current = Date.now();
      if (fresh) lastReqArmedAtRef.current = Date.now();
      lastReqPlayerRef.current = player?.name ?? '';
      lastReqReasonRef.current = reason;
      // Hold requests belong to the STAGED riddle, tracked apart so
      // a live-turn request (e.g. a bonus mini-turn) can't orphan them.
      // The staged record carries the room PIN (stale-room guard).
      if (publish === 'hold') {
        stagedReqRef.current = { reqId, player: player?.name ?? '', reason, pin: r.pin };
      } else if (!reuseReqId) {
        // A fresh BONUS live mint must NOT retire a staged
        // MAIN riddle for the same room. The staged record belongs to the
        // next MAIN turn; clearing it on a bonus mint orphaned the staged
        // riddle (stagedUsable=false after the bonus mini-turn → the staged
        // record was discarded and the riddle regenerated). A fresh
        // MAIN-turn mint (or any staged record for another room) still
        // retires it.
        const staged = stagedReqRef.current;
        if (
          !staged ||
          staged.pin !== r.pin ||
          !(reason === 'bonus' && staged.reason === 'turn')
        ) {
          stagedReqRef.current = null;
        }
      }
      // The ENVIRONMENT anchors the answer; the PROOF METHOD is
      // rolled in code from the playstyle distribution (fresh requests
      // only - a reused request keeps the board's original prompt).
      // A FLIP (reuseReqId > 0) re-sends the SAME method: re-rolling
      // it here used to hand the board a request whose proof no longer
      // matched the riddle it had already generated. Fresh mints roll with
      // an anti-streak so one method can never land three turns in a row.
      const envName =
        ENVIRONMENT_MAP[(r.environment ?? '') as keyof typeof ENVIRONMENT_MAP]?.name ??
        'Everyday Objects';
      let proof: string;
      if (reuseReqId && lastReqProofRef.current) {
        proof = lastReqProofRef.current;
      } else {
        const prev = lastProofsRef.current;
        let roll = pickProofMethod(r.playstyle ?? DEFAULT_PLAYSTYLE_ID);
        if (
          prev && prev.pin === r.pin &&
          prev.a === prev.b && PROOF_METHOD_NAMES[roll] === prev.b
        ) {
          const alt = pickProofMethod(r.playstyle ?? DEFAULT_PLAYSTYLE_ID);
          if (PROOF_METHOD_NAMES[alt] !== prev.b) roll = alt; // reroll once
        }
        proof = PROOF_METHOD_NAMES[roll];
        lastProofsRef.current = { pin: r.pin, a: prev?.pin === r.pin ? prev.b : proof, b: proof };
      }
      lastReqProofRef.current = proof;
      const excluded = (r.excluded_keywords ?? []).join(', ');
      await sync
        .update('hardware_session', {
          riddle_req: {
            req_id: reqId,
            reason,
            difficulty: player?.difficulty ?? 'Easy',
            environment: envName,
            excluded,
            proof,
            player_name: player?.name ?? '',
            publish,
            ts: Date.now(),
          },
        })
        .catch(() => undefined);
    },
    [],
  );

  /* 🎲 riddle-arrival + self-heal (real rooms): while a turn is live the
     riddle must exist and match the ONE request minted for this turn.
     The first self-heal re-sends the SAME req_id (idempotent -
     covers a lost DB write) and never mints while the board may still be
     generating. if a FULL MINUTE passes with no matching riddle
     and the board is NOT generating (esp.gen !== 'riddle'), the request
     itself is dead (lost write / board latch stuck behind a node the host
     cleared) - mint a FRESH id, which re-arms the board unconditionally.
     When the board publishes a matching riddle, the riddle line is
     announced (gated - the turn clock waits for the speech to end, exactly
     like banners). */
  useEffect(() => {
    if (!isHost || !room || room.demo || room.state !== 'ACTIVE_TURN') return;
    const riddle = room.current_riddle;
    const pending = lastReqIdRef.current !== 0 && riddle?.req_id !== lastReqIdRef.current;
    if (!riddle || (riddle.req_id != null && pending)) {
      // No riddle (or one from a superseded request) - heal politely.
      if (lastReqIdRef.current) {
        const activeId = room.active_player_id;
        const player = activeId ? room.players?.[activeId] : null;
        if (!player) return;
        const reason = room.bonus_turn ? 'bonus' : 'turn';
        const armedFor = Date.now() - lastReqArmedAtRef.current;
        // 60 s with no riddle and the board is not generating →
        // the outstanding request is dead. Mint a fresh id (new ids reset
        // the board's latch + bookkeeping unconditionally).
        if (armedFor > 60000 && espStatusRef.current?.gen !== 'riddle') {
          lastReqArmedAtRef.current = Date.now();
          stagedReqRef.current = null; // the staged record is obsolete too
          toast.info('Still no riddle — re-asking the camera board…');
          void writeRiddleReq(
            reason,
            {
              id: activeId,
              name: player.name,
              difficulty: player.current_difficulty,
            },
            0,
            'now',
          );
          return;
        }
        // 30 s - same-id idempotent re-send (lost-write cover).
        if (Date.now() - lastReqSentAtRef.current > 30000) {
          void writeRiddleReq(
            reason,
            {
              id: activeId,
              name: player.name,
              difficulty: player.current_difficulty,
            },
            lastReqIdRef.current,
          );
        }
      }
      return;
    }
    if (riddle.req_id == null) return; // demo-shaped riddle in a real room - ignore
    // Fresh riddle → announce it (once per RIDDLE - keys on the
    // riddle's own id (gem-<req_id>) instead of phase_started_at so a
    // staged→live republish of the SAME riddle can never re-announce it;
    // testing caught the double "Riddle for …" line 2.9 s apart).
    const key = `RIDDLE:${riddle.id}`;
    if (riddleFxRef.current === key) return;
    riddleFxRef.current = key;
    // A phase that began before this page loaded is history (page
    // refresh mid-turn): the room already heard this riddle. Show, don't say.
    if (room.phase_started_at < appMountAtRef.current - 2000) return;
    const activeName = room.active_player_id
      ? (room.players?.[room.active_player_id]?.name ?? null)
      : null;
    sfxTick(settingsRef.current.muted);
    // New riddle lead-in (byte-identical with phaseLine).
    announce(`${activeName ?? 'player'}, here is your riddle: ${riddle.text}`, `ACTIVE_TURN:${room.phase_started_at}`);
  }, [isHost, room, room?.state, room?.current_riddle?.req_id, room?.current_riddle?.text, announce, writeRiddleReq]);

  /* 🎲 LOBBY PREFETCH: the first riddle is the one generation that
     can never hide behind "prefetch during the previous turn", so mint it
     the moment the first player joins the lobby - their difficulty shapes
     the prompt, and the board generates while the room fills. The staged
     riddle lands in next_riddle (publish:"hold") where it is never rendered
     in the lobby; startMatch reuses it instead of re-minting.
     Costs one Gemini call even if the lobby is abandoned - the price of an
     instant first turn.
     The staged record is PIN-SCOPED: leaving a lobby and creating
     a new game used to inherit the previous room's staged record, silently
     suppressing the new room's prefetch AND startMatch's mint (the "3rd
     room never generated a riddle" field report). A staged record for a
     different PIN is dead - dropped on sight. */
  useEffect(() => {
    if (!isHost || !room || room.demo || room.state !== 'LOBBY') return;
    if (stagedReqRef.current && stagedReqRef.current.pin !== room.pin) {
      stagedReqRef.current = null; // stale record from a previous room
    }
    if (lastReqIdRef.current !== 0 && !stagedReqRef.current) {
      // request ids are global epoch-ms - a previous room's id is meaningless
      // here; forget it so startActiveTurn's keep/flip logic can't match it
      lastReqIdRef.current = 0;
      lastReqArmedAtRef.current = 0;
      lastReqPlayerRef.current = '';
    }
    if (stagedReqRef.current) return;               // already staged for THIS match
    const first = Object.entries(room.players ?? {})
      .filter(([, p]) => p && typeof p === 'object' && typeof p.name === 'string')
      .sort((a, b) => a[1].joined_at - b[1].joined_at)[0];
    if (!first) return;
    const [id, p] = first;
    void writeRiddleReq('turn', {
      id,
      name: p.name,
      difficulty: ddaDiffRef.current.get(id) ?? p.current_difficulty,
    }, 0, 'hold');
  }, [isHost, room, room?.state, room?.players, room?.pin, writeRiddleReq]);

  /* ── FSM transitions (host only) ────────────────────────────────────── */

  const startActiveTurn = useCallback(
    async (pinLocal: string, r: Room) => {
      const activeId = r.active_player_id;
      const player = activeId ? r.players?.[activeId] : null;
      if (!activeId || !player) {
        toast.error('Active player missing — skipping turn.');
        return;
      }
      lastCaptureRef.current =
        typeof r.capture_request === 'object' && r.capture_request
          ? (r.capture_request.ts ?? 0)
          : (r.capture_request ?? 0);
      /* ⏱️ the clock does NOT start here - it is armed by the effect below
         only after the riddle line has finished being spoken (or the sync
         fallback fires). Until then the UI shows the full limit frozen. */
      deadlineRef.current = null;
      deadlineTurnRef.current = null;
      if (r.demo) {
        // Demo rooms keep the local bank - no board, no Gemini generation.
        // Themes are gone from the game; the bank draws across ALL
        // of its riddles (the per-player theme filter died with categories).
        let riddle = pickRiddle({
          difficulty: player.current_difficulty,
          excluded: r.excluded_keywords ?? [],
        });
        if (!riddle) {
          riddle = pickRiddle({
            difficulty: player.current_difficulty,
            excluded: [],
          });
        }
        if (!riddle) {
          toast.error('The riddle bank is empty — cannot continue.');
          return;
        }
        const limit = TIME_LIMIT[player.current_difficulty];
        setLocalTimeRemaining(limit);
        await sync.update(`rooms/${pinLocal}`, {
          current_riddle: {
            id: riddle.id,
            text: riddle.text,
            proof_method: riddle.proof_method,
            difficulty: player.current_difficulty,
            time_limit_sec: limit,
            target_keyword: riddle.target_keyword,
            theme: riddle.theme,
          },
          turn_timer: { time_remaining: limit, is_active: false },
          turn_started_at: null,
          state: 'ACTIVE_TURN',
          phase_started_at: Date.now(),
          paused: null,
          paper_mode: null,
          countdown: null,
        });
      } else {
        // Real room: the board is the only riddle source. The UI shows
        // "Preparing riddle…" until the board publishes.
        setLocalTimeRemaining(0);
        const reason = r.bonus_turn ? 'bonus' : 'turn';
        const requestMatches =
          lastReqIdRef.current !== 0 &&
          lastReqPlayerRef.current === player.name &&
          lastReqReasonRef.current === reason;
        /* RIDDLE STAGING. Prefetches land in rooms/{pin}/next_riddle
           (the board publishes them there on a publish:"hold" req), so the
           next riddle is never revealed during the results screen. Cases
           when the turn goes live:
             1 · a staged riddle exists for THIS player+reason → MOVE it into
                 current_riddle (instant start, no Gemini call, no leak).
             2 · the riddle already sits in current_riddle from our request
                 (self-heal / older firmware delivered it directly) → KEEP it.
             3 · nothing usable → clear current_riddle (staged leftovers of
                 other reasons are cleared only on MAIN turns - a bonus
                 mini-turn keeps the staged next main riddle for later) and
                 re-aim the board at the live turn:
                   · staged record matches → re-send THAT req with
                     publish:"now" - the board flips its publish target and
                     republishes the cached riddle (no regeneration);
                   · the live-turn request matches → flip it the same way;
                   · nothing matches → mint a fresh request. */
        const staged = r.next_riddle ?? null;
        const rec =
          stagedReqRef.current && stagedReqRef.current.pin === pinLocal
            ? stagedReqRef.current
            : null;
        // The LOBBY prefetch is minted for whoever joined
        // first; if that player left or rejoined under another name, the
        // staged riddle was thrown away and regenerated live (staged for
        // "#Bob", first turn was "Boby #Mate"). The riddle itself
        // never depends on the player, so the match's FIRST turn takes it for
        // any player at the same difficulty. Later prefetches keep the strict
        // name match (difficulty adapts per player mid-game).
        const firstTurnOfMatch =
          reason === 'turn' && r.current_round === 1 && (r.turn_pos ?? 0) === 0;
        const stagedUsable = Boolean(
          staged && rec && staged.req_id === rec.reqId && rec.reason === reason &&
          (rec.player === player.name ||
            (firstTurnOfMatch && staged.difficulty === player.current_difficulty)),
        );
        const keepInPlace = Boolean(
          r.current_riddle && requestMatches &&
          r.current_riddle.req_id === lastReqIdRef.current,
        );
        /* The "0 → 60" clock: the host
           clock renders localTimeRemaining, so the 0 seed below made the
           dashboard read "0" for the whole announce + riddle-speech window
           and then jump to the limit when the arm effect fired (arming is
           speech-gated BY DESIGN - the countdown must not burn while the
           room is still listening to the riddle). Seed the FROZEN full
           limit instead, exactly like the demo path above does. Purely a
           display seed: scoring still reads turn_timer at verdict time. */
        if (stagedUsable && staged) {
          setLocalTimeRemaining(staged.time_limit_sec || 0);
        } else if (keepInPlace && r.current_riddle) {
          setLocalTimeRemaining(r.current_riddle.time_limit_sec || 0);
        }
        if (stagedUsable && staged && rec) {
          lastReqIdRef.current = rec.reqId;
          lastReqPlayerRef.current = player.name; // The lobby reuse may re-key it
          lastReqReasonRef.current = rec.reason;
          stagedReqRef.current = null; // consumed by this turn
          await sync.update(`rooms/${pinLocal}`, {
            current_riddle: staged,
            next_riddle: null,
            turn_timer: { time_remaining: 0, is_active: false },
            turn_started_at: null,
            state: 'ACTIVE_TURN',
            phase_started_at: Date.now(),
            paused: null,
            host_paused: null, // A new turn starts unpaused
            hint: null,
            hint_used_turn: null,
            hint_request: null, // A stale request must never block the next clock
            host_review: null, // Host Check dies with the turn
            paper_mode: null,
            countdown: null,
          });
          return;
        }
        await sync.update(`rooms/${pinLocal}`, {
          current_riddle: keepInPlace ? r.current_riddle : null,
          // a bonus mini-turn must NOT discard the staged next MAIN riddle
          next_riddle: r.bonus_turn ? (r.next_riddle ?? null) : null,
          turn_timer: { time_remaining: 0, is_active: false },
          turn_started_at: null,
          state: 'ACTIVE_TURN',
          phase_started_at: Date.now(),
          paused: null,
          host_paused: null, // A new turn starts unpaused
          hint: null,
          hint_used_turn: null,
          hint_request: null, // A stale request must never block the next clock
          host_review: null, // Host Check dies with the turn
          paper_mode: null,
          countdown: null,
        });
        if (keepInPlace) {
          stagedReqRef.current = null; // that request was consumed by the delivery
          return;
        }
        const askReq = {
          id: activeId,
          name: player.name,
          difficulty: player.current_difficulty,
        };
        if (stagedUsable && rec) {
          // the staged riddle was generated for THIS turn - flip its request
          // to publish:"now" and let the board republish from cache
          stagedReqRef.current = null;
          await writeRiddleReq(reason, askReq, rec.reqId, 'now');
        } else if (requestMatches) {
          // same id, publish target flipped to the live turn - the board
          // republishes its cached riddle (or finishes generating) into
          // current_riddle. Idempotent: safe to re-send.
          await writeRiddleReq(reason, askReq, lastReqIdRef.current, 'now');
        } else {
          await writeRiddleReq(reason, askReq);
        }
      }
    },
    [writeRiddleReq],
  );

  const enterCallout = useCallback(
    async (pinLocal: string, r: Room, posOverride?: number) => {
      const order = r.turn_order ?? [];
      if (!order.length) return;
      let p = posOverride ?? r.turn_pos ?? 0;
      let activeId = order[p];
      // Skip players who left mid-game.
      let guard = 0;
      while (activeId && !r.players?.[activeId] && guard < order.length) {
        p = (p + 1) % order.length;
        activeId = order[p];
        guard++;
      }
      if (!activeId || !r.players?.[activeId]) {
        toast.error('No active players left in the room.');
        return;
      }
      await sync.update(`rooms/${pinLocal}`, {
        active_player_id: activeId,
        turn_pos: p,
        state: 'CALLOUT',
        phase_started_at: Date.now(),
        last_evaluation: null,
        // enterCallout OWNS the CALLOUT transition.
        // bonus_turn previously died in continueTurn's separate first write
        // (the two-snapshot glitch); clearing it here covers both callers
        // (post-verdict advance and the ROUND_FLASH opener).
        bonus_turn: null,
      });
    },
    [],
  );

  /* Banner-phase scheduler: INTRO → ROUND_FLASH → CALLOUT → ACTIVE_TURN.
     🗣️ Each phase now advances when its Voice Master line has FINISHED
     (board tts_done echo / browser onend), after a small minimum dwell so
     banners stay readable. If no speech-end event lands, it falls back to
     the old estimate-based wait + grace - identical to previous behavior. */
  useEffect(() => {
    if (!isHost || !room || !pin) return;
    const t0 = room.phase_started_at;
    const key = `${room.state}:${t0}`;
    const ttsMs = estimateSpeechMs(phaseLine(room), settingsRef.current.voice_speed);

    // FIRE-TIME speech-gate re-check (shared by all three
    // banner phases). The announcer effect is declared AFTER this scheduler,
    // so on the scheduler's only run the spoken-gate still held the
    // PREVIOUS phase → `extra` computed to 0 → the estimate fallback fired
    // while the board was frozen mid-line and the screens outran the
    // speaker. Re-reading the gate INSIDE the timeout callback (it now
    // reflects THIS phase) extends the wait once by the board-line
    // patience; the tts_done echo bumps speechDoneTick → this effect
    // re-runs, the extension is cleaned up and the phase advances at
    // MIN_DWELL after the real speech end.
    let extendedFire = 0;
    const fireWhenSettled = (fire: () => void) => {
      const sp = phaseSpokenRef.current;
      // Boards with the tts_start echo: hold until the line has
      // really started + its estimate (capped), not a fixed extension.
      const fb = boardFallbackAt(sp, key, ttsMs, ttsStartSeenRef.current, Boolean(espStatusRef.current));
      if (fb != null) {
        if (fb > Date.now()) extendedFire = window.setTimeout(fire, fb - Date.now());
        else fire();
        return;
      }
      if (
        sp && sp.key === key && !sp.done && sp.board &&
        espStatusRef.current
      ) {
        extendedFire = window.setTimeout(fire, BOARD_LINE_PATIENCE_MS);
        return;
      }
      fire();
    };
    const cancelTimers = (outer: number) => {
      window.clearTimeout(outer);
      window.clearTimeout(extendedFire);
    };

    if (room.state === 'INTRO') {
      const advance = () => {
        void sync.update(`rooms/${pin}`, {
          state: 'ROUND_FLASH',
          special_round_type: specialForRound(room.current_round, room.num_rounds),
          phase_started_at: Date.now(),
        });
      };
      const spoken = phaseSpokenRef.current;
      let wait: number;
      if (spoken && spoken.key === key && spoken.done) {
        wait = Math.max(0, t0 + MIN_DWELL_MS - Date.now());
      } else {
        // A board-owned INTRO line gets the extra patience window:
        // the welcome is usually written while the board is still generating
        // the first riddle and cannot echo for tens of seconds.
        // Boards with the tts_start echo anchor on real speech start.
        const fb = boardFallbackAt(
          spoken, key, Math.max(INTRO_MS, ttsMs), ttsStartSeenRef.current, Boolean(espStatusRef.current),
        );
        const extra =
          spoken && spoken.key === key && spoken.board
            ? espStatusRef.current
              ? BOARD_LINE_PATIENCE_MS
              : BOARD_LINE_PATIENCE_OFFLINE_MS
            : 0;
        wait = fb != null
          ? Math.max(0, fb - Date.now())
          : Math.max(0, t0 + Math.max(INTRO_MS, ttsMs) + SPEECH_GRACE_MS + extra - Date.now());
      }
      const id = window.setTimeout(() => fireWhenSettled(advance), wait);
      return () => cancelTimers(id);
    }

    if (room.state === 'ROUND_FLASH') {
      const wait = spokenWaitOrFallback(key, t0, Math.max(FLASH_MS, ttsMs));
      const id = window.setTimeout(() => {
        fireWhenSettled(() => { void enterCallout(pin, room); });
      }, wait);
      return () => cancelTimers(id);
    }

    if (room.state === 'CALLOUT') {
      const wait = spokenWaitOrFallback(key, t0, Math.max(CALLOUT_MS, ttsMs));
      const id = window.setTimeout(() => {
        fireWhenSettled(() => { void startActiveTurn(pin, room); });
      }, wait);
      return () => cancelTimers(id);
    }
    return undefined;

    function spokenWaitOrFallback(phaseKey: string, t0Ms: number, estMs: number): number {
      const spoken = phaseSpokenRef.current;
      if (spoken && spoken.key === phaseKey && spoken.done) {
        return Math.max(0, t0Ms + MIN_DWELL_MS - Date.now());
      }
      // Boards with the tts_start echo anchor on real speech start.
      const fb = boardFallbackAt(spoken, phaseKey, estMs, ttsStartSeenRef.current, Boolean(espStatusRef.current));
      if (fb != null) return Math.max(0, fb - Date.now());
      // board-owned line: wait out the board's Gemini block before
      // falling back (the echo releases the gate the moment speech ends).
      const extra =
        spoken && spoken.key === phaseKey && spoken.board
          ? espStatusRef.current
            ? BOARD_LINE_PATIENCE_MS
            : BOARD_LINE_PATIENCE_OFFLINE_MS
          : 0;
      return Math.max(0, t0Ms + estMs + SPEECH_GRACE_MS + extra - Date.now());
    }
  }, [isHost, pin, room?.state, room?.phase_started_at, room?.current_round, speechDoneTick, enterCallout, startActiveTurn]);

  /* ── host turn countdown ────────────────────────────────────────────── */
  useEffect(() => {
    if (!isHost || !room || !pin) return;
    if (room.state !== 'ACTIVE_TURN' || !room.turn_timer?.is_active || !room.turn_started_at) {
      return undefined;
    }
    // ⏸ Paused: freeze everything - no ticking, no DB writes, no timeout.
    if (room.paused || room.host_paused) {
      timerWasPausedRef.current = true; // Remember for the rebase
      return undefined;
    }
    // DEADLINE REBASE. The deadline is an absolute wall-clock time;
    // keeping the pre-pause one after ANY resume (host button, hint line
    // finished, countdown capture done) silently charged every paused
    // second to the player (the timer once dropped 30 s at once).
    // Re-anchor from the frozen DB remaining on: a new turn, a cold start,
    // or the run right after a pause of any kind.
    if (
      deadlineRef.current == null ||
      deadlineTurnRef.current !== room.turn_started_at ||
      timerWasPausedRef.current
    ) {
      deadlineRef.current = Date.now() + room.turn_timer.time_remaining * 1000;
      deadlineTurnRef.current = room.turn_started_at;
      timerWasPausedRef.current = false;
    }
    let tick = 0;
    const iv = window.setInterval(() => {
      const rem = Math.max(0, ((deadlineRef.current ?? 0) - Date.now()) / 1000);
      setLocalTimeRemaining(rem);
      if (++tick % 2 === 0) {
        void sync.update(`rooms/${pin}/turn_timer`, {
          time_remaining: rem,
          is_active: true,
        });
      }
      // Ticking clock for the final 5 seconds.
      const sec = Math.ceil(rem);
      if (sec !== lastTickSecRef.current) {
        lastTickSecRef.current = sec;
        if (sec <= 5 && sec > 0) sfxTick(settingsRef.current.muted);
      }
      if (rem <= 0) {
        window.clearInterval(iv);
        const r = roomRef.current;
        if (r && r.state === 'ACTIVE_TURN') {
          void applyEvaluation({
            passed: false,
            error: false,
            feedback: '⏰ Time expired! No object proof submitted.',
            timedOut: true,
          });
        }
      }
       
    }, 500);
    return () => window.clearInterval(iv);
     
  }, [isHost, pin, room?.state, room?.turn_started_at, room?.turn_timer?.is_active, room?.paused, room?.host_paused]);

  /* ⏱️ Arm the turn clock ONLY after the riddle has been spoken (item 3).
     startActiveTurn writes is_active:false + turn_started_at:null; this
     effect waits for the riddle line's speech-end gate and then starts the
     countdown from the FULL limit. If the speech-end event never arrives
     (old firmware / muted room), the sync fallback arms it after the
     estimated speech time + grace - never slower than before, never less
     fair. The clock also can't be armed twice: the is_active guard.
     Real rooms additionally wait until the board's riddle has ARRIVED. */
  useEffect(() => {
    if (!isHost || !room || !pin || room.state !== 'ACTIVE_TURN') return;
    if (room.turn_timer?.is_active || room.turn_started_at) return; // already running
    if (room.paused) return;
    // 💡 A hint is being generated/spoken: the clock waits until the
    // hint line has finished (the pause resumes it, arming stays blocked).
    // Only a request from THIS turn may hold the clock;
    // an older leftover is ignored here (and cleared by the hint effect).
    const pendingHint = room.hint_request && (room.hint_request.ts ?? 0) >= (room.phase_started_at ?? 0);
    if (pendingHint || hintPauseRef.current) return;
    if (!room.current_riddle) return; // still "Preparing riddle…" - no clock yet
    // Only a riddle that answers OUR request may arm the clock: a
    // stale publish from a superseded request must never start a countdown.
    if (lastReqIdRef.current !== 0 && room.current_riddle.req_id !== lastReqIdRef.current) {
      return;
    }
    const key = `ACTIVE_TURN:${room.phase_started_at}`;
    let cancelled = false;
    const arm = () => {
      if (cancelled) return;
      const r = roomRef.current;
      if (!r || r.state !== 'ACTIVE_TURN') return;
      if (r.turn_timer?.is_active || r.turn_started_at) return; // raced - someone else armed it
      const limit = r.current_riddle?.time_limit_sec ?? r.turn_timer?.time_remaining ?? 45;
      void sync
        .update(`rooms/${pin}`, {
          turn_started_at: Date.now(),
          turn_timer: { time_remaining: limit, is_active: true },
        })
        .catch(() => undefined);
    };
    const spoken = phaseSpokenRef.current;
    if (spoken && spoken.key === key && spoken.done) {
      arm();
      return undefined;
    }
    const line = phaseLine(room);
    const ttsMs = estimateSpeechMs(line, settingsRef.current.voice_speed);
    // The riddle line is BOARD-OWNED in real rooms: while the board
    // is frozen inside a Gemini attempt it cannot echo tts_done, so give the
    // arm timer the extra patience window before the estimate fallback.
    const boardLine = spoken && spoken.key === key && spoken.board;
    const extra = boardLine
      ? espStatusRef.current
        ? BOARD_LINE_PATIENCE_MS
        : BOARD_LINE_PATIENCE_OFFLINE_MS
      : 0;
    // Boards with the tts_start echo: the clock's fallback counts
    // from when the riddle line really STARTED (the tts_done echo still arms
    // it at end of speech). A line still queued behind others waits for its
    // start echo (capped) instead of arming before the riddle is heard.
    const fb = boardFallbackAt(
      spoken, key, Math.max(1500, ttsMs), ttsStartSeenRef.current, Boolean(espStatusRef.current),
    );
    const delay = fb != null ? Math.max(0, fb - Date.now()) : Math.max(1500, ttsMs) + SPEECH_GRACE_MS + extra;
    const id = window.setTimeout(arm, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [isHost, pin, room?.state, room?.phase_started_at, room?.turn_timer?.is_active, room?.turn_started_at, room?.paused, speechDoneTick]);

  /* ── evaluation engine ──────────────────────────────────────────────── */

  const applyEvaluation = useCallback(
    async (verdict: {
      passed: boolean;
      error: boolean;
      feedback: string;
      timedOut: boolean;
      points?: number;
      seen?: string | null;
      /** 'host_check': the host decided an UNCLEAR photo. It is
       *  the turn's FIRST real verdict (nothing to reverse), not an overrule. */
      source?: 'host_check';
    }) => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      // Accept ACTIVE_TURN (timeout path), EVALUATING (judged path) and
      // ROUND_RESULTS (the Overrule-AI path re-opens a rejected
      // verdict; only overruleAi() calls this from that state).
      if (!sess || sess.role !== 'host' || !r ||
        (r.state !== 'EVALUATING' && r.state !== 'ACTIVE_TURN' && r.state !== 'ROUND_RESULTS')) return;
      const pinLocal = sess.pin;
      const activeId = r.active_player_id;
      const player = activeId ? r.players?.[activeId] : null;
      const riddle = r.current_riddle;
      if (!activeId || !player || !riddle) return;
      // The OVERRULE path re-enters from ROUND_RESULTS. Its player
      // patch must not re-run the next-riddle prefetch (the original verdict
      // already minted one) - that double mint is a wasted Gemini generation.
      // Host Check also arrives from ROUND_RESULTS, but it decides
      // an UNCLEAR photo: no earlier fail to reverse, no doom penalty to
      // refund, normal DDA/fail accounting and a normal post-verdict prefetch.
      const isOverrule = r.state === 'ROUND_RESULTS' && verdict.source !== 'host_check';
      // What the REVERSED verdict already charged the stats with, so
      // the overrule can net it out (a reversed fail must not leave the
      // player with ✅1 ❌1 for one and the same turn).
      const wasTimedOut = r.last_evaluation?.timed_out === true;

      /* 🎁 Bonus mini-turns: normal points, no doom, DDA skipped.
         They are marked by room.bonus_turn; the round's own special does
         not apply to them. */
      const bonusTurn = Boolean(r.bonus_turn);
      const special = bonusTurn ? 'NONE' : r.special_round_type;
      const frozenRemaining = Math.max(0, r.turn_timer?.time_remaining ?? 0);
      const stats = { ...(player.stats ?? emptyStats()) };
      const updates: Record<string, unknown> = {};
      let delta = 0;
      // Set when DDA moves this player's difficulty; surfaced in the
      // feed after the commit so the host can SEE the adjustment working.
      let ddaNote: string | null = null;

      if (verdict.error) {
        // Unclear image - no score change, retake allowed.
        delta = 0;
      } else if (verdict.passed) {
        delta = verdict.points ?? computeScore(riddle.difficulty, frozenRemaining, riddle.time_limit_sec, special);
        /* 💡 A hint used during THIS turn costs 50 % of the solve
           award (HINT_SOLVE_PENALTY). Applies to main + bonus riddles alike;
           there is no longer an up-front score charge (the flat −100 died). */
        if (r.hint_used_turn != null && r.hint_used_turn === r.turn_started_at) {
          delta = Math.max(0, Math.floor(delta * (1 - HINT_SOLVE_PENALTY)));
        }
        stats.solves += 1;
        // The overrule reverses the original fail/timeout verdict:
        // take its stat back so the same turn is not counted twice.
        if (isOverrule) {
          if (wasTimedOut && stats.timeouts > 0) stats.timeouts -= 1;
          else if (stats.fails > 0) stats.fails -= 1;
        }
        if (riddle.difficulty === 'Hard') stats.hard_solves += 1;
        if (special === 'DOUBLE_OR_DOOM') stats.doom_survives += 1;
        const solveTime = Math.max(1, Math.round(riddle.time_limit_sec - frozenRemaining));
        // The overrule's frozen remaining is the SNAP-time
        // clock, not a solve time - recording it could mint a bogus ~1 s
        // "fastest solve". Existing best times stand on an overrule.
        if (!isOverrule && (stats.best_time_sec == null || solveTime < stats.best_time_sec)) {
          stats.best_time_sec = solveTime;
        }
        // The overrule re-scores the turn as a pass AFTER
        // the fail already zeroed the streak. The pre-fail values ride in
        // last_evaluation.pre_fail (written by the fail branch below) and
        // restore streak continuity - a 3-in-a-row hype can now fire when
        // the reversed turn completes it.
        const pf = isOverrule ? (r.last_evaluation?.pre_fail ?? null) : null;
        const newStreak = (pf ? pf.streak : player.streak) + 1;
        streakMilestoneRef.current = newStreak === 3 ? player.name : null;
        /* DDA: bonus outcomes never move difficulty.
           Difficulty moves on 2-round BLOCKS:
           two resolved main turns decide - 2/2 solves → step up, 0/2 →
           ease, 1/2 → hold; the block resets after every resolution and
           whenever the difficulty changes under it. The old raw-streak
           triggers (bump at the 2nd consecutive solve, ease at the 2nd
           fail) are gone. The overrule path restores the pre-fail block
           counters first, so the reversed turn counts exactly like a
           genuine solve. Tier caps still bound it via stepDifficulty. */
        let blockSolved = pf ? (pf.block_solved ?? 0) : (player.dda_block_solved ?? 0);
        let blockTotal = pf ? (pf.block_total ?? 0) : (player.dda_block_total ?? 0);
        let newDiff = pf ? pf.difficulty : player.current_difficulty;
        let ddaUp = false;
        if (!bonusTurn) {
          blockTotal += 1;
          blockSolved += 1;
          if (blockTotal >= 2) {
            ddaUp = blockSolved >= 2;   // 2/2 → up · 1/2 → hold (pass never eases)
            blockTotal = 0;
            blockSolved = 0;
          }
          if (newDiff !== player.current_difficulty && !ddaUp) {
            blockTotal = 0;             // difficulty changed under us → fresh block
            blockSolved = 0;
          }
          if (ddaUp) newDiff = stepDifficulty(newDiff, 'up', player.tier);
          if (ddaUp && newDiff !== player.current_difficulty) {
            blockTotal = 0;             // resolution consumed → fresh block
            blockSolved = 0;
            ddaNote = `Difficulty up for ${player.name} — now solving ${newDiff} riddles!`;
          }
        }
        // Publish the freshest difficulty for the prefetch mints:
        // they run before the DB round-trip delivers the new player node.
        ddaDiffRef.current.set(activeId, newDiff);
        // An overruled DOUBLE_OR_DOOM fail also gets its
        // doom penalty REFUNDED - the original fail subtracted it, and the
        // pass award alone used to leave the player 2×base short.
        const doomRefund =
          isOverrule && special === 'DOUBLE_OR_DOOM' ? -doomPenalty(riddle.difficulty) : 0;
        const newScore = Math.max(0, player.score + delta + doomRefund);
        updates[`players/${activeId}`] = {
          ...player,
          score: newScore,
          streak: newStreak,
          fail_streak: pf ? pf.fail_streak : 0, // Restored on overrule
          current_difficulty: newDiff,
          dda_block_solved: blockSolved,        // T12
          dda_block_total: blockTotal,          // T12
          stats,
        };
      } else {
        if (verdict.timedOut) stats.timeouts += 1;
        else stats.fails += 1;
        /* Bonus riddles carry no penalty. */
        delta = !bonusTurn && special === 'DOUBLE_OR_DOOM' ? doomPenalty(riddle.difficulty) : 0;
        const newFailStreak = player.fail_streak + 1;
        /* DDA the fail adds its attempt to the block; a
           0/2 block eases the difficulty. The old ease-on-2-fails trigger
           is gone - fails now resolve through blocks exactly like solves.
           Bonus mini-turns stay outside blocks. */
        let blockSolved = player.dda_block_solved ?? 0;
        let blockTotal = player.dda_block_total ?? 0;
        let newDiff = player.current_difficulty;
        if (!bonusTurn) {
          blockTotal += 1;
          if (blockTotal >= 2) {
            const ddaDown = blockSolved <= 0;   // 0/2 → ease · 1/2 → hold
            if (ddaDown) newDiff = stepDifficulty(newDiff, 'down', player.tier);
            blockTotal = 0;
            blockSolved = 0;
            if (ddaDown && newDiff !== player.current_difficulty) {
              ddaNote = `Difficulty eased for ${player.name} — back to ${newDiff} riddles.`;
            }
          }
        }
        ddaDiffRef.current.set(activeId, newDiff);
        updates[`players/${activeId}`] = {
          ...player,
          score: Math.max(0, player.score + delta),
          streak: bonusTurn ? player.streak : 0,
          fail_streak: newFailStreak, // No reset-on-ease; the next solve zeroes it
          current_difficulty: newDiff,
          dda_block_solved: blockSolved, // T12
          dda_block_total: blockTotal,   // T12
          stats,
        };
      }

      /* 🎨 Theme Mastery - count resolved attempts per riddle theme.
         Unclear retakes don't count (no player node is written either).
         The overrule path re-enters this block after the
         fail already counted the attempt → the attempt is NOT re-added;
         the solve flips on (net: one attempt + one solve per resolved
         turn, matching the corrected score/stats above). */
      if (!verdict.error) {
        const themeStats = { ...(stats.theme_stats ?? {}) };
        const cur = themeStats[riddle.theme] ?? { attempts: 0, solves: 0 };
        themeStats[riddle.theme] = {
          attempts: cur.attempts + (isOverrule ? 0 : 1),
          solves: cur.solves + (verdict.passed ? 1 : 0),
        };
        stats.theme_stats = themeStats;
      }

      // Dedupe - the overrule re-appends the keyword its
      // original fail already recorded (Set keeps insertion order; the
      // freshest keyword still lands last for the 12-entry trim).
      const excluded = Array.from(
        new Set([...(r.excluded_keywords ?? []), riddle.target_keyword]),
      ).slice(-12);
      updates.excluded_keywords = excluded;
      // The paper pivot is a PER-TURN toggle: it dies with the turn.
      // An UNCLEAR verdict does not end the turn (the retake
      // judges the same riddle), so the pivot and the spotlight survive it.
      // Clearing them here made the retake judge a paper proof as Object
      // Match ("A drawing is not a physical object") - and the retake
      // window has no Pivot button to restore it.
      if (!verdict.error) {
        updates.paper_mode = null;
        // Spotlight hype ends when the spotlighted player's turn resolves.
        if (r.spotlight?.player_id && r.spotlight.player_id === activeId) {
          updates.spotlight = null;
        }
      }
      // 📸 Photo Moments - attach the captured frame as a small polaroid.
      // Unclear shots are skipped (the player retakes those); pass & fail
      // proofs become gallery memories.
      const rawFrame =
        pendingMomentRef.current ?? (verdict.source === 'host_check' ? unclearFrameRef.current : null);
      pendingMomentRef.current = null;
      // Keep the latest unclear frame for a possible Host Check
      unclearFrameRef.current = verdict.error ? (rawFrame ?? unclearFrameRef.current) : null;
      if (isOverrule && !verdict.error) {
        /* OVERRULE PATCH: the original verdict already stored this
           turn's polaroid as fail/timeout with the doom penalty. The
           overrule used to leave that moment untouched, so the victory
           screen kept showing "failed · −200" even though the host had
           reversed the verdict and the score was correct. Rewrite the
           player's latest failed moment for this turn into the accepted
           proof with the awarded points instead. */
        const moments = [...(r.moments ?? [])];
        for (let i = moments.length - 1; i >= 0; --i) {
          const m = moments[i];
          if (m && m.player_id === activeId && (m.verdict === 'fail' || m.verdict === 'timeout')) {
            moments[i] = { ...m, verdict: 'pass', points: delta };
            updates.moments = moments;
            break;
          }
        }
      } else if (rawFrame && !verdict.error) {
        const photo = await makeMomentPhoto(rawFrame);
        if (photo) {
          const moment: PhotoMoment = {
            id: newId('m'),
            ts: Date.now(),
            player_id: activeId,
            player_name: player.name,
            player_color: player.color,
            keyword: riddle.target_keyword,
            difficulty: riddle.difficulty,
            round: r.current_round,
            verdict: verdict.timedOut ? 'timeout' : verdict.passed ? 'pass' : 'fail',
            points: delta,
            photo,
          };
          updates.moments = [...(r.moments ?? []), moment].slice(-12);
        }
      }

      updates.last_evaluation = {
        passed: verdict.passed,
        error: verdict.error,
        feedback: verdict.feedback,
        points_earned: delta,
        timed_out: verdict.timedOut,
        // What the judge saw (powers the spoken "I see …" line)
        seen: verdict.seen ?? null,
        // pre-verdict snapshot (fail/timeout writes only).
        // The Overrule-AI path re-scores the turn as a pass and restores
        // streak, fail-streak, difficulty and the DDA block from here.
        ...(verdict.passed
          ? {}
          : {
              pre_fail: {
                streak: player.streak,
                fail_streak: player.fail_streak,
                difficulty: player.current_difficulty,
                block_solved: player.dda_block_solved ?? 0,
                block_total: player.dda_block_total ?? 0,
              },
            }),
      };
      updates.state = 'ROUND_RESULTS';
      updates.phase_started_at = Date.now();
      updates.paused = null; // a paused turn that resolves still cleans up
      updates.host_paused = null; // The manual pause dies with the turn
      await sync.update(`rooms/${pinLocal}`, updates);
      // The frozen proof photo STAYS on the feed through the
      // results screen (cleared when the host continues). It used to be
      // dropped here and the feed silently swapped frames the moment the
      // verdict landed.

      // Live event feed
      if (verdict.error) {
        await pushFeed(pinLocal, `📸 ${player.name}'s photo was unclear — retake!`, 'info');
      } else if (verdict.timedOut) {
        await pushFeed(pinLocal, `⏰ ${player.name} ran out of time!`, 'bad');
      } else if (verdict.passed) {
        const mult = special === 'DOUBLE_OR_DOOM' ? ' 💀2×' : '';
        const half = r.hint_used_turn != null && r.hint_used_turn === r.turn_started_at;
        // Surface the doom refund on overruled doom turns
        // (the score moved by more than the pass award).
        const refundNote = isOverrule && special === 'DOUBLE_OR_DOOM' ? ' · doom refunded' : '';
        await pushFeed(
          pinLocal,
          `✅ ${player.name} proved “${riddle.target_keyword}” +${delta} pts${mult}${half ? ' · hint halved' : ''}${refundNote}`,
          'good',
        );
      } else {
        await pushFeed(pinLocal, `❌ ${player.name} failed the “${riddle.target_keyword}” proof`, 'bad');
      }
      /* 🔥 Streak milestone hype - 3 in a row deserves the Voice Master
         (announcements carry no emojis). */
      if (streakMilestoneRef.current) {
        const nm = streakMilestoneRef.current;
        streakMilestoneRef.current = null;
        announce(`${nm} is on fire — three in a row!`);
        await pushFeed(pinLocal, `🔥 ${nm} is ON FIRE — 3 solves in a row!`, 'gold');
      }
      // Make the DDA step visible in the live ticker.
      if (ddaNote) {
        await pushFeed(pinLocal, `📈 ${ddaNote}`, 'gold');
      }
      /* 🎲 Prefetch the NEXT player's riddle right after a judged turn
         (unclear retakes keep the same riddle; bonus mini-turns prefetch in
         continueTurn). Skipped when a request is still unconsumed.
         The prefetch is published with publish:"hold": the board
         stages it into rooms/{pin}/next_riddle so it never appears on any
         screen before the host presses Continue.
         The difficulty reads through ddaDiffRef (the DDA bump from
         THIS verdict reaches the very next mint without waiting for the DB
         round-trip - the reason every riddle stayed Easy in field report
         #7), a plain FAIL also prefetches now, and the OVERRULE path (which
         re-enters from ROUND_RESULTS) never mints a second prefetch. */
      // The board runs ONE riddle job at a time, so a
      // bonus request aborts a main prefetch that was still generating (field
      // log 16:36:47 "result … discarded") and the next main turn then waited
      // on a live generation. After a bonus verdict, re-mint the next main
      // turn's riddle unless the staged one actually landed in next_riddle.
      const stagedRec = stagedReqRef.current;
      const bonusLostStaged =
        bonusTurn &&
        !(stagedRec && stagedRec.pin === pinLocal && roomRef.current?.next_riddle?.req_id === stagedRec.reqId);
      if (!verdict.error && (!bonusTurn || bonusLostStaged) && !isOverrule) {
        const cur = roomRef.current;
        if (cur && cur.state === 'ROUND_RESULTS') {
          const consumed = cur.current_riddle?.req_id === lastReqIdRef.current;
          // Any resolved verdict (pass / plain fail / timeout) needs
          // a fresh riddle next turn, so prefetch whenever the request that
          // produced THIS riddle was actually consumed.
          // GATE FLIP: every startActiveTurn branch ends
          // with current_riddle.req_id === lastReqIdRef, so `consumed` is
          // ALWAYS true on a judged turn - the old `if (!consumed)` skipped
          // the prefetch after EVERY normal verdict and pushed the next mint
          // into startActiveTurn's live path, putting the Gemini wait exactly
          // on the "step up to the camera" beat (the turn-start lag quest).
          // Mint when the producing request WAS consumed, as described
          // above. A non-consuming verdict means a fresher
          // request is already in flight (self-heal minted it) → skip.
          if (consumed) {
            const order = cur.turn_order ?? [];
            let nextPos = (cur.turn_pos ?? 0) + 1;
            let nextId: string | null = order[nextPos] ?? null;
            if (!nextId || !cur.players?.[nextId]) nextId = order[0] ?? null; // round will advance
            const np = nextId ? cur.players?.[nextId] : null;
            if (np) {
              await writeRiddleReq('turn', {
                id: nextId,
                name: np.name,
                difficulty: ddaDiffRef.current.get(nextId) ?? np.current_difficulty,
              }, 0, 'hold');
            }
          }
        }
      }
    },
    [pushFeed, announce, writeRiddleReq],
  );

  /* Auto-judge while EVALUATING - demo rooms only (fixed rates:
     ~50 % pass / 15 % unclear / 35 % fail). Real rooms are judged by the
     board's own Gemini call (judge_result consumption effect below). */
  useEffect(() => {
    if (!isHost || !room || room.state !== 'EVALUATING') return;
    if (!room.demo) return undefined; // real room → ESP32 Vision judges
    const phaseKey = String(room.phase_started_at);
    const riddle = room.current_riddle;

    if (judgedPhaseRef.current === phaseKey) return;
    judgedPhaseRef.current = phaseKey;
    const unclearShare = DEMO_UNCLEAR_SHARE;
    const failShare = Math.max(0, 1 - unclearShare - DEMO_PASS_RATE);
    const id = window.setTimeout(
      () => {
        const roll = Math.random();
        const kw = riddle?.target_keyword ?? 'object';
        if (roll < unclearShare) {
          void applyEvaluation({
            passed: false,
            error: true,
            feedback: '⚠️ Image Unclear: Gemini could not detect any object due to blur or lighting.',
            timedOut: false,
          });
        } else if (roll < unclearShare + failShare) {
          void applyEvaluation({
            passed: false,
            error: false,
            feedback: `Incorrect proof! That did not match ${kw}.`,
            timedOut: false,
          });
        } else {
          void applyEvaluation({
            passed: true,
            error: false,
            feedback: `Great job! That is clearly a ${kw}.`,
            timedOut: false,
          });
        }
      },
      1800,
    );
    return () => window.clearTimeout(id);
     
  }, [isHost, room?.state, room?.phase_started_at, room?.current_riddle?.target_keyword]);

  /* ── 🤖 ESP32 Vision judge consumption (real rooms)
     The board captures the frame and runs its own key-rotated Gemini call,
     then writes rooms/{pin}/judge_result/{phaseSeconds}. The host waits for
     the matching verdict (exact key OR any verdict fresher than the phase -
     belt & suspenders), scores it via applyEvaluation, and clears the node.
     The listener stays alive the whole time - a late verdict still lands.
     20 s: re-send the cloud judge request. 45 s: surface the manual judge
     override. (The old browser-Gemini fallback died with B2 - the board is
     the only judge for real rooms.) */
  useEffect(() => {
    if (!isHost || !room || room.state !== 'EVALUATING') return;
    if (room.demo) return; // demo rooms are judged by the fixed simulator
    const phaseMs = room.phase_started_at;
    const phaseSec = Math.floor(phaseMs / 1000);
    if (espJudgePhaseRef.current === phaseMs) return;
    const pinLocal = sessionRef.current?.pin;
    if (!pinLocal) return;

    let live = true;
    let consumed = false;
    let retryTimer = 0;
    let finalTimer = 0;
    let unsub: () => void = () => undefined;

    unsub = sync.subscribe(`rooms/${pinLocal}/judge_result`, (v) => {
      if (consumed || !live) return;
      const all = v as Record<string, JudgeResult> | null;
      if (!all || typeof all !== 'object') return;
      // Preferred: exact seconds key. Tolerant: newest verdict written after
      // this phase began (covers legacy boards with wrapped-ms keys).
      let res = all[String(phaseSec)] ?? null;
      if (!res) {
        let bestTs = 0;
        for (const cand of Object.values(all)) {
          const ts = cand?.ts ?? 0;
          if (ts >= phaseMs - 1500 && ts > bestTs) {
            bestTs = ts;
            res = cand;
          }
        }
      }
      if (!res || typeof res !== 'object') return;
      consumed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(finalTimer);
      void (async () => {
        if (!live) return;
        void sync.remove(`rooms/${pinLocal}/judge_result`).catch(() => undefined);
        const r2 = roomRef.current;
        if (!r2 || r2.state !== 'EVALUATING' || !r2.current_riddle) return;
        const points = res!.passed
          ? computeScore(r2.current_riddle.difficulty, r2.turn_timer.time_remaining, r2.current_riddle.time_limit_sec, r2.bonus_turn ? 'NONE' : r2.special_round_type)
          : 0;
        void applyEvaluation({
          passed: res!.passed,
          error: res!.unclear === true,
          feedback: res!.feedback || (res!.passed ? 'Correct proof!' : 'That did not match the riddle.'),
          timedOut: false,
          seen: res!.seen ?? null,
          points,
        });
      })();
    });

    /* The board beats its heartbeat with state=JUDGING + gen="judge"
       the instant it starts judging, so the watchdog can tell "working"
       (Gemini retry storms take 1-3 min) from "quiet". While the ack is
       visible the timers keep rescheduling instead of toasting. */
    let escalated = false;
    const judgeCheck = () => {
      if (!live || consumed) return;
      const esp = espStatusRef.current;
      if (esp && (esp.gen === 'judge' || esp.state === 'JUDGING')) {
        retryTimer = window.setTimeout(judgeCheck, 15000);
        return;
      }
      if (!escalated) {
        escalated = true;
        void sync
          .update('hardware_session', {
            judge_request: {
              phase: phaseSec,
              riddle: room.current_riddle?.text ?? '',
              target: room.current_riddle?.target_keyword ?? '',
              ts: Date.now(),
            },
          })
          .catch(() => undefined);
        toast.info('Gemini is slow right now — the board is still judging your photo…');
        retryTimer = window.setTimeout(judgeCheck, ESP_JUDGE_FINAL_MS);
      } else {
        toast.error('ESP32 judge still silent — use the Pass / Fail judge override under the camera.');
      }
    };
    retryTimer = window.setTimeout(judgeCheck, ESP_JUDGE_TIMEOUT_MS);

    espJudgePhaseRef.current = phaseMs;
    const cleanup = () => {
      if (!live) return;
      live = false;
      try {
        unsub();
      } catch {
        /* already gone */
      }
      window.clearTimeout(retryTimer);
      window.clearTimeout(finalTimer);
      espJudgeCleanupRef.current = null;
      espJudgePhaseRef.current = null;
    };
    espJudgeCleanupRef.current = cleanup;
    return cleanup;
  }, [isHost, room?.state, room?.phase_started_at]);

  /* ── host actions ───────────────────────────────────────────────────── */

  const snapPhoto = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ACTIVE_TURN') return;
    // Capture is locked while no riddle is armed: the judge has
    // nothing to judge against (the physical button is gated on the board
    // too, but the web button / space key used to slip through).
    if (!r.current_riddle) {
      toast.warning('No riddle armed yet — the camera unlocks when the riddle lands.');
      return;
    }
    // Locked while the riddle is read, the host paused, or a hint plays
    const lock = buttonLock(r);
    if (lock) {
      toast.info(BUTTON_LOCK_MSG[lock]);
      return;
    }
    const frozen = Math.max(0, r.turn_timer?.time_remaining ?? 0);
    setSnapSeq((n) => n + 1);
    const myToken = ++snapTokenRef.current;
    if (!r.demo) {
      const ip = cameraIpRef.current || settingsRef.current.esp32_ip;
      setFrozenUrl(`http://${ip}/capture?t=${Date.now()}`);
      /* grab the ESP32 JPEG in the background - the SAME blob becomes both
         the frozen feed frame and the photo-moment, so the TV shows exactly
         what the judge (and history) sees. v1.6.0: the frozen frame is this
         object URL from then on, and it no longer changes when the verdict
         arrives. */
      pendingMomentRef.current = null;
      void (async () => {
        try {
          const ctrl = new AbortController();
          const t = window.setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(`http://${ip}/capture?t=${Date.now()}`, {
            signal: ctrl.signal,
          });
          window.clearTimeout(t);
          if (res.ok && snapTokenRef.current === myToken) {
            const blob = await res.blob();
            pendingMomentRef.current = blob;
            if (frozenObjRef.current) {
              try {
                URL.revokeObjectURL(frozenObjRef.current);
              } catch {
                /* already gone */
              }
            }
            const objUrl = URL.createObjectURL(blob);
            frozenObjRef.current = objUrl;
            setFrozenUrl(objUrl);
          }
        } catch {
          /* no thumbnail for this turn - gallery simply skips it */
        }
      })();
    } else {
      setFrozenUrl('mock');
      /* raw 800×450 frame - downscaled once at evaluation commit time */
      pendingMomentRef.current = captureMockFrame();
    }
    sfxShutter(settingsRef.current.muted);
    await sync.update(`rooms/${sess.pin}`, {
      state: 'EVALUATING',
      phase_started_at: Date.now(),
      turn_timer: { time_remaining: frozen, is_active: false },
    });
  }, []);

  /* ⏸ Host pause - freezes the countdown mid-turn (doorbell / snack / chaos
     management). The host interval simply stops writing; phones mirror the
     frozen DB remaining, so every screen holds still until resume. */
  const pauseTurn = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ACTIVE_TURN') return;
    if (buttonLock(r) === 'reading') {
      // The P key used to do nothing here, silently
      toast.info('The clock starts after the riddle is read — nothing to pause yet.');
      return;
    }
    if (r.paused || r.host_paused || !r.turn_timer?.is_active) return; // already frozen / not ticking
    // host_paused marks WHO owns this freeze. An auto-pause (hint
    // generation / countdown capture) may layer on top and resume by itself;
    // the manual pause stays until the host presses Resume.
    await sync
      .update(`rooms/${sess.pin}`, { paused: { at: Date.now(), reason: 'host' }, host_paused: true })
      .catch(() => undefined);
    sfxPop(settingsRef.current.muted, 0.7);
    toast.info('⏸ Countdown paused — phones frozen too.');
    void pushFeed(sess.pin, '⏸ Host paused the countdown', 'info');
  }, [pushFeed]);

  /* ▶ Host resume - re-anchors the deadline from the frozen DB remaining,
     so the paused seconds are handed back to the active player intact. */
  const resumeTurn = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ACTIVE_TURN' || (!r.paused && !r.host_paused)) return;
    const rem = Math.max(0, r.turn_timer?.time_remaining ?? 0);
    deadlineRef.current = Date.now() + rem * 1000; // re-anchor: pause cost nobody anything
    deadlineTurnRef.current = r.turn_started_at ?? Date.now();
    setLocalTimeRemaining(rem);
    lastTickSecRef.current = -1; // re-arm tick SFX
    timerWasPausedRef.current = false; // The rebase already happened here
    await sync
      .update(`rooms/${sess.pin}`, {
        paused: null,
        host_paused: null,
        turn_timer: { time_remaining: rem, is_active: true },
      })
      .catch(() => undefined);
    sfxPop(settingsRef.current.muted, 1.2);
    toast.success('▶ Countdown resumed!');
    void pushFeed(sess.pin, '▶ Host resumed the countdown', 'info');
  }, [pushFeed]);

  /* ── 🧑‍⚖️ Manual judge override (EVALUATING only) - always available:
     the board is the judge, but the host has the final word.
     "overrule" lands in ROUND_RESULTS after a WRONG verdict: the
     host manually validates the answer and awards the points, announced
     with the dedicated overrule line. */
  const handleJudgeOverride = useCallback(
    (v: 'pass' | 'fail' | 'unclear') => {
      const r = roomRef.current;
      if (!r || r.state !== 'EVALUATING') return;
      judgedPhaseRef.current = String(r.phase_started_at);
      const kw = r.current_riddle?.target_keyword ?? 'object';
      if (v === 'pass') {
        const points = r.current_riddle
          ? computeScore(r.current_riddle.difficulty, r.turn_timer.time_remaining, r.current_riddle.time_limit_sec, r.special_round_type)
          : 0;
        void applyEvaluation({
          passed: true,
          error: false,
          feedback: `Great job! That is clearly a ${kw}.`,
          timedOut: false,
          points,
        });
      } else if (v === 'fail') {
        void applyEvaluation({
          passed: false,
          error: false,
          feedback: `Incorrect proof! That did not match ${kw}.`,
          timedOut: false,
        });
      } else {
        void applyEvaluation({
          passed: false,
          error: true,
          feedback: '⚠️ Image Unclear: judge could not verify the object. Retake allowed.',
          timedOut: false,
        });
      }
    },
    [applyEvaluation],
  );

  /* 🙋 HOST OVERRULE AI (ROUND_RESULTS, after a REJECTED verdict):
     human-in-the-loop fallback whenever the AI vision is wrong. Awards the
     normal pass points and announces the dedicated overrule line. */
  const overruleAi = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ROUND_RESULTS') return;
    const ev = r.last_evaluation;
    if (!ev || ev.passed || ev.error) return; // nothing to overrule
    // A TIMEOUT has no proof photo to accept: nothing to overrule
    if (ev.timed_out) return;
    const activeId = r.active_player_id;
    const player = activeId ? r.players?.[activeId] : null;
    const riddle = r.current_riddle;
    if (!activeId || !player || !riddle) return;
    judgedPhaseRef.current = String(r.phase_started_at);
    const points = computeScore(
      riddle.difficulty,
      r.turn_timer.time_remaining,
      riddle.time_limit_sec,
      r.bonus_turn ? 'NONE' : r.special_round_type,
    );
    announce(
      `My mistake! The Host has overruled my verdict, ${player.name} earned ${points} points!`,
      undefined,
      { priority: true },
    );
    // one-shot: suppress the FX's standard "Correct! …" line for
    // this award - the overrule line above already carries it. The two lines
    // used to play back-to-back and stretched the queue the room waited on.
    suppressPassAnnounceRef.current = true;
    void pushFeed(sess.pin, `🙋 Host overruled the AI — ${player.name} gets the points!`, 'gold');
    applyEvaluation({
      passed: true,
      error: false,
      feedback: `The host overruled the AI — the proof was accepted.`,
      timedOut: false,
      points,
    });
  }, [announce, applyEvaluation, pushFeed]);

  /* 🔍 HOST CHECK (ROUND_RESULTS after an UNCLEAR verdict): the
     host looks at the proof and decides it, instead of an endless retake
     loop when the light is bad. Opening the panel marks the room
     (host_review) so the active player's phone shows "host is checking";
     Cancel returns to the retake window. Accept / Reject run through
     applyEvaluation as the turn's FIRST real verdict (source:'host_check'),
     so score, stats, streak/DDA, feed and polaroids all move together. The
     clock stays frozen at the snap-time value the whole time. */
  const setHostReview = useCallback(async (open: boolean) => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r) return;
    if (open && (r.state !== 'ROUND_RESULTS' || !r.last_evaluation?.error)) return;
    await sync
      .update(`rooms/${sess.pin}`, { host_review: open ? { ts: Date.now() } : null })
      .catch(() => undefined);
  }, []);

  const hostCheckDecide = useCallback(
    async (accept: boolean) => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      if (!sess || sess.role !== 'host' || !r || r.state !== 'ROUND_RESULTS') return;
      if (!r.last_evaluation?.error) return; // only an UNCLEAR photo is host-checked
      const activeId = r.active_player_id;
      const player = activeId ? r.players?.[activeId] : null;
      const riddle = r.current_riddle;
      if (!activeId || !player || !riddle) return;
      judgedPhaseRef.current = String(r.phase_started_at);
      unclearStreakRef.current = { key: '', n: 0 };
      setUnclearStreak(0);
      await sync.update(`rooms/${sess.pin}`, { host_review: null }).catch(() => undefined);
      if (accept) {
        const points = computeScore(
          riddle.difficulty,
          r.turn_timer.time_remaining,
          riddle.time_limit_sec,
          r.bonus_turn ? 'NONE' : r.special_round_type,
        );
        // the standard "Correct! … earned N points!" line follows from the
        // results FX (it carries the final, hint-adjusted award)
        announce('The host checked the photo!');
        void pushFeed(sess.pin, `🔍 Host checked ${player.name}'s photo — accepted!`, 'gold');
        await applyEvaluation({
          passed: true,
          error: false,
          feedback: 'The host checked the photo — accepted.',
          timedOut: false,
          points,
          source: 'host_check',
        });
      } else {
        void pushFeed(sess.pin, `🔍 Host checked ${player.name}'s photo — not a match.`, 'bad');
        await applyEvaluation({
          passed: false,
          error: false,
          feedback: 'The host checked the photo — not a match.',
          timedOut: false,
          source: 'host_check',
        });
      }
    },
    [announce, applyEvaluation, pushFeed],
  );

  /* ⏱ COUNTDOWN CAPTURE: the active player gets `t` seconds to
     step into frame before the photo fires by itself. The riddle clock is
     PAUSED for the whole window (press → capture never costs seconds).
     Started by: the host button, the active player's phone button, or the
     board's double-press (which arrives as a capture_request with a
     countdown field). The host executes the capture when the clock hits 0. */
  const startCountdown = useCallback(
    async (origin: 'host' | 'player') => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      if (!sess?.pin || !r) return;
      if (r.state !== 'ACTIVE_TURN') return;
      if (origin === 'player' && sess.role !== 'player') return;
      if (origin === 'host' && sess.role !== 'host') return;
      if (origin === 'player' && r.active_player_id !== sess.playerId) return;
      if (!r.current_riddle) {
        // Both origins get the pre-lock message (the player
        // phone used to stay silent while the riddle was still generating).
        toast.warning('No riddle armed yet — the countdown unlocks when the riddle lands.');
        return;
      }
      const lock = buttonLock(r); // v1.10.8
      if (lock) {
        toast.info(BUTTON_LOCK_MSG[lock]);
        return;
      }
      if (r.countdown) return; // already running
      const secs = Math.max(1, Math.min(10, r.countdown_secs ?? 3));
      await sync
        .update(`rooms/${sess.pin}`, {
          countdown: { secs, ts: Date.now(), origin, player_id: r.active_player_id ?? null },
        })
        .catch(() => undefined);
    },
    [],
  );

  /* 🖐 PIVOT TO PAPER (host, ACTIVE_TURN): the proof may be a
     drawing / handwritten word on paper, a whiteboard or a phone screen
     (English, Hebrew or Arabic). Announced room-wide; the judge instruction
     switches on the mirror's allow_paper flag; the riddle clock keeps
     running (sketching time is part of the challenge, per owner spec). */
  const pivotToPaper = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ACTIVE_TURN') return;
    if (!r.current_riddle) return;
    if (r.paper_mode) return; // already pivoted
    await sync.update(`rooms/${sess.pin}`, { paper_mode: true }).catch(() => undefined);
    announce('No object? No problem! Draw or write the answer on paper!');
    toast.info('Paper mode on — drawings and written answers are now accepted.');
    void pushFeed(sess.pin, '🖐 Host pivoted the proof to paper — draw or write it!', 'info');
  }, [announce, pushFeed]);

  const finishGame = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r) return;
    const rkd = rankPlayers(r.players);
    const badges = computeBadges(rkd);
    const updates: Record<string, unknown> = {
      state: 'GAME_OVER',
      phase_started_at: Date.now(),
      active_player_id: null,
      current_riddle: null,
      next_riddle: null, // A staged riddle must never outlive the match
      turn_timer: { time_remaining: 0, is_active: false },
      spotlight: null,
      paper_mode: null,
      countdown: null,
    };
    for (const { id } of rkd) {
      updates[`players/${id}/badge`] = badges[id] ?? '⭐ New Challenger';
    }
    await sync.update(`rooms/${sess.pin}`, updates);
    clearFrozen();
    // Scrub every pending board request so a finished game can
    // never leak lines/requests into the next one.
    await sync.update('hardware_session', {
      active_room: null,
      last_heartbeat: Date.now(),
      judge_request: null,
      riddle_req: null,
      hint_req: null,
    });
    const champ = rkd[0];
    await pushFeed(sess.pin, `🏆 Match complete — ${champ ? `${champ.player.name} wins!` : 'gg!'}`, 'gold');
    /* 👑 crown the single most valuable accepted proof (tie → earliest) */
    const best = (r.moments ?? [])
      .filter((m) => m.verdict === 'pass' && m.points > 0)
      .sort((a, b) => b.points - a.points || a.ts - b.ts)[0];
    if (best) {
      // The best-moment VOICE line is retired -
      // the game-over speak is now the single merged champion line; the
      // moment itself stays visible in the feed + gallery below.
      await pushFeed(sess.pin, `👑 Best moment: ${best.player_name}'s “${best.keyword}” — +${best.points} pts!`, 'gold');
    }
  }, [clearFrozen, pushFeed]);

  const continueTurnCore = useCallback(async () => {
    const sess0 = sessionRef.current;
    const r0 = roomRef.current;
    if (!sess0 || sess0.role !== 'host' || !r0 || r0.state !== 'ROUND_RESULTS') return;
    // Continuing past an unclear photo closes any open Host Check
    if (r0.host_review) void sync.update(`rooms/${sess0.pin}`, { host_review: null }).catch(() => undefined);
    /* SPEECH-GATED ADVANCE: let the board finish the results
       lines (overrule / verdict / streak hype) BEFORE the next full-screen
       banner flashes. The overrule cascade queued five lines; the screen
       used to reach ROUND_FLASH while the speaker was still two lines
       behind - the "flashed before it began to say the words" report.
       Bounded by BOARD_LINE_PATIENCE_MS, and skipped entirely when the
       laptop owns the voice or the board is gone. State is re-read after
       the wait: the room may have moved meanwhile. */
    await waitForBoardSpeech(BOARD_LINE_PATIENCE_MS);
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ROUND_RESULTS') return;
    const wasBonusTurn = Boolean(r.bonus_turn);
    const roundSpecial = specialForRound(r.current_round, r.num_rounds);
    const activeId = r.active_player_id;

    /* 🎁 Bonus round reward: in the round scheduled as BONUS, every
       player whose MAIN riddle solve was accepted earns an immediate
       personal bonus riddle (normal points, no penalty, DDA skipped).
       One bonus per player per round; the bonus riddle itself never chains. */
    if (
      !wasBonusTurn &&
      roundSpecial === 'BONUS' &&
      activeId &&
      r.last_evaluation?.passed &&
      r.last_evaluation.points_earned > 0
    ) {
      const name = r.players?.[activeId]?.name ?? 'Player';
      await sync.update(`rooms/${sess.pin}`, {
        bonus_turn: { player_id: activeId, round: r.current_round, ts: Date.now() },
        active_player_id: activeId,
        state: 'CALLOUT',
        phase_started_at: Date.now(),
        last_evaluation: null,
        current_riddle: null,
        // A staged next-MAIN riddle survives the bonus mini-turn:
        // it belongs to the turn AFTER the bonus and must not be discarded
        // (it would force a regenerate-and-wait later).
        turn_timer: { time_remaining: 0, is_active: false },
        turn_started_at: null,
        hint: null,
        hint_used_turn: null,
        hint_request: null, // A stale request must never block the next clock
        host_review: null, // Host Check dies with the turn
        paper_mode: null,
        countdown: null,
      });
      // New bonus unlock wording.
      announce(`Amazing, ${name}! You get a bonus riddle!`);
      await pushFeed(sess.pin, `🎁 ${name} earned a BONUS RIDDLE!`, 'gold');
      toast(`🎁 Bonus riddle for ${name}!`, { icon: '🎁' });
      return;
    }

    let pos = (r.turn_pos ?? 0) + 1;
    let round = r.current_round;
    if (pos >= (r.turn_order?.length ?? 0)) {
      pos = 0;
      round += 1;
      if (round > r.num_rounds) {
        await finishGame();
        return;
      }
      // Rebuild the play order so mid-game joiners get their turn.
      // (defensive: skip malformed player nodes - never let garbage into the order)
      const freshOrder = Object.entries(r.players ?? {})
        .filter(([, p]) => p && typeof p === 'object' && typeof p.name === 'string')
        .sort((a, b) => a[1].joined_at - b[1].joined_at)
        .map(([id]) => id);
      await sync.update(`rooms/${sess.pin}`, {
        turn_pos: pos,
        current_round: round,
        turn_order: freshOrder,
        state: 'INTRO',
        phase_started_at: Date.now(),
        active_player_id: null,
        last_evaluation: null,
        current_riddle: null,
        // KEEP the staged next_riddle! Nulling it here threw away a
        // riddle the board had JUST finished generating and forced a full
        // regeneration during the round banners (the 12-27 s round
        // transitions - the "27 s while it already said
        // Next riddle ready" case). startActiveTurn moves the staged riddle
        // into current_riddle instantly when its turn goes live.
        bonus_turn: null,
        special_round_type: specialForRound(round, r.num_rounds),
        paper_mode: null,
        countdown: null,
      });
      await pushFeed(sess.pin, `🎬 Round ${round} of ${r.num_rounds} starting!`, 'info');
      /* 🎲 prefetch the new round's first riddle while the banners play
         (staged into next_riddle, never shown before its turn).
         SKIPPED when a staged record for THIS room + the next
         player already exists: the post-verdict prefetch already minted one
         (and the board already generated it) - minting again re-armed the
         board, wasted a generation and swapped the staged answer. */
      const firstId = freshOrder[pos];
      const fp = firstId ? r.players?.[firstId] : null;
      const stagedRec = stagedReqRef.current;
      const stagedMatches =
        stagedRec && stagedRec.pin === sess.pin &&
        stagedRec.reason === 'turn' &&
        stagedRec.player === (fp?.name ?? '');
      if (fp && !stagedMatches) {
        await writeRiddleReq('turn', {
          id: firstId,
          name: fp.name,
          difficulty: ddaDiffRef.current.get(firstId) ?? fp.current_difficulty,
        }, 0, 'hold');
      }
    } else {
      // Two-flash glitch: this branch used to write a
      // nameless CALLOUT snapshot first and then re-write the real one
      // inside enterCallout - two DB snapshots, two banner keys, two voice
      // lines ~300-600 ms apart, and flash #1 rendered the generic
      // ", STEP UP!" with no name (non-first players only; round openers go
      // through single-write paths). ONE write owns the transition now:
      // enterCallout computes the next active id (skip-missing loop) and
      // patches CALLOUT exactly once. The stale roomRef.current re-read
      // between the two writes is gone with it.
      await enterCallout(sess.pin, r, pos);
    }
    // The results screen is over: release the frozen proof frame.
    clearFrozen();
  }, [announce, clearFrozen, enterCallout, finishGame, pushFeed, waitForBoardSpeech, writeRiddleReq]);

  /* Continue waits for the board to finish the results
     lines (up to BOARD_LINE_PATIENCE_MS) and looked dead meanwhile, so it got
     clicked again and again. One advance at a time, and the button shows the
     wait (continueBusy) instead of silently swallowing presses. */
  const continueTurn = useCallback(async () => {
    if (continueBusyRef.current) return;
    continueBusyRef.current = true;
    setContinueBusy(true);
    try {
      await continueTurnCore();
    } finally {
      continueBusyRef.current = false;
      setContinueBusy(false);
    }
  }, [continueTurnCore]);

  /* 🔁 Instant retake (host, ROUND_RESULTS + unclear only): grab a fresh
     frame from the camera RIGHT NOW, jump back to EVALUATING with the
     countdown still frozen (the player never loses seconds for a blurred
     shot), and let the judge engine look at the new photo. Triggered by
     the amber Retake button, the R key, or the physical camera button. */
  const retakePhoto = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'ROUND_RESULTS') return;
    if (!r.last_evaluation?.error) return;
    const frozen = Math.max(0, r.turn_timer?.time_remaining ?? 0);
    setSnapSeq((n) => n + 1);
    const myToken = ++snapTokenRef.current;
    clearFrozen();
    if (!r.demo) {
      const ip = cameraIpRef.current || settingsRef.current.esp32_ip;
      const url = `http://${ip}/capture?t=${Date.now()}`;
      setFrozenUrl(url);
      pendingMomentRef.current = null;
      void (async () => {
        try {
          const ctrl = new AbortController();
          const t = window.setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(url, { signal: ctrl.signal });
          window.clearTimeout(t);
          if (res.ok && snapTokenRef.current === myToken) {
            const blob = await res.blob();
            pendingMomentRef.current = blob;
            if (frozenObjRef.current) {
              try {
                URL.revokeObjectURL(frozenObjRef.current);
              } catch {
                /* already gone */
              }
            }
            const objUrl = URL.createObjectURL(blob);
            frozenObjRef.current = objUrl;
            setFrozenUrl(objUrl);
          }
        } catch {
          /* no thumbnail for this retake - gallery simply skips it */
        }
      })();
    } else {
      setFrozenUrl('mock');
      pendingMomentRef.current = captureMockFrame();
    }
    sfxShutter(settingsRef.current.muted);
    await sync.update(`rooms/${sess.pin}`, {
      state: 'EVALUATING',
      phase_started_at: Date.now(),
      last_evaluation: null,
      turn_timer: { time_remaining: frozen, is_active: false },
      host_review: null, // A retake closes any Host Check
    });
  }, [clearFrozen]);

  const startMatch = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'LOBBY') return;
    /* Start gating: real matches need a live board. Demo rooms start free. */
    if (!r.demo && !espStatusRef.current) {
      toast.warning('Waiting for hardware — power the camera board and keep it on WiFi.');
      return;
    }
    const ids = Object.entries(r.players ?? {})
      .filter(([, p]) => p && typeof p === 'object' && typeof p.name === 'string')
      .sort((a, b) => a[1].joined_at - b[1].joined_at)
      .map(([id]) => id);
    if (!ids.length) {
      toast.warning('At least 1 player is required to start!');
      return;
    }
    await sync.update(`rooms/${sess.pin}`, {
      state: 'INTRO',
      phase_started_at: Date.now(),
      current_round: 1,
      turn_pos: 0,
      turn_order: ids,
      special_round_type: specialForRound(1, r.num_rounds),
      active_player_id: null,
    });
    /* 🎲 The FIRST riddle is generated at lobby close: ask the board
       while the INTRO/ROUND_FLASH/CALLOUT banners play so the riddle is
       usually ready by the time the first turn goes live.
       Staged (publish:"hold") into next_riddle so it can never
       flash on screen during the banners.
       The lobby PREFETCH effect usually minted this while players
       were still joining (their themes/difficulty already shape the prompt);
       reuse that staged request so Gemini's answer isn't thrown away. */
    const firstId = ids[0];
    const fp = r.players?.[firstId];
    const staged = stagedReqRef.current;
    const stagedForThisRoom = staged && staged.pin === sess.pin ? staged : null;
    if (fp && !r.demo && (!stagedForThisRoom || stagedForThisRoom.player !== fp.name)) {
      await writeRiddleReq('turn', {
        id: firstId,
        name: fp.name,
        difficulty: ddaDiffRef.current.get(firstId) ?? fp.current_difficulty,
      }, 0, 'hold');
    }
  }, [writeRiddleReq]);

  const createGame = useCallback(
    async (cfg: CreateGameConfig): Promise<LocalSession | null> => {
      // Hardware lock check
      const hwNow = await sync.get('hardware_session');
      const busy =
        hwNow &&
        (hwNow as HardwareSession).active_room &&
        Date.now() - (hwNow as HardwareSession).last_heartbeat < HW_LOCK_STALE_MS;
      if (busy) {
        toast.error(
          `Cannot create game! Room ${(hwNow as HardwareSession).active_room} is already active on the ESP32 hardware.`,
        );
        return null;
      }
      let hostDeviceId = '';
      try {
        hostDeviceId = window.localStorage.getItem(HOST_DEVICE_KEY) ?? '';
        if (!hostDeviceId) {
          hostDeviceId = newId('host');
          window.localStorage.setItem(HOST_DEVICE_KEY, hostDeviceId);
        }
      } catch {
        hostDeviceId = newId('host');
      }
      // Unique 4-digit PIN
      let roomPin = '';
      for (let i = 0; i < 12; i++) {
        const candidate = String(Math.floor(1000 + Math.random() * 9000));

        const exists = await sync.get(`rooms/${candidate}`);
        if (exists == null) {
          roomPin = candidate;
          break;
        }
      }
      if (!roomPin) {
        toast.error('Could not allocate a Room PIN — try again.');
        return null;
      }
      const newRoom: Room = {
        pin: roomPin,
        host_device_id: hostDeviceId,
        game_name: cfg.name,
        num_rounds: cfg.rounds,
        current_round: 1,
        state: 'LOBBY',
        demo: cfg.demo ?? false,
        // host-picked environment + playstyle + countdown length
        environment: cfg.environment ?? 'house',
        playstyle: cfg.playstyle ?? DEFAULT_PLAYSTYLE_ID,
        countdown_secs: Math.max(1, Math.min(10, cfg.countdownSecs ?? 3)),
        active_player_id: null,
        turn_order: [],
        turn_pos: 0,
        special_round_type: 'NONE',
        current_riddle: null,
        next_riddle: null,
        turn_timer: { time_remaining: 0, is_active: false },
        last_evaluation: null,
        players: {},
        reactions: null,
        excluded_keywords: [],
        capture_request: null,
        hint_request: null,
        hint: null,
        hint_used_turn: null,
        hint_tokens_per_player: cfg.hintTokens ?? DEFAULT_HINT_TOKENS,
        bonus_turn: null,
        spotlight: null,
        paper_mode: null,
        countdown: null,
        feed: null,
        moments: null,
        phase_started_at: Date.now(),
        turn_started_at: null,
        created_at: Date.now(),
      };
      /* Reset ALL cross-room request bookkeeping the moment a new
         room is created. The refs are component-global, so without this a
         previous room's staged record / req id leaks into the new room:
         the lobby prefetch stays silent, startMatch trusts the stale
         "matching" request, and the first turn sits in "Preparing
         riddle…" for minutes (the 3rd-room field report). */
      lastReqIdRef.current = 0;
      lastReqSentAtRef.current = 0;
      lastReqArmedAtRef.current = 0;
      lastReqPlayerRef.current = '';
      lastReqReasonRef.current = 'turn';
      lastReqProofRef.current = ''; // v1.9.0
      lastProofsRef.current = null; // v1.9.0
      ddaDiffRef.current.clear(); // A new match restarts DDA bookkeeping
      lastHintForwardRef.current = 0; // v1.9.0
      timerWasPausedRef.current = false; // v1.9.0
      stagedReqRef.current = null;
      lastCountdownTsRef.current = 0;
      lastAnnounceTextRef.current = '';
      lastAnnounceTextAtRef.current = 0;
      cmdqWrittenRef.current = 0; // The trim counter is per game too
      await sync.set(`rooms/${roomPin}`, newRoom);
      // A NEW game starts with a scrubbed board channel: no stale
      // cmd line from the previous match can ever be spoken again.
      await sync.update('hardware_session', {
        active_room: roomPin,
        last_heartbeat: Date.now(),
        cmd: null,
        cmdq: null,
        judge_request: null,
        riddle_req: null,
        hint_req: null,
      });
      const sess: LocalSession = {
        role: 'host',
        hostDeviceId,
        playerId: '',
        pin: roomPin,
        name: '',
        tier: 'Standard',
        themes: [],
      };
      setSession(sess);
      persistSession(sess);
      setViewIntent(null);
      toast.success(`Room ${roomPin} created — share the PIN!`);
      return sess;
    },
    [persistSession],
  );

  const quickDemo = useCallback(async () => {
    setDemoBusy(true);
    const sess = await createGame({ name: 'Demo Match', rounds: 3, demo: true });
    const bots: Array<{ name: string; tier: Player['tier'] }> = [
      { name: 'Maya', tier: 'Standard' },
      { name: 'Alex', tier: 'Casual' },
      { name: 'Sam', tier: 'Expert' },
    ];
    const players: Record<string, Player> = {};
    const base = Date.now();
    bots.forEach((b, i) => {
      players[newId('p')] = emptyPlayer(b.name, b.tier, i, true, base + i, DEFAULT_HINT_TOKENS);
    });
    if (sess) {
      await sync.update(`rooms/${sess.pin}/players`, players);
      await pushFeed(sess.pin, '👋 Maya, Alex & Sam joined the demo!', 'info');
    }
    setDemoBusy(false);
  }, [createGame, pushFeed]);

  const exitRoom = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    // Leaving a room retires its request bookkeeping: a new game
    // created afterwards must start with a clean request slate.
    lastReqIdRef.current = 0;
    lastReqSentAtRef.current = 0;
    lastReqArmedAtRef.current = 0;
    lastReqPlayerRef.current = '';
    lastReqReasonRef.current = 'turn';
    lastReqProofRef.current = ''; // v1.9.0
    lastProofsRef.current = null; // v1.9.0
    ddaDiffRef.current.clear(); // v1.9.0
    lastHintForwardRef.current = 0; // v1.9.0
    timerWasPausedRef.current = false; // v1.9.0
    stagedReqRef.current = null;
    lastCountdownTsRef.current = 0;
    if (sess.pin) await sync.remove(`rooms/${sess.pin}`).catch(() => undefined);
    await sync.update('hardware_session', {
      active_room: null,
      last_heartbeat: Date.now(),
      cmd: null,
      cmdq: null, // Nothing queued outlives the room
      judge_request: null,
      riddle_req: null,
      hint_req: null,
    });
    clearSession();
  }, [clearSession]);

  const leaveLobby = useCallback(async () => {
    await exitRoom();
  }, [exitRoom]);

  /* 💡 The host picks free hint tokens per player in the lobby (0-3,
     default 2). Applied to the room config AND every player already in it. */
  const setHintTokens = useCallback(async (n: number) => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'LOBBY') return;
    const tokens = Math.max(0, Math.min(3, Math.round(n)));
    const updates: Record<string, unknown> = { hint_tokens_per_player: tokens };
    for (const id of Object.keys(r.players ?? {})) {
      updates[`players/${id}/hint_tokens`] = tokens;
    }
    await sync.update(`rooms/${sess.pin}`, updates).catch(() => undefined);
  }, []);

  /* ⏱ The host picks the Countdown Capture length in the lobby
     (1-10 s, default 3 - the selector sits right next to the hint tokens). */
  const setCountdownSecs = useCallback(async (n: number) => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'host' || !r || r.state !== 'LOBBY') return;
    const secs = Math.max(1, Math.min(10, Math.round(n)));
    await sync.update(`rooms/${sess.pin}`, { countdown_secs: secs }).catch(() => undefined);
  }, []);

  /* ── player actions ─────────────────────────────────────────────────── */

  const joinGame = useCallback(
    async (form: JoinForm) => {
      const data = await sync.get(`rooms/${form.pin}`);
      if (data == null) {
        toast.error('Invalid Room PIN! Please check the Host TV screen.');
        return;
      }
      const r = data as Room;
      if (r.state === 'GAME_OVER') {
        toast.error('That match already finished — ask the host for a new room.');
        return;
      }
      const existingCount = Object.keys((r.players as Record<string, Player>) ?? {}).length;
      if (existingCount >= MAX_PLAYERS) {
        toast.error(`Room is full! This match already has ${MAX_PLAYERS} players.`);
        return;
      }
      // UNIQUE NICKNAMES: the Voice Master calls players by name, so
      // two identical names in one room would be indistinguishable on the TV
      // and in the announcements (a real field finding - duplicates used to
      // be allowed silently).
      const wanted = form.name.trim().toLowerCase();
      const nameTaken = Object.values((r.players as Record<string, Player>) ?? {}).some(
        (p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim().toLowerCase() === wanted,
      );
      if (nameTaken) {
        toast.error(`The name “${form.name.trim()}” is already taken in this room — pick another.`);
        return;
      }
      const playerId = newId('p');
      const player = emptyPlayer(
        form.name,
        form.tier,
        existingCount,
        false,
        Date.now(),
        r.hint_tokens_per_player ?? DEFAULT_HINT_TOKENS,
      );
      await sync.set(`rooms/${form.pin}/players/${playerId}`, player);
      await pushFeed(form.pin, `👋 ${form.name} joined the game!`, 'info');
      const sess: LocalSession = {
        role: 'player',
        hostDeviceId: '',
        playerId,
        pin: form.pin,
        name: form.name,
        tier: form.tier,
      };
      setSession(sess);
      persistSession(sess);
      sfxJoin(settingsRef.current.muted);
      toast.success(`Joined room ${form.pin} — good luck, ${form.name}!`);
    },
    [persistSession, pushFeed],
  );

  /* 💡 Player requests a hint. Free while tokens last; afterwards the
     SOLVE pays half its points (the old flat −100 up-front charge
     is gone; the cost is realized at evaluation instead). The host engine
     forwards the request to the board, which generates the Gemini hint and
     speaks it to the whole room - only the requester paid.
     GATED like the physical button: no riddle armed yet (the
     board is still generating) → refused with a visible error toast. */
  const requestHint = useCallback(async () => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'player' || !r || r.state !== 'ACTIVE_TURN') return;
    if (r.active_player_id !== sess.playerId) return;
    if (!r.current_riddle) {
      toast.error('The riddle is still being written — hints unlock once it lands!');
      return;
    }
    const lock = buttonLock(r); // v1.10.8
    if (lock) {
      toast.info(BUTTON_LOCK_MSG[lock]);
      return;
    }
    // No hint during a countdown window: the countdown already owns
    // the clock pause and would resume the clock mid-hint
    if (r.countdown) {
      toast.info('Wait for the countdown photo — hints unlock after it.');
      return;
    }
    const me = r.players?.[sess.playerId];
    if (!me) return;
    const tokens = me.hint_tokens ?? 0;
    const updates: Record<string, unknown> = {
      hint_request: { player_id: sess.playerId, ts: Date.now() },
    };
    if (tokens > 0) {
      updates[`players/${sess.playerId}/hint_tokens`] = tokens - 1;
    }
    updates[`players/${sess.playerId}/stats/hints_used`] = (me.stats?.hints_used ?? 0) + 1;
    await sync.update(`rooms/${sess.pin}`, updates);
  }, []);

  const leaveRoomPlayer = useCallback(async () => {
    const sess = sessionRef.current;
    if (sess?.pin && sess.playerId) {
      await sync.remove(`rooms/${sess.pin}/players/${sess.playerId}`).catch(() => undefined);
    }
    clearSession();
  }, [clearSession]);

  /* ── emoji reactions (player phone → host TV) ───────────────────────── */

  const sendReaction = useCallback(async (emoji: string, combo?: number) => {
    const sess = sessionRef.current;
    if (!sess || sess.role !== 'player' || !sess.pin) return;
    try {
      const cur = (await sync.get(`rooms/${sess.pin}/reactions`)) as ReactionEvent[] | null;
      const arr = Array.isArray(cur) ? cur : [];
      const ev: ReactionEvent = {
        id: newId('r'),
        emoji,
        ts: Date.now(),
        by: sess.playerId,
        name: sess.name,
        ...(combo && combo >= 2 ? { combo } : {}),
      };
      await sync.set(`rooms/${sess.pin}/reactions`, [...arr, ev].slice(-12));
    } catch {
      /* reactions are cosmetic - never block the controller */
    }
  }, []);

  /* ── host hype: spotlight one player (gold glow on TV + phone) ────── */

  const toggleSpotlight = useCallback(
    async (playerId: string, name: string) => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      if (!sess || sess.role !== 'host' || !sess.pin || !r) return;
      const isOn = r.spotlight?.player_id === playerId;
      await sync
        .update(`rooms/${sess.pin}`, {
          spotlight: isOn ? null : { player_id: playerId, ts: Date.now() },
        })
        .catch(() => undefined);
      if (isOn) return;
      sfxPop(settingsRef.current.muted, 1.15);
      toast.info(`🌟 ${name} is in the spotlight!`);
      void pushFeed(sess.pin, `🌟 ${name} got the host spotlight!`, 'gold');
    },
    [pushFeed],
  );

  /* ── 🎺 Host sound board - one tap blasts a party jingle on the TV and
     every connected phone (keys 1-4). Works in any room phase. ────────── */
  const playSoundCue = useCallback(
    async (sound: SoundCueId) => {
      const sess = sessionRef.current;
      if (!sess || sess.role !== 'host' || !sess.pin) return;
      sfxSoundBoard(settingsRef.current.muted, sound);
      const meta = SOUND_CUES.find((s) => s.id === sound);
      toast(`${meta?.emoji ?? '🎺'} ${meta?.label ?? sound}!`, { icon: meta?.emoji });
      await sync
        .update(`rooms/${sess.pin}`, { sfx_cue: { sound, ts: Date.now() } })
        .catch(() => undefined);
      if (meta) void pushFeed(sess.pin, meta.feedText, 'info');
    },
    [pushFeed],
  );

  /* ── 💬 Player caption for their accepted proof photo - goes to the host
     engine via a request channel (phones never write the moments array) ── */
  const submitCaption = useCallback(async (momentId: string, text: string) => {
    const sess = sessionRef.current;
    const r = roomRef.current;
    if (!sess || sess.role !== 'player' || !r) return;
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean || !clean.length) return;
    await sync
      .update(`rooms/${sess.pin}`, {
        caption_request: {
          moment_id: momentId,
          player_id: sess.playerId,
          player_name: sess.name,
          text: clean,
          ts: Date.now(),
        },
      })
      .catch(() => undefined);
  }, []);

  /* Host listener: attach the caption to its moment + celebrate it in the feed. */
  useEffect(() => {
    if (!isHost || !room || room.state !== 'ROUND_RESULTS') return;
    const cr = room.caption_request;
    if (!cr || !cr.ts || cr.ts === lastCaptionRef.current) return;
    lastCaptionRef.current = cr.ts;
    const moment = (room.moments ?? []).find((m) => m.id === cr.moment_id);
    if (!moment || moment.caption) {
      // stale or duplicate request - just clear it
      void sync.update(`rooms/${room.pin}`, { caption_request: null }).catch(() => undefined);
      return;
    }
    void (async () => {
      const r2 = roomRef.current;
      if (!r2) return;
      const moments = (r2.moments ?? []).map((m) =>
        m.id === cr.moment_id ? { ...m, caption: cr.text } : m,
      );
      await sync.set(`rooms/${r2.pin}/moments`, moments).catch(() => undefined);
      await sync.update(`rooms/${r2.pin}`, { caption_request: null }).catch(() => undefined);
      sfxPop(settingsRef.current.muted, 1.05);
      toast(`💬 ${cr.player_name} captioned the moment!`, { icon: '💬' });
      void pushFeed(
        r2.pin,
        `💬 ${moment.player_name} captioned their “${moment.keyword}” proof: “${cr.text}”`,
        'info',
      );
    })();
  }, [isHost, room?.state, room?.caption_request?.ts, pushFeed]);

  /* ── ✏️ host caption moderation - tweak or clear a player's photo caption.
     The host owns the moments array, so edits are written directly. ── */
  const editCaption = useCallback(
    async (momentId: string, text: string | null) => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      if (!sess || sess.role !== 'host' || !sess.pin || !r) return;
      const target = (r.moments ?? []).find((m) => m.id === momentId);
      if (!target) return;
      const moments = (r.moments ?? []).map((m) => {
        if (m.id !== momentId) return m;
        const next: PhotoMoment = { ...m };
        if (text && text.trim()) next.caption = text.trim().replace(/\s+/g, ' ').slice(0, 60);
        else delete next.caption;
        return next;
      });
      await sync.set(`rooms/${sess.pin}/moments`, moments).catch(() => undefined);
      sfxPop(settingsRef.current.muted, 1.05);
      if (text && text.trim()) {
        const clean = text.trim().replace(/\s+/g, ' ').slice(0, 60);
        toast(`✏️ Caption updated — “${clean}”`, { icon: '💬' });
        void pushFeed(sess.pin, `✏️ Host updated the caption on ${target.player_name}'s photo: “${clean}”`, 'info');
      } else {
        toast.info('Caption cleared from the gallery.');
        void pushFeed(sess.pin, `✏️ Host cleared the caption on ${target.player_name}'s photo`, 'info');
      }
    },
    [pushFeed],
  );

  /* ── host moderation: kick a player from the lobby ──────────────────── */

  const kickPlayer = useCallback(
    async (playerId: string, name: string) => {
      const sess = sessionRef.current;
      const r = roomRef.current;
      if (!sess || sess.role !== 'host' || !sess.pin || !r) return;
      if (r.state !== 'LOBBY') {
        toast.warning('Players can only be removed while in the lobby.');
        return;
      }
      await sync.remove(`rooms/${sess.pin}/players/${playerId}`).catch(() => undefined);
      await pushFeed(sess.pin, `🚫 ${name} was removed by the host`, 'bad');
      toast.info(`${name} was removed from the lobby.`);
    },
    [pushFeed],
  );

  /* ── reset lobby presence memory when the room changes ─────────────── */
  useEffect(() => {
    knownPlayersRef.current = null;
  }, [pin]);

  /* 👋 Host lobby presence chimes - every NEW player in the lobby gets the
     TV a join jingle + toast, so the host never misses an arrival while
     setting up. Leaves (incl. kicks) are announced once too. First sight
     of a room seeds silently (no replay of history on refresh). */
  useEffect(() => {
    if (!isHost || !room) return;
    const players = room.players ?? {};
    const prev = knownPlayersRef.current;
    const now = new Map<string, string>(
      Object.entries(players)
        .filter(([, p]) => p && typeof p === 'object' && typeof p.name === 'string')
        .map(([id, p]) => [id, p.name]),
    );
    knownPlayersRef.current = now;
    if (!prev) return; // first sight - seed only
    const joined = [...now.keys()].filter((id) => !prev.has(id));
    const left = [...prev.keys()].filter((id) => !now.has(id));
    if (room.state !== 'LOBBY') return; // chimes are a lobby thing
    for (const id of joined) {
      const name = now.get(id);
      if (!name) continue;
      sfxJoin(settingsRef.current.muted);
      toast.success(`👋 ${name} joined the lobby!`);
    }
    for (const id of left) {
      const name = prev.get(id);
      if (!name) continue;
      toast.info(`👋 ${name} left the lobby.`, { icon: '🚪' });
    }
  }, [isHost, room]);

  /* ── player presence heartbeat (reconnect awareness) ────────────────── */
  useEffect(() => {
    if (session?.role !== 'player' || !session.pin || !session.playerId) return;
    const path = `rooms/${session.pin}/players/${session.playerId}/last_seen`;
    /* Heartbeat only while MY real player node still exists. A
       kicked player's phone used to keep writing last_seen for minutes,
       recreating a nameless zombie node under the live room - which then
       crashed the host's lobby render (the charAt/themes errors). */
    const beat = () => {
      const mine = roomRef.current?.players?.[session.playerId];
      if (!mine || typeof mine !== 'object' || typeof mine.name !== 'string') return;
      void sync.set(path, Date.now()).catch(() => undefined);
    };
    beat();
    const iv = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(iv);
  }, [session?.role, session?.pin, session?.playerId]);

  /* ── kicked-from-room detection (player) ─────────────────────────────── */
  useEffect(() => {
    if (!room || session?.role !== 'player' || !session.playerId) return;
    const mine = room.players?.[session.playerId];
    // A REAL player node always carries its name. A nameless
    // leftover (zombie heartbeat recreate) counts as gone too - otherwise
    // the kicked phone would sit on a broken controller forever.
    if (mine && typeof mine === 'object' && typeof mine.name === 'string') return;
    // My player node vanished - confirm against the DB before bouncing.
    const t = window.setTimeout(async () => {
      const still = await sync
        .get(`rooms/${session.pin}/players/${session.playerId}`)
        .catch(() => 'error');
      if (
        still == null ||
        typeof still !== 'object' ||
        typeof (still as { name?: unknown }).name !== 'string'
      ) {
        toast.error('The host removed you from the room.');
        clearSession();
      }
    }, 1400);
    return () => window.clearTimeout(t);
  }, [room, session?.role, session?.playerId, session?.pin, clearSession]);

  /* ── host: keep the reactions buffer small + heal malformed player nodes ── */
  useEffect(() => {
    if (!isHost || !pin || !room) return;
    const rx = room.reactions;
    if (rx && rx.length > 12) {
      void sync.set(`rooms/${pin}/reactions`, rx.slice(-6)).catch(() => undefined);
    }
    /* heal: a malformed players/{key} node (e.g. from an older bug) would
       otherwise leak into the play order and crash the dashboard */
    const badKeys = Object.entries(room.players ?? {})
      .filter(([, p]) => !(p && typeof p === 'object' && typeof p.name === 'string'))
      .map(([k]) => k);
    if (badKeys.length) {
      void sync
        .set(
          `rooms/${pin}/players`,
          Object.fromEntries(
            Object.entries(room.players ?? {}).filter(
              ([, p]) => p && typeof p === 'object' && typeof p.name === 'string',
            ),
          ),
        )
        .catch(() => undefined);
      toast.info('Cleaned up a corrupted player entry.');
    }
  }, [isHost, pin, room, room?.reactions, room?.players]);

  /* ── listener effects: GPIO capture requests (host) ─────────────────── */
  useEffect(() => {
    if (!isHost || !room) return;
    const raw = room.capture_request ?? 0;
    // The body is either the legacy epoch-ms number (single press)
    // or {ts, countdown} (double press → timed capture). ts drives dedupe.
    const cr = typeof raw === 'object' && raw ? (raw.ts ?? 0) : Number(raw) || 0;
    if (!cr || cr <= lastCaptureRef.current) return;
    lastCaptureRef.current = cr;
    const cd = typeof raw === 'object' && raw ? Math.max(0, Math.round(raw.countdown ?? 0)) : 0;
    if (room.state === 'ACTIVE_TURN') {
      // Mirror of the board-side gate: no armed riddle → no capture
      // (the judge has nothing to check the photo against).
      if (!room.current_riddle) {
        toast.warning('Camera button pressed, but no riddle is armed yet — ignored.');
        return;
      }
      // The board gates on its mirror too, but that copy can lag
      // the room by ~1 s; the host's own state is the authority.
      const lock = buttonLock(room);
      if (lock) {
        toast.info(`Camera button pressed — ${BUTTON_LOCK_MSG[lock]}`);
        return;
      }
      // A second double press must not restart a running window
      // (the web Countdown button already refuses; the board path did not)
      if (cd > 0 && room.countdown) {
        toast.info('Countdown already running — the photo fires by itself.');
        return;
      }
      if (cd > 0) {
        // DOUBLE PRESS on the physical button → countdown capture:
        // reuse the exact same window as the web buttons (paused clock +
        // auto capture when the timer hits 0).
        toast.info(`📸 Double press — ${cd}s countdown capture!`);
        void sync
          .update(`rooms/${room.pin}`, {
            countdown: { secs: cd, ts: Date.now(), origin: 'esp', player_id: room.active_player_id ?? null },
          })
          .catch(() => undefined);
        return;
      }
      toast.info('📸 Camera button pressed — capturing proof!');
      void snapPhoto();
    } else if (room.state === 'ROUND_RESULTS' && room.last_evaluation?.error) {
      // While the host is checking the photo, the button can't
      // pull the rug out from under the decision
      if (room.host_review) {
        toast.info('Camera button pressed — ignored while the host checks the photo.');
        return;
      }
      // A DOUBLE press during the retake window
      // runs the same Countdown Capture as a live turn - the window
      // gives the player time to step back into frame, then the RETAKE
      // fires itself (it used to be ignored with "needs a live turn").
      if (cd > 0 && room.countdown) {
        toast.info('Countdown already running — the retake fires by itself.'); // v1.10.8
        return;
      }
      if (cd > 0) {
        toast.info(`📸 Double press — ${cd}s countdown retake!`);
        void sync
          .update(`rooms/${room.pin}`, {
            countdown: { secs: cd, ts: Date.now(), origin: 'esp', player_id: room.active_player_id ?? null },
          })
          .catch(() => undefined);
        return;
      }
      toast.info('📸 Camera button pressed — retaking the unclear photo!');
      void retakePhoto();
    }
  }, [isHost, room?.state, room?.capture_request, room?.current_riddle, room?.pin, room?.active_player_id, room?.host_review, snapPhoto, retakePhoto]);

  /* ⏱ countdown-capture driver (host): watches rooms/{pin}/countdown,
     pauses the riddle clock for the window, then fires the capture at 0.
     NOTE: the fire/safety timers are (RE)ARMED ON EVERY RUN - the effect
     re-runs on every room snapshot and its cleanup cancels the previous
     timers, so an early-return-on-seen guard would leave NO live timer and
     the capture would never fire (caught in E2E). Only the one-shot pause
     write is guarded by the ts. */
  useEffect(() => {
    if (!isHost || !room) return;
    // The countdown window also serves the RETAKE parity path
    // (board double-press during the unclear-retake window). ACTIVE_TURN
    // pauses the live clock for the window; ROUND_RESULTS+unclear just
    // shows the window and re-fires the retake at 0 (no clock to pause -
    // it is already frozen).
    const retakeMode = room.state === 'ROUND_RESULTS' && Boolean(room.last_evaluation?.error);
    if (room.state !== 'ACTIVE_TURN' && !retakeMode) return;
    const cd = room.countdown;
    if (!cd || !cd.ts) return;
    // A countdown node older than 25 s is a CORPSE (crashed round,
    // stale DB child). Clear it instead of letting any overlay do the math
    // on a dead timestamp - the "random big number before the 3" glitch class.
    if (Date.now() - cd.ts > 25000) {
      void sync.update(`rooms/${room.pin}`, { countdown: null }).catch(() => undefined);
      return;
    }
    if (cd.ts !== lastCountdownTsRef.current) {
      lastCountdownTsRef.current = cd.ts;
      // freeze the riddle clock for the whole window (press → capture is free)
      // Never over an owned host pause (the host pause stays)
      if (room.state === 'ACTIVE_TURN' && room.turn_started_at && !room.paused && !room.host_paused) {
        void sync
          .update(`rooms/${room.pin}`, { paused: { at: Date.now(), reason: 'countdown' } })
          .catch(() => undefined);
      }
    }
    const remaining = Math.max(0, cd.ts + cd.secs * 1000 - Date.now());
    const fire = window.setTimeout(() => {
      void sync.update(`rooms/${room.pin}`, { countdown: null }).catch(() => undefined);
      const r2 = roomRef.current;
      if (!r2) return; // room gone
      // The retake window re-fires the RETAKE, not a snap.
      if (r2.state === 'ROUND_RESULTS' && r2.last_evaluation?.error) {
        void retakePhoto();
        return;
      }
      if (r2.state !== 'ACTIVE_TURN') return; // turn ended meanwhile
      void snapPhoto();
    }, remaining);
    // safety: if the capture never happened (dead board / guard tripped),
    // hand the seconds back instead of freezing the turn forever.
    // ACTIVE_TURN only - the retake window has no running clock to hand back.
    if (room.state === 'ACTIVE_TURN') {
      if (countdownSafetyTimerRef.current) window.clearTimeout(countdownSafetyTimerRef.current);
      countdownSafetyTimerRef.current = window.setTimeout(() => {
        const r2 = roomRef.current;
        if (r2 && r2.state === 'ACTIVE_TURN' && r2.paused?.reason === 'countdown' && !r2.countdown) {
          const rem = Math.max(0, r2.turn_timer?.time_remaining ?? 0);
          void sync
            .update(`rooms/${r2.pin}`, {
              paused: null,
              turn_timer: { time_remaining: rem, is_active: true },
            })
            .catch(() => undefined);
        }
      }, remaining + COUNTDOWN_SAFETY_MS);
    }
    return () => window.clearTimeout(fire);
  }, [isHost, room, room?.state, room?.countdown?.ts, room?.pin, snapPhoto, retakePhoto]);

  /* 💡 host hint pipeline: forward hint requests to the board - the
     board asks Gemini for the hint text and SPEAKS it to the whole room;
     the requester's payment already happened on their phone. Demo rooms
     have no board, so the local bank writes the hint and the browser voice
     reads it aloud.
     The hint now PAUSES the riddle clock for the whole
     generate+speech window and resumes it when the board echoes tts_done
     for the hint line (safety resume after HINT_PAUSE_MAX_MS). */
  useEffect(() => {
    if (!isHost || !room || room.state !== 'ACTIVE_TURN') return;
    const hr = room.hint_request;
    if (!hr || !hr.ts || hr.ts === lastHintRef.current) return;
    lastHintRef.current = hr.ts;
    const player = hr.player_id ? room.players?.[hr.player_id] : null;
    if (!pin) return;
    // An unusable request is CLEARED, never left behind.
    // A hint pressed while the riddle was still generating used to stay in
    // rooms/{pin}/hint_request forever, and the clock-arm effect refuses to
    // arm while one is pending → the turn clock froze for the rest of the game.
    // Also refused while the buttons are locked (reading / host
    // pause) or a countdown window owns the clock
    if (!player || !room.current_riddle || buttonLock(room) || room.countdown) {
      if (player) toast.info('A hint is not available right now — try again in a moment.');
      void sync.update(`rooms/${pin}`, { hint_request: null }).catch(() => undefined);
      return;
    }
    // ONE HINT PER WINDOW (web twin of the board's HINT_MIN_GAP_MS):
    // while a hint is still being generated or spoken, or within
    // HINT_MIN_GAP_MS of the last forwarded hint, further requests are
    // dropped - a held / bouncing long-press used to queue a second hint and
    // the room heard two hints back to back. The request is cleared either
    // way so it can never be replayed by a later effect run.
    // Single-hint latch: a hint used THIS turn blocks any
    // further forward. hint_used_turn existed but gated nothing on this
    // path - a refreshed player page re-enabled its local button and the
    // host happily re-forwarded a second request. The latch persists
    // across an unclear retake of the SAME riddle (a retake never touches
    // turn_started_at), and the retake window offers no hint request.
    const hintAlreadyUsed =
      room.hint_used_turn != null && room.hint_used_turn === room.turn_started_at;
    if (hintAlreadyUsed) {
      toast.info(`One hint per riddle — ${player.name} already used theirs this turn.`);
      void sync.update(`rooms/${pin}`, { hint_request: null }).catch(() => undefined);
      return;
    }
    if (hintPauseRef.current || Date.now() - lastHintForwardRef.current < HINT_MIN_GAP_MS) {
      toast.info('One hint at a time — the previous one is still being written or spoken.');
      void sync.update(`rooms/${pin}`, { hint_request: null }).catch(() => undefined);
      return;
    }
    lastHintForwardRef.current = Date.now();
    toast.info(`💡 ${player.name} requested a hint`);
    void pushFeed(pin, `💡 ${player.name} asked for a hint`, 'info');
    if (room.demo) {
      const hint = makeHint(room.current_riddle);
      announce(`Hint for ${player.name}: ${hint}`);
      void sync
        .update(`rooms/${pin}`, {
          hint: { req_id: 0, player_id: hr.player_id, player_name: player.name, text: hint, ts: Date.now() },
          hint_request: null,
        })
        .catch(() => undefined);
      // demo hint: pause for the spoken line only (no generation wait)
      if (room.turn_started_at && !room.paused && !room.host_paused) {
        void sync
          .update(`rooms/${pin}`, { paused: { at: Date.now(), reason: 'hint' } })
          .catch(() => undefined);
        hintPauseRef.current = { lineId: 0, startedAt: Date.now() };
        if (hintSafetyTimerRef.current) window.clearTimeout(hintSafetyTimerRef.current);
        hintSafetyTimerRef.current = window.setTimeout(
          () => {
            hintPauseRef.current = null;
            const r2 = roomRef.current;
            if (r2?.paused?.reason === 'hint') {
              const rem = Math.max(0, r2.turn_timer?.time_remaining ?? 0);
              void sync
                .update(`rooms/${r2.pin}`, {
                  paused: null,
                  turn_timer: { time_remaining: rem, is_active: true },
                })
                .catch(() => undefined);
            }
          },
          estimateSpeechMs(hint) + 2500,
        );
      }
    } else {
      // 💡 Pause the clock while the board generates + speaks the hint.
      // NEVER when the host already paused: the host pause keeps
      // ownership (host_paused) and the hint's own resume may not lift it.
      if (room.turn_started_at && !room.paused && !room.host_paused) {
        void sync
          .update(`rooms/${pin}`, { paused: { at: Date.now(), reason: 'hint' } })
          .catch(() => undefined);
      }
      hintPauseRef.current = { lineId: hr.ts, startedAt: Date.now() };
      if (hintSafetyTimerRef.current) window.clearTimeout(hintSafetyTimerRef.current);
      hintSafetyTimerRef.current = window.setTimeout(() => {
        hintPauseRef.current = null;
        const r2 = roomRef.current;
        if (r2?.paused?.reason === 'hint') {
          const rem = Math.max(0, r2.turn_timer?.time_remaining ?? 0);
          void sync
            .update(`rooms/${r2.pin}`, {
              paused: null,
              turn_timer: { time_remaining: rem, is_active: true },
            })
            .catch(() => undefined);
        }
      }, HINT_PAUSE_MAX_MS);
      void sync
        .update('hardware_session', {
          hint_req: { req_id: hr.ts, player_name: player.name, ts: Date.now() },
        })
        .catch(() => undefined);
      void sync.update(`rooms/${pin}`, { hint_request: null }).catch(() => undefined);
    }
  }, [isHost, room, room?.state, room?.hint_request?.ts, pin, announce, pushFeed]);

  /* 💡 board-written hint arrives → caption it on the TV (the board is
     already speaking it room-wide, so this is VISUAL only - no re-speak)
     and mark the turn as hint-assisted (solve pays 50 %). */
  useEffect(() => {
    if (!isHost || !room || !room.hint) return;
    const h = room.hint;
    if (!h.ts || Date.now() - h.ts > 30000) return;
    if (room.state === 'ACTIVE_TURN' && room.turn_started_at && room.hint_used_turn !== room.turn_started_at) {
      void sync
        .update(`rooms/${room.pin}`, { hint_used_turn: room.turn_started_at })
        .catch(() => undefined);
    }
    if (voiceHideRef.current) window.clearTimeout(voiceHideRef.current);
    setVoiceLine(`💡 Hint for ${h.player_name}: ${h.text}`);
    voiceHideRef.current = window.setTimeout(() => setVoiceLine(null), 9000);
  }, [isHost, room?.hint?.ts]);

  /* ── phase sound/speech FX ──────────────────────────────────────────── */
  useEffect(() => {
    if (!room) return;
    const key = `${room.state}:${room.phase_started_at}`;
    if (phaseFxRef.current === key) return;
    phaseFxRef.current = key;
    // A phase that began BEFORE this page loaded is history (page
    // refresh on the victory screen, mid-game reload, joining a running
    // match). It was announced when it actually happened - replaying it is
    // exactly how a stale "game over" line got spoken after a NEW game
    // started. Skip both the sounds and the speech for old phases.
    if (room.phase_started_at < appMountAtRef.current - 2000) return;
    const host = sessionRef.current?.role === 'host';
    const myId = sessionRef.current?.playerId;
    const isMyTurn = sessionRef.current?.role === 'player' && room.active_player_id === myId;
    const muted = settingsRef.current.muted;
    const activeName = room.active_player_id
      ? (room.players?.[room.active_player_id]?.name ?? null)
      : null;
    const ev = room.last_evaluation;

    switch (room.state) {
      case 'INTRO':
        if (host) {
          sfxWhoosh(muted);
          announce(phaseLine(room), key);
        }
        break;
      case 'ROUND_FLASH':
        if (host) {
          sfxWhoosh(muted);
          announce(phaseLine(room), key);
        }
        break;
      case 'CALLOUT':
        if (host) {
          sfxJoin(muted);
          announce(phaseLine(room), key);
        }
        break;
      case 'ACTIVE_TURN':
        if (host && room.current_riddle) {
          sfxTick(muted);
          /* Real rooms announce via the riddle-arrival effect (the
             board's riddle usually arrives AFTER the phase flip; a kept
             prefetch is announced there too - same gate, no double speak).
             Demo riddles exist immediately, so announce here. */
          if (room.demo) announce(phaseLine(room), key);
        }
        break;
      case 'EVALUATING':
        /* The board speaks "Photo captured…" LOCALLY at the shutter
           instant; the web shows the caption and writes NO duplicate cmd
           (that line used to land one round-trip late - or minutes late). */
        if (host) announce(phaseLine(room), undefined, { boardSpeaks: !room.demo });
        break;
      case 'ROUND_RESULTS':
        if (ev) {
          if (ev.passed) {
            sfxPass(muted || (!host && !isMyTurn));
            if (host) {
              burstConfetti();
              // "Correct!" leads the award line.
              // The overrule path announced its own dedicated
              // line seconds ago; skip the standard award line (one-shot).
              if (suppressPassAnnounceRef.current) {
                suppressPassAnnounceRef.current = false;
              } else {
                announce(`Correct! ${activeName ?? 'Player'} earned ${ev.points_earned} points!`);
              }
            }
          } else if (ev.error) {
            sfxUnclear(muted || (!host && !isMyTurn));
            // Host Check: count consecutive unclear verdicts on the
            // SAME riddle; from the 2nd one the host is invited to decide.
            const uKey = `${room.active_player_id ?? ''}:${room.current_riddle?.id ?? ''}`;
            const prevU = unclearStreakRef.current;
            const n = prevU.key === uKey ? prevU.n + 1 : 1;
            unclearStreakRef.current = { key: uKey, n };
            setUnclearStreak(n);
            if (host) {
              announce(
                n >= HOST_CHECK_SUGGEST_AFTER
                  ? 'Still unclear. The host can take a look, or you can retake!'
                  : 'Unclear photo. Retake is allowed!', // T16(4)
              );
            }
          } else {
            sfxFail(muted || (!host && !isMyTurn));
            if (host) {
              /* Owner wording: name + what the judge saw + the
                 expected answer. Falls back to the short line when the
                 judge (older firmware) sent no "seen" phrase.
                 MULTI-ANSWER RIDDLES: target_keyword may hold
                 "TV remote | remote | remote control | TV clicker". The
                 SPOKEN line mentions ONE answer (the canonical first);
                 the judge prompt still accepts every variant. */
              const seen = (ev.seen ?? '').trim();
              const answer = (room.current_riddle?.target_keyword ?? '').split('|')[0].trim();
              const failLine = ev.timed_out
                ? 'Time is up!' // T16(5)
                : seen && answer
                  ? `Not quite, ${activeName ?? 'player'}! I see ${seen}, but I was looking for ${answer}.`
                  : `Not quite, ${activeName ?? 'player'}, that was incorrect!`;
              announce(
                failLine,
                undefined,
                // time-up must cut through any queued line
                ev.timed_out ? { priority: true } : undefined,
              );
            }
          }
        }
        break;
      case 'GAME_OVER': {
        sfxFanfare(muted);
        if (host) {
          /* ONE merged game-over line. The old 3-line
             burst (best moment + reveal + congrats) used to eat itself
             whenever the board was busy, and the best-moment announce
             is owner-retired. Priority keeps it over queued lines. */
          const c = rankPlayers(room.players)[0] ?? null;
          if (c) {
            announce(
              `Match complete! Let's reveal our champion... Congratulations, ${c.player.name}, you win with ${c.player.score} points!`,
              undefined,
              { priority: true },
            );
          }
        }
        break;
      }
      default:
        break;
    }
     
  }, [room?.state, room?.phase_started_at]);

  /* ── host keyboard shortcuts: Space = snap · Enter = continue · R = retake */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sess = sessionRef.current;
      if (!sess || sess.role !== 'host') return;
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const r = roomRef.current;
      if (!r) return;
      // No shortcuts under an open dialog (Host Check, rules,
      // settings…): Enter on a focused dialog button ALSO fired Continue, and
      // R retook the photo behind the Host Check panel.
      if (r.host_review || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (r.state === 'ACTIVE_TURN') void snapPhoto();
      } else if (e.key === 'Enter') {
        if (r.state === 'ROUND_RESULTS') void continueTurn();
      } else if (e.key.toLowerCase() === 'r') {
        if (r.state === 'ROUND_RESULTS' && r.last_evaluation?.error) void retakePhoto();
      } else if (e.key.toLowerCase() === 'p') {
        if (r.state === 'ACTIVE_TURN') void (r.paused || r.host_paused ? resumeTurn() : pauseTurn());
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        // 🎺 sound board hotkeys - party hype from the keyboard
        const cue = (['airhorn', 'drumroll', 'rimshot', 'tada'] as const)[Number(e.key) - 1];
        void playSoundCue(cue);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapPhoto, continueTurn, retakePhoto, pauseTurn, resumeTurn, playSoundCue]);

  /* ── settings save ──────────────────────────────────────────────────── */
  const handleSaveSettings = useCallback(
    (s: HardwareSettings) => {
      setSettings(s);
      saveSettings(s);
      setSettingsOpen(false);
      void pushSettingsToEsp32(s).then((res) => {
        // Demo rooms have no board to push to - silence is honest there.
        if (!roomRef.current?.demo) {
          if (res.ok) toast.success(res.message);
          else toast.error(res.message);
        }
      });
      toast.success('Settings saved.');
    },
    [],
  );

  const toggleMuted = useCallback((m: boolean) => {
    const next: HardwareSettings = { ...settingsRef.current, muted: m };
    setSettings(next);
    saveSettings(next);
  }, []);

  /* ── render ─────────────────────────────────────────────────────────── */

  const playerTimer = room
    ? room.state === 'ACTIVE_TURN' || room.state === 'EVALUATING'
      ? room.turn_timer?.time_remaining ?? 0
      : 0
    : 0;

  let screen: React.ReactNode;
  if (!ready) {
    screen = (
      <div className="flex flex-col items-center gap-3 py-24">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-amber-400 border-t-transparent" />
        <p className="text-sm text-sr-2">SnapRiddle is warming up…</p>
      </div>
    );
  } else if (syncStatus === 'error') {
    /* ☁️ Firebase-only sync: when the database can't be reached there
       is no local fallback. One honest screen + one Retry button. */
    screen = (
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border-2 p-10 text-center sr-glass" style={{ borderColor: 'var(--sr-line)' }} role="alert">
        <CloudOff className="h-10 w-10 text-rose-400" aria-hidden />
        <h2 className="font-display text-xl font-extrabold text-fg">Can&apos;t reach game services</h2>
        <p className="text-sm text-sr-2">
          SnapRiddle syncs everything through Firebase and the connection is
          failing. Check the internet connection on this device, then retry.
        </p>
        <button
          type="button"
          onClick={() => sync.retry()}
          className="mt-1 flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition hover:bg-amber-400 active:scale-95"
        >
          <RotateCcw className="h-4 w-4" /> Retry connection
        </button>
      </div>
    );
  } else if (session && !room) {
    screen = (
      <div className="flex flex-col items-center gap-3 py-24">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-amber-400 border-t-transparent" />
        <p className="text-sm text-sr-2">Opening room…</p>
      </div>
    );
  } else if (!session) {
    screen =
      viewIntent === 'player' ? (
        <JoinGameScreen
          initialPin={initialPin}
          onBack={() => setViewIntent(null)}
          onJoin={(f) => void joinGame(f)}
        />
      ) : (
        <LandingScreen
          hardwareBusyPin={hardwareBusyPin}
          onCreate={(cfg) => void createGame(cfg)}
          onGoJoin={() => setViewIntent('player')}
          onQuickDemo={() => void quickDemo()}
          demoBusy={demoBusy}
        />
      );
  } else if (session.role === 'host') {
    screen =
      room?.state === 'LOBBY' ? (
        <HostLobby
          room={room}
          players={joinedPlayers}
          maxPlayers={MAX_PLAYERS}
          hardwareReady={hardwareReady}
          joinUrlBase={settings.join_url_base}
          onBack={() => void leaveLobby()}
          onStart={() => void startMatch()}
          onKick={(id, name) => void kickPlayer(id, name)}
          onSoundCue={(s) => void playSoundCue(s)}
          onHintTokens={(n) => void setHintTokens(n)}
          onCountdownSecs={(n) => void setCountdownSecs(n)}
        />
      ) : room?.state === 'GAME_OVER' ? (
        <VictoryScreen
          ranked={ranked}
          badges={Object.fromEntries(ranked.map(({ id, player }) => [id, player.badge]))}
          isHost
          moments={room.moments ?? []}
          onEditCaption={(momentId, text) => void editCaption(momentId, text)}
          onExit={() => void exitRoom()}
        />
      ) : room ? (
        <HostDashboard
          room={room}
          ranked={ranked}
          activePlayer={activePlayer}
          localTimeRemaining={localTimeRemaining}
          frozenUrl={frozenUrl}
          snapSeq={snapSeq}
          isDemo={Boolean(room.demo)}
          cameraIp={cameraIpRef.current || settings.esp32_ip}
          hardwareOnline={hardwareReady}
          espBoot={espStatus?.boot ?? 0}
          espJudging={!room.demo && room.state === 'EVALUATING'}
          bonusActive={bonusActive}
          feed={room.feed ?? []}
          onSnap={() => void snapPhoto()}
          onJudgeOverride={handleJudgeOverride}
          onContinue={() => void continueTurn()}
          onRetake={() => void retakePhoto()}
          onEndGame={() => void finishGame()}
          onPauseToggle={() => void (room.paused || room.host_paused ? resumeTurn() : pauseTurn())}
          isPaused={Boolean(room.paused || room.host_paused)}
          spotlightId={room.spotlight?.player_id ?? null}
          onSpotlight={(id, name) => void toggleSpotlight(id, name)}
          lastMoment={(room.moments ?? []).length ? (room.moments as PhotoMoment[]).slice(-1)[0] : null}
          onEditCaption={(momentId, text) => void editCaption(momentId, text)}
          onSoundCue={(s) => void playSoundCue(s)}
          onCountdown={() => void startCountdown('host')}
          onPivotPaper={() => void pivotToPaper()}
          onOverrule={() => void overruleAi()}
          continueBusy={continueBusy}
          hostCheckSuggested={unclearStreak >= HOST_CHECK_SUGGEST_AFTER}
          onHostReview={(open) => void setHostReview(open)}
          onHostCheck={(accept) => void hostCheckDecide(accept)}
        />
      ) : (
        <></>
      );
  } else {
    // player
    screen = room ? (
      room.state === 'GAME_OVER' ? (
        <VictoryScreen
          ranked={ranked}
          badges={Object.fromEntries(ranked.map(({ id, player }) => [id, player.badge]))}
          isHost={false}
          myId={session.playerId}
          moments={room.moments ?? []}
          onExit={() => void leaveRoomPlayer()}
        />
      ) : (
        <PlayerController
          room={room}
          myId={session.playerId}
          ranked={ranked}
          localTimeRemaining={playerTimer}
          feed={room.feed ?? []}
          spotlight={room.spotlight ?? null}
          isPaused={Boolean(room.paused || room.host_paused)}
          lastMoment={(room.moments ?? []).length ? (room.moments as PhotoMoment[]).slice(-1)[0] : null}
          onHint={() => void requestHint()}
          onReact={(emoji, combo) => void sendReaction(emoji, combo)}
          onCaption={(momentId, text) => void submitCaption(momentId, text)}
          onLeave={() => void leaveRoomPlayer()}
          onCountdown={() => void startCountdown('player')}
        />
      )
    ) : (
      <></>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* ambient background glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-amber-500/[0.07] blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-violet-600/[0.08] blur-3xl" />
        <div className="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-emerald-500/[0.05] blur-3xl" />
      </div>

      <Header
        role={session?.role ?? null}
        muted={settings.muted}
        onToggleMute={toggleMuted}
        onOpenSettings={() => setSettingsOpen(true)}
        onSwitchRole={() => setRoleModalOpen(true)}
      />

      <main className="flex w-full flex-1 flex-col items-center justify-center px-3 py-5 md:px-6 md:py-8">
        {screen}
      </main>

      <Footer />

      {/* overlays */}
      <SettingsDrawer
        key={settingsOpen ? 'open' : 'closed'}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        espStatus={espStatus}
        onSave={handleSaveSettings}
      />
      <RoleModal
        open={roleModalOpen}
        onOpenChange={setRoleModalOpen}
        hasSession={Boolean(session)}
        onPick={(role) => {
          if (session) {
            toast.info('Finish or leave your current session before switching views.');
            return;
          }
          setViewIntent(role);
          setRoleModalOpen(false);
        }}
      />
      {voiceLine && <VoiceMasterBanner text={voiceLine} onClose={() => setVoiceLine(null)} />}
      {/* Phone → TV emoji reactions float above every host screen */}
      {isHost && room && <FloatingReactions reactions={room.reactions} muted={settings.muted} />}
      <Toaster position="top-center" offset={{ top: 64 }} richColors theme={settings.theme} closeButton />
    </div>
  );
}

/* ── (removed helpers) ──
   The browser-side Gemini judge, the ESP32 JPEG fetcher and the shared
   verdict-sink type died together with the judge-source toggle and the
   Gemini API key field: real rooms are judged exclusively by the board. */
