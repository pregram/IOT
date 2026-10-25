// Dedicated FreeRTOS task for every Gemini/Groq/OpenRouter call.
//
// netTask used to make these calls itself. Each attempt blocks for up to
// GEMINI_TIMEOUT_MS, and meanwhile netTask cannot poll Firebase for queued voice
// lines, so a line the host just wrote could sit unspoken for 3-10+ s. With the
// calls on their own task, netTask is never blocked by a rotation.
//
// The cost: a Firebase TLS session and an LLM TLS session can now be open at the
// same time, on a chip that has repeatedly run out of RAM for exactly that. The
// mitigations are netTaskOnce() throttling its own poll cadence while geminiBusy()
// (instead of rebuilding its Firebase socket every cycle) and the higher heap floors
// in parameters.h.
//
// Design: two polled slots (judge, riddle), not a generic queue. netTask fills a
// slot, this task runs the full blocking rotation and leaves the result for netTask
// to collect. The judge slot is always checked first, which keeps the old
// judge-before-riddle priority and guarantees exactly one caller inside the shared
// statics of gemini_rotation.h / gemini_judge.h / gemini_riddle.h.
// The slot is the only border: netTask never touches the generator buffers, and this
// task never touches cloudMux-guarded netTask state.
// The judge slot serves both the live judge (tryJudge) and the retry pump
// (pendingPump); `isRetry` says whose job it is, and each caller peeks it before
// taking a DONE result so neither steals the other's.
//
// geminiMux guards both slots. Keep critical sections to a few copies and never hold
// it across a network call.
#pragma once
#include <Arduino.h>
#include "parameters.h"
#include "freertos/idf_additions.h"   // xTaskCreatePinnedToCoreWithCaps
#include "gemini_judge.h"
#include "gemini_riddle.h"

enum GemSlotState { GEM_IDLE, GEM_PENDING, GEM_RUNNING, GEM_DONE };

static SemaphoreHandle_t geminiMux = nullptr;

static void geminiTaskInit() {
  if (!geminiMux) geminiMux = xSemaphoreCreateMutex();
}

struct GemJudgeSlot {
  GemSlotState state = GEM_IDLE;
  // Request fields: written by netTask before state flips to GEM_PENDING, then owned
  // by this task until geminiTakeJudgeResult() resets the slot.
  String   room, riddle, target, proof;
  bool     paper = false;
  uint32_t phase = 0;
  PsStr    img;
  int      imgW = 0, imgH = 0;
  bool     isRetry = false;        // true = pendingPump's backup resend
  volatile bool abortRequested = false;
  // written by this task when state flips to GEM_DONE
  JudgeOutcome outcome;
};
static GemJudgeSlot g_judgeSlot;

// Returns false and leaves the slot alone if it is busy: overwriting a running job
// would race the task mid-rotation.
static bool geminiSubmitJudgeJob(const String& room, uint32_t phase,
                                 const String& riddle, const String& target,
                                 const String& proof, bool paper,
                                 const PsStr& img, int imgW, int imgH,
                                 bool isRetry) {
  if (!geminiMux) geminiTaskInit();
  bool ok = false;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    if (g_judgeSlot.state == GEM_IDLE) {
      g_judgeSlot.room = room; g_judgeSlot.phase = phase;
      g_judgeSlot.riddle = riddle; g_judgeSlot.target = target;
      g_judgeSlot.proof = proof; g_judgeSlot.paper = paper;
      g_judgeSlot.img = img; g_judgeSlot.imgW = imgW; g_judgeSlot.imgH = imgH;
      g_judgeSlot.isRetry = isRetry;
      g_judgeSlot.abortRequested = false;
      g_judgeSlot.state = GEM_PENDING;
      ok = true;
    }
    xSemaphoreGive(geminiMux);
  }
  return ok;
}

static GemSlotState geminiJudgeState() {
  GemSlotState s = GEM_IDLE;
  if (!geminiMux) return s;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    s = g_judgeSlot.state;
    xSemaphoreGive(geminiMux);
  }
  return s;
}

