const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const net = require('net');
const aedes = require('aedes')();
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 4000;
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const STATE_FILE = path.join(__dirname, 'state_backup.json');

// ============================================================================
// 1. CONVERSIÓ ADC <-> dBA i CLASSIFICACIÓ ( basat en Report 1 bo + main.c )
// ============================================================================
// En el PoC (src/main.c), SOUND_THRESHOLD_ADC = 40 (sobre 0..4095) i MOTION_THRESHOLD_MS2 = 2.10 m/s2.
// Mapegem de forma realista l'amplitud ADC del sensor Grove v1.0 a dBA estimats:
//   0..15 ADC   -> 38..52 dBA (Ambient tranquil)
//   15..28 ADC  -> 52..65 dBA (Conversa normal)
//   28..40 ADC  -> 65..75 dBA (Avís / Soroll creixent)
//   40..120 ADC -> 75..92 dBA (Alerta / Soroll excessiu)
//   >120 ADC    -> 92..110 dBA (Pic acústic molt fort)
function adcToDba(adc) {
  const val = Math.max(0, Number(adc) || 0);
  let dba;
  if (val <= 15) {
    dba = 38 + (val / 15) * 14;
  } else if (val <= 28) {
    dba = 52 + ((val - 15) / 13) * 13;
  } else if (val <= 40) {
    dba = 65 + ((val - 28) / 12) * 10;
  } else if (val <= 150) {
    dba = 75 + ((val - 40) / 110) * 18;
  } else {
    dba = Math.min(112, 93 + Math.log10(val - 149) * 6.5);
  }
  return Number(dba.toFixed(1));
}

function dbaToAdc(dba) {
  const val = Number(dba) || 40;
  if (val <= 52) return Math.round(((val - 38) / 14) * 15);
  if (val <= 65) return Math.round(15 + ((val - 52) / 13) * 13);
  if (val <= 75) return Math.round(28 + ((val - 65) / 10) * 12);
  return Math.round(40 + ((val - 75) / 18) * 110);
}

// ============================================================================
// 2. ESTAT INICIAL DEL SISTEMA (Molins de Rei + Bar PoC amb nRF52840 + UNO Q)
// ============================================================================
const defaultThresholds = {
  // Valors exactes per defecte del firmware Zephyr (src/main.c) + nivell d'Avís intermedi
  soundWarningAdc: 28,          // Activa mode AVÍS (Ambre)
  soundAlertAdc: 40,            // SOUND_THRESHOLD_ADC = 40 a main.c -> Activa ALERTA (Vermell)
  soundWarningDba: 65.0,        // Equivalent municipal dBA Avís
  soundAlertDba: 75.0,          // Equivalent municipal dBA Alerta
  motionWarningMs2: 1.2,        // Vibració lleu a la taula
  motionAlertMs2: 2.1,          // MOTION_THRESHOLD_MS2 = 2.1f a main.c -> Arrossegament / Impacte
  normalIntervalMs: 3000,       // NORMAL_INTERVAL_MS = 3000 a main.c
  alertIntervalMs: 500,         // ALERT_INTERVAL_MS = 500 a main.c
  quietTimeRequiredMs: 5000,    // QUIET_TIME_REQUIRED_MS = 5000 a main.c
  schedulePreset: 'evening',    // 'day' | 'evening' | 'night' | 'custom'
  updatedAt: new Date().toISOString(),
  updatedBy: 'Ajuntament de Molins de Rei (Configuració Inicial PoC)'
};

