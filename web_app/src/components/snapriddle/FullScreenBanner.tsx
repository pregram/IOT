'use client';

import { Sparkles } from 'lucide-react';
import type { SpecialRoundType } from '@/lib/types';

export type BannerKind =
  | 'get-ready'
  | 'round'
  | 'bonus'
  | 'bonus-callout'
  | 'doom'
  | 'callout';

interface FullScreenBannerProps {
  kind: BannerKind;
  round?: number;
  total?: number;
  gameName?: string;
  playerName?: string;
  playerInitial?: string;
  playerColor?: string;
  score?: number;
  streak?: number;
  special?: SpecialRoundType;
}

const KIND_BG: Record<BannerKind, string> = {
  'get-ready':
    'bg-[radial-gradient(ellipse_at_center,rgba(76,29,149,0.55),rgba(11,17,32,0.98))]',
  round: 'bg-[radial-gradient(ellipse_at_center,rgba(76,29,149,0.55),rgba(11,17,32,0.98))]',
  bonus:
    'bg-[radial-gradient(ellipse_at_center,rgba(234,179,8,0.45),rgba(11,17,32,0.98))]',
  'bonus-callout':
    'bg-[radial-gradient(ellipse_at_center,rgba(234,179,8,0.5),rgba(11,17,32,0.98))]',
  doom: 'bg-[radial-gradient(ellipse_at_center,rgba(239,68,68,0.42),rgba(11,17,32,0.98))]',
  callout:
    'bg-[radial-gradient(ellipse_at_center,rgba(124,58,237,0.5),rgba(11,17,32,0.98))]',
};

/**
 * Kahoot-style full-screen energy flash used for INTRO / ROUND_FLASH /
 * CALLOUT / bonus beats. Re-mounts (key changes) restart the animation.
 */
export default function FullScreenBanner({
  kind,
  round,
  total,
  gameName,
  playerName,
  playerInitial,
  playerColor,
  score,
  streak,
}: FullScreenBannerProps) {
  return (
    <div
      className={`dark-dialog fixed inset-0 z-30 flex flex-col items-center justify-center p-6 text-center ${KIND_BG[kind]}`}
    >
      {kind === 'get-ready' && (
        <div key={`gr-${gameName}-${round}`} className="animate-scale-in space-y-4">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-violet-300">
            {(round ?? 1) > 1 ? `Round ${round} · Next Up` : 'Match Starting'}
          </p>
          <h2 className="font-display text-4xl font-extrabold tracking-tight text-white md:text-6xl">
            {(round ?? 1) > 1 ? `ROUND ${round}` : gameName}
          </h2>
          <p className="flex items-center justify-center gap-2 text-sm text-sr-2">
            <Sparkles className="h-4 w-4 text-amber-400" />
            {(round ?? 1) > 1 ? 'Get ready! Riddle loading…' : 'Cameras ready. Riddles loading…'}
          </p>
        </div>
      )}

      {kind === 'round' && (
        <div key={`rd-${round}`} className="animate-scale-in space-y-4">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-violet-300">
            Round Transition
          </p>
          <h2 className="font-display text-5xl font-extrabold tracking-tight text-white md:text-7xl">
            ROUND {round}
            <span className="text-violet-400">/{total}</span>
          </h2>
          <p className="text-sm text-sr-2">Get ready! Next riddle loading…</p>
        </div>
      )}

      {kind === 'bonus' && (
        <div key={`bn-${round}`} className="animate-scale-in space-y-4">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-yellow-400">
            🎁 Special Round 🎁
          </p>
          <h2 className="font-display text-5xl font-extrabold tracking-tight text-white md:text-7xl">
            ROUND {round}
            <span className="text-yellow-400">/{total}</span>
          </h2>
          <div className="mx-auto max-w-md rounded-2xl border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm font-semibold text-yellow-300">
            🎁 BONUS ROUND! Every correct proof in this round wins an extra
            personal riddle — bonus points, zero risk.
          </div>
        </div>
      )}

      {kind === 'doom' && (
        <div key={`dm-${round}`} className="animate-doom-pulse rounded-3xl p-8 animate-scale-in space-y-4">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-rose-300">
            💀 Special Round 💀
          </p>
          <h2 className="font-display text-5xl font-extrabold tracking-tight text-white md:text-7xl">
            ROUND {round}
            <span className="text-rose-400">/{total}</span>
          </h2>
          <div className="mx-auto max-w-md rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm font-semibold text-rose-300">
            💀 DOUBLE OR DOOM ROUND! Earn 2× points if correct — LOSE equal points if wrong!
          </div>
        </div>
      )}

      {kind === 'bonus-callout' && (
        <div key="bnc" className="animate-scale-in space-y-4">
          {playerInitial && (
            <div
              className="animate-bounce mx-auto flex h-20 w-20 items-center justify-center rounded-2xl text-4xl font-extrabold"
              style={{
                background: `${playerColor ?? '#eab308'}2e`,
                color: playerColor ?? '#fde047',
                border: `2px solid ${playerColor ?? '#eab308'}66`,
              }}
            >
              {playerInitial}
            </div>
          )}
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-yellow-400">
            Bonus riddle unlocked
          </p>
          <h2 className="font-display text-4xl font-extrabold tracking-tight text-white md:text-6xl">
            🎁 {playerName ?? 'Player'}, ONE MORE!
          </h2>
          <div className="mx-auto max-w-md rounded-2xl border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm font-semibold text-yellow-300">
            You solved it — here comes your personal bonus riddle. Normal
            points, no penalty. Step back to the camera!
          </div>
        </div>
      )}

      {kind === 'callout' && (
        <div key={`co-${playerName}`} className="animate-scale-in space-y-4">
          {playerInitial && (
            <div
              className="animate-bounce mx-auto flex h-20 w-20 items-center justify-center rounded-2xl text-4xl font-extrabold"
              style={{
                background: `${playerColor ?? '#8b5cf6'}2e`,
                color: playerColor ?? '#c4b5fd',
                border: `2px solid ${playerColor ?? '#8b5cf6'}66`,
              }}
            >
              {playerInitial}
            </div>
          )}
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-violet-300">
            Next up to the camera
          </p>
          <h2 className="font-display text-4xl font-extrabold tracking-tight text-white md:text-6xl">
            {playerName}, STEP UP!
          </h2>
          {typeof score === 'number' && (
            <p className="text-xs text-sr-2">
              Current Score: {score} pts · Streak: {streak ?? 0}🔥
            </p>
          )}
        </div>
      )}
    </div>
  );
}
