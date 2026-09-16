/*
  simpleGeminiCall.ino — Test 1: continuous Serial chat with Gemini.
  Type a message -> reply printed. Failed requests are KEPT; 'r' resends.
  Note: a failed Gemini request may still count against quota — 'r' is
  your explicit choice.
  Request body + response are handled entirely by ArduinoJson 7.x.
  If HTTP 404 "model not found": verify the exact id at
  https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
*/
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

static const char* WIFI_SSID     = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
static const char* API_KEY       = "PASTE_YOUR_KEY";
static const char* MODEL         = "gemini-3.5-flash";   // or "gemini-3.6-flash"
static const char* SYS_PROMPT    =
  "You are a helpful voice assistant. Reply short (1-3 sentences), plain text only: "
  "no markdown, no lists, no emoji.";

static String lastPrompt, buf;

static int geminiAsk(const char* apiKey, const char* model, const String& prompt, String& replyOut) {
  replyOut = "";
  if (WiFi.status() != WL_CONNECTED) { replyOut = "[error: Wi-Fi down]"; return -1; }

  // ---- request built entirely by ArduinoJson (no manual JSON assembly) ----
  JsonDocument doc;
  doc["systemInstruction"]["parts"][0]["text"] = SYS_PROMPT;
  doc["contents"][0]["role"]  = "user";
  doc["contents"][0]["parts"][0]["text"] = prompt;
  doc["generationConfig"]["maxOutputTokens"] = 256;
  doc["generationConfig"]["temperature"] = 0.7;
  String body;
  serializeJson(doc, body);

  String url = String("https://generativelanguage.googleapis.com/v1beta/models/") +
               model + ":generateContent?key=" + apiKey;

  WiFiClientSecure client;
  client.setInsecure();                    // encrypted; cert not verified (prototype)
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(25000);
  if (!http.begin(client, url)) { replyOut = "[error: http begin failed]"; return -2; }
  http.addHeader("Content-Type", "application/json");
  uint32_t t0 = millis();
  int code = http.POST(body);
  Serial.printf("[GEMINI] %u ms\n", (unsigned)(millis() - t0));

  if (code == HTTP_CODE_OK) {
    JsonDocument resp;
    DeserializationError err = deserializeJson(resp, http.getString());
    if (err) replyOut = String("[error: JSON ") + err.c_str() + "]";
    else {
      const char* txt = resp["candidates"][0]["content"]["parts"][0]["text"] | "";
      replyOut = String(txt);
      if (!replyOut.length()) replyOut = "[error: no text in reply]";
    }
  } else {
    String detail = code > 0 ? http.getString() : String(http.errorToString(code));
    if (code > 0) {
      JsonDocument resp;
      if (!deserializeJson(resp, detail)) {
        const char* msg = resp["error"]["message"] | "";
        if (msg[0]) detail = msg;          // clean message, e.g. quota / invalid key
      }
    }
    replyOut = "[error HTTP " + String(code) + "] " + detail.substring(0, 180);
  }
  http.end();
  return code;
}

static void doAsk(const String& prompt) {
  Serial.printf("[YOU] %s\n", prompt.c_str());
  String reply;
  int code = geminiAsk(API_KEY, MODEL, prompt, reply);
  Serial.println("[GEMINI] " + reply);
  if (code != 200) {
    if (code == 429) Serial.println("[SYS] 429 = quota exhausted today for this key.");
    Serial.println("[SYS] Message kept. 'r' = resend, or type a new message.");
  } else {
    lastPrompt = prompt;
  }
}

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Gemini Text Test (ArduinoJson) ===");
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] connecting to %s", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250); Serial.print(".");
    if (millis() - t0 > 20000) { Serial.println("\n[WiFi] retrying..."); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); t0 = millis(); }
  }
  Serial.printf("\n[WiFi] connected, IP=%s\n", WiFi.localIP().toString().c_str());
  Serial.println("[SYS] Type a message. 'r' = resend last failed message.");
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      buf.trim();
      if (buf.length()) {
        if (buf == "r") {
          if (lastPrompt.length()) doAsk(lastPrompt);
          else Serial.println("[SYS] nothing to retry.");
        } else doAsk(buf);
      }
      buf = "";
    } else {
      buf += c;
      if (buf.length() > 1000) { Serial.println("[SYS] input too long, dropped."); buf = ""; }
    }
  }
  vTaskDelay(1);
}