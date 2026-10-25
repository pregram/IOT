// SnapRiddle hardware node (XIAO ESP32-S3 Sense): camera, AI judge, riddle maker,
// room speaker and action button. The web app stays the game master.
// Task split, data flows and invariants: Documentation/DEVELOPER_GUIDE.md.
// Board settings and libraries: Documentation/INSTALLATION.md.
//
// The firmware is one translation unit, so include order matters: each header
// may use symbols from the ones above it.

#include <Arduino.h>
#include <WiFi.h>
#include <LittleFS.h>

#include "parameters.h"
#include "tls_psram.h"        // tlsPsramInstall() must run before any TLS
#include "pins_board.h"
#include "tts_engine.h"      // Core 1 only
#include "gemini_judge.h"    // geminiTask only
#include "gemini_riddle.h"   // geminiTask only
#include "gemini_task.h"
#include "camera_srv.h"
#include "cloud_link.h"      // Core 0
#include "button_ctl.h"
#include "game_link.h"

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(300);
  Serial.println("\n══════════════════════════════════════════");
  Serial.printf("  SnapRiddle Hardware Node  v%s\n", FW_VERSION);
  Serial.println("  XIAO ESP32-S3 (Sense) · camera+judge+voice");
  Serial.println("══════════════════════════════════════════");
  printHelp();

  // mbedTLS allocations go to PSRAM; this has to happen before WiFi or any TLS
  // session exists (see tls_psram.h).
  tlsPsramInstall();

  // LittleFS is mounted for the serial usage report only; nothing writes to it now
  if (!LittleFS.begin(true)) Serial.println("[FS] LittleFS mount failed!");
  else Serial.printf("[FS] mounted. used=%u / total=%u bytes\n",
                     (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());

  setupLedFlash();
  buttonInit();

  // blocks until connected; every subsystem needs WiFi
  wifiConnect();
  setEspState("WIFI");

  // button events need real epoch-ms timestamps for the host
  ensureTimeStart();
  uint32_t t0 = millis();
  while (!g_timeSynced && millis() - t0 < SNTP_WAIT_MS) { checkTimeSynced(); delay(200); }
  Serial.println(g_timeSynced ? "[TIME] ready" : "[TIME] not synced yet (will keep trying)");

  ttsEngineInit();
  applyTtsSettings("Kore", DEFAULT_SPEED, DEFAULT_VOLUME);

  if (camInit()) {
    Serial.println("[CAM] ready.");
    startCameraServers();
    Serial.printf("[WEB] stream  → http://%s:81/stream\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WEB] capture → http://%s/capture\n",   WiFi.localIP().toString().c_str());
  } else {
    setEspState("CAM_ERR");
    Serial.println("[CAM] init FAILED — game judging disabled, text/cloud still work.");
  }

  cloudInit();
  startNetTask();
  startGeminiTask();
  // The boot heartbeat is sent by netTask on its first cycle instead of here.
  // Sending it from Core 1 raced netTask's first TLS handshake on the shared client
  // (one failed PATCH on every boot).
  g_bootBeatPending = true;

  // Also left to netTask: it speaks the boot line after its first poll and skips it
  // if a game is already live (mid-game reboot).
  g_bootLinePending = true;

  Serial.println("[SYS] Ready.");
}

void loop() {
  // Core 1 owns the Audio object
  ttsHousekeeping();

  // voice settings handed over from Core 0
  consumeVoiceSettings();

  BtnEvent ev = buttonScan();
  if (ev != BTN_NONE) dispatchButton(ev);

  serialConsolePump();

  // keep the board state current for the /status probe
  static uint32_t lastStateSync = 0;
  if (millis() - lastStateSync > 500) {
    lastStateSync = millis();
    GameMirror m; copyMirror(m);
    if (m.valid && m.state.length()) {
      // Core 0 sets and clears JUDGING / GENERATING itself; don't overwrite them
      const String cur = getEspState();
      if (cur != "JUDGING" && cur != "GENERATING") setEspState(m.state.c_str());
    } else if (WiFi.status() == WL_CONNECTED && getEspState() != "CAM_ERR") {
      setEspState("IDLE");
    }
  }

  // periodic heap report, to spot leaks during long parties
  static uint32_t lastHeap = 0;
  if (millis() - lastHeap > 30000) {
    lastHeap = millis();
    Serial.printf("[SYS] free heap=%u, min ever=%u\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
  }

  vTaskDelay(1);
}
