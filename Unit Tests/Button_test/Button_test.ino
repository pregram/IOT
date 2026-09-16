/*
  XIAO ESP32-S3 Button Serial Test
  --------------------------------------------------
  Hardware Wiring:
  - Pushbutton Leg 1: Connected to GPIO 6 (pushbutton)
  - Pushbutton Leg 2: Connected to GPIO 5 (refpin / Virtual Ground)
  
  Behavior:
  - GPIO 5 is set to OUTPUT LOW (Virtual GND).
  - GPIO 6 uses INPUT_PULLUP.
  - Serial Monitor outputs '1' when released, '0' when pressed.
*/

const int pushbutton = 6; // Pin connected to button
const int refpin = 5;     // Pin acting as Virtual Ground (GND)

void setup() {
  Serial.begin(115200);

  // Configure refpin (Pin 5) as Virtual Ground
  pinMode(refpin, OUTPUT);
  digitalWrite(refpin, LOW);

  // Configure pushbutton pin with internal pull-up resistor
  pinMode(pushbutton, INPUT_PULLUP);
}

void loop() {
  // Read state: HIGH (1) when not pressed, LOW (0) when pressed
  int buttonState = digitalRead(pushbutton);

  // Print raw value directly to Serial
  Serial.println(buttonState);

  delay(100); // Prevents rapid scrolling in Serial Monitor
}