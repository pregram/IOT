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
| lags & cuts off a bit | `I2Saudio_long_TTS_tests/I2Saudio_Google_TTS_test` | audio output test - plays long text via TTS through speaker |
| muffled & distorted voice | `I2Saudio_long_TTS_tests/WitAITTS_test` | audio output test - plays up to 200 characters text via TTS through speaker |
| success | `I2Saudio_long_TTS_tests/I2Saudio_local_EdgeTTS_test` | audio output test - plays long text via local Docker `openai-edge-tts` server, latency increases linearly with text input size. For [details click here](./I2Saudio_long_TTS_final_test/README.md) |
| success | `I2Saudio_long_TTS_final_test` | audio output test - audio streaming via local TTS relay server for text size <= 1500 characters and local Docker `openai-edge-tts` server as a fallback. For [details click here](./I2Saudio_long_TTS_final_test/README.md) |
| success | `GeminiCall_test/simpleGeminiCall.ino` | gemini call test - take input text via serial monitor and send to gemini with retry option in case of failure |
| success | `GeminiCall_test/GeminiCallRotation_test.ino` | gemini call test - same as above, with option to change api keys in a round robin bypassing rate limits |
| success | `CamGemini_test` | cam -> gemini test - gemini takes camera and text input, user views what camera captured via web cam server |
| success | `Button_test` | button test - pushing button prints 0 otherwise 1 is printed on serial monitor |
| success | `StreamProbe_test/StreamProbe_test.ino` | camera hardware & local stream test - proves local HTTP MJPEG stream (:81/stream) runs smoothly at 15–20 FPS with stable RAM when cloud overhead is removed |
| success | `FirebasePreviewTest/FirebasePreviewTest.ino` | HTTPS cloud snapshot relay test - captures QVGA frames, converts to Base64, and pushes to Firebase REST endpoint; proves ~40–45 KB TLS handshake overhead caps cloud rate at ~1 FPS |
