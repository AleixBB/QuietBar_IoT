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
   1. PARAMETROS DE FUNCIONAMIENTO
   ========================================== */

#define NORMAL_INTERVAL_MS       3000
#define ALERT_INTERVAL_MS        500

#define MOTION_THRESHOLD_MS2     2.1f
#define SOUND_THRESHOLD_ADC      120

#define QUIET_TIME_REQUIRED_MS   5000

/* La batería se lee y se notifica cada 5 minutos (independiente del modo) */
#define BATTERY_INTERVAL_MS      (5 * 60 * 1000)

/* Batería: rango de tensión VDD que se mapea a 0..100 %
 * (ajusta a tu fuente: CR2032 ~2000..3000 mV) */
#define BATTERY_FULL_MV          3000
#define BATTERY_EMPTY_MV         2000

/* ==========================================
   2. UUIDs BLE
   ========================================== */

#define BT_UUID_SOUND_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef0)

#define BT_UUID_SOUND_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)

#define BT_UUID_ACCEL_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef2)

#define BT_UUID_BATT_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef3)

#define BT_UUID_CFG_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef4)

#define BT_UUID_CFG_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_CFG_CHAR_VAL)

#define BT_UUID_SOUND_SERVICE \
    BT_UUID_DECLARE_128(BT_UUID_SOUND_SERVICE_VAL)

#define BT_UUID_SOUND_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_SOUND_CHAR_VAL)

#define BT_UUID_ACCEL_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_ACCEL_CHAR_VAL)

#define BT_UUID_BATT_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_BATT_CHAR_VAL)

/* ==========================================
   3. VARIABLES GLOBALES
   ========================================== */

static uint16_t sound_level_val = 0;
static uint16_t accel_magnitude_val = 0;
static uint8_t  battery_level_val = 0;     /* 0..100 % */

/* Umbrales activos (por defecto los #define; el backend los cambia por BLE) */
static volatile uint16_t sound_threshold_adc  = SOUND_THRESHOLD_ADC;
static volatile float    motion_threshold_ms2 = MOTION_THRESHOLD_MS2;

static struct bt_conn *current_conn = NULL;

/* Se pone a true cuando hay que notificar la batería (cada 5 min,
 * o justo al suscribirse el receptor) */
static volatile bool battery_notify_pending = false;

/* Canal 0 de zephyr,user: micrófono */
static const struct adc_dt_spec adc_channel =
    ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);

/* Canal 1 de zephyr,user: VDD (batería) */
static const struct adc_dt_spec adc_batt =
    ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 1);

/* ==========================================
   4. SERVICIO GATT
   ========================================== */

static void ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);

    printk("BLE: Notificaciones %s\n",
           notif_enabled ? "activadas" : "desactivadas");
}

/* CCC de la batería: al suscribirse, envía el valor en el siguiente ciclo
 * para que el receptor no tenga que esperar 5 minutos al primer dato */
static void battery_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);

    printk("BLE: Notificaciones bateria %s\n",
           notif_enabled ? "activadas" : "desactivadas");

    if (notif_enabled) {
        battery_notify_pending = true;
    }
}

/* Callback de lectura (uint16_t) */
static ssize_t read_u16(struct bt_conn *conn,
                        const struct bt_gatt_attr *attr,
                        void *buf, uint16_t len, uint16_t offset)
{
    const uint16_t *value = attr->user_data;

    return bt_gatt_attr_read(conn, attr, buf, len, offset,
                             value, sizeof(*value));
}

/* Callback de lectura (uint8_t) */
static ssize_t read_u8(struct bt_conn *conn,
                       const struct bt_gatt_attr *attr,
                       void *buf, uint16_t len, uint16_t offset)
{
    const uint8_t *value = attr->user_data;

    return bt_gatt_attr_read(conn, attr, buf, len, offset,
                             value, sizeof(*value));
}

/* Escritura de umbrales: 4 bytes little-endian
 * [0..1] sound_threshold_adc, [2..3] motion_threshold_ms2 x100 */
