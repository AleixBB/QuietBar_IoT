#include <zephyr/kernel.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <stdio.h>
#include <math.h>

/* --- Parámetros de muestreo y umbrales --- */
#define SAMPLE_INTERVAL_MS       100   // 10 Hz para capturar movimiento y picos de sonido
#define BLE_NOTIFY_INTERVAL_MS   1000  // Notificación BLE cada 1 segundo
#define MOTION_THRESHOLD_MS2     2.1f  // Umbral de movimiento/arrastre
#define QUIET_SAMPLES_REQUIRED   50    // 5 segundos de silencio para volver a estado Normal

// UUIDs de 128 bits
#define BT_UUID_SOUND_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef0)
#define BT_UUID_SOUND_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)
#define BT_UUID_ACCEL_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef2)

#define BT_UUID_SOUND_SERVICE  BT_UUID_DECLARE_128(BT_UUID_SOUND_SERVICE_VAL)
#define BT_UUID_SOUND_CHAR     BT_UUID_DECLARE_128(BT_UUID_SOUND_CHAR_VAL)
#define BT_UUID_ACCEL_CHAR     BT_UUID_DECLARE_128(BT_UUID_ACCEL_CHAR_VAL)

// Variables que se enviarán por BLE
static uint16_t sound_level_val = 0;        // Amplitud de sonido (0 - 4095)
static uint16_t accel_magnitude_val = 0;    // Vibración (m/s2 * 100)
static struct bt_conn *current_conn = NULL;

// Especificación del canal ADC del Devicetree
static const struct adc_dt_spec adc_channel = ADC_DT_SPEC_GET(DT_PATH(zephyr_user));

static void ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);
    printk("BLE: Notificaciones %s\n", notif_enabled ? "activadas" : "desactivadas");
}

/* Servicio GATT con DOS Características: Sonido y Aceleración */
BT_GATT_SERVICE_DEFINE(quietbar_svc,
    BT_GATT_PRIMARY_SERVICE(BT_UUID_SOUND_SERVICE),

    /* Característica 1: Micrófono Grove (Sonido) -> Attr [2] */
    BT_GATT_CHARACTERISTIC(BT_UUID_SOUND_CHAR,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_READ, NULL, NULL, &sound_level_val),
    BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    /* Característica 2: Movimiento MPU6050 -> Attr [5] */
    BT_GATT_CHARACTERISTIC(BT_UUID_ACCEL_CHAR,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_READ, NULL, NULL, &accel_magnitude_val),
    BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

static void connected(struct bt_conn *conn, uint8_t err)
{
    if (err) {
        printk("Conexión BLE fallida (%u)\n", err);
        return;
    }
    printk("BLE: Dispositivo Central conectado\n");
    current_conn = bt_conn_ref(conn);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
    printk("BLE: Dispositivo desconectado (%u)\n", reason);
    if (current_conn) {
        bt_conn_unref(current_conn);
        current_conn = NULL;
    }
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected = connected,
    .disconnected = disconnected,
};

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_SOUND_SERVICE_VAL),
};

static float sensor_val_to_float(const struct sensor_value *val)
{
    return (float)val->val1 + ((float)val->val2 / 1000000.0f);
}

/* Función para medir la amplitud pico a pico de sonido con el micrófono Grove */
static uint16_t read_sound_amplitude(void)
{
    uint16_t buf;
    struct adc_sequence sequence = {
        .buffer = &buf,
        .buffer_size = sizeof(buf),
    };
    (void)adc_sequence_init_dt(&adc_channel, &sequence);

    uint16_t min_val = 4095;
    uint16_t max_val = 0;

    // Muestreo rápido de 20 lecturas para capturar la onda sonora
    for (int i = 0; i < 20; i++) {
        if (adc_read_dt(&adc_channel, &sequence) == 0) {
            if (buf < min_val) min_val = buf;
            if (buf > max_val) max_val = buf;
        }
        k_busy_wait(100); // 100 microsegundos entre muestras
    }

    return (max_val >= min_val) ? (max_val - min_val) : 0;
}

