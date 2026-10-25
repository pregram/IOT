// Room speaker (Voice Master). Every function here runs on Core 1, which owns the
// Audio object. The only Core-0-facing entry points are ttsRequestSpeak() (writer)
// and ttsLastDoneId()/ttsLastStartId() (readers), all guarded by ttsMux.
//
// Text up to GET_URL_BUDGET (URL-encoded) streams from tts_relay.py and is decoded
// while it arrives. Longer text is word-trimmed; the judge prompt already keeps
// verdict feedback under 90 chars, so trimming only hits long custom lines.
// There is no Docker POST fallback in this build: it needed LittleFS writes, a second
// 4 KB buffer and a second HTTP stack next to the MP3 decoder, which is exactly where
// the heap dips came from.
// Relay down: the line waits in a RAM queue (max 3) and is retried every 10 s.
// Line ids are echoed back as "started" and "done", so the web arms the turn clock
// on the real end of speech instead of a duration estimate.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include "Audio.h"
#include "parameters.h"

static Audio audio;                       // ESP32-audioI2S 4.0.x API

static String currentVoice  = VOICE_EN;
static float  currentSpeed  = DEFAULT_SPEED;
static int    currentVolume = DEFAULT_VOLUME;

static bool   busy       = false;
static bool   speaking   = false;
static uint32_t lastCur = 0, curChangedMs = 0, speakStartMs = 0;
static bool   audioStarted = false;
// End-of-speech detection. getAudioCurrentTime() only ticks in whole seconds, so the
// old "decoded time froze for 3 s" check added ~3 s of dead air after every line.
// Two earlier signals now end a line first:
//  - isRunning() false: the library stopped (EOF with a Content-Length, or a failed
//    request). The relay's chunked stream does not raise EOF outside the library's
//    own TTS mode, so for relay lines this is only a guard.
//  - input buffer drained: under TTS_DRAIN_BYTES and unchanged for TTS_DRAIN_MS.
//    edge-tts delivers far faster than real time, so an underrun this long mid-line
//    would already be an audible gap.
// The freeze check stays as the last backup.
static uint32_t eofSeenMs = 0;
static uint32_t drainBytes = 0, drainSinceMs = 0;
static const uint32_t TTS_TAIL_MS     = 250;    // I2S DMA tail after the library stopped
static const uint32_t TTS_DRAIN_BYTES = 2048;   // < ~0.3 s of 48 kbps MP3
static const uint32_t TTS_DRAIN_MS    = 600;

// Offline queue (RAM, max 3) for lines the relay could not take.
#define QUEUE_MAX 3
static String   qText[QUEUE_MAX], qVoice[QUEUE_MAX];
static int      qCount = 0;
static uint32_t lastRetryMs = 0;
// A parked line older than this is dropped, never replayed: a boot announcement or
// a round call for a finished turn must not play minutes later.
static const uint32_t Q_MAX_AGE_MS = 45000;
static uint32_t qMs[QUEUE_MAX];

// Cross-core speak FIFO (netTask -> Core 1). A one-slot newest-wins mailbox made
// back-to-back lines chop each other mid-word. Normal lines now wait until the
// speaker is idle; a priority line cuts the current one, clears the queue and
// plays now.
#define MB_MAX 8
static SemaphoreHandle_t ttsMux        = nullptr;
static String            mbText[MB_MAX];
static uint64_t          mbIdArr[MB_MAX];
static bool              mbPrio[MB_MAX];
static int               mbCount       = 0;

// g_doneId / g_startId: ids of the newest finished / started line. Monotonic (max
// wins), so serial or retry lines (id 0) never roll them back.
static uint64_t curLineId = 0;                 // Core 1 only, no lock needed
static uint64_t g_doneId  = 0;                 // guarded by ttsMux
static uint64_t g_startId = 0;                 // guarded by ttsMux; the web anchors its speech-gate fallbacks on it

static void ttsMarkStarted() {
  if (!ttsMux) { if (curLineId > g_startId) g_startId = curLineId; return; }
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    if (curLineId > g_startId) g_startId = curLineId;
    xSemaphoreGive(ttsMux);
  }
}

static void ttsMarkDone() {
  if (!ttsMux) { if (curLineId > g_doneId) g_doneId = curLineId; return; }
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    if (curLineId > g_doneId) g_doneId = curLineId;
    xSemaphoreGive(ttsMux);
  }
}

static void tts_audio_info(Audio::msg_t m) {
  if (m.e == Audio::evt_eof) {
    speaking = false;
    ttsMarkDone();
    Serial.println("[TTS] speech ended.");
  }
  else if (m.e == Audio::evt_info) Serial.printf("[Audio Info] %s\n", m.msg);
}

