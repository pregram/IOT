// Moves mbedTLS buffers to PSRAM and prints a real diagnosis for HTTPClient -1.
//
// The precompiled core ships CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC=y, so every TLS
// session (two ~16.7 KB records plus handshake scratch) must fit in internal SRAM.
// With the camera, two httpd servers, WiFi, two 24 KB task stacks and a warm
// Firebase session resident, internal maxAlloc sat at 24-27 KB and every LLM
// handshake failed locally in ~15 ms as "-1: connection refused".
//
// MBEDTLS_PLATFORM_MEMORY is defined in the core's esp_config.h, so the allocator
// can be swapped at runtime (same policy as IDF's CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC).
// heap_caps_free() frees from any region, so blocks allocated before the swap are
// still freed safely.
//
// Call tlsPsramInstall() first thing in setup(), before WiFi. WiFiClientSecure
// constructors only init contexts; nothing is allocated until connect().
#pragma once
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <errno.h>
#include "esp_heap_caps.h"
#include "mbedtls/platform.h"
#include "parameters.h"

static bool g_tlsInPsram = false;   // set once in setup(), read-only afterwards

// TLS client whose single-byte read() yields when no byte is ready.
// HTTPClient parses headers and chunk sizes via Stream::timedRead(), which spins on
// read() without delay until the 12 s timeout. A provider stalling mid-reply kept
// the Gemini task spinning on CPU 0, starved IDLE0 for > 5 s and the task watchdog
// rebooted the board mid-game. One tick per empty read lets IDLE0 run.
//
// Optional wall-clock deadline (0 = off): HTTPClient's body loops only end on a
// per-read timeout, so a server dripping keep-alive filler is never cut. Past the
// deadline the client reports disconnected with nothing available, which ends every
// HTTPClient loop at once. http.end() skips stop() on a client that reports
// disconnected, so the caller must stop() it after a deadline cut.
class YieldingTlsClient : public WiFiClientSecure {
public:
  int read() override {
    // Past the deadline timedRead() would spin on this -1 for the whole 12 s stream
    // timeout without yielding (watchdog reboot), so zero the timeout and yield.
    if (deadlineHit()) { Stream::setTimeout(0); vTaskDelay(1); return -1; }
    int c = WiFiClientSecure::read();
    if (c < 0) vTaskDelay(1);
    return c;
  }
  using WiFiClientSecure::read;       // keep read(uint8_t*, size_t) visible
  int available() override { return deadlineHit() ? 0 : WiFiClientSecure::available(); }
  uint8_t connected() override { return deadlineHit() ? 0 : WiFiClientSecure::connected(); }

  void setDeadline(uint32_t budgetMs) { _deadline = budgetMs ? millis() + budgetMs : 0; _hit = false; }
  bool deadlineHit() {
    if (!_hit && _deadline && (int32_t)(millis() - _deadline) >= 0) _hit = true;
    return _hit;
  }
private:
  uint32_t _deadline = 0;
  bool _hit = false;
};

static void* tlsPsramCalloc(size_t n, size_t size) {
  void* p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  return p;
}
static void tlsPsramFree(void* p) { heap_caps_free(p); }

static void tlsPsramInstall() {
  if (!psramFound()) {
    Serial.println("[TLS] WARNING: no PSRAM (Tools → PSRAM: OPI PSRAM?) — mbedTLS stays in internal RAM");
    return;
  }
  if (mbedtls_platform_set_calloc_free(tlsPsramCalloc, tlsPsramFree) == 0) {
    g_tlsInPsram = true;
    Serial.printf("[TLS] mbedTLS buffers → PSRAM (psram free=%u)\n",
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  } else {
    Serial.println("[TLS] WARNING: mbedtls_platform_set_calloc_free failed — internal RAM");
  }
}

// One line naming the resource behind a negative HTTPClient code. The core's own
// log_e() for these paths is compiled out at Core Debug Level "None".
//   mbedtls=-0x7F00 -> SSL alloc failed (RAM)   errno=23 ENFILE -> no socket
// lastError() is the last handshake's mbedTLS code (it survives stop()); a DNS
// failure happens before any handshake and leaves it stale. `err` is errno captured
// by the caller right after POST(), because logging may clobber it.
static void tlsLogFailure(const char* tag, WiFiClientSecure& client, int httpCode, int err) {
  char buf[96];
  // After a successful handshake lastError() holds the socket fd (>= 0); only a
  // negative value is an mbedTLS code, so a read timeout prints "mbedtls=none".
  int tlsErr = client.lastError(buf, sizeof(buf));
  if (tlsErr > 0) tlsErr = 0;
  Serial.printf("[TLS] %s %d detail: mbedtls=-0x%04X \"%s\" errno=%d (%s) | "
                "internal free=%u maxAlloc=%u | psram free=%u maxAlloc=%u | tls=%s\n",
                tag, httpCode, (unsigned)(-tlsErr), tlsErr ? buf : "none", err, strerror(err),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),
                g_tlsInPsram ? "psram" : "internal");
}

// Attempt floors for gemFloorOk callers. With TLS in PSRAM a handshake only needs
// internal RAM for the socket, lwIP pbufs and objects under 4 KB
// (SPIRAM_MALLOC_ALWAYSINTERNAL=4096), so the floors are lower.
static uint32_t gemAttemptMinHeap()  { return g_tlsInPsram ? GEMINI_ATTEMPT_MIN_HEAP_PSRAM  : GEMINI_ATTEMPT_MIN_HEAP; }
static uint32_t gemAttemptMinBlock() { return g_tlsInPsram ? GEMINI_ATTEMPT_MIN_BLOCK_PSRAM : GEMINI_ATTEMPT_MIN_BLOCK; }
