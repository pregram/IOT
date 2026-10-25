## Camera game: SnapRiddle, by Tamer Lucas Ataba, Adelin Ataba and Rom Dan (group 3A)

## Details about the project

SnapRiddle is a party game played around a TV. A small camera box built on a XIAO ESP32-S3 Sense reads a riddle out loud to one player at a time. The answer is something the player has to prove on camera: an object they grab, a quick sketch, a gesture, or the written answer to a puzzle. The box takes the photo, an AI vision model judges it, and the web app scores the turn while everyone else watches on the TV and reacts from their phones.

What the system does:

- The board writes every riddle on demand with an LLM (Gemini, with Groq and OpenRouter as fallbacks), anchored on the environment the host picked.
- The board judges the proof photo itself and writes the verdict to Firebase. The photo never passes through the database.
- A MAX98357A amplifier and a speaker give the game a voice. A small relay on the host PC synthesizes the lines with edge-tts and streams them to the board.
- One physical button: a single press takes the photo, a double press starts a Countdown Capture, a long press asks for a hint.
- The web app (host TV and player phones) runs the game: rooms with a PIN, turns, timers, scoring, adaptive difficulty, special rounds, reactions, a sound board and a victory screen with photo moments.
- The host and the board stay in sync through Firebase Realtime Database only. The board polls it over HTTPS, so the game does not depend on a direct link between the browser and the board.

## Folder description:

* ESP32: firmware for the board. `SnapRiddle_HW/` is the Arduino sketch, including `parameters.h` (all hard-coded parameters) and `SECRETS.h` (empty template for credentials). `compiled_program.bin` is a prebuilt image and `link_to_full_SECRETS.txt` links to the real secrets file.
* web_app: the Next.js web app (host TV screen and player phones).
* tts_relay: the Python server that turns the board's text into a streamed MP3 voice.
* Unit Tests: one sketch per hardware part or cloud service (camera, speaker, TTS, button, Gemini, Firebase), with results in its README.
* Documentation: user guide (with statuses and error messages), installation, developer guide, parameters, and the connection diagram.
* .github/workflows: GitHub Actions workflow that deploys `web_app` to GitHub Pages.

## Documentation:

* [User guide](Documentation/USER_GUIDE.md): how to play, screens, statuses, error messages
* [Installation](Documentation/INSTALLATION.md): Firebase, AI keys, relay, flashing, running the web app
* [Developer guide](Documentation/DEVELOPER_GUIDE.md): architecture, modules, database layout, data flows
* [Parameters](Documentation/PARAMETERS.md): the 15 most important parameters and where they live
* [Pin mapping](Documentation/connection%20diagram/pin_mapping.md)
* [Unit tests](Unit%20Tests/README.md)

## ESP32 SDK version used in this project:

Arduino-ESP32 core 3.3.11 (esp32 by Espressif Systems), based on ESP-IDF 5.5.5. Board XIAO_ESP32S3 with PSRAM set to OPI PSRAM, flash 8 MB, partition scheme "Default with spiffs (3MB APP/1.5MB SPIFFS)". Built with Arduino IDE 2.x.

## Arduino/ESP32 libraries used in this project:

* ArduinoJson - version 7.4.3
* ESP32-audioI2S (schreibfaul1, installed from the GitHub master branch) - version 4.0.0

Included with the Arduino-ESP32 3.3.11 core: WiFi, WiFiClientSecure, HTTPClient, LittleFS, esp32-camera (`esp_camera`), `esp_http_server`, mbedTLS.

Other parts of the project:

* TTS relay: Python 3.9+, fastapi >= 0.110, uvicorn[standard] >= 0.29, edge-tts >= 7.0.0
* Web app: Next.js 16.4.0, React 19.3.0, Firebase JS SDK 12.19.0, TypeScript 5.9.3, Tailwind CSS 4.3.3 (full list in `web_app/package.json`)

## Hardware components and quantities:

* Seeed Studio XIAO ESP32-S3 Sense (with its camera module and expansion board) - 1
* MAX98357A I2S amplifier board - 1
* Speaker - 1
* Tactile push button - 1
* Jumper wires - for the amplifier and button connections
* USB-C cable (power, flashing and serial) - 1

Also needed, but not part of the box: a PC on the same 2.4 GHz WiFi to run the TTS relay and the host screen, and the players' phones.

## Connection diagram:

![Connection diagram](Documentation/connection%20diagram/esp32_connection_diagram.svg)

Pin-by-pin details: [pin_mapping.md](Documentation/connection%20diagram/pin_mapping.md).

## Secrets:

`ESP32/SnapRiddle_HW/SECRETS.h` is committed only as a template with empty fields (WiFi, Gemini keys, Groq and OpenRouter keys). The filled-in file is linked from [`ESP32/link_to_full_SECRETS.txt`](ESP32/link_to_full_SECRETS.txt). The web app's optional "Test Gemini" key in `web_app/src/lib/aiConfig.ts` is also left empty.

## Installation in short:

1. Create a Firebase Realtime Database. Put its URL in `parameters.h` and the web config in `web_app/src/lib/firebase.ts`.
2. Fill in `SECRETS.h`, set `RELAY_HOST` in `parameters.h`, and flash the sketch from the Arduino IDE with the settings above.
3. Run the relay: `uvicorn tts_relay:app --host 0.0.0.0 --port 5051` in `tts_relay/`.
4. Run the web app: `npm ci && npm run dev` in `web_app/`, or let the workflow deploy it to GitHub Pages.

Full steps: [INSTALLATION.md](Documentation/INSTALLATION.md).

This project is part of ICST - The Interdisciplinary Center for Smart Technologies, Taub Faculty of Computer Science, Technion
https://icst.cs.technion.ac.il/