const initialVenues = [
  {
    id: 'ven-001',
    name: 'Bar Terrassa El Pati (PoC QuietBar)',
    address: 'Passeig del Terraplè, 42, Molins de Rei',
    district: 'Centre Vila / Terraplè',
    lat: 41.4136,
    lng: 2.0154,
    isPoCVenue: true,
    gatewayId: 'Arduino-UNO-Q-4GB-01',
    licenseMaxTables: 8,
    customThresholds: null, // Si és null, usa els llindars globals de l'Ajuntament
    zones: [
      { id: 'zone-terrace-north', name: 'Terrassa Nord (Vora Carrer)', color: '#3b82f6', x: 3, y: 5, w: 60, h: 44 },
      { id: 'zone-terrace-south', name: 'Terrassa Sud (Pèrgola)', color: '#10b981', x: 3, y: 53, w: 60, h: 42 },
      { id: 'zone-indoor', name: 'Interior & Barra', color: '#8b5cf6', x: 66, y: 5, w: 31, h: 90 }
    ],
    tables: [
      {
        id: 'T1',
        name: 'Taula 1 (PoC Real)',
        sensorId: 'nRF52840-BLE-01',
        isPhysicalPoC: true,
        zoneId: 'zone-terrace-north',
        x: 18,
        y: 25,
        seats: 4,
        soundAdc: 14,
        dBA: adcToDba(14),
        peakAdc: 19,
        peakDba: adcToDba(19),
        accelMs2: 0.08,
        status: 'normal', // 'normal' | 'warning' | 'alert'
        cause: 'normal',  // 'normal' | 'chatter' | 'drag' | 'impact'
        causeLabel: 'Calma ambiental',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 96,
        lastUpdate: new Date().toISOString(),
        source: 'waiting_hardware' // 'hardware_live' | 'simulator' | 'waiting_hardware'
      },
      {
        id: 'T2',
        name: 'Taula 2',
        sensorId: 'QB-NODE-02',
        isPhysicalPoC: false,
        zoneId: 'zone-terrace-north',
        x: 45,
        y: 25,
        seats: 4,
        soundAdc: 21,
        dBA: adcToDba(21),
        peakAdc: 26,
        peakDba: adcToDba(26),
        accelMs2: 0.12,
        status: 'normal',
        cause: 'normal',
        causeLabel: 'Conversa moderada',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 89,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      },
      {
        id: 'T3',
        name: 'Taula 3',
        sensorId: 'QB-NODE-03',
        isPhysicalPoC: false,
        zoneId: 'zone-terrace-north',
        x: 32,
        y: 38,
        seats: 6,
        soundAdc: 31,
        dBA: adcToDba(31),
        peakAdc: 37,
        peakDba: adcToDba(37),
        accelMs2: 0.25,
        status: 'warning',
        cause: 'chatter',
        causeLabel: 'Grup parlant alt',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 92,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      },
      {
        id: 'T4',
        name: 'Taula 4',
        sensorId: 'QB-NODE-04',
        isPhysicalPoC: false,
        zoneId: 'zone-terrace-south',
        x: 18,
        y: 72,
        seats: 4,
        soundAdc: 16,
        dBA: adcToDba(16),
        peakAdc: 20,
        peakDba: adcToDba(20),
        accelMs2: 0.05,
        status: 'normal',
        cause: 'normal',
        causeLabel: 'Calma ambiental',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 84,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      },
      {
        id: 'T5',
        name: 'Taula 5',
        sensorId: 'QB-NODE-05',
        isPhysicalPoC: false,
        zoneId: 'zone-terrace-south',
        x: 45,
        y: 72,
        seats: 4,
        soundAdc: 19,
        dBA: adcToDba(19),
        peakAdc: 24,
        peakDba: adcToDba(24),
        accelMs2: 0.10,
        status: 'normal',
        cause: 'normal',
        causeLabel: 'Calma ambiental',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 91,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      },
      {
        id: 'T6',
        name: 'Taula 6 (Interior)',
        sensorId: 'QB-NODE-06',
        isPhysicalPoC: false,
        zoneId: 'zone-indoor',
        x: 81,
        y: 28,
        seats: 4,
        soundAdc: 24,
        dBA: adcToDba(24),
        peakAdc: 29,
        peakDba: adcToDba(29),
        accelMs2: 0.09,
        status: 'normal',
        cause: 'normal',
        causeLabel: 'Soroll interior normal',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 98,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      },
      {
        id: 'T7',
        name: 'Taula 7 (Barra)',
        sensorId: 'QB-NODE-07',
        isPhysicalPoC: false,
        zoneId: 'zone-indoor',
        x: 81,
        y: 68,
        seats: 6,
        soundAdc: 22,
        dBA: adcToDba(22),
        peakAdc: 27,
        peakDba: adcToDba(27),
        accelMs2: 0.14,
        status: 'normal',
        cause: 'normal',
        causeLabel: 'Soroll interior normal',
        inAlertMode: false,
        currentIntervalMs: 3000,
        quietTimeMs: 0,
        battery: 87,
        lastUpdate: new Date().toISOString(),
        source: 'simulator'
      }
    ],
    alertsToday: 3,
    dragEventsToday: 1,
    chatterEventsToday: 2,
    complianceScore: 94
  },
  {
    id: 'ven-002',
    name: 'La Vermuteria de la Plaça',
    address: 'Plaça de Catalunya, 8, Molins de Rei',
    district: 'Plaça Catalunya',
    lat: 41.4148,
    lng: 2.0169,
    isPoCVenue: false,
    gatewayId: 'GW-MOL-002',
    licenseMaxTables: 12,
    customThresholds: null,
    zones: [
      { id: 'z1', name: 'Terrassa Plaça', color: '#3b82f6', x: 5, y: 5, w: 90, h: 90 }
    ],
    tables: [
      { id: 'V2-T1', name: 'Taula 1', sensorId: 'V2-N1', isPhysicalPoC: false, zoneId: 'z1', x: 25, y: 35, seats: 4, soundAdc: 48, dBA: adcToDba(48), peakAdc: 62, peakDba: adcToDba(62), accelMs2: 2.45, status: 'alert', cause: 'drag', causeLabel: 'Arrossegament de cadires', inAlertMode: true, currentIntervalMs: 500, quietTimeMs: 0, battery: 82, lastUpdate: new Date().toISOString(), source: 'simulator' },
      { id: 'V2-T2', name: 'Taula 2', sensorId: 'V2-N2', isPhysicalPoC: false, zoneId: 'z1', x: 65, y: 35, seats: 4, soundAdc: 42, dBA: adcToDba(42), peakAdc: 51, peakDba: adcToDba(51), accelMs2: 0.40, status: 'alert', cause: 'chatter', causeLabel: 'Conversa molt elevada', inAlertMode: true, currentIntervalMs: 500, quietTimeMs: 0, battery: 79, lastUpdate: new Date().toISOString(), source: 'simulator' },
      { id: 'V2-T3', name: 'Taula 3', sensorId: 'V2-N3', isPhysicalPoC: false, zoneId: 'z1', x: 45, y: 70, seats: 6, soundAdc: 33, dBA: adcToDba(33), peakAdc: 39, peakDba: adcToDba(39), accelMs2: 0.20, status: 'warning', cause: 'chatter', causeLabel: 'Soroll creixent', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 90, lastUpdate: new Date().toISOString(), source: 'simulator' }
    ],
    alertsToday: 18,
    dragEventsToday: 7,
    chatterEventsToday: 11,
    complianceScore: 68
  },
  {
    id: 'ven-003',
    name: 'Cafè del Foment & Terrassa',
    address: 'Passeig del Terraplè, 19, Molins de Rei',
    district: 'Centre Vila / Terraplè',
    lat: 41.4125,
    lng: 2.0168,
    isPoCVenue: false,
    gatewayId: 'GW-MOL-003',
    licenseMaxTables: 10,
    customThresholds: null,
    zones: [
      { id: 'z1', name: 'Terrassa Principal', color: '#10b981', x: 5, y: 5, w: 90, h: 90 }
    ],
    tables: [
      { id: 'V3-T1', name: 'Taula 1', sensorId: 'V3-N1', isPhysicalPoC: false, zoneId: 'z1', x: 30, y: 50, seats: 4, soundAdc: 32, dBA: adcToDba(32), peakAdc: 38, peakDba: adcToDba(38), accelMs2: 0.35, status: 'warning', cause: 'chatter', causeLabel: 'Conversa elevada', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 88, lastUpdate: new Date().toISOString(), source: 'simulator' },
      { id: 'V3-T2', name: 'Taula 2', sensorId: 'V3-N2', isPhysicalPoC: false, zoneId: 'z1', x: 70, y: 50, seats: 4, soundAdc: 26, dBA: adcToDba(26), peakAdc: 31, peakDba: adcToDba(31), accelMs2: 0.15, status: 'normal', cause: 'normal', causeLabel: 'Calma ambiental', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 94, lastUpdate: new Date().toISOString(), source: 'simulator' }
    ],
    alertsToday: 9,
    dragEventsToday: 3,
    chatterEventsToday: 6,
    complianceScore: 83
  },
  {
    id: 'ven-004',
    name: 'Gastrobar Plaça de la Vila',
    address: 'Plaça de la Vila, 3, Molins de Rei',
    district: 'Casc Antic',
    lat: 41.4141,
    lng: 2.0138,
    isPoCVenue: false,
    gatewayId: 'GW-MOL-004',
    licenseMaxTables: 8,
    customThresholds: null,
    zones: [
      { id: 'z1', name: 'Porxos Vila', color: '#8b5cf6', x: 5, y: 5, w: 90, h: 90 }
    ],
    tables: [
      { id: 'V4-T1', name: 'Taula 1', sensorId: 'V4-N1', isPhysicalPoC: false, zoneId: 'z1', x: 35, y: 45, seats: 4, soundAdc: 17, dBA: adcToDba(17), peakAdc: 22, peakDba: adcToDba(22), accelMs2: 0.08, status: 'normal', cause: 'normal', causeLabel: 'Calma ambiental', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 95, lastUpdate: new Date().toISOString(), source: 'simulator' },
      { id: 'V4-T2', name: 'Taula 2', sensorId: 'V4-N2', isPhysicalPoC: false, zoneId: 'z1', x: 65, y: 45, seats: 4, soundAdc: 19, dBA: adcToDba(19), peakAdc: 25, peakDba: adcToDba(25), accelMs2: 0.11, status: 'normal', cause: 'normal', causeLabel: 'Calma ambiental', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 91, lastUpdate: new Date().toISOString(), source: 'simulator' }
    ],
    alertsToday: 2,
    dragEventsToday: 0,
    chatterEventsToday: 2,
    complianceScore: 97
  },
  {
    id: 'ven-005',
    name: 'Cerveseria El Canal',
    address: 'Carrer Major, 74, Molins de Rei',
    district: 'Carrer Major',
    lat: 41.4153,
    lng: 2.0145,
    isPoCVenue: false,
    gatewayId: 'GW-MOL-005',
    licenseMaxTables: 14,
    customThresholds: null,
    zones: [
      { id: 'z1', name: 'Terrassa Carrer Major', color: '#f59e0b', x: 5, y: 5, w: 90, h: 90 }
    ],
    tables: [
      { id: 'V5-T1', name: 'Taula 1', sensorId: 'V5-N1', isPhysicalPoC: false, zoneId: 'z1', x: 30, y: 40, seats: 6, soundAdc: 44, dBA: adcToDba(44), peakAdc: 55, peakDba: adcToDba(55), accelMs2: 2.30, status: 'alert', cause: 'drag', causeLabel: 'Arrossegament de mobiliari', inAlertMode: true, currentIntervalMs: 500, quietTimeMs: 0, battery: 76, lastUpdate: new Date().toISOString(), source: 'simulator' },
      { id: 'V5-T2', name: 'Taula 2', sensorId: 'V5-N2', isPhysicalPoC: false, zoneId: 'z1', x: 70, y: 60, seats: 4, soundAdc: 35, dBA: adcToDba(35), peakAdc: 41, peakDba: adcToDba(41), accelMs2: 0.28, status: 'warning', cause: 'chatter', causeLabel: 'Conversa elevada', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 85, lastUpdate: new Date().toISOString(), source: 'simulator' }
    ],
    alertsToday: 14,
    dragEventsToday: 6,
    chatterEventsToday: 8,
    complianceScore: 74
  },
  {
    id: 'ven-006',
    name: 'Bistró Parc de la Mariona',
    address: 'Avinguda de Barcelona, 58, Molins de Rei',
    district: 'La Granja / Parc',
    lat: 41.4112,
    lng: 2.0192,
    isPoCVenue: false,
    gatewayId: 'GW-MOL-006',
    licenseMaxTables: 10,
    customThresholds: null,
    zones: [
      { id: 'z1', name: 'Jardí Exterior', color: '#10b981', x: 5, y: 5, w: 90, h: 90 }
    ],
    tables: [
      { id: 'V6-T1', name: 'Taula 1', sensorId: 'V6-N1', isPhysicalPoC: false, zoneId: 'z1', x: 50, y: 50, seats: 4, soundAdc: 15, dBA: adcToDba(15), peakAdc: 21, peakDba: adcToDba(21), accelMs2: 0.06, status: 'normal', cause: 'normal', causeLabel: 'Calma ambiental', inAlertMode: false, currentIntervalMs: 3000, quietTimeMs: 0, battery: 96, lastUpdate: new Date().toISOString(), source: 'simulator' }
    ],
    alertsToday: 1,
    dragEventsToday: 0,
    chatterEventsToday: 1,
    complianceScore: 99
  }
];

