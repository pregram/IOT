// Firebase RTDB REST link (netTask, Core 0). The web app is the game master; this
// board only writes hardware facts (verdicts, generated riddles, heartbeats, button
// events, speech echoes). Full schema: Documentation/DEVELOPER_GUIDE.md.
//
// READ  GET hardware_session.json, every 600 ms in a live turn, 1.5 s otherwise:
//   active_room, hw (game mirror), cmdq/{id} (voice line queue, authoritative),
//   cmd (legacy newest-wins line), esp_settings, judge_request, riddle_req, hint_req
// WRITE
//   PATCH hardware_session/esp              heartbeat every 10 s
//   PUT   hardware_session/tts_start|done   id of the last started / finished line
//   PUT   rooms/{pin}/capture_request       button single/double press
//   PUT   rooms/{pin}/hint_request          button long press
//   PUT   rooms/{pin}/judge_result/{phase}  verdict
//   PUT   rooms/{pin}/current_riddle | next_riddle   generated riddle (now / hold)
//   PUT   rooms/{pin}/hint                  spoken hint record
//
// Every outbound path has a failure plan that holds at most one item and costs
// nothing while the network is healthy: TTS lines queue in tts_engine.h, and the
// last failed button event / judge photo / verdict each get one retry slot here.
//
// judge_phase is epoch seconds (fits uint32 until 2106).
// Threading: the persistent Firebase client is touched only from netTask. LLM calls
// run on geminiTask; netTask only submits jobs and collects results. Core 1 reads the
// mirror through copyMirror() and only sets request flags.
// camera_srv.h must be included before this header (g_streaming lives there).
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h>
#include "parameters.h"
#include "shared_state.h"
#include "gemini_judge.h"
#include "gemini_riddle.h"
#include "gemini_rotation.h"
#include "gemini_task.h"
#include "tts_engine.h"

struct GameMirror {
  bool   valid = false;
  String room;            // PIN or ""
  String state;           // FSM state string, "" when idle
  uint32_t seq = 0;
  uint32_t judgePhase = 0;   // seconds; 0 = no judge pending
  String playerId, player;
  int round = 0, rounds = 0;
  String riddle, target, difficulty, theme, special;
  String proof;               // "Object Match", ...
  bool   allowPaper = false;  // host pivoted this turn to paper proof
  int    countdown = 0;      // Countdown Capture seconds (0 = unknown)
  int timeLimit = 0, timeLeft = 0;
  bool timerRunning = false, paused = false, unclear = false;
  // why buttons are locked ("" = free): "reading" (riddle being read),
  // "host_paused", "hint" (hint being read)
  String lock;
};

static SemaphoreHandle_t cloudMux = nullptr;
static GameMirror g_mirror;
static uint64_t   g_lastCmdId64 = 0;        // last spoken cloud line id (epoch ms)
static String     g_lastEspSettingsRaw;     // applied-settings cache (raw JSON)

static void cloudInit() {
  if (!cloudMux) cloudMux = xSemaphoreCreateMutex();
}

// Backstop for the direct /speak path only (httpd task); pollOnce() keeps its own
// cmd/cmdq dedup. See shared_state.h.
bool claimCmdId(uint64_t id) {
  bool claimed = false;
  if (!cloudMux) cloudInit();
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (id > g_lastCmdId64) { g_lastCmdId64 = id; claimed = true; }
    xSemaphoreGive(cloudMux);
  }
  return claimed;
}

// Definitions for the externs in shared_state.h. Board state is a fixed buffer
// behind cloudMux because it is written from both cores.
bool   g_settingsViaHttp = false;
volatile bool g_linkUp = false;
volatile bool g_timeSynced = false;
static char g_espStateBuf[16] = "BOOT";      // guarded by cloudMux

void setEspState(const char* s) {
  if (!cloudMux) cloudInit();
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    strncpy(g_espStateBuf, s ? s : "", sizeof(g_espStateBuf) - 1);
    g_espStateBuf[sizeof(g_espStateBuf) - 1] = 0;
    xSemaphoreGive(cloudMux);
  }
}

String getEspState() {
  String out;
  if (!cloudMux) { out = g_espStateBuf; return out; }
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    out = g_espStateBuf;
    xSemaphoreGive(cloudMux);
  }
  return out;
}

// The voice profile has three writers on two cores, so it is a fixed buffer behind
// cloudMux. Speed/volume stay plain scalars: a torn read there is harmless.
static char g_voicePendProfileBuf[24] = "";  // guarded by cloudMux

void setVoicePendProfile(const char* p) {
  if (!cloudMux) cloudInit();
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    strncpy(g_voicePendProfileBuf, p ? p : "", sizeof(g_voicePendProfileBuf) - 1);
    g_voicePendProfileBuf[sizeof(g_voicePendProfileBuf) - 1] = 0;
    xSemaphoreGive(cloudMux);
  }
}

String getVoicePendProfile() {
  String out;
  if (!cloudMux) { out = g_voicePendProfileBuf; return out; }
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    out = g_voicePendProfileBuf;
    xSemaphoreGive(cloudMux);
  }
  return out;
}

volatile bool g_bootBeatPending = false;
volatile bool g_bootLinePending = false;
volatile bool g_forceFallback = false;

// voice-settings handoff: netTask or the /settings handler queues, Core 1 applies
volatile bool g_voicePend = false;
float        g_voicePendSpeed = -1.0f;
int          g_voicePendVol = -1;

// request mailbox: Core 1 sets a flag, Core 0 does the HTTP write
static volatile bool g_reqCapture = false;
static volatile bool g_reqHint    = false;
// > 0 = Countdown Capture (double press): the body becomes {"ts":...,"countdown":N}
// and the host runs the countdown.
static volatile int g_reqCountdown = 0;
static String g_hintPlayerId;               // guarded by cloudMux

// judge bookkeeping (netTask-local, exposed for the serial console)
static uint32_t g_lastJudgeDone = 0;
static uint32_t g_judgeCount = 0;

// Last {phase, riddle, target} seen under judge_request. Survives mirror races and
// short network drops; cleared when the host nulls the node.
static uint32_t g_jreqPhase  = 0;
static String   g_jreqRiddle = "";
static String   g_jreqTarget = "";
static String   g_jreqProof  = "";
static bool     g_jreqPaper  = false;

// riddle_req / hint_req state. netTask-only (pollOnce fills, the pumps consume), so
// no locking. The host overwrites riddle_req when it wants another riddle; a stale
// request just stays until replaced, and the retry-forever cadence covers failures.
static uint64_t g_rreqId         = 0;     // req_id being served (epoch ms)
static String   g_rreqDifficulty = "";
static String   g_rreqEnvironment = "";  // the room's single environment
static String   g_rreqProof      = "";   // proof method rolled by the host
static String   g_rreqThemes     = "";   // older hosts send a theme list instead
static String   g_rreqExcluded   = "";   // comma-joined recent answers to avoid
static bool     g_rreqBonus      = false; // reason == "bonus"
static String   g_rreqPlayer     = "";    // for logs only
static bool     g_rreqDone       = false; // published; wait for the next request
// req_id last submitted to geminiTask. If the slot is still busy and this no longer
// matches g_rreqId, the host has moved on: ask the job to abort between attempts.
static uint64_t g_rreqSubmittedId = 0;
// Publish staging: hold=true publishes to rooms/{pin}/next_riddle (a prefetch while
// the results screen is up). When the turn goes live the host re-writes the same
// request with publish:"now" and the riddle is republished from cache, with no
// second LLM call.
static bool     g_rreqHold       = false;
// 0 idle, 1 generating, 2 riddle in hand (publish next cycle, after a fresh mirror
// and request check)
static uint8_t  g_rreqStage      = 0;
static GeneratedRiddle g_rreqReady;       // stash between generation and publish
static uint32_t g_rreqPubTries   = 0;     // publish-write retries for the stash
static uint64_t g_hintReqId      = 0;     // hint_req being served (epoch ms)
static String   g_hintReqPlayer  = "";
static String   g_hintText       = "";    // stored hint waiting to be spoken + written
static bool     g_hintPend       = false; // true until the hint is spoken + written
// The hint ships inside the riddle payload, so the only hint stage left is
// 2 = speak + write.
static uint8_t  g_hintStage      = 0;
// One hint per riddle: the latch holds the riddle req_id whose hint was already
// spoken. Another hint_req for the same riddle (web re-mint, button mashing) is
// ignored, and an unclear retake does not clear it. Cleared by a new riddle request
// and by a session scrub.
static uint64_t g_hintLatchReqId = 0;
// What Core 0 is busy on ("" / "riddle" / "hint" / "judge"). It rides the heartbeat
// so the web can tell "thinking" from "offline". Each pump re-asserts its own task
// on entry. Fixed buffer behind cloudMux because the serial console reads it from
// Core 1.
static char g_genTaskBuf[12] = "";           // guarded by cloudMux

