// ═══════════════════════════════════════════════════════════════════════
//  FirebasePreviewTest.ino — standalone HTTPS camera→RTDB stress sketch
//  XIAO ESP32-S3 Sense · SnapRiddle architectural-review deliverable
// ─────────────────────────────────────────────────────────────────────
//  PURPOSE
//    Isolates and MEASURES the exact path the game's cloud preview uses,
//    on a bare sketch with zero game logic, so the memory story behind the
//    ~1 FPS cloud snapshot relay is reproducible in front of an audience:
//
//      OV2640 (QVGA 320x240 JPEG)
//        → mbedtls base64 encode            (~11-27 KB chars)
//        → JSON payload {"img":"<b64>","ts":<epoch-ms>}
//        → outbound HTTPS PUT (WiFiClientSecure = mbedTLS)
//            https://<your-project>/hardware_session_preview.json
//        → per-cycle serial telemetry + heap guard
//
//    The payload is BYTE-IDENTICAL to production uploadPreviewFrame()
//    (SnapRiddle_HW/cloud_link.h, line ~411), so the SnapRiddle host
//    screen's "CLOUD PREVIEW" panel will live-display these frames if this
//    sketch runs against the same Firebase project — a free end-to-end
//    demo. Avoid running it during a real game (it would overwrite the
//    live preview node).
//
//  STRESS DESIGN (the part the lecturer asked to see demonstrated)
//    Every upload opens a FRESH WiFiClientSecure and closes it
//    ("Connection: close") — the same pattern the game's Gemini judge uses
//    (gemini_judge.h geminiVisionCall()). Each cycle therefore pays a full
//    TCP+TLS handshake (~40-45 KB of mbedTLS buffers, semi-contiguous),
//    exactly the allocation that v1.4.1 had to protect with fbDrop().
//    Raising the upload rate does NOT raise the frame cost — it removes
//    the heap's recovery time between handshakes, which is what actually
//    collapses small boards. Watch the heap telemetry.
//
//  EXPECTED RESULTS (matches the numbers cited in the HLD / review)
//    · QVGA q12 JPEG frames  ≈ 8-20 KB  → base64 ≈ 11-27 KB chars
//    · cycle cost is dominated by the TLS handshake (~0.3-1.5 s on typical
//      WiFi) — so even at UPLOAD_INTERVAL_MS=100 ("fast") the achieved
//      rate is ≈ 0.5-1.5 FPS, NOT 10 FPS
//    · free heap oscillates by the size of the TLS context + payload
//      temporaries each cycle; watch "largest internal block" shrink as
//      fragmentation sets in (free ≠ usable — the v1.4.1 lesson)
//    · below 30 KB free the sketch prints the RAM warning and skips
//      cycles instead of crashing (production preview additionally skips
//      below 45 KB — PREVIEW_MIN_HEAP — but this test deliberately rides
//      closer to the edge to show what happens)
//
//  BOARD SETTINGS (identical to FLASHING_GUIDE.md §3)
//    Board: XIAO_ESP32S3 · PSRAM: OPI PSRAM · Flash 8MB
//    Partition: 8M with spiffs · esp32 core 3.x
//
//  FIREBASE PREREQ
//    The database rules must allow writes (test mode, or at least the
//    hardware_session_preview node). The URL format is the one shown at
//    the top of Firebase console → Realtime Database (same value as
//    SnapRiddle_HW/config.h §2 — FB_DB_URL).
// ═══════════════════════════════════════════════════════════════════════
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>     // WiFiClientSecure = mbedTLS on ESP32.
#include <esp_camera.h>           //   A raw client (instead of HTTPClient)
#include <mbedtls/base64.h>       //   gives us per-phase ms (TLS connect /
#include <esp_timer.h>            //   write / response) that HTTPClient
#include <esp_heap_caps.h>        //   lumps together — needed for telemetry.
#include <time.h>
#include <sys/time.h>

#define TEST_FW_VERSION "FirebasePreviewTest-1.0"

// ── 1 · CREDENTIALS & TARGET — EDIT ALL THREE BEFORE FLASHING ─────────
static const char* WIFI_SSID     = "X";
static const char* WIFI_PASSWORD = "*";
//  RTDB root URL, https:// prefix, NO trailing slash, no path.
static const char* FIREBASE_URL  = "https://default-rtdb.firebaseio.com";

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

