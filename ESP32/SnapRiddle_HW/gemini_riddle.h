// Riddle generation (text-only LLM calls). The board writes every riddle; the web
// app has no fallback bank for real games, so failures retry instead of degrading.
//
// Each request carries one environment (picked by the host), one proof method
// (Object / Sketch / Gesture / Cipher, rolled by the web app) and a difficulty.
// The reply bundles the riddle, the answer, a short hint and a time limit, so a turn
// costs one LLM call. The answer must be something players can physically prove:
// grab and photograph it, draw it, perform it, or write it down.
// Gemini replies in JSON mode; the fallback providers use a plain key:value text
// format (JSON mode measurably hurt their riddles), parsed by parseRiddleText().
// Validation is strict only about what the game cannot survive without (a non-empty
// riddle and a short provable answer); other fields get a sane in-code default so
// one sloppy field never wastes a generation round.
// The prompt was tuned against Groq gpt-oss-120b, the live demo provider.
//
// Threading: every attempt runs on geminiTask, the single caller that makes the
// plain statics here safe. netTask only submits jobs and collects results.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "parameters.h"
#include "gemini_rotation.h"
#include "llm_provider.h"

static int rWheelIdx = 0;   // where the next scan starts
static int rFbStep   = 0;   // fallback attempts this request (priority order)

static const char* RIDDLE_SYS_PROMPT =
  "You are the riddle-writing game master of a physical riddle party game. "
  "You sound playful and lively, like a witty game-show host. Reply "
  "with ONLY minified JSON: {\"riddle\":\"...\",\"answer\":\"...\",\"hint\":\"...\",\"proof_method\":"
  "\"...\",\"environment\":\"...\",\"difficulty\":\"...\",\"time_limit\":<seconds>}. "
  "The answer may name up to 3 equally-valid objects joined with ' | '. "
  "The hint is at most 12 words and NEVER contains the answer. "
  "No markdown, no emoji, no extra text.";

// System prompt for the fallback providers' plain-text format.
static const char* RIDDLE_SYS_PROMPT_TEXT =
  "You are the riddle-writing game master of a physical riddle party game. "
  "You sound playful and lively, like a witty game-show host. "
  "Write in plain text using the requested key-value structure. "
  "No markdown, no emoji, no extra text.";

