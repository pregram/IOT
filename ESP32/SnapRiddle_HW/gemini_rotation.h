// One failure-aware attempt wheel, shared by the judge (gemini_judge.h) and the
// text generators (gemini_riddle.h).
//
// Gemini fails in two very different ways: a 503 is refused in 1-2 s and is cheap
// to rotate past, while a hang (connection accepted, nothing sent) only ends at
// GEMINI_TIMEOUT_MS. A blind wheel could revisit a model that answered 503 seconds
// earlier; this one remembers through cooldowns.
//
// Order: the model changes on every failed attempt, the key only after every model
// had a try. One pass = key #1's Gemini models, then Groq, then OpenRouter, then
// key #2's pass. "Force Fallback Models" skips every Gemini slot.
// Only Gemini cooldowns steer the wheel. Fallbacks always run in fixed priority
// order per request (Groq first, OpenRouter last), so a request never stalls even
// when every Gemini slot is cooling. A success clears the slot's cooldowns.
//
// Threading: only geminiTask calls this, one request at a time, so plain statics
// are safe. Judge and text share the cooldown state on purpose: a model that just
// returned 503 to the riddle is not worth the judge's first attempt either.
#pragma once
#include <Arduino.h>
#include "parameters.h"
#include "shared_state.h"     // g_forceFallback
#include "tls_psram.h"        // g_tlsInPsram + attempt-floor accessors

// until-millis stamps, 0 = healthy
static uint32_t g_keyCoolUntil[GEMINI_KEY_SLOTS]     = {0};
static uint32_t g_modelCoolUntil[GEMINI_MODEL_SLOTS] = {0};
// Fallback cooldowns, indexed by model slot:
// Groq [0]=gpt-oss-120b [1]=gpt-oss-20b [2]=qwen vision;
// OpenRouter [0]=nemotron text [1]=nemotron-vl vision.
static uint32_t g_groqCoolUntil[3] = {0};
static uint32_t g_orCoolUntil[2]   = {0};

struct ChainSlot {
  int provider;   // 0 = Gemini, 1 = Groq, 2 = OpenRouter (matches LLM_* in llm_provider.h)
  int key;        // Gemini key index, -1 for fallbacks
  int model;      // Gemini model index, or fallback model slot
};

static inline bool gemPairHealthy(int k, int m) {
  return millis() >= g_keyCoolUntil[k] && millis() >= g_modelCoolUntil[m];
}

// slots per key segment: the key's Gemini models + the fallback tail
// (text: Groq 120b, Groq 20b, OpenRouter; vision: Groq qwen, OpenRouter)
static inline int chainSlotsPerKey(int nModels, bool vision) {
  return nModels + (vision ? 2 : (N_GROQ_TEXT_MODELS + 1));
}

static inline void chainResolve(int nModels, bool vision, int p, ChainSlot& out) {
  const int perKey = chainSlotsPerKey(nModels, vision);
  const int k = p / perKey;
  const int sub = p % perKey;
  if (sub < nModels) {
    out.provider = 0; out.key = k; out.model = sub;
  } else if (vision) {
    out.key = -1;
    out.provider = (sub == nModels) ? 1 : 2;
    out.model = (sub == nModels) ? 2 : 0;   // Groq qwen = groq slot 2, OpenRouter vision = or slot 0
  } else {
    out.key = -1;
    const int f = sub - nModels;            // 0/1 = Groq text, 2 = OpenRouter
    out.provider = (f < N_GROQ_TEXT_MODELS) ? 1 : 2;
    out.model = (f < N_GROQ_TEXT_MODELS) ? f : 0;
  }
}

static inline bool chainSlotHealthy(const ChainSlot& s) {
  if (s.provider == 0) return gemPairHealthy(s.key, s.model);
  if (s.provider == 1) return millis() >= g_groqCoolUntil[s.model];
  return millis() >= g_orCoolUntil[s.model];
}

// Fallbacks are priority-ordered per request: every request starts at Groq, the
// next fallback is tried only after the previous one failed for this request, and
// OpenRouter is the last resort. fbStep counts the current request's fallback
// attempts (reset by riddleGenBegin/judgeBegin). A fallback that failed the last
// request still gets the next request's first try.
static inline int chainFallbackCount(bool vision) {
  return vision ? 2 : (N_GROQ_TEXT_MODELS + 1);
}

