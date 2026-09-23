// ═══════════════════════════════════════════════════════════════════════
//  StreamProbe_test.ino — standalone camera-stream measurement sketch
//  SnapRiddle architectural review deliverable (2026-09-23)
// ─────────────────────────────────────────────────────────────────────
//  PURPOSE
//    Isolates and MEASURES the camera-stream solution under review, on a
//    bare sketch, so the HLD numbers are reproducible without the game:
//      · identical camera pipeline to production camera_srv.h
//        (XIAO ESP32-S3 Sense · SVGA q12 · PSRAM double buffer)
//      · identical MJPEG server  GET http://<ip>:81/stream
//        (multipart/x-mixed-replace, 50 ms pacing → 20 fps ceiling)
//      · snapshot endpoint       GET http://<ip>/capture
//        with per-phase timing headers (X-T-Fbget-Ms, X-T-Send-Ms)
//      · live probe endpoint     GET http://<ip>/status
//        JSON {fw, fps, avgFrameBytes, frames, heap, minHeap, framesize}
//      · 5-second serial heartbeat: measured FPS, mean frame bytes,
//        free heap, min-ever heap  → the numbers cited in the HLD §5.4
//
//  EXPECTED RESULT (matches the claims in the HLD document)
//    · ≥ 15 FPS to a LAN browser at SVGA q12
//    · SVGA JPEG frames ≈ 25–45 KB (scene-dependent)
//    · free heap stable ±2 KB across minutes of streaming (no leak)
//    · the same server pattern the game uses — no TLS anywhere on the
//      stream path (TLS termination analysis lives in the HLD, §4)
//
//  BOARD SETTINGS (identical to FLASHING_GUIDE.md §3)
//    XIAO_ESP32S3 · PSRAM: OPI PSRAM · Flash 8MB · partition 8M with spiffs
// ═══════════════════════════════════════════════════════════════════════
#include <Arduino.h>
#include <WiFi.h>
#include <esp_http_server.h>
#include <esp_camera.h>
#include <esp_timer.h>

// ── 1 · Wi-Fi credentials — EDIT BEFORE FLASHING ──────────────────────
static const char* WIFI_SSID     = "*";
static const char* WIFI_PASSWORD = "*";

#define PROBE_FW_VERSION "probe-1.0"

// ── 2 · XIAO ESP32-S3 Sense camera pin map (verified, pins_board.h) ───
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

// ── 3 · shared probe statistics (written by httpd tasks, read by loop) ─
static volatile uint32_t g_frames     = 0;   // MJPEG frames actually sent
static volatile uint64_t g_bytesTotal = 0;   // MJPEG payload bytes sent
static volatile uint32_t g_minHeap    = UINT32_MAX;
static volatile bool    g_streaming   = false;

static inline void bumpHeapWatermark() {
  uint32_t h = ESP.getFreeHeap();
  if (h < g_minHeap) g_minHeap = h;
}

// ── 4 · camera init — same config as production camera_srv.h camInit ──
static bool camInit() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href  = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn  = PWDN_GPIO_NUM;  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.frame_size   = FRAMESIZE_SVGA;      // web-app default
  config.jpeg_quality = 12;
  config.fb_count     = 2;

  if (!psramFound()) {
    config.frame_size  = FRAMESIZE_QVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count    = 1;
    config.grab_mode   = CAMERA_GRAB_WHEN_EMPTY;
    Serial.println("[PROBE] WARNING: no PSRAM — falling back to QVGA/DRAM");
  }
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[PROBE] camera init failed 0x%x (ribbon seated? PSRAM set?)\n", err);
    return false;
  }
  return true;
}

// ── 5 · GET /capture — single JPEG with per-phase timing headers ──────
static esp_err_t capture_handler(httpd_req_t* req) {
  int64_t t0 = esp_timer_get_time();
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  int64_t t1 = esp_timer_get_time();

  char hdr[32];
  snprintf(hdr, sizeof(hdr), "%lld", (long long)((t1 - t0) / 1000));
  httpd_resp_set_hdr(req, "X-T-Fbget-Ms", hdr);
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  snprintf(hdr, sizeof(hdr), "%lld", (long long)((esp_timer_get_time() - t0) / 1000));
  httpd_resp_set_hdr(req, "X-T-Send-Ms", hdr);   // informational only (set post-send)
  Serial.printf("[PROBE] /capture %u B, fb_get %lld ms\n",
                (unsigned)fb->len, (long long)((t1 - t0) / 1000));
  return res;
}

