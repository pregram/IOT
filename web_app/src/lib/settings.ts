/**
 * Host hardware settings (localStorage) and the HTTP bridge to the board.
 * Settings are device-local on purpose: the host laptop owns the physical camera
 * and voice configuration.
 */

import type { Esp32ProbeResult, HardwareSettings } from './types';
import { sync } from './firebase';

const LS_SETTINGS = 'snapriddle:settings';
const LS_THEME = 'snapriddle:theme';

export const DEFAULT_SETTINGS: HardwareSettings = {
  esp32_ip: '192.168.1.100',
  resolution: 'SVGA',
  quality: 12,
  flip_h: false,
  flip_v: false,
  brightness: 0,
  contrast: 0,
  awb: true,
  awb_gain: true,
  special_fx: 0,
  voice_profile: 'Kore',
  voice_speed: 1.0,
  voice_volume: 18,
  muted: false,
  esp_speaker: true,
  sfx_volume: 80,
  theme: 'dark',
  join_url_base: '',
};

const RESOLUTIONS = ['QVGA', 'VGA', 'SVGA', 'XGA', 'UXGA'] as const;
const VOICES = ['Zephyr', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Charon'] as const;

export function loadSettings(): HardwareSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<HardwareSettings>;
    const s: HardwareSettings = { ...DEFAULT_SETTINGS, ...parsed };
    // stored values may predate the current ranges
    if (!RESOLUTIONS.includes(s.resolution)) s.resolution = 'SVGA';
    if (!VOICES.includes(s.voice_profile as (typeof VOICES)[number])) s.voice_profile = 'Kore';
    s.quality = clamp(Math.round(s.quality), 10, 63);
    s.brightness = clamp(Math.round(s.brightness), -2, 2);
    s.contrast = clamp(Math.round(s.contrast), -2, 2);
    s.special_fx = clamp(Math.round(s.special_fx), 0, 6);
    s.voice_speed = clamp(Math.round(s.voice_speed * 10) / 10, 0.5, 2);
    s.voice_volume = clamp(Math.round(s.voice_volume), 0, 21);
    s.sfx_volume = clamp(Math.round(s.sfx_volume), 0, 100);
    s.esp_speaker = s.esp_speaker !== false;
    s.theme = s.theme === 'light' ? 'light' : 'dark';
    s.join_url_base = typeof s.join_url_base === 'string' ? s.join_url_base.trim() : '';
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: HardwareSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  } catch {
    /* storage blocked: settings just won't persist */
  }
  applyTheme(s.theme);
}

export function applyTheme(theme: 'dark' | 'light') {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(LS_THEME, theme);
  } catch {
    /* storage blocked: theme just won't persist */
  }
}

export function getInitialTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  try {
    return window.localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** The ESP32 register is inverted (10 = best, 63 = fastest); the UI shows 0-100%. */
export function qualityToPercent(espValue: number): number {
  return Math.round(((63 - clamp(espValue, 10, 63)) / 53) * 100);
}

export function percentToQuality(percent: number): number {
  return clamp(63 - Math.round((clamp(percent, 0, 100) / 100) * 53), 10, 63);
}

/** JSON payload the ESP32-S3 firmware expects at POST /settings. */
export function esp32SettingsPayload(s: HardwareSettings) {
  return {
    resolution: s.resolution,
    quality: s.quality,
    flip_h: s.flip_h,
    flip_v: s.flip_v,
    brightness: s.brightness,
    contrast: s.contrast,
    awb: s.awb ? 1 : 0,
    awb_gain: s.awb_gain ? 1 : 0,
    special_effect: s.special_fx,
    voice: s.voice_profile,
    speed: s.voice_speed,
    volume: s.voice_volume,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, mode: 'no-cors' as RequestMode });
  } finally {
    clearTimeout(t);
  }
}

/**
 * POST /speak straight to the board, skipping the Firebase cmd/cmdq round-trip.
 * Unlike pushSettingsToEsp32() this is a real CORS fetch: the board answers
 * {"ok":true|false} with Access-Control-Allow-Origin: *, and the caller needs that
 * answer to decide whether to fall back to cmd/cmdq.
 * @returns false on any failure (network, non-2xx, {"ok":false}, no IP yet).
 */
export async function speakDirectToEsp32(
  ip: string,
  id: number,
  text: string,
  priority: boolean,
): Promise<boolean> {
  if (!ip.trim()) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    let res: Response;
    try {
      res = await fetch(`http://${ip}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, say: text, p: priority ? 1 : 0 }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return Boolean(j?.ok);
  } catch {
    return false;
  }
}

/**
 * Push settings to the board: direct LAN POST first. HTTPS pages block requests to
 * http:// LAN devices, so on failure it checks the cloud heartbeat instead; the board
 * also polls hardware_session/esp_settings, so the settings still arrive.
 * `no-cors` makes the response opaque, so success here means "sent", not "applied".
 */
export async function pushSettingsToEsp32(s: HardwareSettings): Promise<Esp32ProbeResult> {
  if (!s.esp32_ip.trim()) return { ok: false, message: 'ESP32 IP address is empty.' };
  try {
    await fetchWithTimeout(
      `http://${s.esp32_ip}/settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(esp32SettingsPayload(s)),
      },
      4000,
    );
    return { ok: true, message: `Settings pushed to ESP32 at ${s.esp32_ip}.` };
  } catch {
    const cloud = await probeEsp32Cloud();
    if (cloud.ok) {
      return {
        ok: true,
        message: 'Direct HTTP is blocked by the browser (HTTPS page) — settings were mirrored to the board via the cloud instead.',
      };
    }
    return {
      ok: false,
      message: `Could not reach http://${s.esp32_ip}/settings and the board heartbeat is stale — check the ESP32 is powered & online.`,
    };
  }
}

/** Reachability probe (GET /status). Only works when the host page is served over plain HTTP. */
export async function probeEsp32(ip: string): Promise<Esp32ProbeResult> {
  if (!ip.trim()) return { ok: false, message: 'ESP32 IP address is empty.' };
  try {
    await fetchWithTimeout(`http://${ip}/status`, { method: 'GET' }, 3000);
    return { ok: true, message: `ESP32 responded at ${ip}.` };
  } catch {
    return { ok: false, message: `No response from ${ip} (3s timeout).` };
  }
}

/** Cloud heartbeat probe for HTTPS pages. Fresh = a heartbeat within the last 15 s. */
export async function probeEsp32Cloud(): Promise<Esp32ProbeResult> {
  try {
    const esp = (await sync.get('hardware_session/esp')) as {
      ip?: string;
      fw?: string;
      rssi?: number;
      heap?: number;
      ts?: number;
    } | null;
    if (!esp?.ts) {
      return { ok: false, message: 'No ESP32 heartbeat found in the cloud — is the board flashed, powered and on WiFi?' };
    }
    const ageSec = Math.round((Date.now() - esp.ts) / 1000);
    if (ageSec > 15) {
      return { ok: false, message: `Board heartbeat is stale (${ageSec}s old) — is the ESP32 still powered & online?` };
    }
    return {
      ok: true,
      message: `ESP32 is alive via cloud (fw ${esp.fw ?? '?'} · ${esp.rssi ?? '?'} dBm · ${esp.ip ?? '?'}) — direct HTTP is blocked on HTTPS pages, so the cloud path drives the board.`,
    };
  } catch {
    return { ok: false, message: 'Cloud probe failed — no sync connection available.' };
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}
