# Local Edge-TTS Speaker Server - Setup & Limits

Architecture:
  ESP32-S3 ──GET /tts.mp3?text=..──► tts_relay.py (PC, :5051) ──► Microsoft Edge TTS (free)
        └─(texts > URL budget)──► Docker openai-edge-tts (:5050, buffered, slower)

## Prerequisites
- Windows 10/11 (or Linux), Python 3.9+ (tested on 3.13), Docker Desktop (only for the fallback)
- Arduino: esp32 core 3.x, library "ESP32-audioI2S" (master), PSRAM = OPI PSRAM enabled

## 1. Relay (streaming, low latency) - REQUIRED
via powershell or wsl(change `\` ──► `/` ) run the following commands:
```ps
python -m venv venv
.\venv\Scripts\activate
python -m pip install -r requirements.txt
uvicorn tts_relay:app --host 0.0.0.0 --port 5051
```
requirements.txt:
    fastapi>=0.110
    uvicorn[standard]>=0.29
    edge-tts>=7.0.0
Keep the window open - the window IS the server.
Verify: browser → http://<PC_IP>:5051/tts.mp3?text=hello  (should download an MP3)

## 2. Docker fallback (buffered; needed only for very long texts) - OPTIONAL
    docker run -d -p 5050:5050 -e REQUIRE_API_KEY=False --name openai-edge-tts travisvn/openai-edge-tts:latest

## 3. ESP32
- Same Wi-Fi as the PC. In the sketch set RELAY_HOST / TTS_HOST_IP to the PC's
  LAN IP (`ipconfig` → IPv4 of the Wi-Fi adapter). Use the LAN IP, never localhost.
- Give the PC a DHCP reservation in the router so the IP never changes.

## Limits (measured on this build)
- Streaming GET: text travels in the URL; audio library hard cap = 2048 chars.
  Budget in sketch: 1500 encoded chars ≈ ~1200 English / ~400 Hebrew-Arabic chars.
- POST fallback: any length; audio buffered to flash first, so first-word latency
  scales with length (measured: 270 ch ≈ 3 s, 540 ≈ 6 s, 2000 ≈ 20 s).
  Flash budget ≈ 1.25 MB free ≈ ~3.5 minutes of audio.
- Volume 0..21 - applies instantly, even mid-speech.
- Speed 0.5..2.0 - applies to the NEXT utterance (baked in at synthesis).
- Voices: `edge-tts --list-voices` (catalog: github.com/rany2/edge-tts). Sketch presets:
  en-GB-RyanNeural, he-IL-HilaNeural, ar-EG-SalmaNeural. Voice must match text language.
- Behavior: newest text interrupts current speech (newest-wins); if both servers are
  down, up to 3 texts queue in RAM and auto-play when a server returns.
- End-of-speech detection: event fires ≤ ~3 s after the last word (decode-time freeze).
- Known risk: Edge-TTS is an unofficial API (no SLA). If it ever breaks:
  python -m pip install -U edge-tts, restart relay.