static ssize_t write_cfg(struct bt_conn *conn,
                         const struct bt_gatt_attr *attr,
                         const void *buf, uint16_t len,
                         uint16_t offset, uint8_t flags)
{
    const uint8_t *d = buf;

    if (offset != 0 || len != 4) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }

    sound_threshold_adc  = (uint16_t)(d[0] | (d[1] << 8));
    motion_threshold_ms2 = (float)(d[2] | (d[3] << 8)) / 100.0f;

    printk("CFG: sound_threshold_adc=%u, motion_threshold_ms2=%.2f\n",
           sound_threshold_adc, (double)motion_threshold_ms2);

    return len;
}

/* Índices de atributos:
 * [0] servicio
 * [1] decl. sonido,  [2] valor sonido,  [3] CCC sonido
 * [4] decl. accel,   [5] valor accel,   [6] CCC accel
 * [7] decl. batería, [8] valor batería, [9] CCC batería
 * [10] decl. config,  [11] valor config (escritura)
 */
BT_GATT_SERVICE_DEFINE(quietbar_svc,

    BT_GATT_PRIMARY_SERVICE(BT_UUID_SOUND_SERVICE),

    /* Característica 1: Micrófono */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_SOUND_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        read_u16,
        NULL,
        &sound_level_val
    ),

    BT_GATT_CCC(
        ccc_cfg_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE
    ),

    /* Característica 2: Acelerómetro */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_ACCEL_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        read_u16,
        NULL,
        &accel_magnitude_val
    ),

    BT_GATT_CCC(
        ccc_cfg_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE
    ),

    /* Característica 3: Batería (%) */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_BATT_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        read_u8,
        NULL,
        &battery_level_val
    ),

    BT_GATT_CCC(
        battery_ccc_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE
    ),

    /* Característica 4: Umbrales (escritura desde el gateway) */
    BT_GATT_CHARACTERISTIC(
        BT_UUID_CFG_CHAR,
        BT_GATT_CHRC_WRITE,
        BT_GATT_PERM_WRITE,
        NULL,
        write_cfg,
        NULL
    )
);

/* ==========================================
   5. ANUNCIO BLE
   ========================================== */

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_SOUND_SERVICE_VAL),
};

/* El nombre va en la scan response (el anuncio principal ya está lleno) */
static const struct bt_data sd[] = {
    BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
            sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static void start_advertising(void)
{
    int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1,
                              ad, ARRAY_SIZE(ad),
                              sd, ARRAY_SIZE(sd));
    if (err) {
        printk("Error iniciando BLE (%d)\n", err);
    } else {
        printk("BLE: anunciando...\n");
    }
}

/* ==========================================
   6. CONEXION BLE
   ========================================== */

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

/* Objeto de conexión liberado: momento correcto para volver a anunciar */
static void recycled(void)
{
    start_advertising();
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected    = connected,
    .disconnected = disconnected,
    .recycled     = recycled,
};

/* ==========================================
   7. CONVERSION SENSOR
   ========================================== */

static float sensor_val_to_float(const struct sensor_value *val)
{
    return (float)val->val1 + ((float)val->val2 / 1000000.0f);
}

/* ==========================================
   8. LECTURA MICROFONO GROVE
   ========================================== */

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

    /* 20 muestras rápidas */
    for (int i = 0; i < 20; i++) {
        if (adc_read_dt(&adc_channel, &sequence) == 0) {
            if (buf < min_val) {
                min_val = buf;
            }
            if (buf > max_val) {
                max_val = buf;
            }
        }
        k_busy_wait(100);
    }

    return (max_val >= min_val) ? (max_val - min_val) : 0;
}

/* ==========================================
   9. LECTURA BATERIA (VDD)
   ========================================== */