// Non-destructive peek, so tryJudge() and pendingPump() can check that a DONE result
// is theirs before consuming it.
static bool geminiJudgeIsRetry() {
  bool r = false;
  if (!geminiMux) return r;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    r = g_judgeSlot.isRetry;
    xSemaphoreGive(geminiMux);
  }
  return r;
}

// Call only when the state is GEM_DONE and geminiJudgeIsRetry() matches the caller.
// Returns false if the slot was not DONE.
static bool geminiTakeJudgeResult(JudgeOutcome& out, String& room, uint32_t& phase,
                                  String& riddle, String& target) {
  bool ok = false;
  if (!geminiMux) return ok;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    if (g_judgeSlot.state == GEM_DONE) {
      out = g_judgeSlot.outcome;
      room = g_judgeSlot.room; phase = g_judgeSlot.phase;
      riddle = g_judgeSlot.riddle; target = g_judgeSlot.target;
      g_judgeSlot = GemJudgeSlot();     // resets to GEM_IDLE and frees the PSRAM frame
      ok = true;
    }
    xSemaphoreGive(geminiMux);
  }
  return ok;
}

// Ask a job to stop between attempts (phase superseded, room changed, match over).
// The state is left alone; the task still moves the job to DONE when it notices.
static void geminiRequestJudgeAbort() {
  if (!geminiMux) return;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_judgeSlot.abortRequested = true;
    xSemaphoreGive(geminiMux);
  }
}

struct GemRiddleSlot {
  GemSlotState state = GEM_IDLE;
  uint64_t reqId = 0;
  String   difficulty, environment, themesCsv, proof, excludedCsv;
  bool     bonus = false;
  volatile bool abortRequested = false;
  GeneratedRiddle result;
};
static GemRiddleSlot g_riddleSlot;

static bool geminiSubmitRiddleJob(uint64_t reqId, const String& difficulty,
                                  const String& environment, const String& themesCsv,
                                  const String& proof, const String& excludedCsv,
                                  bool bonus) {
  if (!geminiMux) geminiTaskInit();
  bool ok = false;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    if (g_riddleSlot.state == GEM_IDLE) {
      g_riddleSlot.reqId = reqId; g_riddleSlot.difficulty = difficulty;
      g_riddleSlot.environment = environment; g_riddleSlot.themesCsv = themesCsv;
      g_riddleSlot.proof = proof; g_riddleSlot.excludedCsv = excludedCsv;
      g_riddleSlot.bonus = bonus;
      g_riddleSlot.abortRequested = false;
      g_riddleSlot.state = GEM_PENDING;
      ok = true;
    }
    xSemaphoreGive(geminiMux);
  }
  return ok;
}

static GemSlotState geminiRiddleState() {
  GemSlotState s = GEM_IDLE;
  if (!geminiMux) return s;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    s = g_riddleSlot.state;
    xSemaphoreGive(geminiMux);
  }
  return s;
}

static bool geminiTakeRiddleResult(GeneratedRiddle& out, uint64_t& reqId) {
  bool ok = false;
  if (!geminiMux) return ok;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    if (g_riddleSlot.state == GEM_DONE) {
      out = g_riddleSlot.result;
      reqId = g_riddleSlot.reqId;
      g_riddleSlot = GemRiddleSlot();
      ok = true;
    }
    xSemaphoreGive(geminiMux);
  }
  return ok;
}

static void geminiRequestRiddleAbort() {
  if (!geminiMux) return;
  if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
    g_riddleSlot.abortRequested = true;
    xSemaphoreGive(geminiMux);
  }
}

// netTaskOnce() throttles its poll cadence while this is true, to keep the Firebase
// socket's footprint small while an LLM socket is open.
static bool geminiBusy() {
  GemSlotState j = geminiJudgeState();
  if (j == GEM_PENDING || j == GEM_RUNNING) return true;
  GemSlotState r = geminiRiddleState();
  return r == GEM_PENDING || r == GEM_RUNNING;
}

