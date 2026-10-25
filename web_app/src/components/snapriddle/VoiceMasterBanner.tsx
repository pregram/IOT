'use client';

import { Mic, X } from 'lucide-react';

interface VoiceMasterBannerProps {
  text: string;
  onClose: () => void;
}

/** Floating "Voice Master" TTS caption bar (bottom center). */
export default function VoiceMasterBanner({ text, onClose }: VoiceMasterBannerProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 md:bottom-24">
      <div
        className="sr-glass pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-2xl p-3.5 shadow-2xl md:p-4"
        style={{ background: 'var(--sr-glass-strong)', borderColor: 'rgba(245,158,11,0.4)' }}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-400/50 bg-amber-500/15">
          <Mic className="h-5 w-5 animate-pulse text-amber-400" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400">
            Voice Master
          </div>
          <div className="truncate text-sm font-semibold text-fg md:text-base">“{text}”</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto rounded-lg p-1.5 text-sr-3 transition hover:text-fg"
          aria-label="Hide voice banner"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