static bool rIsAlnum(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

// whitespace-aware word count (spaces / tabs / newlines)
static int wordCount(const String& s) {
  int n = 0;
  bool inWord = false;
  for (size_t i = 0; i < s.length(); ++i) {
    char c = s.charAt(i);
    bool ws = (c == ' ' || c == '\t' || c == '\n' || c == '\r');
    if (!ws && !inWord) n++;
    inWord = !ws;
  }
  return n;
}

// keep the first maxWords words so a hint stays short enough to speak
static String trimWords(const String& s, int maxWords) {
  String out;
  int n = 0, start = 0;
  while (start < (int)s.length() && n < maxWords) {
    int sp = s.indexOf(' ', start);
    int end = (sp < 0) ? (int)s.length() : sp;
    if (end > start) {
      if (n) out += ' ';
      out += s.substring(start, end);
      n++;
    }
    start = end + 1;
  }
  return out;
}

// first theme of a comma-joined list ("Food & Kitchen, Nature" -> "Food & Kitchen")
static String firstThemeOf(const String& themesCsv) {
  int c = themesCsv.indexOf(',');
  String t = (c < 0) ? themesCsv : themesCsv.substring(0, c);
  t.trim();
  return t;
}

// whole-word, case-insensitive ("iron" must not match "environment")
static bool containsWordCI(const String& lowText, const String& lowWord) {
  if (!lowWord.length()) return false;
  int idx = 0;
  while ((idx = lowText.indexOf(lowWord, idx)) >= 0) {
    int end = idx + (int)lowWord.length();
    bool leftOk  = (idx == 0) || !rIsAlnum(lowText.charAt(idx - 1));
    bool rightOk = (end >= (int)lowText.length()) || !rIsAlnum(lowText.charAt(end));
    if (leftOk && rightOk) return true;
    idx = end;
  }
  return false;
}

// A hint must never give the answer away: check the whole phrase and every answer
// word of 3+ letters, on word boundaries.
static bool hintLeaksAnswer(const String& hint, const String& answer) {
  String low = hint; low.toLowerCase();
  String a = answer; a.toLowerCase(); a.trim();
  if (!a.length()) return false;
  if (containsWordCI(low, a)) return true;
  int start = 0;
  while (start < (int)a.length()) {
    int sp = a.indexOf(' ', start);
    int end = (sp < 0) ? (int)a.length() : sp;
    if (end - start >= 3 && containsWordCI(low, a.substring(start, end))) return true;
    start = end + 1;
  }
  return false;
}

// Persistent riddle TLS session, same reasoning as g_judgeTls in gemini_judge.h: the
// model-first wheel hits the same Gemini host several times in a row, so reuse one
// client and drop it with riddleGenDrop() when the rotation finishes.
static YieldingTlsClient g_riddleTls;  // yields while waiting (tls_psram.h)
static HTTPClient       g_riddleHttp;
static bool             g_riddleTlsConfigured = false;

static void riddleGenDrop() {
  g_riddleHttp.end();
  g_riddleTls.stop();
}

// Same transport as geminiVisionCall without the image part; the caller picks the
// system prompt, mime type and temperature.
static int geminiTextCall(const char* apiKey, const char* model,
                          const String& sysPrompt, const String& userPrompt,
                          bool jsonReply, float temperature,
                          int maxTokens, String& finishOut, String& replyOut) {
  replyOut = "";
  finishOut = "";
  if (WiFi.status() != WL_CONNECTED) { replyOut = "[error: Wi-Fi down]"; return -1; }

  JsonDocument doc;
  doc["systemInstruction"]["parts"][0]["text"] = sysPrompt;
  JsonArray contents = doc["contents"].to<JsonArray>();
  JsonObject turn = contents.add<JsonObject>();
  turn["role"] = "user";
  turn["parts"][0]["text"] = userPrompt;
  doc["generationConfig"]["maxOutputTokens"] = maxTokens;
  doc["generationConfig"]["temperature"] = temperature;
  if (jsonReply) doc["generationConfig"]["responseMimeType"] = "application/json";
  String body;
  body.reserve(measureJson(doc) + 8);
  serializeJson(doc, body);

  String url = String("https://generativelanguage.googleapis.com/v1beta/models/") +
               model + ":generateContent?key=" + apiKey;

  if (!g_riddleTlsConfigured) {
    g_riddleTls.setInsecure();          // encrypted but the cert is not verified (prototype)
    g_riddleHttp.setReuse(true);        // keep the socket warm across attempts
    g_riddleTlsConfigured = true;
  }
  g_riddleHttp.setTimeout(GEMINI_TIMEOUT_MS);
  if (!g_riddleHttp.begin(g_riddleTls, url)) { replyOut = "[error: http begin failed]"; return -2; }
  g_riddleHttp.addHeader("Content-Type", "application/json");

  uint32_t t0 = millis();
  errno = 0;
  int code = g_riddleHttp.POST(body);
  const int postErrno = errno;          // capture before any logging can clobber it
  uint32_t dt = millis() - t0;

  if (code == HTTP_CODE_OK) {
    JsonDocument resp;
    DeserializationError err = deserializeJson(resp, g_riddleHttp.getString());
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
                    (unsigned)dt, (unsigned)body.length(), finish, outTok);
      if (txt.length()) replyOut = txt;
      else {
        const char* block = resp["promptFeedback"]["blockReason"] | "";
        if (block[0]) replyOut = String("[blocked: ") + block + "]";
        else          replyOut = "[error: no text in reply]";
      }
    }
  } else {
    String detail = (code > 0) ? g_riddleHttp.getString() : String(g_riddleHttp.errorToString(code));
    if (code > 0) {
      JsonDocument resp;
      if (!deserializeJson(resp, detail)) {
        const char* msg = resp["error"]["message"] | "";
        if (msg[0]) detail = msg;       // clean message, e.g. quota / invalid key
      }
    }
    Serial.printf("[GEMINI] %u ms | request %u B\n", (unsigned)dt, (unsigned)body.length());
    Serial.println("[GEMINI] RAW " + String(code) + ": " + detail.substring(0, 220));
    replyOut = "[error HTTP " + String(code) + "] " + detail.substring(0, 120);
  }
  if (code < 0) tlsLogFailure("GEMINI", g_riddleTls, code, postErrno);   // log before the drop
  g_riddleHttp.end();
  // after a transport failure the socket is suspect; the next attempt starts clean
  if (code < 0) riddleGenDrop();
  return code;
}

struct GeneratedRiddle {
  bool ok = false;          // a usable riddle was produced
  String text;              // spoken aloud
  String answer;            // proof object / word / number, 1-3 words
  String hint;              // <= RIDDLE_HINT_MAX_WORDS, leak-guarded
  String proofMethod;       // Object|Sketch|Gesture|Cipher, from the request
  String theme;             // holds the environment name (legacy field name)
  String difficulty;        // Easy | Medium | Hard
  int    timeLimitSec = 0;  // LLM-chosen, clamped to RIDDLE_TIME_MIN/MAX_SEC
};

// Example objects per environment: a soft anchor, not a whitelist. The prompt lets
// the model pick any plausible item, but telling it "you are unrestricted" invited
// weird items.
static String environmentExamplesFor(const String& env) {
  String e = env; e.toLowerCase();
  if (e.indexOf("classroom") >= 0 || e.indexOf("lab") >= 0)
    return String("pens, erasers, notebooks, water bottles, cables, student IDs, "
                  "highlighters, calculators, glasses, iPads, laptops, markers");
  if (e.indexOf("office") >= 0 || e.indexOf("workspace") >= 0)
    return String("computer mice, sticky notes, staplers, paperclips, USB drives, "
                  "lanyards, coffee mugs, chargers");
  if (e.indexOf("kitchen") >= 0 || e.indexOf("dining") >= 0)
    return String("spoons, forks, cups, paper napkins, apples, small plates, tea bags, "
                  "dish sponges");
  if (e.indexOf("living") >= 0)
    return String("TV remotes, books, house keys, coins, coasters, phone cases, "
                  "small cushions, board game pieces");
  if (e.indexOf("dorm") >= 0 || e.indexOf("bedroom") >= 0)
    return String("hairbrushes, hats, wallets, slippers, alarm clocks, socks, "
                  "headphones, chargers");
  if (e.indexOf("house") >= 0 || e.indexOf("full") >= 0)
    return String("kitchen things, living-room things, bedroom things — spoons, cups, "
                  "apples, tea bags, remotes, books, keys, coins, phone cases, board game "
                  "pieces, hairbrushes, wallets, slippers, alarm clocks, socks, headphones, "
                  "chargers");
  return String("common household objects");
}

