#include <ArduinoBLE.h>

// UUIDs del servei i de les dues característiques de la nRF52840
const char* serviceUUID   = "12345678-1234-5678-1234-56789abcdef0";
const char* soundCharUUID = "12345678-1234-5678-1234-56789abcdef1"; // Micro
const char* accelCharUUID = "12345678-1234-5678-1234-56789abcdef2"; // Accelerometre

void setup() {
  Serial.begin(115200);
  while (!Serial);

  if (!BLE.begin()) {
    Serial.println("Error en iniciar BLE a l'Arduino");
    while (1);
  }

  Serial.println("Cercant emissor BLE per UUID...");
  BLE.scanForUuid(serviceUUID);
}

void loop() {
  BLEDevice peripheral = BLE.available();

  if (peripheral) {
    BLE.stopScan();
    Serial.print("nRF52840 detectada. MAC: ");
    Serial.println(peripheral.address());

    Serial.println("Connectant...");
    if (peripheral.connect()) {
      Serial.println("¡Connexió establerta!");
    } else {
      Serial.println("Error en connectar. Reiniciant cerca...");
      BLE.scanForUuid(serviceUUID);
      return;
    }

    if (peripheral.discoverAttributes()) {
      // Obtenim les dues característiques
      BLECharacteristic soundChar = peripheral.characteristic(soundCharUUID);
      BLECharacteristic accelChar = peripheral.characteristic(accelCharUUID);
      
      if (soundChar && accelChar && soundChar.canSubscribe() && accelChar.canSubscribe()) {
        soundChar.subscribe();
        accelChar.subscribe();
        Serial.println("Subscrit a les notificacions de Soroll i Acceleració.");
        
        while (peripheral.connected()) {
          // Lectura de Soroll (Micròfon)
          if (soundChar.valueUpdated()) {
            uint16_t sound_val = 0;
            soundChar.readValue(&sound_val, sizeof(sound_val));

            Serial.print("[SOROLL GROVE] Amplitud ADC: ");
            Serial.println(sound_val);
          }

          // Lectura d'Acceleració (MPU6050)
          if (accelChar.valueUpdated()) {
            uint16_t raw_accel = 0;
            accelChar.readValue(&raw_accel, sizeof(raw_accel));

            float accel_ms2 = raw_accel / 100.0f;

            Serial.print("Vibració: ");
            Serial.print(accel_ms2, 2);
            Serial.println(" m/s2");
          }
        }
      } else {
        Serial.println("No s'han trobat les dues característiques o no permeten subscripció.");
      }
    } else {
      Serial.println("Error en descobrir atributs GATT.");
    }
    
    Serial.println("Desconnectat. Cercant de nou...");
    BLE.scanForUuid(serviceUUID);
  }
}
