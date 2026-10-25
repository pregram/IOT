/**
 * Pure game logic: fair score formula, dynamic difficulty
 * adjustment (DDA), special rounds and victory badges.
 * All functions are pure so the Host Dashboard can run them in memory
 * before committing results to Firebase.
 */

import type { Difficulty, Player, SpecialRoundType, Tier } from '@/lib/types';

export const BASE_POINTS: Record<Difficulty, number> = {
  Easy: 100,
  Medium: 200,
  Hard: 300,
};

/**
 * Seconds granted per difficulty - DEMO FALLBACK ONLY.
 * NOTE: real rooms use Gemini-chosen times (clamped 60-180 s) that the
 * board writes into current_riddle.time_limit_sec. The static table below
 * survives only for Fast-Demo rooms (no board = no Gemini generation).
 * Values were raised from 30/40/50 to sit inside the live 60-180 band.
 */
export const TIME_LIMIT: Record<Difficulty, number> = {
  Easy: 60,
  Medium: 90,
  Hard: 120,
};

export const DIFFICULTY_ORDER: Difficulty[] = ['Easy', 'Medium', 'Hard'];

export interface TierRule {
  start: Difficulty;
  min: Difficulty;
  max: Difficulty;
}

/** Tier caps for the DDA engine (spec §6). */
export const TIER_RULES: Record<Tier, TierRule> = {
  Casual: { start: 'Easy', min: 'Easy', max: 'Medium' },
  Standard: { start: 'Easy', min: 'Easy', max: 'Hard' },
  Expert: { start: 'Medium', min: 'Medium', max: 'Hard' },
};

export const SPECIAL_LABEL: Record<SpecialRoundType, string> = {
  NONE: '',
  BONUS: '🎁 BONUS ROUND!',
  DOUBLE_OR_DOOM: '💀 DOUBLE OR DOOM ROUND!',
};

export function tierStartDifficulty(tier: Tier): Difficulty {
  return TIER_RULES[tier].start;
}

/**
 * Move a player's difficulty one step up/down while respecting tier caps.
 */
export function stepDifficulty(
  current: Difficulty,
  dir: 'up' | 'down',
  tier: Tier,
): Difficulty {
  const rule = TIER_RULES[tier];
  const idx = DIFFICULTY_ORDER.indexOf(current);
  if (dir === 'up') {
    const maxIdx = DIFFICULTY_ORDER.indexOf(rule.max);
    return DIFFICULTY_ORDER[Math.min(idx + 1, maxIdx)];
  }
  const minIdx = DIFFICULTY_ORDER.indexOf(rule.min);
  return DIFFICULTY_ORDER[Math.max(idx - 1, minIdx)];
}

/**
 * Special round schedule:
 *   BONUS - round floor(N/2)+1 (3→r2, 5→r3, 10→r6; N=2 → r1)
 *   DOUBLE_OR_DOOM - always the LAST round
 *   N=1 → no special rounds at all.
 */
export function specialForRound(round: number, totalRounds: number): SpecialRoundType {
  if (totalRounds <= 1) return 'NONE';
  if (round === totalRounds) return 'DOUBLE_OR_DOOM';
  const bonusRound = totalRounds === 2 ? 1 : Math.floor(totalRounds / 2) + 1;
  if (round === bonusRound) return 'BONUS';
  return 'NONE';
}

/**
 * Fair Score Formula (spec §6):
 *   Score = Base × (1 + (T_remaining / T_max) × 0.5)
 * DOUBLE_OR_DOOM pass → ×2 (applied here). BONUS rounds score with the
 * normal formula (no multiplier, no doom) - callers pass 'NONE' for them.
 * A used hint halves the final score - applied by the caller afterwards.
 */
export function computeScore(
  difficulty: Difficulty,
  timeRemaining: number,
  timeLimit: number,
  special: SpecialRoundType,
): number {
  const base = BASE_POINTS[difficulty];
  const ratio = Math.max(0, Math.min(1, timeRemaining / timeLimit));
  let score = Math.round(base * (1 + ratio * 0.5));
  if (special === 'DOUBLE_OR_DOOM') score *= 2;
  return score;
}

/** DOUBLE_OR_DOOM failure → lose 2× base points. */
export function doomPenalty(difficulty: Difficulty): number {
  return -(BASE_POINTS[difficulty] * 2);
}

export interface RankedPlayer {
  id: string;
  player: Player;
  rank: number;
}