// One example pair per difficulty for the requested proof method, so tiers and answer
// shape are anchored without locking the model into one template.
static const char* fewShotFor(const String& method) {
  if (method == "Sketch Proof")
    return "{\"difficulty\":\"Easy\",\"riddle\":\"I have zero corners and zero straight lines. Draw me "
           "on paper before time runs out!\",\"answer\":\"circle\"}\n"
           "{\"difficulty\":\"Medium\",\"riddle\":\"I show you the way without saying a word, and I point "
           "at my target, sharp and unheard. Sketch me on paper!\",\"answer\":\"arrow\"}\n"
           "{\"difficulty\":\"Hard\",\"riddle\":\"I have a face but no eyes, two hands but no arms, and I "
           "tell the truth without a word. Draw me before time runs out!\",\"answer\":\"clock\"}\n";
  if (method == "Body Gestures")
    return "{\"difficulty\":\"Easy\",\"riddle\":\"Make two L shapes with your fingers and frame your face "
           "like a photographer. Hold that pose!\",\"answer\":\"camera frame hands\"}\n"
           "{\"difficulty\":\"Medium\",\"riddle\":\"When you are nervous and hoping for luck, twist two "
           "fingers together and leave doubt behind. Show the camera!\",\"answer\":\"crossed fingers\"}\n"
           "{\"difficulty\":\"Hard\",\"riddle\":\"Curl four companions tight in bed, but wake the stout one "
           "straight ahead. Point his blunt crown at the ceiling to say all is well. Hold it up!\","
           "\"answer\":\"thumbs up\"}\n";
  if (method == "Handwritten Cipher")
    return "{\"difficulty\":\"Easy\",\"riddle\":\"Which single letter buzzes like an insect in a hive? "
           "Write it down!\",\"answer\":\"B\"}\n"
           "{\"difficulty\":\"Medium\",\"riddle\":\"Which five-letter word becomes shorter when you add "
           "two letters to it? Write it down!\",\"answer\":\"SHORT\"}\n"
           "{\"difficulty\":\"Hard\",\"riddle\":\"Raise me to my own power and you get two to the power "
           "of eight. Write my number down!\",\"answer\":\"4\"}\n";
  return "{\"difficulty\":\"Easy\",\"riddle\":\"The more I dry, the wetter I get. Grab me after your "
         "shower and hold me up to the camera!\",\"answer\":\"towel\"}\n"
         "{\"difficulty\":\"Medium\",\"riddle\":\"I am tall when I am young and short when I am old, "
         "and I glow in the dark until my flame goes cold. Fetch me and show me to the camera!\","
         "\"answer\":\"candle\"}\n"
         "{\"difficulty\":\"Hard\",\"riddle\":\"I have keys but open no locks, space but no room, and "
         "you can enter but never go inside. Bring me to the camera!\",\"answer\":\"keyboard\"}\n";
}

// Stepped API: riddleGenBegin() builds the prompt and resets the rotation;
// riddleGenStep() runs exactly one provider attempt. Re-begin whenever the request is
// replaced. The shared prompt body is built once; the reply-format tail (JSON for
// Gemini, plain text for fallbacks) is added per attempt.
// Temperature 0.9 for variety. A failure is just ok=false: the caller retries on its
// own cadence and there is never a fallback riddle.
static String rGenBody;
static String rGenEnvTail;        // for the JSON tail
static String rGenDiffTail;       // for the JSON tail
static String rGenMethod;         // stamped on the result
static int   rGenAttempt  = 0;
static bool  rGenActive   = false;
static String rGenThemesCsv;              // firstThemeOf fallback needs the list

