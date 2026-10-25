// Camera init and the board's local HTTP endpoints:
//   :80  GET /capture, GET /status, POST /settings, POST /speak
//   :81  GET /stream (MJPEG)
// The CameraWebServer example's on-board config website is left out on purpose:
// the SnapRiddle web app is the UI.
// POST /settings takes the same JSON as the hardware_session/esp_settings mirror:
//   {"resolution":"SVGA","quality":12,"flip_h":false,"flip_v":false,
//    "brightness":0,"contrast":0,"awb":1,"awb_gain":1,"special_effect":0,
//    "voice":"Kore","speed":1.0,"volume":18}
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <esp_http_server.h>
#include <esp_camera.h>
#include <img_converters.h>
#include <ArduinoJson.h>
#include "parameters.h"
#include "pins_board.h"
#include "shared_state.h"
#include "tts_engine.h"

static bool g_streaming = false;

static framesize_t framesizeFor(const String& r) {
  if      (r == "QVGA") return FRAMESIZE_QVGA;
  else if (r == "VGA")  return FRAMESIZE_VGA;
  else if (r == "XGA")  return FRAMESIZE_XGA;
  else if (r == "UXGA") return FRAMESIZE_UXGA;
  return FRAMESIZE_SVGA;
}

// defaults match the web app: SVGA, quality 12, frames in PSRAM
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
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.frame_size   = FRAMESIZE_SVGA;
  config.jpeg_quality = 12;
  config.fb_count     = 2;

  if (!psramFound()) {
    config.frame_size   = FRAMESIZE_QVGA;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    config.fb_count     = 1;
    config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
    Serial.println("[CAM] WARNING: no PSRAM — falling back to QVGA/DRAM");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init failed with error 0x%x\n", err);
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  if (s && s->id.PID == OV3660_PID) {   // the 3 MP sensor looks washed out with driver defaults
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }
  return true;
}

// Sensor writes are i2c register writes, safe to call from Core 0.
static void applyCameraRegsFromJson(JsonDocument& doc) {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return;
  const char* res = doc["resolution"] | "";
  if (res[0]) s->set_framesize(s, framesizeFor(String(res)));
  if (!doc["quality"].isNull())          s->set_quality(s, (int)doc["quality"] | 12);
  if (!doc["flip_h"].isNull())           s->set_hmirror(s, doc["flip_h"].as<bool>() ? 1 : 0);
  if (!doc["flip_v"].isNull())           s->set_vflip(s, doc["flip_v"].as<bool>() ? 1 : 0);
  if (!doc["brightness"].isNull())       s->set_brightness(s, (int)doc["brightness"] | 0);
  if (!doc["contrast"].isNull())         s->set_contrast(s, (int)doc["contrast"] | 0);
  if (!doc["awb"].isNull())              s->set_whitebal(s, (int)doc["awb"] | 1);
  if (!doc["awb_gain"].isNull())         s->set_awb_gain(s, (int)doc["awb_gain"] | 1);
  if (!doc["special_effect"].isNull())   s->set_special_effect(s, (int)doc["special_effect"] | 0);
}

// Called from the httpd task: camera registers apply here, the voice settings are
// handed to Core 1, which owns the Audio object.
static bool applySettingsJson(const String& body) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) { Serial.printf("[SET] settings JSON error: %s\n", err.c_str()); return false; }
  applyCameraRegsFromJson(doc);
  const char* vp = doc["voice"] | "";
  if (vp[0]) {
    setVoicePendProfile(vp);
    g_voicePendSpeed   = (float)(doc["speed"] | 1.0);
    g_voicePendVol     = (int)(doc["volume"] | -1);
    g_voicePend        = true;
  } else if (!doc["volume"].isNull()) {
    setVoicePendProfile("");
    g_voicePendSpeed   = -1.0f;
    g_voicePendVol     = (int)doc["volume"];
    g_voicePend        = true;
  }
  return true;
}

static esp_err_t capture_handler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] capture failed");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res;
  if (fb->format == PIXFORMAT_JPEG) {
    res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  } else {
    size_t outLen = 0; uint8_t* outBuf = nullptr;
    bool ok = frame2jpg(fb, 80, &outBuf, &outLen);
    res = ok ? httpd_resp_send(req, (const char*)outBuf, outLen) : httpd_resp_send_500(req);
    if (outBuf) free(outBuf);
  }
  esp_camera_fb_return(fb);
  return res;
}

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t* req) {
  camera_fb_t* fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t* _jpg_buf = NULL;
  char part_buf[128];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "20");

  g_streaming = true;
  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAM] stream capture failed");
      res = ESP_FAIL;
    } else {
      if (fb->format != PIXFORMAT_JPEG) {
        bool ok = frame2jpg(fb, 80, &_jpg_buf, &_jpg_buf_len);
        esp_camera_fb_return(fb);
        fb = NULL;
        if (!ok) { Serial.println("[CAM] JPEG compression failed"); res = ESP_FAIL; }
      } else {
        _jpg_buf_len = fb->len;
        _jpg_buf = fb->buf;
      }
    }
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    if (res == ESP_OK) {
      size_t hlen = snprintf((char*)part_buf, sizeof(part_buf), _STREAM_PART, _jpg_buf_len);
      res = httpd_resp_send_chunk(req, (const char*)part_buf, hlen);
    }
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)_jpg_buf, _jpg_buf_len);
    if (fb) { esp_camera_fb_return(fb); fb = NULL; _jpg_buf = NULL; }
    else if (_jpg_buf) { free(_jpg_buf); _jpg_buf = NULL; }
    if (res != ESP_OK) { Serial.println("[CAM] stream client left"); break; }
    vTaskDelay(pdMS_TO_TICKS(50));   // ~20 fps ceiling leaves WiFi and audio enough CPU
  }
  g_streaming = false;
  return res;
}

