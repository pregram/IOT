'use client';

import { useEffect, useState } from 'react';
import {
  Bot,
  ChevronRight,
  Cpu,
  Loader2,
  Microchip,
  Moon,
  Sliders,
  Sun,
  Video,
  Volume2,
  Wifi,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  qualityToPercent,
  percentToQuality,
  probeEsp32,
  probeEsp32Cloud,
  esp32SettingsPayload,
} from '@/lib/settings';
import { sync } from '@/lib/firebase';
import { GEMINI_TEST_KEY, GEMINI_TEST_MODEL, GEMINI_TEST_TIMEOUT_MS } from '@/lib/aiConfig';
import type { Esp32ProbeResult, HardwareSettings, HwEspStatus } from '@/lib/types';

interface SettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: HardwareSettings;
  /** live firmware heartbeat (hardware_session/esp) - null when offline */
  espStatus?: HwEspStatus | null;
  onSave: (s: HardwareSettings) => void;
}

const RESOLUTIONS = [
  { value: 'QVGA', label: 'QVGA (320×240)' },
  { value: 'VGA', label: 'VGA (640×480)' },
  { value: 'SVGA', label: 'SVGA (800×600)' },
  { value: 'XGA', label: 'XGA (1024×768)' },
  { value: 'UXGA', label: 'UXGA (1600×1200)' },
];

const VOICES = [
  { value: 'Zephyr', label: 'Zephyr (Bright)' },
  { value: 'Puck', label: 'Puck (Upbeat)' },
  { value: 'Kore', label: 'Kore (Firm Game Master)' },
  { value: 'Fenrir', label: 'Fenrir (Excitable)' },
  { value: 'Aoede', label: 'Aoede (Breezy)' },
  { value: 'Charon', label: 'Charon (Informative)' },
];

const FX = [
  { value: '0', label: 'No Effect' },
  { value: '1', label: 'Negative' },
  { value: '2', label: 'Grayscale' },
  { value: '3', label: 'Red Tint' },
  { value: '4', label: 'Green Tint' },
  { value: '5', label: 'Blue Tint' },
  { value: '6', label: 'Sepia' },
];

