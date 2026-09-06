/*
  ESP32-S3 Sense + MAX98357A (I2S)
  Library: schreibfaul1/ESP32-audioI2S (v4)
  Free TTS: Google Translate TTS endpoint via audio.connecttospeech(),
  chunked under its ~100 char limit, queued for gapless continuous playback.
*/

#include <WiFi.h>
#include <Audio.h>
#include <deque>
#include <vector>

// ---------- Wi-Fi ----------
const char* ssid     = "*****";
const char* password = "*****";

// ---------- I2S Pins ----------
#define I2S_DOUT 7
#define I2S_BCLK 8
#define I2S_LRC  9

Audio audio;

// ---------- TTS Queue ----------
std::deque<String> ttsQueue;
volatile bool speechDone = true;

// ---------- Mock Gemini Stream Simulation ----------
String mockParagraph =
  "Welcome human! I am Eye Spy Bot. I spy with my little eye something you "
  "wear on your wrist to check the time. Show it to my camera! Nice try, "
  "but that is a spoon! You cannot tell time with a spoon.";

const int mockChunkSize = 150;
int mockPos = 0;
unsigned long lastMockTime = 0;
const unsigned long mockInterval = 2000; // simulate a new Gemini chunk every 2s

// Split any length of text into TTS-safe chunks (<100 chars), breaking on
// word boundaries so words are never cut mid-way.
std::vector<String> splitForTTS(const String &text) {
  std::vector<String> chunks;
  const int maxLen = 90; // safety margin under Google TTS's 100 char cap
  int start = 0;
  int len = text.length();

  while (start < len) {
    while (start < len && text[start] == ' ') start++; // skip leading spaces
    if (start >= len) break;

    int end = start + maxLen;
    if (end >= len) {
      chunks.push_back(text.substring(start));
      break;
    }

    int splitAt = text.lastIndexOf(' ', end);
    if (splitAt <= start) splitAt = end; // no space found, hard cut

    chunks.push_back(text.substring(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

// Feed any length of incoming text (e.g. a Gemini response fragment) into
// the playback queue as safely-sized TTS chunks.
void enqueueGeminiResponse(const String &text) {
  std::vector<String> parts = splitForTTS(text);
  for (auto &p : parts) {
    if (p.length() > 0) ttsQueue.push_back(p);
  }
}

// Simulates Gemini streaming ~150-char chunks into the system over time.
void simulateGeminiStream() {
  if (mockPos >= (int)mockParagraph.length()) return;
  if (millis() - lastMockTime < mockInterval) return;
  lastMockTime = millis();

  int end = min(mockPos + mockChunkSize, (int)mockParagraph.length());
  if (end < (int)mockParagraph.length()) {
    int spacePos = mockParagraph.indexOf(' ', end);
    if (spacePos != -1 && spacePos - end < 20) end = spacePos;
  }

  String piece = mockParagraph.substring(mockPos, end);
  mockPos = end + 1;

  Serial.println("[Gemini sim] chunk received: " + piece);
  enqueueGeminiResponse(piece);
}

// ---------- ESP32-audioI2S v4 callback ----------
// v4 replaced the old weak-linked globals (audio_eof_speech, audio_info, ...)
// with ONE unified callback registered via Audio::audio_info_callback.
// Google-TTS playback ends like any other stream, so it's reported as evt_eof.
void my_audio_info(Audio::msg_t m) {
  switch (m.e) {
    case Audio::evt_eof:
      speechDone = true;
      break;
    default:
      break; // evt_info, evt_bitrate, etc. - ignored here
  }
}

// True once every queued chunk has been spoken and nothing is playing.
// Use this in your real project to know when it's safe to go listen
// for the user's response before calling Gemini again.
bool isDoneSpeaking() {
  return speechDone && ttsQueue.empty();
}

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  Audio::audio_info_callback = my_audio_info; // register v4 event callback

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(14);
}

void loop() {
  audio.loop();

  simulateGeminiStream();

  if (speechDone && !ttsQueue.empty()) {
    String chunk = ttsQueue.front();
    ttsQueue.pop_front();
    speechDone = false;
    audio.connecttospeech(chunk.c_str(), "en");
  }
}
