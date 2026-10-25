#include "Arduino.h"
#include "WiFi.h"
#include "Audio.h"

// I2S speaker test: streams internet radio through the MAX98357A.
// Pass: music plays. Fill in WiFi credentials before flashing.
const char* ssid     = "***********";
const char* password = "***********";

// MAX98357A wiring, same pins as the main firmware
#define I2S_LRC  9
#define I2S_BCLK 8
#define I2S_DOUT 7

Audio audio;

void setup() {
    Serial.begin(115200);
    delay(1000);

    WiFi.begin(ssid, password);
    Serial.print("Connecting to WiFi");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");

    audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
    audio.setVolume(15); // 0..21

    audio.connecttohost("http://stream.radioparadise.com/mp3-128"); 
}

void loop() {
    audio.loop();
}

// optional debug hook for stream info
void audio_info(const char *info){
    Serial.print("info        "); Serial.println(info);
}