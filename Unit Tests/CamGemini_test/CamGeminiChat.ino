/*
  GeminiVisionTest.ino — CameraWebServer UI + single-turn Gemini.  (v2.2)
  ----------------------------------------------------------------------------
  v2.2:
   - DISABLE_THINKING defaults to 0 (thinkingConfig field NOT sent - matches
     the v1 request shape that returned 200; the field is a suspect in the
     current 400 INVALID_ARGUMENT).
   - New serial cmd 'gencfg' toggles the two suspect generationConfig fields
     on/off and prints the resulting body shape; use it + one 'snap' to
     bisect any future 400 in a single round.
   - Error paths print first 300 bytes of Google's raw response body.
   - Diagnostics per call: finishReason + output/thinking token counts.
   - snap appends true capture resolution (WxH) to the prompt.
   - Reply joins ALL parts[] entries.

  Folder must also contain: app_httpd.cpp, camera_index.h, board_config.h,
  camera_pins.h (from the CameraWebServer example).
  Browser: http://<board-ip>/ (tune) and /stream (live view).
  Serial: any text = Gemini call | 'snap <prompt>' | 'gencfg' | 'r' | 'help'
  Requires: ArduinoJson 7.x, PSRAM = OPI PSRAM, esp32 core 3.x.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "mbedtls/base64.h"
#include "board_config.h"

void startCameraServer();
void setupLedFlash();

// ---------------- USER CONFIG ----------------
static const char* WIFI_SSID     = "SSID";
static const char* WIFI_PASSWORD = "PWD";
static const char* API_KEY       = "KEY";
static const char* MODEL         = "gemini-3.6-flash";   // or "gemini-3.6-flash"
static const char* SYS_PROMPT    =
  "You are a helpful assistant. Reply short (1-3 sentences), plain text only: "
  "no markdown, no lists, no emoji.";

static const int GEMINI_MAX_TOKENS = 1024;  // reply-length cap only (NOT quota)
static bool useThinkingCfg   = false;       // toggled by 'gencfg' (start = OFF)
static bool useMaxOutTokens  = true;        // toggled by 'gencfg' (start = ON, 1024)

static String lastPrompt, lastImgB64, buf;

// ---------------- camera (defaults exactly per CamWebServer example) ----------------
static bool camInit() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href  = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn  = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size   = FRAMESIZE_UXGA;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count     = 1;

  if (psramFound()) {
    config.jpeg_quality = 10;
    config.fb_count     = 2;
    config.grab_mode    = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size  = FRAMESIZE_SVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init failed with error 0x%x\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }
  s->set_framesize(s, FRAMESIZE_QVGA);
  return true;
}

static String captureB64(int* outW, int* outH) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { Serial.println("[CAM] capture failed"); return ""; }
  if (outW) *outW = fb->width;
  if (outH) *outH = fb->height;
  size_t need = ((fb->len + 2) / 3) * 4 + 1;
  char* out = (char*)malloc(need);
  if (!out) out = (char*)ps_malloc(need);
  if (!out) { esp_camera_fb_return(fb); Serial.println("[CAM] no mem for base64"); return ""; }
  size_t olen = 0;
  mbedtls_base64_encode((unsigned char*)out, need, &olen, fb->buf, fb->len);
  out[olen] = 0;
  Serial.printf("[CAM] captured %ux%u, %u B -> base64 %u B\n",
                (unsigned)fb->width, (unsigned)fb->height, (unsigned)fb->len, (unsigned)olen);
  String s(out);
  free(out);
  esp_camera_fb_return(fb);
  return s;
}

// ---------------- request body (ArduinoJson only) ----------------
static String buildBody(const String& prompt, const String* imgB64) {
  JsonDocument doc;
  doc["systemInstruction"]["parts"][0]["text"] = SYS_PROMPT;
  JsonArray contents = doc["contents"].to<JsonArray>();
  JsonObject turn = contents.add<JsonObject>();
  turn["role"] = "user";
  turn["parts"][0]["text"] = prompt;
  if (imgB64 && imgB64->length()) {
    turn["parts"][1]["inline_data"]["mime_type"] = "image/jpeg";
    turn["parts"][1]["inline_data"]["data"] = *imgB64;
  }
  if (useMaxOutTokens) doc["generationConfig"]["maxOutputTokens"] = GEMINI_MAX_TOKENS;
  doc["generationConfig"]["temperature"] = 0.7;
  if (useThinkingCfg) doc["generationConfig"]["thinkingConfig"]["thinkingBudget"] = 0;

  String body;
  body.reserve(measureJson(doc) + 8);
  serializeJson(doc, body);
  return body;
}

static void printGenCfg() {
  Serial.printf("[CFG] model=%s | maxOutputTokens=%s (%d) | thinkingConfig=%s | "
                "toggle with 'gencfg'\n",
                MODEL,
                useMaxOutTokens ? "ON" : "OFF", GEMINI_MAX_TOKENS,
                useThinkingCfg ? "ON" : "OFF");
}

// ---------------- Gemini ----------------
static int geminiCall(const String& prompt, const String* imgB64, String& replyOut) {
  replyOut = "";
  if (WiFi.status() != WL_CONNECTED) { replyOut = "[error: Wi-Fi down]"; return -1; }

  String url = String("https://generativelanguage.googleapis.com/v1beta/models/") +
               MODEL + ":generateContent?key=" + API_KEY;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout((imgB64 && imgB64->length()) ? 30000 : 25000);
  if (!http.begin(client, url)) { replyOut = "[error: http begin failed]"; return -2; }
  http.addHeader("Content-Type", "application/json");

  String body = buildBody(prompt, imgB64);
  uint32_t t0 = millis();
  int code = http.POST(body);
  uint32_t dt = millis() - t0;

  if (code == HTTP_CODE_OK) {
    JsonDocument resp;
    DeserializationError err = deserializeJson(resp, http.getString());
    if (err) {
      replyOut = String("[error: JSON ") + err.c_str() + "]";
    } else {
      String txt;
      JsonArray parts = resp["candidates"][0]["content"]["parts"];
      if (!parts.isNull())
        for (JsonObject p : parts) txt += (const char*)(p["text"] | "");
      const char* finish = resp["candidates"][0]["finishReason"] | "?";
      uint32_t outTok  = resp["usageMetadata"]["candidatesTokenCount"] | 0;
      uint32_t thinkTk = resp["usageMetadata"]["thoughtsTokenCount"] | 0;
      Serial.printf("[GEMINI] %u ms | request %u B | finish=%s out=%u think=%u tokens\n",
                    (unsigned)dt, (unsigned)body.length(), finish, outTok, thinkTk);
      if (txt.length()) replyOut = txt;
      else {
        const char* block = resp["promptFeedback"]["blockReason"] | "";
        if (block[0]) replyOut = String("[blocked: ") + block + "]";
        else          replyOut = "[error: no text in reply]";
      }
      if (!strcmp(finish, "MAX_TOKENS"))
        Serial.println("[GEMINI] NOTE: hit token budget - raise GEMINI_MAX_TOKENS.");
    }
  } else {
    String detail = (code > 0) ? http.getString() : String(http.errorToString(code));
    if (code > 0) {
      JsonDocument resp;
      if (!deserializeJson(resp, detail)) {
        const char* msg = resp["error"]["message"] | "";
        if (msg[0]) detail = msg;
      }
    }
    Serial.printf("[GEMINI] %u ms | request %u B\n", (unsigned)dt, (unsigned)body.length());
    Serial.println("[GEMINI] RAW " + String(code) + ": " + detail.substring(0, 300));
    replyOut = "[error HTTP " + String(code) + "] " + detail.substring(0, 120);
  }
  http.end();
  return code;
}

static void doAsk(const String& prompt, const String* img) {
  Serial.printf("[YOU] %s%s\n", prompt.c_str(), (img && img->length()) ? "  [with image]" : "");
  String reply;
  int code = geminiCall(prompt, img, reply);
  Serial.println("[GEMINI] " + reply);
  if (code != 200) {
    if (code == 429) Serial.println("[SYS] 429 = quota exhausted today for this key.");
    Serial.println("[SYS] Last request kept. 'r' = retry, or send a new message.");
  } else if (reply.startsWith("[error") || reply.startsWith("[blocked")) {
    Serial.println("[SYS] Last request kept. 'r' = retry.");
  } else {
    lastPrompt = prompt;
    lastImgB64 = (img && img->length()) ? *img : String();
  }
}

static void doSnap(const String& userPrompt) {
  int w = 0, h = 0;
  String img = captureB64(&w, &h);
  if (!img.length()) { Serial.println("[SYS] snap failed - type 'snap' to retry."); return; }
  String prompt = userPrompt + "\n(The attached image is " + String(w) + "x" + String(h) + " pixels.)";
  doAsk(prompt, &img);
}

static void printHelp() {
  Serial.println("[SYS] any text = Gemini call | 'snap <prompt>' image+prompt | "
                 "'gencfg' toggle generation fields | 'r' retry | 'help'");
}

// ---------------- sketch ----------------
void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== GeminiVisionTest v2.2: camera web UI + single-turn Gemini ===");

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

  if (camInit()) {
    Serial.println("[CAM] ready.");
#if defined(LED_GPIO_NUM)
    setupLedFlash();
#endif
    startCameraServer();
    Serial.printf("[WEB] Camera Ready! Open http://%s/ to view & tune, /stream for live view.\n",
                  WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[CAM] init FAILED - web UI not started. Text calls still work.");
  }

  printGenCfg();
  printHelp();
  Serial.println("[SYS] Ready.");
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      buf.trim();
      if (buf.length()) {
        String line = buf; buf = "";
        String lower = line; lower.toLowerCase();
        if      (lower == "help")   printHelp();
        else if (lower == "gencfg") {
          useThinkingCfg = !useThinkingCfg;
          useMaxOutTokens = !useMaxOutTokens;
          printGenCfg();
        }
        else if (lower == "r") {
          if (lastPrompt.length())
            doAsk(lastPrompt, lastImgB64.length() ? &lastImgB64 : nullptr);
          else Serial.println("[SYS] nothing to retry.");
        }
        else if (lower.startsWith("snap")) {
          String p = (line.length() > 4) ? line.substring(5) : String();
          p.trim();
          if (!p.length()) p = "Describe what you see in one short spoken sentence.";
          doSnap(p);
        }
        else doAsk(line, nullptr);
      }
    } else {
      buf += c;
      if (buf.length() > 1000) { Serial.println("[SYS] input too long, dropped."); buf = ""; }
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