static void setGenTask(const char* t) {
  if (!cloudMux) cloudInit();
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    strncpy(g_genTaskBuf, t ? t : "", sizeof(g_genTaskBuf) - 1);
    g_genTaskBuf[sizeof(g_genTaskBuf) - 1] = 0;
    xSemaphoreGive(cloudMux);
  }
}

static String getGenTask() {
  String out;
  if (!cloudMux) { out = g_genTaskBuf; return out; }
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(50)) == pdTRUE) {
    out = g_genTaskBuf;
    xSemaphoreGive(cloudMux);
  }
  return out;
}

// gemFloorOk()/gemFloorReset() live in gemini_rotation.h because geminiTask needs them
// and does not include this header. Judge/riddle serialization is geminiTask's job:
// it always serves the judge slot first.

// Without a synced clock, the first cmd line seen is swallowed so a re-flashed board
// does not read the previous session's last line aloud.
static bool g_cmdSeeded = false;

// Boot instant in epoch ms, set when SNTP lands. The cmd floor: lines older than
// boot belong to the previous session and are never spoken; newer ones are ours,
// even on the very first poll (the DB link can come up minutes after boot, and
// swallowing the first line used to eat the game intro).
static uint64_t g_bootEpochMs = 0;

// ids of the last finished / started lines already written out
static uint64_t g_ttsDoneWritten = 0;
static uint64_t g_ttsStartWritten = 0;

static void copyMirror(GameMirror& out) {
  if (!cloudMux) { out = g_mirror; return; }
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    out = g_mirror;
    xSemaphoreGive(cloudMux);
  }
}

static bool copyHintTarget(String& out) {
  bool has = false;
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    out = g_hintPlayerId;
    has = out.length() > 0;
    xSemaphoreGive(cloudMux);
  }
  return has;
}

static void ensureTimeStart() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // UTC; only the epoch is needed
}

static void checkTimeSynced() {
  if (g_timeSynced) return;
  time_t now = time(nullptr);
  if (now > 1700000000) {           // ~Nov 2023: SNTP has landed
    g_timeSynced = true;
    g_bootEpochMs = (uint64_t)now * 1000ULL;   // cmd floor anchor
    Serial.printf("[TIME] synced, epoch=%lld s\n", (long long)now);
  }
}

static uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
}

// One persistent WiFiClientSecure + HTTPClient for all Firebase REST traffic: the
// TCP+TLS handshake (~1-2 s) only happens on the first request and after a drop.
// Any transport error or 30 s of idle drops it; the next request reconnects.
static YieldingTlsClient g_fbTls;            // Core 0 only
static HTTPClient       g_fbHttp;            // Core 0 only
static uint32_t         g_fbLastUseMs = 0;
static bool             g_fbConfigured = false;
static const uint32_t FB_MIN_HEAP     = 30000;   // never (re)connect below this
static const uint32_t FB_IDLE_DROP_MS = 30000;   // drop a session idle this long

static void fbDrop() {
  g_fbHttp.end();
  g_fbTls.stop();
}

// Clean the socket state before a request; HTTPClient reconnects lazily on send.
static bool fbBegin(const String& url) {
  // Both gate paths log (at most every 10 s). Silent, a heap-floor or WiFi outage
  // looked exactly like a healthy quiet link for 13.5 minutes in one field test.
  static uint32_t s_lastGateLogMs = 0;
  const bool rateOk = (millis() - s_lastGateLogMs > 10000);
  if (WiFi.status() != WL_CONNECTED) {
    if (rateOk) {
      s_lastGateLogMs = millis();
      Serial.printf("[DB] blocked: wifi down (heap=%u floor=%u)\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)FB_MIN_HEAP);
    }
    return false;
  }
  if (ESP.getFreeHeap() < FB_MIN_HEAP) {
    // Too little RAM for a TLS stack. Callers treat this as a network failure; retry
    // cycles and the pending backup cover it.
    if (rateOk) {
      s_lastGateLogMs = millis();
      Serial.printf("[DB] blocked: heap %u < floor %u — TLS connect skipped\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)FB_MIN_HEAP);
    }
    return false;
  }
  if (!g_fbConfigured) {
    g_fbTls.setInsecure();
    g_fbTls.setTimeout(6);                    // handshake timeout, seconds
    g_fbConfigured = true;
  }
  // half-dead socket after an outage, or idle too long: start clean
  bool stale = (g_fbLastUseMs != 0 && millis() - g_fbLastUseMs > FB_IDLE_DROP_MS);
  if (stale && g_fbTls.connected()) g_fbTls.stop();
  g_fbHttp.setReuse(true);
  g_fbHttp.setTimeout(6000);
  return true;
}

static bool httpGet(const String& url, String& bodyOut) {
  if (!fbBegin(url)) return false;
  if (!g_fbHttp.begin(g_fbTls, url)) return false;
  int code = g_fbHttp.GET();
  bool ok = false;
  if (code == HTTP_CODE_OK) { bodyOut = g_fbHttp.getString(); ok = true; }
  else if (code > 0) Serial.printf("[DB] GET %d → %s\n", code, g_fbHttp.getString().substring(0, 120).c_str());
  g_fbHttp.end();
  if (code < 0) fbDrop();                     // transport died: fresh handshake next time
  g_fbLastUseMs = millis();
  return ok;
}

static bool httpSend(const char* method, const String& url, const String& body) {
  if (!fbBegin(url)) return false;
  if (!g_fbHttp.begin(g_fbTls, url)) return false;
  int code = g_fbHttp.sendRequest(method, body);
  bool ok = (code >= 200 && code < 300);
  if (!ok) Serial.printf("[DB] %s %d → %s\n", method, code,
                         code > 0 ? g_fbHttp.getString().substring(0, 120).c_str() : "net err");
  // One success line per 5 minutes proves the link is alive without spamming.
  static uint32_t s_lastOkLogMs = 0;
  if (ok && millis() - s_lastOkLogMs > 300000) {
    s_lastOkLogMs = millis();
    Serial.printf("[DB] %s %d ok (link healthy)\n", method, code);
  }
  g_fbHttp.end();
  if (code < 0) fbDrop();                     // transport died: fresh handshake next time
  g_fbLastUseMs = millis();
  return ok;
}

// Reserve + append instead of a chained `+`: this runs on every Firebase call, so
// the temporaries fragmented internal heap for the whole match.
static String dbUrl(const String& path) {
  String url;
  url.reserve(strlen(FB_DB_URL) + path.length() + 8);
  url += FB_DB_URL; url += '/'; url += path; url += ".json";
  return url;
}

// Last-failed-send backup, one slot each: one pending judge (image or verdict) and
// one pending button event, never a history. A slot is overwritten by the next
// failure and freed on success, expiry, or when a newer attempt takes over.
// Retry cadence and expiry are the constants below.
struct PendingJudge {
  bool     valid = false;
  bool     haveImage = false;   // true: re-send the image to the judge; false: re-write the verdict
  PsStr    imgB64;              // the exact frame that failed (~7-20 KB, PSRAM)
  int      imgW = 0, imgH = 0;
  String   room, riddle, target;
  String   proof;
  bool     allowPaper = false;
  uint32_t phase = 0;
  JudgeOutcome outcome;         // used when haveImage == false
  uint32_t savedMs = 0;
  uint32_t lastTryMs = 0;
  uint8_t  tries = 0;
  // a retry is on geminiTask's judge slot, waiting for GEM_DONE
  bool     awaitingGemini = false;
};
struct PendingBtn {
  bool     valid = false;
  String   url, body;           // the exact PUT that failed
  uint32_t savedMs = 0, lastTryMs = 0;
};
static PendingJudge g_pendJudge;
static PendingBtn   g_pendBtn;

static const uint32_t BTN_PEND_RETRY_MS   = 4000;    // button retry cadence once WiFi is back
static const uint32_t BTN_PEND_MAX_AGE_MS = 60000;   // a button event is useless after a minute
static const uint32_t PEND_RETRY_MS       = 15000;   // judge retry cadence once WiFi is back
static const uint32_t PEND_MAX_AGE_MS     = 120000;  // a late verdict is useless after 2 min

// Keep the last button write that failed because of the network. If WiFi is up the
// server refused it, and retrying would not help.
static void keepLastFailedWrite(const String& url, const String& body) {
  if (WiFi.status() == WL_CONNECTED) return;
  g_pendBtn.valid     = true;
  g_pendBtn.url       = url;
  g_pendBtn.body      = body;
  g_pendBtn.savedMs   = millis();
  g_pendBtn.lastTryMs = millis();
  Serial.println("[PEND] button event kept — will re-send when the network is back");
}

static void clearPendingJudge(const char* why) {
  if (!g_pendJudge.valid) return;
  Serial.printf("[PEND] judge backup cleared (%s)\n", why);
  // stop an in-flight retry between attempts; pendingPump still drains its result
  if (g_pendJudge.awaitingGemini) geminiRequestJudgeAbort();
  // the serial console snapshots this struct, so reassign under the mutex
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_pendJudge = PendingJudge();          // frees the held frame, if any
    xSemaphoreGive(cloudMux);
  }
}

// Snapshot for Core 1: the serial console must not read the live Strings while
// Core 0 reassigns them.
struct PendJudgeSnapshot {
  bool     valid = false;
  bool     haveImage = false;
  uint32_t phase = 0;
  uint32_t savedMs = 0;
  uint32_t tries = 0;
  size_t   imgLen = 0;
  String   feedback;
};
static void snapshotPendJudge(PendJudgeSnapshot& s) {
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    s.valid      = g_pendJudge.valid;
    s.haveImage  = g_pendJudge.haveImage;
    s.phase      = g_pendJudge.phase;
    s.savedMs    = g_pendJudge.savedMs;
    s.tries      = g_pendJudge.tries;
    s.imgLen     = g_pendJudge.imgB64.length();
    s.feedback   = g_pendJudge.outcome.feedback;
    xSemaphoreGive(cloudMux);
  }
}

