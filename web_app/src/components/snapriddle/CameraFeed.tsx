'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Wifi, WifiOff } from 'lucide-react';
import type { CameraMode } from '@/lib/types';

export type FeedStatus = 'idle' | 'live' | 'frozen' | 'judging' | 'passed' | 'failed';

/* Module-level registry of the currently mounted mock-feed canvas so the
   demo engine can grab a still frame (Photo Moments) at snap time without
   prop-drilling a ref through the component tree. Single-instance camera. */
let mockCanvasEl: HTMLCanvasElement | null = null;

/**
 * Grab the current simulated-camera frame as a JPEG data URL.
 * Returns null when the mock feed is not mounted (or capture fails).
 */
export function captureMockFrame(): string | null {
  try {
    if (!mockCanvasEl) return null;
    return mockCanvasEl.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

interface CameraFeedProps {
  mode: CameraMode;
  /** board IP - auto-discovered from the firmware heartbeat */
  espIp: string;
  /** true while the board heartbeat is fresh - drives the waiting panel */
  hardwareOnline?: boolean;
  /** board boot epoch from the heartbeat - a change reopens the stream */
  espBoot?: number;
  status: FeedStatus;
  /** real mode: URL of the frozen /capture JPEG */
  frozenUrl?: string | null;
  /** increments on every snap so the capture URL cache-busts */
  snapSeq?: number;
  /** name of the player being judged - personalizes the status pill */
  judgeName?: string | null;
  className?: string;
}

const STATUS_BORDER: Record<FeedStatus, string> = {
  idle: 'border-white/10',
  live: 'border-white/10',
  frozen: 'border-yellow-400 shadow-[0_0_34px_-8px_rgba(234,179,8,0.65)]',
  judging: 'border-amber-400 shadow-[0_0_34px_-8px_rgba(245,158,11,0.75)]',
  passed: 'border-emerald-500 neon-emerald',
  failed: 'border-rose-500 neon-doom',
};

/**
 * Host camera container.
 * - mock  : animated canvas "simulated ESP32 feed" that freezes in place
 * - real  : MJPEG stream from http://<ip>:81/stream, swaps to the /capture
 *           JPEG snapshot when frozen. The game host runs this page on the
 *           game computer (HTTP), so the direct stream is THE camera path -
 *           the old cloud-preview relay was removed.
 * Handles shutter flash, crosshair overlay and the judging status pill.
 */
export default function CameraFeed({
  mode,
  espIp,
  hardwareOnline = true,
  espBoot = 0,
  status,
  frozenUrl,
  snapSeq = 0,
  judgeName = null,
  className = '',
}: CameraFeedProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [errorSrc, setErrorSrc] = useState<string | null>(null);
  /* bumps to reopen the live stream after an <img> error */
  const [streamRetry, setStreamRetry] = useState(0);
  const frozen = status === 'frozen' || status === 'judging' || status === 'passed' || status === 'failed';

  /* ── Mock camera animation ─────────────────────────────────────────── */
  useEffect(() => {
    if (mode !== 'mock') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    mockCanvasEl = canvas;

    let raf = 0;
    let t = 0;
    const W = (canvas.width = 800);
    const H = (canvas.height = 450);

    const blobs = Array.from({ length: 7 }, (_, i) => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 26 + Math.random() * 60,
      hue: [38, 160, 276, 348][i % 4],
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.3,
      a: 0.05 + Math.random() * 0.06,
    }));

    const draw = (time: number) => {
      // backdrop
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0d1326');
      g.addColorStop(0.55, '#111a33');
      g.addColorStop(1, '#070b16');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // drifting bokeh
      for (const b of blobs) {
        if (!frozen) {
          b.x += b.vx;
          b.y += b.vy;
          if (b.x < -b.r) b.x = W + b.r;
          if (b.x > W + b.r) b.x = -b.r;
          if (b.y < -b.r) b.y = H + b.r;
          if (b.y > H + b.r) b.y = -b.r;
        }
        const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        rg.addColorStop(0, `hsla(${b.hue}, 85%, 60%, ${b.a})`);
        rg.addColorStop(1, 'hsla(0,0%,0%,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // perspective floor grid
      ctx.strokeStyle = 'rgba(148,163,184,0.10)';
      ctx.lineWidth = 1;
      const horizon = H * 0.62;
      for (let i = 0; i <= 12; i++) {
        const x = (W / 12) * i;
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(W / 2 + (x - W / 2) * 0.25, horizon);
        ctx.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const p = i / 6;
        const y = horizon + (H - horizon) * p * p;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // rotating abstract "object" on the platform
      const cx = W / 2;
      const cy = horizon + (H - horizon) * 0.32;
      const s = 46 + Math.sin(time / 900) * 3;
      ctx.save();
      ctx.translate(cx, cy - s * 0.6);
      ctx.rotate(frozen ? 0.5 : time / 2400);
      ctx.fillStyle = 'rgba(245,158,11,0.16)';
      ctx.strokeStyle = 'rgba(251,191,36,0.65)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + s * 0.28, s * 0.75, s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      // scanlines
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = (frozen ? 0 : time / 24) % 4; y < H; y += 4) {
        ctx.fillRect(0, y, W, 1);
      }

      // HUD
      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = 'rgba(226,232,240,0.75)';
      ctx.fillText('ESP32-S3 · SIMULATED FEED · SVGA 800x600', 14, H - 16);
      const ts = new Date().toLocaleTimeString();
      ctx.fillText(ts, W - 108, 26);
      if (!frozen || Math.floor(time / 600) % 2 === 0) {
        ctx.fillStyle = 'rgba(244,63,94,0.95)';
        ctx.beginPath();
        ctx.arc(W - 84, 22, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(226,232,240,0.9)';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('REC', W - 74, 26);
      }

      if (!frozen) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      if (mockCanvasEl === canvas) mockCanvasEl = null;
    };
  }, [mode, frozen]);

  /* A board reboot ends the MJPEG response without an <img> error, leaving
     a dead frame on screen. The URL carries the boot epoch, so a reboot
     (new heartbeat `boot`) remounts the stream; the board ignores the query. */
  const realLiveSrc = `http://${espIp}:81/stream?b=${espBoot}-${streamRetry}`;
  const realFrozenSrc = frozenUrl ?? `http://${espIp}/capture?t=${snapSeq}`;
  const currentSrc = frozen ? realFrozenSrc : realLiveSrc;
  const realError = mode === 'real' && errorSrc === currentSrc;

  /* A failed live stream retries every 3 s instead of staying on the
     unreachable panel until the page is reloaded. */
  useEffect(() => {
    if (!realError || frozen) return;
    const t = setTimeout(() => setStreamRetry((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [realError, frozen]);
  /* No board heartbeat yet (or the IP is still unknown) → show the honest
     waiting panel instead of a doomed <img>. Cameras need zero config: the
     address rides the firmware heartbeat. */
  const waitingForCamera = mode === 'real' && (!espIp || !hardwareOnline) && !frozen;

  return (
    <div
      className={`relative w-full overflow-hidden rounded-2xl border-2 transition-all duration-300 ${STATUS_BORDER[status]} ${className}`}
      style={{ background: '#070b16', aspectRatio: '16 / 9' }}
    >
      {/* Feed */}
      {mode === 'mock' ? (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Simulated camera feed" />
      ) : waitingForCamera ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <Wifi className="h-10 w-10 animate-pulse text-sky-300" />
          <p className="text-sm font-bold text-white">Waiting for camera…</p>
          <p className="max-w-md text-xs text-sr-3">
            The camera board has not checked in yet. Power it on, keep it on the
            same WiFi as this screen — it announces itself automatically, no IP
            typing needed.
          </p>
        </div>
      ) : realError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <WifiOff className="h-10 w-10 text-rose-400" />
          <p className="text-sm font-bold text-white">ESP32 stream unreachable</p>
          <p className="max-w-md text-xs text-sr-3">
            Check that the board is powered, on the same WiFi, and that{' '}
            <code className="rounded bg-black/40 px-1">{`http://${esp32Display(espIp)}:81/stream`}</code>{' '}
            opens. (The host screen must be opened on the game computer over
            HTTP for the live stream to load.)
          </p>
        </div>
      ) : (
        <img
          src={currentSrc}
          alt={frozen ? 'Frozen proof snapshot from ESP32' : 'Live ESP32 camera stream'}
          className="absolute inset-0 h-full w-full object-contain"
          onError={() => setErrorSrc(currentSrc)}
        />
      )}

      {/* Crosshair overlay */}
      <div className="pointer-events-none absolute inset-4 rounded-xl border border-dashed border-white/15">
        <span className="absolute left-2 top-2 h-6 w-6 border-l-2 border-t-2 border-amber-400/70" />
        <span className="absolute right-2 top-2 h-6 w-6 border-r-2 border-t-2 border-amber-400/70" />
        <span className="absolute bottom-2 left-2 h-6 w-6 border-b-2 border-l-2 border-amber-400/70" />
        <span className="absolute bottom-2 right-2 h-6 w-6 border-b-2 border-r-2 border-amber-400/70" />
      </div>

      {/* Status chips */}
      {status === 'idle' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45">
          <Camera className="h-8 w-8 animate-pulse text-sr-3" />
          <p className="font-mono text-xs text-sr-3">Waiting for match to start…</p>
        </div>
      )}
      {status === 'live' && !waitingForCamera && !realError && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-3 py-1 font-mono text-[10px] text-emerald-300 backdrop-blur-sm">
          {mode === 'real' ? <Wifi className="h-3 w-3" /> : null}
          {mode === 'real' ? `LIVE · http://${esp32Display(espIp)}:81/stream` : 'Hold the object steady in frame for the AI judge'}
        </div>
      )}

      {/* Gemini judging: the photo stays clear at
          full brightness; a slim status pill rides the bottom edge instead
          of the old blur+dark overlay (wording bank §5). */}
      {status === 'judging' && <JudgingPill name={judgeName} />}

      {/* Shutter flash - retriggers on every capture */}
      {frozen && (
        <div key={`flash-${snapSeq}-${status}`} className="animate-shutter pointer-events-none absolute inset-0 z-30 bg-white" />
      )}
    </div>
  );
}

function esp32Display(ip: string) {
  return ip || '192.168.1.100';
}

/** Owner-approved judging status pill (design Option A): clear photo + a
 *  slim glass pill (≤ 40 px tall) - spinner, whose-photo line, shimmer
 *  progress bar, and the honest "usually a few seconds". Owns its 1 s tick
 *  so the feed itself never re-renders; swaps to the patient wording from
 *  the wording bank after 8 s of silence. */
function JudgingPill({ name }: { name?: string | null }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(iv);
  }, []);
  const line =
    secs >= 8
      ? 'Still checking — the camera board is being patient…'
      : name
        ? `Checking ${name}'s photo…`
        : 'The camera board is checking…';
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-3 left-1/2 z-20 flex max-w-[94%] -translate-x-1/2 items-center gap-2.5 rounded-full border border-amber-400/40 bg-black/70 px-4 py-2 shadow-lg shadow-amber-500/10 backdrop-blur-md"
    >
      <span
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
        aria-hidden
      />
      <span className="truncate text-xs font-bold text-amber-100">{line}</span>
      <span className="hidden shrink-0 items-center gap-2 sm:flex" aria-hidden>
        <span className="h-0.5 w-16 overflow-hidden rounded-full bg-white/15">
          <span className="animate-sr-shimmer block h-full w-1/3 rounded-full bg-amber-400" />
        </span>
        <span className="text-[10px] font-semibold text-sr-3">usually a few seconds</span>
      </span>
    </div>
  );
}
