/*
 * QuietVenue PoC — Sketch Autònom per a Arduino (BLE -> Wi-Fi -> Cloud MQTT / HTTP)
 * =================================================================================
 * Aquest sketch permet que l'Arduino funcioni 100% sense ordinador (només alimentada
 * a corrent), rebent les notificacions BLE de la Nordic nRF52840-DK i enviant-les
 * directament per Wi-Fi al vostre servidor d'Azure (via MQTT al port 1883 o HTTP POST).
 *
 * Llibreries necessàries a l'Arduino IDE:
 *   - ArduinoBLE
 *   - ArduinoMqttClient (per enviar via MQTT com a Quiet_Architecture.png)
 *   - WiFi / WiFiS3 / WiFiNINA (segons el core de la placa seleccionat a Arduino IDE)
 */

#include <ArduinoBLE.h>
#include <ArduinoMqttClient.h>

#if defined(ARDUINO_UNOR4_WIFI)
  #include <WiFiS3.h>
#else
  #include <WiFi.h>
#endif

// ============================================================================
// 1. CONFIGURACIÓ WI-FI I SERVIDOR CLOUD (AZURE O IP LOCAL)
// ============================================================================
const char WIFI_SSID[]     = "NOM_DEL_TEU_WIFI";
const char WIFI_PASSWORD[] = "CONTRASENYA_WIFI";

// Posa aquí la IP pública de la teva Azure VM (o la IP del servidor local)
const char CLOUD_HOST[]    = "20.123.45.67"; // <-- Canvia per la IP/domini d'Azure
const int  MQTT_PORT       = 1883;
const int  HTTP_PORT       = 4000;
const char MQTT_TOPIC[]    = "quietvenue/telemetry";

// ============================================================================
// 2. UUIDs BLE DE LA NORDIC nRF52840-DK (definits a src/main.c)
// ============================================================================
const char* serviceUUID   = "12345678-1234-5678-1234-56789abcdef0";
const char* soundCharUUID = "12345678-1234-5678-1234-56789abcdef1"; // Micròfon Grove (uint16_t ADC)
const char* accelCharUUID = "12345678-1234-5678-1234-56789abcdef2"; // Acceleròmetre MPU6050 (uint16_t m/s2*100)

WiFiClient wifiClient;
MqttClient mqttClient(wifiClient);

uint16_t lastSoundAdc = 0;
float lastAccelMs2 = 0.0f;
bool soundUpdated = false;
bool accelUpdated = false;

// Connecta o reconnecta al Wi-Fi
void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("[WiFi] Connectant a ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connectat! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] No s'ha pogut connectar. Es reintentarà.");
  }
}

// Connecta o reconnecta al Broker MQTT del nostre Backend a Azure (port 1883)
void ensureMqttConnected() {
  ensureWiFiConnected();
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;

  Serial.print("[MQTT] Connectant al broker d'Azure ");
  Serial.print(CLOUD_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);

  if (!mqttClient.connect(CLOUD_HOST, MQTT_PORT)) {
    Serial.print("[MQTT] Error de connexió, codi: ");
    Serial.println(mqttClient.connectError());
  } else {
    Serial.println("[MQTT] Connectat al Broker Cloud!");
  }
}

// Publica el JSON cap al Backend per MQTT (i fa fallback a HTTP POST si cal)
void sendTelemetryToCloud(uint16_t soundAdc, float accelMs2) {
  ensureMqttConnected();

  // Construïm el JSON: {"venueId":"ven-001","tableId":"T1","soundAdc":45,"accelMs2":2.35}
  String payload = "{\"venueId\":\"ven-001\",\"tableId\":\"T1\",\"soundAdc\":";
  payload += String(soundAdc);
  payload += ",\"accelMs2\":";
  payload += String(accelMs2, 2);
  payload += ",\"source\":\"hardware_live\"}";

  // 1. Enviament via MQTT (port 1883)
  if (mqttClient.connected()) {
    mqttClient.beginMessage(MQTT_TOPIC);
    mqttClient.print(payload);
    mqttClient.endMessage();
    Serial.print("[CLOUD MQTT OK] ");
    Serial.println(payload);
    return;
  }

  // 2. Fallback directe via HTTP POST /api/telemetry (port 4000)
  if (WiFi.status() == WL_CONNECTED && wifiClient.connect(CLOUD_HOST, HTTP_PORT)) {
    wifiClient.println("POST /api/telemetry HTTP/1.1");
    wifiClient.print("Host: ");
    wifiClient.println(CLOUD_HOST);
    wifiClient.println("Content-Type: application/json");
    wifiClient.print("Content-Length: ");
    wifiClient.println(payload.length());
    wifiClient.println("Connection: close");
    wifiClient.println();
    wifiClient.println(payload);
    wifiClient.stop();
    Serial.print("[CLOUD HTTP OK] ");
    Serial.println(payload);
  }
}

void setup() {
  // NOTA IMPORTANT: NO posem "while (!Serial);" perquè si l'Arduino no té
  // el cable USB connectat a un PC, "while (!Serial);" deixaria la placa bloquejada!
  Serial.begin(115200);
  delay(1000);

  ensureWiFiConnected();
  ensureMqttConnected();

  if (!BLE.begin()) {
    Serial.println("Error en iniciar BLE a l'Arduino");
    while (1);
  }

  Serial.println("Cercant emissor BLE QuietBar per UUID...");
  BLE.scanForUuid(serviceUUID);
}

void loop() {
  mqttClient.poll();

  BLEDevice peripheral = BLE.available();

  if (peripheral) {
    BLE.stopScan();
    Serial.print("nRF52840 detectada. MAC: ");
    Serial.println(peripheral.address());

    if (peripheral.connect()) {
      Serial.println("¡Connexió BLE establerta!");
    } else {
      BLE.scanForUuid(serviceUUID);
      return;
    }

    if (peripheral.discoverAttributes()) {
      BLECharacteristic soundChar = peripheral.characteristic(soundCharUUID);
      BLECharacteristic accelChar = peripheral.characteristic(accelCharUUID);

      if (soundChar && accelChar && soundChar.canSubscribe() && accelChar.canSubscribe()) {
        soundChar.subscribe();
        accelChar.subscribe();
        Serial.println("Subscrit a Soroll i Acceleració.");

        while (peripheral.connected()) {
          mqttClient.poll();

          if (soundChar.valueUpdated()) {
            uint16_t sound_val = 0;
            soundChar.readValue(&sound_val, sizeof(sound_val));
            lastSoundAdc = sound_val;
            soundUpdated = true;
          }

          if (accelChar.valueUpdated()) {
            uint16_t raw_accel = 0;
            accelChar.readValue(&raw_accel, sizeof(raw_accel));
            lastAccelMs2 = raw_accel / 100.0f;
            accelUpdated = true;
          }

          // Quan tenim nova lectura de la nRF52840, l'enviem per Wi-Fi al Cloud!
          if (soundUpdated && accelUpdated) {
            soundUpdated = false;
            accelUpdated = false;
            sendTelemetryToCloud(lastSoundAdc, lastAccelMs2);
          }
        }
      }
    }

    Serial.println("BLE desconnectat. Cercant de nou...");
    BLE.scanForUuid(serviceUUID);
  }
}