// ── 3 · tunables ──────────────────────────────────────────────────────
//  Upload pacing, start-of-cycle to start-of-cycle. EDITED AT RUNTIME by
//  the serial commands:  slow=1000 · medium=200 · fast=100 (ms).
static uint32_t UPLOAD_INTERVAL_MS = 1000;          // 1 FPS baseline (default)

static const char*    FB_PUT_PATH       = "/hardware_session_preview.json";
static const uint32_t RAM_WARN_HEAP     = 30000;    // the 30 KB guard
static const uint32_t CONNECT_TIMEOUT_S = 6;        // TLS handshake budget (s) —
                                                    // parity: cloud_link.h fbBegin()
static const uint32_t WRITE_TIMEOUT_MS  = 8000;     // hard deadline for the PUT body
static const uint32_t RESPONSE_TIMEOUT_MS = 8000;   // hard deadline for the status line
static const uint32_t HEARTBEAT_MS      = 5000;     // rolling stats print

// ── 4 · runtime state ─────────────────────────────────────────────────
static String   FB_HOST;                 // parsed out of FIREBASE_URL in setup()
static bool     g_paused       = false;  // "stop" command
static const char* g_paceName  = "slow"; // label for the current pacing
static uint32_t g_lastCycleMs   = 0;      // start of the last upload cycle
static uint32_t g_cycleNum      = 0;
static uint32_t g_okCount       = 0;
static uint32_t g_failCount     = 0;
static uint32_t g_cycleMsSum    = 0;
static uint16_t g_lastW = 0, g_lastH = 0;
static int      g_codeRing[8]  = {0};    // last 8 HTTP codes for the "stats" cmd
static uint8_t  g_codeRingIdx  = 0;
static bool     g_timeNoteShown = false;
// rolling achieved-FPS window (for the heartbeat)
static uint32_t g_windowStartMs = 0;
static uint32_t g_windowCycles  = 0;

static inline uint32_t msSince(int64_t t0us) {
  return (uint32_t)((esp_timer_get_time() - t0us) / 1000LL);
}

// ── 5 · camera init — QVGA 320x240 (the memory-safe spec), otherwise ──
//       byte-parity with production camera_srv.h camInit()
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
  config.frame_size   = FRAMESIZE_QVGA;   // ← TEST SPEC: 320x240, memory-safe
  config.jpeg_quality = 12;               // production quality (larger than q15)
  config.fb_count     = 2;                // double buffer, production parity

  if (!psramFound()) {
    config.frame_size  = FRAMESIZE_QVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count    = 1;
    config.grab_mode   = CAMERA_GRAB_WHEN_EMPTY;
    Serial.println("[CAM] WARNING: no PSRAM — QVGA in DRAM, single buffer");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init failed 0x%x (ribbon seated? OPI PSRAM enabled in Tools?)\n", err);
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  if (s) Serial.printf("[CAM] sensor PID 0x%04X ready · QVGA 320x240 · JPEG q12\n", s->id.PID);
  return true;
}

// ── 6 · capture → base64 (timed) — parity with production captureB64() ─
//       gemini_judge.h: mbedtls_base64_encode into malloc'd buffer with a
//       ps_malloc fallback, then a String copy while the frame is held.
static bool captureB64Timed(String& b64Out, uint32_t& capMs, uint32_t& b64Ms,
                            size_t& jpgBytes, size_t& b64Chars) {
  int64_t t0 = esp_timer_get_time();
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { Serial.println("[CAM] capture failed"); return false; }
  int64_t t1 = esp_timer_get_time();
  capMs = msSince(t0);

  size_t need = ((fb->len + 2) / 3) * 4 + 1;          // base64 upper bound
  char* out = (char*)malloc(need);                    // internal heap first…
  if (!out) out = (char*)ps_malloc(need);             // …PSRAM as the fallback
  if (!out) { esp_camera_fb_return(fb); Serial.println("[CAM] no mem for base64"); return false; }

  size_t olen = 0;
  int ret = mbedtls_base64_encode((unsigned char*)out, need, &olen, fb->buf, fb->len);
  if (ret != 0) {
    esp_camera_fb_return(fb); free(out);
    Serial.printf("[CAM] base64 encode failed -0x%x\n", -ret);
    return false;
  }
  out[olen] = 0;                                      // String() needs a NUL

  jpgBytes = fb->len;
  g_lastW = fb->width;  g_lastH = fb->height;
  b64Out = String(out);                               // one extra copy (production parity)
  free(out);
  esp_camera_fb_return(fb);
  b64Ms = msSince(t1);                                // encode + copy + buffer churn
  b64Chars = olen;
  return true;
}