let state = {
  thresholds: { ...defaultThresholds },
  venues: initialVenues,
  pocTelemetryHistory: [],
  alertsLog: [
    {
      id: 'alt-init-1',
      venueId: 'ven-002',
      venueName: 'La Vermuteria de la Plaça',
      tableId: 'V2-T1',
      tableName: 'Taula 1',
      zoneName: 'Terrassa Plaça',
      level: 'alert',
      cause: 'drag',
      causeLabel: 'Arrossegament de cadires + Soroll alt',
      soundAdc: 48,
      dBA: adcToDba(48),
      accelMs2: 2.45,
      timestamp: new Date(Date.now() - 180000).toISOString(),
      acknowledged: false
    },
    {
      id: 'alt-init-2',
      venueId: 'ven-001',
      venueName: 'Bar Terrassa El Pati (PoC QuietBar)',
      tableId: 'T3',
      tableName: 'Taula 3',
      zoneName: 'Terrassa Nord (Vora Carrer)',
      level: 'warning',
      cause: 'chatter',
      causeLabel: 'Soroll acústic creixent (Avís)',
      soundAdc: 31,
      dBA: adcToDba(31),
      accelMs2: 0.25,
      timestamp: new Date(Date.now() - 90000).toISOString(),
      acknowledged: false
    }
  ],
  edgeConnection: {
    connected: false,
    lastPacketAt: null,
    protocol: null, // 'HTTP' | 'MQTT' | 'WebSocket' | 'Simulator'
    gatewayName: 'Arduino UNO Q 4GB',
    peripheralName: 'QuietBar Accel (nRF52840-DK)',
    packetsReceived: 0,
    demoSimulationActive: true // Simula suaument el PoC fins que entra un paquet físic real
  }
};

