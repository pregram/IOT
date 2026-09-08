#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include "Audio.h"

// ------------------------- USER CONFIG -------------------------
static const char* WIFI_SSID     = "S";
static const char* WIFI_PASSWORD = "P";
static const char* TTS_HOST_IP   = "H";   // PC's LAN IP running Docker
static const uint16_t TTS_PORT   = 5050;
static const char* TTS_API_KEY   = "not-needed";      // REQUIRE_API_KEY=False
static const char* DEFAULT_VOICE = "en-GB-RyanNeural";
static const float  TTS_SPEED    = 1.0f;

// Set to 1 ONLY after the GET curl test succeeds (see instructions).
// Gives near-instant playback start; POST+LittleFS is the fallback path.
#define TTS_USE_GET_STREAM 0

#define I2S_DOUT 7
#define I2S_BCLK 8
#define I2S_LRC  9

// ------------------------- GLOBALS -----------------------------
static Audio audio;
static String serialBuffer;
static bool   busy       = false;
static int    activeSlot = -1;                                  // last downloaded slot

// Two alternating files: never rewrite a file the decoder may hold open.
static const char* TTS_FILE[2] = { "/tts_a.mp3", "/tts_b.mp3" };

// ------------------- Library debug callbacks -------------------
void audio_info(const char* info)    { Serial.printf("[audio] %s\n", info); }
void audio_eof_mp3(const char* info) { Serial.printf("[audio] playback finished: %s\n", info); }

// --------------------------- Helpers ---------------------------
static String urlEncode(const String& in) {
  static const char* hex = "0123456789ABCDEF";
  String out; out.reserve(in.length() * 3 + 1);
  for (size_t i = 0; i < in.length(); ++i) {
    uint8_t c = (uint8_t)in.charAt(i);
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') {
      out += (char)c;
    } else {
      out += '%'; out += hex[c >> 4]; out += hex[c & 0x0F];
    }
  }
  return out;
}

static String buildRequestBody(const String& text, const String& voice) {
  String escaped; escaped.reserve(text.length() + 16);
  for (size_t i = 0; i < text.length(); ++i) {
    char c = text.charAt(i);
    switch (c) {
      case '"':  escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\n': escaped += "\\n";  break;
      case '\r': escaped += "\\r";  break;
      case '\t': escaped += "\\t";  break;
      default:   escaped += c;      break;
    }
  }
  String body = "{";
  body += "\"model\":\"tts-1\",";
  body += "\"input\":\"" + escaped + "\",";
  body += "\"voice\":\"" + voice + "\",";
  body += "\"response_format\":\"mp3\",";
  body += "\"speed\":" + String(TTS_SPEED, 2);
  body += "}";
  return body;
}

// Stop playback and make sure the library has fully released its
// internal file handle / decoder state before we touch the FS.
static void stopAudioSafely() {
  if (audio.isRunning()) {
    audio.stopSong();
    for (int i = 0; i < 25 && audio.isRunning(); ++i) {   // drain
      audio.loop();
      delay(2);
    }
    delay(10);
  }
}

// POST text -> stream MP3 into LittleFS. Hardened download loop.
static bool downloadSpeech(const String& text, const String& voice, const char* outPath) {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[TTS] Wi-Fi down."); return false; }

  String url  = "http://" + String(TTS_HOST_IP) + ":" + String(TTS_PORT) + "/v1/audio/speech";
  String body = buildRequestBody(text, voice);

  WiFiClient client;
  HTTPClient http;
  http.setReuse(false);          // clean close, no half-open socket reuse
  http.setTimeout(20000);        // Edge TTS session setup + synthesis can be slow

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

  int contentLength = http.getSize();          // -1 if chunked
  WiFiClient* stream = http.getStreamPtr();

  if (LittleFS.exists(outPath)) LittleFS.remove(outPath);
  File f = LittleFS.open(outPath, FILE_WRITE);
  if (!f) { Serial.println("[TTS] LittleFS open failed."); http.end(); return false; }

  static uint8_t buff[4096];                   // big chunks = fast FS writes
  size_t   total = 0;
  uint32_t tFirst = 0, lastData = millis();
  bool     stalled = false;

  while (contentLength > 0 || (contentLength == -1 && http.connected())) {
    size_t avail = stream->available();
    if (avail == 0) {
      if (!http.connected()) break;
      if (millis() - lastData > 10000) { stalled = true; break; }
      delay(1);
      continue;
    }
    if (tFirst == 0) tFirst = millis();
    int n = stream->readBytes(buff, min(avail, sizeof(buff)));
    if (n <= 0) {
      if (millis() - lastData > 10000) { stalled = true; break; }
      continue;
    }
    if (f.write(buff, n) != (size_t)n) { Serial.println("[TTS] FS write failed."); break; }
    total += n;
    if (contentLength > 0) contentLength -= n;
    lastData = millis();
  }

  f.close();
  http.end();

  uint32_t t1 = millis();
  Serial.printf("[TTS] %u B | server TTFB %u ms | total %u ms | ~%u KB/s -> %s\n",
                (unsigned)total,
                tFirst ? (unsigned)(tFirst - t0) : 0,
                (unsigned)(t1 - t0),
                (t1 - t0) ? (unsigned)(((uint32_t)total / 1024) * 1000 / (t1 - t0)) : 0,
                outPath);
  if (stalled) Serial.println("[TTS] WARNING: stream stalled, file may be truncated.");
  return total > 0;
}