// ── 7 · epoch timestamp (parity with cloud_link.h epochMs) ────────────
static uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
}
static bool timeSynced() { return time(nullptr) > 1700000000; }   // ~Nov 2023+

//  TLS-frAGMENT-SAFE write helper: loops over partial writes under a hard
//  deadline (a 27 KB body crosses several mbedTLS records; write() may
//  legally hand back fewer bytes than requested at each call).
static bool writeAllBytes(WiFiClientSecure& c, const char* p, size_t n, int64_t deadlineUs) {
  size_t done = 0;
  while (done < n) {
    int w = (int)c.write((const uint8_t*)p + done, n - done);
    if (w > 0) { done += (size_t)w; continue; }
    if (esp_timer_get_time() > deadlineUs || !c.connected()) return false;
    delayMicroseconds(200);
  }
  return true;
}

// ── 8 · one HTTPS PUT over a FRESH WiFiClientSecure, phase-timed ──────
//       Returns the HTTP status code, or:
//         -1  TCP+TLS connect failed   (the v1.4.1 failure signature)
//         -2  short write (socket dropped mid-PUT)
//         -3  timeout waiting for the response status line
static int httpsPutB64(const String& body, uint32_t& connMs, uint32_t& writeMs,
                       uint32_t& respMs, String& noteOut) {
  noteOut = "";
  int64_t t0 = esp_timer_get_time();

  // FRESH context per upload — same memory pattern as the game's Gemini
  // judge (geminiVisionCall()). Scope-end stop() frees the ~40-45 KB of
  // mbedTLS buffers, and re-mallocing them every cycle is the stress.
  WiFiClientSecure client;
  client.setInsecure();                // encrypted, cert not pinned (prototype parity)
  client.setTimeout(CONNECT_TIMEOUT_S);// seconds — handshake budget (cloud_link.h parity)

  if (!client.connect(FB_HOST.c_str(), 443)) {
    connMs  = msSince(t0);
    noteOut = "connect failed (TCP+TLS handshake)";
    return -1;
  }
  int64_t t1 = esp_timer_get_time();
  connMs = msSince(t0);

  // Minimal correct HTTP/1.1 request — same wire format HTTPClient would
  // produce for http.sendRequest("PUT", body), minus the wrapper.
  String req = String("PUT ") + FB_PUT_PATH + " HTTP/1.1\r\n" +
               "Host: " + FB_HOST + "\r\n" +
               "Content-Type: application/json\r\n" +
               "Content-Length: " + String(body.length()) + "\r\n" +
               "Connection: close\r\n\r\n";

  const int64_t wDeadline = esp_timer_get_time() + (int64_t)WRITE_TIMEOUT_MS * 1000;
  bool ok = writeAllBytes(client, req.c_str(), req.length(), wDeadline) &&
            writeAllBytes(client, body.c_str(), body.length(), wDeadline);
  int64_t t2 = esp_timer_get_time();
  writeMs = msSince(t1);
  if (!ok) {
    client.stop();
    noteOut = "short write, socket dropped mid-PUT";
    return -2;
  }

  // Read the status line byte-by-byte under a hard deadline (immune to
  // Stream-timeout semantics differences between esp32 core versions).
  const int64_t rDeadline = esp_timer_get_time() + (int64_t)RESPONSE_TIMEOUT_MS * 1000;
  String status;
  while (esp_timer_get_time() < rDeadline) {
    int b = client.read();
    if (b >= 0) { status += (char)b; if (b == '\n') break; }
    else if (!client.connected()) break;
    else delayMicroseconds(250);
  }

  // Slurp a bounded slice of the body — Firebase error JSON lives here.
  String rest;
  rest.reserve(256);
  while (esp_timer_get_time() < rDeadline && rest.length() < 200) {
    int b = client.read();
    if (b >= 0) rest += (char)b;
    else if (!client.connected()) break;
    else delayMicroseconds(250);
  }
  int64_t t3 = esp_timer_get_time();
  respMs = msSince(t2);
  client.stop();

  int code = -3;                                    // "HTTP/1.1 200 OK" → 200
  int sp = status.indexOf(' ');
  if (sp > 0) code = status.substring(sp + 1).toInt();
  if (code <= 0) {
    noteOut = "timeout waiting for response";
    return -3;
  }
  if (code >= 300) noteOut = rest;                  // show the Firebase error body
  return code;
}

