#!/usr/bin/env python3
"""
QuietVenue PoC — Pont Edge en Temps Real (Arduino UNO Q -> Cloud Azure / Localhost)
===================================================================================
Aquest script llegeix en temps real les dades que l'Arduino UNO Q rep per BLE
des de la placa Nordic nRF52840-DK (sketch iot_conn_ble.ino) a través del port
Sèrie (USB / UART) i les envia immediatament al Backend (Azure o localhost:4000).

Accepta tant el format de text actual d'iot_conn_ble.ino:
  [SOROLL GROVE] Amplitud ADC: 45
  Vibració: 2.35 m/s2
com el format JSON directe:
  {"soundAdc": 45, "accelMs2": 2.35}

Ús:
  pip install pyserial requests
  python serial_to_azure_bridge.py --port COM3 --url http://localhost:4000
  (O cap a Azure: python serial_to_azure_bridge.py --port COM3 --url https://el-teu-app.azurewebsites.net)
"""

import argparse
import json
import re
import time
import urllib.request

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None


def send_telemetry(backend_url: str, venue_id: str, table_id: str, sound_adc: int, accel_ms2: float):
    endpoint = f"{backend_url.rstrip('/')}/api/telemetry"
    payload = {
        "venueId": venue_id,
        "tableId": table_id,
        "soundAdc": int(sound_adc),
        "accelMs2": float(round(accel_ms2, 2)),
        "source": "hardware_live",
        "protocol": "Serial-Edge-HTTP"
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            cmd = body.get("commandAck", {})
            print(
                f"[CLOUD OK] ADC={sound_adc:4d} | Vib={accel_ms2:4.2f} m/s² "
                f"-> Estat LED={cmd.get('ledState')} | Interval={cmd.get('nextIntervalMs')} ms"
            )
    except Exception as err:
        print(f"[ERROR CLOUD] No s'ha pogut enviar a {endpoint}: {err}")


def main():
    parser = argparse.ArgumentParser(description="QuietVenue Edge Serial -> Cloud Bridge")
    parser.add_argument("--port", type=str, default="COM3", help="Port sèrie de l'Arduino UNO Q (ex: COM3 o /dev/ttyACM0)")
    parser.add_argument("--baud", type=int, default=115200, help="Baudrate (115200 per defecte)")
    parser.add_argument("--url", type=str, default="http://localhost:4000", help="URL del Backend (Local o Azure)")
    parser.add_argument("--venue", type=str, default="ven-001", help="ID del Bar (ven-001 per defecte)")
    parser.add_argument("--table", type=str, default="T1", help="ID de la Taula PoC (T1 per defecte)")
    args = parser.parse_args()

    if serial is None:
        print("ERROR: Cal instal·lar pyserial -> pip install pyserial")
        return

    print("=============================================================")
    print("  QuietVenue Edge Gateway Bridge (nRF52840 -> Arduino UNO Q) ")
    print(f"  Port Sèrie : {args.port} ({args.baud} bauds)")
    print(f"  Cloud URL  : {args.url}")
    print("=============================================================")

    regex_sound = re.compile(r"Amplitud ADC:\s*(\d+)", re.IGNORECASE)
    regex_accel = re.compile(r"Vibraci[oó]:\s*([0-9.]+)", re.IGNORECASE)

    last_sound_adc = 0
    last_accel_ms2 = 0.0

    while True:
        try:
            with serial.Serial(args.port, args.baud, timeout=1) as ser:
                print(f"[CONNECTAT] Escoltant dades BLE de l'Arduino UNO Q a {args.port}...")
                while True:
                    line = ser.readline().decode("utf-8", errors="ignore").strip()
                    if not line:
                        continue

                    print(f"[ARDUINO] {line}")

                    # 1. Si l'Arduino envia directament una línia JSON:
                    if line.startswith("{") and line.endswith("}"):
                        try:
                            obj = json.loads(line)
                            last_sound_adc = int(obj.get("soundAdc", obj.get("sound_val", last_sound_adc)))
                            last_accel_ms2 = float(obj.get("accelMs2", obj.get("accel_ms2", last_accel_ms2)))
                            send_telemetry(args.url, args.venue, args.table, last_sound_adc, last_accel_ms2)
                            continue
                        except Exception:
                            pass

                    # 2. Si l'Arduino usa el format original d'iot_conn_ble.ino:
                    m_sound = regex_sound.search(line)
                    if m_sound:
                        last_sound_adc = int(m_sound.group(1))

                    m_accel = regex_accel.search(line)
                    if m_accel:
                        last_accel_ms2 = float(m_accel.group(1))
                        # A iot_conn_ble.ino la vibració s'imprimeix just després del soroll, enviem el paquet!
                        send_telemetry(args.url, args.venue, args.table, last_sound_adc, last_accel_ms2)

        except Exception as e:
            print(f"[ESPERANT ARDUINO] No s'ha pogut obrir {args.port} ({e}). Reintentant en 3s...")
            time.sleep(3)


if __name__ == "__main__":
    main()
