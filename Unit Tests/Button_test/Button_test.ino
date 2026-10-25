/*
  Button test (XIAO ESP32-S3). Wiring: leg 1 -> GPIO 6, leg 2 -> GPIO 5.
  GPIO 5 is driven LOW as a virtual ground, so the button needs no GND wire.
  Pass: Serial Monitor prints 1 while released and 0 while pressed.
*/

const int pushbutton = 6;
const int refpin = 5;

void setup() {
  Serial.begin(115200);

  pinMode(refpin, OUTPUT);
  digitalWrite(refpin, LOW);

  pinMode(pushbutton, INPUT_PULLUP);
}

void loop() {
  int buttonState = digitalRead(pushbutton);

  Serial.println(buttonState);

  delay(100); // slows the Serial Monitor scroll
}