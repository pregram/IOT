/*
 * WitAITTS ESP32-S3 Basic Example
 * 
 * Text-to-Speech using Wit.ai API on ESP32-S3
 * 
 * Copyright (c) 2025 Jobit Joseph, Circuit Digest
 * 
 * Hardware:
 * - ESP32-S3 Dev Board (e.g., ESP32-S3-DevKitC-1)
 * - MAX98357A I2S Amplifier or similar DAC
 * - Speaker (4-8 ohm, 3W recommended)
 * 
 * Default I2S Connections (ESP32-S3):
 * ESP32-S3 GPIO16 -> MAX98357A BCLK
 * ESP32-S3 GPIO17 -> MAX98357A LRC
 * ESP32-S3 GPIO15 -> MAX98357A DIN
 * MAX98357A VIN   -> 5V
 * MAX98357A GND   -> GND
 * 
 * Note: ESP32-S3 has many available GPIOs (0-48).
 * Default pins are 16, 17, 15 but can be changed.
 * 
 * Instructions:
 * 1. Update WiFi credentials below
 * 2. Get Wit.ai token from https://wit.ai
 * 3. Select "ESP32S3 Dev Module" in Arduino IDE
 * 4. Upload sketch
 * 5. Open Serial Monitor (115200 baud)
 * 6. Type any text and press Enter to hear it spoken
 */

#include <WitAITTS.h>

// ==================== CONFIGURATION ====================
// WiFi Credentials
const char* WIFI_SSID     = "****";
const char* WIFI_PASSWORD = "****";

// Wit.ai Token (get from https://wit.ai -> Your App -> Settings)
const char* WIT_TOKEN = "****";

// I2S Pins (default for ESP32-S3: BCLK=16, LRC=17, DIN=15)
// Uncomment to use custom pins:
#define CUSTOM_BCLK 8
#define CUSTOM_LRC  9
#define CUSTOM_DIN  7
// ========================================================

// Create TTS object with default pins (16, 17, 15 for S3)
// WitAITTS tts;

// Or with custom pins:
WitAITTS tts(CUSTOM_BCLK, CUSTOM_LRC, CUSTOM_DIN);

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("\n\n========================================");
    Serial.println("   WitAITTS ESP32-S3 Basic Example");
    Serial.println("   Copyright (c) 2025 Jobit Joseph");
    Serial.println("           Circuit Digest");
    Serial.println("========================================\n");
    
    // ==================== DEBUG LEVEL ====================
    // DEBUG_OFF     (0) - No output
    // DEBUG_ERROR   (1) - Errors only
    // DEBUG_INFO    (2) - Info messages (default)
    // DEBUG_VERBOSE (3) - All messages including network data
    tts.setDebugLevel(DEBUG_INFO);
    
    // Initialize TTS
    if (tts.begin(WIFI_SSID, WIFI_PASSWORD, WIT_TOKEN)) {
        Serial.println("✓ TTS Ready!\n");
        
        // ==================== VOICE CONFIGURATION ====================
        // Available Voices:
        // 
        // US English Female:
        //   wit$Remi      - Natural female (default)
        //   wit$Rebecca   - Professional female
        //   wit$Railey    - Friendly female
        //   wit$Rubie     - Warm female
        //   wit$Disaffected - Monotone female
        //   wit$Cartoon Kid - Playful child
        //   wit$Cartoon Villain - Evil female
        //   wit$Kenyan Accent - Kenyan English female
        // 
        // US English Male:
        //   wit$Cody      - Natural male
        //   wit$Charlie   - Friendly male
        //   wit$Cooper    - Professional male
        //   wit$Carl      - Casual male
        //   wit$Surfer    - Laid-back male
        //   wit$Vampire   - Spooky male
        //   wit$Prospector - Old western male
        //   wit$Southern Accent - US Southern male
        // 
        // UK English:
        //   wit$Pirate    - Pirate male (UK)
        //   wit$Wizard    - Fantasy male (UK)
        //   wit$British Butler - Formal male (UK)
        //   wit$Cockney Accent - Cockney nonbinary (UK)
        // 
        // Canadian English:
        //   wit$Rosie     - Canadian female
        //   wit$Colin     - Canadian male
        // 
        // Special:
        //   wit$Cartoon Baby - Baby voice (nonbinary)
        tts.setVoice("wit$Remi");
        
        // ==================== VOICE STYLE ====================
        // Available Styles:
        //   "default"   - Normal speaking voice
        //   "soft"      - Gentle, quiet tone
        //   "formal"    - Professional, clear
        //   "fast"      - Quick speaking pace
        //   "projected" - Loud, clear voice
        // Note: Not all voices support all styles
        tts.setStyle("default");
        
        // ==================== SPEED & PITCH ====================
        // Speed: 0-200 (100 = normal, <100 = slower, >100 = faster)
        // Pitch: 0-200 (100 = normal, <100 = lower, >100 = higher)
        tts.setSpeed(100);
        tts.setPitch(100);
        
        // ==================== VOLUME/GAIN ====================
        // Gain: 0.0 to 1.0 (0.0 = mute, 1.0 = max volume)
        tts.setGain(0.2);
        
        // ==================== SOUND EFFECTS (Optional) ====================
        // SFX Character - Transforms the voice:
        //   "none"     - No effect (default)
        //   "chipmunk" - High-pitched squeaky voice
        //   "monster"  - Deep growly voice
        //   "daemon"   - Dark demonic voice
        //   "robot"    - Mechanical robotic voice
        //   "alien"    - Otherworldly effect
        // tts.setSFXCharacter("none");
        
        // SFX Environment - Adds acoustic effects:
        //   "none"      - No effect (default)
        //   "reverb"    - Standard reverb
        //   "room"      - Small room acoustics
        //   "cathedral" - Large hall echo
        //   "radio"     - Radio/telephone quality
        //   "phone"     - Phone call simulation
        // tts.setSFXEnvironment("none");
        
        // Print current configuration
        tts.printConfig();
        
        Serial.println("Type any text and press Enter to speak:\n");
        
    } else {
        Serial.println("✗ TTS initialization failed!");
        Serial.println("Check WiFi credentials and Wit.ai token");
    }
}

void loop() {
    // IMPORTANT: Must call loop() for audio streaming on ESP32
    tts.loop();
    
    // Check for serial input
    if (Serial.available()) {
        String text = Serial.readStringUntil('\n');
        text.trim();
        
        if (text.length() > 0) {
            Serial.println("Speaking: " + text);
            tts.speak(text);
        }
    }
}