// ── 6 · GET /status — machine-readable probe (the HTML probe polls it) ─
static esp_err_t status_handler(httpd_req_t* req) {
  static uint32_t s_lastFrames = 0;
  static uint64_t s_lastMs = 0;
  static uint32_t s_fps = 0;
  static uint64_t s_lastBytes = 0;
  static uint32_t s_avgBytes = 0;
  uint32_t now = millis();
  if (s_lastMs == 0) s_lastMs = now;
  if (now - s_lastMs >= 2000) {                       // 2 s statistics window
    s_fps = (g_frames - s_lastFrames) * 1000 / (now - s_lastMs);
    s_avgBytes = (g_frames > 0) ? (uint32_t)((g_bytesTotal - s_lastBytes) / (g_frames - s_lastFrames ? (g_frames - s_lastFrames) : 1)) : 0;
    s_lastFrames = g_frames; s_lastBytes = g_bytesTotal; s_lastMs = now;
  }
  sensor_t* s = esp_camera_sensor_get();
  char json[256];
  snprintf(json, sizeof(json),
           "{\"fw\":\"" PROBE_FW_VERSION "\",\"ip\":\"%s\",\"fps\":%u,"
           "\"avgFrameBytes\":%u,\"frames\":%u,\"heap\":%u,\"minHeap\":%u,"
           "\"framesize\":%u,\"streaming\":%s,\"ok\":true}",
           WiFi.localIP().toString().c_str(), (unsigned)s_fps, (unsigned)s_avgBytes,
           (unsigned)g_frames, (unsigned)ESP.getFreeHeap(), (unsigned)g_minHeap,
           s ? (unsigned)s->status.framesize : 0, g_streaming ? "true" : "false");
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, strlen(json));
}

// ── 7 · GET /stream — MJPEG, byte-identical pattern to camera_srv.h ───
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t* req) {
  camera_fb_t* fb = NULL;
  esp_err_t res = ESP_OK;
  size_t  jpg_len = 0;
  uint8_t buf[64];
  char    part_buf[128];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "20");

  Serial.println("[PROBE] stream client attached");
  g_streaming = true;
  while (true) {
    int64_t t0 = esp_timer_get_time();
    fb = esp_camera_fb_get();
    if (!fb) { Serial.println("[PROBE] stream capture failed"); res = ESP_FAIL; }
    else {
      jpg_len = fb->len;
      size_t hlen = snprintf((char*)part_buf, sizeof(part_buf), _STREAM_PART, jpg_len);
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)part_buf, hlen);
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, jpg_len);
      int64_t dt = esp_timer_get_time() - t0;
      g_frames++;
      g_bytesTotal += jpg_len;
      if ((g_frames % 100) == 0)                       // per-frame log sample
        Serial.printf("[PROBE] frame %u: %u B, pipeline %lld ms\n",
                      (unsigned)g_frames, (unsigned)jpg_len, (long long)(dt / 1000));
      esp_camera_fb_return(fb);
      fb = NULL;
    }
    if (res != ESP_OK) { Serial.println("[PROBE] stream client left"); break; }
    vTaskDelay(pdMS_TO_TICKS(50));   // ~20 fps ceiling — identical to production
  }
  g_streaming = false;
  return res;
}

// ── 8 · server boot (same two-httpd layout as production) ─────────────
static httpd_handle_t ctrl_httpd  = NULL;
static httpd_handle_t stream_httpd = NULL;

static void startServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 8;
  httpd_uri_t cap_uri    = { .uri = "/capture", .method = HTTP_GET, .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t stat_uri   = { .uri = "/status",  .method = HTTP_GET, .handler = status_handler,  .user_ctx = NULL };
  httpd_uri_t stream_uri = { .uri = "/stream",  .method = HTTP_GET, .handler = stream_handler,  .user_ctx = NULL };

  if (httpd_start(&ctrl_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(ctrl_httpd, &cap_uri);
    httpd_register_uri_handler(ctrl_httpd, &stat_uri);
    Serial.printf("[PROBE] control server on :%u (/capture /status)\n", config.server_port);
  }
  config.server_port += 1;
  config.ctrl_port += 1;
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    Serial.printf("[PROBE] MJPEG stream on :%u/stream\n", config.server_port);
  }
}

// ── 9 · setup / loop — loop prints the 5 s heartbeat the HLD cites ────
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n══════════════════════════════════════════");
  Serial.println("  StreamProbe_test — SnapRiddle review      ");
  Serial.printf("  %s\n", PROBE_FW_VERSION);
  Serial.println("══════════════════════════════════════════");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                       // same as production wifiConnect
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] connecting to %s", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250); Serial.print(".");
    if (millis() - t0 > 20000) { Serial.println("\n[WiFi] retrying..."); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); t0 = millis(); }
  }
  Serial.printf("\n[WiFi] connected, IP=%s RSSI=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  if (!camInit()) { Serial.println("[PROBE] halting — camera init failed"); while (true) delay(1000); }
  startServers();
  Serial.println("[PROBE] ready — open http://<board-ip>:81/stream and watch the heartbeat");
}

void loop() {
  static uint32_t s_lastFrames = 0;
  static uint64_t s_lastBytes  = 0;
  static uint32_t s_lastMs     = 0;
  bumpHeapWatermark();
  uint32_t now = millis();
  if (s_lastMs == 0) { s_lastMs = now; return; }
  if (now - s_lastMs >= 5000) {
    uint32_t fps = (g_frames - s_lastFrames) * 1000 / (now - s_lastMs);
    uint32_t avg = (g_frames > s_lastFrames) ? (uint32_t)((g_bytesTotal - s_lastBytes) / (g_frames - s_lastFrames)) : 0;
    Serial.printf("[PROBE] HEARTBEAT fps=%u  avgFrame=%u B  frames=%u  heap=%u  minHeap=%u  streaming=%d\n",
                  (unsigned)fps, (unsigned)avg, (unsigned)g_frames,
                  (unsigned)ESP.getFreeHeap(), (unsigned)g_minHeap, (int)g_streaming);
    s_lastFrames = g_frames; s_lastBytes = g_bytesTotal; s_lastMs = now;
  }
  delay(50);
}