// --------------------------- Speak -----------------------------
static void speak(const String& text) {
  if (text.isEmpty() || busy) return;
  busy = true;

#if TTS_USE_GET_STREAM
  if (text.length() <= 700) {                  // GET URLs shouldn't get huge
    stopAudioSafely();
    String url = "http://" + String(TTS_HOST_IP) + ":" + String(TTS_PORT) +
                 "/v1/audio/speech?text=" + urlEncode(text) +
                 "&voice=" + DEFAULT_VOICE +
                 "&response_format=mp3&speed=" + String(TTS_SPEED, 2);
    // If the lib can't detect the codec (no file extension in URL), append
    // "&ext=.mp3" — unknown query params are ignored by the server.
    Serial.printf("[TTS] GET-stream: %s\n", url.c_str());
    if (audio.connecttohost(url.c_str())) { activeSlot = -1; busy = false; return; }
    Serial.println("[TTS] GET stream failed, falling back to POST+LittleFS.");
  }
#endif

  stopAudioSafely();
  int slot = (activeSlot == 0) ? 1 : 0;        // ALWAYS write the other file
  if (downloadSpeech(text, DEFAULT_VOICE, TTS_FILE[slot])) {
    activeSlot = slot;
    if (!audio.connecttoFS(LittleFS, TTS_FILE[slot])) {
      Serial.println("[TTS] connecttoFS() failed to start playback.");
    }
  } else {
    Serial.println("[TTS] Download failed, nothing to play.");
  }
  busy = false;
}

// --------------------------- Setup -----------------------------
void setup() {
  Serial.setRxBufferSize(2048);                // before begin(): survive pasted text
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== ESP32-S3 Local TTS Player v2 ===");

  if (!LittleFS.begin(true)) {
    Serial.println("[FS] LittleFS mount failed - check partition scheme!");
  } else {
    Serial.printf("[FS] mounted. used=%u / total=%u bytes\n",
                  (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                        // lower latency, steadier streams
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
  Serial.printf("[SYS] free heap=%u, PSRAM=%u\n",
                (unsigned)ESP.getFreeHeap(),
                psramFound() ? (unsigned)ESP.getPsramSize() : 0);

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(15);                         // 0..21
  audio.setConnectionTimeout(4000, 8000);      // used by connecttohost() path

  speak("Hello. Local text to speech is online and ready for input.");
  Serial.println("[SYS] Ready. Type text + Enter in Serial Monitor.");
}

// --------------------------- Loop ------------------------------
void loop() {
  audio.loop();                                // non-blocking decode pump

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuffer.trim();
      if (serialBuffer.length()) speak(serialBuffer);
      serialBuffer = "";
    } else {
      serialBuffer += c;
      if (serialBuffer.length() > 1000) { Serial.println("[SYS] input too long, dropped."); serialBuffer = ""; }
    }
  }

  static uint32_t lastHeap = 0;                // leak detection
  if (millis() - lastHeap > 30000) {
    lastHeap = millis();
    Serial.printf("[SYS] free heap=%u, min ever=%u\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
  }

  vTaskDelay(1);
}