// If the wheel was left inside a key's fallback tail, move it to the next key's
// first Gemini slot so Gemini still gets the first attempt.
static void gemChainRequestStart(int nKeys, int nModels, bool vision, int& wheel) {
  if (nKeys < 1) nKeys = 1;
  if (nModels < 1) nModels = 1;
  if (nKeys > GEMINI_KEY_SLOTS)     nKeys = GEMINI_KEY_SLOTS;
  if (nModels > GEMINI_MODEL_SLOTS) nModels = GEMINI_MODEL_SLOTS;
  const int perKey = chainSlotsPerKey(nModels, vision);
  const int total = nKeys * perKey;
  const int w = wheel % total;
  if (w % perKey >= nModels) wheel = ((w / perKey + 1) * perKey) % total;
}

// Gemini slots: scan forward from `wheel`, skipping cooled slots. `wheel` persists
// across requests to spread load over models and keys. The first fallback position
// reached resolves to the request's next fallback in priority order (fbStep).
static void gemNextChain(int nKeys, int nModels, bool vision, bool skipGemini,
                         int& wheel, int& fbStep, ChainSlot& out) {
  if (nKeys < 1) nKeys = 1;
  if (nModels < 1) nModels = 1;
  if (nKeys > GEMINI_KEY_SLOTS)     nKeys = GEMINI_KEY_SLOTS;
  if (nModels > GEMINI_MODEL_SLOTS) nModels = GEMINI_MODEL_SLOTS;
  const int perKey = chainSlotsPerKey(nModels, vision);
  const int total = nKeys * perKey;
  const int w = wheel % total;
  // Every key segment ends in a fallback tail and fallbacks are never skipped, so
  // this scan always finds a slot.
  for (int i = 0; i < total; ++i) {
    const int p = (w + i) % total;
    chainResolve(nModels, vision, p, out);
    if (out.provider == 0 && (skipGemini || !chainSlotHealthy(out))) continue;
    if (out.provider != 0) {
      const int nFb = chainFallbackCount(vision);
      chainResolve(nModels, vision, nModels + (fbStep % nFb), out);
      fbStep++;
      // stay on this tail until every fallback had its try, then move to the next key
      wheel = (fbStep % nFb) ? p : ((p / perKey + 1) * perKey) % total;
      return;
    }
    wheel = (p + 1) % total;
    return;
  }
}

static inline void gemCoolChainModel(const ChainSlot& s) {   // 503 / timeout / 400 / 404
  if (s.provider == 0) {
    if (s.model >= 0 && s.model < GEMINI_MODEL_SLOTS)
      g_modelCoolUntil[s.model] = millis() + GEMINI_COOLDOWN_MODEL_MS;
  } else if (s.provider == 1) {
    if (s.model >= 0 && s.model < 3) g_groqCoolUntil[s.model] = millis() + PROVIDER_COOLDOWN_MODEL_MS;
  } else {
    if (s.model >= 0 && s.model < 2) g_orCoolUntil[s.model] = millis() + PROVIDER_COOLDOWN_MODEL_MS;
  }
}

static inline void gemCoolChainKey(const ChainSlot& s) {     // 429 / 403 (quota, billing)
  if (s.provider == 0) {
    if (s.key >= 0 && s.key < GEMINI_KEY_SLOTS)
      g_keyCoolUntil[s.key] = millis() + GEMINI_COOLDOWN_KEY_MS;
  } else if (s.provider == 1) {
    for (int i = 0; i < 3; ++i) g_groqCoolUntil[i] = millis() + PROVIDER_COOLDOWN_KEY_MS;
  } else {
    for (int i = 0; i < 2; ++i) g_orCoolUntil[i] = millis() + PROVIDER_COOLDOWN_KEY_MS;
  }
}

static inline void gemCoolModel(int m) {
  if (m >= 0 && m < GEMINI_MODEL_SLOTS)
    g_modelCoolUntil[m] = millis() + GEMINI_COOLDOWN_MODEL_MS;
}
static inline void gemCoolKey(int k) {
  if (k >= 0 && k < GEMINI_KEY_SLOTS)
    g_keyCoolUntil[k] = millis() + GEMINI_COOLDOWN_KEY_MS;
}
static inline void gemPraiseChainSlot(const ChainSlot& s) {
  if (s.provider == 0) {
    if (s.key >= 0 && s.key < GEMINI_KEY_SLOTS)     g_keyCoolUntil[s.key] = 0;
    if (s.model >= 0 && s.model < GEMINI_MODEL_SLOTS) g_modelCoolUntil[s.model] = 0;
  } else if (s.provider == 1) {
    if (s.model >= 0 && s.model < 3) g_groqCoolUntil[s.model] = 0;
  } else {
    if (s.model >= 0 && s.model < 2) g_orCoolUntil[s.model] = 0;
  }
}

