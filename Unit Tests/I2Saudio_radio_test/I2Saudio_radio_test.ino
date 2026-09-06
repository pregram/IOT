#include "Arduino.h"
#include "WiFi.h"
#include "Audio.h"

// Wi-Fi Credentials
const char* ssid     = "***********";
const char* password = "***********";


// Pin definitions matching step 3
#define I2S_LRC  9
#define I2S_BCLK 8
#define I2S_DOUT 7

Audio audio;

void setup() {
    Serial.begin(115200);
    delay(1000);

    // Connect to Wi-Fi
    WiFi.begin(ssid, password);
    Serial.print("Connecting to WiFi");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");

    // Configure I2S Speaker Output
    audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
    audio.setVolume(15); // Volume level 0-21

    // Example HTTP stream URL or direct audio URL test
    // To stream direct text-to-speech from Gemini, make your HTTP POST request 
    // to Gemini REST API and pass the audio stream handle to audio.connecttohost()
    audio.connecttohost("http://stream.radioparadise.com/mp3-128"); 
}

void loop() {
    // Keep the audio engine running continuously
    audio.loop();
}

// Optional audio callbacks for debugging
void audio_info(const char *info){
    Serial.print("info        "); Serial.println(info);
}