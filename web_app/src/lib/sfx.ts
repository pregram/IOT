/**
 * WebAudio sound effects, synthesized live so no audio assets ship with the app.
 * Every call is a no-op when muted or when WebAudio is unavailable.
 */

import type { SoundCueId } from './types';

let ctx: AudioContext | null = null;

/* Master SFX volume (0..100 in settings), applied to every tone and noise burst.
   Seeded from localStorage so phone components that call sfx directly get the saved
   level before the settings drawer syncs it. */
let masterVol = 1;
try {
  if (typeof window !== 'undefined') {
    const raw = window.localStorage.getItem('snapriddle:settings');
    const stored = raw ? (JSON.parse(raw) as { sfx_volume?: unknown }).sfx_volume : undefined;
    if (typeof stored === 'number') {
      masterVol = Math.min(1, Math.max(0, stored / 100));
    }
  }
} catch {
  /* settings unreadable: default volume stays */
}

/** Live-update the master SFX volume (0..100). Called when settings change. */
export function setSfxVolume(percent: number) {
  masterVol = Math.min(1, Math.max(0, percent / 100));
}

/** Current master SFX volume in percent (0..100). */
export function getSfxVolume(): number {
  return Math.round(masterVol * 100);
}

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface ToneOpts {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
  slideTo?: number;
}

function tone({ freq, dur, type = 'sine', gain = 0.12, delay = 0, slideTo }: ToneOpts) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
  const v = Math.max(0, gain * masterVol);
  g.gain.setValueAtTime(0.0001, t0);
  // exponentialRamp cannot target 0 - floor at an inaudible level
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseBurst(dur: number, gain = 0.2, delay = 0) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const frames = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, frames, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.setValueAtTime(Math.max(0, gain * masterVol), t0);
  src.buffer = buf;
  src.connect(g).connect(a.destination);
  src.start(t0);
}

export function sfxShutter(muted: boolean) {
  if (muted) return;
  noiseBurst(0.09, 0.25);
  tone({ freq: 1400, dur: 0.06, type: 'square', gain: 0.08, delay: 0.02 });
  tone({ freq: 700, dur: 0.08, type: 'square', gain: 0.06, delay: 0.09 });
}

export function sfxPass(muted: boolean) {
  if (muted) return;
  tone({ freq: 523.25, dur: 0.12, type: 'triangle', gain: 0.14 });
  tone({ freq: 659.25, dur: 0.12, type: 'triangle', gain: 0.14, delay: 0.1 });
  tone({ freq: 783.99, dur: 0.2, type: 'triangle', gain: 0.16, delay: 0.2 });
}

export function sfxFail(muted: boolean) {
  if (muted) return;
  tone({ freq: 240, dur: 0.3, type: 'sawtooth', gain: 0.12, slideTo: 110 });
}

export function sfxUnclear(muted: boolean) {
  if (muted) return;
  tone({ freq: 320, dur: 0.15, type: 'square', gain: 0.08 });
  tone({ freq: 280, dur: 0.15, type: 'square', gain: 0.08, delay: 0.18 });
}

export function sfxWhoosh(muted: boolean) {
  if (muted) return;
  noiseBurst(0.25, 0.08);
  tone({ freq: 200, dur: 0.25, type: 'sine', gain: 0.06, slideTo: 600 });
}

export function sfxFanfare(muted: boolean) {
  if (muted) return;
  const seq: Array<[number, number]> = [
    [523.25, 0], [659.25, 0.12], [783.99, 0.24], [1046.5, 0.36],
    [783.99, 0.56], [1046.5, 0.68],
  ];
  for (const [f, d] of seq) tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.16, delay: d });
  tone({ freq: 261.63, dur: 1.0, type: 'sine', gain: 0.1, delay: 0.36 });
  tone({ freq: 329.63, dur: 1.0, type: 'sine', gain: 0.1, delay: 0.36 });
}

export function sfxTick(muted: boolean) {
  if (muted) return;
  tone({ freq: 900, dur: 0.04, type: 'square', gain: 0.05 });
}

export function sfxJoin(muted: boolean) {
  if (muted) return;
  tone({ freq: 440, dur: 0.1, type: 'sine', gain: 0.1 });
  tone({ freq: 660, dur: 0.14, type: 'sine', gain: 0.1, delay: 0.09 });
}

/** Bubbly pop for incoming emoji reactions (pitch varies per call). */
export function sfxPop(muted: boolean, pitch = 1) {
  if (muted) return;
  tone({ freq: 500 * pitch, dur: 0.07, type: 'sine', gain: 0.09, slideTo: 900 * pitch });
}

/** "You're up" cue on the player's own phone when their turn starts (pairs with a vibration). */
export function sfxRally(muted: boolean) {
  if (muted) return;
  tone({ freq: 660, dur: 0.11, type: 'triangle', gain: 0.16 });
  tone({ freq: 880, dur: 0.16, type: 'triangle', gain: 0.18, delay: 0.13 });
  tone({ freq: 1320, dur: 0.22, type: 'sine', gain: 0.14, delay: 0.3 });
}

