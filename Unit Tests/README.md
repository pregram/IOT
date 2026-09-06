## This folder contains Valdation tests done to check sensors/hardware parts

Validation sketches for the individual hardware components. Flash each one on
its own (Arduino IDE, same board settings as the main firmware) to verify a
part in isolation - useful for elimination-style debugging when something
stops working.

| Status | Sketch | What it tests |
|---|---|---|
| success | `CameraWebServer/` | verifies that camera works (captures image) |
| success | `I2Saudio_radio_test` | audio output test - plays radio audio through speaker |
| success | `I2Saudio_short_TTS_test` | audio output test - plays short text via TTS through speaker |
| lags & cuts off a bit | `I2Saudio_long_TTS_test` | audio output test - plays long text via TTS through speaker |