export function rankPlayers(players: Record<string, Player> | undefined): RankedPlayer[] {
  if (!players) return [];
  return Object.entries(players)
    /* defensive: skip malformed nodes (non-objects / missing name) so a
       corrupted DB write can never crash the dashboards */
    .filter(([, player]) => Boolean(player) && typeof player === 'object' && typeof player.name === 'string')
    .map(([id, player]) => ({ id, player }))
    .sort((a, b) => b.player.score - a.player.score || a.player.joined_at - b.player.joined_at)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

/**
 * Fun badges awarded when the match ends.
 * Champion / medals are handled by the podium, these are flavour badges.
 */
export function computeBadges(ranked: RankedPlayer[]): Record<string, string> {
  const badges: Record<string, string> = {};
  if (ranked.length === 0) return badges;

  // ⚡ Speed Demon - fastest verified solve
  let speedId: string | null = null;
  let speedBest = Infinity;
  // 🧠 Brainiac - most Hard-difficulty solves
  let brainId: string | null = null;
  let brainBest = 0;
  // 🎯 Sharp Eye - best accuracy with at least 3 attempts
  let sharpId: string | null = null;
  let sharpBest = 0;
  // 💀 Doom Survivor - passed a double-or-doom turn
  let doomId: string | null = null;
  // 🎨 Theme Champion - solved ≥2 riddles from a single theme this match
  let champId: string | null = null;
  let champBest = 0;

  for (const { id, player } of ranked) {
    // defensive: zombie heartbeat nodes may carry players without stats
    const s = player.stats ?? {
      solves: 0,
      fails: 0,
      timeouts: 0,
      hard_solves: 0,
      hints_used: 0,
      doom_survives: 0,
      best_time_sec: null,
    };
    if (typeof s.best_time_sec === 'number' && s.best_time_sec < speedBest) {
      speedBest = s.best_time_sec;
      speedId = id;
    }
    if (s.hard_solves > brainBest) {
      brainBest = s.hard_solves;
      brainId = id;
    }
    const attempts = s.solves + s.fails + s.timeouts;
    if (attempts >= 3) {
      const acc = s.solves / attempts;
      if (acc > sharpBest) {
        sharpBest = acc;
        sharpId = id;
      }
    }
    if (s.doom_survives > 0 && !doomId) doomId = id;
    for (const ts of Object.values(s.theme_stats ?? {})) {
      if (ts.solves > champBest) {
        champBest = ts.solves;
        champId = id;
      }
    }
  }

  if (speedId && speedBest <= 12) badges[speedId] = '⚡ Speed Demon';
  if (brainId && brainBest > 0) badges[brainId] = '🧠 Brainiac';
  if (sharpId && sharpBest >= 0.6) badges[sharpId] = '🎯 Sharp Eye';
  if (doomId) badges[doomId] = '💀 Doom Survivor';
  if (champId && champBest >= 2) badges[champId] = '🎨 Theme Champion';

  for (const { id } of ranked) {
    if (!badges[id]) badges[id] = '⭐ New Challenger';
  }
  return badges;
}

export const MEDALS: Record<number, string> = { 1: '🏆', 2: '🥈', 3: '🥉' };

/** Round label helper used by banners. */
export function roundLabel(current: number, total: number): string {
  return `Round ${current} of ${total}`;
}

/**
 * True while the Voice Master is still READING the riddle: the
 * turn is live and the riddle is armed, but the clock has not started
 * (it arms at the end of the riddle line). Snap, countdown and hint are
 * locked in this window - on the web AND on the board's physical button.
 */
export function isReadingRiddle(r: {
  state: string;
  current_riddle?: unknown;
  turn_started_at?: number | null;
}): boolean {
  return r.state === 'ACTIVE_TURN' && Boolean(r.current_riddle) && !r.turn_started_at;
}

/**
 * WHY the turn's buttons (snap, countdown, hint - web AND the
 * board's physical button) are locked right now, or null when they work:
 *   reading - the Voice Master is still reading the riddle
 *   host_paused - the host froze the turn (Pause): nothing may end it
 *   hint - the hint line is being spoken (the clock is paused for it)
 * A running countdown window is gated separately (snap still fires early).
 */
export type ButtonLock = 'reading' | 'host_paused' | 'hint' | null;

export function buttonLock(r: {
  state: string;
  current_riddle?: unknown;
  turn_started_at?: number | null;
  paused?: { reason?: string } | null;
  host_paused?: boolean | null;
}): ButtonLock {
  if (r.state !== 'ACTIVE_TURN') return null;
  if (isReadingRiddle(r)) return 'reading';
  if (r.host_paused || r.paused?.reason === 'host') return 'host_paused';
  if (r.paused?.reason === 'hint') return 'hint';
  return null;
}

export const BUTTON_LOCK_MSG: Record<Exclude<ButtonLock, null>, string> = {
  reading: 'The Voice Master is still reading the riddle — buttons unlock when the clock starts.',
  host_paused: 'The host paused the game — buttons unlock when it resumes.',
  hint: 'The hint is being read — buttons unlock when it ends.',
};