static void riddleGenBegin(const String& difficulty, const String& environment,
                           const String& legacyThemesCsv, const String& proofMethod,
                           const String& excludedCsv, bool bonus) {
  String env = environment;
  if (!env.length()) {
    // an older host still sends a theme CSV; use the first name
    env = legacyThemesCsv;
    int c = env.indexOf(',');
    if (c > 0) env = env.substring(0, c);
    env.trim();
  }
  if (!env.length()) env = "Everyday Objects";

  // The proof method is an input; the answer's shape must match it. Each block ends
  // with an action phrase (draw it, hold it up, strike the pose, write it down) so the
  // riddle itself tells the player how to prove it.
  String proofLine;
  String method = proofMethod;
  if (!method.length()) method = "Object Match";
  if (method == "Sketch Proof") {
    proofLine =
      "Proof method: SKETCH. The player draws the answer on paper and shows it to the "
      "camera. The answer must be drawable in a few lines WITHOUT any artistic talent: a "
      "basic drawing (house, tree, book, envelope), a shape or geometry (triangle, star, "
      "spiral, grid), a symbol or line sign (arrow, plus sign, question mark, zigzag) or a "
      "simple icon (sun, anchor, ghost, fire, heart). NEVER an abstract concept (time, "
      "silence, darkness, an idea or feeling) and never something that needs shading, "
      "fine detail or a skilled hand to be recognized. The LAST sentence must be an "
      "explicit drawing instruction (sketch / draw / doodle it on paper before time runs "
      "out). Write answer as the name of the drawing (1-4 words).\n";
  } else if (method == "Body Gestures") {
    proofLine =
      "Proof method: BODY GESTURE. The camera is static and frames only the head, "
      "shoulders, arms and hands, so the answer must be a hand sign — e.g. peace sign "
      "(index and middle finger in a V), thumbs up (fist, thumb pointing up), OK sign "
      "(thumb and index touch in a circle, other fingers up), crossed fingers (middle "
      "finger over index), salute (flat hand at the brow) — or an UPPER-BODY pose "
      "(ballerina arms, flexed biceps, hands framing the face, shrug) — never legs, feet, "
      "jumps or full-body moves. It must be a sign or pose ONE person already knows by "
      "name and can hold still — pick from the whole range, not always the same favorite. The riddle "
      "describes the pose to strike without using the gesture's usual name, and every "
      "detail must match how people really make it. Easy may describe the pose plainly; "
      "Medium pairs a plain clue with the moment people use it; Hard disguises the pose "
      "in playful metaphor. Use only meanings everyone knows — no history, myths or "
      "country-specific customs. The LAST sentence must tell the player to strike / hold the pose. Write "
      "answer as the pose's common name (1-4 words).\n";
  } else if (method == "Handwritten Cipher") {
    proofLine =
      "Proof method: HANDWRITTEN CIPHER. The player writes the answer on paper and shows "
      "it to the camera. The riddle itself must be a MATH puzzle (an equation, a number "
      "riddle, a short counting chain, e.g. 'multiply the sides of a triangle by the "
      "points on a star, subtract a spider's legs' -> 7) or a WORD puzzle (letter logic, "
      "anagram, hidden word, sound-alike letter, word play, e.g. 'a word that becomes "
      "shorter when you add two letters' -> SHORT) — not a description of an object to "
      "name. The answer is ONE number or ONE single word (a single letter counts) — "
      "never a phrase or a description. Abstract words are fine here (time, silence). "
      "The puzzle must have exactly ONE correct answer: build it only from facts with one "
      "undisputed value (sides of a triangle, days in a week, legs of a spider, letters of "
      "a word written in the riddle), each clue pointing to exactly one thing (say 'a "
      "spider', not 'a creepy visitor'), never from a choice (a month, a day, 'a word for "
      "quiet'), and never put the answer word in the riddle. The LAST sentence must tell "
      "the player to write the result down. Write answer as the exact string to write "
      "(digits for numbers).\n";
  } else {
    proofLine =
      "Proof method: OBJECT MATCH. The player fetches the real object and holds it up to the "
      "static camera. The answer MUST be one specific physical object (1-3 words) that is "
      "common in the environment above (most players have one nearby — never a niche or "
      "unfamiliar item), light and easy to pick up, and small enough to fit in the camera "
      "frame when held up. NEVER heavy or fixed items (fridge, table, sofa, faucet, sink), "
      "never big items (large luggage bag, chair, TV), never an abstract concept (time, "
      "silence, darkness). If the riddle legitimately admits several objects, join up to 3 "
      "equally-valid answers with ' | ' (e.g. \"a book | a smartphone | a flash drive\") "
      "— the judge accepts any one of them. The LAST sentence must tell the player to "
      "fetch the item and hold it up to the camera.\n";
  }

  String prompt;
  // Sized so the build never reallocates. Each growth past capacity means a new buffer,
  // a copy and a free, and on real hardware that one realloc wedged maxAlloc
  // (29684 -> 23540 B) at the start of every rotation. The prompt runs ~3.2-3.7 KB
  // before the excluded list, which grows by one answer per turn.
  prompt.reserve(6144);
  prompt += "Create ONE riddle for the game.\n";
  prompt += "The proof is ONE photo from a static, low-resolution camera, so the answer must "
            "be clearly visible and recognizable in a single still picture.\n";
  // Three difficulty tiers, independent of proof method. Per-tier examples used to be
  // object/sketch-specific and leaked into every method; the per-method example pairs
  // carry the examples now.
  prompt += "Difficulty: ";
  const String diff = difficulty.length() ? difficulty : String("Medium");
  prompt += diff;
  prompt += " — follow this calibration EXACTLY:\n";
  if (diff == "Easy") {
    prompt +=
      "EASY: a familiar answer and an openly suggestive riddle — one clear clue that points "
      "almost directly at it, with one playful twist. A player should get it within seconds "
      "of hearing it twice. Keep it 1-3 short sentences.\n";
  } else if (diff == "Hard") {
    prompt +=
      "HARD: the solver must chain SEVERAL steps of logical deduction: give 2-3 separate "
      "clues that each fit many things but together fit only the answer (or a puzzle that "
      "takes several steps to work out). No single clue may give the answer away on its own "
      "(never name its defining part, e.g. tines, pages, bristles). The final answer is still "
      "universally known — no obscure trivia, no expert knowledge, no rare item. Keep it 2-4 "
      "sentences.\n";
  } else {
    prompt +=
      "MEDIUM: still a familiar answer, but described from a sideways angle — its habits, "
      "effects, company or a double meaning instead of a straight description — so the "
      "solver needs one small mental hop. Keep it 2-3 sentences.\n";
  }
  // The environment anchors the answer for Object Match only. Sketch and cipher proofs
  // are drawn or written on paper and gestures are performed, so the environment must
  // not constrain those answers.
  if (method == "Object Match") {
    prompt += "Environment: ";
    prompt += env;
    prompt += ". Typical objects found there include: ";
    prompt += environmentExamplesFor(env);
    prompt += ". Treat that list as flavor, not a menu: pick any common, physical item that "
              "plausibly belongs in this environment — the riddle just has to be provable "
              "inside it.\n";
  } else if (method == "Body Gestures") {
    prompt += "The proof is a pose performed in front of the camera; the environment does "
              "not constrain the answer. The answer must be actable with your upper body or hands.\n";
  } else {
    // Sketch Proof + Handwritten Cipher: the proof is drawn/written on paper
    prompt += "The proof is written on paper; the environment does not constrain the answer.\n";
  }
  prompt += proofLine;
  prompt += "Calibration examples (tone and difficulty scaling only — never reuse their "
            "riddles or answers):\n";
  prompt += fewShotFor(method);
  if (excludedCsv.length()) {
    prompt += "Do NOT reuse any of these recently used answers (or close synonyms of them): ";
    prompt += excludedCsv;
    prompt += ".\n";
  }
  if (bonus) {
    prompt += "This is a fast BONUS riddle: slightly easier, punchy, one or two sentences max.\n";
  }
  // Quality bar: game-master tone, never self-explanatory, never contains the answer
  // or a close relative of it.
  prompt += "The riddle text: short spoken sentences. Voice and tone: playful game-master, "
            "light poetic rhythm or rhyme when it lands naturally, never stiff or encyclopedic. "
            "It must NOT be self-explanatory and must NEVER contain the answer, a synonym of "
            "it, or a word that gives it away (for a heart-shaped-hands answer never say heart "
            "or love; for a spoon never say stir or soup). Prefer misdirection: describe the "
            "item's traits, habits or look from an unexpected angle.\n";
  // Correctness over rhyme, plus a silent self-check. gpt-oss reasons in hidden tokens,
  // so this costs no visible output.
  prompt += "Correctness beats sound: every clue must be literally true of the answer and "
            "read naturally aloud. Use rhyme only when it costs no accuracy and no odd "
            "phrasing.\n";
  prompt += "The closing instruction says only HOW to prove it (draw it, hold it up, strike "
            "the pose, write it down) — never what the answer is or what it looks like.\n";
  prompt += "Before you reply, silently verify: exactly one answer fits all the clues; every "
            "clue, fact, count and calculation is literally true of the answer (no "
            "contradictions); no clue names the answer or its defining part; the last sentence "
            "tells the player how to prove it; the riddle matches the requested difficulty.\n";
  prompt += "time_limit = how many seconds a player reasonably needs (Easy ~60-90, Medium "
            "~90-140, Hard ~120-180; never outside 60-180). Sketch/Gesture/Cipher proofs sit "
            "at the lower half of the band (no hunting time needed).\n";
  // The hint rides in the same reply: one LLM call per turn instead of two.
  prompt += "Also write ONE hint for the player: at most 12 words, it must NEVER contain "
            "the answer nor its exact spelling and must not rhyme with it. Nudge instead: "
            "the first letter, a color, the size, where to find it, how many, or what shape "
            "to start with. The hint will be read aloud to the whole room.\n";

  rGenBody      = prompt;
  rGenEnvTail   = env;
  rGenDiffTail  = diff;
  rGenMethod    = method;
  rGenThemesCsv = legacyThemesCsv;
  rGenAttempt   = 0;
  rFbStep       = 0;           // every request starts at Groq gpt-oss-120b
  gemChainRequestStart(N_KEYS, N_MODELS, /*vision=*/false, rWheelIdx);
  rGenActive    = true;
}

