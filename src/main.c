
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
#define SOUND_THRESHOLD_ADC      40

#define QUIET_TIME_REQUIRED_MS   5000

   //2. UUIDs BLE

#define BT_UUID_SOUND_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef0)

#define BT_UUID_SOUND_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef1)

#define BT_UUID_ACCEL_CHAR_VAL \
    BT_UUID_128_ENCODE(0x12345678, 0x1234, 0x5678, 0x1234, 0x56789abcdef2)

#define BT_UUID_SOUND_SERVICE \
    BT_UUID_DECLARE_128(BT_UUID_SOUND_SERVICE_VAL)

#define BT_UUID_SOUND_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_SOUND_CHAR_VAL)

#define BT_UUID_ACCEL_CHAR \
    BT_UUID_DECLARE_128(BT_UUID_ACCEL_CHAR_VAL)

   //3. VARIABLES GLOBALES

static uint16_t sound_level_val = 0;
static uint16_t accel_magnitude_val = 0;

static struct bt_conn *current_conn = NULL;

/* Canal ADC del micrófono */

static const struct adc_dt_spec adc_channel =
    ADC_DT_SPEC_GET(DT_PATH(zephyr_user));

   //4. SERVICIO GATT
static void ccc_cfg_changed(
    const struct bt_gatt_attr *attr,
    uint16_t value)
{
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);

    printk("BLE: Notificaciones %s\n",
           notif_enabled ? "activadas" : "desactivadas");
}

BT_GATT_SERVICE_DEFINE(quietbar_svc,

    BT_GATT_PRIMARY_SERVICE(BT_UUID_SOUND_SERVICE),

    /* Característica 1: Micrófono */

    BT_GATT_CHARACTERISTIC(
        BT_UUID_SOUND_CHAR,
        BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_READ,
        NULL,
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
        NULL,
        NULL,
        &accel_magnitude_val
    ),

    BT_GATT_CCC(
        ccc_cfg_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE
    )
);
   //5. CONEXION BLE

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
   //6. ANUNCIO BLE
static const struct bt_data ad[] = {

    BT_DATA_BYTES(
        BT_DATA_FLAGS,
        (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)
    ),

    BT_DATA_BYTES(
        BT_DATA_UUID128_ALL,
        BT_UUID_SOUND_SERVICE_VAL
    ),
};


   //7. CONVERSION SENSOR

static float sensor_val_to_float(const struct sensor_value *val)
{
    return (float)val->val1 +
           ((float)val->val2 / 1000000.0f);
}

   //8. LECTURA MICROFONO GROVE

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

    return (max_val >= min_val)
        ? (max_val - min_val)
        : 0;
}


   //9. PROGRAMA PRINCIPAL