/* Devuelve el porcentaje 0..100 y guarda los mV en *mv_out */
static uint8_t read_battery_percent(int32_t *mv_out)
{
    int16_t buf;

    struct adc_sequence sequence = {
        .buffer = &buf,
        .buffer_size = sizeof(buf),
    };

    *mv_out = 0;

    if (adc_sequence_init_dt(&adc_batt, &sequence) < 0) {
        return 0;
    }

    if (adc_read_dt(&adc_batt, &sequence) < 0) {
        return 0;
    }

    int32_t mv = buf;

    if (adc_raw_to_millivolts_dt(&adc_batt, &mv) < 0) {
        return 0;
    }

    *mv_out = mv;

    if (mv <= BATTERY_EMPTY_MV) {
        return 0;
    }
    if (mv >= BATTERY_FULL_MV) {
        return 100;
    }

    return (uint8_t)(((mv - BATTERY_EMPTY_MV) * 100) /
                     (BATTERY_FULL_MV - BATTERY_EMPTY_MV));
}

/* ==========================================
   10. PROGRAMA PRINCIPAL
   ========================================== */

int main(void)
{
    int err;

    /* Estado del sistema */
    bool in_alert_mode = false;
    uint32_t quiet_time_ms = 0;
    uint32_t current_interval = NORMAL_INTERVAL_MS;
    float gravity_baseline = 9.81f;

    int32_t battery_mv = 0;
    int64_t last_battery_ms = 0;

    /* ---- Inicializar MPU6050 ---- */
    const struct device *const accel_dev =
        DEVICE_DT_GET_ONE(invensense_mpu6050);

    if (!device_is_ready(accel_dev)) {
        printk("ERROR: MPU6050 no listo\n");
        return 0;
    }

    /* ---- Inicializar ADC (micrófono + batería) ---- */
    if (!adc_is_ready_dt(&adc_channel)) {
        printk("ERROR: ADC canal de sonido no listo\n");
        return 0;
    }

    if (!adc_is_ready_dt(&adc_batt)) {
        printk("ERROR: ADC canal de batería no listo\n");
        return 0;
    }

    err = adc_channel_setup_dt(&adc_channel);
    if (err < 0) {
        printk("Error configurando ADC sonido (%d)\n", err);
        return 0;
    }

    err = adc_channel_setup_dt(&adc_batt);
    if (err < 0) {
        printk("Error configurando ADC batería (%d)\n", err);
        return 0;
    }

    /* Primera lectura de batería (así la característica ya tiene valor) */
    battery_level_val = read_battery_percent(&battery_mv);
    last_battery_ms = k_uptime_get();

    /* ---- Inicializar Bluetooth ---- */
    err = bt_enable(NULL);
    if (err) {
        printk("Error inicializando Bluetooth (%d)\n", err);
        return 0;
    }

    start_advertising();

    /* Imprimir la MAC propia */
    bt_addr_le_t addrs[CONFIG_BT_ID_MAX];
    size_t count = CONFIG_BT_ID_MAX;
    bt_id_get(addrs, &count);

    if (count > 0) {
        char addr_str[BT_ADDR_LE_STR_LEN];

        bt_addr_le_to_str(&addrs[0], addr_str, sizeof(addr_str));
        printk("MAC nRF52840: %s\n", addr_str);
    }

    /* ---- Mensaje de inicio ---- */
    printk("\n");
    printk("====================================\n");
    printk("          QUIETBAR ACTIVO           \n");
    printk("====================================\n");
    printk("Sensores: MPU6050 + Grove Mic + VDD\n");
    printk("Modo inicial: NORMAL\n");
    printk("Intervalo NORMAL: %u ms\n", NORMAL_INTERVAL_MS);
    printk("Intervalo ALERTA: %u ms\n", ALERT_INTERVAL_MS);
    printk("Umbral movimiento: %.2f m/s2\n", (double)MOTION_THRESHOLD_MS2);
    printk("Umbral sonido: %u ADC\n", SOUND_THRESHOLD_ADC);
    printk("Tiempo para volver a NORMAL: %u ms\n", QUIET_TIME_REQUIRED_MS);
    printk("====================================\n");

    /* ---- BUCLE PRINCIPAL ---- */
    while (1) {

        /* 1. LECTURA DEL MICROFONO */
        sound_level_val = read_sound_amplitude();

        /* 1b. LECTURA DE LA BATERIA (cada 5 minutos) */
        int64_t now_ms = k_uptime_get();

        if ((now_ms - last_battery_ms) >= BATTERY_INTERVAL_MS) {
            battery_level_val = read_battery_percent(&battery_mv);
            last_battery_ms = now_ms;
            battery_notify_pending = true;
        }

        /* 2. LECTURA DEL ACELEROMETRO */
        struct sensor_value accel[3];

        if (sensor_sample_fetch(accel_dev) == 0 &&
            sensor_channel_get(accel_dev, SENSOR_CHAN_ACCEL_XYZ, accel) == 0) {

            float ax = sensor_val_to_float(&accel[0]);
            float ay = sensor_val_to_float(&accel[1]);
            float az = sensor_val_to_float(&accel[2]);

            float total_magnitude = sqrtf(ax * ax + ay * ay + az * az);
            float dynamic_accel = fabsf(total_magnitude - gravity_baseline);

            accel_magnitude_val = (uint16_t)(dynamic_accel * 100.0f);

            /* 3. DETECCION DE MOVIMIENTO Y SONIDO */
            bool motion_detected = (dynamic_accel >= motion_threshold_ms2);
            bool sound_detected  = (sound_level_val >= sound_threshold_adc);

            /* 4. GESTION DE ESTADOS */
            if (motion_detected || sound_detected) {

                quiet_time_ms = 0;

                if (!in_alert_mode) {
                    in_alert_mode = true;
                    current_interval = ALERT_INTERVAL_MS;

                    printk("\n!!! ALERTA QUIETBAR !!!\n");

                    if (motion_detected) {
                        printk("Causa: MOVIMIENTO (%.2f m/s2)\n",
                               (double)dynamic_accel);
                    }
                    if (sound_detected) {
                        printk("Causa: SONIDO (%u ADC)\n", sound_level_val);
                    }
                    printk("Nuevo intervalo: %u ms\n", ALERT_INTERVAL_MS);
                }

            } else {

                if (in_alert_mode) {

                    quiet_time_ms += current_interval;

                    /* 5000 ms consecutivos sin actividad */
                    if (quiet_time_ms >= QUIET_TIME_REQUIRED_MS) {
                        in_alert_mode = false;
                        quiet_time_ms = 0;
                        current_interval = NORMAL_INTERVAL_MS;

                        printk("\n[OK] Sin movimiento ni ruido elevado.\n");
                        printk("Volviendo a modo NORMAL.\n");
                        printk("Nuevo intervalo: %u ms\n", NORMAL_INTERVAL_MS);
                    }

                } else {
                    /* Actualizar referencia de gravedad */
                    gravity_baseline = (gravity_baseline * 0.95f) +
                                       (total_magnitude * 0.05f);
                }
            }

            /* 5. NOTIFICACIONES BLE
             * Sonido y aceleración: 3000 ms en NORMAL, 500 ms en ALERTA.
             * Batería: solo cada 5 minutos (o al suscribirse). */
            if (current_conn != NULL) {
                bt_gatt_notify(current_conn, &quietbar_svc.attrs[2],
                               &sound_level_val, sizeof(sound_level_val));

                bt_gatt_notify(current_conn, &quietbar_svc.attrs[5],
                               &accel_magnitude_val, sizeof(accel_magnitude_val));

                if (battery_notify_pending) {
                    bt_gatt_notify(current_conn, &quietbar_svc.attrs[8],
                                   &battery_level_val, sizeof(battery_level_val));
                    battery_notify_pending = false;
                }
            }

            /* 6. INFORMACION DE ESTADO */
            printk("[ESTADO] Modo: %s | Mov: %.2f m/s2 | Sonido: %u ADC | "
                   "Bateria: %u%% (%d mV) | Quiet: %u ms | Intervalo: %u ms\n",
                   in_alert_mode ? "ALERTA" : "NORMAL",
                   (double)accel_magnitude_val / 100.0,
                   sound_level_val,
                   battery_level_val,
                   (int)battery_mv,
                   quiet_time_ms,
                   current_interval);
        }

        /* 7. ESPERA SEGUN EL MODO ACTIVO */
        k_msleep(current_interval);
    }

    return 0;
}