// Inicialitzem l'històric amb 25 punts recents per tenir gràfiques vives des del segon 0
const nowMs = Date.now();
for (let i = 24; i >= 0; i--) {
  const sampleAdc = 14 + Math.round(Math.sin(i * 0.4) * 6 + Math.random() * 5);
  const sampleAccel = Number((0.06 + Math.random() * 0.12).toFixed(2));
  state.pocTelemetryHistory.push({
    timestamp: new Date(nowMs - i * 3000).toISOString(),
    timeLabel: new Date(nowMs - i * 3000).toLocaleTimeString('ca-ES', { hour12: false }),
    soundAdc: sampleAdc,
    dBA: adcToDba(sampleAdc),
    accelMs2: sampleAccel,
    status: 'normal',
    cause: 'normal',
    inAlertMode: false
  });
}

// ============================================================================
// 3. AVALUACIÓ DE LLINDARS (Lògica idèntica a main.c + regles de l'Ajuntament)
// ============================================================================
function getEffectiveThresholds(venue) {
  if (venue && venue.customThresholds) {
    return { ...state.thresholds, ...venue.customThresholds };
  }
  return state.thresholds;
}

function evaluateReading(soundAdc, accelMs2, prevTable, thresholds, dtMs = 1000) {
  const dBA = adcToDba(soundAdc);
  const isMotionAlert = accelMs2 >= thresholds.motionAlertMs2;
  const isMotionWarning = accelMs2 >= thresholds.motionWarningMs2 && !isMotionAlert;
  const isSoundAlert = soundAdc >= thresholds.soundAlertAdc || dBA >= thresholds.soundAlertDba;
  const isSoundWarning = (soundAdc >= thresholds.soundWarningAdc || dBA >= thresholds.soundWarningDba) && !isSoundAlert;

  let status = 'normal';
  let cause = 'normal';
  let causeLabel = 'Calma ambiental';

  if (isMotionAlert && (isSoundAlert || isSoundWarning)) {
    status = 'alert';
    cause = 'drag';
    causeLabel = 'Arrossegament de taula/cadira detectat';
  } else if (isMotionAlert) {
    status = 'alert';
    cause = 'impact';
    causeLabel = 'Vibració / Impacte estructural a la taula';
  } else if (isSoundAlert) {
    status = 'alert';
    cause = 'chatter';
    causeLabel = 'Soroll acústic excessiu (Veu / Ambient)';
  } else if (isMotionWarning || isSoundWarning) {
    status = 'warning';
    cause = isMotionWarning ? 'impact' : 'chatter';
    causeLabel = isMotionWarning
      ? 'Vibració moderada a la taula (Avís)'
      : 'Soroll en augment — Avís preventiu';
  }

  // Lògica de l'estat d'alerta amb histèresi (QUIET_TIME_REQUIRED_MS = 5000 ms a main.c)
  let inAlertMode = prevTable ? Boolean(prevTable.inAlertMode) : false;
  let quietTimeMs = prevTable ? Number(prevTable.quietTimeMs || 0) : 0;

  if (status === 'alert') {
    inAlertMode = true;
    quietTimeMs = 0;
  } else if (inAlertMode) {
    quietTimeMs += dtMs;
    if (quietTimeMs >= thresholds.quietTimeRequiredMs) {
      inAlertMode = false;
      quietTimeMs = 0;
    }
  }

  const currentIntervalMs = inAlertMode ? thresholds.alertIntervalMs : thresholds.normalIntervalMs;

  return {
    dBA,
    status,
    cause,
    causeLabel,
    inAlertMode,
    quietTimeMs,
    currentIntervalMs
  };
}

function recalculateAllVenues() {
  state.venues.forEach((venue) => {
    const thresholds = getEffectiveThresholds(venue);
    venue.tables.forEach((table) => {
      const evalRes = evaluateReading(table.soundAdc, table.accelMs2, table, thresholds, 0);
      table.dBA = evalRes.dBA;
      table.status = evalRes.status;
      table.cause = evalRes.cause;
      table.causeLabel = evalRes.causeLabel;
      table.inAlertMode = evalRes.inAlertMode;
      table.currentIntervalMs = evalRes.currentIntervalMs;
    });
  });
}

// ============================================================================
// 4. PROCESSAMENT DE TELEMETRIA EN TEMPS REAL (des d'Arduino UNO Q o Simulador)
// ============================================================================
let lastPoCAlertLoggedAt = 0;

