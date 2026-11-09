#!/usr/bin/env python3
"""
QuietVenue PoC — Servei Edge Autònom per al Linux intern de l'Arduino UNO Q 4GB
===============================================================================
L'Arduino UNO Q 4GB incorpora un processador Qualcomm Dragonwing amb Debian Linux
i Wi-Fi/BLE integrat a la mateixa placa, a més del microcontrolador STM32.

Si executes aquest script directament DINS del Linux de l'Arduino UNO Q (via SSH
o Arduino App Lab), la placa no necessita cap ordinador ni cable USB de dades:
  1. Llegeix per BLE la Nordic nRF52840-DK (o el pont sèrie intern /dev/ttyHS1).
  2. Envia les dades per Wi-Fi (MQTT port 1883 o HTTP POST port 4000) cap a Azure!

Instal·lació dins de l'Arduino UNO Q (Linux):
  pip install bleak requests paho-mqtt
  python3 uno_q_linux_ble_to_cloud.py --url https://el-teu-backend.azurewebsites.net
"""

import asyncio
import argparse
import json
import struct
import urllib.request

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    BleakScanner = None
    BleakClient = None

SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0"
SOUND_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef1"
ACCEL_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef2"


def post_to_cloud(backend_url: str, venue_id: str, table_id: str, sound_adc: int, accel_ms2: float):
    endpoint = f"{backend_url.rstrip('/')}/api/telemetry"
    payload = {
        "venueId": venue_id,
        "tableId": table_id,
        "soundAdc": int(sound_adc),
        "accelMs2": float(round(accel_ms2, 2)),
        "source": "hardware_live",
        "protocol": "UNO-Q-WiFi-HTTP"
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            ack = res.get("commandAck", {})
            print(f"[WIFI -> AZURE OK] ADC={sound_adc} | Vib={accel_ms2:.2f} m/s² -> LED={ack.get('ledState')}")
    except Exception as e:
        print(f"[WIFI ERROR] {e}")


async def run_ble_gateway(backend_url: str, venue_id: str, table_id: str):
    if BleakScanner is None:
        print("Instal·la bleak: pip install bleak")
        return

    state = {"sound": 0, "accel": 0.0, "got_sound": False, "got_accel": False}

    while True:
        print(f"[BLE] Cercant nRF52840 amb servei {SERVICE_UUID}...")
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: SERVICE_UUID.lower() in [u.lower() for u in (ad.service_uuids or [])]
            or (d.name and "QuietBar" in d.name)
        )

        if not device:
            await asyncio.sleep(2)
            continue

        print(f"[BLE] Trobada nRF52840 ({device.address}). Connectant...")
        try:
            async with BleakClient(device) as client:
                print("[BLE] Connectat! Subscrivint a notificacions GATT...")

                def on_sound(_, data: bytearray):
                    (val,) = struct.unpack("<H", data[:2])
                    state["sound"] = val
                    state["got_sound"] = True

                def on_accel(_, data: bytearray):
                    (raw_val,) = struct.unpack("<H", data[:2])
                    state["accel"] = raw_val / 100.0
                    state["got_accel"] = True
                    if state["got_sound"]:
                        state["got_sound"] = False
                        state["got_accel"] = False
                        post_to_cloud(backend_url, venue_id, table_id, state["sound"], state["accel"])

                await client.start_notify(SOUND_CHAR_UUID, on_sound)
                await client.start_notify(ACCEL_CHAR_UUID, on_accel)

                while client.is_connected:
                    await asyncio.sleep(1)
        except Exception as e:
            print(f"[BLE] Connexió perduda ({e}). Reintentant en 2s...")
            await asyncio.sleep(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:4000", help="URL del servidor Azure o local")
    parser.add_argument("--venue", default="ven-001")
    parser.add_argument("--table", default="T1")
    args = parser.parse_args()
    asyncio.run(run_ble_gateway(args.url, args.venue, args.table))