static String urlEncode(const String& in) {
  static const char* hex = "0123456789ABCDEF";
  String out; out.reserve(in.length() * 3 + 1);
  for (size_t i = 0; i < in.length(); ++i) {
    uint8_t c = (uint8_t)in.charAt(i);
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') out += (char)c;
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 0x0F]; }
  }
  return out;
}

// Word-boundary trim so the URL-encoded text fits the GET budget.
static String trimToBudget(const String& text) {
  if (urlEncode(text).length() <= GET_URL_BUDGET) return text;
  String out;
  int start = 0;
  while (start < (int)text.length()) {
    int sp = text.indexOf(' ', start);
    int end = (sp < 0) ? (int)text.length() : sp;
    String word = text.substring(start, end);
    String cand = out.length() ? out + ' ' + word : word;
    if (urlEncode(cand + " …").length() > GET_URL_BUDGET) break;
    out = cand;
    if (sp < 0) break;
    start = end + 1;
  }
  if (!out.length()) out = text.substring(0, 64);   // pathological single word
  return out + " …";
}

static void stopAudioSafely() {
  speaking = false;
  if (audio.isRunning()) {
    audio.stopSong();
    for (int i = 0; i < 25 && audio.isRunning(); ++i) { audio.loop(); delay(2); }
    delay(10);
  }
}

static void setSpeakerVolume(int v) {
  if (v < 0) v = 0;
  if (v > 21) v = 21;
  currentVolume = v;
  audio.setVolume(v);                    // applies instantly, even mid-speech
  Serial.printf("[SET] volume=%d\n", currentVolume);
}

static void setVoiceName(const String& v) {
  String name = v; name.trim();
  if (!name.length()) return;
  currentVoice = name;
  Serial.printf("[SET] voice=%s\n", currentVoice.c_str());
}

static void setSpeed(float s) {
  if (s < 0.5f) s = 0.5f;
  if (s > 2.0f) s = 2.0f;
  currentSpeed = s;
  Serial.printf("[SET] speed=%.2f (next utterance)\n", currentSpeed);
}

// Web app voice profiles (Gemini-style names) -> edge-tts voices.
static const char* voiceForProfile(const String& profile) {
  if      (profile == "Zephyr") return "en-GB-SoniaNeural";
  else if (profile == "Puck")   return "en-US-GuyNeural";
  else if (profile == "Fenrir") return "en-US-ChristopherNeural";
  else if (profile == "Aoede")  return "en-US-JennyNeural";
  else if (profile == "Charon") return "en-GB-ThomasNeural";
  else if (profile == "Kore")   return VOICE_EN;
  return VOICE_EN;
}

// Hebrew / Arabic glyphs override the profile so the voice matches the language.
static const char* autoVoiceFor(const String& text, const String& profile) {
  bool hasHe = false, hasAr = false;
  for (size_t i = 0; i < text.length(); ++i) {
    uint8_t c = (uint8_t)text.charAt(i);
    if (c == 0xD7 && i + 1 < text.length()) {           // UTF-8 lead byte of U+0590..05FF
      uint8_t n = (uint8_t)text.charAt(i + 1);
      if (n >= 0x90 && n <= 0xBF) { hasHe = true; }
    }
    if (c == 0xD8 || c == 0xD9) { hasAr = true; }       // U+0600..06FF lead bytes
  }
  if (hasHe) return VOICE_HE;
  if (hasAr) return VOICE_AR;
  return voiceForProfile(profile);
}

// voice = profile name (Kore...), speed 0.5..2, volume 0..21
static void applyTtsSettings(const String& voiceProfile, float speed, int volume) {
  currentVoice = autoVoiceFor("", voiceProfile);
  setSpeed(speed);
  setSpeakerVolume(volume);
}

// When full, the oldest line is dropped.
static void enqueuePending(const String& text, const String& voice) {
  if (qCount >= QUEUE_MAX) {
    for (int i = 1; i < QUEUE_MAX; ++i) { qText[i - 1] = qText[i]; qVoice[i - 1] = qVoice[i]; qMs[i - 1] = qMs[i]; }
    qCount--;
    Serial.println("[Q] queue full — oldest line dropped");
  }
  qText[qCount] = text;
  qVoice[qCount] = voice;
  qMs[qCount] = millis();
  qCount++;
  Serial.printf("[Q] line parked (%d/%d, %u chars) — retry every %d s\n",
                qCount, QUEUE_MAX, (unsigned)text.length(), OFFLINE_RETRY_MS / 1000);
}

