// Vision judge: one captured frame + the riddle -> verdict, through the shared
// key/model/provider wheel.
// Verdict contract (same semantics as the web app expects):
//   {"passed": bool, "unclear": bool, "feedback": "one short sentence",
//    "seen": "what is actually visible, one short phrase"}
// unclear=true makes the host keep the timer frozen and offer a retake; "seen" feeds
// the spoken "Not quite, I see ..., but I was looking for ..." line.
// Thinking models spend output tokens on reasoning before the answer, so the cap is
// adaptive (x4 per truncated reply, up to 8192), responseMimeType forces minified
// JSON, and the prompt keeps feedback under 90 chars (which also keeps the TTS URL
// short).
// Threading: netTask only captures (esp_camera_fb_get() is internally locked, so it
// is safe next to the MJPEG stream). Every network attempt runs on geminiTask, the
// single caller that makes the plain statics below safe.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "mbedtls/base64.h"
#include "parameters.h"
#include "pins_board.h"
#include "gemini_rotation.h"
#include "llm_provider.h"

// PSRAM-backed byte string for the base64 frame (7-20 KB). Kept in internal-heap
// Strings, capture -> stash -> outcome -> pending park made up to four internal
// copies per turn, and that churn fragmented the heap until TLS handshakes failed for
// minutes. Value semantics (deep copy on assign) keep call sites simple; free()
// handles ps_malloc'd blocks because heap_caps_free routes any heap.
struct PsStr {
  char*  p = nullptr;
  size_t n = 0;
  PsStr() = default;
  ~PsStr() { release(); }
  PsStr(const PsStr& o) { copyFrom(o); }
  PsStr& operator=(const PsStr& o) {
    if (this != &o) { release(); copyFrom(o); }
    return *this;
  }
  void release() {
    if (p) { free(p); p = nullptr; }
    n = 0;
  }
  void clear() { release(); }
  void set(const char* s, size_t len) {
    release();
    if (!s || !len) return;
    n = len;
    p = (char*)ps_malloc(n + 1);
    if (!p) p = (char*)malloc(n + 1);        // no PSRAM -> internal fallback
    if (!p) { n = 0; return; }
    memcpy(p, s, len);
    p[len] = 0;
  }
  void set(const String& s) { set(s.c_str(), s.length()); }
  size_t      length() const { return n; }
  bool        empty()  const { return n == 0; }
  const char* c_str() const { return p ? p : ""; }
private:
  void copyFrom(const PsStr& o) {
    n = o.n;
    p = nullptr;
    if (!o.p || !n) return;
    p = (char*)ps_malloc(n + 1);
    if (!p) p = (char*)malloc(n + 1);
    if (!p) { n = 0; return; }
    memcpy(p, o.p, n + 1);
  }
};

// The judge keeps its own wheel position, separate from the text path's.
static int jWheelIdx = 0;
static int jFbStep   = 0;   // fallback attempts this request (Groq first)

static const char* JUDGE_SYS_PROMPT =
  "You are the strict but fair AI judge of a physical riddle party game. "
  "Reply with ONLY minified JSON: {\"passed\": boolean, \"unclear\": boolean, "
  "\"feedback\": \"one short sentence, fewer than 90 characters\", "
  "\"seen\": \"what is actually visible in the photo, one short phrase, fewer "
  "than 60 characters\"}. No markdown, no emoji, no extra text.";

// Encode buffer and result are PSRAM-first: an internal-first malloc planted a
// ~7 KB transient in the region the TLS handshake needs.
static PsStr captureB64(int* outW, int* outH) {
  PsStr out;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { Serial.println("[CAM] capture failed"); return out; }
  if (outW) *outW = fb->width;
  if (outH) *outH = fb->height;
  size_t need = ((fb->len + 2) / 3) * 4 + 1;
  char* enc = (char*)ps_malloc(need);
  if (!enc) enc = (char*)malloc(need);
  if (!enc) { esp_camera_fb_return(fb); Serial.println("[CAM] no mem for base64"); return out; }
  size_t olen = 0;
  mbedtls_base64_encode((unsigned char*)enc, need, &olen, fb->buf, fb->len);
  enc[olen] = 0;
  Serial.printf("[CAM] captured %ux%u, %u B -> base64 %u B\n",
                (unsigned)fb->width, (unsigned)fb->height, (unsigned)fb->len, (unsigned)olen);
  out.set(enc, olen);
  free(enc);
  esp_camera_fb_return(fb);
  return out;
}

