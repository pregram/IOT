/*
  edgeTTS.ino — ESP32-S3 Local TTS Player (stable working build)
  ---------------------------------------------------------------
  Flow: text <= GET_URL_BUDGET (encoded) -> streaming GET via local relay
        else                             -> Docker POST fallback (buffered)
        both down                        -> queue in RAM, auto-retry 10 s
  End-of-speech: decode-time freeze detection (fires <= ~3 s after last word).
  Serial cmds: '+' '-' vol N voice X lang en|he|ar speed X stop status help
  Requires: ArduinoJson 7.x, ESP32-audioI2S, tts_relay.py :5051 (+ Docker :5050
  only if you want the long-text fallback).
*/
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "Audio.h"

// ------------------------- USER CONFIG -------------------------
static const char* WIFI_SSID     = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
static const char* TTS_HOST_IP   = "192.168.1.230";
static const uint16_t TTS_PORT   = 5050;
static const char* TTS_API_KEY   = "not-needed";
static const char* RELAY_HOST    = "192.168.1.230";
static const uint16_t RELAY_PORT = 5051;

static const char* VOICE_EN = "en-GB-RyanNeural";
static const char* VOICE_HE = "he-IL-HilaNeural";
static const char* VOICE_AR = "ar-EG-SalmaNeural";
static const char* DEFAULT_VOICE   = VOICE_EN;
static const float  DEFAULT_SPEED  = 1.0f;    // 0.5 .. 2.0
static const int    DEFAULT_VOLUME = 17;      // 0 .. 21

#define I2S_DOUT 7
#define I2S_BCLK 8
#define I2S_LRC  9

static const size_t GET_URL_BUDGET = 1500;    // library hard cap 2048 (incl. overhead)

// ------------------------- GLOBALS -----------------------------
static Audio audio;
static String serialBuffer;
static bool   busy       = false;
static int    activeSlot = -1;
static bool   speaking   = false;
static uint32_t lastCur = 0, curChangedMs = 0, speakStartMs = 0;
static bool   audioStarted = false;

static String currentVoice  = DEFAULT_VOICE;
static float  currentSpeed  = DEFAULT_SPEED;
static int    currentVolume = DEFAULT_VOLUME;

static const char* TTS_FILE[2] = { "/tts_a.mp3", "/tts_b.mp3" };

// ---- offline queue ----
#define QUEUE_MAX 3
static String qText[QUEUE_MAX], qVoice[QUEUE_MAX];
static int    qCount = 0;
static uint32_t lastRetryMs = 0;

// ------------------- Library event callback --------------------
void my_audio_info(Audio::msg_t m) {
  if (m.e == Audio::evt_eof)  { speaking = false; Serial.println("[TTS] speech ended (file)."); }
  else if (m.e == Audio::evt_info) Serial.printf("[Audio Info] %s\n", m.msg);
}

// --------------------------- Helpers ---------------------------
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

// ArduinoJson handles all escaping (quotes, newlines, UTF-8 passthrough).
static String buildRequestBody(const String& text, const String& voice, float speed) {
  JsonDocument doc;
  doc["model"] = "tts-1";
  doc["input"] = text;
  doc["voice"] = voice;
  doc["response_format"] = "mp3";
  doc["speed"] = speed;
  String body; body.reserve(text.length() + 128);
  serializeJson(doc, body);
  return body;
}

static void stopAudioSafely() {
  speaking = false;
  if (audio.isRunning()) {
    audio.stopSong();
    for (int i = 0; i < 25 && audio.isRunning(); ++i) { audio.loop(); delay(2); }
    delay(10);
  }
}

// ------------------- Live settings setters ---------------------
static void setSpeakerVolume(int v) {
  if (v < 0) v = 0; if (v > 21) v = 21;
  currentVolume = v;
  audio.setVolume(v);                       // instant, even mid-stream
  Serial.printf("[SET] volume=%d\n", currentVolume);
}
static void setVoice(const String& v) {
  String name = v; name.trim();
  if (!name.length()) { Serial.println("[SET] voice name empty."); return; }
  currentVoice = name;
  Serial.printf("[SET] voice=%s\n", currentVoice.c_str());
}
static void setSpeed(float s) {
  if (s < 0.5f) s = 0.5f; if (s > 2.0f) s = 2.0f;
  currentSpeed = s;
  Serial.printf("[SET] speed=%.2f (applies to next utterance)\n", currentSpeed);
}

// ----------------------- offline queue -------------------------
static void enqueuePending(const String& t, const String& v) {
  if (qCount == QUEUE_MAX) {
    for (int i = 1; i < QUEUE_MAX; ++i) { qText[i-1] = qText[i]; qVoice[i-1] = qVoice[i]; }
    qCount--;
    Serial.println("[Q] queue full - dropped oldest.");
  }
  qText[qCount] = t; qVoice[qCount] = v; qCount++;
  Serial.printf("[Q] text queued (%d pending) - retry every 10 s.\n", qCount);
}

