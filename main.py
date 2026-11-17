import asyncio
import requests
from bleak import BleakScanner, BleakClient

CLOUD_URL = "https://quietvenue-backend-uab-avdfehandwdrf3dm.spaincentral-01.azurewebsites.net/api/telemetry"
SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0"
SOUND_UUID   = "12345678-1234-5678-1234-56789abcdef1"
ACCEL_UUID   = "12345678-1234-5678-1234-56789abcdef2"

state = {"sound": None, "accel": None}

def send_to_cloud():
    payload = {
        "venueId": "ven-001",
        "tableId": "T1",
        "soundAdc": state["sound"],
        "accelMs2": round(state["accel"], 2),
        "source": "hardware_live",
    }
    try:
        r = requests.post(CLOUD_URL, json=payload, timeout=5)
        print(f"[CLOUD {r.status_code}] {payload}")
    except requests.RequestException as e:
        print(f"[CLOUD ERROR] {e}")
    state["sound"] = state["accel"] = None

def on_sound(_, data: bytearray):
    state["sound"] = int.from_bytes(data[:2], "little")
    if state["accel"] is not None:
        send_to_cloud()

def on_accel(_, data: bytearray):
    state["accel"] = int.from_bytes(data[:2], "little") / 100.0
    if state["sound"] is not None:
        send_to_cloud()

async def main():
    while True:
        print("Buscando emisor BLE QuietBar...")
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: SERVICE_UUID.lower() in [u.lower() for u in ad.service_uuids],
            timeout=15,
        )
        if device is None:
            continue
        print(f"nRF52840 detectada: {device.address}")
        try:
            async with BleakClient(device) as client:
                await client.start_notify(SOUND_UUID, on_sound)
                await client.start_notify(ACCEL_UUID, on_accel)
                print("Suscrito a sonido y aceleración.")
                while client.is_connected:
                    await asyncio.sleep(1)
        except Exception as e:
            print(f"[BLE] {e}")
        print("BLE desconectado. Reintentando...")
        await asyncio.sleep(2)

asyncio.run(main())