// ── 9 · one full upload cycle: capture → base64 → JSON → PUT ──────────
//  NOTE: the result lives in a GLOBAL, not in function signatures — the
//  Arduino .ino preprocessor hoists auto-generated prototypes above type
//  declarations, so user-defined types in .ino function signatures can
//  break the build. Void functions + a global is bullet-proof.
struct CycleResult {
  bool     captured = false, sent = false;
  uint32_t capMs = 0, b64Ms = 0, connMs = 0, writeMs = 0, respMs = 0, totalMs = 0;
  size_t   jpgBytes = 0, b64Chars = 0, bodyBytes = 0;
  int      httpCode = -1;
  String   note;
  uint32_t heapBefore = 0, heapAfter = 0, largestBefore = 0;
};
static CycleResult g_cycle;                 // reset at the start of every cycle

static void doUploadCycle() {
  CycleResult& r = g_cycle;
  r = CycleResult{};                        // wipe the previous cycle's metrics
  int64_t tCycle = esp_timer_get_time();
  r.heapBefore = ESP.getFreeHeap();

  // 9.1 · capture + base64
  String b64;
  if (!captureB64Timed(b64, r.capMs, r.b64Ms, r.jpgBytes, r.b64Chars)) {
    r.heapAfter = ESP.getFreeHeap();
    r.totalMs = msSince(tCycle);
    return;                                         // r.captured stays false
  }
  r.captured = true;

  // 9.2 · JSON payload — byte-identical to production uploadPreviewFrame()
  //       (cloud_link.h): {"img":"<b64>","ts":<epoch-ms>}
  uint64_t ts = timeSynced() ? epochMs() : (uint64_t)millis();
  if (!timeSynced() && !g_timeNoteShown) {
    Serial.println("[TIME] SNTP not synced yet — ts=millis() fallback (cosmetic only)");
    g_timeNoteShown = true;
  }
  String body = "{\"img\":\"" + b64 + "\",\"ts\":" + String((unsigned long long)ts) + "}";
  r.bodyBytes = body.length();
  // NOTE: b64 stays alive until the function returns — the deliberate
  // double-residency (b64 + body) is part of the memory stress being shown.

  // 9.3 · the handshake-critical number, measured right before TLS:
  //       largest CONTIGUOUS internal block (free heap can be fragmented).
  r.largestBefore = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);

  // 9.4 · send it
  r.httpCode = httpsPutB64(body, r.connMs, r.writeMs, r.respMs, r.note);
  r.sent = (r.httpCode >= 200 && r.httpCode < 300);

  r.totalMs   = msSince(tCycle);
  r.heapAfter = ESP.getFreeHeap();                  // TLS ctx + Strings released
}

