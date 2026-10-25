// SnapRiddle firmware parameters. Every hard-coded setting the board uses lives
// here; changing one means re-flashing. Credentials are in SECRETS.h.
// Board: XIAO ESP32-S3 Sense, esp32 core 3.3.x, ArduinoJson 7.4.x, ESP32-audioI2S 4.0.x.
#pragma once

// ---- 0. Secrets ----
// Included when present. The fallback block only exists so a fresh clone compiles.
#if __has_include("SECRETS.h")
  #include "SECRETS.h"
#else
  #warning "SECRETS.h not found - compiling with placeholder WiFi/keys (fill in SECRETS.h)"
  static const char* WIFI_SSID     = "YOUR_WIFI_SSID";
  static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
  static const char* GEMINI_API_KEYS[5] = { "KEY1", "KEY2", "KEY3", "", "" };
  static const char* GROQ_API_KEY           = "";
  static const char* OPENROUTER_API_KEY     = "";
#endif

// ---- 1. Firebase Realtime Database ----
// Must be the same database the web app uses (web_app/src/lib/firebase.ts).
// Keep the https:// prefix and no trailing slash. Rules must allow read/write on
// hardware_session/* and rooms/*.
static const char* FB_DB_URL = "https://camgame-d52b0-default-rtdb.firebaseio.com";

// ---- 2. TTS relay (room speaker voice) ----
// Runs on the host PC: uvicorn tts_relay:app --host 0.0.0.0 --port 5051
// Use the PC's LAN IP, never localhost, and give the PC a DHCP reservation so the
// IP does not change between parties.
static const char*    RELAY_HOST   = "192.168.1.230";   // PC running tts_relay.py
static const uint16_t RELAY_PORT   = 5051;              // streaming GET, lowest latency

// Unused by this build: the Docker openai-edge-tts POST fallback was removed (see
// tts_engine.h). Kept for reference; changing them has no effect.
static const char*    TTS_HOST_IP  = "192.168.1.230";
static const uint16_t TTS_PORT     = 5050;              // POST /v1/audio/speech
static const char*    TTS_API_KEY  = "not-needed";

// Longer URL-encoded text is word-trimmed to fit.
static const size_t GET_URL_BUDGET = 1500;   // ESP32-audioI2S caps a URL at 2048 chars including overhead

// Edge-TTS voices; the voice must match the text language.
static const char* VOICE_EN = "en-GB-RyanNeural";
static const char* VOICE_HE = "he-IL-HilaNeural";
static const char* VOICE_AR = "ar-EG-SalmaNeural";
static const float  DEFAULT_SPEED  = 1.0f;   // 0.5 .. 2.0, applies to the next utterance
static const int    DEFAULT_VOLUME = 17;     // 0 .. 21, applies instantly