// Probed by the web Settings drawer's "Test Connection" button.
static esp_err_t status_handler(httpd_req_t* req) {
  char json[256];
  sensor_t* s = esp_camera_sensor_get();
  snprintf(json, sizeof(json),
           "{\"fw\":\"" FW_VERSION "\",\"ip\":\"%s\",\"rssi\":%d,\"heap\":%u,"
           "\"state\":\"%s\",\"linked\":%s,\"framesize\":%u,\"ok\":true}",
           WiFi.localIP().toString().c_str(), WiFi.RSSI(),
           (unsigned)ESP.getFreeHeap(), getEspState().c_str(),
           g_linkUp ? "true" : "false",
           s ? (unsigned)s->status.framesize : 0);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, strlen(json));
}

static esp_err_t settings_handler(httpd_req_t* req) {
  int total = req->content_len;
  if (total <= 0 || total > 2048) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad Request"); return ESP_FAIL; }
  String body; body.reserve(total + 1);
  char buf[256];
  int remaining = total;
  while (remaining > 0) {
    int n = httpd_req_recv(req, buf, (remaining < (int)sizeof(buf)) ? remaining : (int)sizeof(buf));
    if (n <= 0) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad Request"); return ESP_FAIL; }
    body.concat(buf, (size_t)n);
    remaining -= n;
  }
  bool ok = applySettingsJson(body);
  g_settingsViaHttp = true;
  Serial.printf("[SET] /settings applied=%s (%u bytes)\n", ok ? "yes" : "no", (unsigned)body.length());
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, ok ? "{\"ok\":true}" : "{\"ok\":false}", ok ? 11 : 12);
}

// Fast LAN path for Voice Master lines. Body: {"id": <epoch-ms>, "say": "<text>",
// "p": 0|1}, the same shape as a hardware_session/cmdq child. The web tries this
// first and writes cmd/cmdq only if it fails; claimCmdId() guards the rare case
// where both paths deliver (see shared_state.h). Runs on the httpd task;
// ttsRequestSpeak() is safe from any task.
static esp_err_t speak_handler(httpd_req_t* req) {
  int total = req->content_len;
  if (total <= 0 || total > 2048) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad Request"); return ESP_FAIL; }
  String body; body.reserve(total + 1);
  char buf[256];
  int remaining = total;
  while (remaining > 0) {
    int n = httpd_req_recv(req, buf, (remaining < (int)sizeof(buf)) ? remaining : (int)sizeof(buf));
    if (n <= 0) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad Request"); return ESP_FAIL; }
    body.concat(buf, (size_t)n);
    remaining -= n;
  }
  JsonDocument v;
  bool ok = false;
  if (!deserializeJson(v, body)) {
    uint64_t id64 = (uint64_t)(v["id"] | (double)0);
    const char* say = v["say"] | "";
    bool prio = ((int)(v["p"] | 0) == 1);
    if (id64 != 0 && say[0] && claimCmdId(id64)) {
      ttsRequestSpeak(String(say), id64, prio);
      Serial.printf("[SPEAK] direct line (id %llu%s, %u chars)\n",
                    (unsigned long long)id64, prio ? " · priority" : "", (unsigned)strlen(say));
      ok = true;
    } else if (id64 != 0 && say[0]) {
      Serial.printf("[SPEAK] direct line (id %llu) already claimed — skipped\n", (unsigned long long)id64);
      ok = true;   // already handled, not an error
    }
  }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, ok ? "{\"ok\":true}" : "{\"ok\":false}", ok ? 11 : 12);
}

static httpd_handle_t camera_httpd = NULL;
static httpd_handle_t stream_httpd = NULL;

static void startCameraServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 8;
  // The defaults (7 clients per server, no LRU purge) let the two servers hold 14 of
  // lwIP's 16 sockets while browsers park idle keep-alives. LRU purge recycles the
  // oldest idle client instead of refusing a new one.
  config.lru_purge_enable = true;
  config.max_open_sockets = 4;          // control server :80

  httpd_uri_t capture_uri  = { .uri = "/capture",  .method = HTTP_GET,  .handler = capture_handler,  .user_ctx = NULL };
  httpd_uri_t status_uri   = { .uri = "/status",   .method = HTTP_GET,  .handler = status_handler,   .user_ctx = NULL };
  httpd_uri_t settings_uri = { .uri = "/settings", .method = HTTP_POST, .handler = settings_handler, .user_ctx = NULL };
  httpd_uri_t speak_uri    = { .uri = "/speak",    .method = HTTP_POST, .handler = speak_handler,    .user_ctx = NULL };
  httpd_uri_t stream_uri   = { .uri = "/stream",   .method = HTTP_GET,  .handler = stream_handler,   .user_ctx = NULL };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
    httpd_register_uri_handler(camera_httpd, &settings_uri);
    httpd_register_uri_handler(camera_httpd, &speak_uri);
    Serial.printf("[WEB] control server on :%u (/capture /status /settings /speak)\n", config.server_port);
  } else {
    Serial.println("[WEB] failed to start control server");
  }

  config.server_port += 1;
  config.ctrl_port += 1;
  config.max_open_sockets = 3;          // stream :81, one socket per live viewer
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    Serial.printf("[WEB] MJPEG stream on :%u/stream\n", config.server_port);
  } else {
    Serial.println("[WEB] failed to start stream server");
  }
}

static void setupLedFlash() {
  // No-op: the on-board LED is not used. Kept so older sketches still compile.
}
