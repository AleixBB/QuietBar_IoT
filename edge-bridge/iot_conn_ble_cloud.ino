#include <ArduinoBLE.h>

// UUIDs del servei i de les dues característiques de la nRF52840 (QuietBar PoC)
const char* serviceUUID   = "12345678-1234-5678-1234-56789abcdef0";
const char* soundCharUUID = "12345678-1234-5678-1234-56789abcdef1"; // Micròfon Grove v1.0 (ADC uint16_t)
const char* accelCharUUID = "12345678-1234-5678-1234-56789abcdef2"; // Acceleròmetre MPU6050 (m/s2 * 100 uint16_t)

uint16_t latestSoundAdc = 0;
float latestAccelMs2 = 0.0f;
bool hasNewSound = false;
bool hasNewAccel = false;

void setup() {
  Serial.begin(115200);
  while (!Serial);

  if (!BLE.begin()) {
    Serial.println("Error en iniciar BLE a l'Arduino UNO Q");
    while (1);
  }

  Serial.println("Cercant emissor BLE QuietBar per UUID...");
  BLE.scanForUuid(serviceUUID);
}

void loop() {
  BLEDevice peripheral = BLE.available();

  if (peripheral) {
    BLE.stopScan();
    Serial.print("nRF52840 detectada. MAC: ");
    Serial.println(peripheral.address());

    if (peripheral.connect()) {
      Serial.println("¡Connexió BLE establerta!");
    } else {
      Serial.println("Error en connectar. Reiniciant cerca...");
      BLE.scanForUuid(serviceUUID);
      return;
    }

    if (peripheral.discoverAttributes()) {
      BLECharacteristic soundChar = peripheral.characteristic(soundCharUUID);
      BLECharacteristic accelChar = peripheral.characteristic(accelCharUUID);

      if (soundChar && accelChar && soundChar.canSubscribe() && accelChar.canSubscribe()) {
        soundChar.subscribe();
        accelChar.subscribe();
        Serial.println("Subscrit a les notificacions de Soroll i Acceleració.");

        while (peripheral.connected()) {
          // 1. Lectura de Soroll (Micròfon Grove v1.0)
          if (soundChar.valueUpdated()) {
            uint16_t sound_val = 0;
            soundChar.readValue(&sound_val, sizeof(sound_val));
            latestSoundAdc = sound_val;
            hasNewSound = true;

            Serial.print("[SOROLL GROVE] Amplitud ADC: ");
            Serial.println(sound_val);
          }

          // 2. Lectura d'Acceleració (MPU6050)
          if (accelChar.valueUpdated()) {
            uint16_t raw_accel = 0;
            accelChar.readValue(&raw_accel, sizeof(raw_accel));
            latestAccelMs2 = raw_accel / 100.0f;
            hasNewAccel = true;

            Serial.print("Vibració: ");
            Serial.print(latestAccelMs2, 2);
            Serial.println(" m/s2");
          }

          // 3. Emetem trama JSON unificada per al pont Cloud / Azure
          if (hasNewSound && hasNewAccel) {
            hasNewSound = false;
            hasNewAccel = false;
            Serial.print("{\"venueId\":\"ven-001\",\"tableId\":\"T1\",\"soundAdc\":");
            Serial.print(latestSoundAdc);
            Serial.print(",\"accelMs2\":");
            Serial.print(latestAccelMs2, 2);
            Serial.println("}");
          }
        }
      }
    }

    Serial.println("Desconnectat. Cercant de nou...");
    BLE.scanForUuid(serviceUUID);
  }
}