// Persistent judge TLS session. A rotation usually makes 2-4 consecutive attempts at
// the same Gemini host (only key/model in the URL change), and a fresh client per
// attempt threw a socket away each time. Same pattern as the Firebase client in
// cloud_link.h: reuse across same-host attempts, drop with judgeClientDrop() when the
// rotation ends, success or not.
static YieldingTlsClient g_judgeTls;   // yields while waiting (tls_psram.h)
static HTTPClient       g_judgeHttp;
static bool             g_judgeTlsConfigured = false;

static void judgeClientDrop() {
  g_judgeHttp.end();
  g_judgeTls.stop();
}

// The body is built once per rotation (judgeBuildBody, in PSRAM) and only the URL
// changes per attempt. Rebuilding the ~8 KB document per attempt churned internal
// heap right next to the TLS stack.
static int geminiVisionCall(const char* apiKey, const char* model,
                            const char* body, size_t bodyLen,
                            String& finishOut, String& replyOut) {
  replyOut = "";
  finishOut = "";
  if (WiFi.status() != WL_CONNECTED) { replyOut = "[error: Wi-Fi down]"; return -1; }

  String url = String("https://generativelanguage.googleapis.com/v1beta/models/") +
               model + ":generateContent?key=" + apiKey;

  if (!g_judgeTlsConfigured) {
    g_judgeTls.setInsecure();           // encrypted but the cert is not verified (prototype)
    g_judgeHttp.setReuse(true);         // keep the socket warm across attempts
    g_judgeTlsConfigured = true;
  }
  g_judgeHttp.setTimeout(GEMINI_TIMEOUT_MS);
  if (!g_judgeHttp.begin(g_judgeTls, url)) { replyOut = "[error: http begin failed]"; return -2; }
  g_judgeHttp.addHeader("Content-Type", "application/json");

  uint32_t t0 = millis();
  errno = 0;
  int code = g_judgeHttp.POST((uint8_t*)body, bodyLen);
  const int postErrno = errno;          // capture before any logging can clobber it
  uint32_t dt = millis() - t0;

  if (code == HTTP_CODE_OK) {
    JsonDocument resp;
    DeserializationError err = deserializeJson(resp, g_judgeHttp.getString());
    if (err) {
      replyOut = String("[error: JSON ") + err.c_str() + "]";
    } else {
      String txt;
      JsonArray parts = resp["candidates"][0]["content"]["parts"];
      if (!parts.isNull())
        for (JsonObject p : parts) txt += (const char*)(p["text"] | "");
      const char* finish = resp["candidates"][0]["finishReason"] | "?";
      finishOut = finish;
      uint32_t outTok  = resp["usageMetadata"]["candidatesTokenCount"] | 0;
      Serial.printf("[GEMINI] %u ms | request %u B | finish=%s out=%u tokens\n",
                    (unsigned)dt, (unsigned)bodyLen, finish, outTok);
      if (txt.length()) replyOut = txt;
      else {
        const char* block = resp["promptFeedback"]["blockReason"] | "";
        if (block[0]) replyOut = String("[blocked: ") + block + "]";
        else          replyOut = "[error: no text in reply]";
      }
    }
  } else {
    String detail = (code > 0) ? g_judgeHttp.getString() : String(g_judgeHttp.errorToString(code));
    if (code > 0) {
      JsonDocument resp;
      if (!deserializeJson(resp, detail)) {
        const char* msg = resp["error"]["message"] | "";
        if (msg[0]) detail = msg;       // clean message, e.g. quota / invalid key
      }
    }
    Serial.printf("[GEMINI] %u ms | request %u B\n", (unsigned)dt, (unsigned)bodyLen);
    Serial.println("[GEMINI] RAW " + String(code) + ": " + detail.substring(0, 220));
    replyOut = "[error HTTP " + String(code) + "] " + detail.substring(0, 120);
  }
  if (code < 0) tlsLogFailure("GEMINI", g_judgeTls, code, postErrno);   // log before the drop
  g_judgeHttp.end();
  // After a transport failure the socket is suspect; the next attempt starts clean.
  if (code < 0) judgeClientDrop();
  return code;
}

