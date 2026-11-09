import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import L from 'leaflet';
import {
  Building2,
  Flame,
  Sliders,
  AlertTriangle,
  Volume2,
  Activity,
  ShieldCheck,
  Radio,
  Save,
  RotateCcw,
  Trophy,
  MapPin,
  Bell,
  CheckCircle2,
  Cpu,
  Clock
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell
} from 'recharts';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function App() {
  const [appState, setAppState] = useState(null);
  const [selectedVenueId, setSelectedVenueId] = useState('ven-001');
  const [rankingSortBy, setRankingSortBy] = useState('avgDba'); // 'avgDba' | 'alertsToday' | 'dragEventsToday'
  const [saveSuccessMsg, setSaveSuccessMsg] = useState(null);

  // Form d'edició de llindars municipals (Globals)
  const [formThresholds, setFormThresholds] = useState({
    soundWarningAdc: 28,
    soundAlertAdc: 40,
    motionWarningMs2: 1.2,
    motionAlertMs2: 2.1,
    normalIntervalMs: 3000,
    alertIntervalMs: 500,
    quietTimeRequiredMs: 5000,
    schedulePreset: 'evening'
  });

  // Mapa Leaflet refs
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layersGroupRef = useRef(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/state`)
      .then((r) => r.json())
      .then((data) => {
        setAppState(data);
        if (data.thresholds) {
          setFormThresholds(data.thresholds);
        }
      })
      .catch((err) => console.error('Error connectant al backend:', err));

    const socket = io(BACKEND_URL);

    socket.on('state:sync', (fullState) => {
      setAppState(fullState);
      if (fullState.thresholds) {
        setFormThresholds(fullState.thresholds);
      }
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
        return {
          ...prev,
          venues: nextVenues,
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

    return () => socket.disconnect();
  }, []);

  // Inicialització del Mapa Leaflet centrat a Molins de Rei
  useEffect(() => {
    if (!appState || !mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [41.4138, 2.0158],
      zoom: 16,
      zoomControl: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO — Ajuntament de Molins de Rei',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;
    layersGroupRef.current = layerGroup;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [Boolean(appState)]);

  // Actualització dinàmica de la capa de Mapa de Calor i Marcadors de Bars a Molins de Rei
  useEffect(() => {
    if (!appState || !mapInstanceRef.current || !layersGroupRef.current) return;

    const group = layersGroupRef.current;
    group.clearLayers();

    appState.venues.forEach((venue) => {
      const s = venue.summary || {};
      const isSelected = venue.id === selectedVenueId;
      const isAlert = s.overallStatus === 'alert';
      const isWarn = s.overallStatus === 'warning';

      const baseColor = isAlert ? '#f43f5e' : isWarn ? '#f59e0b' : '#10b981';
      const heatRadiusOuter = 55 + Math.max(0, (s.maxDba - 45) * 1.9);
      const heatRadiusInner = heatRadiusOuter * 0.55;

      // Halo exterior de calor acústica
      L.circle([venue.lat, venue.lng], {
        radius: heatRadiusOuter,
        stroke: false,
        fillColor: baseColor,
        fillOpacity: isAlert ? 0.28 : isWarn ? 0.22 : 0.14
      }).addTo(group);

      // Nucli de calor acústica
      L.circle([venue.lat, venue.lng], {
        radius: heatRadiusInner,
        stroke: false,
        fillColor: baseColor,
        fillOpacity: isAlert ? 0.45 : isWarn ? 0.35 : 0.22
      }).addTo(group);

      // Pin interactiu del Bar amb el nivell de dBA en viu
      const iconHtml = `
        <div style="
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          cursor: pointer;
        ">
          ${
            venue.isPoCVenue
              ? `<div style="background:#10b981;color:#020617;font-size:9px;font-weight:900;padding:1px 6px;border-radius:99px;margin-bottom:2px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.6);">★ POC REAL</div>`
              : ''
          }
          <div style="
            background: ${isSelected ? '#ffffff' : '#0f172a'};
            color: ${isSelected ? '#020617' : '#f8fafc'};
            border: 3px solid ${baseColor};
            border-radius: 12px;
            padding: 4px 8px;
            font-weight: 800;
            font-size: 12px;
            white-space: nowrap;
            box-shadow: 0 0 18px ${baseColor}88;
            display: flex;
            align-items: center;
            gap: 5px;
          ">
            <span style="width:8px;height:8px;border-radius:99px;background:${baseColor};display:inline-block;"></span>
            <span>${s.avgDba} dBA</span>
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        html: iconHtml,
        className: 'custom-venue-pin',
        iconSize: [0, 0]
      });

      const marker = L.marker([venue.lat, venue.lng], { icon: customIcon }).addTo(group);
      marker.on('click', () => {
        setSelectedVenueId(venue.id);
      });
    });
  }, [appState, selectedVenueId]);

  if (!appState) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 rounded-full border-4 border-sky-500 border-t-transparent animate-spin" />
          <h2 className="text-xl font-bold">Carregant Portal Municipal — Ajuntament de Molins de Rei...</h2>
          <p className="text-sm text-slate-400">
            Connectant al servidor Cloud a <code className="text-sky-400">{BACKEND_URL}</code>
          </p>
        </div>
      </div>
    );
  }

  const venuesWithSummary = appState.venues;
  const selectedVenue =
    venuesWithSummary.find((v) => v.id === selectedVenueId) || venuesWithSummary[0];
  const sVenue = selectedVenue.summary || {};

  // Rànquing ordenat dels bars més sorollosos
  const rankedVenues = [...venuesWithSummary].sort((a, b) => {
    if (rankingSortBy === 'alertsToday') {
      return (b.summary?.alertsToday || 0) - (a.summary?.alertsToday || 0);
    }
    if (rankingSortBy === 'dragEventsToday') {
      return (b.summary?.dragEventsToday || 0) - (a.summary?.dragEventsToday || 0);
    }
    return (b.summary?.avgDba || 0) - (a.summary?.avgDba || 0);
  });

  // Estadístiques globals de tota la ciutat
  const cityAvgDba = Number(
    (
      venuesWithSummary.reduce((acc, v) => acc + (v.summary?.avgDba || 0), 0) /
      venuesWithSummary.length
    ).toFixed(1)
  );
  const cityAlertsCount = venuesWithSummary.filter(
    (v) => v.summary?.overallStatus === 'alert'
  ).length;
  const totalAlertsToday = venuesWithSummary.reduce(
    (acc, v) => acc + (v.summary?.alertsToday || 0),
    0
  );
  const totalDragToday = venuesWithSummary.reduce(
    (acc, v) => acc + (v.summary?.dragEventsToday || 0),
    0
  );

  // Aplicar un preset d'horari municipal
  const applyPreset = (presetName) => {
    if (presetName === 'day') {
      setFormThresholds((prev) => ({
        ...prev,
        soundWarningAdc: 35,
        soundAlertAdc: 52,
        motionWarningMs2: 1.5,
        motionAlertMs2: 2.5,
        normalIntervalMs: 3000,
        alertIntervalMs: 500,
        quietTimeRequiredMs: 5000,
        schedulePreset: 'day'
      }));
    } else if (presetName === 'evening') {
      // Valors exactes per defecte del PoC (src/main.c: SOUND_THRESHOLD_ADC=40, MOTION_THRESHOLD_MS2=2.1)
      setFormThresholds((prev) => ({
        ...prev,
        soundWarningAdc: 28,
        soundAlertAdc: 40,
        motionWarningMs2: 1.2,
        motionAlertMs2: 2.1,
        normalIntervalMs: 3000,
        alertIntervalMs: 500,
        quietTimeRequiredMs: 5000,
        schedulePreset: 'evening'
      }));
    } else if (presetName === 'night') {
      setFormThresholds((prev) => ({
        ...prev,
        soundWarningAdc: 20,
        soundAlertAdc: 30,
        motionWarningMs2: 0.9,
        motionAlertMs2: 1.6,
        normalIntervalMs: 2500,
        alertIntervalMs: 500,
        quietTimeRequiredMs: 8000,
        schedulePreset: 'night'
      }));
    }
  };

  const handleSaveThresholds = async (e) => {
    e.preventDefault();
    const res = await fetch(`${BACKEND_URL}/api/thresholds`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formThresholds,
        updatedBy: 'Tècnic Medi Ambient — Ajuntament de Molins de Rei'
      })
    });
    if (res.ok) {
      setSaveSuccessMsg(
        'Límits municipals aplicats i propagats en temps real a tots els bars i gateways Edge!'
      );
      setTimeout(() => setSaveSuccessMsg(null), 6000);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* HEADER MUNICIPAL */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30 px-6 py-3.5">
        <div className="max-w-[1650px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <Building2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  Ajuntament de Molins de Rei — QuietVenue Smart City
                </h1>
                <span className="text-xs px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 font-semibold">
                  Governança Acústica i Terrasses
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Mapa de calor urbà en temps real, rànquing d&apos;establiments i configuració remota de límits d&apos;Avís i Alerta
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" />
              <span>
                Node PoC (Bar El Pati):{' '}
                <strong className="text-emerald-400">
                  {appState.edgeConnection.connected ? 'LIVE HARDWARE' : 'ACTIU (DEMO/READY)'}
                </strong>
              </span>
            </div>

            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs">
              Límit Alerta Vigent:{' '}
              <strong className="text-rose-400">
                {appState.thresholds.soundAlertAdc} ADC ({appState.thresholds.soundAlertDba} dBA) |{' '}
                {appState.thresholds.motionAlertMs2} m/s²
              </strong>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1650px] w-full mx-auto flex-1 p-6 space-y-6">
        {/* FILA 1: KPIS GLOBALS DE LA CIUTAT */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between text-xs text-slate-400 font-semibold uppercase">
              <span>Mitjana Acústica Municipal</span>
              <Volume2 className="w-4 h-4 text-sky-400" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-white">{cityAvgDba} dBA</span>
              <span className="text-xs text-slate-400">({venuesWithSummary.length} terrasses actives)</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between text-xs text-slate-400 font-semibold uppercase">
              <span>Establiments en Mode Alerta Ara</span>
              <Flame className="w-4 h-4 text-rose-400" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-rose-400">{cityAlertsCount}</span>
              <span className="text-xs text-slate-400">superant el llindar municipal</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between text-xs text-slate-400 font-semibold uppercase">
              <span>Incidències Registrades Avui</span>
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-white">{totalAlertsToday}</span>
              <span className="text-xs text-slate-400">({totalDragToday} per arrossegament de mobiliari)</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between text-xs text-slate-400 font-semibold uppercase">
              <span>Bar Més Sorollós Actualment</span>
              <Trophy className="w-4 h-4 text-amber-400" />
            </div>
            <div className="mt-2">
              <div className="text-sm font-bold text-white truncate">{rankedVenues[0]?.name}</div>
              <div className="text-lg font-extrabold text-rose-400">
                {rankedVenues[0]?.summary?.avgDba} dBA (Pic: {rankedVenues[0]?.summary?.maxDba} dBA)
              </div>
            </div>
          </div>
        </div>

        {/* FILA 2: MAPA DE CALOR DE MOLINS DE REI (7 col) + RÀNQUING DE BARS MÉS SOROLLOSOS (5 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* MAPA DE CALOR GEOGRAFIC */}
          <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Flame className="w-4 h-4 text-rose-400" />
                  Mapa de Calor Acústic — Molins de Rei (Temps Real)
                </h2>
                <p className="text-xs text-slate-400">
                  Visualització geolocalitzada de l&apos;impacte acústic per terrasses. Clica qualsevol bar per inspeccionar-lo.
                </p>
              </div>
              <button
                onClick={() => {
                  const poc = venuesWithSummary.find((v) => v.isPoCVenue);
                  if (poc && mapInstanceRef.current) {
                    setSelectedVenueId(poc.id);
                    mapInstanceRef.current.flyTo([poc.lat, poc.lng], 17);
                  }
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition"
              >
                ★ Centrar al Bar PoC (El Pati)
              </button>
            </div>

            <div
              ref={mapContainerRef}
              className="w-full h-[460px] rounded-xl border border-slate-800 overflow-hidden z-10"
            />

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
                  Zona Tranquil·la (&lt; {appState.thresholds.soundWarningDba} dBA)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />
                  Zona en Avís ({appState.thresholds.soundWarningDba}–{appState.thresholds.soundAlertDba} dBA)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-rose-500 inline-block" />
                  Punt Calent / Alerta (&ge; {appState.thresholds.soundAlertDba} dBA)
                </span>
              </div>
              <span>Coordenades: 41.4138° N, 2.0158° E</span>
            </div>
          </div>

          {/* RÀNQUING DE BARS QUE FAN MÉS SOROLL */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-400" />
                  Rànquing de Bars per Nivell de Soroll
                </h2>
                <p className="text-xs text-slate-400">
                  Ordenat en temps real segons les lectures dels sensors desplegats
                </p>
              </div>

              <select
                value={rankingSortBy}
                onChange={(e) => setRankingSortBy(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-200"
              >
                <option value="avgDba">Ordenar per: Soroll Actual (dBA)</option>
                <option value="alertsToday">Ordenar per: Total Alertes Avui</option>
                <option value="dragEventsToday">Ordenar per: Arrossegament Mobiliari</option>
              </select>
            </div>

            <div className="space-y-2.5 flex-1 overflow-y-auto max-h-[460px] pr-1">
              {rankedVenues.map((v, idx) => {
                const s = v.summary || {};
                const isSelected = v.id === selectedVenueId;
                const isAlert = s.overallStatus === 'alert';
                const isWarn = s.overallStatus === 'warning';

                return (
                  <div
                    key={v.id}
                    onClick={() => {
                      setSelectedVenueId(v.id);
                      if (mapInstanceRef.current) {
                        mapInstanceRef.current.panTo([v.lat, v.lng]);
                      }
                    }}
                    className={`p-3.5 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? 'bg-slate-800/90 border-sky-400 ring-2 ring-sky-400/20'
                        : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`w-6 h-6 rounded-lg text-xs font-black flex items-center justify-center ${
                            idx === 0
                              ? 'bg-rose-500 text-white'
                              : idx === 1
                              ? 'bg-amber-500 text-slate-950'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          #{idx + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-white">{v.name}</span>
                            {v.isPoCVenue && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-extrabold">
                                POC REAL
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-slate-400 block">{v.address}</span>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div
                          className={`text-base font-black ${
                            isAlert
                              ? 'text-rose-400'
                              : isWarn
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                          }`}
                        >
                          {s.avgDba} dBA
                        </div>
                        <div className="text-[11px] font-mono text-slate-400">
                          Mitjana: {s.avgAdc} ADC
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
                      <span>
                        Alertes avui: <strong className="text-white">{s.alertsToday}</strong>
                      </span>
                      <span>
                        🪑 Mobiliari: <strong className="text-purple-300">{s.dragEventsToday}</strong>
                      </span>
                      <span>
                        Compliment:{' '}
                        <strong
                          className={
                            s.complianceScore >= 85
                              ? 'text-emerald-400'
                              : s.complianceScore >= 75
                              ? 'text-amber-400'
                              : 'text-rose-400'
                          }
                        >
                          {s.complianceScore}%
                        </strong>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* FILA 3: DADES GENERALS DEL BAR SELECCIONAT (6 col) + CONFIGURADOR DE LÍMITS D'AVÍS I ALERTA (6 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* FITXA COMPLETA DE DADES GENERALS PER AL BAR SELECCIONAT */}
          <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-2 pb-3 border-b border-slate-800">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
                    Inspecció Municipal d&apos;Establiment
                  </span>
                  <h3 className="text-xl font-extrabold text-white mt-0.5">
                    {selectedVenue.name}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {selectedVenue.address} &bull; Districte: {selectedVenue.district} &bull; Gateway:{' '}
                    <code className="text-slate-200">{selectedVenue.gatewayId}</code>
                  </p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-extrabold border ${
                    sVenue.overallStatus === 'alert'
                      ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                      : sVenue.overallStatus === 'warning'
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                  }`}
                >
                  {sVenue.overallStatus === 'alert'
                    ? 'INFRACCIÓ / ALERTA ACTIVA'
                    : sVenue.overallStatus === 'warning'
                    ? 'AVÍS PREVENTIU'
                    : 'DINS DELS LÍMITS'}
                </span>
              </div>

              {/* Grid de Mètriques Generals del Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block">Soroll Mitjà</span>
                  <span className="text-lg font-extrabold text-white">{sVenue.avgDba} dBA</span>
                  <span className="text-[11px] text-slate-400 block font-mono">{sVenue.avgAdc} ADC</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block">Pic Màxim</span>
                  <span className="text-lg font-extrabold text-amber-400">{sVenue.maxDba} dBA</span>
                  <span className="text-[11px] text-slate-400 block font-mono">{sVenue.maxAdc} ADC</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block">Vibració Màx.</span>
                  <span className="text-lg font-extrabold text-sky-400">{sVenue.maxAccel} m/s²</span>
                  <span className="text-[11px] text-slate-400 block">MPU-6050</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block">Índex Compliment</span>
                  <span className="text-lg font-extrabold text-emerald-400">
                    {sVenue.complianceScore}%
                  </span>
                  <span className="text-[11px] text-slate-400 block">
                    {sVenue.alertsToday} alertes avui
                  </span>
                </div>
              </div>

              {/* Estat de cada taula del bar seleccionat */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                  Estat en temps real dels sensors per taula ({selectedVenue.tables.length} taules)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[210px] overflow-y-auto pr-1">
                  {selectedVenue.tables.map((t) => (
                    <div
                      key={t.id}
                      className={`p-2.5 rounded-xl border text-xs ${
                        t.status === 'alert'
                          ? 'bg-rose-950/40 border-rose-500/50'
                          : t.status === 'warning'
                          ? 'bg-amber-950/30 border-amber-500/40'
                          : 'bg-slate-950 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold text-white">
                        <span className="truncate">{t.name}</span>
                        <span
                          className={`w-2 h-2 rounded-full ${
                            t.status === 'alert'
                              ? 'bg-rose-500'
                              : t.status === 'warning'
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                          }`}
                        />
                      </div>
                      <div className="mt-1 flex justify-between font-mono text-[11px]">
                        <span>{t.dBA} dBA</span>
                        <span className="text-slate-400">{t.soundAdc} ADC</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                        Vib: {Number(t.accelMs2).toFixed(2)} m/s² &bull; {t.causeLabel}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Gràfica comparativa de dBA entre bars */}
            <div className="pt-3 border-t border-slate-800">
              <span className="text-xs font-bold text-slate-400 block mb-2">
                Comparativa Acústica Actual entre Establiments (dBA)
              </span>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rankedVenues.map((v) => ({ name: v.name.split(' ')[0] + ' ' + (v.name.split(' ')[1] || ''), avgDba: v.summary?.avgDba, status: v.summary?.overallStatus }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <YAxis domain={[35, 95]} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: '12px' }}
                    />
                    <Bar dataKey="avgDba" name="Soroll Mitjà (dBA)" radius={[6, 6, 0, 0]}>
                      {rankedVenues.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={
                            entry.summary?.overallStatus === 'alert'
                              ? '#f43f5e'
                              : entry.summary?.overallStatus === 'warning'
                              ? '#f59e0b'
                              : '#10b981'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* PANELL MUNICIPAL DE CONFIGURACIÓ DE LÍMITS (AVÍS I MODE ALERTA) */}
          <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <form onSubmit={handleSaveThresholds} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
                    Ordenança Municipal de Soroll i Vibracions
                  </span>
                  <h3 className="text-xl font-extrabold text-white flex items-center gap-2 mt-0.5">
                    <Sliders className="w-5 h-5 text-amber-400" />
                    Configuració de Límits d&apos;Avís i Mode Alerta
                  </h3>
                  <p className="text-xs text-slate-400">
                    Els canvis s&apos;apliquen en temps real sobre el sistema d&apos;alertes, el Dashboard dels Bars i el node PoC.
                  </p>
                </div>
              </div>

              {saveSuccessMsg && (
                <div className="p-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{saveSuccessMsg}</span>
                </div>
              )}

              {/* Presets d'Horari Municipal */}
              <div>
                <label className="text-xs font-bold text-slate-300 block mb-2">
                  Perfils Ràpids d&apos;Ordenança Municipal:
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => applyPreset('day')}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      formThresholds.schedulePreset === 'day'
                        ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    ☀️ Diürn (08h–20h)
                    <span className="block text-[10px] font-normal opacity-80">Alerta: 52 ADC</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPreset('evening')}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      formThresholds.schedulePreset === 'evening'
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    🌆 Vespre / PoC (20h–23h)
                    <span className="block text-[10px] font-normal opacity-80">
                      Alerta: 40 ADC (main.c)
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPreset('night')}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      formThresholds.schedulePreset === 'night'
                        ? 'bg-purple-500/20 border-purple-400 text-purple-200'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    🌙 Nocturn Estricte (&gt;23h)
                    <span className="block text-[10px] font-normal opacity-80">Alerta: 30 ADC</span>
                  </button>
                </div>
              </div>

              {/* Sliders de Soroll Acústic (ADC + dBA) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-amber-400">
                      🟡 Llindar d&apos;Avís Acústic (Warning)
                    </label>
                    <span className="text-sm font-extrabold text-white">
                      {formThresholds.soundWarningAdc} ADC
                    </span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={80}
                    value={formThresholds.soundWarningAdc}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        soundWarningAdc: Number(e.target.value),
                        schedulePreset: 'custom'
                      })
                    }
                    className="w-full accent-amber-400"
                  />
                  <p className="text-[11px] text-slate-400">
                    Activa l&apos;avís preventiu groc al plànol del bar abans de superar el límit legal.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-rose-400">
                      🔴 Llindar Mode Alerta (SOUND_THRESHOLD_ADC)
                    </label>
                    <span className="text-sm font-extrabold text-white">
                      {formThresholds.soundAlertAdc} ADC
                    </span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={120}
                    value={formThresholds.soundAlertAdc}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        soundAlertAdc: Number(e.target.value),
                        schedulePreset: 'custom'
                      })
                    }
                    className="w-full accent-rose-500"
                  />
                  <p className="text-[11px] text-slate-400">
                    Valor per defecte al firmware Zephyr: <code className="text-rose-300">40 ADC</code> (~75 dBA).
                  </p>
                </div>
              </div>

              {/* Sliders de Vibració MPU-6050 (m/s²) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-sky-400">
                      📳 Avís Vibració Taula (MPU-6050)
                    </label>
                    <span className="text-sm font-extrabold text-white">
                      {Number(formThresholds.motionWarningMs2).toFixed(2)} m/s²
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.4}
                    max={3.0}
                    step={0.1}
                    value={formThresholds.motionWarningMs2}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        motionWarningMs2: Number(e.target.value),
                        schedulePreset: 'custom'
                      })
                    }
                    className="w-full accent-sky-400"
                  />
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-purple-400">
                      🪑 Alerta Arrossegament (MOTION_THRESHOLD_MS2)
                    </label>
                    <span className="text-sm font-extrabold text-white">
                      {Number(formThresholds.motionAlertMs2).toFixed(2)} m/s²
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.8}
                    max={5.0}
                    step={0.1}
                    value={formThresholds.motionAlertMs2}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        motionAlertMs2: Number(e.target.value),
                        schedulePreset: 'custom'
                      })
                    }
                    className="w-full accent-purple-500"
                  />
                  <p className="text-[11px] text-slate-400">
                    Valor per defecte al firmware Zephyr: <code className="text-purple-300">2.10 m/s²</code>.
                  </p>
                </div>
              </div>

              {/* Paràmetres Temporals del Node PoC (Intervals i Temps de Calma) */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <label className="text-[11px] text-slate-400 block">
                    Interval Normal (ms)
                  </label>
                  <input
                    type="number"
                    step={500}
                    min={1000}
                    max={30000}
                    value={formThresholds.normalIntervalMs}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        normalIntervalMs: Number(e.target.value)
                      })
                    }
                    className="w-full bg-transparent text-sm font-bold text-white mt-1 focus:outline-none"
                  />
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <label className="text-[11px] text-slate-400 block">
                    Interval Alerta (ms)
                  </label>
                  <input
                    type="number"
                    step={100}
                    min={200}
                    max={5000}
                    value={formThresholds.alertIntervalMs}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        alertIntervalMs: Number(e.target.value)
                      })
                    }
                    className="w-full bg-transparent text-sm font-bold text-rose-400 mt-1 focus:outline-none"
                  />
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <label className="text-[11px] text-slate-400 block">
                    Temps Calma Retorn (ms)
                  </label>
                  <input
                    type="number"
                    step={1000}
                    min={2000}
                    max={30000}
                    value={formThresholds.quietTimeRequiredMs}
                    onChange={(e) =>
                      setFormThresholds({
                        ...formThresholds,
                        quietTimeRequiredMs: Number(e.target.value)
                      })
                    }
                    className="w-full bg-transparent text-sm font-bold text-emerald-400 mt-1 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => applyPreset('evening')}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1.5 transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restaurar Valors PoC (main.c)
                </button>

                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl text-xs font-extrabold bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white flex items-center gap-2 shadow-lg shadow-sky-500/25 transition"
                >
                  <Save className="w-4 h-4" />
                  Aplicar i Propagar Límits a Tota la Ciutat
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
