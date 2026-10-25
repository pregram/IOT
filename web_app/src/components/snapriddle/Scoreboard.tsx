'use client';

import { Flame, Star } from 'lucide-react';
import type { RankedPlayer } from '@/utils/gameLogic';
import { MEDALS } from '@/utils/gameLogic';

interface ScoreboardProps {
  ranked: RankedPlayer[];
  activePlayerId?: string | null;
  title?: string;
  /** player-phone compact variant */
  compact?: boolean;
  /** highlight the local player row */
  myId?: string | null;
  /** id of the player currently in the host spotlight */
  spotlightId?: string | null;
  /** when set (host boards), rows get a star button to toggle the spotlight */
  onSpotlight?: (playerId: string, name: string) => void;
}

const RANK_STYLES: Record<number, string> = {
  1: 'text-amber-500 dark:text-amber-400',
  2: 'text-slate-400 dark:text-slate-300',
  3: 'text-amber-600 dark:text-amber-500',
};

/** a heartbeat older than this renders an amber "reconnecting" dot */
const SEEN_STALE_MS = 12000;

export default function Scoreboard({
  ranked,
  activePlayerId,
  title = 'Leaderboard',
  compact = false,
  myId = null,
  spotlightId = null,
  onSpotlight,
}: ScoreboardProps) {
  return (
    <div
      className={`sr-glass rounded-2xl ${compact ? 'p-3' : 'p-4'}`}
      style={{ borderColor: 'var(--sr-line)' }}
    >
      <div
        className={`flex items-center justify-between border-b pb-2 text-xs font-bold text-sr-2 ${
          compact ? 'mb-2' : 'mb-3'
        }`}
        style={{ borderColor: 'var(--sr-line)' }}
      >
        <span className="uppercase tracking-wider">{title}</span>
        <span className="text-sr-3">{onSpotlight ? 'Scores · tap ★ to spotlight' : 'Scores'}</span>
      </div>
      <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1 md:max-h-48">
        {ranked.length === 0 && (
          <p className="py-4 text-center text-xs text-sr-3">No players yet.</p>
        )}
        {ranked.map(({ id, player, rank }) => {
          const isActive = id === activePlayerId;
          const isMe = id === myId;
          const isSpot = id === spotlightId;
          return (
            <div
              key={id}
              className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition ${
                isSpot
                  ? 'neon-gold border border-amber-400/70 bg-amber-400/15'
                  : isActive
                    ? 'border border-amber-500/40 bg-amber-500/10'
                    : isMe
                      ? 'border border-violet-500/30 bg-violet-500/10'
                      : 'bg-black/10 dark:bg-white/[0.04]'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={`w-7 shrink-0 font-bold ${RANK_STYLES[rank] ?? 'text-sr-3'}`}>
                  {MEDALS[rank] ?? `#${rank}`}
                </span>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: player.color ?? '#94a3b8' }}
                  aria-hidden
                />
                <span className="truncate font-semibold text-fg">{player.name}</span>
                {isSpot && (
                  <Star
                    className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400"
                    aria-label={`${player.name} is spotlighted`}
                  />
                )}
                {player.is_bot ? null : typeof player.last_seen === 'number' ? (
                  Date.now() - player.last_seen > SEEN_STALE_MS ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
                      title="Reconnecting…"
                      aria-label={`${player.name} is reconnecting`}
                    />
                  ) : (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                      title="Connected"
                      aria-label={`${player.name} is connected`}
                    />
                  )
                ) : null}
                {player.streak >= 2 && (
                  <span className="flex shrink-0 items-center gap-0.5 rounded bg-orange-500/15 px-1.5 py-0.5 text-[9px] font-bold text-orange-600 dark:text-orange-400">
                    <Flame className="h-2.5 w-2.5" />
                    {player.streak}
                  </span>
                )}
                {isMe && (
                  <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-bold text-violet-700 dark:text-violet-300">
                    YOU
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {onSpotlight && (
                  <button
                    type="button"
                    onClick={() => onSpotlight(id, player.name)}
                    aria-label={isSpot ? `Remove spotlight from ${player.name}` : `Spotlight ${player.name}`}
                    title={isSpot ? `Unspotlight ${player.name}` : `Spotlight ${player.name} 🌟`}
                    className={`flex h-6 w-6 items-center justify-center rounded-md transition focus-visible:ring-2 focus-visible:ring-amber-400/60 ${
                      isSpot
                        ? 'bg-amber-500/25 text-amber-300'
                        : 'text-sr-3 opacity-50 hover:bg-amber-500/15 hover:text-amber-300 hover:opacity-100'
                    }`}
                  >
                    <Star className={`h-3 w-3 ${isSpot ? 'fill-amber-400' : ''}`} />
                  </button>
                )}
                {!compact && (
                  <span className="rounded bg-black/20 px-1.5 py-0.5 text-[9px] font-semibold text-sr-3 dark:bg-white/5">
                    {player.current_difficulty}
                  </span>
                )}
                <span
                  key={`score-${player.score}`}
                  className="animate-pop inline-block font-mono font-bold text-amber-600 dark:text-amber-300"
                >
                  {player.score} pts
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
