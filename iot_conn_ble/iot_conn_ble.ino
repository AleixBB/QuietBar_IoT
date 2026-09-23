#include <ArduinoBLE.h>

const char* serviceUUID = "12345678-1234-5678-1234-56789abcdef0";
const char* charUUID    = "12345678-1234-5678-1234-56789abcdef1";

void setup() {
  Serial.begin(115200);
  while (!Serial);

  if (!BLE.begin()) {
    Serial.println("Error al iniciar BLE en la Arduino UNO Q");
    while (1);
  }

  Serial.println("Buscando emisor BLE por UUID...");
  BLE.scanForUuid(serviceUUID);
}

void loop() {
  BLEDevice peripheral = BLE.available();

  if (peripheral) {
    // Al coincidir el UUID, detenemos el escaneo y nos conectamos directamente
    BLE.stopScan();
    Serial.print("nRF52840 detectada. MAC: ");
    Serial.println(peripheral.address());

    Serial.println("Conectando...");
    if (peripheral.connect()) {
      Serial.println("¡Conexión establecida!");
    } else {
      Serial.println("Error al conectar. Reiniciando escaneo...");
      BLE.scanForUuid(serviceUUID);
      return;
    }

    if (peripheral.discoverAttributes()) {
      BLECharacteristic soundChar = peripheral.characteristic(charUUID);
      
      if (soundChar && soundChar.canSubscribe()) {
        soundChar.subscribe();
        Serial.println("Suscrito a notificaciones.");
        
        while (peripheral.connected()) {
          if (soundChar.valueUpdated()) {
            uint16_t valor_mv = 0;
            soundChar.readValue(&valor_mv, sizeof(valor_mv));

            Serial.print("Dato BLE recibido: ");
            Serial.print(valor_mv);
            Serial.println(" mV_pp");
          }
        }
      } else {
        Serial.println("No se pudo suscribir a la característica.");
      }
    } else {
      Serial.println("Fallo al descubrir atributos GATT.");
    }
    
    Serial.println("Desconectado. Buscando de nuevo...");
    BLE.scanForUuid(serviceUUID);
  }
}