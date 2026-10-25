// Physical action button, scanned on Core 1.
// Gestures: single = capture/retake, double = Countdown Capture, long = hint.
// The host re-checks game state for every event, so a mis-tap cannot break a turn.
// A lone single press is emitted BTN_DOUBLE_GAP_MS after release so it can be
// told apart from a double; 350 ms is invisible in a camera game.
#pragma once
#include <Arduino.h>
#include "parameters.h"

enum BtnEvent : uint8_t {
  BTN_NONE = 0,
  BTN_SINGLE,
  BTN_DOUBLE,
  BTN_LONG
};

static bool     btnPressedStable = false;
static bool     btnLastRaw       = true;    // INPUT_PULLUP: idle reads HIGH
static uint32_t btnLastChangeMs  = 0;
static uint32_t btnPressStartMs  = 0;
static bool     btnLongFired     = false;

static bool     btnAwaitSecond   = false;
static uint32_t btnSecondDeadlineMs = 0;
static bool     btnSecondSeen    = false;

static void buttonInit() {
  pinMode(BTN_GND, OUTPUT);
  digitalWrite(BTN_GND, LOW);              // ground return for the button (Button_test wiring)
  pinMode(BTN_PIN, INPUT_PULLUP);
  btnLastRaw = digitalRead(BTN_PIN);
  btnPressedStable = (btnLastRaw == LOW);
  Serial.println("[BTN] ready on GPIO6 (virtual GND GPIO5) — single=snap · double=countdown · long=hint");
}

// Call every loop iteration; returns at most one gesture per call.
static BtnEvent buttonScan() {
  BtnEvent ev = BTN_NONE;
  bool raw = digitalRead(BTN_PIN);
  uint32_t now = millis();

  if (raw != btnLastRaw) {
    btnLastRaw = raw;
    btnLastChangeMs = now;
  }
  if (now - btnLastChangeMs < BTN_DEBOUNCE_MS) return BTN_NONE;

  bool pressed = (raw == LOW);

  if (btnAwaitSecond && !btnSecondSeen && !pressed && now >= btnSecondDeadlineMs) {
    btnAwaitSecond = false;
    return BTN_SINGLE;
  }

  if (pressed != btnPressedStable) {
    btnPressedStable = pressed;
    if (pressed) {
      if (btnAwaitSecond && now <= btnSecondDeadlineMs) {
        btnSecondSeen = true;
      }
      btnPressStartMs = now;
      btnLongFired = false;
    } else {
      uint32_t held = now - btnPressStartMs;
      if (btnLongFired) {
        btnAwaitSecond = false;
        btnSecondSeen = false;
      } else if (held < BTN_LONG_MS) {
        if (btnAwaitSecond && btnSecondSeen) {
          btnAwaitSecond = false;
          btnSecondSeen = false;
          ev = BTN_DOUBLE;
        } else {
          btnAwaitSecond = true;
          btnSecondSeen = false;
          btnSecondDeadlineMs = now + BTN_DOUBLE_GAP_MS;
        }
      }
    }
  } else if (pressed) {
    if (!btnLongFired && now - btnPressStartMs >= BTN_LONG_MS) {
      btnLongFired = true;
      btnAwaitSecond = false;              // a long press cancels a half-finished double
      btnSecondSeen = false;
      ev = BTN_LONG;
    }
  }
  return ev;
}
