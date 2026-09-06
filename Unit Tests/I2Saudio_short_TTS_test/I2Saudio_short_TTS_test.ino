#include "Arduino.h"
#include "Audio.h"
#include "WiFi.h"

#define I2S_DOUT            7
#define I2S_BCLK            8
#define I2S_LRC             9

Audio audio;

String ssid =     "*****";
String password = "*****";

void my_audio_info(Audio::msg_t m) {
    Serial.printf("%s: %s\n", m.s, m.msg);
}

void setup() {
    Audio::audio_info_callback = my_audio_info;
    Serial.begin(115200);
    WiFi.begin(ssid.c_str(), password.c_str());
    while (WiFi.status() != WL_CONNECTED) delay(1500);
    audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
    audio.setVolume(14); // default 0...21
    audio.connecttospeech("testing out a sample tts audio", "en"); // Google TTS
}

void loop() {
    audio.loop();
    vTaskDelay(1);
}