// ── 10 · telemetry printing ───────────────────────────────────────────
static void ramWarnIfLow(uint32_t heap) {
  if (heap >= RAM_WARN_HEAP) return;
  Serial.println("[WARNING] RAM dangerously low - risk of heap collapse!");
  Serial.printf("         freeHeap=%u B · largest internal block=%u B\n",
                (unsigned)heap,
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
}

static void printCycle() {
  const CycleResult& r = g_cycle;
  Serial.println("──────────────────────────────────────────────");
  Serial.printf("[CYCLE %u] UPLOAD_INTERVAL_MS=%u (%s)%s\n", (unsigned)g_cycleNum,
                (unsigned)UPLOAD_INTERVAL_MS, g_paceName, g_paused ? " [paused-run]" : "");
  Serial.printf("  heap %u → %u B   (Δ %+d KB)\n",
                (unsigned)r.heapBefore, (unsigned)r.heapAfter,
                (int)((int32_t)r.heapAfter - (int32_t)r.heapBefore) / 1024);
  if (!r.captured) {
    Serial.println("  [CAM] capture/base64 FAILED — cycle aborted before PUT");
    Serial.printf("  cycle total %u ms\n", (unsigned)r.totalMs);
    return;
  }
  Serial.printf("  [CAM] captured %ux%u, %u B → base64 %u chars (JSON body %u B)\n",
                g_lastW, g_lastH, (unsigned)r.jpgBytes,
                (unsigned)r.b64Chars, (unsigned)r.bodyBytes);
  Serial.printf("  capture %u ms · base64+pack %u ms\n",
                (unsigned)r.capMs, (unsigned)r.b64Ms);
  Serial.printf("  TLS connect %u ms · write %u ms · response %u ms   [fresh handshake per PUT]\n",
                (unsigned)r.connMs, (unsigned)r.writeMs, (unsigned)r.respMs);
  Serial.printf("  HTTP %d %s\n", r.httpCode, r.note.c_str());
  Serial.printf("  pre-TLS largest internal block %u B\n", (unsigned)r.largestBefore);
  Serial.printf("  cycle total %u ms\n", (unsigned)r.totalMs);
}

static void recordCode(int code) {
  g_codeRing[g_codeRingIdx] = code;
  g_codeRingIdx = (g_codeRingIdx + 1) % 8;
}

static void printStats() {
  uint32_t cycles = g_okCount + g_failCount;
  Serial.println("──────────────────────────────────────────────");
  Serial.printf("[STATS] uptime %u s · cycles=%u ok=%u fail=%u (%u%%)\n",
                (unsigned)(millis() / 1000), (unsigned)cycles,
                (unsigned)g_okCount, (unsigned)g_failCount,
                cycles ? (unsigned)(g_okCount * 100 / cycles) : 0);
  Serial.printf("        avgCycle=%u ms · last codes:",
                cycles ? (unsigned)(g_cycleMsSum / cycles) : 0);
  for (int i = 0; i < 8; i++) {
    int idx = (g_codeRingIdx + i) % 8;
    if (g_codeRing[idx]) Serial.printf(" %d", g_codeRing[idx]);
  }
  Serial.println();
  Serial.printf("        heap now %u B · min-ever %u B · largest internal block %u B\n",
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  Serial.printf("        PSRAM free %u B · interval %u ms (%s) · paused=%s\n",
                (unsigned)ESP.getFreePsram(), (unsigned)UPLOAD_INTERVAL_MS, g_paceName,
                g_paused ? "yes" : "no");
}

// ── 11 · serial command parser ────────────────────────────────────────
static void printHelp() {
  Serial.println("[CMD] commands:");
  Serial.println("  slow   → UPLOAD_INTERVAL_MS = 1000 (1 FPS baseline)");
  Serial.println("  medium → UPLOAD_INTERVAL_MS = 200  (5 FPS target)");
  Serial.println("  fast   → UPLOAD_INTERVAL_MS = 100  (10 FPS target)");
  Serial.println("  once   → one upload now (works while paused)");
  Serial.println("  stop   → pause automatic uploads");
  Serial.println("  stats  → one-shot deep statistics");
  Serial.println("  help   → this list");
}

static void execCommand(String line) {
  line.trim();
  line.toLowerCase();
  if (line.length() == 0) return;

  if      (line == "slow")   { UPLOAD_INTERVAL_MS = 1000; g_paceName = "slow";   g_paused = false;
                               Serial.println("[CMD] UPLOAD_INTERVAL_MS = 1000 (1 FPS baseline)"); }
  else if (line == "medium") { UPLOAD_INTERVAL_MS = 200;  g_paceName = "medium"; g_paused = false;
                               Serial.println("[CMD] UPLOAD_INTERVAL_MS = 200  (5 FPS target)"); }
  else if (line == "fast")   { UPLOAD_INTERVAL_MS = 100;  g_paceName = "fast";   g_paused = false;
                               Serial.println("[CMD] UPLOAD_INTERVAL_MS = 100  (10 FPS target)"); }
  else if (line == "stop")   { g_paused = true;
                               Serial.println("[CMD] paused — type slow/medium/fast to resume"); }
  else if (line == "help")   { printHelp(); }
  else if (line == "stats")  { printStats(); }
  else if (line == "once")   { g_lastCycleMs = 0;   // forces one cycle on the next loop()
                               Serial.println("[CMD] single upload queued"); }
  else Serial.printf("[CMD] unknown '%s' — try help\n", line.c_str());
}

static void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { execCommand(line); line = ""; continue; }
    if (line.length() < 32) line += c;
  }
}

