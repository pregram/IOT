// OpenAI-compatible chat-completions adapter for the fallback providers (Groq,
// OpenRouter). gemini_rotation.h hands an attempt here once a key's Gemini models
// are spent. Runs on geminiTask (Core 0), like every LLM call.
//
// Provider rules (all tested against the team's Python replica):
//  - Groq gpt-oss text models: reasoning_format=hidden + reasoning_effort=medium,
//    so the thought process never reaches the parser.
//  - Groq vision and OpenRouter models: no reasoning params.
//  - The judge keeps strict JSON mode; riddles/hints use the plain key:value text
//    format here, because JSON mode measurably degraded fallback riddles.
//  - An empty API key fails fast with -3 so the wheel benches the slot instead of
//    burning a timeout.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "parameters.h"
#include "tls_psram.h"

// must match gemini_rotation.h's ChainSlot.provider
static const int LLM_GEMINI      = 0;
static const int LLM_GROQ        = 1;
static const int LLM_OPENROUTER  = 2;

/**
 * One chat-completions attempt.
 * @return HTTP code, or a transport code: -1 WiFi down, -2 http.begin failed,
 *         -3 key not configured, -11 deadline cut (treated as a hang).
 * contentOut gets the assistant text; errOut a short reason on failure.
 * imgB64 is a raw pointer so the judge can pass its PSRAM frame without an
 * internal-heap String copy per attempt; text callers pass "" or nullptr.
 */
static int llmChatCompletion(int provider, const char* model,
                             const String& sysPrompt, const String& userPrompt,
                             const char* imgB64,       // empty/null -> text-only
                             bool jsonMode, float temperature,
                             int maxTokens,            // 0 -> not sent
                             String& contentOut, String& errOut) {
  const bool haveImg = (imgB64 && imgB64[0]);
  contentOut = "";
  errOut = "";
  if (WiFi.status() != WL_CONNECTED) { errOut = "Wi-Fi down"; return -1; }
  const char* apiKey = (provider == LLM_GROQ) ? GROQ_API_KEY : OPENROUTER_API_KEY;
  if (!apiKey[0]) { errOut = "no API key configured"; return -3; }

  const char* url = (provider == LLM_GROQ)
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://openrouter.ai/api/v1/chat/completions";

  JsonDocument doc;
  doc["model"] = model;
  JsonArray msgs = doc["messages"].to<JsonArray>();
  JsonObject sys = msgs.add<JsonObject>();
  sys["role"] = "system";
  sys["content"] = sysPrompt;
  JsonObject usr = msgs.add<JsonObject>();
  usr["role"] = "user";
  if (haveImg) {
    JsonArray parts = usr["content"].to<JsonArray>();
    JsonObject t = parts.add<JsonObject>();
    t["type"] = "text";
    t["text"] = userPrompt;
    JsonObject im = parts.add<JsonObject>();
    im["type"] = "image_url";
    im["image_url"]["url"] = String("data:image/jpeg;base64,") + imgB64;
  } else {
    usr["content"] = userPrompt;
  }
  doc["temperature"] = temperature;
  // see LLM_*_MAX_TOKENS in parameters.h
  if (maxTokens > 0) doc["max_completion_tokens"] = maxTokens;
  if (jsonMode) {
    JsonObject rf = doc["response_format"].to<JsonObject>();
    rf["type"] = "json_object";
  }
  if (provider == LLM_GROQ && !haveImg &&
      String(model).indexOf("gpt-oss") >= 0) {
    doc["reasoning_format"] = "hidden";
    doc["reasoning_effort"] = "medium";
  }
  // The OpenRouter vision judge spent the whole token cap on reasoning and returned
  // 0 chars every time (finish=length). With reasoning off it answers in ~1-2 s.
  if (provider == LLM_OPENROUTER && haveImg) {
    doc["reasoning"]["enabled"] = false;
  }

  String body;
  body.reserve(measureJson(doc) + 16);
  serializeJson(doc, body);

  YieldingTlsClient client;            // yields while waiting (tls_psram.h)
  client.setInsecure();                 // encrypted but the cert is not verified (prototype)
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(GEMINI_TIMEOUT_MS);
  if (!http.begin(client, url)) { errOut = "http begin failed"; return -2; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + apiKey);
  if (provider == LLM_OPENROUTER) {
    http.addHeader("X-Title", "SnapRiddle");
  }

  uint32_t t0 = millis();
  client.setDeadline(LLM_TOTAL_DEADLINE_MS);   // wall-clock budget for POST + body
  errno = 0;
  int code = http.POST(body);
  const int postErrno = errno;          // capture before any logging can clobber it
  uint32_t dt = millis() - t0;          // headers only; the body is timed below

  if (code == HTTP_CODE_OK) {
    String raw = http.getString();
    uint32_t total = millis() - t0;
    if (client.deadlineHit()) {
      // the provider held the body open past the budget
      Serial.printf("[LLM] %s cut at %u ms (headers %u ms) — body never finished, treating as a hang\n",
                    model, (unsigned)total, (unsigned)dt);
      errOut = "reply exceeded the total deadline";
      code = HTTPC_ERROR_READ_TIMEOUT;   // -11 -> the wheel cools this model slot
    } else {
      JsonDocument resp;
      DeserializationError err = deserializeJson(resp, raw);
      if (err) {
        errOut = String("JSON ") + err.c_str();
      } else {
        contentOut = String((const char*)(resp["choices"][0]["message"]["content"] | ""));
        const char* fr = resp["choices"][0]["finish_reason"] | "?";
        Serial.printf("[LLM] %s %u ms total (headers %u ms) | request %u B | finish=%s | reply %u chars\n",
                      model, (unsigned)total, (unsigned)dt, (unsigned)body.length(), fr,
                      (unsigned)contentOut.length());
        if (strcmp(fr, "length") == 0) {
          // log where the budget went (usually gpt-oss hidden reasoning)
          Serial.printf("[LLM] finish=length: completion_tokens=%d reasoning_tokens=%d cap=%d\n",
                        (int)(resp["usage"]["completion_tokens"] | -1),
                        (int)(resp["usage"]["completion_tokens_details"]["reasoning_tokens"] | -1),
                        maxTokens);
        }
        if (!contentOut.length()) errOut = "no text in reply";
      }
    }
  } else if (client.deadlineHit()) {
    Serial.printf("[LLM] %s cut at %u ms — no response headers within the total deadline\n",
                  model, (unsigned)(millis() - t0));
    errOut = "no response within the total deadline";
    code = HTTPC_ERROR_READ_TIMEOUT;
  } else {
    String detail = (code > 0) ? http.getString() : String(http.errorToString(code));
    if (code > 0) {
      JsonDocument resp;
      if (!deserializeJson(resp, detail)) {
        const char* msg = resp["error"]["message"] | "";
        if (msg[0]) detail = msg;
      }
    }
    Serial.printf("[LLM] %s %u ms | request %u B\n", model, (unsigned)dt, (unsigned)body.length());
    Serial.println("[LLM] RAW " + String(code) + ": " + detail.substring(0, 220));
    errOut = detail.substring(0, 120);
  }
  const bool cut = client.deadlineHit();
  if (code < 0 && !cut) tlsLogFailure("LLM", client, code, postErrno);
  http.end();
  // a deadline-cut client reports "disconnected", so http.end() skipped stop();
  // close the socket here or it leaks
  if (cut) { client.setDeadline(0); client.stop(); }
  return code;
}