// POST text -> stream MP3 into LittleFS (Docker fallback).
static bool downloadSpeech(const String& text, const String& voice, float speed, const char* outPath) {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[TTS] Wi-Fi down."); return false; }
  String url  = "http://" + String(TTS_HOST_IP) + ":" + String(TTS_PORT) + "/v1/audio/speech";
  String body = buildRequestBody(text, voice, speed);

  WiFiClient client;
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(30000);
  if (!http.begin(client, url)) { Serial.println("[TTS] http.begin() failed."); return false; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + TTS_API_KEY);

  uint32_t t0 = millis();
  int httpCode = http.POST(body);
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[TTS] POST failed: %d (%s)\n", httpCode, http.errorToString(httpCode).c_str());
    if (httpCode > 0) { Serial.println("[TTS] Body:"); Serial.println(http.getString()); }
    http.end();
    return false;
  }

  int contentLength = http.getSize();
  WiFiClient* stream = http.getStreamPtr();
  if (LittleFS.exists(outPath)) LittleFS.remove(outPath);
  File f = LittleFS.open(outPath, FILE_WRITE);
  if (!f) { Serial.println("[TTS] LittleFS open failed."); http.end(); return false; }

  static uint8_t buff[4096];
  size_t total = 0;
  uint32_t tFirst = 0, lastData = millis();
  bool stalled = false;
  while (contentLength > 0 || (contentLength == -1 && http.connected())) {
    size_t avail = stream->available();
    if (avail == 0) {
      if (!http.connected()) break;
      if (millis() - lastData > 10000) { stalled = true; break; }
      delay(1); continue;
    }
    if (!tFirst) tFirst = millis();
    int n = stream->readBytes(buff, (avail < sizeof(buff)) ? avail : sizeof(buff));
    if (n <= 0) { if (millis() - lastData > 10000) { stalled = true; break; } continue; }
    if (f.write(buff, n) != (size_t)n) { Serial.println("[TTS] FS write failed."); break; }
    total += n;
    if (contentLength > 0) contentLength -= n;
    lastData = millis();
  }
  f.close();
  http.end();
  uint32_t t1 = millis();
  Serial.printf("[TTS] %u B | TTFB %u ms | total %u ms -> %s\n",
                (unsigned)total, tFirst ? (unsigned)(tFirst - t0) : 0,
                (unsigned)(t1 - t0), outPath);
  if (stalled) Serial.println("[TTS] WARNING: stream stalled, file may be truncated.");
  return total > 0;
}

// --------------------------- Speak -----------------------------
static bool speak(const String& text, const String& voice = "", float speed = -1.0f,
                  int volume = -1, bool queueOnFail = true) {
  if (text.isEmpty() || busy) return false;
  busy = true;
  speaking = false;
  lastCur = 0; audioStarted = false; curChangedMs = speakStartMs = millis();

  String v = voice.length() ? voice : currentVoice;
  float  s = (speed > 0) ? speed : currentSpeed;
  if (volume >= 0) setSpeakerVolume(volume);

  String q = urlEncode(text);
  Serial.printf("[TTS] encoded length: %u (GET budget %u)\n", (unsigned)q.length(), (unsigned)GET_URL_BUDGET);

  if (q.length() <= GET_URL_BUDGET) {
    stopAudioSafely();
    String url = "http://" + String(RELAY_HOST) + ":" + String(RELAY_PORT) +
                 "/tts.mp3?text=" + q + "&voice=" + urlEncode(v) + "&speed=" + String(s, 2);
    Serial.printf("[TTS] relay stream: %s\n", url.c_str());
    if (audio.connecttohost(url.c_str())) {
      activeSlot = -1; busy = false; speaking = true;
      return true;
    }
    Serial.println("[TTS] relay connect failed -> falling back to POST path.");
  } else {
    Serial.println("[TTS] text too long for GET URL -> POST path.");
  }

  stopAudioSafely();
  int slot = (activeSlot == 0) ? 1 : 0;
  if (downloadSpeech(text, v, s, TTS_FILE[slot])) {
    activeSlot = slot;
    if (audio.connecttoFS(LittleFS, TTS_FILE[slot])) { speaking = true; busy = false; return true; }
    Serial.println("[TTS] connecttoFS() failed.");
  } else {
    Serial.println("[TTS] Download failed, nothing to play.");
    if (queueOnFail) {
      if (text.length() <= 1500) enqueuePending(text, v);
      else Serial.println("[Q] text too large to queue - dropped.");
    }
  }
  busy = false;
  return false;
}

