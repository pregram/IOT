// Template only. Fill in your own values locally and never commit the filled copy.
// The real file is linked from ESP32/link_to_full_SECRETS.txt.
// parameters.h includes this file when present and falls back to placeholders
// otherwise, so the sketch still compiles but cannot reach WiFi or any LLM.
#pragma once

// WiFi: 2.4 GHz only, the ESP32 cannot see 5 GHz networks
static const char* WIFI_SSID     = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Gemini keys shared by the judge and riddle/hint generation.
// Fill up to 5 and set N_KEYS in parameters.h to the number you entered.
static const char* GEMINI_API_KEYS[5] = { "KEY1", "KEY2", "KEY3", "", "" };

// Fallback providers; leave a key empty to skip that provider
static const char* GROQ_API_KEY       = "";   // console.groq.com
static const char* OPENROUTER_API_KEY = "";   // openrouter.ai