struct JudgeOutcome {
  bool ok       = false;   // a usable verdict was produced
  bool passed   = false;
  bool unclear  = false;
  String feedback;
  String seen;              // what the judge actually saw (short phrase)
  // The frame this verdict was judged from. cloud_link.h keeps it only when every send
  // failed, so the same photo can be re-sent once the network is back. Never a history,
  // just one frame.
  PsStr imgB64;
  int    imgW = 0, imgH = 0;
};

static String judgeBuildPrompt(const String& riddle, const String& target,
                               const String& proofMethod, bool allowPaper,
                               int w, int h) {
  String method = proofMethod.length() ? proofMethod : String("Object Match");
  // Reserve once, then append only: a chained `+` plus unreserved `+=` growth meant a
  // realloc+copy+free per step on the internal heap.
  String prompt;
  prompt.reserve(900 + riddle.length() + target.length());
  prompt += "The riddle was: \""; prompt += riddle; prompt += "\". ";
  // An answer may join up to 3 valid options with " | ". Spell them out so the model
  // never has to parse the separator.
  String targetList = target;
  targetList.replace("|", "/");
  prompt += "The accepted answer(s): \""; prompt += targetList; prompt += "\". ";
  prompt += "Proof method: "; prompt += method; prompt += ". ";
  if (allowPaper) {
    prompt +=
      "PAPER PROOF MODE: instead of a physical object, the photo may show a hand-drawn "
      "sketch, a handwritten word, number or equation on paper, a whiteboard, or that "
      "content held on a phone screen (any mix of English, Hebrew or Arabic handwriting). "
      "Read the handwriting carefully and judge whether the drawing/writing correctly "
      "represents the expected answer. ";
  }
  if (method == "Handwritten Cipher") {
    prompt +=
      "This is a written-cipher riddle: the photo should show handwriting. Accept a legible "
      "final result, a correct full equation, or a correct word — digits written as words "
      "count too. ";
  }
  prompt +=
    "Look at the attached photo. passed=true when the proof clearly matches ANY ONE of the "
    "accepted answer(s) — every listed variant is a full pass, so if the riddle legitimately "
    "admits several answers, ANY correct one passes. "
    "unclear=true if the photo is blurry, too dark, or nothing recognizable is visible. "
    "In \"seen\" describe what is actually visible, one short phrase. "
    "(The attached image is ";
  prompt += w; prompt += 'x'; prompt += h; prompt += " pixels.)";
  return prompt;
}

// Stepped judge state
static PsStr  jGenImg;            // the frame being judged (base64, PSRAM)
static int   jGenW = 0, jGenH = 0;
static String jGenPrompt;         // built once per judgeBegin
static PsStr  jGenBody;           // full request body, built once per rotation
                                  // (PSRAM) and reused by every attempt
static int   jGenTok;             // adaptive output cap
static int   jGenAttempt = 0;
static bool  jGenActive  = false;

// Build the full request (system prompt, riddle prompt, frame, generation config)
// once and park it in PSRAM. The transient internal String is freed before the first
// attempt.
static void judgeBuildBody(const String& prompt, const PsStr& img, int maxTokens) {
  JsonDocument doc;
  doc["systemInstruction"]["parts"][0]["text"] = JUDGE_SYS_PROMPT;
  JsonArray contents = doc["contents"].to<JsonArray>();
  JsonObject turn = contents.add<JsonObject>();
  turn["role"] = "user";
  turn["parts"][0]["text"] = prompt;
  turn["parts"][1]["inline_data"]["mime_type"] = "image/jpeg";
  turn["parts"][1]["inline_data"]["data"] = img.c_str();
  doc["generationConfig"]["maxOutputTokens"] = maxTokens;
  doc["generationConfig"]["temperature"] = 0.2;      // low randomness for judging
  doc["generationConfig"]["responseMimeType"] = "application/json";  // no prose or code fences
  String body;
  body.reserve(measureJson(doc) + 8);
  serializeJson(doc, body);
  jGenBody.set(body);
}

// Arm the stepped judge. One provider attempt happens per judgeStep() call (at most
// GEMINI_TIMEOUT_MS), so the caller can breathe between attempts.
static void judgeBegin(const PsStr& imgB64, int w, int h,
                       const String& riddle, const String& target,
                       const String& proofMethod = "", bool allowPaper = false) {
  jGenImg     = imgB64;
  jGenW       = w;
  jGenH       = h;
  jGenPrompt  = judgeBuildPrompt(riddle, target, proofMethod, allowPaper, w, h);
  jGenTok     = GEMINI_JUDGE_MAX_TOKENS;
  judgeBuildBody(jGenPrompt, jGenImg, jGenTok);
  jGenAttempt = 0;
  jFbStep     = 0;              // every verdict starts at Groq
  gemChainRequestStart(N_KEYS, N_MODELS, /*vision=*/true, jWheelIdx);
  jGenActive  = imgB64.length() > 0;
}

