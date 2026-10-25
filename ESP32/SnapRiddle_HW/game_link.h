// Core 1 glue: button dispatch, the voice-settings handoff and the serial console.
// Core 1 reaches Core 0 only through the mailboxes in tts_engine.h / cloud_link.h,
// never through shared Audio or HTTP objects.
#pragma once
#include <Arduino.h>
#include "parameters.h"
#include "cloud_link.h"
#include "camera_srv.h"

// netTask applies camera registers; voice settings are applied here because the
// Audio object lives on Core 1.
static void consumeVoiceSettings() {
  if (!g_voicePend) return;
  g_voicePend = false;
  const String pendProfile = getVoicePendProfile();
  if (pendProfile.length()) {
    currentVoice = voiceForProfile(pendProfile);   // language auto-detect still applies per line
    Serial.printf("[SET] cloud voice profile=%s → %s\n",
                  pendProfile.c_str(), currentVoice.c_str());
  }
  if (g_voicePendSpeed > 0) setSpeed(g_voicePendSpeed);
  if (g_voicePendVol >= 0) setSpeakerVolume(g_voicePendVol);
}

static void dispatchButton(BtnEvent ev) {
  if (ev == BTN_NONE) return;
  GameMirror m; copyMirror(m);
  const char* name = ev == BTN_SINGLE ? "SINGLE" : ev == BTN_DOUBLE ? "DOUBLE" : "LONG";
  Serial.printf("[BTN] %s (state=%s unclear=%d lock=%s)\n",
                name, m.state.c_str(), m.unclear ? 1 : 0, m.lock.length() ? m.lock.c_str() : "-");
  // Buttons are locked while the riddle is read, while the host has paused the turn
  // and while a hint plays (the web's buttonLock()). The host re-checks the same gate
  // on its own state, since this mirror can lag the room by ~1 s.
  if (m.valid && m.state == "ACTIVE_TURN" && m.lock.length()) {
    Serial.printf("[BTN] ignored — buttons locked (%s)\n", m.lock.c_str());
    return;
  }

  if (ev == BTN_SINGLE || ev == BTN_DOUBLE) {
    // SINGLE = snap during a turn, or instant retake after an "unclear" verdict.
    // DOUBLE = Countdown Capture: the host pauses the clock, runs the countdown and
    // fires the photo itself. It works in the retake window too.
    if (m.valid && m.room.length() &&
        (m.state == "ACTIVE_TURN" || (m.state == "ROUND_RESULTS" && m.unclear))) {
      // While the riddle is still being generated there is nothing to judge the photo
      // against, and a queued capture_request would freeze the host. Drop the press.
      if (m.state == "ACTIVE_TURN" && (m.riddle.isEmpty() || m.target.isEmpty())) {
        Serial.println("[BTN] ignored — no riddle armed yet (waiting for Gemini)");
        return;
      }
      g_reqCountdown = (ev == BTN_DOUBLE) ? (m.countdown > 0 ? m.countdown : 3) : 0;
      g_reqCapture = true;
      if (ev == BTN_DOUBLE) {
        Serial.printf("[BTN] → countdown capture_request queued (%u s)\n",
                      (unsigned)g_reqCountdown);
      } else {
        Serial.println("[BTN] → capture_request queued");
      }
    } else {
      Serial.println("[BTN] ignored — no actionable state");
    }
  } else {
    if (m.valid && m.room.length() && m.state == "ACTIVE_TURN" && m.playerId.length()) {
      // Same gate as capture: a hint_request written before the riddle exists was never
      // consumed by the host and blocked the turn clock for the rest of the game.
      if (m.riddle.isEmpty() || m.target.isEmpty()) {
        Serial.println("[BTN] hint ignored — no riddle armed yet (waiting for Gemini)");
        return;
      }
      // One hint per long press. A held or bouncing button used to queue a second hint
      // seconds later and the room heard two hints back to back.
      static uint32_t s_lastHintBtnMs = 0;   // millis() of the last accepted hint
      uint32_t now = millis();
      if (s_lastHintBtnMs != 0 && now - s_lastHintBtnMs < HINT_MIN_GAP_MS) {
        Serial.printf("[BTN] hint ignored — one hint per press (next in %u s)\n",
                      (unsigned)((HINT_MIN_GAP_MS - (now - s_lastHintBtnMs)) / 1000) + 1);
        return;
      }
      s_lastHintBtnMs = now;
      g_reqHint = true;
      Serial.printf("[BTN] → hint_request queued for %s\n", m.player.c_str());
    } else {
      Serial.println("[BTN] hint ignored — no active player");
    }
  }
}

static void printHelp() {
  Serial.println("[SYS] cmds: '+'/'-' volume | 'vol 0..21' set | 'voice <name>' | "
                 "'lang en|he|ar' | 'speed 0.5..2.0' | 'stop' | 'status' | 'state' | "
                 "'snap' | 'judge' | 'resend' | 'say <text>' | 'help'. Any other line is spoken.");
}

