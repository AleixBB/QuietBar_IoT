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

/* ==========================================
   SELECTOR DE MODE
   1 = Gravar dades cap a Edge Impulse (Data Forwarder a 50 Hz)
   0 = Executar IA (Edge Impulse) + Enviar per BLE
   ========================================== */
#define MODE_DATA_FORWARDER      0

#if !MODE_DATA_FORWARDER
/* Quan passis a MODE 0, canvia l'extensió a .cpp i activa la llibreria */
#include "edge-impulse-sdk/classifier/ei_run_classifier.h"
static float features[EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE];
#endif

/* ==========================================
   1. PARAMETROS DE FUNCIONAMENTO
   ========================================== */
#define SAMPLE_INTERVAL_MS       20      /* 50 Hz exactes per a Edge Impulse */
#define AI_CONFIDENCE_THRESHOLD  0.75f   /* Llindar mínim de confiança (75%) */

/* ==========================================
   2. UUIDs BLE (Mantenim els originals + 1 de nou per a la IA)
   ========================================== */
#define BT_UUID_SOUND_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef0)

#define BT_UUID_SOUND_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)

#define BT_UUID_ACCEL_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef2)

#define BT_UUID_ML_CLASS_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef3)

#define BT_UUID_SOUND_SERVICE   BT_UUID_DECLARE_128(BT_UUID_SOUND_SERVICE_VAL)
#define BT_UUID_SOUND_CHAR      BT_UUID_DECLARE_128(BT_UUID_SOUND_CHAR_VAL)
#define BT_UUID_ACCEL_CHAR      BT_UUID_DECLARE_128(BT_UUID_ACCEL_CHAR_VAL)
#define BT_UUID_ML_CLASS_CHAR   BT_UUID_DECLARE_128(BT_UUID_ML_CLASS_CHAR_VAL)

/* ==========================================
   3. VARIABLES GLOBALS
   ========================================== */
static uint16_t sound_level_val = 0;
static uint16_t accel_magnitude_val = 0;
static uint8_t  ml_class_val = 0; /* Índex de la classe guanyadora (0, 1, 2...) */

static struct bt_conn *current_conn = NULL;

/* Canal ADC del micròfon (sense canvis) */
static const struct adc_dt_spec adc_channel =
    ADC_DT_SPEC_GET(DT_PATH(zephyr_user));

/* ==========================================
   4. SERVEI GATT
   ========================================== */
static void ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
#if !MODE_DATA_FORWARDER
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);
    printk("BLE: Notificacions %s\n", notif_enabled ? "activades" : "desactivades");
#endif
}

BT_GATT_SERVICE_DEFINE(quietbar_svc,
    BT_GATT_PRIMARY_SERVICE(BT_UUID_SOUND_SERVICE),

    /* Característica 1: Micròfon (attrs[2]) */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_SOUND_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        NULL, NULL, &sound_level_val
    ),
    BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    /* Característica 2: Acceleròmetre (attrs[5]) */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_ACCEL_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        NULL, NULL, &accel_magnitude_val
    ),
    BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    /* Característica 3: Classe detectada per la IA (attrs[8]) */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_ML_CLASS_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        NULL, NULL, &ml_class_val
    ),
    BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE)
);

/* ==========================================
   5. CONNEXIÓ I ANUNCI BLE
   ========================================== */
static void connected(struct bt_conn *conn, uint8_t err)
{
    if (err) {
        return;
    }
    current_conn = bt_conn_ref(conn);
#if !MODE_DATA_FORWARDER
    printk("BLE: Dispositiu Central connectat\n");
#endif
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
    if (current_conn) {
        bt_conn_unref(current_conn);
        current_conn = NULL;
    }
#if !MODE_DATA_FORWARDER
    printk("BLE: Dispositiu desconnectat (%u)\n", reason);
#endif
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected = connected,
    .disconnected = disconnected,
};

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_SOUND_SERVICE_VAL),
};

/* ==========================================
   6. LECTURA DE SENSORS (Sense canvis respecte al teu codi)
   ========================================== */
static float sensor_val_to_float(const struct sensor_value *val)
{
    return (float)val->val1 + ((float)val->val2 / 1000000.0f);
}

static uint16_t read_sound_amplitude(void)
{
    uint16_t buf;
    struct adc_sequence sequence = {
        .buffer = &buf,
        .buffer_size = sizeof(buf),
    };

    if (adc_sequence_init_dt(&adc_channel, &sequence) < 0) {
        return 0;
    }

    uint16_t min_val = 4095;
    uint16_t max_val = 0;

    for (int i = 0; i < 20; i++) {
        if (adc_read_dt(&adc_channel, &sequence) == 0) {
            if (buf < min_val) min_val = buf;
            if (buf > max_val) max_val = buf;
        }
        k_busy_wait(100);
    }

    return (max_val >= min_val) ? (max_val - min_val) : 0;
}

/* ==========================================
   7. PROGRAMA PRINCIPAL
   ========================================== */