// Keep the last judge photo whose every attempt failed. The retry re-sends this
// frame, the proof the player actually posed, not a new capture minutes later.
static void savePendingImage(const String& room, uint32_t phase,
                             const String& riddle, const String& target,
                             const JudgeOutcome& o) {
  if (!o.imgB64.length()) {
    // Should not happen now that the judge hands the frame over on exhaustion; log it
    // loudly, since this silent drop once hung a match in EVALUATING.
    Serial.println("[PEND] no frame in the failed outcome — nothing to park (host watchdog covers)");
    return;
  }
  // The frame parks in PSRAM, so parking is effectively free. The internal-heap guard
  // below only applies to a board without PSRAM; it used to refuse to park under heap
  // pressure, exactly when parking matters most.
  if (!psramFound() && ESP.getFreeHeap() < (unsigned)(o.imgB64.length() + 25000)) {
    Serial.println("[PEND] heap too low to keep the last image — dropped (host fallback covers)");
    return;
  }
  // built under the mutex (the serial console snapshots this struct from Core 1)
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_pendJudge = PendingJudge();
    g_pendJudge.valid     = true;
    g_pendJudge.haveImage = true;
    g_pendJudge.imgB64    = o.imgB64;
    g_pendJudge.imgW      = o.imgW;
    g_pendJudge.imgH      = o.imgH;
    g_pendJudge.room      = room;
    g_pendJudge.phase     = phase;
    g_pendJudge.riddle    = riddle;
    g_pendJudge.target    = target;
    g_pendJudge.proof     = g_jreqProof;      // judge context rides along
    g_pendJudge.allowPaper = g_jreqPaper || g_mirror.allowPaper;
    g_pendJudge.savedMs   = millis();
    g_pendJudge.lastTryMs = millis();
    g_pendJudge.tries     = 0;
    xSemaphoreGive(cloudMux);
  }
  Serial.printf("[PEND] judge photo kept for retry (%u b64 chars, phase %u) — "
                "re-send every %u s, gives up after %u s\n",
                (unsigned)o.imgB64.length(), (unsigned)phase,
                (unsigned)(PEND_RETRY_MS / 1000), (unsigned)(PEND_MAX_AGE_MS / 1000));
}

// The judge answered but the verdict never reached the database: park the small
// verdict and free the image.
static void savePendingResult(const String& room, uint32_t phase, const JudgeOutcome& o) {
  // under the mutex, see savePendingImage
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_pendJudge = PendingJudge();
    g_pendJudge.valid     = true;
    g_pendJudge.haveImage = false;
    g_pendJudge.outcome.ok       = o.ok;
    g_pendJudge.outcome.passed   = o.passed;
    g_pendJudge.outcome.unclear  = o.unclear;
    g_pendJudge.outcome.feedback = o.feedback;
    g_pendJudge.outcome.seen     = o.seen;
    g_pendJudge.room      = room;
    g_pendJudge.phase     = phase;
    g_pendJudge.savedMs   = millis();
    g_pendJudge.lastTryMs = millis();
    g_pendJudge.tries     = 0;
    xSemaphoreGive(cloudMux);
  }
  Serial.println("[PEND] verdict write failed — verdict kept for retry (image freed)");
}

// gen (""/"riddle"/"hint"/"judge") lets the web tell a busy board from a dead one.
static bool writeEspHeartbeat(const String& state, const char* gen = "") {
  String body = "{\"ip\":\"" + WiFi.localIP().toString() + "\",\"fw\":\"" FW_VERSION
    + "\",\"rssi\":" + String(WiFi.RSSI())
    + ",\"heap\":" + String((unsigned)ESP.getFreeHeap())
    + ",\"state\":\"" + state + "\"";
  // PATCH keeps fields it does not mention, so an idle beat must null gen. Leaving it
  // out kept "riddle"/"judge" stuck, which disabled the web's riddle re-request
  // watchdog and stretched its judge patience on an idle board.
  body += (gen && gen[0]) ? String(",\"gen\":\"") + gen + "\"" : String(",\"gen\":null");
  // boot epoch (s) changes on every reboot, so the web reopens the MJPEG stream the
  // reboot cut (that stream never errors on its own)
  if (g_bootEpochMs) body += ",\"boot\":" + String((unsigned long long)(g_bootEpochMs / 1000ULL));
  body += ",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  return httpSend("PATCH", dbUrl("hardware_session/esp"), body);
}

static bool writeCaptureRequest() {
  GameMirror m; copyMirror(m);
  if (!m.room.length()) return false;
  if (!g_timeSynced) { Serial.println("[BTN] time not synced — event dropped"); return false; }
  // {"ts":...} for a snap, {"ts":...,"countdown":N} for a Countdown Capture.
  // The web still accepts the legacy bare-number body.
  int cd = g_reqCountdown; g_reqCountdown = 0;
  String body = String("{\"ts\":") + String((unsigned long long)epochMs());
  if (cd > 0) body += String(",\"countdown\":") + String(cd);
  body += "}";
  String url  = dbUrl("rooms/" + m.room + "/capture_request");
  if (httpSend("PUT", url, body)) return true;
  keepLastFailedWrite(url, body);        // network backup
  return false;
}

static bool writeHintRequest() {
  GameMirror m; copyMirror(m);
  if (!m.room.length() || !m.playerId.length()) return false;
  if (!g_timeSynced) { Serial.println("[BTN] time not synced — event dropped"); return false; }
  String body = "{\"player_id\":\"" + m.playerId + "\",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  String url  = dbUrl("rooms/" + m.room + "/hint_request");
  if (httpSend("PUT", url, body)) return true;
  keepLastFailedWrite(url, body);        // network backup
  return false;
}

// Minimal escaping for hand-built JSON bodies: backslash, double quote, newline.
static void jsonEscape(String& s) {
  s.replace("\\", "\\\\");
  s.replace("\"", "\\\"");
  s.replace("\n", " ");
}

static bool writeJudgeResult(const String& room, uint32_t phase, const JudgeOutcome& o) {
  String fb = o.feedback;
  jsonEscape(fb);
  // "seen" feeds the spoken "Not quite, I see ..., but I was looking for ..." line.
  String seen = o.seen;
  jsonEscape(seen);
  String body = String("{\"phase\":") + phase
    + ",\"passed\":" + (o.passed ? "true" : "false")
    + ",\"unclear\":" + (o.unclear ? "true" : "false")
    + ",\"feedback\":\"" + fb + "\""
    + ",\"seen\":\"" + seen + "\""
    + ",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  return httpSend("PUT", dbUrl("rooms/" + room + "/judge_result/" + String(phase)), body);
}

