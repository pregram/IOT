# Installation

SnapRiddle has four parts to set up: a Firebase database, the ESP32 firmware, the TTS relay on the host PC, and the web app. The board, the PC and the phones need internet access; the board and the PC must be on the same 2.4 GHz WiFi.

## 1. Firebase Realtime Database

1. Create a project at <https://console.firebase.google.com> and add a Realtime Database.
2. Start it in test mode, or give read/write access to at least `rooms/*` and `hardware_session/*`.
3. Register a web app in the project and copy its config object into `web_app/src/lib/firebase.ts` (the `firebaseConfig` block). The Firebase web `apiKey` identifies the project and is not a secret.
4. Copy the database URL (shown at the top of the Realtime Database page) into `FB_DB_URL` in `ESP32/SnapRiddle_HW/parameters.h`. Keep the `https://` prefix and leave off the trailing slash.

## 2. AI keys

- Gemini: create up to 5 API keys at <https://aistudio.google.com>. More keys spread the free-tier daily quota.
- Optional fallbacks: a Groq key (<https://console.groq.com>) and an OpenRouter key (<https://openrouter.ai>). The board tries them after a key's Gemini models fail. Leave a key empty to skip that provider.

## 3. TTS relay (host PC)

The board streams its voice from this small server. From the `tts_relay/` folder (PowerShell shown; on Linux use `source venv/bin/activate`):

```powershell
python -m venv venv
.\venv\Scripts\activate
python -m pip install -r requirements.txt
uvicorn tts_relay:app --host 0.0.0.0 --port 5051
```

Keep that window open while playing. Check it from another device on the WiFi: `http://<PC_IP>:5051/tts.mp3?text=hello` should download an MP3.

Find the PC's LAN IP with `ipconfig` (IPv4 address of the WiFi adapter) and give the PC a DHCP reservation in the router so the address does not change. Allow port 5051 through the PC firewall.

## 4. Firmware (ESP32)

### Arduino IDE setup (once)

1. Install Arduino IDE 2.x.
2. File > Preferences > Additional boards manager URLs:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. Tools > Board > Boards Manager: install **esp32 by Espressif Systems 3.3.11**.
4. Tools > Manage Libraries: install **ArduinoJson 7.4.3** (Benoit Blanchon).
5. Install **ESP32-audioI2S 4.0.0** from <https://github.com/schreibfaul1/ESP32-audioI2S> (Code > Download ZIP, then Sketch > Include Library > Add .ZIP Library).

Everything else (`esp_camera`, `esp_http_server`, `mbedtls`, WiFi, HTTPClient, LittleFS) ships with the esp32 core.

### Board settings

Tools > Board > esp32 > **XIAO_ESP32S3**, then:

| Setting | Value | Why |
| --- | --- | --- |
| PSRAM | OPI PSRAM | Camera frames and TLS buffers live in PSRAM. This is the most often missed setting. |
| Flash Size | 8MB (64Mb) | The XIAO ESP32-S3 has 8 MB |
| Partition Scheme | Default with spiffs (3MB APP/1.5MB SPIFFS) | Fits the 2.2 MB sketch |
| USB CDC On Boot | Enabled | Serial Monitor over the USB-C port |

### Configure

1. Open `ESP32/SnapRiddle_HW/SnapRiddle_HW.ino`. The other files open as tabs.
2. Fill in `SECRETS.h`: WiFi name and password, Gemini keys, optional Groq / OpenRouter keys. The full file used for the project is linked from `ESP32/link_to_full_SECRETS.txt`. Do not commit a filled-in copy.
3. In `parameters.h` set `FB_DB_URL`, `RELAY_HOST` (the PC's LAN IP) and `N_KEYS` (how many Gemini keys you entered). Every other parameter has a working default; see [PARAMETERS.md](PARAMETERS.md).

### Flash

1. Connect the XIAO over USB-C and pick its port.
2. Sketch > Upload. If the upload does not start, hold the BOOT button while the IDE says "Connecting…".
3. Open the Serial Monitor at 115200 baud. A good boot ends like this:

```
[WiFi] connected, IP=192.168.1.xxx RSSI=-52 dBm
[TIME] synced, epoch=... s
[CAM] ready.
[WEB] control server on :80 (/capture /status /settings /speak)
[WEB] MJPEG stream on :81/stream
[NET] cloud link task pinned to Core 0
[GEM] dedicated Gemini/LLM task pinned to Core 0 (stack in PSRAM)
[SYS] Ready.
```

and the speaker says "SnapRiddle hardware online. Ready to play."

### Flashing the prebuilt binary instead

`ESP32/compiled_program.bin` is the application image built from this folder (esp32 core 3.3.x, OPI PSRAM, default 8 MB partition with spiffs). It contains the placeholder `SECRETS.h`, so it cannot join WiFi as is; build from source to use your own credentials. To flash it on top of an existing install with esptool:

```
esptool.py --chip esp32s3 write_flash 0x10000 compiled_program.bin
```

`ESP32/how_to_export_compiled_program.txt` links to a guide for exporting a new binary from the Arduino IDE (Sketch > Export Compiled Binary).

## 5. Web app

Needs Node.js 20 or later. From `web_app/`:

```
npm ci
npm run dev
```

Open <http://localhost:3000> on the host laptop. Phones join through the link and QR code in the lobby; for phones on the same WiFi, open the site using the laptop's LAN IP, or set the join-link base in the Settings drawer.

Other scripts:

| Command | Result |
| --- | --- |
| `npm run build` then `npm run start` | Standalone production server (the start script uses Bun) |
| `npm run build:static` with `NEXT_PUBLIC_STATIC_EXPORT=1` | Static export into `web_app/out` |
| `npm run lint` | ESLint |

### GitHub Pages

`.github/workflows/deploy-pages.yml` builds the static export and deploys it whenever something under `web_app/` changes on `main`. Turn it on once in the repository: Settings > Pages > Build and deployment > Source: GitHub Actions. The site then lives at <https://pregram.github.io/IOT/>.

The host page works best opened from the laptop over plain HTTP (`npm run dev`). On an HTTPS page the browser blocks direct calls to the board's HTTP endpoints (mixed content), so "Test Connection" and direct voice delivery fall back to the Firebase path. Settings and judging keep working.

## 6. Check the whole chain

1. The Settings drawer (gear icon) shows a green "Firmware online" row.
2. Create a room. The lobby's Start button is enabled once a player joins.
3. Serial command `say hello` speaks through the room speaker.
4. Serial command `snap` prints a captured frame size.