int main(void)
{
    int err;

    /* Estado del sistema */

    bool in_alert_mode = false;

    uint32_t quiet_time_ms = 0;

    uint32_t current_interval = NORMAL_INTERVAL_MS;

    float gravity_baseline = 9.81f;


    /* --------------------------------------
       Inicializar MPU6050
       -------------------------------------- */

    const struct device *const accel_dev =
        DEVICE_DT_GET_ONE(invensense_mpu6050);

    if (!device_is_ready(accel_dev)) {
        printk("ERROR: MPU6050 no listo\n");
        return 0;
    }

       //Inicializar ADC
    if (!adc_is_ready_dt(&adc_channel)) {
        printk("ERROR: ADC canal de sonido no listo\n");
        return 0;
    }

    err = adc_channel_setup_dt(&adc_channel);

    if (err < 0) {
        printk("Error configurando ADC (%d)\n", err);
        return 0;
    }
       //Inicializar Bluetooth

    err = bt_enable(NULL);

    if (err) {
        printk("Error inicializando Bluetooth (%d)\n", err);
        return 0;
    }

    err = bt_le_adv_start(
        BT_LE_ADV_CONN_FAST_1,
        ad,
        ARRAY_SIZE(ad),
        NULL,
        0
    );

    if (err) {
        printk("Error iniciando BLE (%d)\n", err);
        return 0;
    }

       //Mensaje de inicio

    printk("\n");
    printk("====================================\n");
    printk("          QUIETBAR ACTIVO           \n");
    printk("====================================\n");
    printk("Sensores: MPU6050 + Grove Mic\n");
    printk("Modo inicial: NORMAL\n");
    printk("Intervalo NORMAL: %u ms\n", NORMAL_INTERVAL_MS);
    printk("Intervalo ALERTA: %u ms\n", ALERT_INTERVAL_MS);
    printk("Umbral movimiento: %.2f m/s2\n",
           MOTION_THRESHOLD_MS2);
    printk("Umbral sonido: %u ADC\n",
           SOUND_THRESHOLD_ADC);
    printk("Tiempo para volver a NORMAL: %u ms\n",
           QUIET_TIME_REQUIRED_MS);
    printk("====================================\n");

       //BUCLE PRINCIPAL

    while (1) {

           //1. LECTURA DEL MICROFONO

        sound_level_val = read_sound_amplitude();


           //2. LECTURA DEL ACELEROMETRO

        struct sensor_value accel[3];

        if (sensor_sample_fetch(accel_dev) == 0) {

            if (sensor_channel_get(
                    accel_dev,
                    SENSOR_CHAN_ACCEL_XYZ,
                    accel) == 0) {

                float ax = sensor_val_to_float(&accel[0]);
                float ay = sensor_val_to_float(&accel[1]);
                float az = sensor_val_to_float(&accel[2]);

                float total_magnitude =
                    sqrtf(ax * ax + ay * ay + az * az);

                float dynamic_accel =
                    fabsf(total_magnitude - gravity_baseline);

                accel_magnitude_val =
                    (uint16_t)(dynamic_accel * 100.0f);


                   //3. DETECCION DE MOVIMIENTO Y SONIDO

                bool motion_detected =
                    (dynamic_accel >= MOTION_THRESHOLD_MS2);

                bool sound_detected =
                    (sound_level_val >= SOUND_THRESHOLD_ADC);


                   //4. GESTION DE ESTADOS
                if (motion_detected || sound_detected) {

                    /* Alguno de los sensores ha detectado actividad */

                    quiet_time_ms = 0;

                    if (!in_alert_mode) {

                        in_alert_mode = true;

                        current_interval = ALERT_INTERVAL_MS;

                        printk("\n");
                        printk("!!! ALERTA QUIETBAR !!!\n");

                        if (motion_detected) {
                            printk(
                                "Causa: MOVIMIENTO (%.2f m/s2)\n",
                                dynamic_accel
                            );
                        }

                        if (sound_detected) {
                            printk(
                                "Causa: SONIDO (%u ADC)\n",
                                sound_level_val
                            );
                        }

                        printk(
                            "Nuevo intervalo: %u ms\n",
                            ALERT_INTERVAL_MS
                        );
                    }

                } else {

                    /* Ningun sensor supera su umbral */

                    if (in_alert_mode) {

                        quiet_time_ms += current_interval;

                        /* 5000 ms consecutivos sin actividad */

                        if (quiet_time_ms >= QUIET_TIME_REQUIRED_MS) {

                            in_alert_mode = false;

                            quiet_time_ms = 0;

                            current_interval = NORMAL_INTERVAL_MS;

                            printk("\n");
                            printk("[OK] Sin movimiento ni ruido elevado.\n");
                            printk("Volviendo a modo NORMAL.\n");

                            printk(
                                "Nuevo intervalo: %u ms\n",
                                NORMAL_INTERVAL_MS
                            );
                        }

                    } else {

                        /* Actualizar referencia de gravedad */

                        gravity_baseline =
                            (gravity_baseline * 0.95f) +
                            (total_magnitude * 0.05f);
                    }
                }


                /* ----------------------------------
                   5. NOTIFICACIONES BLE
                   ---------------------------------- */

                if (current_conn != NULL) {

                    /* Enviar nivel de sonido */

                    bt_gatt_notify(
                        current_conn,
                        &quietbar_svc.attrs[2],
                        &sound_level_val,
                        sizeof(sound_level_val)
                    );

                    /* Enviar magnitud de aceleracion */

                    bt_gatt_notify(
                        current_conn,
                        &quietbar_svc.attrs[5],
                        &accel_magnitude_val,
                        sizeof(accel_magnitude_val)
                    );
                }


                /* ----------------------------------
                   6. INFORMACION DE ESTADO
                   ---------------------------------- */

                printk(
                    "[ESTADO] Modo: %s | "
                    "Movimiento: %.2f m/s2 | "
                    "Sonido: %u ADC | ",
                    

                    in_alert_mode ? "ALERTA" : "NORMAL",

                    (float)accel_magnitude_val / 100.0f,

                    sound_level_val,

                    quiet_time_ms,

                    current_interval
                );
            }
        }
           //7. ESPERA SEGUN EL MODO ACTIVO

        k_msleep(current_interval);
    }

    return 0;
}