// "This line finished speaking": the web advances banners and arms the turn clock
// on the real end of speech.
static bool writeTtsDone(uint64_t id) {
  String body = String("{\"id\":") + String((unsigned long long)id)
    + ",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  return httpSend("PUT", dbUrl("hardware_session/tts_done"), body);
}

// "This line started playing" (first decoded audio): the web anchors its speech-gate
// fallbacks here instead of on the queue time.
static bool writeTtsStart(uint64_t id) {
  String body = String("{\"id\":") + String((unsigned long long)id)
    + ",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  return httpSend("PUT", dbUrl("hardware_session/tts_start"), body);
}

// req_id ties the riddle to the host's riddle_req; id is a stable "gem-<req_id>".
// hold=true writes next_riddle so the riddle is not revealed before Continue.
static bool writeCurrentRiddle(const String& room, uint64_t reqId,
                               const GeneratedRiddle& r, bool hold) {
  String text  = r.text;         jsonEscape(text);
  String answ  = r.answer;       jsonEscape(answ);
  String hint  = r.hint;         jsonEscape(hint);
  String proof = r.proofMethod;  jsonEscape(proof);
  String diff  = r.difficulty;   jsonEscape(diff);
  String theme = r.theme;        jsonEscape(theme);
  String body = String("{\"req_id\":") + String((unsigned long long)reqId)
    + ",\"id\":\"gem-" + String((unsigned long long)reqId) + "\""
    + ",\"text\":\"" + text + "\""
    + ",\"target_keyword\":\"" + answ + "\""
    + (hint.length() ? String(",\"hint\":\"" + hint + "\"") : String(""))
    + ",\"proof_method\":\"" + proof + "\""
    + ",\"difficulty\":\"" + diff + "\""
    + ",\"theme\":\"" + theme + "\""
    + ",\"time_limit_sec\":" + String(r.timeLimitSec) + "}";
  return httpSend("PUT", dbUrl("rooms/" + room + (hold ? "/next_riddle" : "/current_riddle")), body);
}

// player_id may be empty: the host fills its own accounting from the hint_request
// it wrote.
static bool writeRoomHint(const String& room, uint64_t reqId,
                          const String& playerName, const String& hintText) {
  String pn = playerName; jsonEscape(pn);
  String ht = hintText;   jsonEscape(ht);
  String body = String("{\"req_id\":") + String((unsigned long long)reqId)
    + ",\"player_id\":\"\""
    + ",\"player_name\":\"" + pn + "\""
    + ",\"text\":\"" + ht + "\""
    + ",\"ts\":" + String((unsigned long long)epochMs()) + "}";
  return httpSend("PUT", dbUrl("rooms/" + room + "/hint"), body);
}

// Last-failed-send retry pump, once per netTask cycle:
//   1. a button event that never reached the database
//   2. the last judge image that never got a verdict (re-sent as-is)
//   3. the last verdict that never reached the database
// Only with WiFi up, no live judge, the speaker idle, and one try per cadence.
static void pendingPump() {
  uint32_t now = millis();

  // 1. button event backup (cheap: no camera, no LLM call)
  if (g_pendBtn.valid) {
    if (now - g_pendBtn.savedMs > BTN_PEND_MAX_AGE_MS) {
      g_pendBtn.valid = false;
      Serial.println("[PEND] button event expired (stale)");
    } else if (WiFi.status() == WL_CONNECTED &&
               now - g_pendBtn.lastTryMs > BTN_PEND_RETRY_MS) {
      g_pendBtn.lastTryMs = now;
      if (httpSend("PUT", g_pendBtn.url, g_pendBtn.body)) {
        g_pendBtn.valid = false;
        Serial.println("[PEND] button event delivered on retry");
      }
    }
  }

  // 2. judge backup.
  // Always drain a stray retry result first. If the backup was cleared under an
  // in-flight retry, nothing else would take its GEM_DONE, and geminiSubmitJudgeJob()
  // only works from GEM_IDLE, so the judge slot would wedge forever.
  if (geminiJudgeState() == GEM_DONE && geminiJudgeIsRetry() &&
      !(g_pendJudge.valid && g_pendJudge.awaitingGemini)) {
    JudgeOutcome o; String room, riddle, target; uint32_t phase;
    geminiTakeJudgeResult(o, room, phase, riddle, target);
    Serial.println("[PEND] retry result discarded (backup abandoned)");
  }

  if (!g_pendJudge.valid) return;
  if (now - g_pendJudge.savedMs > PEND_MAX_AGE_MS) { clearPendingJudge("expired"); return; }

  GameMirror m; copyMirror(m);
  if (m.valid && m.room.length() && m.room != g_pendJudge.room) { clearPendingJudge("room changed"); return; }
  if (!m.valid && m.state.isEmpty())                            { clearPendingJudge("game closed");  return; }

  if (!g_pendJudge.haveImage) {
    // verdict-only re-write: a pure Firebase retry
    Serial.println("[PEND] re-writing the judge verdict…");
    if (writeJudgeResult(g_pendJudge.room, g_pendJudge.phase, g_pendJudge.outcome)) {
      g_judgeCount++;
      clearPendingJudge("delivered");
    }
    return;
  }

  // A retry already in flight is polled regardless of the JUDGING/TTS guard below;
  // that guard only decides whether to start a new one.
  if (g_pendJudge.awaitingGemini) {
    if (geminiJudgeState() != GEM_DONE || !geminiJudgeIsRetry()) return;  // still working, or it belongs to the live judge
    JudgeOutcome o; String room, riddle, target; uint32_t phase;
    if (!geminiTakeJudgeResult(o, room, phase, riddle, target)) return;
    g_pendJudge.awaitingGemini = false;
    GameMirror m2; copyMirror(m2);
    setEspState((m2.valid && m2.state.length()) ? m2.state.c_str() : "IDLE");
    if (o.ok) {
      g_pendJudge.haveImage = false;      // image no longer needed
      if (writeJudgeResult(g_pendJudge.room, g_pendJudge.phase, o)) {
        g_judgeCount++;
        clearPendingJudge("delivered");
      } else {
        g_pendJudge.savedMs = now;        // verdict stage gets a fresh clock
        Serial.println("[PEND] judged ok, verdict write failed — kept for retry");
        // outcome hand-off under the mutex (the Core 1 snapshot reads it)
        if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
          g_pendJudge.imgB64.clear();
          g_pendJudge.outcome = o;
          xSemaphoreGive(cloudMux);
        }
      }
    } else {
      Serial.println("[PEND] retry failed — keeps waiting");
    }
    return;
  }

  if (WiFi.status() != WL_CONNECTED) return;
  if (getEspState() == "JUDGING" || ttsSpeaking()) return;   // don't start a retry over the live judge or the audio decoder
  if (now - g_pendJudge.lastTryMs < PEND_RETRY_MS) return;
  g_pendJudge.lastTryMs = now;
  g_pendJudge.tries++;
  Serial.printf("[PEND] re-sending the last judge photo to Gemini (try %u)…\n", g_pendJudge.tries);
  setEspState("JUDGING");
  if (geminiSubmitJudgeJob(g_pendJudge.room, g_pendJudge.phase, g_pendJudge.riddle,
                           g_pendJudge.target, g_pendJudge.proof, g_pendJudge.allowPaper,
                           g_pendJudge.imgB64, g_pendJudge.imgW, g_pendJudge.imgH,
                           /*isRetry=*/true)) {
    g_pendJudge.awaitingGemini = true;
  } else {
    Serial.println("[PEND] geminiTask slot busy — will retry submitting next cycle");
    GameMirror m2; copyMirror(m2);
    setEspState((m2.valid && m2.state.length()) ? m2.state.c_str() : "IDLE");
  }
}

// Phase key in seconds, fits uint32. Accepts the legacy epoch-ms contract too
// (values > 1e11 are divided by 1000).
static uint32_t phaseKeyFromJson(double v) {
  if (v <= 0) return 0;
  if (v > 1.0e11) v /= 1000.0;
  return (uint32_t)v;
}

