'use client';

import { Radio } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { FeedEvent } from '@/lib/types';

const TONE_STYLE: Record<FeedEvent['tone'], CSSProperties> = {
  good: { color: '#34d399' },
  bad: { color: '#fb7185' },
  info: { color: 'var(--sr-fg-2)' },
  gold: { color: '#fbbf24' },
};

interface FeedTickerProps {
  events: FeedEvent[];
  /** compact = player phone (shows last 3, no header) */
  compact?: boolean;
}

/** Rolling live event feed - "Alex proved 'book' +213 pts ⚡2×". */
export default function FeedTicker({ events, compact = false }: FeedTickerProps) {
  const visible = compact ? events.slice(-3) : events.slice(-6);

  if (compact) {
    if (!visible.length) return null;
    return (
      <div className="sr-glass space-y-1.5 rounded-2xl p-3 text-left">
        {visible.map((ev) => (
          <div key={ev.id} className="animate-fade-up truncate text-[11px] font-medium" style={TONE_STYLE[ev.tone]}>
            {ev.text}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="sr-glass rounded-2xl p-3.5">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-sr-3">
        <Radio className="h-3 w-3 animate-pulse text-amber-400" />
        Live Feed
      </div>
      <div className="max-h-28 space-y-1.5 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="text-[11px] text-sr-3">Events will appear here — joins, proofs, doom fails…</p>
        )}
        {[...visible].reverse().map((ev, i) => (
          <div
            key={ev.id}
            className="animate-fade-up flex items-center gap-2 text-xs font-medium"
            style={{ ...TONE_STYLE[ev.tone], animationDelay: `${i * 40}ms` }}
          >
            <span className="h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
            <span className="truncate">{ev.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