int main(void)
{
    int err;
    bool in_alert_mode = false;
    uint16_t quiet_sample_count = 0;
    uint32_t ble_notify_timer = 0;

    float gravity_baseline = 9.81f;

    const struct device *const accel_dev = DEVICE_DT_GET_ONE(invensense_mpu6050);

    if (!device_is_ready(accel_dev)) {
        printk("ERROR: MPU6050 no listo\n");
        return 0;
    }

    if (!adc_is_ready_dt(&adc_channel)) {
        printk("ERROR: ADC canal de sonido no listo\n");
        return 0;
    }

    err = adc_channel_setup_dt(&adc_channel);
    if (err < 0) {
        printk("Error configurando canal ADC (%d)\n", err);
        return 0;
    }

    err = bt_enable(NULL);
    if (err) {
        printk("Error inicializando Bluetooth (%d)\n", err);
        return 0;
    }

    err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
    if (err) {
        printk("Error iniciando anuncios BLE (%d)\n", err);
        return 0;
    }

    printk("Nodo QuietBar Activo: Sensor MPU6050 + Micrófono Grove. Anunciando BLE...\n");

    while (1) {
        /* --- 1. Lectura del Micrófono Grove --- */
        sound_level_val = read_sound_amplitude();

        /* --- 2. Lectura del Acelerómetro MPU6050 --- */
        struct sensor_value accel[3];
        if (sensor_sample_fetch(accel_dev) == 0) {
            sensor_channel_get(accel_dev, SENSOR_CHAN_ACCEL_XYZ, accel);

            float ax = sensor_val_to_float(&accel[0]);
            float ay = sensor_val_to_float(&accel[1]);
            float az = sensor_val_to_float(&accel[2]);

            float total_magnitude = sqrtf(ax * ax + ay * ay + az * az);
            float dynamic_accel = fabsf(total_magnitude - gravity_baseline);

            accel_magnitude_val = (uint16_t)(dynamic_accel * 100.0f);

            /* Lógica de estado Alerta/Normal por movimiento */
            if (dynamic_accel >= MOTION_THRESHOLD_MS2) {
                if (!in_alert_mode) {
                    in_alert_mode = true;
                    printk("!!! [ALERTA] MESA EN MOVIMIENTO !!! Dynamic Accel: %.2f m/s2 | Sonido: %u\n", 
                           dynamic_accel, sound_level_val);
                }
                quiet_sample_count = 0;
            } else {
                if (in_alert_mode) {
                    quiet_sample_count++;
                    if (quiet_sample_count >= QUIET_SAMPLES_REQUIRED) {
                        in_alert_mode = false;
                        quiet_sample_count = 0;
                        printk("[OK] Mesa de nuevo en reposo.\n");
                    }
                } else {
                    gravity_baseline = (gravity_baseline * 0.95f) + (total_magnitude * 0.05f);
                }
            }
        }

        /* --- 3. Notificación por Bluetooth (cada 1s) --- */
        ble_notify_timer += SAMPLE_INTERVAL_MS;
        if (ble_notify_timer >= BLE_NOTIFY_INTERVAL_MS) {
            ble_notify_timer = 0;

            if (current_conn) {
                // Notifica Sonido (Atributo [2])
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[2], &sound_level_val, sizeof(sound_level_val));
                // Notifica Movimiento (Atributo [5])
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[5], &accel_magnitude_val, sizeof(accel_magnitude_val));
            }

            printk("[ESTADO] Movimiento: %.2f m/s2 | Nivel Sonido: %u ADC\n", 
                   (float)accel_magnitude_val / 100.0f, sound_level_val);
        }

        k_msleep(SAMPLE_INTERVAL_MS);
    }

    return 0;
}