static bool speak(const String& text, const String& voice = "", float speed = -1.0f,
                  int volume = -1, bool queueOnFail = true) {
  if (text.isEmpty() || busy) return false;
  busy = true;
  speaking = false;
  lastCur = 0; audioStarted = false; eofSeenMs = 0; drainBytes = 0; drainSinceMs = 0;
  curChangedMs = speakStartMs = millis();

  String v = voice.length() ? voice : autoVoiceFor(text, currentVoice);
  float  s = (speed > 0) ? speed : currentSpeed;
  if (volume >= 0) setSpeakerVolume(volume);

  String t = trimToBudget(text);
  if (t.length() != text.length()) {
    Serial.printf("[TTS] trimmed %u → %u chars to fit the GET budget\n",
                  (unsigned)text.length(), (unsigned)t.length());
  }
  String q = urlEncode(t);
  Serial.printf("[TTS] encoded length: %u (GET budget %u)\n",
                (unsigned)q.length(), (unsigned)GET_URL_BUDGET);

  stopAudioSafely();
  // Built with reserve() + appends, not a chained `+`: each `+` on an Arduino String
  // allocates a fresh temporary, so every speak() (and every relay retry, forever,
  // while the relay is down) churned 8+ small internal-heap blocks. On real hardware
  // that wedged maxAlloc at 23.5 KB during setup() and every later TLS handshake
  // failed. (The audio ring buffer is ps_malloc'd, so it was not the cause.)
  String voiceEnc = urlEncode(v);
  String url;
  url.reserve(24 + strlen(RELAY_HOST) + 5 + q.length() + voiceEnc.length() + 16);
  url += "http://"; url += RELAY_HOST; url += ':'; url += RELAY_PORT;
  url += "/tts.mp3?text="; url += q;
  url += "&voice="; url += voiceEnc;
  url += "&speed="; url += String(s, 2);
  Serial.printf("[TTS] relay stream: %s\n", url.c_str());
  if (audio.connecttohost(url.c_str())) {
    busy = false; speaking = true;
    return true;
  }

  Serial.println("[TTS] relay connect failed — queued for retry.");
  if (queueOnFail) {
    if (text.length() <= 1500) enqueuePending(text, v);
    else Serial.println("[Q] text too large to queue - dropped.");
  }
  busy = false;
  return false;
}

// True while a line is playing or connecting; the cloud preview loop stays off the
// radio during speech.
static bool ttsSpeaking() { return busy || speaking; }

// Id of the newest finished cloud line, 0 if none since boot (serial and queued
// lines carry no id). Core 0 publishes it as hardware_session/tts_done.
static uint64_t ttsLastDoneId() {
  if (!ttsMux) return g_doneId;
  uint64_t id = 0;
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    id = g_doneId;
    xSemaphoreGive(ttsMux);
  }
  return id;
}

// Id of the newest line whose audio actually started (first decoded frame).
static uint64_t ttsLastStartId() {
  if (!ttsMux) return g_startId;
  uint64_t id = 0;
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    id = g_startId;
    xSemaphoreGive(ttsMux);
  }
  return id;
}

static void ttsMailboxInit() {
  if (!ttsMux) ttsMux = xSemaphoreCreateMutex();
}

// Safe from any task. id is the host's cmd id (epoch ms), echoed back when the line
// starts and ends. Priority lines go to the front of the FIFO.
static void ttsRequestSpeak(const String& text, uint64_t id = 0, bool priority = false) {
  if (!ttsMux || text.isEmpty()) return;
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    if (mbCount >= MB_MAX) {
      // Full: a priority line evicts the oldest normal entry, a normal line evicts the
      // oldest entry of any kind.
      int victim = 0;
      if (priority) {
        for (int i = 0; i < mbCount; ++i) if (!mbPrio[i]) { victim = i; break; }
      }
      for (int i = victim; i < mbCount - 1; ++i) {
        mbText[i] = mbText[i + 1]; mbIdArr[i] = mbIdArr[i + 1]; mbPrio[i] = mbPrio[i + 1];
      }
      mbCount--;
      Serial.println("[VOICE] speak FIFO full — oldest line dropped");
    }
    if (priority) {
      for (int i = mbCount; i > 0; --i) {
        mbText[i] = mbText[i - 1]; mbIdArr[i] = mbIdArr[i - 1]; mbPrio[i] = mbPrio[i - 1];
      }
      mbText[0] = text; mbIdArr[0] = id; mbPrio[0] = true;
      mbCount++;
    } else {
      mbText[mbCount] = text; mbIdArr[mbCount] = id; mbPrio[mbCount] = false;
      mbCount++;
    }
    xSemaphoreGive(ttsMux);
  }
}