int main(void)
{
    int err;
    float gravity_baseline = 9.81f;

    /* Inicialitzar MPU6050 */
    const struct device *const accel_dev = DEVICE_DT_GET_ONE(invensense_mpu6050);
    if (!device_is_ready(accel_dev)) {
        printk("ERROR: MPU6050 no llest\n");
        return 0;
    }

    /* Inicialitzar ADC */
    if (!adc_is_ready_dt(&adc_channel)) {
        printk("ERROR: ADC no llest\n");
        return 0;
    }
    err = adc_channel_setup_dt(&adc_channel);
    if (err < 0) {
        printk("Error configurant ADC (%d)\n", err);
        return 0;
    }

#if !MODE_DATA_FORWARDER
    /* Inicialitzar BLE només en mode inferència per no embrutar el port sèrie */
    err = bt_enable(NULL);
    if (err) {
        printk("Error inicializando Bluetooth (%d)\n", err);
        return 0;
    }

    err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
    if (err) {
        printk("Error iniciando BLE (%d)\n", err);
        return 0;
    }

    printk("QUIETBAR + EDGE IMPULSE ACTIU (BLE + IA)\n");
#endif

    /* ==========================================
       BUCLE PRINCIPAL
       ========================================== */
    while (1) {

#if MODE_DATA_FORWARDER
        /* --- FASE 1: ENVIAR DADES A EDGE IMPULSE A 50 Hz --- */
        int64_t t_start = k_uptime_get();

        uint16_t sound = read_sound_amplitude();
        struct sensor_value accel[3];

        if (sensor_sample_fetch(accel_dev) == 0 &&
            sensor_channel_get(accel_dev, SENSOR_CHAN_ACCEL_XYZ, accel) == 0) {

            float ax = sensor_val_to_float(&accel[0]);
            float ay = sensor_val_to_float(&accel[1]);
            float az = sensor_val_to_float(&accel[2]);

            /* Format estricte CSV per a edge-impulse-data-forwarder */
            printk("%u,%.3f,%.3f,%.3f\n", sound, (double)ax, (double)ay, (double)az);
        }

        /* Compensem els ~2 ms de lectura per mantenir 50 Hz exactes */
        int64_t elapsed = k_uptime_get() - t_start;
        if (elapsed < SAMPLE_INTERVAL_MS) {
            k_msleep(SAMPLE_INTERVAL_MS - elapsed);
        }

#else
        /* --- FASE 2: OMPLIR BUFFER + INFERÈNCIA IA + BLE --- */
        size_t ix = 0;
        uint16_t max_sound_window = 0;
        float max_dyn_accel_window = 0.0f;

        while (ix < EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE) {
            int64_t t_start = k_uptime_get();

            uint16_t sound = read_sound_amplitude();
            struct sensor_value accel[3];
            float ax = 0.0f, ay = 0.0f, az = 0.0f;

            if (sensor_sample_fetch(accel_dev) == 0 &&
                sensor_channel_get(accel_dev, SENSOR_CHAN_ACCEL_XYZ, accel) == 0) {
                ax = sensor_val_to_float(&accel[0]);
                ay = sensor_val_to_float(&accel[1]);
                az = sensor_val_to_float(&accel[2]);
            }

            /* 1. Guardem les 4 variables intercalades al buffer de la IA */
            features[ix++] = (float)sound;
            features[ix++] = ax;
            features[ix++] = ay;
            features[ix++] = az;

            /* 2. Mantenim el càlcul dels pics per enviar-los per BLE */
            if (sound > max_sound_window) {
                max_sound_window = sound;
            }
            float total_mag = sqrtf(ax * ax + ay * ay + az * az);
            float dyn_accel = fabsf(total_mag - gravity_baseline);
            if (dyn_accel > max_dyn_accel_window) {
                max_dyn_accel_window = dyn_accel;
            }
            gravity_baseline = (gravity_baseline * 0.95f) + (total_mag * 0.05f);

            int64_t elapsed = k_uptime_get() - t_start;
            if (elapsed < SAMPLE_INTERVAL_MS) {
                k_msleep(SAMPLE_INTERVAL_MS - elapsed);
            }
        }

        /* 3. Executem el classificador d'Edge Impulse */
        signal_t signal;
        ei_impulse_result_t result = { 0 };

        if (numpy::signal_from_buffer(features, EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE, &signal) == 0 &&
            run_classifier(&signal, &result, false) == EI_IMPULSE_OK) {

            uint8_t best_class = 0;
            float best_score = 0.0f;

            for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
                if (result.classification[i].value > best_score) {
                    best_score = result.classification[i].value;
                    best_class = (uint8_t)i;
                }
            }

            /* Actualitzem els valors globals per al BLE */
            sound_level_val = max_sound_window;
            accel_magnitude_val = (uint16_t)(max_dyn_accel_window * 100.0f);
            ml_class_val = (best_score >= AI_CONFIDENCE_THRESHOLD) ? best_class : 255; /* 255 = incert */

            printk("[IA] Classe: %s (%.2f) | Pic So: %u | Pic Accel: %.2f m/s2\n",
                   result.classification[best_class].label,
                   (double)best_score,
                   sound_level_val,
                   (double)max_dyn_accel_window);

            /* 4. Enviem les notificacions BLE al Gateway */
            if (current_conn != NULL) {
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[2], &sound_level_val, sizeof(sound_level_val));
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[5], &accel_magnitude_val, sizeof(accel_magnitude_val));
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[8], &ml_class_val, sizeof(ml_class_val));
            }
        }
#endif
    }

    return 0;
}