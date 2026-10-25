'use client';

import { Smartphone, Tv } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Role } from '@/lib/types';

interface RoleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** true when a host/player session is active */
  hasSession: boolean;
  onPick: (role: Role) => void;
}

/** "Switch View Mode" dialog - test both screens from one device. */
export default function RoleModal({ open, onOpenChange, hasSession, onPick }: RoleModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sr-card max-w-md rounded-3xl border-2 p-6">
        <DialogHeader>
          <DialogTitle className="font-display text-lg text-fg">Switch View Mode</DialogTitle>
          <DialogDescription className="text-xs text-sr-3">
            Test how the game looks on both the Host TV Dashboard and a Player Mobile Controller.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <button
            type="button"
            onClick={() => onPick('host')}
            className="group rounded-xl border-2 border-black/10 bg-black/5 p-4 text-left transition hover:border-amber-500/60 hover:bg-amber-500/10 dark:border-white/10 dark:bg-black/20"
          >
            <Tv className="mb-2 h-7 w-7 text-amber-400 transition-transform group-hover:scale-110" />
            <div className="text-sm font-bold text-fg">Host Screen</div>
            <div className="mt-0.5 text-[11px] text-sr-3">
              Main TV / laptop display with camera feed & game loop
            </div>
          </button>
          <button
            type="button"
            onClick={() => onPick('player')}
            className="group rounded-xl border-2 border-black/10 bg-black/5 p-4 text-left transition hover:border-violet-500/60 hover:bg-violet-500/10 dark:border-white/10 dark:bg-black/20"
          >
            <Smartphone className="mb-2 h-7 w-7 text-violet-400 transition-transform group-hover:scale-110" />
            <div className="text-sm font-bold text-fg">Player Controller</div>
            <div className="mt-0.5 text-[11px] text-sr-3">
              Mobile interface with hint buttons & turn locks
            </div>
          </button>
        </div>

        {hasSession && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] font-medium text-amber-400">
            You have an active session — leave it first to switch views.
          </p>
        )}

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="sr-well w-full rounded-xl py-2 text-xs text-sr-3 transition hover:text-fg"
        >
          Cancel
        </button>
      </DialogContent>
    </Dialog>
  );
}