export default function SettingsDrawer({ open, onOpenChange, settings, espStatus, onSave }: SettingsDrawerProps) {
  // Draft re-initializes on each open via key-remount (see parent usage).
  const [draft, setDraft] = useState<HardwareSettings>(settings);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Esp32ProbeResult | null>(null);
  // The app already gates espStatus through the gen-aware freshness
  // rule (a busy board = "thinking", not offline); the drawer just reflects it.
  const espLive = Boolean(espStatus);
  const espThinking = espLive && Boolean(espStatus?.gen);

  // "Force Fallback Models" toggle. The flag rides in
  // hardware_session/esp_settings (merged into the FULL node - the board
  // re-applies the whole payload when its raw form changes) and the board's
  // rotation wheel skips every Gemini model while it is set.
  const [forceFallback, setForceFallback] = useState<boolean | null>(null);
  // LIVE subscription (ported from the branch): the DB is
  // the single source of truth, so the drawer always shows the flag exactly
  // as the board sees it, across screen and game-state changes.
  useEffect(() => {
    const unsub = sync.subscribe('hardware_session/esp_settings', (v) => {
      setForceFallback(Boolean((v as Record<string, unknown> | null)?.force_fallback));
    });
    return unsub;
  }, []);
  const toggleForceFallback = async (on: boolean) => {
    setForceFallback(on); // optimistic - the DB echo confirms
    try {
      const cur = (await sync.get('hardware_session/esp_settings')) as Record<string, unknown> | null;
      await sync.update('hardware_session/esp_settings', {
        ...(cur ?? {}),
        force_fallback: on,
      });
    } catch {
      setForceFallback(!on);
    }
  };

  // "Test Gemini" - ONE bounded text ping from the WEB
  // (not the board) with one key, purely display. No retry cascade.
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [geminiResult, setGeminiResult] = useState<Esp32ProbeResult | null>(null);
  const testGemini = async () => {
    setGeminiTesting(true);
    setGeminiResult(null);
    if (!GEMINI_TEST_KEY) {
      setGeminiResult({
        ok: false,
        message: 'No key configured — paste it into src/lib/aiConfig.ts (same key as firmware config.h).',
      });
      setGeminiTesting(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEST_MODEL}:generateContent?key=${GEMINI_TEST_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
          }),
          signal: ctrl.signal,
        },
      );
      clearTimeout(timer);
      if (res.ok) {
        setGeminiResult({ ok: true, message: `Gemini OK — ${GEMINI_TEST_MODEL} responded.` });
      } else {
        let detail = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j?.error?.message) detail = j.error.message.slice(0, 90);
        } catch {
          /* keep the status-code fallback */
        }
        setGeminiResult({ ok: false, message: `Gemini error — ${detail}` });
      }
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as DOMException)?.name === 'AbortError';
      setGeminiResult({
        ok: false,
        message: aborted ? 'Gemini test timed out (12 s) — check the network.' : 'Gemini test failed — network error.',
      });
    } finally {
      setGeminiTesting(false);
    }
  };

  const patch = (p: Partial<HardwareSettings>) => setDraft((d) => ({ ...d, ...p }));

  const testConnection = async () => {
    setProbing(true);
    setProbe(null);
    // The camera IP is discovered from the firmware heartbeat - probe
    // that first, then fall back to the cloud heartbeat (works even when
    // direct LAN HTTP is blocked by the browser).
    const ip = espStatus?.ip || draft.esp32_ip;
    const direct = await probeEsp32(ip);
    const res = direct.ok ? direct : await probeEsp32Cloud();
    setProbe(res);
    setProbing(false);
  };

  const save = () => onSave(draft);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sr-glass w-full max-w-xl overflow-y-auto rounded-l-3xl border-l-2 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b p-5" style={{ borderColor: 'var(--sr-line)' }}>
          <SheetTitle className="font-display flex items-center gap-2 text-lg text-fg">
            <Sliders className="h-5 w-5 text-amber-400" /> Hardware & Engine Settings
          </SheetTitle>
          <SheetDescription className="text-xs text-sr-3">
            Camera calibration, Voice Master audio & appearance — pushed to the ESP32 via local
            HTTP POST.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-7 p-5 text-xs">
          {/* ESP32 board */}
          <section className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Microchip className="h-3.5 w-3.5" /> ESP32-S3 Board Config
            </h4>
            {/* 📸 No IP field, no camera-source switch: the board announces
                itself via the heartbeat below and the camera is always real.
                Demo rooms (Fast Demo Launch) use the simulated feed instead. */}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={testConnection} disabled={probing} className="rounded-lg text-[11px]">
                {probing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wifi className="mr-1 h-3 w-3" />}
                Test Connection
              </Button>
              {probe && (
                <span className={`text-[11px] font-semibold ${probe.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {probe.message}
                </span>
              )}
            </div>
          </section>

          {/* Hardware integration (firmware link) */}
          <section className="space-y-3 border-t pt-5" style={{ borderColor: 'var(--sr-line)' }}>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Cpu className="h-3.5 w-3.5" /> Hardware Integration
            </h4>

            {/* 🔌 firmware heartbeat */}
            <div
              className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
                espLive ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-500/25 bg-slate-500/5'
              }`}
              role="status"
              aria-label={espLive ? 'ESP32 firmware online' : 'ESP32 firmware offline'}
            >
              <Cpu className={`h-3.5 w-3.5 shrink-0 ${espLive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`} />
              {espLive && espStatus ? (
                <>
                  <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">Firmware online</span>
                  <span className="font-mono text-[10px] text-sr-3">
                    {espStatus.ip} · {espStatus.rssi} dBm · {Math.max(0, Math.round(espStatus.heap / 1024))} KB free · {espStatus.fw}
                  </span>
                  {espThinking && (
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden />
                      {espStatus!.gen === 'judge'
                        ? 'Board is judging the photo…'
                        : espStatus!.gen === 'hint'
                          ? 'Board is writing a hint…'
                          : 'Board is writing a riddle…'}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-[11px] font-semibold text-sr-3">
                  Firmware offline — flash the board &amp; join it to your WiFi to see live status.
                </span>
              )}
            </div>

            {/* 🔊 ESP room speaker */}
            <div
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
              style={{ borderColor: 'var(--sr-line)' }}
            >
              <div className="min-w-0">
                <Label className="text-sr-2">🔊 ESP32 Room Speaker</Label>
                <p className="mt-0.5 text-[10px] leading-snug text-sr-3">
                  Voice Master lines ride the cloud to the board's speaker (edge-TTS relay). The TV caption still shows.
                </p>
              </div>
              <Switch
                checked={draft.esp_speaker}
                onCheckedChange={(v) => patch({ esp_speaker: v })}
                aria-label="ESP32 room speaker"
              />
            </div>

          </section>

          {/* AI engine (LLM provider) */}
          <section className="space-y-3 border-t pt-5" style={{ borderColor: 'var(--sr-line)' }}>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Bot className="h-3.5 w-3.5" /> AI Engine (LLM)
            </h4>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void testGemini()}
                disabled={geminiTesting}
                className="rounded-lg text-[11px]"
              >
                {geminiTesting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Bot className="mr-1 h-3 w-3" />}
                Test Gemini
              </Button>
              {geminiResult && (
                <span
                  className={`text-[11px] font-semibold ${
                    geminiResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {geminiResult.message}
                </span>
              )}
            </div>
            <div
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
              style={{ borderColor: 'var(--sr-line)' }}
            >
              <div className="min-w-0">
                <Label className="text-sr-2">Force Fallback Models</Label>
                <p className="mt-0.5 text-[10px] leading-snug text-sr-3">
                  Skips every Gemini model on the board — riddles, hints and image judging — and routes everything
                  through the fallback chain (Groq, then OpenRouter). Stays on until switched off, even across
                  screen and game-state changes.
                </p>
                <p className="mt-1 text-[10px] leading-snug text-amber-500/90">
                  Needs the Groq / OpenRouter API keys in the board&apos;s firmware config — without them no provider
                  is left to serve requests.
                </p>
              </div>
              <Switch
                checked={Boolean(forceFallback)}
                onCheckedChange={(v) => void toggleForceFallback(v)}
                aria-label="Force fallback models"
              />
            </div>
          </section>

          {/* Camera controls */}
          <section className="space-y-4 border-t pt-5" style={{ borderColor: 'var(--sr-line)' }}>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Video className="h-3.5 w-3.5" /> Camera Hardware Controls
            </h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sr-2">Resolution (Default: SVGA 800×600)</Label>
                <Select
                  value={draft.resolution}
                  onValueChange={(v) => patch({ resolution: v as HardwareSettings['resolution'] })}
                >
                  <SelectTrigger className="w-full rounded-lg border-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-sr-2">Compression Quality</Label>
                  <span className="font-mono text-[11px] font-bold text-amber-400">
                    {qualityToPercent(draft.quality)}%
                  </span>
                </div>
                <Slider
                  value={[qualityToPercent(draft.quality)]}
                  min={0}
                  max={100}
                  step={5}
                  onValueChange={([v]) => patch({ quality: percentToQuality(v) })}
                />
                <div className="flex justify-between text-[9px] text-sr-3">
                  <span>Fast / High Compression</span>
                  <span>High Quality / Low Compression</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 p-2.5" style={{ borderColor: 'var(--sr-line)' }}>
                <Switch checked={draft.flip_h} onCheckedChange={(v) => patch({ flip_h: v })} />
                <span className="text-[11px] text-sr-2">Flip Horiz</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 p-2.5" style={{ borderColor: 'var(--sr-line)' }}>
                <Switch checked={draft.flip_v} onCheckedChange={(v) => patch({ flip_v: v })} />
                <span className="text-[11px] text-sr-2">Flip Vert</span>
              </label>
              <div className="space-y-1">
                <span className="block text-[11px] text-sr-2">Brightness ({draft.brightness})</span>
                <Slider value={[draft.brightness]} min={-2} max={2} step={1} onValueChange={([v]) => patch({ brightness: v })} />
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-sr-2">Contrast ({draft.contrast})</span>
                <Slider value={[draft.contrast]} min={-2} max={2} step={1} onValueChange={([v]) => patch({ contrast: v })} />
              </div>
            </div>

            {/* Advanced */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="group flex items-center gap-1 py-1 text-[11px] font-semibold text-amber-400 hover:underline">
                <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                Advanced Sensors (AWB, Special Effects)
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 grid grid-cols-1 gap-3 rounded-xl border-2 p-3 sm:grid-cols-3" style={{ borderColor: 'var(--sr-line)' }}>
                  <div className="space-y-1.5">
                    <Label className="text-sr-2">Special Effects</Label>
                    <Select value={String(draft.special_fx)} onValueChange={(v) => patch({ special_fx: Number(v) })}>
                      <SelectTrigger className="w-full rounded-lg border-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FX.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center justify-between gap-2 rounded-lg sr-well p-2.5">
                    <span className="text-[11px] text-sr-2">Auto White Balance</span>
                    <Switch checked={draft.awb} onCheckedChange={(v) => patch({ awb: v })} />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-lg sr-well p-2.5">
                    <span className="text-[11px] text-sr-2">AWB Gain</span>
                    <Switch checked={draft.awb_gain} onCheckedChange={(v) => patch({ awb_gain: v })} />
                  </label>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </section>

          {/* Voice Master */}
          <section className="space-y-4 border-t pt-5" style={{ borderColor: 'var(--sr-line)' }}>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Volume2 className="h-3.5 w-3.5" /> Voice Master Audio
            </h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-sr-2">Voice Profile</Label>
                <Select value={draft.voice_profile} onValueChange={(v) => patch({ voice_profile: v })}>
                  <SelectTrigger className="w-full rounded-lg border-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VOICES.map((v) => (
                      <SelectItem key={v.value} value={v.value}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-sr-2">Speech Speed ({draft.voice_speed.toFixed(1)}×)</span>
                <Slider
                  value={[draft.voice_speed]}
                  min={0.5}
                  max={2}
                  step={0.1}
                  onValueChange={([v]) => patch({ voice_speed: Math.round(v * 10) / 10 })}
                />
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-sr-2">Speaker Volume ({draft.voice_volume})</span>
                <Slider
                  value={[draft.voice_volume]}
                  min={0}
                  max={21}
                  step={1}
                  onValueChange={([v]) => patch({ voice_volume: v })}
                />
              </div>
            </div>
          </section>

          {/* AI Judge + appearance */}
          <section className="space-y-4 border-t pt-5" style={{ borderColor: 'var(--sr-line)' }}>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
              <Microchip className="h-3.5 w-3.5" /> AI Judge & Interface
            </h4>
            <div className="space-y-1.5 rounded-xl border p-3" style={{ borderColor: 'var(--sr-line)' }}>
              <Label className="text-sr-2">🔗 Player Join-Link Base (optional)</Label>
              <Input
                value={draft.join_url_base ?? ''}
                onChange={(e) => patch({ join_url_base: e.target.value })}
                placeholder="https://pregram.github.io/IOT/"
                className="rounded-lg border-2 font-mono"
              />
              <p className="text-[10px] leading-snug text-sr-3">
                Where the lobby QR/link sends players. Defaults to the built-in
                GitHub Pages URL, then this page's own address. Leave empty
                unless you host your own copy.
              </p>
            </div>
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
              <h5 className="text-xs font-bold text-amber-400">⌨️ Host Keyboard Shortcuts</h5>
              <p className="mt-1 text-[10px] leading-relaxed text-sr-2">
                <kbd className="sr-well rounded px-1.5 py-0.5 font-mono text-[10px] text-fg">Space</kbd>{' '}
                Snap Photo ·{' '}
                <kbd className="sr-well rounded px-1.5 py-0.5 font-mono text-[10px] text-fg">Enter</kbd>{' '}
                Continue to Next Turn ·{' '}
                <kbd className="sr-well rounded px-1.5 py-0.5 font-mono text-[10px] text-fg">R</kbd>{' '}
                Retake Unclear Photo ·{' '}
                <kbd className="sr-well rounded px-1.5 py-0.5 font-mono text-[10px] text-fg">P</kbd>{' '}
                Pause / Resume Countdown ·{' '}
                <kbd className="sr-well rounded px-1.5 py-0.5 font-mono text-[10px] text-fg">1-4</kbd>{' '}
                🎺 Sound Board (Airhorn · Drumroll · Rimshot · Ta-Da)
              </p>
            </div>
            <div className="flex items-center justify-between rounded-xl border-2 p-3" style={{ borderColor: 'var(--sr-line)' }}>
              <div>
                <h5 className="text-xs font-bold text-sr-2">Interface Display Theme</h5>
                <p className="text-[10px] text-sr-3">Toggle dark / light game-show mode</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-xl text-[11px]"
                onClick={() => patch({ theme: draft.theme === 'dark' ? 'light' : 'dark' })}
              >
                {draft.theme === 'dark' ? <Moon className="mr-1.5 h-3.5 w-3.5" /> : <Sun className="mr-1.5 h-3.5 w-3.5" />}
                {draft.theme === 'dark' ? 'Dark' : 'Light'}
              </Button>
            </div>
            {/* 🔊 audio cluster - mute + master volume live together */}
            <h5 className="pt-1 text-[10px] font-extrabold uppercase tracking-widest text-sr-3">
              🔊 Audio
            </h5>
            <label className="flex items-center justify-between rounded-xl border-2 p-3" style={{ borderColor: 'var(--sr-line)' }}>
              <div>
                <h5 className="text-xs font-bold text-sr-2">Mute Sound Effects</h5>
                <p className="text-[10px] text-sr-3">Shutter, verdict stingers & victory fanfare</p>
              </div>
              <Switch checked={draft.muted} onCheckedChange={(v) => patch({ muted: v })} />
            </label>
            {/* 🎚 master SFX volume - scales every effect & sound-board jingle */}
            <div
              className="rounded-xl border-2 border-emerald-500/25 bg-emerald-500/[0.06] p-3 transition hover:border-emerald-500/45"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Volume2 className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />
                  <h5 className="text-xs font-bold text-sr-2">SFX Volume</h5>
                </div>
                <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  {draft.sfx_volume}%
                </span>
              </div>
              <Slider
                value={[draft.sfx_volume]}
                min={0}
                max={100}
                step={5}
                aria-label="Master sound effects volume"
                onValueChange={([v]) => patch({ sfx_volume: v })}
                className="mt-2.5 [&_[data-slot=slider-range]]:bg-emerald-500 [&_[data-slot=slider-thumb]]:border-emerald-500"
              />
              <p className="mt-1.5 text-[10px] text-sr-3">
                TV chimes, ticks & the sound board — mute switch still wins.
              </p>
            </div>
          </section>
        </div>

        <SheetFooter className="border-t p-4" style={{ borderColor: 'var(--sr-line)' }}>
          <div className="flex w-full items-center justify-between gap-3">
            <p className="hidden truncate text-[10px] font-semibold text-sr-3 sm:block">
              Saved settings are pushed to the camera board automatically.
            </p>
            <Button onClick={save} className="rounded-xl bg-amber-500 px-5 text-xs font-bold text-slate-950 hover:bg-amber-400">
              Save & Apply Settings
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