// ── 12 · setup / loop ─────────────────────────────────────────────────
static bool parseFirebaseUrl() {
  String u = FIREBASE_URL;
  int scheme = u.indexOf("://");
  if (scheme < 0) { Serial.println("[CFG] FIREBASE_URL must start with https://"); return false; }
  String rest = u.substring(scheme + 3);
  int slash = rest.indexOf('/');
  FB_HOST = (slash < 0) ? rest : rest.substring(0, slash);
  if (slash >= 0 && rest.length() > (unsigned)(slash + 1))
    Serial.println("[CFG] WARNING: FIREBASE_URL contains a path — RTDB root expected; using host only");
  if (FB_HOST.length() < 4 || FB_HOST.indexOf('.') < 0) {
    Serial.println("[CFG] FIREBASE_URL host looks invalid"); return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n═══════════════════════════════════════════════");
  Serial.println("  FirebasePreviewTest — XIAO ESP32-S3 Sense     ");
  Serial.printf("  %s\n", TEST_FW_VERSION);
  Serial.println("  camera → base64 → HTTPS PUT → Firebase RTDB   ");
  Serial.println("═══════════════════════════════════════════════");
  Serial.println("  (standalone test sketch — the SnapRiddle game");
  Serial.println("   firmware v1.4.1 is NOT part of this flash)  ");

  if (String(WIFI_SSID) == "YOUR_WIFI_SSID")
    Serial.println("[CFG] !! EDIT WIFI_SSID / WIFI_PASSWORD in this sketch first");
  if (String(FIREBASE_URL).indexOf("YOUR-PROJECT") >= 0)
    Serial.println("[CFG] !! EDIT FIREBASE_URL in this sketch first");

  Serial.printf("[BOARD] PSRAM %u B · flash %u B\n",
                (unsigned)ESP.getPsramSize(), (unsigned)ESP.getFlashChipSize());
  Serial.printf("[BOARD] free heap %u B · largest internal block %u B\n",
                (unsigned)ESP.getFreeHeap(),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));

  if (!parseFirebaseUrl()) {
    Serial.println("[CFG] halting — fix FIREBASE_URL and re-flash");
    while (true) delay(1000);
  }
  Serial.printf("[CFG] target: PUT https://%s%s\n", FB_HOST.c_str(), FB_PUT_PATH);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                       // production wifiConnect parity
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
  Serial.printf("\n[WiFi] connected, IP=%s RSSI=%d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());

  configTime(0, 0, "pool.ntp.org", "time.google.com");   // UTC — epoch for "ts"

  if (!camInit()) {
    Serial.println("[TEST] halting — camera init failed");
    while (true) delay(1000);
  }

  g_windowStartMs = millis();
  Serial.println("\n[TEST] ready — Serial commands: slow / medium / fast / once / stop / stats / help");
  Serial.println("[TEST] every cycle prints capture, base64, TLS, HTTP and heap telemetry");
  if (String(FIREBASE_URL).indexOf("YOUR-PROJECT") < 0) {
    Serial.println("[TEST] if the SnapRiddle host screen is open on this project, these frames");
    Serial.println("[TEST] will appear live in its CLOUD PREVIEW panel (same RTDB node).");
  }
}

void loop() {
  handleSerial();
  uint32_t now = millis();

  bool due = (g_lastCycleMs == 0) || (now - g_lastCycleMs >= UPLOAD_INTERVAL_MS);
  if (!g_paused && due) {
    g_lastCycleMs = now;

    // ── memory guard, BEFORE touching camera or TLS ──────────────────
    uint32_t heap = ESP.getFreeHeap();
    if (heap < RAM_WARN_HEAP) {
      ramWarnIfLow(heap);
      Serial.println("        cycle SKIPPED — waiting for heap recovery");
    } else {
      g_cycleNum++;
      doUploadCycle();
      printCycle();
      recordCode(g_cycle.httpCode);
      ramWarnIfLow(g_cycle.heapAfter);        // the same guard, post-release
      if (g_cycle.sent) g_okCount++; else g_failCount++;
      g_cycleMsSum += g_cycle.totalMs;
      g_windowCycles++;
    }
  }

  // ── 5 s heartbeat: target vs achieved rate + memory watermarks ─────
  if (g_windowStartMs == 0) g_windowStartMs = now;
  if (now - g_windowStartMs >= HEARTBEAT_MS) {
    uint32_t winSec = (now - g_windowStartMs) / 1000;
    float achieved = (winSec > 0) ? (float)g_windowCycles / (float)winSec : 0.0f;
    Serial.printf("[HEARTBEAT] pace=%s(%u ms → target %.1f fps)  achieved≈%.1f fps  "
                  "avgCycle=%u ms  ok=%u fail=%u\n",
                  g_paceName, (unsigned)UPLOAD_INTERVAL_MS,
                  1000.0f / (float)UPLOAD_INTERVAL_MS, achieved,
                  (g_okCount + g_failCount) ? (unsigned)(g_cycleMsSum / (g_okCount + g_failCount)) : 0,
                  (unsigned)g_okCount, (unsigned)g_failCount);
    Serial.printf("            heap=%u B  min-ever=%u B  largest-internal=%u B\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    g_windowStartMs = now;
    g_windowCycles = 0;
  }

  delay(2);
}