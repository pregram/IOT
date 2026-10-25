/*
  Long-text TTS test with the free Google Translate TTS endpoint
  (audio.connecttospeech), MAX98357A on I2S, ESP32-audioI2S v4.
  The endpoint caps a request at ~100 chars, so text is split on word boundaries
  and queued for back-to-back playback. Result: works, but lags and cuts off a bit
  between chunks, which is why the game uses the edge-tts relay instead.
*/

#include <WiFi.h>
#include <Audio.h>
#include <deque>
#include <vector>

const char* ssid     = "*****";
const char* password = "*****";

#define I2S_DOUT 7
#define I2S_BCLK 8
#define I2S_LRC  9

Audio audio;

std::deque<String> ttsQueue;
volatile bool speechDone = true;

// Simulated LLM output arriving in chunks
String mockParagraph =
  "Welcome human! I am Eye Spy Bot. I spy with my little eye something you "
  "wear on your wrist to check the time. Show it to my camera! Nice try, "
  "but that is a spoon! You cannot tell time with a spoon.";

const int mockChunkSize = 150;
int mockPos = 0;
unsigned long lastMockTime = 0;
const unsigned long mockInterval = 2000; // a new chunk every 2 s

// Split text into chunks under 100 chars on word boundaries, so words are never cut.
std::vector<String> splitForTTS(const String &text) {
  std::vector<String> chunks;
  const int maxLen = 90; // margin under the endpoint's 100 char cap
  int start = 0;
  int len = text.length();

  while (start < len) {
    while (start < len && text[start] == ' ') start++;
    if (start >= len) break;

    int end = start + maxLen;
    if (end >= len) {
      chunks.push_back(text.substring(start));
      break;
    }

    int splitAt = text.lastIndexOf(' ', end);
    if (splitAt <= start) splitAt = end; // no space found: hard cut

    chunks.push_back(text.substring(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

void enqueueGeminiResponse(const String &text) {
  std::vector<String> parts = splitForTTS(text);
  for (auto &p : parts) {
    if (p.length() > 0) ttsQueue.push_back(p);
  }
}

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

// ESP32-audioI2S v4 replaced the weak-linked globals (audio_eof_speech, audio_info,
// ...) with one callback registered via Audio::audio_info_callback. Google TTS
// playback ends like any stream, so it arrives as evt_eof.
void my_audio_info(Audio::msg_t m) {
  switch (m.e) {
    case Audio::evt_eof:
      speechDone = true;
      break;
    default:
      break; // other events ignored
  }
}

// True once every queued chunk has been spoken and nothing is playing.
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

  Audio::audio_info_callback = my_audio_info;

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
