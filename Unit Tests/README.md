## This folder contains validation tests done to check sensors and hardware parts

Each sketch tests one hardware part or cloud service on its own, without the game. Flash it from the Arduino IDE with the same board settings as the main firmware (XIAO_ESP32S3, PSRAM = OPI PSRAM). When something stops working in the full system, running these one by one narrows down the faulty part by elimination.

Sketches that need WiFi or a key have placeholder credentials at the top of the file. Fill them in locally before flashing.

| Result | Sketch | What it tests | Needs |
|---|---|---|---|
| success | `CameraWebServer/` | Camera works and captures images (Espressif's CameraWebServer example) | WiFi |
| success | `I2Saudio_radio_test` | Speaker output: plays internet radio through the MAX98357A | WiFi |
| success | `I2Saudio_short_TTS_test` | Speaker output: speaks a short text with Google TTS | WiFi |
| lags and cuts off a bit | `I2Saudio_long_TTS_tests/I2Saudio_Google_TTS_test` | Long text with Google TTS, split into chunks under 100 characters | WiFi |
| muffled and distorted voice | `I2Saudio_long_TTS_tests/WitAITTS_test` | Text up to 200 characters with Wit.ai TTS (third-party example sketch) | WiFi, Wit.ai token |
| success | `I2Saudio_long_TTS_tests/I2Saudio_local_EdgeTTS_test` | Long text from a local Docker `openai-edge-tts` server. Latency grows linearly with text length. [Details](./I2Saudio_long_TTS_final_test/README.md) | WiFi, Docker on the PC |
| success | `I2Saudio_long_TTS_final_test` | The voice setup the game is based on: streaming from the local TTS relay for text up to 1500 encoded characters, with Docker `openai-edge-tts` as a fallback. [Details](./I2Saudio_long_TTS_final_test/README.md) | WiFi, `tts_relay` on the PC |
| success | `GeminiCall_test/simpleGeminiCall.ino` | Gemini call: text typed in the Serial Monitor goes to Gemini, with a manual retry | WiFi, Gemini key |
| success | `GeminiCall_test/GeminiCallRotation_test.ino` | Same as above, rotating through several API keys and models to get past rate limits | WiFi, Gemini keys |
| success | `CamGemini_test` | Camera to Gemini: Gemini gets a camera frame plus a text prompt, and the captured image can be viewed on the camera web server | WiFi, Gemini key |
| success | `Button_test` | Button: prints 0 while pressed and 1 otherwise on the Serial Monitor | nothing |
| success | `StreamProbe_test/StreamProbe_test.ino` | Camera and local stream: the HTTP MJPEG stream (`:81/stream`) runs at 15-20 FPS with stable RAM when there is no cloud traffic. `dual-path-probe.html` compares it with the snapshot path in a browser. | WiFi |
| success | `FirebasePreviewTest/FirebasePreviewTest.ino` | HTTPS cloud snapshot relay: captures QVGA frames, encodes them as Base64 and PUTs them to Firebase. The ~40-45 KB TLS handshake per upload caps the rate at about 1 FPS, which is why the game shows the board's local stream instead. | WiFi, Firebase URL |

The speaker and button tests use the same wiring as the main firmware: see the [pin mapping](../Documentation/connection%20diagram/pin_mapping.md).