static void pollOnce() {
  String body;
  if (!httpGet(dbUrl("hardware_session"), body)) {
    if (g_linkUp && WiFi.status() != WL_CONNECTED) Serial.println("[DB] link down");
    g_linkUp = (WiFi.status() == WL_CONNECTED);
    return;
  }
  g_linkUp = true;

  if (body == "null" || body.length() < 4) {
    GameMirror empty;
    if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) { g_mirror = empty; xSemaphoreGive(cloudMux); }
    // session gone (host exited / lock released): drop every armed request so the
    // pumps go quiet and the heartbeat stops saying "busy"
    g_rreqId = 0; g_rreqDone = false; g_rreqStage = 0; g_rreqPubTries = 0;
    g_rreqHold = false;
    g_hintPend = false; g_hintStage = 0; g_hintText = ""; setGenTask("");
    g_hintLatchReqId = 0;                 // a session scrub clears the hint latch
    return;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) { Serial.printf("[DB] parse error: %s\n", err.c_str()); return; }

  // game mirror: parse into a local, swap under the lock at the end
  GameMirror m;
  JsonObject hw = doc["hw"].as<JsonObject>();
  if (!hw.isNull()) {
    m.valid = true;
    const char* room = hw["room"] | "";
    m.room = room;
    m.state = (const char*)(hw["state"] | "");
    m.seq = (uint32_t)(hw["seq"] | 0);
    // judge_phase is in seconds. An epoch-ms value overflows, and ArduinoJson's `| 0`
    // then silently returned 0, so the board never judged.
    m.judgePhase = phaseKeyFromJson(hw["judge_phase"] | (double)0);
    m.playerId = (const char*)(hw["player_id"] | "");
    m.player = (const char*)(hw["player"] | "");
    m.round = (int)(hw["round"] | 0);
    m.rounds = (int)(hw["rounds"] | 0);
    m.riddle = (const char*)(hw["riddle"] | "");
    m.target = (const char*)(hw["target"] | "");
    m.difficulty = (const char*)(hw["difficulty"] | "");
    m.theme = (const char*)(hw["theme"] | "");
    m.proof = (const char*)(hw["proof"] | "");
    m.allowPaper = hw["allow_paper"] | false;
    m.countdown = (int)(hw["countdown"] | 0);
    m.special = (const char*)(hw["special"] | "NONE");
    m.timeLimit = (int)(hw["time_limit"] | 0);
    m.timeLeft = (int)(hw["time_left"] | 0);
    m.timerRunning = hw["timer_running"] | false;
    m.paused = hw["paused"] | false;
    m.unclear = hw["unclear"] | false;
    m.lock = String((const char*)(hw["lock"] | ""));   // older hosts never send it
  }

  // explicit judge request {phase (s), riddle, target, proof?, allow_paper?}
  JsonObject jr = doc["judge_request"].as<JsonObject>();
  uint32_t jreqPhase = 0;
  String jreqR, jreqT;
  if (!jr.isNull()) {
    jreqPhase = phaseKeyFromJson(jr["phase"] | (double)0);
    if (jreqPhase) {
      jreqR = (const char*)(jr["riddle"] | "");
      jreqT = (const char*)(jr["target"] | "");
      g_jreqProof = String((const char*)(jr["proof"] | ""));
      g_jreqPaper = jr["allow_paper"] | false;
    }
  }
  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_jreqPhase = jreqPhase;                    // host nulls it -> pending clears
    if (jreqPhase) { g_jreqRiddle = jreqR; g_jreqTarget = jreqT; }
    xSemaphoreGive(cloudMux);
  }

  // riddle_req {req_id, reason, difficulty, environment, proof, themes?, excluded,
  // player_name, publish?}. req_id is epoch ms (parse as double, cast to 64-bit).
  // A new id resets the retry bookkeeping. The same id re-written with a different
  // publish target (hold <-> now) flips g_rreqHold, and a riddle already in hand is
  // served from cache to the new target.
  JsonObject rr = doc["riddle_req"].as<JsonObject>();
  if (!rr.isNull()) {
    uint64_t rid = (uint64_t)(rr["req_id"] | (double)0);
    if (rid != 0 && rid == g_rreqId) {
      bool holdNow = String((const char*)(rr["publish"] | "now")) == "hold";
      if (holdNow != g_rreqHold) {
        g_rreqHold = holdNow;
        Serial.printf("[RIDDLE] host flipped publish → %s (req %llu)\n",
                      holdNow ? "next_riddle" : "current_riddle",
                      (unsigned long long)rid);
        if (g_rreqDone && g_rreqStage == 0 && g_rreqReady.ok) {
          g_rreqStage = 2;           // republish the cached riddle to the new target
          g_rreqPubTries = 0;
        }
      }
    } else if (rid != 0 && rid != g_rreqId) {
      g_rreqId         = rid;
      g_rreqDifficulty = String((const char*)(rr["difficulty"] | ""));
      // The environment anchors the answer; the proof method is rolled by the web.
      // Older hosts send `themes` instead, used as a fallback anchor.
      g_rreqEnvironment = String((const char*)(rr["environment"] | ""));
      g_rreqProof      = String((const char*)(rr["proof"] | ""));
      g_rreqThemes     = String((const char*)(rr["themes"] | ""));
      g_rreqExcluded   = String((const char*)(rr["excluded"] | ""));
      g_rreqPlayer     = String((const char*)(rr["player_name"] | ""));
      g_rreqBonus      = String((const char*)(rr["reason"] | "turn")) == "bonus";
      g_rreqHold       = String((const char*)(rr["publish"] | "now")) == "hold";
      g_rreqDone       = false;
      g_rreqStage      = 1;
      g_rreqPubTries   = 0;
      setGenTask("riddle");
      g_hintLatchReqId = 0;          // a new riddle resets the hint latch
      // Generation is not started here: geminiTask owns gemini_riddle.h's statics and may
      // still be mid-rotation on an older request. tryRiddle() stage 1 submits the job
      // once the slot is free, aborting a stale job first.
      Serial.printf("[RIDDLE] new request %llu (%s, %s%s) for %s\n",
                    (unsigned long long)rid, g_rreqBonus ? "bonus" : "turn",
                    g_rreqDifficulty.c_str(), g_rreqHold ? " · hold" : "",
                    g_rreqPlayer.c_str());
    }
  }

  // hint_req {req_id, player_name}: speak-only. The hint ships inside the riddle
  // payload, so this speaks the current riddle's stored hint, once per riddle.
  JsonObject hq = doc["hint_req"].as<JsonObject>();
  if (!hq.isNull()) {
    uint64_t hid = (uint64_t)(hq["req_id"] | (double)0);
    if (hid != 0 && hid != g_hintReqId) {
      g_hintReqId     = hid;
      g_hintReqPlayer = String((const char*)(hq["player_name"] | ""));
      g_hintText      = "";
      g_hintPend      = false;
      g_hintStage     = 0;
      if (g_hintLatchReqId != 0 && g_hintLatchReqId == g_rreqId) {
        // one hint per riddle: a re-mint or button mash is ignored, loudly
        Serial.printf("[HINT] latch — hint already spoken for riddle %llu (req %llu ignored)\n",
                      (unsigned long long)g_rreqId, (unsigned long long)hid);
      } else if (g_rreqId != 0 && g_rreqReady.ok && g_rreqReady.hint.length()) {
        g_hintLatchReqId = g_rreqId;
        g_hintText       = g_rreqReady.hint;
        g_hintPend       = true;
        g_hintStage      = 1;          // 1 = speak pending, 2 = write-only retries
        Serial.printf("[HINT] speak stored hint of riddle %llu (req %llu) for %s\n",
                      (unsigned long long)g_rreqId, (unsigned long long)hid,
                      g_hintReqPlayer.c_str());
      } else {
        Serial.println("[HINT] no stored hint for the current riddle — request dropped");
      }
    }
  }

  // Voice Master queue: every line has its own slot at hardware_session/cmdq/{id}, so
  // an announce burst written while this task was busy can no longer overwrite itself
  // (the legacy `cmd` slot is newest-wins and lost lines that way).
  // The queue is the source of truth and runs first; the legacy slot only speaks lines
  // that are not in this poll's queue snapshot. Both dedupe on g_lastCmdId64, so a
  // line delivered twice is spoken once. Consumed children are deleted one by one,
  // never the whole node, so a line written mid-poll is never wiped unseen.
  JsonObject cq = doc["cmdq"].as<JsonObject>();
  uint64_t cqSeenIds[8];                   // ids present in this snapshot
  int cqSeenN = 0;
  if (!cq.isNull()) {
    struct QLine { uint64_t id; bool prio; String key; String say; };
    QLine lines[8];
    const char* staleKeys[8];                // malformed / already-spoken slots
    int n = 0, nStale = 0;
    for (JsonPair kv : cq) {
      if (n >= 8 || nStale >= 8) break;      // the rest waits for the next poll
      JsonObject o = kv.value().as<JsonObject>();
      uint64_t id64 = (uint64_t)(o["id"] | (double)0);
      const char* say = o["say"] | "";
      if (id64 == 0 || !say[0]) {            // malformed: cleaned up below
        staleKeys[nStale++] = kv.key().c_str();
        continue;
      }
      lines[n].id   = id64;
      lines[n].prio = ((int)(o["p"] | 0) == 1);
      lines[n].key  = String(kv.key().c_str());
      lines[n].say  = String(say);
      if (cqSeenN < 8) cqSeenIds[cqSeenN++] = id64;
      n++;
    }
    // First sight with no legacy cmd to seed from: same boot-floor rule as below.
    if (!g_cmdSeeded && n > 0) {
      g_cmdSeeded = true;
      if (g_timeSynced && g_bootEpochMs != 0) {
        g_lastCmdId64 = g_bootEpochMs - 1;
        Serial.printf("[VOICE] cmd floor = boot epoch (%llu ms) — queued lines after boot will be spoken\n",
                      (unsigned long long)g_bootEpochMs);
      } else {
        uint64_t maxId = 0;
        for (int i = 0; i < n; ++i) if (lines[i].id > maxId) maxId = lines[i].id;
        g_lastCmdId64 = maxId;               // no clock: swallow what is here
        Serial.println("[VOICE] boot backlog skipped (queue, no synced clock)");
      }
    }
    // RTDB returns numeric keys in ascending order; sort anyway so speech order never
    // depends on transport order.
    for (int i = 1; i < n; ++i) {
      QLine t = lines[i];
      int j = i - 1;
      while (j >= 0 && lines[j].id > t.id) { lines[j + 1] = lines[j]; --j; }
      lines[j + 1] = t;
    }
    int nDelete = 0;                          // at most 6 DELETEs per cycle
    for (int i = 0; i < n; ++i) {
      if (lines[i].id <= g_lastCmdId64) {     // already spoken or below the floor
        if (nStale < 8) staleKeys[nStale++] = lines[i].key.c_str();
        continue;
      }
      // Speak gate: a normal line goes to the audio core only when the speaker is idle;
      // otherwise the DB child stays and is spoken on a later poll. Back-to-back lines used
      // to chop each other mid-word. Priority lines pass (the pump barges them). Break,
      // never skip ahead, because order matters.
      if (!lines[i].prio && ttsSpeaking()) break;
      Serial.printf("[VOICE] queued line (id %llu%s)\n", (unsigned long long)lines[i].id,
                    lines[i].prio ? " · priority" : "");
      ttsRequestSpeak(lines[i].say, lines[i].id, lines[i].prio);
      g_lastCmdId64 = lines[i].id;
      if (nDelete < 6) {
        httpSend("DELETE", dbUrl("hardware_session/cmdq/" + lines[i].key), "");
        nDelete++;
      }
    }
    for (int i = 0; i < nStale && nDelete < 6; ++i, ++nDelete)
      httpSend("DELETE", dbUrl(String("hardware_session/cmdq/") + staleKeys[i]), "");
  }

  // Legacy `cmd` slot (newest wins), fallback only: a line whose id is in this poll's
  // cmdq snapshot belongs to the queue. Speaking the newest legacy twin first used to
  // push the floor past older queued lines.
  JsonObject cmd = doc["cmd"].as<JsonObject>();
  if (!cmd.isNull()) {
    // ids are epoch ms from the host: always compare in 64-bit
    uint64_t id64 = (uint64_t)(cmd["id"] | (double)0);
    bool queueTwin = false;
    for (int i = 0; i < cqSeenN; ++i) {
      if (cqSeenIds[i] == id64) { queueTwin = true; break; }
    }
    if (!g_cmdSeeded) {
      g_cmdSeeded = true;
      // Boot-clock floor: anything written after boot is ours to speak, even on the first
      // poll. Without a synced clock old and new cannot be told apart, so the first line
      // seen is swallowed.
      if (g_timeSynced && g_bootEpochMs != 0) {
        g_lastCmdId64 = g_bootEpochMs - 1;    // everything newer is speakable
        Serial.printf("[VOICE] cmd floor = boot epoch (%llu ms) — lines written after boot will be spoken\n",
                      (unsigned long long)g_bootEpochMs);
      } else {
        g_lastCmdId64 = id64;
        if (id64) Serial.printf("[VOICE] boot backlog skipped (id %llu)\n", (unsigned long long)id64);
      }
    }
    if (id64 > g_lastCmdId64 && !queueTwin) {
      const char* say = cmd["say"] | "";
      // "p":1 = priority (time-up, game-over): barges current speech and the offline queue
      bool prio = ((int)(cmd["p"] | 0) == 1);
      if (say[0]) {
        // Same speak gate as the queue. The floor is not advanced on defer, so the next poll
        // (or the cmdq twin) still speaks it; advancing it used to drop the line.
        if (prio || !ttsSpeaking()) {
          Serial.printf("[VOICE] new cloud line (id %llu%s)\n", (unsigned long long)id64,
                        prio ? " · priority" : "");
          ttsRequestSpeak(String(say), id64, prio);
          g_lastCmdId64 = id64;
        }
        // deferred: floor untouched, retried next poll
      } else {
        g_lastCmdId64 = id64;      // empty line: just mark it seen
      }
    }
  }

  // camera + voice settings, applied only when changed
  JsonObject es = doc["esp_settings"].as<JsonObject>();
  if (!es.isNull()) {
    String raw;
    serializeJson(es, raw);
    if (raw != g_lastEspSettingsRaw) {
      Serial.println("[SET] esp_settings changed → applying");
      g_lastEspSettingsRaw = raw;
      JsonDocument v;
      if (!deserializeJson(v, raw)) {
        applyCameraRegsFromJson(v);            // camera regs are safe on Core 0
        setVoicePendProfile((const char*)(v["voice"] | ""));
        g_voicePendSpeed   = (float)(v["speed"] | 1.0);
        g_voicePendVol     = (int)(v["volume"] | -1);
        g_voicePend        = true;             // voice settings go to Core 1
        // "Force Fallback Models" rides the same node
        const bool ff = v["force_fallback"] | false;
        if (ff != g_forceFallback) {
          g_forceFallback = ff;
          Serial.printf("[SET] force_fallback = %s — the wheel %s\n",
                        ff ? "ON" : "OFF",
                        ff ? "skips every Gemini model" : "uses the full chain again");
        }
      }
    }
  }

  if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_mirror = m;
    xSemaphoreGive(cloudMux);
  }
}