static void handleSerialLine(const String& raw) {
  String line = raw; line.trim();
  if (!line.length()) return;
  String lower = line; lower.toLowerCase();

  if (lower == "+" || lower == "-") { setSpeakerVolume(currentVolume + (lower == "+" ? 1 : -1)); return; }
  if (lower == "vol")     { Serial.printf("[SET] volume=%d (0..21)\n", currentVolume); return; }
  if (lower.startsWith("vol "))   { setSpeakerVolume(line.substring(4).toInt()); return; }
  if (lower.startsWith("voice ")) { setVoiceName(line.substring(6)); return; }
  if (lower.startsWith("lang ")) {
    String lang = line.substring(5); lang.trim(); lang.toLowerCase();
    if      (lang == "en") setVoiceName(VOICE_EN);
    else if (lang == "he") setVoiceName(VOICE_HE);
    else if (lang == "ar") setVoiceName(VOICE_AR);
    else Serial.println("[SET] unknown lang (use en/he/ar)");
    return;
  }
  if (lower.startsWith("speed ")) { setSpeed(line.substring(6).toFloat()); return; }
  if (lower == "stop") { stopAudioSafely(); Serial.println("[SYS] playback stopped."); return; }

  if (lower == "state") {
    GameMirror m; copyMirror(m);
    Serial.printf("[MIRROR] valid=%d room=%s state=%s judge_phase=%u player=%s round=%d/%d\n",
                  m.valid, m.room.c_str(), m.state.c_str(), (unsigned)m.judgePhase,
                  m.player.c_str(), m.round, m.rounds);
    Serial.printf("[MIRROR] riddle=%s target=%s (%s/%s) time=%d/%d running=%d paused=%d unclear=%d\n",
                  m.riddle.c_str(), m.target.c_str(), m.difficulty.c_str(), m.theme.c_str(),
                  m.timeLeft, m.timeLimit, m.timerRunning, m.paused, m.unclear);
    Serial.printf("[SYS] judges_done=%u last_phase=%u cmd_id=%llu\n",
                  (unsigned)g_judgeCount, (unsigned)g_lastJudgeDone,
                  (unsigned long long)g_lastCmdId64);
    return;
  }
  if (lower == "snap") {
    int w = 0, h = 0;
    PsStr b64 = captureB64(&w, &h);
    Serial.printf("[SYS] snap %ux%u base64=%u chars\n", w, h, (unsigned)b64.length());
    return;
  }
  if (lower == "judge") {
    GameMirror m; copyMirror(m);
    if (!m.valid || m.riddle.isEmpty()) { Serial.println("[SYS] no live riddle in mirror"); return; }
    g_lastJudgeDone = 0;               // force re-judge
    Serial.println("[SYS] judge forced — see [JUDGE] lines from Core 0");
    return;
  }
  if (lower == "resend") {
    // Read a snapshot, not the live Strings: Core 0 reassigns that struct and a direct
    // read here could race it (double-free).
    PendJudgeSnapshot pj;
    snapshotPendJudge(pj);
    if (pj.valid) {
      if (pj.haveImage)
        Serial.printf("[PEND] holding the last JUDGE PHOTO for phase %u "
                      "(%u b64 chars, age %u s, tries %u)\n",
                      (unsigned)pj.phase, (unsigned)pj.imgLen,
                      (unsigned)((millis() - pj.savedMs) / 1000),
                      (unsigned)pj.tries);
      else
        Serial.printf("[PEND] holding the last VERDICT for phase %u "
                      "(age %u s, tries %u): %s\n",
                      (unsigned)pj.phase,
                      (unsigned)((millis() - pj.savedMs) / 1000),
                      (unsigned)pj.tries,
                      pj.feedback.c_str());
      g_pendJudge.lastTryMs = 0;       // scalar write only: retry on the next network cycle
    } else {
      Serial.println("[PEND] nothing waiting — no failed judge sends to re-send");
    }
    if (g_pendBtn.valid) {
      Serial.println("[PEND] a button event is also waiting to be delivered");
      g_pendBtn.lastTryMs = 0;
    }
    return;
  }
  if (lower.startsWith("say ")) { speak(line.substring(4)); return; }

  if (lower == "status") {
    PendJudgeSnapshot pj;
    snapshotPendJudge(pj);
    Serial.printf("[SYS] voice=%s speed=%.2f volume=%d | heap=%u min=%u | speaking=%d queued=%d\n",
                  currentVoice.c_str(), currentSpeed, currentVolume,
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                  (int)speaking, qCount);
    Serial.printf("[SYS] wifi=%s rssi=%d ip=%s time_synced=%d link=%d state=%s gen=%s pend=%s\n",
                  WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.RSSI(),
                  WiFi.localIP().toString().c_str(), g_timeSynced, g_linkUp,
                  getEspState().c_str(), getGenTask().c_str(),
                  (pj.valid || g_pendBtn.valid) ? "WAITING" : "none");
    return;
  }
  if (lower == "help") { printHelp(); return; }
  speak(line, currentVoice, currentSpeed);
}

static String serialBuf;
static void serialConsolePump() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuf.trim();
      if (serialBuf.length()) handleSerialLine(serialBuf);
      serialBuf = "";
    } else {
      serialBuf += c;
      if (serialBuf.length() > 1000) { Serial.println("[SYS] input too long, dropped."); serialBuf = ""; }
    }
  }
}
