# Parameters

SnapRiddle has three kinds of settings:

- **Game setup**, chosen by the host in the web app when creating a room. No rebuild needed.
- **Host settings**, in the web app's Settings drawer (gear icon). Saved in the host browser's localStorage and pushed to the board (directly over the LAN, or through the `hardware_session/esp_settings` node in Firebase). No reflash needed.
- **Hard-coded firmware parameters**, in [`ESP32/SnapRiddle_HW/parameters.h`](../ESP32/SnapRiddle_HW/parameters.h). Changing one means re-flashing the board. Every parameter there has a comment explaining it. Credentials live separately in `SECRETS.h` (see the [README](../README.md#secrets)).

## The 15 that matter most

| # | Parameter | Where | Default | What it does |
| --- | --- | --- | --- | --- |
| 1 | `FB_DB_URL` | parameters.h | the project's RTDB URL | Firebase Realtime Database the board polls and writes. Must match `databaseURL` in `web_app/src/lib/firebase.ts`. |
| 2 | `RELAY_HOST`, `RELAY_PORT` | parameters.h | `192.168.1.230`, `5051` | LAN address of the PC running `tts_relay.py`. Never `localhost`. |
| 3 | `GEMINI_API_KEYS`, `N_KEYS` | SECRETS.h, parameters.h | 3 keys | Gemini keys for the judge and riddle generation. Up to 5; set `N_KEYS` to how many you filled in. |
| 4 | `GEMINI_MODELS`, `N_MODELS` | parameters.h | 4 Gemini flash models | Model pool. The rotation changes model on every failed attempt and only moves to the next key after all models were tried. |
| 5 | `GROQ_API_KEY`, `OPENROUTER_API_KEY` + model names | SECRETS.h, parameters.h | empty keys | Fallback providers tried after a key's Gemini models fail. An empty key skips that provider. |
| 6 | `GEMINI_TIMEOUT_MS` | parameters.h | 12000 | Limit for one LLM attempt. Replies take 2.7 to 18.5 s, so 12 s cuts a hung connection fast without killing a live reply. |
| 7 | `GEMINI_COOLDOWN_MODEL_MS`, `GEMINI_COOLDOWN_KEY_MS` | parameters.h | 30000, 60000 | How long a model (503, timeout, 404) or a key (429, 403, 400) sits out after a failure. |
| 8 | `RIDDLE_TIME_MIN_SEC`, `RIDDLE_TIME_MAX_SEC` | parameters.h | 60, 180 | Range the LLM-chosen turn time is clamped to. |
| 9 | `BTN_LONG_MS`, `BTN_DOUBLE_GAP_MS`, `HINT_MIN_GAP_MS` | parameters.h | 1200, 350, 8000 | Button gestures: hold time for a long press (hint), window for a double press (Countdown Capture), and the lockout between two hints. |
| 10 | `POLL_FAST_MS`, `POLL_IDLE_MS`, `ESP_BEAT_MS` | parameters.h | 600, 1500, 10000 | Firebase poll rate during a live turn and when idle, and the heartbeat period. |
| 11 | Total game rounds | Game setup (landing page) | 3 | 3, 5 or 10 rounds. Round floor(N/2)+1 is the Bonus round and the last round is Double or Doom. |
| 12 | Free hints per player, Countdown Capture length | Game setup (lobby) | 2 hints, 3 s | 0 to 3 free hints (after that a solve with a hint pays half), 1 to 10 s countdown. |
| 13 | Environment and Playstyle | Game setup (landing page) | Full Experience | The environment anchors riddle answers (Classroom, Office, Kitchen, Living Room, Dorm, Full House). The playstyle sets the mix of proof methods: Full Experience, Physical Hunt Mode or Tabletop Brainiac. |
| 14 | Camera: resolution, compression quality, flip, brightness, contrast, effects, white balance | Settings drawer | SVGA, quality 12 | Camera sensor settings, applied live on the board. |
| 15 | Voice profile, speed, volume, ESP32 Room Speaker, Force Fallback Models | Settings drawer | Kore, 1.0, 18, on, off | Voice of the room speaker (speed 0.5 to 2.0, volume 0 to 21). Room Speaker off makes the host browser speak instead. Force Fallback Models skips every Gemini model and uses Groq/OpenRouter only. |

## Other places values are fixed in code

These are not meant to be tuned, but they are hard-coded and worth knowing:

| Value | File | Default |
| --- | --- | --- |
| Base points per difficulty | `web_app/src/utils/gameLogic.ts` (`BASE_POINTS`) | Easy 100, Medium 200, Hard 300 |
| Score formula | `gameLogic.ts` (`computeScore`) | base × (1 + 0.5 × fraction of time left), ×2 in Double or Doom |
| Double or Doom penalty | `gameLogic.ts` (`doomPenalty`) | −2 × base |
| Player tiers | `gameLogic.ts` (`TIER_RULES`) | Casual Easy to Medium, Standard Easy to Hard, Expert Medium to Hard |
| Max players per room | `web_app/src/components/snapriddle/SnapRiddleApp.tsx` (`MAX_PLAYERS`) | 8 |
| Demo judging rates | `SnapRiddleApp.tsx` (`DEMO_PASS_RATE`) | about 50 % pass, 15 % unclear, 35 % fail |
| Voice presets | `parameters.h` (`VOICE_EN`, `VOICE_HE`, `VOICE_AR`) | en-GB-RyanNeural, he-IL-HilaNeural, ar-EG-SalmaNeural |
| Memory floors for LLM attempts | `parameters.h` section 9 | see the comments there |

The firmware version string is `FW_VERSION` in parameters.h.