// ---- 3. Gemini judge + riddle/hint generation (shared key/model pool) ----
// Keys live in SECRETS.h. N_KEYS = how many of them are filled in.
// HTTP 404 "model not found" usually means a stale id; list valid ids with
// https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
static const int   N_KEYS             = 3;
// Up to 6 models. Rotation is model-first: each failed attempt moves to the next
// model and only after every model has had a try does it move to the next key.
// Models dodge per-model 503 "high demand"; keys spread the daily quota.
static const char* GEMINI_MODELS[6]   = {
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-3-flash-preview",
  "gemma-4-31b-it",           // Gemma: see the N_MODELS note
  "gemma-4-26b-a4b-it",
};
// Number of entries above that are actually used. Gemma on the Gemini API tends
// to reject systemInstruction and JSON mode, which every call here uses, so an
// enabled Gemma usually burns one fast 400 before the wheel moves on. Only raise
// this to 5/6 after testing Gemma with your keys.
static const int   N_MODELS           = 4;
// Array capacities; keep in sync with the arrays above.
static const int   GEMINI_KEY_SLOTS     = 5;
static const int   GEMINI_MODEL_SLOTS   = 6;
// Riddle/hint output cap. Thinking models spend output tokens on hidden reasoning
// first, so a tight cap cuts the JSON mid-string and wastes a retry round.
static const int    GEMINI_TEXT_MAX_TOKENS = 8192;
// Judge output cap. Verdicts are 60-80 tokens (finish=STOP in every field log), so
// this never limits quality. It bounds the worst-case reply the board has to buffer
// next to the TLS stack; a 4096-token reply is ~16 KB the heap does not have.
// If a model does hit it (finish=MAX_TOKENS), the judge retries with x4, up to 8192.
static const int    GEMINI_JUDGE_MAX_TOKENS = 2048;
// Per-attempt limit for the whole call (TLS + send + wait + read).
// A 503 is refused in 1-2 s and is cheap no matter what this is. A hang (connection
// accepted, no bytes ever sent) only ends when this timer fires. Successful replies
// measured 2.7-18.5 s (judge median ~3.3 s, generation ~6.5 s), so 12 s catches hangs
// fast while almost never killing a live reply.
static const int    GEMINI_TIMEOUT_MS = 12000;
// Cooldowns after a failure, so the wheel stops retrying a sick model or a spent key.
static const uint32_t GEMINI_COOLDOWN_MODEL_MS = 30000;  // 503 / timeout / 404: the model sits out
static const uint32_t GEMINI_COOLDOWN_KEY_MS   = 60000;  // 429 / 403 / 400: the key sits out
// A 400 (dead key, malformed request) benches the key and a 404 (stale model id)
// benches the model; otherwise they would burn an attempt slot on every pass.
static const int    JUDGE_MAX_ATTEMPTS    = 6;          // attempts per judge request
static const int    TEXTGEN_MAX_ATTEMPTS   = 6;         // attempts per riddle/hint request
static const int    GEMINI_RETRY_JITTER_MS = 600;        // +/- jitter so boards sharing keys never retry in lockstep

// ---- 3b. Fallback providers (Groq, OpenRouter) ----
// One pass per key = that key's Gemini models, then the fallbacks, then the next
// key. Keys live in SECRETS.h; an empty key skips that provider.
// Groq text models use hidden reasoning; the vision model and all OpenRouter models
// run without reasoning params.
static const char* GROQ_TEXT_MODELS[2]    = { "openai/gpt-oss-120b", "openai/gpt-oss-20b" };
static const int   N_GROQ_TEXT_MODELS     = 2;
static const char* OPENROUTER_TEXT_MODEL  = "nvidia/nemotron-3-ultra-550b-a55b:free";
static const char* GROQ_VISION_MODEL      = "qwen/qwen3.8-27b";
static const char* OPENROUTER_VISION_MODEL = "nvidia/nemotron-3.5-super-vl:free";
// 429/403 (quota, billing) bench the whole provider; 503/timeout/400/404 bench
// only that model slot.
static const uint32_t PROVIDER_COOLDOWN_KEY_MS   = 60000;
static const uint32_t PROVIDER_COOLDOWN_MODEL_MS = 30000;
// Wall-clock budget for a fallback reply. OpenRouter free models send headers at
// once and then hold the body open with keep-alive filler, so the per-read timeout
// never trips (a 3.5-minute riddle in one field log). Past this the attempt counts
// as a hang and the wheel moves on.
static const uint32_t LLM_TOTAL_DEADLINE_MS = 25000;
// Explicit output caps for the fallbacks. Without one, Groq reserves the model's
// maximum against the per-minute output quota (instant 429), and gpt-oss can spend
// the whole default budget on hidden reasoning and return nothing.
static const int LLM_JUDGE_MAX_TOKENS = 300;    // verdicts are 130-170 chars
static const int LLM_TEXT_MAX_TOKENS  = 8192;   // riddle plus room for hidden reasoning
// "Force Fallback Models" in the web Settings drawer (esp_settings.force_fallback)
// makes the wheel skip every Gemini model while it is on.

// ---- 4. Button ----
// Leg 1 on GPIO 6, leg 2 on GPIO 5 (driven LOW as the ground return).
#define BTN_PIN  6
#define BTN_GND  5

// Button timing (ms)
#define BTN_DEBOUNCE_MS   30
#define BTN_LONG_MS       1200    // held this long = long press (hint)
#define BTN_DOUBLE_GAP_MS 350     // two presses within this gap = Countdown Capture;
                                // a lone press is reported after the gap