static void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  // log why the radio dropped, so a field report can tell router trouble from firmware
  static bool eventHooked = false;
  if (!eventHooked) {
    eventHooked = true;
    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
      if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
        Serial.printf("[WiFi] DISCONNECTED — reason=%d\n",
                      info.wifi_sta_disconnected.reason);
      }
    });
  }
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
}

// Radio recovery. The SDK's auto-reconnect alone once left the board offline for
// minutes until a manual reboot, so while the link is down re-issue WiFi.begin every
// 15 s (non-blocking; the pumps' WiFi guards keep skipping meanwhile).
static uint32_t g_lastWifiTryMs = 0;
static void wifiRecoveryPump() {
  if (WiFi.status() == WL_CONNECTED) return;
  uint32_t now = millis();
  if (g_lastWifiTryMs != 0 && now - g_lastWifiTryMs < 15000) return;
  g_lastWifiTryMs = now;
  Serial.println("[WiFi] down — re-issuing connect (15 s cadence)");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// Judge pump. netTask spends one cycle on capture + hand-off, polls geminiTask for
// GEM_DONE (free per cycle however long the rotation takes), then one cycle to write
// the verdict. Doing all attempts inline once froze polls, heartbeats and voice lines
// for up to ~73 s.
// Capture at QVGA: SVGA base64 (~110 KB) cannot sit in RAM next to the TLS stack and
// JSON body, while QVGA (~20 KB) judges just as well and answers 3-4x faster.
static PsStr    g_jImg;        // the captured frame (QVGA base64, PSRAM)
static int      g_jImgW    = 0, g_jImgH = 0;
static String   g_jRoom    = "";
static String   g_jRiddle  = "", g_jTarget = "", g_jProof = "";
static bool     g_jPaper   = false;
static uint32_t g_jPhase   = 0;
static uint8_t  g_jStage   = 0;       // 0 idle, 1 waiting on geminiTask, 2 write pending
static JudgeOutcome g_jOutcome;      // verdict in hand (stage 2)

static void judgeResetIdle() {
  g_jStage = 0;
  g_jImg.clear();                    // free the frame
  // the outcome can carry the parked frame (~6.6 KB) on the exhaustion path
  g_jOutcome = JudgeOutcome();
  setGenTask("");                    // pumps re-assert their own task if armed
  GameMirror m; copyMirror(m);
  setEspState((m.valid && m.state.length()) ? m.state.c_str() : "IDLE");
}

static void tryJudge() {
  // stage 2: verdict in hand, write it on this fresh cycle
  if (g_jStage == 2) {
    // No "speaker quiet" gate before the write: it only protected handshake heap, and
    // mbedTLS lives in PSRAM now. The web's verdict line still queues behind "Photo
    // captured" on the speaker.
    if (g_jOutcome.ok) {
      if (writeJudgeResult(g_jRoom, g_jPhase, g_jOutcome)) {
        Serial.printf("[JUDGE] verdict written (passed=%d unclear=%d)\n",
                      g_jOutcome.passed, g_jOutcome.unclear);
        g_judgeCount++;
      } else {
        savePendingResult(g_jRoom, g_jPhase, g_jOutcome);   // delivered later
      }
    } else {
      savePendingImage(g_jRoom, g_jPhase, g_jRiddle, g_jTarget, g_jOutcome);  // the photo is re-sent later
    }
    // "Photo captured" is spoken at the shutter (stage 0). Speaking it after the verdict
    // made the room hear it after the result.
    g_lastJudgeDone = g_jPhase;      // never judge the same phase twice
    judgeResetIdle();
    return;
  }

  // stage 1: submitted to geminiTask; poll for GEM_DONE. Attempts, pacing, floors and
  // cooldowns all live inside judgeImageB64(), so waiting costs netTask nothing.
  if (g_jStage == 1) {
    setGenTask("judge");     // re-assert every cycle; the wait can span many
    GemSlotState st = geminiJudgeState();
    if (st == GEM_IDLE) {
      // Should not happen (only this code takes a non-retry result), but never wait
      // forever for a DONE that will not arrive.
      Serial.println("[JUDGE] slot unexpectedly idle — resetting");
      judgeResetIdle();
      return;
    }
    if (st != GEM_DONE) return;          // still working; netTask stays free meanwhile
    if (geminiJudgeIsRetry()) return;    // that DONE is pendingPump's retry, not ours
    JudgeOutcome o; String room, riddle, target; uint32_t phase;
    if (!geminiTakeJudgeResult(o, room, phase, riddle, target)) return;
    // The wait can span many seconds, so re-check against a fresh mirror before writing a
    // verdict for a phase the host may have abandoned.
    GameMirror m; copyMirror(m);
    if (phase != g_jPhase ||
        (m.valid && m.room.length() && room.length() && m.room != room)) {
      Serial.printf("[JUDGE] result for phase %u discarded (superseded)\n", (unsigned)phase);
      judgeResetIdle();
      return;
    }
    g_jOutcome = o;
    g_jStage   = 2;                      // write on the next fresh cycle
    return;
  }

  // stage 0: idle, look for a fresh judge trigger
  GameMirror m; copyMirror(m);
  uint32_t phase = 0;
  String room, riddle, target, proof;
  bool paper = false;

  // Path A: mirror trigger, EVALUATING + a fresh judge_phase
  if (m.valid && m.room.length() && m.state == "EVALUATING" &&
      m.judgePhase != 0 && m.judgePhase != g_lastJudgeDone &&
      !m.riddle.isEmpty() && !m.target.isEmpty()) {
    phase = m.judgePhase; room = m.room; riddle = m.riddle; target = m.target;
    proof = m.proof; paper = m.allowPaper;
  }

  // Path B: explicit judge_request (survives mirror races and retries)
  if (!phase) {
    uint32_t jreq = 0;
    String jr, jt, jproof;
    bool jpaper = false;
    if (xSemaphoreTake(cloudMux, pdMS_TO_TICKS(250)) == pdTRUE) {
      jreq = g_jreqPhase; jr = g_jreqRiddle; jt = g_jreqTarget;
      jproof = g_jreqProof; jpaper = g_jreqPaper;
      xSemaphoreGive(cloudMux);
    }
    if (jreq != 0 && jreq != g_lastJudgeDone && m.valid && m.room.length() &&
        !jr.isEmpty() && !jt.isEmpty()) {
      // the mirror can carry the paper flag too (a pivot between writes)
      phase = jreq; room = m.room; riddle = jr; target = jt;
      proof = jproof.length() ? jproof : m.proof;
      paper = jpaper || m.allowPaper;
    }
  }
  if (!phase) return;

  // Below the floor the capture is skipped: leave the phase pending and retry next
  // poll. blockFloor is 0 because the capture itself needs no contiguous TLS block.
  if (!gemFloorOk("JUDGE", JUDGE_MIN_FREE_HEAP, 0)) return;

  Serial.printf("[JUDGE] phase %u — capturing “%s”%s%s (handing off to the dedicated geminiTask)\n",
                (unsigned)phase, target.c_str(),
                proof.length() ? " · " : "", proof.c_str());
  setEspState("JUDGING");
  setGenTask("judge");
  clearPendingJudge("new judge started");   // newest attempt wins, RAM freed first
  // Judge ack: one heartbeat with state=JUDGING + gen=judge keeps the host watchdog
  // patient.
  writeEspHeartbeat(getEspState(), getGenTask().c_str());
  // netTask's Firebase session is not dropped before the capture: nothing on netTask
  // needs the room any more, and tearing it down every cycle would add socket churn.

  // Switch to QVGA just for the capture and restore at once, so the MJPEG stream does
  // not lag through the judging phase.
  sensor_t* s = esp_camera_sensor_get();
  framesize_t prev = s ? s->status.framesize : FRAMESIZE_SVGA;
  if (s) { s->set_framesize(s, FRAMESIZE_QVGA); delay(80); }
  g_jImg = captureB64(&g_jImgW, &g_jImgH);
  if (s) s->set_framesize(s, prev);

  g_jRoom = room; g_jRiddle = riddle; g_jTarget = target;
  g_jProof = proof; g_jPaper = paper; g_jPhase = phase;

  if (!g_jImg.length()) {
    Serial.println("[JUDGE] capture failed — the host watchdog covers; phase marked done");
    g_lastJudgeDone = phase;
    judgeResetIdle();
    return;
  }
  // The slot should be idle here (stage 0 only follows judgeResetIdle()), but stay
  // defensive.
  if (!geminiSubmitJudgeJob(g_jRoom, g_jPhase, g_jRiddle, g_jTarget, g_jProof, g_jPaper,
                            g_jImg, g_jImgW, g_jImgH, /*isRetry=*/false)) {
    Serial.println("[JUDGE] geminiTask slot unexpectedly busy — retrying next cycle");
    return;                            // phase stays pending, g_jStage stays 0
  }
  g_jImg.clear();                      // the slot now holds its own PSRAM copy
  g_jStage = 1;
  // Capture confirmation at the shutter. The web shows the caption and does not write
  // a duplicate line when the board speaks it.
  ttsRequestSpeak("Photo captured! Let's see if you got it right...", epochMs());
}

// Riddle and hint pumps.
// The host writes riddle_req; the board generates and publishes current_riddle (or
// next_riddle for a prefetch). There is no fallback riddle: generation retries forever
// and the game waits. Both pumps only submit to geminiTask and poll, so polls,
// heartbeats, button writes and voice lines keep flowing while the board thinks.
static void tryRiddle() {
  if (g_rreqId == 0 || g_rreqDone) {
    if (getGenTask() == "riddle") setGenTask("");
    return;
  }
  setGenTask("riddle");                // re-assert: the heartbeat says "thinking"
  if (WiFi.status() != WL_CONNECTED) return;

  // stage 2: riddle in hand, publish on this fresh cycle. pollOnce already ran, so a
  // replaced request has reset the stage. The target follows g_rreqHold.
  if (g_rreqStage == 2) {
    GameMirror m; copyMirror(m);
    if (!m.valid || m.room.isEmpty()) return;      // wait for a live room
    g_rreqPubTries++;
    if (writeCurrentRiddle(m.room, g_rreqId, g_rreqReady, g_rreqHold)) {
      g_rreqDone    = true;            // keep g_rreqId; the host matches on it
      g_rreqStage   = 0;
      setGenTask("");
      Serial.printf("[RIDDLE] published (req %llu) → rooms/%s/%s "
                    "(%d s, %s, answer=\"%s\")\n",
                    (unsigned long long)g_rreqId, m.room.c_str(),
                    g_rreqHold ? "next_riddle" : "current_riddle",
                    g_rreqReady.timeLimitSec, g_rreqReady.difficulty.c_str(),
                    g_rreqReady.answer.c_str());
    } else if (g_rreqPubTries >= 6) {
      // the write keeps failing: regenerate rather than hold stale text forever
      Serial.println("[RIDDLE] publish write failed 6× — regenerating");
      g_rreqStage       = 1;
      g_rreqPubTries    = 0;
      g_rreqSubmittedId = 0;   // forces stage 1 to resubmit
    } else {
      Serial.println("[RIDDLE] publish write failed — retrying next cycle");
    }
    return;
  }

  // stage 1: ask geminiTask for a riddle. The judge keeps priority.
  if (getEspState() == "JUDGING") return;

  GemSlotState st = geminiRiddleState();

  if (st == GEM_DONE) {
    GeneratedRiddle r; uint64_t doneId = 0;
    bool got = geminiTakeRiddleResult(r, doneId);
    if (got && doneId == g_rreqId && r.ok) {
      g_rreqReady    = r;               // publish next cycle, after a fresh mirror + request check
      g_rreqStage    = 2;
      g_rreqPubTries = 0;
      Serial.printf("[RIDDLE] generated (req %llu): %d s, %s, answer=\"%s\" — publishing\n",
                    (unsigned long long)g_rreqId, r.timeLimitSec,
                    r.difficulty.c_str(), r.answer.c_str());
      return;
    }
    if (got) {
      // stale (the host moved on) or an aborted/empty result; the slot is free, so fall
      // through and resubmit
      Serial.printf("[RIDDLE] result for req %llu discarded (current req %llu)\n",
                    (unsigned long long)doneId, (unsigned long long)g_rreqId);
    }
    st = GEM_IDLE;
  }

  if (st == GEM_PENDING || st == GEM_RUNNING) {
    // Still working. If it is a request the host has moved past, ask it to abort between
    // attempts (cooperative, never mid-POST).
    if (g_rreqSubmittedId != g_rreqId) geminiRequestRiddleAbort();
    return;
  }

  // slot idle: submit for the request we currently want
  GameMirror m; copyMirror(m);
  if (!m.valid || m.room.isEmpty()) return;   // only serve a live room; retry next cycle

  Serial.printf("[RIDDLE] generating (req %llu, %s%s)…\n",
                (unsigned long long)g_rreqId, g_rreqDifficulty.c_str(),
                g_rreqBonus ? " · bonus" : "");
  setEspState("GENERATING");
  if (geminiSubmitRiddleJob(g_rreqId, g_rreqDifficulty, g_rreqEnvironment, g_rreqThemes,
                            g_rreqProof, g_rreqExcluded, g_rreqBonus)) {
    g_rreqSubmittedId = g_rreqId;
  }

  GameMirror m2; copyMirror(m2);
  setEspState((m2.valid && m2.state.length()) ? m2.state.c_str() : "IDLE");
}

// The host writes hint_req. The hint already came with the riddle, so this pump only
// speaks and records it; the latch keeps it to one hint per riddle, across retakes.
// The tts_done echo carries the hint_req id, so the web's hint pause ends exactly
// when the room heard it.
// Stages: 1 = speak pending (waits for an idle speaker), 2 = write-only retries
// (never re-speaks, which used to cause double hints).
static void tryHint() {
  if (!g_hintPend) return;
  if (g_hintStage == 1) {
    if (ttsSpeaking()) return;
    String line = g_hintReqPlayer.length()
      ? String("Hint for ") + g_hintReqPlayer + ": " + g_hintText
      : String("Hint: ") + g_hintText;
    Serial.printf("[HINT] speaking the stored hint for %s\n", g_hintReqPlayer.c_str());
    ttsRequestSpeak(line, g_hintReqId);
    g_hintStage = 2;
    return;
  }
  if (g_hintStage != 2) { g_hintPend = false; return; }
  // stage 2: only the DB write remains; retry until it lands
  GameMirror mw; copyMirror(mw);
  if (mw.valid && mw.room.length() &&
      writeRoomHint(mw.room, g_hintReqId, g_hintReqPlayer, g_hintText)) {
    g_hintPend  = false;
    g_hintStage = 0;
    g_hintText  = "";
    Serial.printf("[HINT] spoken+written (req %llu) for %s\n",
                  (unsigned long long)g_hintReqId, g_hintReqPlayer.c_str());
  } else {
    Serial.println("[HINT] hint write failed — the spoken hint stands, the write will retry");
  }
}

static uint32_t g_lastBeatMs = 0;

static void netTaskOnce(uint32_t& pollDelay) {
  GameMirror m; copyMirror(m);
  // fast poll while the board matters (live turn, judging, retake window)
  bool live = m.valid && m.room.length() && m.state.length() &&
              m.state != "LOBBY" && m.state != "GAME_OVER";

  // The queued boot heartbeat goes out here, on Core 0, and retries each cycle until
  // the link is up. Radio recovery runs before anything else.
  if (g_bootBeatPending && WiFi.status() == WL_CONNECTED) {
    if (writeEspHeartbeat("BOOT")) {
      g_bootBeatPending = false;
      Serial.println("[DB] BOOT heartbeat sent");
    }
  }
  wifiRecoveryPump();

  pollOnce();

  // Boot line, decided after the first poll: a mid-game reboot (watchdog, brown-out)
  // must not announce "hardware online" over the round. With no poll within
  // BOOT_LINE_MAX_WAIT_MS it is spoken anyway, since it still proves the relay path.
  // id 0 is never echoed, so it cannot release a web speech gate.
  if (g_bootLinePending) {
    static uint32_t s_bootLineArmMs = 0;
    if (!s_bootLineArmMs) s_bootLineArmMs = millis();
    const bool polled = g_linkUp;
    if (polled || millis() - s_bootLineArmMs > BOOT_LINE_MAX_WAIT_MS) {
      g_bootLinePending = false;
      GameMirror bm; copyMirror(bm);
      const bool live = polled && bm.valid && bm.room.length() && bm.state.length() &&
                        bm.state != "LOBBY" && bm.state != "GAME_OVER";
      if (live) {
        Serial.printf("[SYS] boot line skipped — game in progress (room %s, %s)\n",
                      bm.room.c_str(), bm.state.c_str());
      } else {
        ttsRequestSpeak("SnapRiddle hardware online. Ready to play.", 0);
      }
    }
  }

  // button writes queued by Core 1
  if (g_reqCapture) { g_reqCapture = false; if (writeCaptureRequest()) Serial.println("[BTN] capture_request written"); }
  if (g_reqHint)    { g_reqHint = false;    if (writeHintRequest())    Serial.println("[BTN] hint_request written"); }

  tryJudge();

  tryRiddle();

  tryHint();

  // re-send whatever the network ate
  pendingPump();

  // Speech echoes. Start goes first, so a short line that starts and ends within one
  // cycle still reaches the web in order.
  uint64_t startId = ttsLastStartId();
  if (startId != 0 && startId > g_ttsStartWritten) {
    if (writeTtsStart(startId)) {
      g_ttsStartWritten = startId;
      Serial.printf("[VOICE] tts_start echoed (id %llu)\n", (unsigned long long)startId);
    }
  }
  uint64_t doneId = ttsLastDoneId();
  if (doneId != 0 && doneId > g_ttsDoneWritten) {
    if (writeTtsDone(doneId)) {
      g_ttsDoneWritten = doneId;
      Serial.printf("[VOICE] tts_done echoed (id %llu)\n", (unsigned long long)doneId);
    }
  }

  // heartbeat; gen keeps a busy board "alive but thinking" on the web
  if (millis() - g_lastBeatMs > ESP_BEAT_MS) {
    g_lastBeatMs = millis();
    writeEspHeartbeat(getEspState(), getGenTask().c_str());
  }

  // While geminiTask has an LLM socket open, poll at the slow cadence even in a live
  // turn. The Firebase session stays warm (not torn down every cycle) but is touched
  // less often during the window two TLS sessions coexist.
  pollDelay = (live && !geminiBusy()) ? POLL_FAST_MS : POLL_IDLE_MS;
}

static void netTask(void* arg) {
  uint32_t pollDelay = POLL_IDLE_MS;
  for (;;) {
    checkTimeSynced();
    netTaskOnce(pollDelay);
    vTaskDelay(pdMS_TO_TICKS(pollDelay));
  }
}

static void startNetTask() {
  xTaskCreatePinnedToCore(
    netTask,
    "sr_net",
    24576,            // TLS + JSON need headroom
    nullptr,
    2,                // above idle, below the WiFi task
    nullptr,
    0                 // Core 0: network side
  );
  Serial.println("[NET] cloud link task pinned to Core 0");
}