// Answer validation shared by both reply modes: up to 3 variants joined with " | ",
// each 1-4 words.
static bool validateAnswer(const String& answer) {
  String low = answer; low.toLowerCase();
  int start = 0;
  int variants = 1;
  while (true) {
    int bar = low.indexOf('|', start);
    String part = low.substring(start, bar < 0 ? (int)low.length() : bar);
    part.trim();
    if (part.length()) {
      const int wc = wordCount(part);
      if (wc < 1 || wc > 4) return false;
    }
    if (bar < 0) break;
    variants++;
    if (variants > 3) return false;
    start = bar + 1;
  }
  return true;
}

// Hint cleanup shared by both reply modes: strip quotes, leak-guard, trim to
// RIDDLE_HINT_MAX_WORDS. An empty result just means no hint this round; the riddle
// stays valid.
static String sanitizeHint(String hint, const String& answer) {
  hint.replace("\n", " ");
  hint.replace("\"", "");
  hint.trim();
  String low = hint; low.toLowerCase();
  if (low.startsWith("hint:")) hint = hint.substring(5);
  hint.trim();
  if (!hint.length()) return "";
  if (hintLeaksAnswer(hint, answer)) {
    Serial.println("[RIDDLE] hint rejected — it leaked the answer: " + hint.substring(0, 60));
    return "";
  }
  if (wordCount(hint) > RIDDLE_HINT_MAX_WORDS) hint = trimWords(hint, RIDDLE_HINT_MAX_WORDS);
  return hint;
}

