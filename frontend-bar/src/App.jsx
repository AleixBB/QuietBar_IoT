import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  Volume2,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Radio,
  Wifi,
  Battery,
  Move,
  Plus,
  Save,
  Bell,
  Sliders,
  Flame,
  Cpu,
  Clock,
  Sparkles,
  ShieldAlert,
  MapPin,
  RefreshCw
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine
} from 'recharts';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function App() {
  const [appState, setAppState] = useState(null);
  const [selectedVenueId, setSelectedVenueId] = useState('ven-001');
  const [selectedTableId, setSelectedTableId] = useState('T1');
  const [isEditingLayout, setIsEditingLayout] = useState(false);
  const [draggingTableId, setDraggingTableId] = useState(null);
  const [showInternalHeatmap, setShowInternalHeatmap] = useState(true);
  const [thresholdNotice, setThresholdNotice] = useState(null);
  const [newTableModal, setNewTableModal] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableZone, setNewTableZone] = useState('zone-terrace-north');
  const [newTableSeats, setNewTableSeats] = useState(4);

  const floorPlanRef = useRef(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/state`)
      .then((r) => r.json())
      .then((data) => setAppState(data))
      .catch((err) => console.error('Error connectant al backend:', err));

    const socket = io(BACKEND_URL);

    socket.on('state:sync', (fullState) => {
      setAppState(fullState);
    });

    socket.on('thresholds:updated', (newThresholds) => {
      setThresholdNotice(
        `L'Ajuntament ha actualitzat els límits: Avís ${newThresholds.soundWarningAdc} ADC (${newThresholds.soundWarningDba} dBA) | Alerta ${newThresholds.soundAlertAdc} ADC (${newThresholds.soundAlertDba} dBA) | Vibració ${newThresholds.motionAlertMs2} m/s²`
      );
      setTimeout(() => setThresholdNotice(null), 9000);
    });

    socket.on('telemetry:update', (payload) => {
      setAppState((prev) => {
        if (!prev) return prev;
        const nextVenues = prev.venues.map((v) => {
          if (v.id !== payload.venueId) return v;
          const nextTables = v.tables.map((t) =>
            t.id === payload.table.id ? payload.table : t
          );
          return {
            ...v,
            tables: nextTables,
            summary: payload.venueSummary || v.summary
          };
        });
        const nextHistory = payload.pocHistoryPoint
          ? [...prev.pocTelemetryHistory.slice(-59), payload.pocHistoryPoint]
          : prev.pocTelemetryHistory;

        return {
          ...prev,
          venues: nextVenues,
          pocTelemetryHistory: nextHistory,
          edgeConnection: payload.edgeConnection || prev.edgeConnection
        };
      });
    });

    socket.on('city:heartbeat', (payload) => {
      setAppState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          venues: payload.venues,
          edgeConnection: payload.edgeConnection
        };
      });
    });

    socket.on('alert:new', (newAlert) => {
      setAppState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          alertsLog: [newAlert, ...prev.alertsLog.slice(0, 49)]
        };
      });
    });

    socket.on('alerts:updated', (alertsLog) => {
      setAppState((prev) => (prev ? { ...prev, alertsLog } : prev));
    });

    return () => socket.disconnect();
  }, []);

  if (!appState) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
          <h2 className="text-xl font-bold">Connectant amb QuietVenue Cloud & Edge...</h2>
          <p className="text-sm text-slate-400">
            Assegura&apos;t que el servidor backend està en marxa a <code className="text-emerald-400">{BACKEND_URL}</code>
          </p>
        </div>
      </div>
    );
  }

  const venue = appState.venues.find((v) => v.id === selectedVenueId) || appState.venues[0];
  const thresholds = venue.summary?.thresholds || appState.thresholds;
  const selectedTable = venue.tables.find((t) => t.id === selectedTableId) || venue.tables[0];
  const pocTable = venue.tables.find((t) => t.isPhysicalPoC) || venue.tables[0];
  const venueAlerts = appState.alertsLog.filter((a) => a.venueId === venue.id);
  const activeUnackedAlerts = venueAlerts.filter((a) => !a.acknowledged);

  // Ordenem les zones del bar de més sorollosa a menys sorollosa
  const sortedZones = [...(venue.summary?.zoneStats || [])].sort((a, b) => b.avgDba - a.avgDba);
  const loudestZone = sortedZones[0];

  // Drag & Drop de taules sobre el plànol
  const handleFloorPlanPointerMove = (e) => {
    if (!isEditingLayout || !draggingTableId || !floorPlanRef.current) return;
    const rect = floorPlanRef.current.getBoundingClientRect();
    const xPct = Math.max(5, Math.min(95, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    const yPct = Math.max(8, Math.min(92, Math.round(((e.clientY - rect.top) / rect.height) * 100)));

    // Detectem a quina zona cau la taula automàticament
    let detectedZoneId = null;
    for (const z of venue.zones) {
      if (xPct >= z.x && xPct <= z.x + z.w && yPct >= z.y && yPct <= z.y + z.h) {
        detectedZoneId = z.id;
        break;
      }
    }

    setAppState((prev) => ({
      ...prev,
      venues: prev.venues.map((v) => {
        if (v.id !== venue.id) return v;
        return {
          ...v,
          tables: v.tables.map((t) =>
            t.id === draggingTableId
              ? { ...t, x: xPct, y: yPct, zoneId: detectedZoneId || t.zoneId }
              : t
          )
        };
      })
    }));
  };

  const handleSaveLayout = async () => {
    setIsEditingLayout(false);
    setDraggingTableId(null);
    await fetch(`${BACKEND_URL}/api/venues/${venue.id}/tables`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables: venue.tables })
    });
  };

  const handleAddTable = async (e) => {
    e.preventDefault();
    const zoneObj = venue.zones.find((z) => z.id === newTableZone) || venue.zones[0];
    const newTable = {
      id: `T${venue.tables.length + 1}`,
      name: newTableName.trim() || `Taula ${venue.tables.length + 1}`,
      sensorId: `QB-NODE-0${venue.tables.length + 1}`,
      zoneId: zoneObj.id,
      x: Math.round(zoneObj.x + zoneObj.w / 2),
      y: Math.round(zoneObj.y + zoneObj.h / 2),
      seats: Number(newTableSeats)
    };
    await fetch(`${BACKEND_URL}/api/venues/${venue.id}/tables`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables: [...venue.tables, newTable] })
    });
    setNewTableName('');
    setNewTableModal(false);
  };

  const triggerPoCScenario = async (scenario) => {
    await fetch(`${BACKEND_URL}/api/simulate/poc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venueId: venue.id,
        tableId: pocTable.id,
        scenario
      })
    });
  };

  const toggleDemoSimulation = async () => {
    await fetch(`${BACKEND_URL}/api/simulate/poc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        demoSimulationActive: !appState.edgeConnection.demoSimulationActive
      })
    });
  };

  const acknowledgeAlert = async (alertId) => {
    await fetch(`${BACKEND_URL}/api/alerts/${alertId}/ack`, { method: 'POST' });
  };

  const getStatusBadge = (status) => {
    if (status === 'alert') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
          <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
          MODE ALERTA
        </span>
      );
    }
    if (status === 'warning') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          AVÍS PREVENTIU
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        NORMAL (CALMA)
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* AVÍS D'ACTUALITZACIÓ DE LÍMITS EN TEMPS REAL DES DE L'AJUNTAMENT */}
      {thresholdNotice && (
        <div className="bg-amber-500/20 border-b border-amber-500/40 px-6 py-2.5 flex items-center justify-between text-amber-200 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{thresholdNotice}</span>
          </div>
          <button
            onClick={() => setThresholdNotice(null)}
            className="text-xs underline hover:text-white"
          >
            Tancar
          </button>
        </div>
      )}

      {/* HEADER DEL BAR */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-6 py-3.5">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Volume2 className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  QuietBar — Dashboard del Local
                </h1>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                  Staff & Responsables
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Monitorització acústica i de vibracions per taules i zones en temps real (GDPR Compliant)
              </p>
            </div>
          </div>

          {/* Selector de Bar + Estat del Hardware PoC */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-800/90 border border-slate-700 rounded-lg px-3 py-1.5">
              <MapPin className="w-4 h-4 text-emerald-400" />
              <select
                value={selectedVenueId}
                onChange={(e) => {
                  setSelectedVenueId(e.target.value);
                  const v = appState.venues.find((item) => item.id === e.target.value);
                  if (v && v.tables[0]) setSelectedTableId(v.tables[0].id);
                }}
                className="bg-transparent text-sm font-semibold text-white focus:outline-none"
              >
                {appState.venues.map((v) => (
                  <option key={v.id} value={v.id} className="bg-slate-900 text-white">
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Estat connexió Edge Gateway (Arduino UNO Q + nRF52840) */}
            <div
              className={`flex items-center gap-2.5 px-3.5 py-1.5 rounded-lg border text-xs font-medium ${
                appState.edgeConnection.connected
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-sky-500/15 border-sky-500/40 text-sky-300'
              }`}
            >
              <Cpu className="w-4 h-4 shrink-0" />
              <div>
                <div className="font-bold">
                  {appState.edgeConnection.connected
                    ? `PoC Físic Connectat (${appState.edgeConnection.protocol})`
                    : 'Edge Gateway: Arduino UNO Q + nRF52840'}
                </div>
                <div className="text-[11px] opacity-80">
                  {appState.edgeConnection.connected
                    ? `Paquets rebuts: ${appState.edgeConnection.packetsReceived}`
                    : appState.edgeConnection.demoSimulationActive
                    ? 'Mode Demo Actiu (Esperant trama Sèrie/HTTP)'
                    : 'En espera de dades del sensor físic'}
                </div>
              </div>
            </div>

            {/* Semàfor Global del Bar */}
            {getStatusBadge(venue.summary?.overallStatus || 'normal')}
          </div>
        </div>
      </header>

      {/* CONTINGUT PRINCIPAL */}
      <main className="max-w-[1600px] w-full mx-auto flex-1 p-6 space-y-6">
        {/* FILA 1: KPI CARDS DEL BAR I DEL SENSOR POC */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Card 1: Sensor PoC Soroll */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Soroll Node PoC (Taula 1)
              </span>
              <Volume2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-white">{pocTable.soundAdc}</span>
              <span className="text-xs font-semibold text-emerald-400">ADC (0-4095)</span>
              <span className="ml-auto text-lg font-bold text-slate-300">{pocTable.dBA} dBA</span>
            </div>
            <div className="text-xs text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Límit Avís: {thresholds.soundWarningAdc} ADC</span>
              <span className="text-rose-400 font-semibold">Alerta: {thresholds.soundAlertAdc} ADC</span>
            </div>
          </div>

          {/* Card 2: Sensor PoC Vibració MPU6050 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Vibració MPU-6050 (Taula 1)
              </span>
              <Activity className="w-4 h-4 text-sky-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-white">
                {Number(pocTable.accelMs2).toFixed(2)}
              </span>
              <span className="text-xs font-semibold text-sky-400">m/s²</span>
              <span className="ml-auto text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                {pocTable.accelMs2 >= thresholds.motionAlertMs2 ? '🪑 Moviment/Arrossegament!' : 'Estable'}
              </span>
            </div>
            <div className="text-xs text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Avís: {thresholds.motionWarningMs2} m/s²</span>
              <span className="text-rose-400 font-semibold">Alerta: {thresholds.motionAlertMs2} m/s²</span>
            </div>
          </div>

          {/* Card 3: Estat Firmware Zephyr nRF52840 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Estat BLE nRF52840 (Zephyr)
              </span>
              <Clock className="w-4 h-4 text-purple-400" />
            </div>
            <div className="my-2 flex items-center justify-between">
              <div>
                <div className="text-lg font-extrabold text-white">
                  {pocTable.inAlertMode ? 'ALERT_MODE' : 'NORMAL_MODE'}
                </div>
                <div className="text-xs text-slate-400">{pocTable.causeLabel}</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-bold text-purple-400">{pocTable.currentIntervalMs} ms</div>
                <div className="text-[11px] text-slate-400">Interval GATT Notify</div>
              </div>
            </div>
            <div className="text-xs text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Retorn calma: {thresholds.quietTimeRequiredMs} ms</span>
              <span>Bat: {pocTable.battery}%</span>
            </div>
          </div>

          {/* Card 4: Zona Més Sorollosa del Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Zona amb Més Soroll Ara
              </span>
              <Flame className="w-4 h-4 text-amber-400" />
            </div>
            <div className="my-2">
              <div className="text-base font-bold text-white truncate">
                {loudestZone ? loudestZone.name : 'Terrassa Nord'}
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-extrabold text-amber-400">
                  {loudestZone ? loudestZone.avgDba : 60} dBA
                </span>
                <span className="text-xs text-slate-400">
                  (Mitjana: {loudestZone ? loudestZone.avgAdc : 20} ADC)
                </span>
              </div>
            </div>
            <div className="text-xs text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Pic màxim local: {venue.summary?.maxDba} dBA</span>
              <span>{venue.tables.length} taules</span>
            </div>
          </div>

          {/* Card 5: Avisos per als Cambrers */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Avisos Actius (Cambrers)
              </span>
              <Bell className="w-4 h-4 text-rose-400" />
            </div>
            <div className="my-2 flex items-baseline justify-between">
              <div>
                <span className="text-3xl font-extrabold text-white">
                  {activeUnackedAlerts.length}
                </span>
                <span className="text-xs text-slate-400 ml-2">pendents d&apos;atendre</span>
              </div>
              <span className="text-sm font-bold text-emerald-400">
                {venue.summary?.complianceScore}% Compliment
              </span>
            </div>
            <div className="text-xs text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>🪑 Arrossegaments avui: {venue.summary?.dragEventsToday}</span>
              <span>🗣️ Veu alta: {venue.summary?.chatterEventsToday}</span>
            </div>
          </div>
        </div>

        {/* FILA 2: PLÀNOL DE DISTRIBUCIÓ DE TAULES I MAPA DE CALOR INTERN DEL BAR + ZONES */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* PLÀNOL DEL BAR (8 columnes) */}
          <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  Distribució de Taules, Sensors i Mapa de Calor per Zones
                </h2>
                <p className="text-xs text-slate-400">
                  Clica una taula per inspeccionar-ne el sensor. Activa &quot;Editar Distribució&quot; per moure les taules pel bar.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowInternalHeatmap(!showInternalHeatmap)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition flex items-center gap-1.5 ${
                    showInternalHeatmap
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                >
                  <Flame className="w-3.5 h-3.5" />
                  {showInternalHeatmap ? 'Mapa de Calor Actiu' : 'Mostrar Calor'}
                </button>

                {!isEditingLayout ? (
                  <>
                    <button
                      onClick={() => setNewTableModal(true)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 flex items-center gap-1.5 transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Afegir Taula
                    </button>
                    <button
                      onClick={() => setIsEditingLayout(true)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-slate-950 flex items-center gap-1.5 transition"
                    >
                      <Move className="w-3.5 h-3.5" />
                      Editar Distribució
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleSaveLayout}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center gap-1.5 shadow-lg shadow-amber-500/20"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Desar Plànol de Taules
                  </button>
                )}
              </div>
            </div>

            {/* ÀREA DEL PLÀNOL INTERACTIU */}
            <div
              ref={floorPlanRef}
              onPointerMove={handleFloorPlanPointerMove}
              onPointerUp={() => setDraggingTableId(null)}
              className="relative w-full h-[460px] rounded-xl bg-slate-950 border border-slate-800 overflow-hidden select-none"
              style={{
                backgroundImage:
                  'radial-gradient(circle, rgba(148, 163, 184, 0.12) 1px, transparent 1px)',
                backgroundSize: '24px 24px'
              }}
            >
              {/* ZONES DEL BAR */}
              {(venue.summary?.zoneStats || venue.zones).map((zone) => {
                const isZoneAlert = zone.status === 'alert';
                const isZoneWarn = zone.status === 'warning';
                return (
                  <div
                    key={zone.id}
                    style={{
                      left: `${zone.x}%`,
                      top: `${zone.y}%`,
                      width: `${zone.w}%`,
                      height: `${zone.h}%`
                    }}
                    className={`absolute rounded-xl border-2 border-dashed transition-colors p-3 flex flex-col justify-between pointer-events-none ${
                      isZoneAlert
                        ? 'border-rose-500/60 bg-rose-950/20'
                        : isZoneWarn
                        ? 'border-amber-500/50 bg-amber-950/15'
                        : 'border-slate-700/70 bg-slate-900/35'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-300 bg-slate-900/90 px-2.5 py-1 rounded-md border border-slate-700">
                        {zone.name}
                      </span>
                      {zone.avgDba && (
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded ${
                            isZoneAlert
                              ? 'bg-rose-500/30 text-rose-200'
                              : isZoneWarn
                              ? 'bg-amber-500/30 text-amber-200'
                              : 'bg-emerald-500/20 text-emerald-300'
                          }`}
                        >
                          Mitjana Zona: {zone.avgDba} dBA ({zone.avgAdc} ADC)
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* HALOS DEL MAPA DE CALOR INTERN DE CADA TAULA */}
              {showInternalHeatmap &&
                venue.tables.map((table) => {
                  const intensity = Math.min(1, Math.max(0.2, (table.dBA - 42) / 45));
                  const radiusPx = 75 + intensity * 95;
                  const gradientColor =
                    table.status === 'alert'
                      ? 'rgba(244, 63, 94, 0.42)'
                      : table.status === 'warning'
                      ? 'rgba(245, 158, 11, 0.35)'
                      : 'rgba(16, 185, 129, 0.22)';

                  return (
                    <div
                      key={`heat-${table.id}`}
                      style={{
                        left: `${table.x}%`,
                        top: `${table.y}%`,
                        width: `${radiusPx * 2}px`,
                        height: `${radiusPx * 2}px`,
                        transform: 'translate(-50%, -50%)',
                        background: `radial-gradient(circle, ${gradientColor} 0%, rgba(15,23,42,0) 70%)`
                      }}
                      className="absolute rounded-full pointer-events-none transition-all duration-500"
                    />
                  );
                })}

              {/* TAULES I SENSORS */}
              {venue.tables.map((table) => {
                const isSelected = table.id === selectedTable.id;
                const isAlert = table.status === 'alert';
                const isWarn = table.status === 'warning';

                return (
                  <div
                    key={table.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedTableId(table.id);
                      if (isEditingLayout) {
                        setDraggingTableId(table.id);
                      }
                    }}
                    style={{
                      left: `${table.x}%`,
                      top: `${table.y}%`,
                      transform: 'translate(-50%, -50%)'
                    }}
                    className={`absolute z-10 transition-transform ${
                      isEditingLayout ? 'cursor-grab active:cursor-grabbing scale-105' : 'cursor-pointer'
                    }`}
                  >
                    {/* Anell animat en cas d'alerta */}
                    {isAlert && (
                      <div className="absolute -inset-3 rounded-2xl bg-rose-500/40 animate-pulse-ring pointer-events-none" />
                    )}

                    <div
                      className={`relative min-w-[122px] rounded-xl p-2.5 border-2 shadow-xl backdrop-blur transition-all ${
                        isAlert
                          ? 'bg-rose-950/90 border-rose-500 text-rose-100 shadow-rose-500/30'
                          : isWarn
                          ? 'bg-amber-950/90 border-amber-400 text-amber-100 shadow-amber-500/20'
                          : 'bg-slate-900/95 border-emerald-500/70 text-slate-100'
                      } ${isSelected ? 'ring-4 ring-white/30 scale-105' : ''}`}
                    >
                      {/* Badge PoC Real */}
                      {table.isPhysicalPoC && (
                        <div className=" -top-2.5 left-2 right-2 flex justify-center mb-1">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-400 text-slate-950 shadow">
                            ★ Node PoC Real
                          </span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-extrabold truncate">{table.name}</span>
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            isAlert
                              ? 'bg-rose-400 animate-ping'
                              : isWarn
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                          }`}
                        />
                      </div>

                      <div className="mt-1 flex items-baseline justify-between">
                        <span className="text-base font-black">{table.dBA} dBA</span>
                        <span className="text-[11px] font-mono opacity-85">{table.soundAdc} ADC</span>
                      </div>

                      <div className="mt-0.5 flex items-center justify-between text-[10px] opacity-85">
                        <span>Vib: {Number(table.accelMs2).toFixed(2)} m/s²</span>
                        <span>{table.seats}p</span>
                      </div>

                      {(isAlert || isWarn) && (
                        <div className="mt-1 pt-1 border-t border-white/15 text-[10px] font-semibold truncate">
                          {table.cause === 'drag' ? '🪑 Arrossegament!' : '🗣️ Soroll elevat'}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Llegenda inferior */}
              <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-xs">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    Normal (&lt; {thresholds.soundWarningAdc} ADC / {thresholds.soundWarningDba} dBA)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    Avís ({thresholds.soundWarningAdc}–{thresholds.soundAlertAdc} ADC)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                    Alerta (&ge; {thresholds.soundAlertAdc} ADC o &ge; {thresholds.motionAlertMs2} m/s²)
                  </span>
                </div>
                <span className="text-slate-400">
                  Gateway: <strong className="text-slate-200">{venue.gatewayId}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* COLUMNA DRETA (4 columnes): ANÀLISI PER ZONES DEL BAR + DETALL DE LA TAULA SELECCIONADA */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            {/* QUINA ZONA DEL BAR FA MÉS SOROLL? */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Flame className="w-4 h-4 text-amber-400" />
                  Soroll per Zones del Bar
                </h3>
                <span className="text-xs text-slate-400">Temps real</span>
              </div>

              <div className="space-y-3">
                {sortedZones.map((z, idx) => {
                  const pct = Math.min(100, Math.max(15, Math.round(((z.avgDba - 35) / 60) * 100)));
                  return (
                    <div
                      key={z.id}
                      className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-extrabold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            #{idx + 1}
                          </span>
                          <span className="text-sm font-bold text-white">{z.name}</span>
                        </div>
                        <span
                          className={`text-sm font-extrabold ${
                            z.status === 'alert'
                              ? 'text-rose-400'
                              : z.status === 'warning'
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                          }`}
                        >
                          {z.avgDba} dBA ({z.avgAdc} ADC)
                        </span>
                      </div>

                      <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          style={{ width: `${pct}%` }}
                          className={`h-full rounded-full transition-all duration-500 ${
                            z.status === 'alert'
                              ? 'bg-rose-500'
                              : z.status === 'warning'
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>{z.tableCount} taules monitoritzades</span>
                        <span>Pic zona: {z.maxDba} dBA</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* DETALL DE LA TAULA SELECCIONADA + BANCS DE PROVA POC */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex-1 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-emerald-400 font-bold">
                      Inspecció de Sensor Actiu
                    </span>
                    <h3 className="text-lg font-extrabold text-white">{selectedTable.name}</h3>
                  </div>
                  {getStatusBadge(selectedTable.status)}
                </div>

                <div className="grid grid-cols-2 gap-2.5 my-3 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400 block">ID Sensor BLE</span>
                    <span className="font-mono font-bold text-slate-200">{selectedTable.sensorId}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400 block">Font de Dades</span>
                    <span className="font-bold text-emerald-400">
                      {selectedTable.source === 'hardware_live' ? 'Maquinari Físic Live' : 'Simulador / Demo'}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400 block">Amplitud Grove ADC</span>
                    <span className="text-base font-extrabold text-white">
                      {selectedTable.soundAdc} ADC ({selectedTable.dBA} dBA)
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400 block">MPU-6050 Vibració</span>
                    <span className="text-base font-extrabold text-sky-400">
                      {Number(selectedTable.accelMs2).toFixed(2)} m/s²
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Diagnòstic IA / DSP:</span>
                    <span className="font-bold text-white">{selectedTable.causeLabel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Cadència BLE Notify:</span>
                    <span className="font-mono text-purple-300">{selectedTable.currentIntervalMs} ms</span>
                  </div>
                </div>
              </div>

              {/* BANC DE PROVES RÀPID PER SIMULAR EL NODE POC SI NO ESTÀ ENDOLLAT */}
              <div className="mt-4 pt-4 border-t border-slate-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                    Simulador d&apos;Escenaris PoC (Taula 1)
                  </span>
                  <button
                    onClick={toggleDemoSimulation}
                    className={`text-[11px] px-2 py-0.5 rounded border font-semibold ${
                      appState.edgeConnection.demoSimulationActive
                        ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400'
                    }`}
                  >
                    Auto-Demo: {appState.edgeConnection.demoSimulationActive ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => triggerPoCScenario('calm')}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition"
                  >
                    🟢 Calma (12 ADC)
                  </button>
                  <button
                    onClick={() => triggerPoCScenario('warning_chatter')}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition"
                  >
                    🟡 Avís Veu Alta
                  </button>
                  <button
                    onClick={() => triggerPoCScenario('alert_chatter')}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition"
                  >
                    🔴 Alerta Soroll Fort
                  </button>
                  <button
                    onClick={() => triggerPoCScenario('alert_drag')}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-500/40 transition"
                  >
                    🪑 Arrossegar Cadira
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* FILA 3: GRÀFIQUES EN TEMPS REAL DEL DISPOSITIU POC (nRF52840 + Arduino UNO Q) + SAFATA D'AVISOS */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* GRÀFIQUES TELEMETRIA POC (8 columnes) */}
          <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Radio className="w-4 h-4 text-emerald-400" />
                  Telemetria en Temps Real — Proof of Concept (nRF52840 BLE &rarr; Arduino UNO Q)
                </h3>
                <p className="text-xs text-slate-400">
                  Corbes en viu de les característiques GATT <code className="text-emerald-400">...abcdef1</code> (Grove Sound ADC) i <code className="text-sky-400">...abcdef2</code> (MPU6050 m/s²) amb els límits de l&apos;Ajuntament.
                </p>
              </div>
              <span className="text-xs font-mono bg-slate-950 px-2.5 py-1 rounded border border-slate-800 text-slate-300">
                Límits actius: Avís={thresholds.soundWarningAdc} ADC | Alerta={thresholds.soundAlertAdc} ADC | Vib={thresholds.motionAlertMs2} m/s²
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Gràfica 1: Soroll ADC */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                <div className="text-xs font-bold text-slate-300 mb-2 flex justify-between">
                  <span>Amplitud Acústica Grove v1.0 (ADC)</span>
                  <span className="text-emerald-400">{pocTable.soundAdc} ADC ({pocTable.dBA} dBA)</span>
                </div>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={appState.pocTelemetryHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="timeLabel" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <YAxis domain={[0, Math.max(80, thresholds.soundAlertAdc + 25)]} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: '12px' }}
                      />
                      <ReferenceLine
                        y={thresholds.soundWarningAdc}
                        stroke="#f59e0b"
                        strokeDasharray="4 4"
                        label={{ value: 'Avís', fill: '#f59e0b', fontSize: 10 }}
                      />
                      <ReferenceLine
                        y={thresholds.soundAlertAdc}
                        stroke="#f43f5e"
                        strokeDasharray="4 4"
                        label={{ value: 'Alerta', fill: '#f43f5e', fontSize: 10 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="soundAdc"
                        name="Soroll (ADC)"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.2}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Gràfica 2: Vibració MPU6050 */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                <div className="text-xs font-bold text-slate-300 mb-2 flex justify-between">
                  <span>Acceleròmetre Dinàmic MPU-6050 (m/s²)</span>
                  <span className="text-sky-400">{Number(pocTable.accelMs2).toFixed(2)} m/s²</span>
                </div>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={appState.pocTelemetryHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="timeLabel" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <YAxis domain={[0, Math.max(3.5, thresholds.motionAlertMs2 + 1)]} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: '12px' }}
                      />
                      <ReferenceLine
                        y={thresholds.motionAlertMs2}
                        stroke="#f43f5e"
                        strokeDasharray="4 4"
                        label={{ value: `Límit Moviment (${thresholds.motionAlertMs2} m/s²)`, fill: '#f43f5e', fontSize: 10 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="accelMs2"
                        name="Vibració (m/s²)"
                        stroke="#38bdf8"
                        strokeWidth={2.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>

          {/* REGISTRE D'ALERTES I INTERVENCIÓ DEL PERSONAL (4 columnes) */}
          <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Bell className="w-4 h-4 text-rose-400" />
                Avisos d&apos;Intervenció per al Personal
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-bold">
                {activeUnackedAlerts.length} pendents
              </span>
            </div>

            <div className="flex-1 overflow-y-auto max-h-[270px] space-y-2.5 pr-1">
              {venueAlerts.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  Cap incidència registrada en aquest local.
                </div>
              ) : (
                venueAlerts.map((alt) => (
                  <div
                    key={alt.id}
                    className={`p-3 rounded-xl border transition ${
                      alt.acknowledged
                        ? 'bg-slate-950/40 border-slate-800/80 opacity-60'
                        : alt.level === 'alert'
                        ? 'bg-rose-950/30 border-rose-500/50'
                        : 'bg-amber-950/30 border-amber-500/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-xs font-extrabold text-white">
                          {alt.tableName} — {alt.zoneName}
                        </span>
                        <p className="text-xs text-slate-300 mt-0.5">{alt.causeLabel}</p>
                        <div className="text-[11px] text-slate-400 mt-1 font-mono">
                          {alt.soundAdc} ADC ({alt.dBA} dBA) | Vib: {alt.accelMs2} m/s² |{' '}
                          {new Date(alt.timestamp).toLocaleTimeString('ca-ES')}
                        </div>
                      </div>

                      {!alt.acknowledged ? (
                        <button
                          onClick={() => acknowledgeAlert(alt.id)}
                          className="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shrink-0"
                        >
                          Atendre
                        </button>
                      ) : (
                        <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Atès
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {/* MODAL AFEGIR NOVA TAULA */}
      {newTableModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleAddTable}
            className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md space-y-4"
          >
            <h3 className="text-lg font-bold text-white">Afegir Nova Taula i Sensor al Plànol</h3>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Nom de la Taula</label>
              <input
                type="text"
                placeholder={`Ex: Taula ${venue.tables.length + 1}`}
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Zona del Bar</label>
              <select
                value={newTableZone}
                onChange={(e) => setNewTableZone(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                {venue.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Nombre de Cadires</label>
              <input
                type="number"
                min={2}
                max={12}
                value={newTableSeats}
                onChange={(e) => setNewTableSeats(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewTableModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300"
              >
                Cancel·lar
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg text-xs font-bold bg-emerald-500 text-slate-950"
              >
                Crear Taula
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
