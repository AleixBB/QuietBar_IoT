import asyncio
import requests
from bleak import BleakScanner, BleakClient

CLOUD_URL = "https://quietvenue-backend-uab-avdfehandwdrf3dm.spaincentral-01.azurewebsites.net/api/telemetry"
SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0"
SOUND_UUID   = "12345678-1234-5678-1234-56789abcdef1"
ACCEL_UUID   = "12345678-1234-5678-1234-56789abcdef2"
ML_CLASS_UUID= "12345678-1234-5678-1234-56789abcdef3"

# Ordre alfabètic exacte de les classes a Edge Impulse
CLASS_LABELS = {0: "cop", 1: "silenci", 2: "veu", 255: "incert"}

state = {"sound": None, "accel": None, "ml_class": None}

def send_to_cloud():
    payload = {
        "venueId": "ven-001",
        "tableId": "T1",
        "soundAdc": state["sound"],
        "accelMs2": round(state["accel"], 2),
        "mlClass": CLASS_LABELS.get(state["ml_class"], "desconegut"),
        "source": "hardware_live",
    }
    try:
        r = requests.post(CLOUD_URL, json=payload, timeout=5)
        print(f"[CLOUD {r.status_code}] {payload}")
    except requests.RequestException as e:
        print(f"[CLOUD ERROR] {e}")
    state["sound"] = state["accel"] = state["ml_class"] = None

def try_send():
    if state["sound"] is not None and state["accel"] is not None and state["ml_class"] is not None:
        send_to_cloud()

def on_sound(_, data: bytearray):
    state["sound"] = int.from_bytes(data[:2], "little")
    try_send()

def on_accel(_, data: bytearray):
    state["accel"] = int.from_bytes(data[:2], "little") / 100.0
    try_send()

def on_ml_class(_, data: bytearray):
    state["ml_class"] = data[0]
    try_send()

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
                await client.start_notify(ML_CLASS_UUID, on_ml_class)
                print("Suscrito a sonido, aceleración y clase IA.")
                while client.is_connected:
                    await asyncio.sleep(1)
        except Exception as e:
            print(f"[BLE] {e}")
        print("BLE desconectado. Reintentando...")
        await asyncio.sleep(2)

asyncio.run(main())