// Parse the plain-text reply used by the fallback providers: take the text after the
// first ':' of each known key (case-insensitive). RIDDLE captures everything up to
// the next known key, so multi-line riddles survive. VARIANTS split on ',' or ' - '.
static bool parseRiddleText(const String& reply, GeneratedRiddle& out) {
  String riddle, answer, variants, proof, env, diff, hint;
  int timeLimit = 0;
  const char* keys[] = { "riddle:", "answer:", "variants:", "proof method:",
                         "environment:", "difficulty:", "time limit:", "hint:" };
  int riddleStart = -1, riddleEnd = -1;
  int idx = 0;
  const int n = reply.length();
  while (idx < n) {
    int eol = reply.indexOf('\n', idx);
    if (eol < 0) eol = n;
    String line = reply.substring(idx, eol);
    line.trim();
    String low = line; low.toLowerCase();
    int hit = -1;
    for (int k = 0; k < 8; ++k) {
      if (low.startsWith(keys[k])) { hit = k; break; }
    }
    if (hit >= 0) {
      if (riddleStart >= 0 && riddleEnd < 0) riddleEnd = idx;   // RIDDLE block closed
      String val = line.substring(strlen(keys[hit]));
      val.trim();
      switch (hit) {
        case 0: riddleStart = idx; break;                        // may span lines; captured after the loop
        case 1: answer = val; break;
        case 2: variants = val; break;
        case 3: proof = val; break;
        case 4: env = val; break;
        case 5: diff = val; break;
        case 6: timeLimit = val.toInt(); break;
        case 7: hint = val; break;
      }
    }
    idx = eol + 1;
  }
  if (riddleStart >= 0) {
    if (riddleEnd < 0) riddleEnd = n;
    riddle = reply.substring(riddleStart, riddleEnd);
    int colon = riddle.indexOf(':');
    if (colon >= 0) riddle = riddle.substring(colon + 1);
    riddle.trim();
  }
  if (riddle.length() && answer.length()) {
    // VARIANTS join the accepted phrasings onto the answer with " | "
    if (variants.length()) {
      variants.replace(" - ", ",");
      String joined = answer;
      int start = 0;
      while (true) {
        int comma = variants.indexOf(',', start);
        String part = variants.substring(start, comma < 0 ? (int)variants.length() : comma);
        part.trim();
        // gpt-oss writes "VARIANTS: -" for none (the format offers ' - ' as a separator):
        // skip a lone dash and repeats, so "anchor | -" never reaches the judge or the web.
        if (part.length() && part != "-" && (" | " + joined + " | ").indexOf(" | " + part + " | ") < 0)
          joined += " | " + part;
        if (comma < 0) break;
        start = comma + 1;
      }
      answer = joined;
    }
    out.text          = riddle;
    out.answer        = answer;
    out.hint          = sanitizeHint(hint, out.answer);
    out.proofMethod   = proof.length() ? proof : String("Object Match");
    out.theme         = env;
    out.difficulty    = diff.length() ? diff : String("Medium");
    if (timeLimit <= 0) timeLimit = 90;
    if (timeLimit < RIDDLE_TIME_MIN_SEC) timeLimit = RIDDLE_TIME_MIN_SEC;
    if (timeLimit > RIDDLE_TIME_MAX_SEC) timeLimit = RIDDLE_TIME_MAX_SEC;
    out.timeLimitSec  = timeLimit;
    return true;
  }
  Serial.println("[RIDDLE] plain-text reply missing RIDDLE:/ANSWER: keys: " + reply.substring(0, 120));
  return false;
}

