'use client';

import { Activity, Camera, Maximize, Settings, Smartphone, Tv, Volume2, VolumeX } from 'lucide-react';
import type { Role } from '@/lib/types';

interface HeaderProps {
  role: Role | null;
  muted: boolean;
  onToggleMute: (m: boolean) => void;
  onOpenSettings: () => void;
  onSwitchRole: () => void;
}

export default function Header({
  role,
  muted,
  onToggleMute,
  onOpenSettings,
  onSwitchRole,
}: HeaderProps) {
  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch {
      /* fullscreen unsupported */
    }
  };
  return (
    <header
      className="sticky top-0 z-40 flex w-full items-center justify-between border-b px-3 py-2.5 backdrop-blur-md md:px-5"
      style={{ background: 'var(--sr-nav)', borderColor: 'var(--sr-line)' }}
    >
      {/* Brand */}
      <div className="flex cursor-pointer items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-rose-500 shadow-lg shadow-amber-500/25">
          <Camera className="h-5 w-5 text-fg" />
        </div>
        <h1 className="font-display text-lg font-bold tracking-tight">
          Snap<span className="text-amber-400">Riddle</span>
        </h1>
      </div>

      {/* Center: role label only (plain 13 px text). Sync/camera status chips
          were removed by owner decision - silence is the honest idle state. */}
      <div className="hidden items-center gap-1.5 text-[13px] text-sr-2 md:flex">
        {role === 'host' ? <Tv className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
        {role === 'host' ? 'Host View' : role === 'player' ? 'Player Controller' : 'Viewer Mode'}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggleMute(!muted)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border text-sr-2 transition hover:text-fg"
          style={{ borderColor: 'var(--sr-line)', background: 'var(--sr-well)' }}
          title={muted ? 'Unmute sound effects' : 'Mute sound effects'}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="h-4.5 w-4.5" /> : <Volume2 className="h-4.5 w-4.5" />}
        </button>
        {role === 'host' && (
          <button
            type="button"
            onClick={toggleFullscreen}
            className="hidden h-10 w-10 items-center justify-center rounded-xl border text-sr-2 transition hover:text-fg sm:flex"
            style={{ borderColor: 'var(--sr-line)', background: 'var(--sr-well)' }}
            title="Toggle fullscreen (great for TVs)"
            aria-label="Toggle fullscreen"
          >
            <Maximize className="h-4.5 w-4.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onSwitchRole}
          className="flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold text-sr-2 transition hover:text-fg md:px-3"
          style={{ borderColor: 'var(--sr-line)', background: 'var(--sr-well)' }}
          title="Switch view mode — open the Host TV or the Player Controller on THIS device (handy when the host wants to play from the same laptop)"
        >
          <Activity className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">View Mode</span>
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="group flex h-10 w-10 items-center justify-center rounded-xl border text-sr-2 transition hover:rotate-45 hover:text-fg"
          style={{ borderColor: 'var(--sr-line)', background: 'var(--sr-well)' }}
          title="Hardware & Engine Settings"
          aria-label="Open hardware settings"
        >
          <Settings className="h-4.5 w-4.5 transition-transform" />
        </button>
      </div>
    </header>
  );
}