static void geminiTaskLoop(void* arg) {
  for (;;) {
    // Judge first: same priority as before, and it keeps a single caller inside
    // gemini_rotation.h.
    if (geminiJudgeState() == GEM_PENDING) {
      // room/phase stay in the slot for geminiTakeJudgeResult(); copy only what
      // judgeImageB64() needs.
      String riddle, target, proof; bool paper = false;
      PsStr img; int imgW = 0, imgH = 0;
      if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
        g_judgeSlot.state = GEM_RUNNING;
        riddle = g_judgeSlot.riddle; target = g_judgeSlot.target;
        proof = g_judgeSlot.proof; paper = g_judgeSlot.paper;
        img = g_judgeSlot.img; imgW = g_judgeSlot.imgW; imgH = g_judgeSlot.imgH;
        xSemaphoreGive(geminiMux);
      }
      // Heap numbers right before reaching for a socket, so a field log shows whether
      // the two-task model changed socket pressure.
      Serial.printf("[GEM] judge rotation starting [free=%u maxAlloc=%u localRefusalCooling=%d]\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap(),
                    (int)gemLocalRefusalCooling());
      // The blocking call runs outside the mutex. judgeImageB64 reads abortRequested
      // (a single volatile bool) between attempts.
      JudgeOutcome outcome = judgeImageB64(img, imgW, imgH, riddle, target,
                                           proof, paper, &g_judgeSlot.abortRequested);
      if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
        g_judgeSlot.outcome = outcome;
        g_judgeSlot.state = GEM_DONE;
        xSemaphoreGive(geminiMux);
      }
      continue;   // re-check the judge slot before looking at the riddle slot
    }

    if (geminiRiddleState() == GEM_PENDING) {
      String difficulty, environment, themesCsv, proof, excludedCsv;
      bool bonus = false;
      if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
        g_riddleSlot.state = GEM_RUNNING;
        difficulty = g_riddleSlot.difficulty;
        environment = g_riddleSlot.environment; themesCsv = g_riddleSlot.themesCsv;
        proof = g_riddleSlot.proof; excludedCsv = g_riddleSlot.excludedCsv;
        bonus = g_riddleSlot.bonus;
        xSemaphoreGive(geminiMux);
      }
      Serial.printf("[GEM] riddle rotation starting [free=%u maxAlloc=%u localRefusalCooling=%d]\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap(),
                    (int)gemLocalRefusalCooling());
      GeneratedRiddle result;
      riddleGenBlocking(difficulty, environment, themesCsv, proof, excludedCsv, bonus,
                        &g_riddleSlot.abortRequested, result);
      if (xSemaphoreTake(geminiMux, pdMS_TO_TICKS(250)) == pdTRUE) {
        g_riddleSlot.result = result;
        g_riddleSlot.state = GEM_DONE;
        xSemaphoreGive(geminiMux);
      }
      continue;
    }

    vTaskDelay(pdMS_TO_TICKS(80));
  }
}

// The 24 KB stack lives in PSRAM, because internal RAM is what a TLS handshake needs.
// A PSRAM-stack task must never write flash (NVS, Preferences, LittleFS, OTA):
// flash writes disable the cache PSRAM is accessed through. Nothing on this task's
// call graph does today; route any future flash write through netTask.
// Falls back to an internal stack if PSRAM is out.
static constexpr uint32_t GEMINI_TASK_STACK = 24576;   // same as netTask; JSON docs and strings are heap/PSRAM-backed

static void startGeminiTask() {
  geminiTaskInit();
  // Priority 1, below netTask's 2, so netTask's short latency-sensitive work wins.
  // Core 0, because Core 1 runs I2S audio decode and starves badly under allocation
  // pressure.
  BaseType_t ok = xTaskCreatePinnedToCoreWithCaps(
    geminiTaskLoop, "sr_gemini", GEMINI_TASK_STACK, nullptr, 1, nullptr, 0,
    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (ok == pdPASS) {
    Serial.println("[GEM] dedicated Gemini/LLM task pinned to Core 0 (stack in PSRAM)");
    return;
  }
  xTaskCreatePinnedToCore(geminiTaskLoop, "sr_gemini", GEMINI_TASK_STACK,
                          nullptr, 1, nullptr, 0);
  Serial.println("[GEM] dedicated Gemini/LLM task pinned to Core 0 (stack in INTERNAL RAM — PSRAM stack failed)");
}