// Core 1 only. Normal lines start only when nothing is playing; priority lines barge.
static void ttsMailboxPump() {
  if (!ttsMux || mbCount == 0) return;
  String text;
  uint64_t id = 0;
  bool prio = false;
  bool have = false;
  if (xSemaphoreTake(ttsMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    if (mbCount > 0 && (!mbPrio[0] ? !ttsSpeaking() : true)) {
      text = mbText[0]; id = mbIdArr[0]; prio = mbPrio[0];
      for (int i = 1; i < mbCount; ++i) {
        mbText[i - 1] = mbText[i]; mbIdArr[i - 1] = mbIdArr[i]; mbPrio[i - 1] = mbPrio[i];
      }
      mbText[mbCount - 1] = "";
      mbIdArr[mbCount - 1] = 0;
      mbPrio[mbCount - 1] = false;
      mbCount--;
      have = true;
    }
    xSemaphoreGive(ttsMux);
  }
  if (!have || !text.length()) return;
  if (prio) {
    Serial.println("[VOICE] priority line — barging ahead of everything");
    qCount = 0;                  // a priority line skips the offline queue too
    stopAudioSafely();
  }
  Serial.printf("[VOICE] speaking cloud line (%u chars)\n", (unsigned)text.length());
  curLineId = id;               // so end-of-speech marks this id
  speak(text);
}

static void ttsHousekeeping() {
  audio.loop();

  if (speaking) {
    uint32_t cur = audio.getAudioCurrentTime();
    if (cur != lastCur) {
      lastCur = cur; curChangedMs = millis();
      if (!audioStarted) ttsMarkStarted();
      audioStarted = true;
    }
    // buffer-drain tracking, only once audio actually played
    const uint32_t filled = audio.inBufferFilled();
    if (!audioStarted || filled >= TTS_DRAIN_BYTES || filled != drainBytes) {
      drainBytes = filled; drainSinceMs = millis();
    }
    if (!audio.isRunning()) {
      if (!eofSeenMs) eofSeenMs = millis();
      else if (millis() - eofSeenMs >= TTS_TAIL_MS) {
        speaking = false;
        if (!audioStarted) ttsMarkStarted();   // a sub-second line never moved the clock
        ttsMarkDone();
        Serial.printf("[TTS] speech ended (library stop, %u ms after start).\n",
                      (unsigned)(millis() - speakStartMs));
      }
    }
    else if (audioStarted && millis() - drainSinceMs >= TTS_DRAIN_MS) {
      speaking = false;
      ttsMarkDone();
      Serial.printf("[TTS] speech ended (buffer drained, %u ms after start).\n",
                    (unsigned)(millis() - speakStartMs));
    }
    else if (audioStarted && millis() - curChangedMs > 3000) {
      speaking = false;
      ttsMarkDone();
      Serial.println("[TTS] speech ended (freeze backup).");
    } else if (!audioStarted && millis() - speakStartMs > 15000) {
      speaking = false;
      ttsMarkDone();                           // a dead line still counts as done, or the web would wait forever
      Serial.println("[TTS] speech ended (no audio started).");
    }
  }

  // drop stale parked lines before retrying them
  while (qCount > 0 && millis() - qMs[0] > Q_MAX_AGE_MS) {
    for (int i = 1; i < qCount; ++i) { qText[i - 1] = qText[i]; qVoice[i - 1] = qVoice[i]; qMs[i - 1] = qMs[i]; }
    qCount--;
    Serial.println("[Q] stale line dropped (too old to speak now)");
  }

  if (!busy && qCount > 0 && millis() - lastRetryMs > OFFLINE_RETRY_MS) {
    lastRetryMs = millis();
    Serial.printf("[Q] retrying (%d queued)...\n", qCount);
    if (speak(qText[0], qVoice[0], -1, -1, false)) {
      for (int i = 1; i < qCount; ++i) { qText[i - 1] = qText[i]; qVoice[i - 1] = qVoice[i]; qMs[i - 1] = qMs[i]; }
      qCount--;
      Serial.printf("[Q] delivered. %d left.\n", qCount);
    }
  }

  ttsMailboxPump();
}

static void ttsEngineInit() {
  Audio::audio_info_callback = tts_audio_info;
  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(currentVolume);
  audio.setConnectionTimeout(4000, 8000);   // unencrypted, encrypted
  ttsMailboxInit();
}
