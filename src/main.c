#include <zephyr/kernel.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <stdio.h>

#define ADC_NODE     DT_NODELABEL(adc)
#define ADC_CHANNEL  1
#define ADC_INPUT    1       // AIN1 (P0.03)

/* --- Parámetros de Muestreo Adaptativo QuietBar --- */
#define NORMAL_INTERVAL_MS     10000  // 30 segundos en estado normal
#define ALERT_INTERVAL_MS      2000   // 2 segundos en estado alerta
#define NOISE_THRESHOLD_MV     60     // Umbral en mV para activar modo alerta
#define QUIET_SAMPLES_REQUIRED 8      // 8 muestras * 2s = 16s requeridos de silencio

// UUIDs de 128 bits
#define BT_UUID_SOUND_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef0)
#define BT_UUID_SOUND_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)

#define BT_UUID_SOUND_SERVICE  BT_UUID_DECLARE_128(BT_UUID_SOUND_SERVICE_VAL)
#define BT_UUID_SOUND_CHAR     BT_UUID_DECLARE_128(BT_UUID_SOUND_CHAR_VAL)

static uint16_t sound_mv = 0;
static struct bt_conn *current_conn = NULL;

static void sound_ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);
    printk("BLE: Notificaciones %s\n", notif_enabled ? "activadas" : "desactivadas");
}

BT_GATT_SERVICE_DEFINE(sound_svc,
    BT_GATT_PRIMARY_SERVICE(BT_UUID_SOUND_SERVICE),
    BT_GATT_CHARACTERISTIC(BT_UUID_SOUND_CHAR,
                   BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                   BT_GATT_PERM_READ, NULL, NULL, &sound_mv),
    BT_GATT_CCC(sound_ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
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

static const struct device *adc_dev = DEVICE_DT_GET(ADC_NODE);
static int16_t sample;
static struct adc_sequence seq = {
    .channels    = BIT(ADC_CHANNEL),
    .buffer      = &sample,
    .buffer_size = sizeof(sample),
    .resolution  = 12,
};

int main(void)
{
    int err;
    int sleep_interval = NORMAL_INTERVAL_MS;
    bool in_alert_mode = false;
    uint8_t quiet_sample_count = 0;

    if (!device_is_ready(adc_dev)) {
        printk("ERROR: ADC no listo\n");
        return 0;
    }

    struct adc_channel_cfg cfg = {
        .gain             = ADC_GAIN_1,
        .reference        = ADC_REF_INTERNAL,
        .acquisition_time = ADC_ACQ_TIME_DEFAULT,
        .channel_id       = ADC_CHANNEL,
        .input_positive   = ADC_INPUT,
    };
    adc_channel_setup(adc_dev, &cfg);

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

    printk("QuietBar Node activo. Anunciando BLE...\n");

    while (1) {
        int min_raw = 4095, max_raw = 0;
        int64_t final = k_uptime_get() + 50; // Ventana de captura de 50 ms

        while (k_uptime_get() < final) {
            if (adc_read(adc_dev, &seq) == 0) {
                if (sample < min_raw) min_raw = sample;
                if (sample > max_raw) max_raw = sample;
            }
        }

        int diff_raw = (max_raw > min_raw) ? (max_raw - min_raw) : 0;
        sound_mv = (uint16_t)((diff_raw * 600) / 4095);

        /* --- Lógica con histéresis de 16 segundos --- */
        if (sound_mv >= NOISE_THRESHOLD_MV) {
            /* Ruido alto detectado: entra o se mantiene en Alerta */
            in_alert_mode = true;
            quiet_sample_count = 0; // Resetea el contador de silencio
            sleep_interval = ALERT_INTERVAL_MS;
            printk("[MODO ALERTA] Ruido: %d mV. Muestreo en 2s\n", sound_mv);
        } else {
            if (in_alert_mode) {
                /* Está en Alerta pero el ruido bajó: incrementa el tiempo acumulado en silencio */
                quiet_sample_count++;
                
                if (quiet_sample_count >= QUIET_SAMPLES_REQUIRED) {
                    /* Cumplió los 16 segundos continuos en silencio (8 lecturas * 2s) */
                    in_alert_mode = false;
                    quiet_sample_count = 0;
                    sleep_interval = NORMAL_INTERVAL_MS;
                    printk("[MODO NORMAL] 16s en silencio alcanzados. Volviendo a 30s\n");
                } else {
                    /* Sigue en periodo de enfriamiento (cooldown) */
                    sleep_interval = ALERT_INTERVAL_MS;
                    printk("[MODO ALERTA - ENFRIAMIENTO] Silencio %d/16s (%d mV). Muestreo en 2s\n", 
                           quiet_sample_count * 2, sound_mv);
                }
            } else {
                /* Estado normal permanente */
                sleep_interval = NORMAL_INTERVAL_MS;
                printk("[MODO NORMAL] Ruido ambiente: %d mV. Próxima lectura en 30s\n", sound_mv);
            }
        }

        if (current_conn) {
            bt_gatt_notify(current_conn, &sound_svc.attrs[1], &sound_mv, sizeof(sound_mv));
        }

        k_msleep(sleep_interval);
    }

    return 0;
}