// ---- 5. Audio amplifier (MAX98357A over I2S) ----
#define I2S_DOUT 7
#define I2S_BCLK 8
#define I2S_LRC  9

// ---- 6. Status LED ----
// Not used: the XIAO's on-board LED is invisible in party lighting, so the serial
// console and the web app are the status surfaces. setupLedFlash() in camera_srv.h
// is a no-op kept for older sketches.

// ---- 7. Firmware timing ----
#define FW_VERSION        "1.10.10"
#define POLL_FAST_MS      600     // poll rate during a live turn (button latency)
#define POLL_IDLE_MS      1500    // poll rate in lobbies and menus
#define ESP_BEAT_MS       10000   // hardware_session/esp heartbeat period
#define SNTP_WAIT_MS      12000   // max wait for network time at boot; button
                                  // events need real epoch timestamps
#define OFFLINE_RETRY_MS  10000   // retry period for queued TTS lines
#define BOOT_LINE_MAX_WAIT_MS 15000   // the boot line waits at most this long for the first poll

// ---- 8. Riddle and hint generation ----
// No fallback riddle exists: generation retries forever rather than show a wrong
// riddle. A few quick retries first, then a slow cadence.
#define RIDDLE_FAST_RETRIES   5       // quick retries right after a request
#define RIDDLE_FAST_GAP_MS    2000    // gap between quick retries
#define RIDDLE_SLOW_RETRY_MS  10000   // then retry forever at this cadence
#define RIDDLE_TIME_MIN_SEC   60      // LLM-chosen riddle time is clamped to 60..180 s
#define RIDDLE_TIME_MAX_SEC   180
#define HINT_MAX_WORDS        25      // cap for the standalone spoken hint
#define RIDDLE_HINT_MAX_WORDS 12      // cap for the hint bundled with each riddle

// ---- 9. Memory guards for LLM attempts ----
// At very low heap an attempt fails as "connection refused" in ~20 ms, and the
// rotation would then cool a healthy model for 30 s. Below this floor the attempt
// is skipped instead (no attempt, no cooldown) and retried next cycle.
#define GEMINI_MIN_FREE_HEAP  26000
#define JUDGE_MIN_FREE_HEAP   26000   // same guard for the vision judge
// TLS needs contiguous blocks, so free heap alone is not enough: one field log
// showed attempts with 104 KB free still refused because the heap was fragmented.
// HEAP = free-heap floor, BLOCK = largest-free-block floor, for any LLM attempt.
// 40 KB leaves room for the Firebase TLS session (~40 KB) staying open while a
// second handshake runs. This is a reasoned estimate, not a measurement; tune it
// from serial logs ([TLS] lines print free + maxAlloc on every failure).
#define GEMINI_ATTEMPT_MIN_HEAP  40000
#define GEMINI_ATTEMPT_MIN_BLOCK 40000
// Floors used when tls_psram.h has moved mbedTLS buffers to PSRAM (the normal
// case). The two above are the no-PSRAM fallback.
#define GEMINI_ATTEMPT_MIN_HEAP_PSRAM  20000
#define GEMINI_ATTEMPT_MIN_BLOCK_PSRAM 8000
#define RIDDLE_MIN_HEAP_PSRAM          24000
// Waiting forever below the floors stalled a whole match once, so after this long
// the attempt goes out anyway: a refused attempt costs one instant failure, an
// endless wait costs the game.
#define GEMINI_FLOOR_ESCALATE_MS 10000
// Minimum real gap between stepped judge attempts. Pacing at the 600 ms poll rate
// burned the whole 6-slot chain in ~3.5 s, faster than transient causes clear
// (the TTS decoder only frees its buffer at the end of speech). Jittered via gemGapMs.
#define JUDGE_ATTEMPT_GAP_MS  1500
// Extra pause after a local -1/-2 failure (usually internal RAM for TLS; tls_psram.h
// names the failing resource). See gemNoteLocalRefusal() in gemini_rotation.h.
#define GEMINI_LOCAL_REFUSAL_COOLDOWN_MS 5000

// ---- 10. Hint lockout ----
// One long press = one hint. A held or bouncing button used to queue a second
// hint seconds later, so further long presses are ignored for this long.
// Single and double presses still work during the lockout.
#define HINT_MIN_GAP_MS       8000
