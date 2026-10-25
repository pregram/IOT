// Cross-module flags. Definitions live in cloud_link.h; these declarations let
// headers included before it (camera_srv.h, gemini_rotation.h) use them.
#pragma once
#include <Arduino.h>

// Board state is touched by Core 0, Core 1 and the httpd task. A shared Arduino
// String there means concurrent free/realloc and a hard reboot mid-party, so it is
// a mutex-guarded fixed buffer and readers get a copy.
extern void   setEspState(const char* s);
extern String getEspState();
extern bool   g_settingsViaHttp;
extern volatile bool g_linkUp;
// Button events need real epoch-ms timestamps; until SNTP lands they are not sent.
extern volatile bool g_timeSynced;

// Set by setup() and cleared by netTask's first cycle, so the boot heartbeat's
// TLS work stays on Core 0.
extern volatile bool g_bootBeatPending;

// netTask speaks the "hardware online" line after its first poll, and only when no
// game is live, so a mid-game reboot does not talk over the round.
extern volatile bool g_bootLinePending;

// Settings drawer "Force Fallback Models": the provider wheel skips every Gemini model.
extern volatile bool g_forceFallback;

// Voice settings arrive on Core 0 but the Audio object lives on Core 1, so they are
// queued here behind a mutex.
extern void   setVoicePendProfile(const char* p);
extern String getVoicePendProfile();
extern volatile bool g_voicePend;
extern float         g_voicePendSpeed;
extern int           g_voicePendVol;

// The web sends each line through POST /speak first and only falls back to
// cmd/cmdq if that fails. claimCmdId() is a backstop: it bumps the same id floor
// that pollOnce() reads, so a line delivered by both paths is spoken once.
extern bool claimCmdId(uint64_t id);