function processIncomingTelemetry(payload, protocol = 'HTTP') {
  const venueId = payload.venueId || 'ven-001';
  const tableId = payload.tableId || 'T1';
  const isRealHardware = payload.source !== 'simulator';

  const venue = state.venues.find((v) => v.id === venueId) || state.venues[0];
  const table = venue.tables.find((t) => t.id === tableId) || venue.tables[0];
  const thresholds = getEffectiveThresholds(venue);

  // Permetem tant dades crues del PoC (sound_adc / sound_val, accel_ms2 / raw_accel) com dBA
  let soundAdc = payload.soundAdc ?? payload.sound_val ?? payload.sound_level_val;
  if (soundAdc === undefined && payload.dBA !== undefined) {
    soundAdc = dbaToAdc(payload.dBA);
  }
  soundAdc = Math.max(0, Math.min(4095, Math.round(Number(soundAdc) || 0)));

  let accelMs2 = payload.accelMs2 ?? payload.accel_ms2 ?? payload.vibration;
  if (accelMs2 === undefined && payload.raw_accel !== undefined) {
    accelMs2 = Number(payload.raw_accel) / 100.0;
  }
  accelMs2 = Math.max(0, Number(Number(accelMs2 || 0).toFixed(2)));

  const now = new Date();
  const prevUpdateMs = table.lastUpdate ? new Date(table.lastUpdate).getTime() : now.getTime() - 1000;
  const dtMs = Math.max(200, Math.min(10000, now.getTime() - prevUpdateMs));

  const prevStatus = table.status;
  const evalRes = evaluateReading(soundAdc, accelMs2, table, thresholds, dtMs);

  table.soundAdc = soundAdc;
  table.dBA = evalRes.dBA;
  table.peakAdc = Math.max(table.peakAdc || 0, soundAdc);
  table.peakDba = Math.max(table.peakDba || 0, evalRes.dBA);
  table.accelMs2 = accelMs2;
  table.status = evalRes.status;
  table.cause = evalRes.cause;
  table.causeLabel = evalRes.causeLabel;
  table.inAlertMode = evalRes.inAlertMode;
  table.quietTimeMs = evalRes.quietTimeMs;
  table.currentIntervalMs = evalRes.currentIntervalMs;
  table.lastUpdate = now.toISOString();
  if (payload.battery !== undefined) {
    table.battery = Number(payload.battery);
  }

  if (isRealHardware) {
    table.source = 'hardware_live';
    state.edgeConnection.connected = true;
    state.edgeConnection.lastPacketAt = now.toISOString();
    state.edgeConnection.protocol = protocol;
    state.edgeConnection.packetsReceived += 1;
    // Quan entra un paquet real de l'Arduino UNO Q, desactivem automàticament la demo simulada sobre T1
    state.edgeConnection.demoSimulationActive = false;
  } else {
    table.source = 'simulator';
  }

  // Si és la taula PoC (T1 de ven-001), afegim a l'històric de temps real
  if (venue.id === 'ven-001' && table.id === 'T1') {
    const point = {
      timestamp: now.toISOString(),
      timeLabel: now.toLocaleTimeString('ca-ES', { hour12: false }),
      soundAdc: table.soundAdc,
      dBA: table.dBA,
      accelMs2: table.accelMs2,
      status: table.status,
      cause: table.cause,
      causeLabel: table.causeLabel,
      inAlertMode: table.inAlertMode,
      source: table.source
    };
    state.pocTelemetryHistory.push(point);
    if (state.pocTelemetryHistory.length > 60) {
      state.pocTelemetryHistory.shift();
    }
  }

  // Registrem alerta si passa a 'alert' o 'warning' (amb cooldown de 6s per no saturar el log)
  if (
    (evalRes.status === 'alert' || (evalRes.status === 'warning' && prevStatus === 'normal')) &&
    now.getTime() - lastPoCAlertLoggedAt > 6000
  ) {
    lastPoCAlertLoggedAt = now.getTime();
    const zoneObj = venue.zones.find((z) => z.id === table.zoneId);
    const newAlert = {
      id: `alt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      venueId: venue.id,
      venueName: venue.name,
      tableId: table.id,
      tableName: table.name,
      zoneName: zoneObj ? zoneObj.name : 'Terrassa',
      level: evalRes.status,
      cause: evalRes.cause,
      causeLabel: evalRes.causeLabel,
      soundAdc: table.soundAdc,
      dBA: table.dBA,
      accelMs2: table.accelMs2,
      timestamp: now.toISOString(),
      acknowledged: false,
      source: table.source
    };
    state.alertsLog.unshift(newAlert);
    if (state.alertsLog.length > 50) {
      state.alertsLog.pop();
    }

    if (evalRes.status === 'alert') {
      venue.alertsToday += 1;
      if (evalRes.cause === 'drag' || evalRes.cause === 'impact') {
        venue.dragEventsToday += 1;
      } else {
        venue.chatterEventsToday += 1;
      }
      venue.complianceScore = Math.max(40, venue.complianceScore - 1);
    }

    io.emit('alert:new', newAlert);
  }

  // Emetem actualització immediata per WebSockets als 2 FrontEnds
  io.emit('telemetry:update', {
    venueId: venue.id,
    table,
    pocHistoryPoint: venue.id === 'ven-001' && table.id === 'T1'
      ? state.pocTelemetryHistory[state.pocTelemetryHistory.length - 1]
      : null,
    edgeConnection: state.edgeConnection,
    venueSummary: computeVenueSummary(venue)
  });

  return {
    ok: true,
    table,
    thresholds,
    commandAck: {
      inAlertMode: table.inAlertMode,
      nextIntervalMs: table.currentIntervalMs,
      ledState: table.status === 'alert' ? 'RED' : table.status === 'warning' ? 'AMBER' : 'GREEN'
    }
  };
}

// ============================================================================
// 5. AGREGACIONS PER ZONES I PER BARS (Per al Dashboard Bar i Ajuntament)
// ============================================================================
function computeVenueSummary(venue) {
  const thresholds = getEffectiveThresholds(venue);
  const tables = venue.tables || [];
  const totalTables = tables.length || 1;

  const avgAdc = Math.round(tables.reduce((acc, t) => acc + (t.soundAdc || 0), 0) / totalTables);
  const avgDba = Number((tables.reduce((acc, t) => acc + (t.dBA || 40), 0) / totalTables).toFixed(1));
  const maxDba = Number(Math.max(...tables.map((t) => t.dBA || 40)).toFixed(1));
  const maxAdc = Math.max(...tables.map((t) => t.soundAdc || 0));
  const maxAccel = Number(Math.max(...tables.map((t) => t.accelMs2 || 0)).toFixed(2));

  const alertTablesCount = tables.filter((t) => t.status === 'alert').length;
  const warningTablesCount = tables.filter((t) => t.status === 'warning').length;

  let overallStatus = 'normal';
  if (alertTablesCount > 0) overallStatus = 'alert';
  else if (warningTablesCount > 0) overallStatus = 'warning';

  // Estadístiques per zona del bar
  const zoneStats = (venue.zones || []).map((zone) => {
    const zTables = tables.filter((t) => t.zoneId === zone.id);
    if (zTables.length === 0) {
      return { ...zone, tableCount: 0, avgDba: 40, avgAdc: 10, maxDba: 40, status: 'normal' };
    }
    const zAvgDba = Number((zTables.reduce((a, b) => a + b.dBA, 0) / zTables.length).toFixed(1));
    const zAvgAdc = Math.round(zTables.reduce((a, b) => a + b.soundAdc, 0) / zTables.length);
    const zMaxDba = Number(Math.max(...zTables.map((t) => t.dBA)).toFixed(1));
    const hasAlert = zTables.some((t) => t.status === 'alert');
    const hasWarning = zTables.some((t) => t.status === 'warning');
    return {
      ...zone,
      tableCount: zTables.length,
      avgDba: zAvgDba,
      avgAdc: zAvgAdc,
      maxDba: zMaxDba,
      status: hasAlert ? 'alert' : hasWarning ? 'warning' : 'normal'
    };
  });

  return {
    id: venue.id,
    name: venue.name,
    address: venue.address,
    district: venue.district,
    lat: venue.lat,
    lng: venue.lng,
    isPoCVenue: venue.isPoCVenue,
    gatewayId: venue.gatewayId,
    avgAdc,
    avgDba,
    maxAdc,
    maxDba,
    maxAccel,
    alertTablesCount,
    warningTablesCount,
    totalTables: tables.length,
    overallStatus,
    alertsToday: venue.alertsToday,
    dragEventsToday: venue.dragEventsToday,
    chatterEventsToday: venue.chatterEventsToday,
    complianceScore: venue.complianceScore,
    thresholds,
    zoneStats
  };
}

function getFullClientState() {
  return {
    thresholds: state.thresholds,
    venues: state.venues.map((v) => ({
      ...v,
      summary: computeVenueSummary(v)
    })),
    pocTelemetryHistory: state.pocTelemetryHistory,
    alertsLog: state.alertsLog,
    edgeConnection: state.edgeConnection
  };
}

// ============================================================================
// 6. ENDPOINTS REST API (Per als 2 FrontEnds i per a l'Arduino UNO Q / Edge)
// ============================================================================

// Health check per Azure App Service
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'QuietVenue IoT Cloud Backend (Azure Ready)',
    uptimeSeconds: Math.round(process.uptime()),
    edgeConnected: state.edgeConnection.connected,
    timestamp: new Date().toISOString()
  });
});

// Estat complet inicial per als 2 FrontEnds
app.get('/api/state', (req, res) => {
  res.json(getFullClientState());
});

// Ingesta de telemetria des de l'Edge Gateway (Arduino UNO Q o script pont Python)
app.post('/api/telemetry', (req, res) => {
  const result = processIncomingTelemetry(req.body, req.body.protocol || 'HTTP');
  res.json(result);
});

// Modificar llindars globals (des del FrontEnd de l'Ajuntament)
app.put('/api/thresholds', (req, res) => {
  const body = req.body || {};

  if (body.soundWarningAdc !== undefined) {
    state.thresholds.soundWarningAdc = Number(body.soundWarningAdc);
    state.thresholds.soundWarningDba = body.soundWarningDba !== undefined
      ? Number(body.soundWarningDba)
      : adcToDba(state.thresholds.soundWarningAdc);
  } else if (body.soundWarningDba !== undefined) {
    state.thresholds.soundWarningDba = Number(body.soundWarningDba);
    state.thresholds.soundWarningAdc = dbaToAdc(state.thresholds.soundWarningDba);
  }

  if (body.soundAlertAdc !== undefined) {
    state.thresholds.soundAlertAdc = Number(body.soundAlertAdc);
    state.thresholds.soundAlertDba = body.soundAlertDba !== undefined
      ? Number(body.soundAlertDba)
      : adcToDba(state.thresholds.soundAlertAdc);
  } else if (body.soundAlertDba !== undefined) {
    state.thresholds.soundAlertDba = Number(body.soundAlertDba);
    state.thresholds.soundAlertAdc = dbaToAdc(state.thresholds.soundAlertDba);
  }

  if (body.motionWarningMs2 !== undefined) {
    state.thresholds.motionWarningMs2 = Number(body.motionWarningMs2);
  }
  if (body.motionAlertMs2 !== undefined) {
    state.thresholds.motionAlertMs2 = Number(body.motionAlertMs2);
  }
  if (body.normalIntervalMs !== undefined) {
    state.thresholds.normalIntervalMs = Number(body.normalIntervalMs);
  }
  if (body.alertIntervalMs !== undefined) {
    state.thresholds.alertIntervalMs = Number(body.alertIntervalMs);
  }
  if (body.quietTimeRequiredMs !== undefined) {
    state.thresholds.quietTimeRequiredMs = Number(body.quietTimeRequiredMs);
  }
  if (body.schedulePreset !== undefined) {
    state.thresholds.schedulePreset = body.schedulePreset;
  }

  state.thresholds.updatedAt = new Date().toISOString();
  state.thresholds.updatedBy = body.updatedBy || 'Ajuntament de Molins de Rei';

  recalculateAllVenues();
  const fullState = getFullClientState();
  io.emit('state:sync', fullState);
  io.emit('thresholds:updated', state.thresholds);

  res.json({ ok: true, thresholds: state.thresholds, state: fullState });
});

// Modificar llindars específics d'un bar concret (des de l'Ajuntament)
app.put('/api/venues/:id/thresholds', (req, res) => {
  const venue = state.venues.find((v) => v.id === req.params.id);
  if (!venue) return res.status(404).json({ error: 'Bar no trobat' });

  if (req.body.resetToGlobal) {
    venue.customThresholds = null;
  } else {
    const soundWarningAdc = req.body.soundWarningAdc !== undefined
      ? Number(req.body.soundWarningAdc)
      : state.thresholds.soundWarningAdc;
    const soundAlertAdc = req.body.soundAlertAdc !== undefined
      ? Number(req.body.soundAlertAdc)
      : state.thresholds.soundAlertAdc;

    venue.customThresholds = {
      soundWarningAdc,
      soundWarningDba: adcToDba(soundWarningAdc),
      soundAlertAdc,
      soundAlertDba: adcToDba(soundAlertAdc),
      motionWarningMs2: Number(req.body.motionWarningMs2 ?? state.thresholds.motionWarningMs2),
      motionAlertMs2: Number(req.body.motionAlertMs2 ?? state.thresholds.motionAlertMs2),
      updatedAt: new Date().toISOString()
    };
  }

  recalculateAllVenues();
  const fullState = getFullClientState();
  io.emit('state:sync', fullState);
  res.json({ ok: true, venue: fullState.venues.find((v) => v.id === venue.id) });
});

// Actualitzar la distribució de taules / posicions al plànol del bar (des del Dashboard del Bar)
app.put('/api/venues/:id/tables', (req, res) => {
  const venue = state.venues.find((v) => v.id === req.params.id);
  if (!venue) return res.status(404).json({ error: 'Bar no trobat' });

  const { tables } = req.body;
  if (Array.isArray(tables)) {
    tables.forEach((updated) => {
      const existing = venue.tables.find((t) => t.id === updated.id);
      if (existing) {
        if (updated.x !== undefined) existing.x = Math.max(4, Math.min(96, Number(updated.x)));
        if (updated.y !== undefined) existing.y = Math.max(6, Math.min(94, Number(updated.y)));
        if (updated.name !== undefined) existing.name = updated.name;
        if (updated.zoneId !== undefined) existing.zoneId = updated.zoneId;
        if (updated.seats !== undefined) existing.seats = Number(updated.seats);
      } else {
        // Nova taula afegida pel responsable del bar
        const soundAdc = 15;
        venue.tables.push({
          id: updated.id || `T${venue.tables.length + 1}`,
          name: updated.name || `Taula ${venue.tables.length + 1}`,
          sensorId: updated.sensorId || `QB-NODE-0${venue.tables.length + 1}`,
          isPhysicalPoC: false,
          zoneId: updated.zoneId || venue.zones[0].id,
          x: Number(updated.x || 50),
          y: Number(updated.y || 50),
          seats: Number(updated.seats || 4),
          soundAdc,
          dBA: adcToDba(soundAdc),
          peakAdc: soundAdc,
          peakDba: adcToDba(soundAdc),
          accelMs2: 0.08,
          status: 'normal',
          cause: 'normal',
          causeLabel: 'Calma ambiental',
          inAlertMode: false,
          currentIntervalMs: 3000,
          quietTimeMs: 0,
          battery: 100,
          lastUpdate: new Date().toISOString(),
          source: 'simulator'
        });
      }
    });
  }

  const fullState = getFullClientState();
  io.emit('state:sync', fullState);
  res.json({ ok: true, tables: venue.tables });
});

// Marcar un avís/alerta com atès pel cambrer o tècnic
app.post('/api/alerts/:id/ack', (req, res) => {
  const alertItem = state.alertsLog.find((a) => a.id === req.params.id);
  if (alertItem) {
    alertItem.acknowledged = true;
    alertItem.acknowledgedAt = new Date().toISOString();
  }
  io.emit('alerts:updated', state.alertsLog);
  res.json({ ok: true, alertsLog: state.alertsLog });
});

// Endpoint per disparar un escenari de prova sobre el node PoC o activar/desactivar la simulació
app.post('/api/simulate/poc', (req, res) => {
  const { scenario, soundAdc, accelMs2, demoSimulationActive } = req.body;

  if (typeof demoSimulationActive === 'boolean') {
    state.edgeConnection.demoSimulationActive = demoSimulationActive;
    io.emit('state:sync', getFullClientState());
    return res.json({ ok: true, demoSimulationActive });
  }

  let simSound = soundAdc ?? 14;
  let simAccel = accelMs2 ?? 0.08;

  if (scenario === 'calm') {
    simSound = 12;
    simAccel = 0.06;
  } else if (scenario === 'warning_chatter') {
    simSound = state.thresholds.soundWarningAdc + 4;
    simAccel = 0.35;
  } else if (scenario === 'alert_chatter') {
    simSound = state.thresholds.soundAlertAdc + 25;
    simAccel = 0.45;
  } else if (scenario === 'alert_drag') {
    simSound = state.thresholds.soundAlertAdc + 18;
    simAccel = Number((state.thresholds.motionAlertMs2 + 0.65).toFixed(2));
  } else if (scenario === 'alert_impact') {
    simSound = state.thresholds.soundWarningAdc + 2;
    simAccel = Number((state.thresholds.motionAlertMs2 + 0.95).toFixed(2));
  }

  const result = processIncomingTelemetry(
    {
      venueId: req.body.venueId || 'ven-001',
      tableId: req.body.tableId || 'T1',
      soundAdc: simSound,
      accelMs2: simAccel,
      source: req.body.source || 'simulator'
    },
    'Simulator'
  );

  res.json(result);
});

// ============================================================================
// 7. WEBSOCKETS (Socket.IO) & BROKER MQTT INTEGRAT (Aedes port 1883)
// ============================================================================
io.on('connection', (socket) => {
  socket.emit('state:sync', getFullClientState());

  // Permet que l'Edge o el FrontEnd enviïn telemetria directament per WebSocket
  socket.on('edge:telemetry', (payload) => {
    processIncomingTelemetry(payload, 'WebSocket');
  });
});

// Broker MQTT integrat (compatible amb Quiet_Architecture.png: Arduino UNO Q -> WiFi -> MQTT)
const mqttServer = net.createServer(aedes.handle);
mqttServer.listen(MQTT_PORT, () => {
  console.log(`[MQTT Broker] Escoltant al port ${MQTT_PORT} (Tòpic: quietvenue/telemetry)`);
});

aedes.on('publish', (packet, client) => {
  if (!client) return;
  const topic = packet.topic;
  if (topic.startsWith('quietvenue/') || topic.startsWith('quietbar/')) {
    try {
      const payloadStr = packet.payload.toString();
      const data = JSON.parse(payloadStr);
      processIncomingTelemetry({ ...data, source: 'hardware_live' }, 'MQTT');
    } catch (err) {
      console.error('[MQTT] Error parsejant JSON:', err.message);
    }
  }
});

// ============================================================================
// 8. BUCLE DE SIMULACIÓ AMBIENTAL PER A LA CIUTAT I TAULES SECUNDÀRIES
// ============================================================================
setInterval(() => {
  // Si han passat més de 15 segons sense paquets físics de l'Arduino UNO Q, marquem com desconnectat
  if (
    state.edgeConnection.connected &&
    state.edgeConnection.lastPacketAt &&
    Date.now() - new Date(state.edgeConnection.lastPacketAt).getTime() > 15000
  ) {
    state.edgeConnection.connected = false;
  }

  // Actualitzem lleugerament les taules secundàries dels bars perquè el mapa de calor visqui en temps real
  state.venues.forEach((venue) => {
    const thresholds = getEffectiveThresholds(venue);
    venue.tables.forEach((table) => {
      if (table.isPhysicalPoC) {
        // Si el mode demo està actiu i no hi ha el maquinari físic enviant dades, fem una simulació suau
        if (state.edgeConnection.demoSimulationActive && !state.edgeConnection.connected) {
          const r = Math.random();
          let nextAdc = table.soundAdc + Math.round((Math.random() - 0.48) * 5);
          let nextAccel = Number((0.06 + Math.random() * 0.18).toFixed(2));
          if (r > 0.94) {
            // Esporàdicament simulem un pic d'arrossegament de cadira o conversa alta
            nextAdc = thresholds.soundAlertAdc + Math.round(Math.random() * 18);
            nextAccel = Number((thresholds.motionAlertMs2 + 0.35).toFixed(2));
          } else if (r > 0.84) {
            nextAdc = thresholds.soundWarningAdc + Math.round(Math.random() * 6);
          } else {
            nextAdc = Math.max(10, Math.min(thresholds.soundWarningAdc - 3, nextAdc));
          }
          processIncomingTelemetry(
            {
              venueId: venue.id,
              tableId: table.id,
              soundAdc: nextAdc,
              accelMs2: nextAccel,
              source: 'simulator'
            },
            'Simulator'
          );
        }
        return;
      }

      // Variació suau per a la resta de taules de Molins de Rei
      const deltaAdc = Math.round((Math.random() - 0.5) * 4);
      let newAdc = Math.max(10, Math.min(75, table.soundAdc + deltaAdc));
      let newAccel = Number((0.05 + Math.random() * 0.22).toFixed(2));

      // Mantenim perfils característics per bar (ex: ven-002 i ven-005 més sorollosos)
      if ((venue.id === 'ven-002' || venue.id === 'ven-005') && Math.random() > 0.72) {
        newAdc = thresholds.soundAlertAdc + Math.round(Math.random() * 15);
        if (Math.random() > 0.6) {
          newAccel = Number((thresholds.motionAlertMs2 + 0.3).toFixed(2));
        }
      }

      const evalRes = evaluateReading(newAdc, newAccel, table, thresholds, 3000);
      table.soundAdc = newAdc;
      table.dBA = evalRes.dBA;
      table.peakAdc = Math.max(table.peakAdc || 0, newAdc);
      table.peakDba = Math.max(table.peakDba || 0, evalRes.dBA);
      table.accelMs2 = newAccel;
      table.status = evalRes.status;
      table.cause = evalRes.cause;
      table.causeLabel = evalRes.causeLabel;
      table.inAlertMode = evalRes.inAlertMode;
      table.currentIntervalMs = evalRes.currentIntervalMs;
      table.lastUpdate = new Date().toISOString();
    });
  });

  io.emit('city:heartbeat', {
    venues: state.venues.map((v) => ({
      ...v,
      summary: computeVenueSummary(v)
    })),
    edgeConnection: state.edgeConnection
  });
}, 3000);

server.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`  QuietVenue IoT Cloud Server actiu a http://localhost:${PORT}`);
  console.log(`  REST API + Socket.IO WebSockets + MQTT Broker (port ${MQTT_PORT})`);
  console.log(`=============================================================`);
});