// --------------------- Serial command layer --------------------
static void printHelp() {
  Serial.println("[SYS] cmds: '+'/'-' volume | 'vol' show | 'vol 0..21' set | "
                 "'voice <name>' | 'lang en|he|ar' | 'speed 0.5..2.0' | "
                 "'stop' | 'status' | 'help'. Any other line is spoken.");
}

static void handleSerialLine(const String& raw) {
  String line = raw; line.trim();
  if (!line.length()) return;
  String lower = line; lower.toLowerCase();

  if (lower == "+" || lower == "-") { setSpeakerVolume(currentVolume + (lower == "+" ? 1 : -1)); return; }
  if (lower == "vol")     { Serial.printf("[SET] volume=%d (0..21)\n", currentVolume); return; }
  if (lower.startsWith("vol "))   { setSpeakerVolume(line.substring(4).toInt()); return; }
  if (lower.startsWith("voice ")) { setVoice(line.substring(6)); return; }
  if (lower.startsWith("lang ")) {
    String lang = line.substring(5); lang.trim(); lang.toLowerCase();
    if      (lang == "en") setVoice(VOICE_EN);
    else if (lang == "he") setVoice(VOICE_HE);
    else if (lang == "ar") setVoice(VOICE_AR);
    else Serial.println("[SET] unknown lang (use en/he/ar)");
    return;
  }
  if (lower.startsWith("speed ")) { setSpeed(line.substring(6).toFloat()); return; }
  if (lower == "stop") { stopAudioSafely(); Serial.println("[SYS] playback stopped."); return; }
  if (lower == "status") {
    Serial.printf("[SYS] voice=%s speed=%.2f volume=%d | heap=%u min=%u | speaking=%d queued=%d\n",
                  currentVoice.c_str(), currentSpeed, currentVolume,
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                  (int)speaking, qCount);
    return;
  }
  if (lower == "help") { printHelp(); return; }
  speak(line, currentVoice, currentSpeed);
}

// --------------------------- Setup -----------------------------
void setup() {
  Audio::audio_info_callback = my_audio_info;
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== ESP32-S3 Local TTS Player (edgeTTS) ===");
  printHelp();

  if (!LittleFS.begin(true)) Serial.println("[FS] LittleFS mount failed!");
  else Serial.printf("[FS] mounted. used=%u / total=%u bytes\n",
                     (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] connecting to %s", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250); Serial.print(".");
    if (millis() - t0 > 20000) {
      Serial.println("\n[WiFi] retrying...");
      WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); t0 = millis();
    }
  }
  Serial.printf("\n[WiFi] connected, IP=%s\n", WiFi.localIP().toString().c_str());

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(currentVolume);
  audio.setConnectionTimeout(4000, 8000);

  speak("Hello. Local text to speech is online and ready for input.",
        DEFAULT_VOICE, DEFAULT_SPEED);
  Serial.println("[SYS] Ready. Type text + Enter.");
}

// --------------------------- Loop ------------------------------
void loop() {
  audio.loop();

  // ---- end-of-speech: decoded-time freeze ----
  if (speaking) {
    uint32_t cur = audio.getAudioCurrentTime();
    if (cur != lastCur) { lastCur = cur; curChangedMs = millis(); audioStarted = true; }
    else if (audioStarted && millis() - curChangedMs > 3000) {
      speaking = false; Serial.println("[TTS] speech ended.");
    } else if (!audioStarted && millis() - speakStartMs > 15000) {
      speaking = false; Serial.println("[TTS] speech ended (no audio started).");
    }
  }

  // ---- retry queued text ----
  if (!busy && qCount > 0 && millis() - lastRetryMs > 10000) {
    lastRetryMs = millis();
    Serial.printf("[Q] retrying (%d queued)...\n", qCount);
    if (speak(qText[0], qVoice[0], -1, -1, false)) {
      for (int i = 1; i < qCount; ++i) { qText[i-1] = qText[i]; qVoice[i-1] = qVoice[i]; }
      qCount--;
      Serial.printf("[Q] delivered. %d left.\n", qCount);
    }
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuffer.trim();
      if (serialBuffer.length()) handleSerialLine(serialBuffer);
      serialBuffer = "";
    } else {
      serialBuffer += c;
      if (serialBuffer.length() > 1000) { Serial.println("[SYS] input too long, dropped."); serialBuffer = ""; }
    }
  }

  static uint32_t lastHeap = 0;
  if (millis() - lastHeap > 30000) {
    lastHeap = millis();
    Serial.printf("[SYS] free heap=%u, min ever=%u\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
  }
  vTaskDelay(1);
}