// One provider attempt per call. false = more slots remain, call again next cycle;
// true = finished (out.ok says whether it worked). Gemini uses JSON mode and the
// flat GEMINI_TEXT_MAX_TOKENS cap; fallbacks use the plain-text mode.
static bool riddleGenStep(GeneratedRiddle& out) {
  out.ok = false;
  if (!rGenActive) return true;                 // nothing armed -> finished (failed)

  const int maxAttempts = TEXTGEN_MAX_ATTEMPTS;
  ChainSlot slot;
  gemNextChain(N_KEYS, N_MODELS, /*vision=*/false, g_forceFallback, rWheelIdx, rFbStep, slot);

  String prompt = rGenBody;
  String reply, finish, err;
  int code;
  if (slot.provider == LLM_GEMINI) {
    prompt += "Reply ONLY minified JSON: {\"riddle\":\"...\",\"answer\":\"...\",\"hint\":\"...\",\"proof_method\":"
              "\"...\",\"environment\":\"";
    prompt += rGenEnvTail;
    prompt += "\",\"difficulty\":\"";
    prompt += rGenDiffTail;
    prompt += "\",\"time_limit\":<seconds>}";
    Serial.printf("[RIDDLE] attempt %d/%d → key#%d %s\n",
                  rGenAttempt + 1, maxAttempts, slot.key + 1, GEMINI_MODELS[slot.model]);
    code = geminiTextCall(GEMINI_API_KEYS[slot.key], GEMINI_MODELS[slot.model],
                          RIDDLE_SYS_PROMPT, prompt, true, 0.9f,
                          GEMINI_TEXT_MAX_TOKENS, finish, reply);
  } else {
    prompt += "Reply in EXACTLY this plain-text structure (no JSON, no markdown fences):\n"
              "RIDDLE: <the riddle, 20-50 words total>\n"
              "ANSWER: <1-4 word answer; up to 3 equally-valid ones joined with ' | '>\n"
              "VARIANTS: <up to 3 alternative accepted phrasings, comma separated, or ' - '>\n"
              "PROOF METHOD: <Object Match|Sketch Proof|Body Gestures|Handwritten Cipher>\n"
              "ENVIRONMENT: <environment name>\n"
              "DIFFICULTY: <Easy|Medium|Hard>\n"
              "TIME LIMIT: <60-180 seconds>\n"
              "HINT: <at most 12 words, must NOT contain the answer>";
    const char* model = (slot.provider == LLM_GROQ)
      ? ((slot.model >= 0 && slot.model < N_GROQ_TEXT_MODELS) ? GROQ_TEXT_MODELS[slot.model] : GROQ_TEXT_MODELS[0])
      : OPENROUTER_TEXT_MODEL;
    Serial.printf("[RIDDLE] attempt %d/%d → %s %s\n",
                  rGenAttempt + 1, maxAttempts,
                  slot.provider == LLM_GROQ ? "Groq" : "OpenRouter", model);
    code = llmChatCompletion(slot.provider, model, RIDDLE_SYS_PROMPT_TEXT, prompt,
                             "", /*jsonMode=*/false, 0.9f, LLM_TEXT_MAX_TOKENS, reply, err);
    finish = code == 200 ? "STOP" : "ERROR";
    if (code != 200) reply = "[error] " + err;
  }
  rGenAttempt++;

  if (code == 200 && !reply.startsWith("[error") && !reply.startsWith("[blocked")) {
    bool parsed = false;
    if (slot.provider == LLM_GEMINI) {
      int b = reply.indexOf('{');
      int e = reply.lastIndexOf('}');
      if (b >= 0 && e > b) {
        JsonDocument v;
        DeserializationError err2 = deserializeJson(v, reply.substring(b, e + 1));
        if (!err2) {
          String text   = String((const char*)(v["riddle"] | ""));
          String answer = String((const char*)(v["answer"] | ""));
          text.trim(); answer.trim();
          if (text.length() && validateAnswer(answer)) {
            out.ok           = true;
            out.text         = text;
            out.answer       = answer;
            out.hint         = sanitizeHint(String((const char*)(v["hint"] | "")), answer);
            out.proofMethod  = String((const char*)(v["proof_method"] | ""));
            if (!out.proofMethod.length()) out.proofMethod = "Object Match";
            // the JSON asks for "environment"; accept the legacy "theme" too
            out.theme        = String((const char*)(v["environment"] | ""));
            if (!out.theme.length()) out.theme = String((const char*)(v["theme"] | ""));
            if (!out.theme.length()) out.theme = firstThemeOf(rGenThemesCsv);
            out.difficulty   = String((const char*)(v["difficulty"] | ""));
            if (!out.difficulty.length()) out.difficulty = "Medium";
            int tl = (int)(v["time_limit"] | (double)0);
            if (tl <= 0) tl = 90;
            if (tl < RIDDLE_TIME_MIN_SEC) tl = RIDDLE_TIME_MIN_SEC;
            if (tl > RIDDLE_TIME_MAX_SEC) tl = RIDDLE_TIME_MAX_SEC;
            out.timeLimitSec = tl;
            parsed = true;
          }
          if (!parsed) {
            Serial.printf("[RIDDLE] reply failed validation (answer variant word cap is 1-4, max 3 variants): "
                          "answer=\"%s\" (%d words) | %s\n",
                          answer.c_str(), wordCount(answer), reply.substring(0, 200).c_str());
          }
        } else {
          Serial.println(String("[RIDDLE] JSON parse error: ") + err2.c_str());
        }
      } else {
        Serial.println("[RIDDLE] reply had no JSON object: " + reply.substring(0, 120));
      }
    } else {
      parsed = parseRiddleText(reply, out);
      if (parsed) {
        if (!out.theme.length()) out.theme = firstThemeOf(rGenThemesCsv);
        out.ok = true;
      }
    }
    if (parsed) {
      // The proof method is an input, so stamp the requested one instead of trusting the
      // model's echo: Gemini echoed "SKETCH"/"BODY GESTURE", and the web displays this
      // field while gemini_judge.h matches "Handwritten Cipher" exactly.
      out.proofMethod = rGenMethod;
      // Log the riddle text: without it the serial log only showed difficulty, time and
      // answer, with no way to see what the board actually wrote.
      Serial.printf("[RIDDLE] generated: %s/%s, %d s, proof=%s, answer=\"%s\"%s\n",
                    out.difficulty.c_str(), out.theme.c_str(), out.timeLimitSec,
                    out.proofMethod.c_str(), out.answer.c_str(),
                    out.hint.length() ? " · hint ok" : " · no hint");
      Serial.println("[RIDDLE] text: " + out.text.substring(0, 220));
      gemPraiseChainSlot(slot);   // success clears cooldowns
      rGenActive = false;
      riddleGenDrop();            // rotation over: release the warm socket
      return true;
    }
  } else if (code == 429 || code == 403) {
    // Quota errors bench the key (or the whole fallback provider).
    Serial.printf("[RIDDLE] %d — quota/billing, cooling %s\n", code,
                  slot.provider == LLM_GEMINI ? "the key" : "the provider");
    gemCoolChainKey(slot);
  } else if (code == 400 || code == 404) {
    // 400 (dead key) benches the key/provider and 404 (stale model id) the model slot;
    // otherwise they would burn an attempt slot on every pass.
    Serial.printf("[RIDDLE] %d — %s benched for this pass\n", code,
                  code == 400 ? "key/provider" : "model");
    if (code == 400) gemCoolChainKey(slot); else gemCoolChainModel(slot);
  } else if (code == -3) {
    // A fallback without a configured key is not an outage: bench the slot quietly.
    Serial.println("[RIDDLE] fallback provider has no API key — slot benched");
    gemCoolChainModel(slot);
  } else if (code == -1 || code == -2) {
    // Local transport failure (connection refused at low heap, http.begin failed). The
    // model is fine and cooling it can stall the whole wheel, so no cooldown. Note the
    // shared local-refusal cooldown so the next attempt waits before reaching for a new
    // connection.
    Serial.printf("[RIDDLE] %d — local transport failure (not the model) — no cooldown\n", code);
    gemNoteLocalRefusal(GEMINI_LOCAL_REFUSAL_COOLDOWN_MS);
  } else if (code == 503 || code < 0) {
    // A 503 answers fast but the model is saturated; a -11 read-timeout is a server-side
    // stall. Both cool the model slot.
    Serial.printf("[RIDDLE] %d — demand/hang, cooling the model slot\n", code);
    gemCoolChainModel(slot);
  }

  if (rGenAttempt >= maxAttempts) {            // every provider slot used
    rGenActive = false;
    riddleGenDrop();                           // release the warm socket
    return true;                               // finished, out.ok = false
  }
  return false;                                // next slot on the caller's next cycle
}