/** One short jingle per hype emoji, so the room can hear what the crowd reacts with. */
export function sfxReaction(muted: boolean, emoji: string) {
  if (muted) return;
  switch (emoji) {
    case '🔥': // crackle + low ember rumble
      noiseBurst(0.22, 0.1);
      tone({ freq: 130, dur: 0.24, type: 'square', gain: 0.07, slideTo: 90 });
      break;
    case '👏': // double clap
      noiseBurst(0.05, 0.18);
      noiseBurst(0.06, 0.16, 0.11);
      break;
    case '😂': // cartoon boing (down then up)
      tone({ freq: 620, dur: 0.16, type: 'sine', gain: 0.11, slideTo: 240 });
      tone({ freq: 240, dur: 0.2, type: 'sine', gain: 0.1, delay: 0.15, slideTo: 700 });
      break;
    case '😱': // shrieking rising slide
      tone({ freq: 420, dur: 0.34, type: 'sawtooth', gain: 0.08, slideTo: 1500 });
      break;
    case '🎉': // three-note party chirp
      tone({ freq: 659.25, dur: 0.09, type: 'triangle', gain: 0.13 });
      tone({ freq: 830.61, dur: 0.09, type: 'triangle', gain: 0.13, delay: 0.09 });
      tone({ freq: 1046.5, dur: 0.16, type: 'triangle', gain: 0.14, delay: 0.18 });
      break;
    case '💀': // ominous descending
      tone({ freq: 300, dur: 0.3, type: 'sawtooth', gain: 0.09, slideTo: 95 });
      tone({ freq: 150, dur: 0.22, type: 'sine', gain: 0.07, delay: 0.18, slideTo: 70 });
      break;
    default:
      sfxPop(muted, 0.85 + Math.random() * 0.5);
  }
}

/* Sound Board metadata, shared by the TV chips, the phone banner and feed lines */

export interface SoundCueMeta {
  id: SoundCueId;
  emoji: string;
  label: string;
  /** live-feed line written when the host fires the cue */
  feedText: string;
  /** tailwind classes for the TV sound-board chip (light + dark contrast) */
  chipCls: string;
}

export const SOUND_CUES: SoundCueMeta[] = [
  {
    id: 'airhorn',
    emoji: '📣',
    label: 'Airhorn',
    feedText: '📣 Host blasted the AIRHORN! Everybody up!',
    chipCls:
      'border-orange-500/40 bg-orange-500/10 text-orange-600 hover:border-orange-400 hover:bg-orange-500/25 hover:shadow-orange-500/30 dark:text-orange-300',
  },
  {
    id: 'drumroll',
    emoji: '🥁',
    label: 'Drumroll',
    feedText: '🥁 Drumroll please…',
    chipCls:
      'border-violet-500/40 bg-violet-500/10 text-violet-700 hover:border-violet-400 hover:bg-violet-500/25 hover:shadow-violet-500/30 dark:text-violet-300',
  },
  {
    id: 'rimshot',
    emoji: '😸',
    label: 'Rimshot',
    feedText: '😸 Ba-dum-tss! Comedy gold.',
    chipCls:
      'border-sky-500/40 bg-sky-500/10 text-sky-700 hover:border-sky-400 hover:bg-sky-500/25 hover:shadow-sky-500/30 dark:text-sky-300',
  },
  {
    id: 'tada',
    emoji: '🎉',
    label: 'Ta-Da!',
    feedText: '🎉 TADA! What a moment!',
    chipCls:
      'border-amber-500/40 bg-amber-500/10 text-amber-700 hover:border-amber-400 hover:bg-amber-500/25 hover:shadow-amber-500/30 dark:text-amber-300',
  },
];

/**
 * Host-triggered Sound Board jingles, synthesized on every device (TV and phones):
 * airhorn, drumroll, rimshot and ta-da.
 */
export function sfxSoundBoard(muted: boolean, sound: SoundCueId) {
  if (muted) return;
  switch (sound) {
    case 'airhorn': {
      // three rising stadium blasts - two detuned sawtooths per blast
      for (let i = 0; i < 3; i++) {
        const d = i * 0.34;
        tone({ freq: 440, dur: 0.24, type: 'sawtooth', gain: 0.13, delay: d, slideTo: 466 });
        tone({ freq: 452, dur: 0.24, type: 'square', gain: 0.09, delay: d, slideTo: 480 });
        tone({ freq: 220, dur: 0.24, type: 'sawtooth', gain: 0.07, delay: d });
      }
      break;
    }
    case 'drumroll': {
      // accelerating snare bursts into a cymbal crash
      for (let i = 0; i < 9; i++) {
        noiseBurst(0.045, 0.07 + i * 0.012, i * 0.062);
      }
      noiseBurst(0.42, 0.16, 0.6);
      tone({ freq: 3400, dur: 0.4, type: 'sine', gain: 0.05, delay: 0.6, slideTo: 1600 });
      break;
    }
    case 'rimshot': {
      // ba-dum-tss - two toms, then an open hi-hat shimmer
      tone({ freq: 196, dur: 0.1, type: 'triangle', gain: 0.2 });
      tone({ freq: 147, dur: 0.12, type: 'triangle', gain: 0.2, delay: 0.15 });
      noiseBurst(0.06, 0.12, 0.32);
      tone({ freq: 3200, dur: 0.55, type: 'sine', gain: 0.05, delay: 0.33, slideTo: 1200 });
      break;
    }
    case 'tada': {
      // bright arpeggio + long shimmer on top
      const seq: Array<[number, number]> = [
        [523.25, 0], [659.25, 0.09], [783.99, 0.18], [1046.5, 0.27],
      ];
      for (const [f, d] of seq) tone({ freq: f, dur: 0.24, type: 'triangle', gain: 0.16, delay: d });
      tone({ freq: 2093, dur: 0.7, type: 'sine', gain: 0.05, delay: 0.34 });
      noiseBurst(0.3, 0.05, 0.34);
      break;
    }
  }
}