// One provider attempt per call. false = more slots remain, call again next cycle;
// true = finished (out.ok says whether a usable verdict was produced).
static bool judgeStep(JudgeOutcome& out) {
  out = JudgeOutcome();
  if (!jGenActive) {
    out.feedback = "judge not armed";
    return true;
  }

  const int maxAttempts = JUDGE_MAX_ATTEMPTS;
  ChainSlot slot;
  gemNextChain(N_KEYS, N_MODELS, /*vision=*/true, g_forceFallback, jWheelIdx, jFbStep, slot);

  String reply, finish, err;
  int code;
  if (slot.provider == LLM_GEMINI) {
    Serial.printf("[JUDGE] attempt %d/%d → key#%d %s\n",
                  jGenAttempt + 1, maxAttempts, slot.key + 1, GEMINI_MODELS[slot.model]);
    code = geminiVisionCall(GEMINI_API_KEYS[slot.key], GEMINI_MODELS[slot.model],
                            jGenBody.c_str(), jGenBody.length(), finish, reply);
  } else {
    const char* model = (slot.provider == LLM_GROQ) ? GROQ_VISION_MODEL : OPENROUTER_VISION_MODEL;
    Serial.printf("[JUDGE] attempt %d/%d → %s %s\n",
                  jGenAttempt + 1, maxAttempts,
                  slot.provider == LLM_GROQ ? "Groq" : "OpenRouter", model);
    // strict JSON mode on the fallbacks too; the verdict is machine-parsed
    code = llmChatCompletion(slot.provider, model, JUDGE_SYS_PROMPT, jGenPrompt,
                             jGenImg.c_str(), /*jsonMode=*/true, 0.2f, LLM_JUDGE_MAX_TOKENS, reply, err);
    finish = code == 200 ? "STOP" : "ERROR";
    if (code != 200) reply = "[error] " + err;
  }
  jGenAttempt++;

  if (code == 200 && !reply.startsWith("[error") && !reply.startsWith("[blocked")) {
    int b = reply.indexOf('{');
    int e = reply.lastIndexOf('}');
    if (b >= 0 && e > b) {
      JsonDocument v;
      DeserializationError err2 = deserializeJson(v, reply.substring(b, e + 1));
      if (!err2) {
        out.ok      = true;
        out.passed  = v["passed"] | false;
        out.unclear = v["unclear"] | false;
        out.feedback = String((const char*)(v["feedback"] | ""));
        out.seen     = String((const char*)(v["seen"] | ""));
        if (out.seen.length() > 80) out.seen = out.seen.substring(0, 80);
        if (!out.feedback.length()) {
          out.feedback = out.passed ? String("Correct proof!") :
                         out.unclear ? String("Image unclear.") :
                                       String("That did not match the riddle.");
        }
        out.feedback = out.feedback.substring(0, 180);
        Serial.printf("[JUDGE] verdict passed=%d unclear=%d → %s\n",
                      out.passed, out.unclear, out.feedback.c_str());
        gemPraiseChainSlot(slot);   // success clears cooldowns
        // Free the frame as soon as a verdict exists, not at the next judgeBegin.
        jGenImg.clear(); jGenW = 0; jGenH = 0;
        jGenBody.clear();
        jGenActive = false;
        judgeClientDrop();         // rotation over: release the warm socket
        return true;
      }
    }
    Serial.println("[JUDGE] reply had no parsable JSON: " + reply.substring(0, 160));
    if (finish == "MAX_TOKENS" && jGenTok < 8192) {
      jGenTok *= 4;
      judgeBuildBody(jGenPrompt, jGenImg, jGenTok);   // rebuild with the bigger cap
      Serial.printf("[JUDGE] reply hit the token cap — retrying with budget %d\n", jGenTok);
    }
  } else {
    // Quota errors bench the key (or the whole fallback provider), demand errors bench
    // the model slot, so the next attempt (and the text wheel, which shares this state)
    // starts somewhere useful. 400 = dead key, 404 = stale model id.
    // -1/-2 are local transport failures, never the model's fault, so no cooldown;
    // cooling them once benched the whole pool.
    if (code == 429 || code == 403) {
      Serial.printf("[JUDGE] %d — quota/billing, cooling %s\n", code,
                    slot.provider == LLM_GEMINI ? "the key" : "the provider");
      gemCoolChainKey(slot);
    } else if (code == 400 || code == 404) {
      Serial.printf("[JUDGE] %d — %s benched for this pass\n", code,
                    code == 400 ? "key/provider" : "model");
      if (code == 400) gemCoolChainKey(slot); else gemCoolChainModel(slot);
    } else if (code == -3) {
      Serial.println("[JUDGE] fallback provider has no API key — slot benched");
      gemCoolChainModel(slot);
    } else if (code == -1 || code == -2) {
      // Free heap alone did not explain these (104 KB free, every provider refused in
      // ~20 ms), so log the contiguous view too. The next attempt still has to wait
      // before reaching for a fresh connection.
      Serial.printf("[JUDGE] %d — local transport failure (not the model) — no cooldown "
                    "[free=%u maxAlloc=%u]\n", code,
                    (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
      gemNoteLocalRefusal(GEMINI_LOCAL_REFUSAL_COOLDOWN_MS);
    } else if (code == 503 || code < 0) {
      Serial.printf("[JUDGE] %d — demand/hang, cooling the model slot\n", code);
      gemCoolChainModel(slot);
    }
  }

  if (jGenAttempt >= maxAttempts) {            // every provider slot used
    jGenActive = false;
    out.feedback = "all keys failed";
    // Hand the frame over so the pending pump can re-send the exact photo later.
    // Without it savePendingImage() dropped the photo silently and the match hung in
    // EVALUATING until the host used the manual override.
    out.imgB64 = jGenImg;
    out.imgW   = jGenW;
    out.imgH   = jGenH;
    jGenImg.clear(); jGenW = 0; jGenH = 0;
    jGenBody.clear();
    judgeClientDrop();             // rotation over: release the warm socket
    return true;                               // finished, out.ok = false
  }
  return false;                                // next slot on the caller's next cycle
}

// Blocking wrapper over the stepped judge, used by the pending-retry pump. Runs on
// geminiTask, so blocking only costs that task's time. `abortFlag` (nullptr = never)
// is checked between attempts only; tearing down a POST from another task would
// not be safe.
static JudgeOutcome judgeImageB64(const PsStr& imgB64, int w, int h,
                                  const String& riddle, const String& target,
                                  const String& proofMethod = "",
                                  bool allowPaper = false,
                                  volatile bool* abortFlag = nullptr) {
  JudgeOutcome out;
  if (!imgB64.length()) {
    Serial.println("[JUDGE] no frame — cannot judge");
    out.feedback = "camera capture failed";
    return out;                       // ok=false -> the host's fallback takes over
  }
  judgeBegin(imgB64, w, h, riddle, target, proofMethod, allowPaper);
  while (true) {
    if (abortFlag && *abortFlag) {
      Serial.println("[JUDGE] abort requested — stopping between attempts");
      out.feedback = "aborted";
      break;
    }
    // Respect a local-refusal cooldown noted by the live judge or the riddle pump; this
    // loop has no netTask cycle boundary of its own.
    const uint32_t cooling = gemLocalRefusalRemainingMs();
    if (cooling) delay(cooling);
    // Floor check right before the attempt. A failed check does not burn a rotation
    // slot (gemFloorOk escalates on its own); wait a beat and recheck.
    if (!gemFloorOk("JUDGE", gemAttemptMinHeap(), gemAttemptMinBlock())) {
      delay(200);
      continue;
    }
    const bool finished = judgeStep(out);
    if (finished) break;
    // Use the same real gap as the live judge. A flat 120 ms jitter let a -1/-2 storm
    // burn all 6 slots in under a second.
    delay(gemGapMs(JUDGE_ATTEMPT_GAP_MS));
  }
  if (!out.ok && !out.feedback.length()) out.feedback = "all keys failed";
  return out;                          // ok=false -> the host's fallback takes over
}

// Live judging is stepped inside cloud_link.h's tryJudge (capture -> judgeBegin ->
// judgeStep); the pending-retry pump uses judgeImageB64() above.
