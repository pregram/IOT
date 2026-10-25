'use client';

import { useEffect, useRef, useState } from 'react';
import { sfxReaction } from '@/lib/sfx';
import type { ReactionEvent } from '@/lib/types';

interface FloatingReactionsProps {
  /** rolling reaction list straight from the DB */
  reactions: ReactionEvent[] | null;
  muted: boolean;
}

interface Particle {
  key: string;
  emoji: string;
  name: string;
  left: number; // vw %
  dx: number; // px horizontal drift
  rot: number; // deg final rotation
  sc: number; // final scale
  dur: number; // seconds
  size: number; // px
}

const MAX_PARTICLES = 40;

/**
 * Host-TV overlay: every reaction sent from a player phone erupts as a
 * swarm of floating emojis drifting up the screen (Jackbox-style).
 * Renders above everything (`fixed inset-0 z-[60] pointer-events-none`).
 */
export default function FloatingReactions({ reactions, muted }: FloatingReactionsProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const lastTsRef = useRef(0);
  const initRef = useRef(false);
  const mutedRef = useRef(muted);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  /** Build particles for a batch of events and schedule their lifecycle.
   *  Timers are intentionally fire-and-forget: rapid room snapshots re-run
   *  the subscription effect and would otherwise cancel pending spawns.
   *  Events carrying a combo streak (≥3 same emoji in a row) erupt into a
   *  bigger, faster swarm with a ×N name tag. */
  const spawnBatch = (events: ReactionEvent[]) => {
    if (events.length === 0) return;
    const spawned: Particle[] = [];
    for (const ev of events.slice(-4)) {
      const combo = Math.min(6, ev.combo ?? 0);
      const copies = 5 + Math.max(0, combo - 2) * 2; // 5 → up to 13
      const boost = combo >= 3 ? 1.35 : 1;
      // Each event erupts from a shared random origin.
      const originLeft = 8 + Math.random() * 78;
      for (let i = 0; i < copies; i++) {
        spawned.push({
          key: `${ev.id}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          emoji: ev.emoji,
          name: i === 0 ? (combo >= 2 ? `${ev.name} ×${combo}` : ev.name) : '',
          left: Math.max(2, Math.min(94, originLeft + (Math.random() * 16 - 8))),
          dx: Math.random() * (combo >= 3 ? 160 : 120) - (combo >= 3 ? 80 : 60),
          rot: Math.random() * 50 - 25,
          sc: (1 + Math.random() * 0.9) * boost,
          dur: (2.1 + Math.random() * 1.3) / (combo >= 3 ? 1.15 : 1),
          size: (30 + Math.random() * 26) * boost,
        });
      }
    }
    window.setTimeout(() => {
      /* each emoji carries its own signature TV jingle */
      sfxReaction(mutedRef.current, events[events.length - 1]?.emoji ?? '🎉');
      setParticles((prev) => [...prev, ...spawned].slice(-MAX_PARTICLES));
    }, 0);
    // Auto-clean once the longest animation certainly finished.
    window.setTimeout(
      () => setParticles((prev) => prev.filter((p) => !spawned.some((s) => s.key === p.key))),
      4400,
    );
  };

  useEffect(() => {
    if (!reactions || reactions.length === 0) return;
    // First snapshot: adopt pre-existing reactions without replaying them,
    // UNLESS the newest one is brand-new (< 5s old) - that's a live party.
    if (!initRef.current) {
      initRef.current = true;
      const newest = Math.max(...reactions.map((r) => r.ts ?? 0));
      if (Date.now() - newest < 5000) {
        spawnBatch(reactions.filter((r) => (r.ts ?? 0) > newest - 5000));
      }
      lastTsRef.current = newest;
      return;
    }
    const fresh = reactions.filter((r) => (r.ts ?? 0) > lastTsRef.current);
    if (fresh.length === 0) return;
    lastTsRef.current = Math.max(...fresh.map((r) => r.ts ?? 0));
    spawnBatch(fresh);
  }, [reactions, muted]);

  if (particles.length === 0) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      {particles.map((p) => (
        <div
          key={p.key}
          className="emoji-burst absolute bottom-16 flex flex-col items-center"
          style={{
            left: `${p.left}vw`,
            '--dx': `${p.dx}px`,
            '--rot': `${p.rot}deg`,
            '--sc': p.sc,
            '--dur': `${p.dur}s`,
          } as React.CSSProperties}
        >
          <span
            style={{
              fontSize: p.size,
              filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.45))',
              lineHeight: 1,
            }}
          >
            {p.emoji}
          </span>
          {p.name && (
            <span
              className={`mt-0.5 rounded-full px-1.5 py-px text-[9px] font-bold backdrop-blur-sm ${
                p.name.includes('×')
                  ? 'bg-amber-500 text-slate-950 shadow shadow-amber-500/40'
                  : 'bg-black/45 text-white/85'
              }`}
            >
              {p.name}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