// Blocking wrapper, the riddle counterpart of judgeImageB64(). Runs on geminiTask,
// so blocking only costs that task's time. It keeps the "no fallback riddle"
// invariant: when every slot fails it re-arms and keeps going instead of returning
// ok=false, because a wrong riddle is worse than a slow one. `abortFlag`
// (nullptr = never) is checked between attempts only, so a superseded request (newer
// riddle_req, room closed) gives up without tearing down a POST mid-flight.
static void riddleGenBlocking(const String& difficulty, const String& environment,
                              const String& legacyThemesCsv, const String& proofMethod,
                              const String& excludedCsv, bool bonus,
                              volatile bool* abortFlag, GeneratedRiddle& out) {
  riddleGenBegin(difficulty, environment, legacyThemesCsv, proofMethod, excludedCsv, bonus);
  uint32_t tries = 0;
  while (true) {
    if (abortFlag && *abortFlag) {
      Serial.println("[RIDDLE] abort requested — stopping between attempts");
      out = GeneratedRiddle();
      return;
    }
    const uint32_t cooling = gemLocalRefusalRemainingMs();
    if (cooling) delay(cooling);
    // Floor check right before the attempt. A failed check does not burn a rotation
    // slot (gemFloorOk escalates on its own); wait a beat and recheck.
    if (!gemFloorOk("RIDDLE", riddleMinHeap(), gemAttemptMinBlock())) {
      delay(200);
      continue;
    }
    const bool finished = riddleGenStep(out);
    tries++;
    if (finished) {
      if (out.ok) return;
      // every slot failed this pass: re-arm and keep trying
      Serial.println("[RIDDLE] rotation wheel spent — re-arming (retries forever)");
      riddleGenBegin(difficulty, environment, legacyThemesCsv, proofMethod, excludedCsv, bonus);
      continue;
    }
    // quick gap for the first RIDDLE_FAST_RETRIES tries, then the slow cadence
    uint32_t gap = gemGapMs((tries <= RIDDLE_FAST_RETRIES) ? RIDDLE_FAST_GAP_MS
                                                            : RIDDLE_SLOW_RETRY_MS);
    delay(gap);
  }
}