// base + rnd(0..GEMINI_RETRY_JITTER_MS), so boards never retry in lockstep against
// a saturated API.
static inline uint32_t gemGapMs(uint32_t base) {
  if (GEMINI_RETRY_JITTER_MS <= 0) return base;
  return base + (uint32_t)random(GEMINI_RETRY_JITTER_MS + 1);
}

// Shared cooldown after a local -1 ("connection refused") or -2 ("http begin
// failed"). Those mean the chip's own TCP/TLS layer could not open a connection, so
// no model or key is cooled. The usual cause is internal RAM for TLS buffers
// (tls_psram.h names it). Judge, riddle and the pending-retry pump share one
// network stack, so one global timestamp is right, not three.
static uint32_t g_localRefusalUntilMs = 0;

// Does not touch any model/key cooldown state.
static inline void gemNoteLocalRefusal(uint32_t cooldownMs) {
  g_localRefusalUntilMs = millis() + cooldownMs;
}

static inline bool gemLocalRefusalCooling() {
  return g_localRefusalUntilMs != 0 && (int32_t)(g_localRefusalUntilMs - millis()) > 0;
}

// for callers that delay() the exact remainder
static inline uint32_t gemLocalRefusalRemainingMs() {
  if (!gemLocalRefusalCooling()) return 0;
  return (uint32_t)(g_localRefusalUntilMs - millis());
}

// Attempt floor guard with escalation. Lives here because gemini_judge.h and
// gemini_riddle.h check it before every attempt and are included before
// cloud_link.h.
// With maxAlloc wedged at 23.5 KB a guard that waited forever stalled the judge for
// 20+ minutes. The floors still skip hopeless attempts without burning a rotation
// slot, but after GEMINI_FLOOR_ESCALATE_MS of continuous waiting the attempt goes
// out anyway: a refused attempt costs one instant -1 with no cooldown. Waiting logs
// are rate-limited to one per 5 s.
static uint32_t s_floorWaitSince = 0;   // 0 = not waiting

static bool gemFloorOk(const char* tag, uint32_t freeFloor, uint32_t blockFloor) {
  const uint32_t freeB  = ESP.getFreeHeap();
  const uint32_t allocB = ESP.getMaxAllocHeap();
  if (freeB >= freeFloor && (blockFloor == 0 || allocB >= blockFloor)) {
    if (s_floorWaitSince) {
      Serial.printf("[%s] RAM settled after %u s — attempting\n",
                    tag, (unsigned)((millis() - s_floorWaitSince) / 1000));
      s_floorWaitSince = 0;
    }
    return true;
  }
  static uint32_t s_floorLogMs = 0;
  const bool escalate = s_floorWaitSince != 0 &&
                        millis() - s_floorWaitSince > (uint32_t)GEMINI_FLOOR_ESCALATE_MS;
  if (millis() - s_floorLogMs > 5000) {
    s_floorLogMs = millis();
    Serial.printf("[%s] heap %u B / maxAlloc %u B below the attempt floor (%u/%u) — %s\n",
                  tag, (unsigned)freeB, (unsigned)allocB,
                  (unsigned)freeFloor, (unsigned)blockFloor,
                  escalate ? "ESCALATING — attempting below the floor" : "waiting for RAM to settle");
  }
  if (!escalate) {
    if (!s_floorWaitSince) s_floorWaitSince = millis();
    return false;
  }
  s_floorWaitSince = 0;                 // one escalated attempt per wait window
  return true;
}
static void gemFloorReset() { s_floorWaitSince = 0; }

// Riddle replies are larger than verdicts and a pregen can always wait a beat, so
// the riddle pump asks for more headroom than the judge.
static const uint32_t RIDDLE_MIN_HEAP = 45000;
static uint32_t riddleMinHeap() { return g_tlsInPsram ? RIDDLE_MIN_HEAP_PSRAM : RIDDLE_MIN_HEAP; }
