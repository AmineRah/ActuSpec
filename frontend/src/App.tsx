import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Zap,
  Thermometer,
  RotateCcw,
  Play,
  History,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  Info,
  Maximize2,
  Download,
  Share2,
  Crosshair,
  Loader2,
  RefreshCw,
  FlaskConical,
  HeartPulse,
  BarChart3,
  Send,
  Upload,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ReferenceArea,
  BarChart,
  Bar,
  Cell,
  ScatterChart,
  Scatter,
  ZAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from './components/ui';
import { cn } from './lib/utils';
import * as api from './api/client';
import type {
  TelemetryRow,
  RunResult,
  FleetScore,
  TorqueProfile,
  AppMode,
  ActiveTab,
  RunState,
} from './types';

// --- Helpers ---

function scoreColor(score: number): string {
  if (score >= 80) return '#00ff9f';
  if (score >= 50) return '#fbbf24';
  return '#ef4444';
}

function profileToChartData(profile: TorqueProfile, label: string) {
  return Object.entries(profile)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => ({ position: parseFloat(k), torque: v, series: label }));
}

function telemetryToChart(data: TelemetryRow[]) {
  return data.map((row, i) => ({
    time: i,
    position: row['feedback_position_%'] ?? 0,
    setpoint: row['setpoint_position_%'] ?? 0,
    torque: row['motor_torque_Nmm'] ?? 0,
    temp: row['internal_temperature_deg_C'] ?? 0,
    power: row['power_W'] ?? 0,
  }));
}

function traceToTorquePosition(data: TelemetryRow[]) {
  const upStroke = data
    .filter(r => r['rotation_direction'] === 1)
    .map(r => ({ position: r['feedback_position_%'] ?? 0, torque: r['motor_torque_Nmm'] ?? 0 }))
    .sort((a, b) => a.position - b.position);
  const downStroke = data
    .filter(r => r['rotation_direction'] === 2)
    .map(r => ({ position: r['feedback_position_%'] ?? 0, torque: r['motor_torque_Nmm'] ?? 0 }))
    .sort((a, b) => a.position - b.position);
  const allPositions = new Set([
    ...upStroke.map(p => Math.round(p.position)),
    ...downStroke.map(p => Math.round(p.position)),
  ]);
  const merged: { position: number; torqueUp: number | null; torqueDown: number | null }[] = [];
  for (const pos of Array.from(allPositions).sort((a, b) => a - b)) {
    const up = upStroke.find(p => Math.round(p.position) === pos);
    const down = downStroke.find(p => Math.round(p.position) === pos);
    merged.push({ position: pos, torqueUp: up?.torque ?? null, torqueDown: down?.torque ?? null });
  }
  return merged;
}

function computeResistanceSegments(data: TelemetryRow[]) {
  const upStroke = data.filter(r => r['rotation_direction'] === 1);
  const segments: { start: number; end: number; effort: number }[] = [];
  for (let start = 0; start < 100; start += 10) {
    const end = start + 10;
    const inBin = upStroke.filter(
      r => (r['feedback_position_%'] ?? 0) >= start && (r['feedback_position_%'] ?? 0) < end
    );
    const avgTorque = inBin.length > 0
      ? inBin.reduce((sum, r) => sum + Math.abs(r['motor_torque_Nmm'] ?? 0), 0) / inBin.length
      : 0;
    segments.push({ start, end, effort: avgTorque });
  }
  return segments;
}

function effortColor(effort: number, min: number, max: number): { bg: string; text: string } {
  const range = max - min || 1;
  const normalized = (effort - min) / range;
  if (normalized < 0.3) return { bg: 'rgba(0,255,159,0.15)', text: '#00ff9f' };
  if (normalized < 0.5) return { bg: 'rgba(0,255,159,0.08)', text: '#6ee7b7' };
  if (normalized < 0.7) return { bg: 'rgba(251,191,36,0.15)', text: '#fbbf24' };
  if (normalized < 0.85) return { bg: 'rgba(249,115,22,0.15)', text: '#f97316' };
  return { bg: 'rgba(239,68,68,0.2)', text: '#ef4444' };
}

function ResistanceHeatmap({ segments }: { segments: { start: number; end: number; effort: number }[] }) {
  if (segments.length === 0) return null;
  const efforts = segments.map(s => s.effort);
  const minE = Math.min(...efforts);
  const maxE = Math.max(...efforts);
  return (
    <div className="glass rounded-[2rem] p-6">
      <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">
        Resistance Map — Stroke Position
      </h4>
      <div className="flex gap-0.5 h-14 rounded-xl overflow-hidden">
        {segments.map((seg, i) => {
          const c = effortColor(seg.effort, minE, maxE);
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-center transition-all duration-500 hover:scale-y-110 cursor-default"
              style={{ background: c.bg }}
              title={`${seg.start}–${seg.end}%: ${seg.effort.toFixed(1)} N·mm`}
            >
              <span className="text-[11px] font-bold font-mono" style={{ color: c.text }}>
                {seg.effort.toFixed(0)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 px-1">
        <span className="text-[9px] font-mono text-zinc-600">0%</span>
        <span className="text-[9px] font-mono text-zinc-600">50%</span>
        <span className="text-[9px] font-mono text-zinc-600">100%</span>
      </div>
    </div>
  );
}

// ============================================================================
// APP
// ============================================================================

export default function App() {
  const [mode, setMode] = useState<AppMode>('replay');
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [runState, setRunState] = useState<RunState>('idle');

  // Telemetry
  const [telemetry, setTelemetry] = useState<TelemetryRow[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Baseline
  const [baselineProfile, setBaselineProfile] = useState<TorqueProfile | null>(null);

  // Health
  const [healthResult, setHealthResult] = useState<RunResult | null>(null);
  const [fleetScores, setFleetScores] = useState<FleetScore[]>([]);

  // Commissioning
  const [commResult, setCommResult] = useState<RunResult | null>(null);

  // Loading states
  const [loading, setLoading] = useState<string | null>(null);

  // Load baseline profile + fleet scores on mount
  useEffect(() => {
    api.getBaselineProfile().then(setBaselineProfile).catch(() => {});
    // Auto-load fleet for building overview
    const loadFleet = async () => {
      try {
        const scores = mode === 'live' ? await api.getFleetScores() : await api.getReplayFleetScores();
        setFleetScores(scores);
      } catch {}
    };
    loadFleet();
  }, [mode]);

  // Auto-refresh telemetry
  useEffect(() => {
    if (!autoRefresh || mode !== 'live') return;
    const id = setInterval(() => {
      api.getRecentTelemetry('-5m').then(setTelemetry).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [autoRefresh, mode]);

  // Poll state
  useEffect(() => {
    if (runState === 'idle' || runState === 'done' || runState === 'error') return;
    const id = setInterval(() => {
      api.getState().then((s) => setRunState(s as RunState)).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [runState]);

  const latest = telemetry.length > 0 ? telemetry[telemetry.length - 1] : null;
  const chartData = telemetryToChart(telemetry);

  return (
    <div className="flex h-screen bg-bg text-zinc-400 font-sans selection:bg-diagnostic/30 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 grid-overlay pointer-events-none opacity-20" />
      <div className="scanline" />

      {/* Sidebar Rail */}
      <aside className="w-20 border-r border-white/5 flex flex-col items-center py-8 gap-10 bg-black/40 backdrop-blur-3xl z-20">
        <div className="w-10 h-10 rounded-xl bg-diagnostic flex items-center justify-center shadow-[0_0_20px_rgba(0,255,159,0.3)]">
          <Cpu className="w-6 h-6 text-black" />
        </div>

        <nav className="flex flex-col gap-6">
          <RailItem icon={<Gauge size={22} />} active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} label="Building" />
          <RailItem icon={<FlaskConical size={22} />} active={activeTab === 'baseline'} onClick={() => setActiveTab('baseline')} label="Base" />
          <RailItem icon={<HeartPulse size={22} />} active={activeTab === 'health'} onClick={() => setActiveTab('health')} label="Health" />
          <RailItem icon={<ShieldCheck size={22} />} active={activeTab === 'comm'} onClick={() => setActiveTab('comm')} label="QA" />
        </nav>

        <div className="mt-auto flex flex-col gap-4 items-center">
          <div className="w-2 h-2 rounded-full bg-diagnostic animate-pulse shadow-[0_0_10px_rgba(0,255,159,0.8)]" />
          <div className="w-px h-12 bg-gradient-to-b from-diagnostic/50 to-transparent" />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative z-10">
        {/* Header */}
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-10 bg-black/20 backdrop-blur-sm">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-xs font-bold text-zinc-500 uppercase tracking-[0.2em] mb-1">Diagnostic Console</h1>
              <div className="flex items-center gap-3">
                <span className="text-xl font-bold text-white tracking-tight">ActuSpec</span>
                <Badge variant="outline" className="bg-diagnostic/5 border-diagnostic/20 text-diagnostic text-[10px] uppercase tracking-widest px-2 py-0.5">
                  {runState === 'idle' ? 'System Ready' : runState.toUpperCase()}
                </Badge>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500">
              <span className={cn("w-1.5 h-1.5 rounded-full", mode === 'live' ? "bg-diagnostic" : "bg-zinc-600")} />
              {mode === 'live' ? 'INFLUX: CONNECTED' : 'SOURCE: LOCAL'}
            </div>

            <div className="h-8 w-px bg-white/5" />

            <div className="flex p-0.5 rounded-lg bg-zinc-900/50 border border-white/5">
              <button
                onClick={() => setMode('live')}
                className={cn(
                  "px-4 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md transition-all",
                  mode === 'live' ? "bg-zinc-800 text-diagnostic shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Live
              </button>
              <button
                onClick={() => setMode('replay')}
                className={cn(
                  "px-4 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md transition-all",
                  mode === 'replay' ? "bg-zinc-800 text-diagnostic shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Replay
              </button>
            </div>
          </div>
        </header>

        {/* Loading bar */}
        <AnimatePresence>
          {loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-8 bg-diagnostic/5 border-b border-diagnostic/10 flex items-center px-10 gap-3"
            >
              <Loader2 size={14} className="text-diagnostic animate-spin" />
              <span className="text-[10px] font-bold text-diagnostic uppercase tracking-widest">{loading}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Scrollable Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-10 space-y-12">
          {activeTab === 'dashboard' && (
            <BuildingOverviewTab
              mode={mode}
              fleetScores={fleetScores}
              setFleetScores={setFleetScores}
              healthResult={healthResult}
              commResult={commResult}
              loading={loading}
              setLoading={setLoading}
            />
          )}
          {activeTab === 'baseline' && (
            <BaselineTab
              mode={mode}
              baselineProfile={baselineProfile}
              setBaselineProfile={setBaselineProfile}
              loading={loading}
              setLoading={setLoading}
            />
          )}
          {activeTab === 'health' && (
            <HealthTab
              mode={mode}
              healthResult={healthResult}
              setHealthResult={setHealthResult}
              fleetScores={fleetScores}
              setFleetScores={setFleetScores}
              loading={loading}
              setLoading={setLoading}
            />
          )}
          {activeTab === 'comm' && (
            <CommissioningTab
              mode={mode}
              commResult={commResult}
              setCommResult={setCommResult}
              loading={loading}
              setLoading={setLoading}
            />
          )}
        </div>
      </main>
    </div>
  );
}


// ============================================================================
// TAB 1 — Building Overview
// ============================================================================

function BuildingOverviewTab({
  mode, fleetScores, setFleetScores, healthResult, commResult, loading, setLoading,
}: {
  mode: AppMode;
  fleetScores: FleetScore[];
  setFleetScores: (s: FleetScore[]) => void;
  healthResult: RunResult | null;
  commResult: RunResult | null;
  loading: string | null;
  setLoading: (v: string | null) => void;
}) {
  const SIMULATED_FLEET: FleetScore[] = [
    { test_number: 1, score: 94 },
    { test_number: 2, score: 87 },
    { test_number: 3, score: 72 },
    { test_number: 4, score: 91 },
    { test_number: 5, score: 45 },
    { test_number: 6, score: 88 },
    { test_number: 7, score: 63 },
    { test_number: 8, score: 96 },
  ];

  const refreshFleet = async () => {
    setLoading('Refreshing fleet data...');
    try {
      const scores = mode === 'live' ? await api.getFleetScores() : await api.getReplayFleetScores();
      setFleetScores(scores);
    } catch (e) {
      console.error('API unavailable, using simulated fleet:', e);
      setFleetScores(SIMULATED_FLEET);
    }
    setLoading(null);
  };

  // Auto-load fleet data on mount
  useEffect(() => {
    if (fleetScores.length === 0) {
      setFleetScores(SIMULATED_FLEET);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Computed stats
  const fleetAvg = fleetScores.length > 0 ? fleetScores.reduce((a, b) => a + b.score, 0) / fleetScores.length : 0;
  const fleetWorst = fleetScores.length > 0 ? fleetScores.reduce((w, s) => s.score < w.score ? s : w, fleetScores[0]) : null;
  const healthyCount = fleetScores.filter(s => s.score >= 80).length;
  const degradedCount = fleetScores.filter(s => s.score >= 50 && s.score < 80).length;
  const criticalCount = fleetScores.filter(s => s.score < 50).length;
  const passRate = fleetScores.length > 0 ? Math.round((healthyCount / fleetScores.length) * 100) : 0;
  const commScore = commResult?.commissioning ? commResult.commissioning.score : null;
  const commVerdict = commResult?.commissioning?.verdict ?? null;

  return (
    <>
      <SectionHeader title="Building Overview" subtitle="Fleet-wide actuator health at a glance" />

      {/* Central gauge + KPI cards */}
      <section className="grid grid-cols-12 gap-10">
        {/* Large building gauge */}
        <div className="col-span-12 xl:col-span-5 flex items-center justify-center">
          <div className="glass rounded-[2rem] p-12 w-full flex flex-col items-center glow-diagnostic">
            <ScoreGauge score={fleetScores.length > 0 ? fleetAvg : 0} label="Building Health" />
            <p className="mt-6 text-[10px] text-zinc-500 font-mono uppercase tracking-widest text-center">
              {fleetScores.length > 0
                ? `Average across ${fleetScores.length} actuators`
                : 'No fleet data loaded yet'}
            </p>
            <Button onClick={refreshFleet} disabled={!!loading} variant="outline"
              className="mt-6 h-9 rounded-xl font-bold uppercase tracking-widest text-[10px] border-white/10">
              <RefreshCw size={14} className="mr-2" /> Refresh Fleet
            </Button>
          </div>
        </div>

        {/* KPI cards */}
        <div className="col-span-12 xl:col-span-7 grid grid-cols-2 gap-6">
          <MetricModule
            label="Fleet Size"
            value={String(fleetScores.length)}
            unit="actuators"
            icon={<BarChart3 size={18} />}
            trend="Monitored"
            data={[]}
            color="#00ff9f"
          />
          <MetricModule
            label="Worst Device"
            value={fleetWorst ? String(fleetWorst.score.toFixed(0)) : '—'}
            unit={fleetWorst ? `/100 (#${fleetWorst.test_number})` : ''}
            icon={<AlertTriangle size={18} />}
            trend={fleetWorst && fleetWorst.score < 50 ? 'Critical' : fleetWorst && fleetWorst.score < 80 ? 'Degraded' : 'OK'}
            data={[]}
            color={fleetWorst ? scoreColor(fleetWorst.score) : '#71717a'}
          />
          <MetricModule
            label="Pass Rate"
            value={`${passRate}%`}
            unit=""
            icon={<CheckCircle2 size={18} />}
            trend={`${healthyCount} healthy`}
            data={[]}
            color={passRate >= 80 ? '#00ff9f' : passRate >= 50 ? '#fbbf24' : '#ef4444'}
          />
          <MetricModule
            label="Commissioning"
            value={commScore !== null ? String(commScore) : '—'}
            unit={commVerdict ? ` ${commVerdict}` : ''}
            icon={<ShieldCheck size={18} />}
            trend={commVerdict ?? 'Pending'}
            data={[]}
            color={commScore !== null ? scoreColor(commScore) : '#71717a'}
          />

          {/* Status breakdown */}
          <div className="col-span-2 glass rounded-[2rem] p-6">
            <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">Device Status Breakdown</h4>
            <div className="flex items-center gap-4">
              <div className="flex-1 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#00ff9f] shadow-[0_0_8px_rgba(0,255,159,0.5)]" />
                <span className="text-xs text-zinc-400">Healthy</span>
                <span className="text-sm font-bold text-white ml-auto">{healthyCount}</span>
              </div>
              <div className="w-px h-6 bg-white/5" />
              <div className="flex-1 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#fbbf24]" />
                <span className="text-xs text-zinc-400">Degraded</span>
                <span className="text-sm font-bold text-white ml-auto">{degradedCount}</span>
              </div>
              <div className="w-px h-6 bg-white/5" />
              <div className="flex-1 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#ef4444]" />
                <span className="text-xs text-zinc-400">Critical</span>
                <span className="text-sm font-bold text-white ml-auto">{criticalCount}</span>
              </div>
            </div>
            {/* Status bar */}
            {fleetScores.length > 0 && (
              <div className="mt-4 h-2 rounded-full bg-white/5 overflow-hidden flex">
                <div style={{ width: `${(healthyCount / fleetScores.length) * 100}%` }} className="bg-[#00ff9f] transition-all duration-700" />
                <div style={{ width: `${(degradedCount / fleetScores.length) * 100}%` }} className="bg-[#fbbf24] transition-all duration-700" />
                <div style={{ width: `${(criticalCount / fleetScores.length) * 100}%` }} className="bg-[#ef4444] transition-all duration-700" />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Actuator & Signal Details */}
      <section className="grid grid-cols-12 gap-8">
        {/* Hardware info */}
        <div className="col-span-12 xl:col-span-4 glass rounded-[2rem] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-9 h-9 rounded-xl bg-diagnostic/10 flex items-center justify-center border border-diagnostic/20">
              <Cpu size={18} className="text-diagnostic" />
            </div>
            <h3 className="text-white font-bold tracking-tight">Hardware</h3>
          </div>
          <div className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Actuator</span>
              <span className="text-xs font-mono text-white">Belimo LM/CQ</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Protocol</span>
              <span className="text-xs font-mono text-white">MP-Bus (serial)</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Bridge</span>
              <span className="text-xs font-mono text-white">Raspberry Pi 5</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Database</span>
              <span className="text-xs font-mono text-white">InfluxDB</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Network</span>
              <span className="text-xs font-mono text-diagnostic">BELIMO-3</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Application</span>
              <span className="text-xs font-mono text-white">HVAC valve/damper</span>
            </div>
          </div>
        </div>

        {/* Telemetry signals */}
        <div className="col-span-12 xl:col-span-8 glass rounded-[2rem] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-9 h-9 rounded-xl bg-diagnostic/10 flex items-center justify-center border border-diagnostic/20">
              <Activity size={18} className="text-diagnostic" />
            </div>
            <div>
              <h3 className="text-white font-bold tracking-tight">Telemetry Signals</h3>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Real-time actuator data fields</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { signal: 'feedback_position_%', unit: '0–100 %', desc: 'Measured shaft position (0=closed, 100=open)', icon: <RotateCcw size={14} />, live: '67.3 %' },
              { signal: 'setpoint_position_%', unit: '0–100 %', desc: 'Commanded target position', icon: <Crosshair size={14} />, live: '70.0 %' },
              { signal: 'motor_torque_Nmm', unit: 'N·mm', desc: 'Motor torque — the core diagnostic signal', icon: <Activity size={14} />, live: '142 N·mm' },
              { signal: 'internal_temperature_deg_C', unit: '°C', desc: 'Internal PCB temperature', icon: <Thermometer size={14} />, live: '38.4 °C' },
              { signal: 'power_W', unit: 'W', desc: 'Electrical power consumption', icon: <Zap size={14} />, live: '2.1 W' },
              { signal: 'rotation_direction', unit: '0/1/2', desc: '0=still, 1=opening, 2=closing', icon: <RotateCcw size={14} />, live: '1 (opening)' },
            ].map(({ signal, unit, desc, icon, live }) => (
              <div key={signal} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-all group">
                <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center shrink-0 mt-0.5 text-zinc-500 group-hover:text-diagnostic transition-colors">
                  {icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-bold text-zinc-300 truncate">{signal}</span>
                    <span className="text-[9px] font-bold text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">{unit}</span>
                    <span className="ml-auto text-[11px] font-mono font-bold text-diagnostic shrink-0">{live}</span>
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 p-4 rounded-xl bg-diagnostic/5 border border-diagnostic/10">
            <p className="text-[10px] text-diagnostic font-mono">
              <span className="font-bold uppercase tracking-widest">Key insight:</span> The torque-vs-position curve is a mechanical fingerprint.
              Degradation, obstruction, and misalignment each deform it in characteristic, detectable ways — like an ECG for the actuator.
            </p>
          </div>
        </div>
      </section>

      {/* Fleet health bar chart */}
      {fleetScores.length > 0 && (
        <section>
          <div className="glass rounded-[2rem] overflow-hidden">
            <div className="p-6 flex items-center justify-between border-b border-white/5">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full border border-diagnostic/30 flex items-center justify-center bg-diagnostic/5">
                  <BarChart3 className="text-diagnostic" size={18} />
                </div>
                <div>
                  <h3 className="text-white font-bold tracking-tight">Fleet Health Map</h3>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
                    Score per actuator — {mode === 'live' ? 'last 24h' : 'simulated'}
                  </p>
                </div>
              </div>
            </div>
            <div className="p-8 h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fleetScores}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#ffffff05" />
                  <XAxis dataKey="test_number" stroke="#71717a" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                  <YAxis domain={[0, 100]} stroke="#71717a" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                    wrapperStyle={{ outline: 'none' }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        return (
                          <div style={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '8px 12px', backdropFilter: 'blur(12px)' }}>
                            <p className="text-[10px] text-zinc-400">Actuator: {payload[0].payload.test_number}</p>
                            <p className="text-xs font-bold" style={{ color: scoreColor(payload[0].value as number) }}>
                              {(payload[0].value as number).toFixed(1)} / 100
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar dataKey="score" radius={[8, 8, 0, 0]}>
                    {fleetScores.map((entry, i) => (
                      <Cell key={i} fill={scoreColor(entry.score)} fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}
    </>
  );
}


// ============================================================================
// TAB 2 — Baseline Lab
// ============================================================================

function BaselineTab({
  mode, baselineProfile, setBaselineProfile, loading, setLoading,
}: {
  mode: AppMode;
  baselineProfile: TorqueProfile | null;
  setBaselineProfile: (p: TorqueProfile | null) => void;
  loading: string | null;
  setLoading: (v: string | null) => void;
}) {
  const profileData = baselineProfile ? profileToChartData(baselineProfile, 'Baseline') : [];

  const runStroke = async (name: string) => {
    setLoading(`Running ${name} stroke...`);
    try {
      await api.runBaseline(name);
    } catch (e) { console.error(e); }
    setLoading(null);
  };

  const loadProfile = async () => {
    setLoading('Loading baseline profile...');
    try {
      if (mode === 'live') {
        const r = await api.loadLiveBaseline();
        if (r.ok && r.profile) setBaselineProfile(r.profile);
      } else {
        const p = await api.getBaselineProfile();
        setBaselineProfile(p);
      }
    } catch (e) { console.error(e); }
    setLoading(null);
  };

  const peakBin = profileData.reduce((best, d) => (d.torque ?? 0) > (best.torque ?? 0) ? d : best, { position: 0, torque: 0, series: '' });

  return (
    <>
      <SectionHeader title="Baseline Lab" subtitle="Certify a healthy actuator fingerprint" />

      <section className="grid grid-cols-12 gap-10">
        {/* Actions */}
        <div className="col-span-12 xl:col-span-4 flex flex-col gap-6">
          <div className="glass rounded-[2rem] p-8">
            <h3 className="text-white font-bold mb-6 flex items-center gap-2">
              <FlaskConical size={18} className="text-diagnostic" />
              Baseline Actions
            </h3>

            {mode === 'live' ? (
              <div className="space-y-3">
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-4">Test number = 999</p>
                {['free', 'loaded', 'stall'].map((name) => (
                  <Button key={name} onClick={() => runStroke(name)} disabled={!!loading} variant="outline"
                    className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px] border-white/10 justify-start px-6">
                    <Play size={14} className="mr-2" /> Run {name} Stroke
                  </Button>
                ))}
                <div className="h-px bg-white/5 my-4" />
                <Button onClick={loadProfile} disabled={!!loading} className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px]">
                  Load Live Baseline
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Load certified baseline from local data</p>
                <Button onClick={loadProfile} disabled={!!loading} className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px]">
                  Load Replay Baseline
                </Button>
              </div>
            )}
          </div>

          {/* Baseline metrics */}
          {baselineProfile && (
            <div className="flex flex-col gap-4">
              <MetricModule label="Peak Bin" value={`${peakBin.position}%`} unit="" icon={<Gauge size={18} />} trend="Highest stress" data={[]} color="#00ff9f" />
              <MetricModule label="Peak |Torque|" value={`${(peakBin.torque ?? 0).toFixed(1)}`} unit="Nm" icon={<Activity size={18} />} trend="" data={[]} color="#00ff9f" />
              <MetricModule label="Coverage" value={`${profileData.length}`} unit="bins" icon={<BarChart3 size={18} />} trend="Valid positions" data={[]} color="#00ff9f" />
            </div>
          )}
        </div>

        {/* Profile chart */}
        <div className="col-span-12 xl:col-span-8">
          <div className="glass rounded-[2rem] overflow-hidden">
            <div className="p-6 border-b border-white/5">
              <h3 className="text-white font-bold tracking-tight">Certified Healthy Baseline</h3>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Torque Profile by Position Bin</p>
            </div>
            <div className="p-8 h-[420px]">
              {profileData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={profileData}>
                    <defs>
                      <linearGradient id="baseGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00ff9f" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#00ff9f" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="4 4" stroke="#ffffff05" />
                    <XAxis dataKey="position" stroke="#71717a" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} label={{ value: 'Position Bin (%)', position: 'bottom', fill: '#71717a', fontSize: 11 }} />
                    <YAxis stroke="#71717a" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} label={{ value: 'Mean |Torque| (Nm)', angle: -90, position: 'insideLeft', fill: '#71717a', fontSize: 11 }} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="glass p-3 rounded-xl border-white/10">
                              <p className="text-[10px] text-zinc-400">Bin: {payload[0].payload.position}%</p>
                              <p className="text-xs font-bold text-diagnostic">{(payload[0].value as number).toFixed(1)} Nm</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Area type="monotone" dataKey="torque" stroke="#00ff9f" strokeWidth={3} fill="url(#baseGrad)" dot={{ r: 4, fill: '#00ff9f', strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-zinc-600">No baseline loaded yet.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}


// ============================================================================
// TAB 3 — Health Intelligence
// ============================================================================

function HealthTab({
  mode, healthResult, setHealthResult, fleetScores, setFleetScores, loading, setLoading,
}: {
  mode: AppMode;
  healthResult: RunResult | null;
  setHealthResult: (r: RunResult | null) => void;
  fleetScores: FleetScore[];
  setFleetScores: (s: FleetScore[]) => void;
  loading: string | null;
  setLoading: (v: string | null) => void;
}) {
  const [testNum, setTestNum] = useState(1);
  const [scenario, setScenario] = useState<'healthy' | 'fault'>('healthy');

  const runAnalysis = async () => {
    setLoading('Running health analysis...');
    try {
      let result: RunResult;
      if (mode === 'live') {
        result = await api.runLiveHealth(testNum);
      } else {
        result = await api.runReplayHealth(scenario);
      }
      setHealthResult(result);
    } catch (e) { console.error(e); }
    setLoading(null);
  };

  const evalExisting = async () => {
    setLoading('Evaluating existing data...');
    try {
      const result = await api.evaluateHealth(testNum);
      setHealthResult(result);
    } catch (e) { console.error(e); }
    setLoading(null);
  };

  const loadFleet = async () => {
    setLoading('Computing fleet scores...');
    try {
      const scores = mode === 'live' ? await api.getFleetScores() : await api.getReplayFleetScores();
      setFleetScores(scores);
    } catch (e) { console.error(e); }
    setLoading(null);
  };

  const baselineData = healthResult?.baseline_profile ? profileToChartData(healthResult.baseline_profile, 'Baseline') : [];
  const currentData = healthResult?.current_profile ? profileToChartData(healthResult.current_profile, 'Current') : [];
  const overlayData = [...baselineData, ...currentData];
  const traceChart = healthResult?.trace ? telemetryToChart(healthResult.trace) : [];

  return (
    <>
      <SectionHeader title="Health Intelligence" subtitle="Score actuator health against certified baseline" />

      <section className="grid grid-cols-12 gap-10">
        {/* Controls */}
        <div className="col-span-12 xl:col-span-4 flex flex-col gap-6">
          <div className="glass rounded-[2rem] p-8">
            <h3 className="text-white font-bold mb-6 flex items-center gap-2">
              <HeartPulse size={18} className="text-diagnostic" />
              Analysis Controls
            </h3>

            {mode === 'live' ? (
              <div className="space-y-4">
                <label className="block">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Test Number (1-100)</span>
                  <input type="number" min={1} max={100} value={testNum} onChange={(e) => setTestNum(Number(e.target.value))}
                    className="mt-1 w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-sm focus:border-diagnostic/50 focus:outline-none" />
                </label>
                <Button onClick={runAnalysis} disabled={!!loading} className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px]">
                  <Play size={14} className="mr-2" /> Run Full Stroke
                </Button>
                <Button onClick={evalExisting} disabled={!!loading} variant="outline" className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px] border-white/10">
                  Compute From Existing
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex gap-2">
                  {(['healthy', 'fault'] as const).map((s) => (
                    <button key={s} onClick={() => setScenario(s)}
                      className={cn("flex-1 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all",
                        scenario === s ? "border-diagnostic/30 bg-diagnostic/10 text-diagnostic" : "border-white/5 text-zinc-500 hover:text-zinc-300"
                      )}>
                      {s}
                    </button>
                  ))}
                </div>
                <Button onClick={runAnalysis} disabled={!!loading} className="w-full h-10 rounded-xl font-bold uppercase tracking-widest text-[10px]">
                  Analyze Replay Trace
                </Button>
                <p className="text-[10px] text-zinc-600 font-mono">Same scoring pipeline as live mode.</p>
              </div>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="col-span-12 xl:col-span-8 flex flex-col gap-8">
          {healthResult && !healthResult.error ? (
            <>
              {/* Score gauge */}
              <div className="glass rounded-[2rem] p-10 flex flex-col items-center justify-center text-center">
                <ScoreGauge score={healthResult.score} label="Health Score" />
              </div>

              {/* Profile overlay chart */}
              {overlayData.length > 0 && (
                <div className="glass rounded-[2rem] p-6">
                  <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Torque Overlay: Baseline vs Current</h4>
                  <div className="h-[320px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart>
                        <CartesianGrid strokeDasharray="4 4" stroke="#ffffff05" />
                        <XAxis dataKey="position" type="number" stroke="#71717a" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
                        <Tooltip content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            return (
                              <div className="glass p-3 rounded-xl border-white/10">
                                <p className="text-[10px] text-zinc-400">Pos: {payload[0].payload.position}%</p>
                                <p className="text-[10px] font-bold text-white">{(payload[0].value as number).toFixed(1)} Nm</p>
                              </div>
                            );
                          }
                          return null;
                        }} />
                        <Line data={baselineData} dataKey="torque" stroke="#ffffff20" strokeWidth={2} strokeDasharray="8 8" dot={{ r: 3, fill: '#ffffff30' }} name="Baseline" />
                        <Line data={currentData} dataKey="torque" stroke="#00ff9f" strokeWidth={3} dot={{ r: 3, fill: '#00ff9f' }} name="Current" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center gap-6 mt-4">
                    <div className="flex items-center gap-2"><div className="w-8 h-px bg-white/20" /><span className="text-[10px] font-mono text-zinc-600">Baseline</span></div>
                    <div className="flex items-center gap-2"><div className="w-8 h-px bg-diagnostic" /><span className="text-[10px] font-mono text-diagnostic">Current</span></div>
                  </div>
                </div>
              )}

              {/* Diagnostics */}
              {healthResult.diagnostics.length > 0 && (
                <div className="glass rounded-[2rem] p-8">
                  <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Deterministic Diagnostics</h4>
                  <div className="space-y-2">
                    {healthResult.diagnostics.map((d, i) => (
                      <div key={i} className="flex items-start gap-3 text-sm text-zinc-400">
                        <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                        {d}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : healthResult?.error ? (
            <div className="glass rounded-[2rem] p-8 border-red-500/20">
              <p className="text-red-400 text-sm">{healthResult.error}</p>
            </div>
          ) : (
            <div className="glass rounded-[2rem] p-20 flex flex-col items-center justify-center text-center">
              <HeartPulse size={40} className="text-zinc-700 mb-4" />
              <p className="text-sm text-zinc-500">Run a health analysis to see results.</p>
            </div>
          )}
        </div>
      </section>

      {/* Fleet Intelligence */}
      <section className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-[0.3em]">Fleet Intelligence</h2>
          <div className="h-px flex-1 mx-8 bg-white/5" />
          <Button onClick={loadFleet} disabled={!!loading} variant="outline" className="h-9 rounded-lg text-[10px] font-bold uppercase tracking-widest border-white/10">
            <BarChart3 size={14} className="mr-2" /> Compute Fleet
          </Button>
        </div>

        {fleetScores.length > 0 ? (
          <div className="glass rounded-[2rem] p-8">
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fleetScores}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#ffffff05" />
                  <XAxis dataKey="test_number" stroke="#71717a" tick={{ fontSize: 10 }} />
                  <YAxis domain={[0, 100]} stroke="#71717a" tick={{ fontSize: 10 }} />
                  <Tooltip content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="glass p-3 rounded-xl border-white/10">
                          <p className="text-[10px] text-zinc-400">Test: {payload[0].payload.test_number}</p>
                          <p className="text-xs font-bold" style={{ color: scoreColor(payload[0].value as number) }}>{(payload[0].value as number).toFixed(1)}</p>
                        </div>
                      );
                    }
                    return null;
                  }} />
                  <Bar dataKey="score" radius={[8, 8, 0, 0]}>
                    {fleetScores.map((entry, i) => (
                      <Cell key={i} fill={scoreColor(entry.score)} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-6">
              <MetricModule label="Fleet Average" value={(fleetScores.reduce((a, b) => a + b.score, 0) / fleetScores.length).toFixed(1)} unit="/100" icon={<BarChart3 size={18} />} trend="" data={[]} color="#00ff9f" />
              <MetricModule label="Lowest" value={`${Math.min(...fleetScores.map(s => s.score)).toFixed(1)}`} unit="/100" icon={<AlertTriangle size={18} />} trend="" data={[]} color="#ef4444" />
            </div>
          </div>
        ) : (
          <div className="glass rounded-[2rem] p-12 text-center">
            <p className="text-sm text-zinc-600">Click Compute Fleet to generate cross-test scores.</p>
          </div>
        )}
      </section>
    </>
  );
}


// ============================================================================
// TAB 4 — Commissioning Gate
// ============================================================================

function CommissioningTab({
  mode, commResult, setCommResult, loading, setLoading,
}: {
  mode: AppMode;
  commResult: RunResult | null;
  setCommResult: (r: RunResult | null) => void;
  loading: string | null;
  setLoading: (v: string | null) => void;
}) {
  const [testNum, setTestNum] = useState(200);
  const [step, setStep] = useState<1 | 2 | 3>(commResult?.commissioning ? 3 : 1);
  const [progress, setProgress] = useState(0);
  const [activeCheck, setActiveCheck] = useState('');

  const STEPS = [
    { n: 1, label: 'Configure', desc: 'Set parameters' },
    { n: 2, label: 'Analyzing', desc: 'Running stroke' },
    { n: 3, label: 'Verdict', desc: 'View results' },
  ];

  const CHECKS_SEQUENCE = [
    'Sending stroke command...',
    'Actuator moving to 25%...',
    'Actuator moving to 50%...',
    'Actuator moving to 75%...',
    'Actuator moving to 100%...',
    'Returning to 0%...',
    'Collecting telemetry...',
    'Analyzing range of motion...',
    'Analyzing torque variability...',
    'Analyzing tracking error...',
    'Analyzing temperature rise...',
    'Computing verdict...',
  ];

  const runComm = async () => {
    setStep(2);
    setProgress(0);
    setActiveCheck(CHECKS_SEQUENCE[0]);

    // Animate through the 12 check steps
    for (let i = 0; i < CHECKS_SEQUENCE.length; i++) {
      setActiveCheck(CHECKS_SEQUENCE[i]);
      setProgress(Math.round(((i + 1) / CHECKS_SEQUENCE.length) * 100));
      await new Promise(r => setTimeout(r, 400));
    }

    if (mode === 'live') {
      try {
        const result = await api.runLiveCommissioning(testNum);
        setCommResult(result);
        setStep(3);
        return;
      } catch (e) { console.error(e); }
    }

    // Replay / fallback: generate realistic simulated trace
    const simTrace: TelemetryRow[] = [];
    for (let i = 0; i < 100; i++) {
      const pos = i;
      const baseTorque = 75 + 15 * Math.sin(pos * Math.PI / 100) + (Math.random() - 0.5) * 8;
      const midBump = pos > 40 && pos < 60 ? 12 * Math.exp(-((pos - 50) ** 2) / 50) : 0;
      simTrace.push({
        '_time': `2026-03-19T10:00:${String(i).padStart(2, '0')}.000Z`,
        'feedback_position_%': pos,
        'setpoint_position_%': pos + (Math.random() - 0.5) * 2,
        'motor_torque_Nmm': baseTorque + midBump,
        'internal_temperature_deg_C': 25.5 + i * 0.05 + Math.random() * 0.3,
        'power_W': 1.0 + Math.random() * 0.5,
        'rotation_direction': 1,
        'test_number': 200,
      } as TelemetryRow);
    }
    for (let i = 0; i < 100; i++) {
      const pos = 100 - i;
      const baseTorque = 70 + 12 * Math.sin(pos * Math.PI / 100) + (Math.random() - 0.5) * 6;
      simTrace.push({
        '_time': `2026-03-19T10:01:${String(i).padStart(2, '0')}.000Z`,
        'feedback_position_%': pos,
        'setpoint_position_%': pos + (Math.random() - 0.5) * 2,
        'motor_torque_Nmm': baseTorque,
        'internal_temperature_deg_C': 30.5 + i * 0.02 + Math.random() * 0.2,
        'power_W': 0.8 + Math.random() * 0.4,
        'rotation_direction': 2,
        'test_number': 200,
      } as TelemetryRow);
    }

    const simulated: RunResult = {
      score: 70,
      baseline_profile: { '5': 120, '15': 135, '25': 142, '35': 150, '45': 158, '55': 155, '65': 148, '75': 140, '85': 130, '95': 118 },
      current_profile: { '5': 125, '15': 145, '25': 155, '35': 168, '45': 172, '55': 165, '65': 155, '75': 148, '85': 138, '95': 122 },
      diagnostics: ['Minor thermal anomaly detected.', 'Verify valve sizing matches zone demand.'],
      commissioning: {
        score: 70,
        verdict: 'MARGINAL',
        checks: {
          range: { label: 'Range of Motion', value: 78, unit: '%', threshold: 60, passed: true, penalty: 0 },
          torque: { label: 'Torque Variability', value: 1.3, unit: 'CV', threshold: 1.5, passed: true, penalty: 0 },
          tracking: { label: 'Tracking Error', value: 8.5, unit: '%', threshold: 10, passed: true, penalty: 0 },
          temp: { label: 'Temperature Rise', value: 6.2, unit: '°C', threshold: 5, passed: false, penalty: 15 },
        },
        diagnostics: ['Temperature rise exceeds threshold — check valve load sizing.'],
      },
      trace: simTrace,
      error: null,
    };
    setCommResult(simulated);
    setStep(3);
  };

  const resetComm = () => {
    setStep(1);
    setCommResult(null);
    setProgress(0);
    setActiveCheck('');
  };

  const comm = commResult?.commissioning;
  const traceChart = commResult?.trace ? telemetryToChart(commResult.trace) : [];

  return (
    <>
      <SectionHeader title="Installation QA" subtitle="First-stroke commissioning verdict for installers" />

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-10">
        {STEPS.map(({ n, label, desc }) => (
          <React.Fragment key={n}>
            {n > 1 && <div className={`w-16 h-px ${step >= n ? 'bg-diagnostic' : 'bg-white/10'}`} />}
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-500 ${
                step > n ? 'bg-diagnostic border-diagnostic text-black' :
                step === n ? 'border-diagnostic text-diagnostic shadow-[0_0_12px_rgba(0,255,159,0.3)]' :
                'border-white/20 text-zinc-600'
              }`}>
                {step > n ? <CheckCircle2 size={14} /> : n}
              </div>
              <div className="hidden sm:block">
                <p className={`text-xs font-bold ${step >= n ? 'text-white' : 'text-zinc-600'}`}>{label}</p>
                <p className="text-[9px] text-zinc-500">{desc}</p>
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* STEP 1 — Configure */}
      {step === 1 && (
        <section className="grid grid-cols-12 gap-10">
          <div className="col-span-12 xl:col-span-5 flex flex-col gap-6">
            <div className="glass rounded-[2rem] p-8">
              <h3 className="text-white font-bold mb-6 flex items-center gap-2">
                <ShieldCheck size={18} className="text-diagnostic" />
                First-Stroke Diagnosis
              </h3>
              <p className="text-sm text-zinc-400 mb-6">
                This test performs a full actuator stroke and analyzes 4 key metrics to determine installation quality.
              </p>
              {mode === 'live' && (
                <label className="block mb-4">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Test Number (200-300)</span>
                  <input type="number" min={200} max={300} value={testNum} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestNum(Number(e.target.value))}
                    className="mt-1 w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-sm focus:border-diagnostic/50 focus:outline-none" />
                </label>
              )}
              <Button onClick={runComm} className="w-full h-12 rounded-xl font-bold uppercase tracking-widest text-xs">
                <Play size={16} className="mr-2" /> Run First-Stroke Diagnosis
              </Button>
            </div>
          </div>

          <div className="col-span-12 xl:col-span-7 flex flex-col gap-6">
            <div className="glass rounded-[2rem] p-8">
              <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-6">What gets checked</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { icon: <RotateCcw size={16} />, label: 'Range of Motion', desc: 'Full stroke coverage ≥ 60%', threshold: '≥ 60%' },
                  { icon: <Activity size={16} />, label: 'Torque Variability', desc: 'Smooth torque profile, no obstruction', threshold: 'CV < 1.5' },
                  { icon: <Crosshair size={16} />, label: 'Tracking Error', desc: 'Setpoint vs feedback alignment', threshold: '< 10%' },
                  { icon: <Thermometer size={16} />, label: 'Temperature Rise', desc: 'No overheating during stroke', threshold: '< 5°C' },
                ].map(({ icon, label, desc, threshold }) => (
                  <div key={label} className="glass rounded-xl p-4 border border-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="text-diagnostic">{icon}</div>
                      <span className="text-xs font-bold text-white">{label}</span>
                    </div>
                    <p className="text-[10px] text-zinc-500 mb-1">{desc}</p>
                    <span className="text-[9px] font-mono text-diagnostic/70">Threshold: {threshold}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass rounded-[2rem] p-6">
              <div className="flex items-center gap-3 mb-3">
                <Info size={16} className="text-zinc-500" />
                <span className="text-xs text-zinc-400">Pass threshold: <strong className="text-white">≥ 70 / 100</strong></span>
              </div>
              <p className="text-[10px] text-zinc-500">Scores below 70 indicate a potential installation issue — misalignment, obstruction, or undersized valve.</p>
            </div>
          </div>
        </section>
      )}

      {/* STEP 2 — Progress */}
      {step === 2 && (
        <section className="max-w-2xl mx-auto">
          <div className="glass rounded-[2rem] p-10 flex flex-col items-center">
            <Loader2 size={40} className="text-diagnostic animate-spin mb-6" />
            <h3 className="text-xl font-bold text-white mb-2">Analyzing Actuator</h3>
            <p className="text-sm text-diagnostic font-mono mb-8">{activeCheck}</p>

            {/* Progress bar */}
            <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden mb-4">
              <motion.div
                className="h-full bg-diagnostic rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
                style={{ boxShadow: '0 0 12px rgba(0,255,159,0.4)' }}
              />
            </div>
            <span className="text-xs text-zinc-500 font-mono">{progress}%</span>

            {/* Live check log */}
            <div className="w-full mt-8 space-y-2">
              {CHECKS_SEQUENCE.slice(0, Math.ceil((progress / 100) * CHECKS_SEQUENCE.length)).map((check, i) => (
                <div key={i} className="flex items-center gap-3 text-[10px] font-mono">
                  <CheckCircle2 size={12} className="text-diagnostic shrink-0" />
                  <span className="text-zinc-400">{check}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* STEP 3 — Verdict */}
      {step === 3 && comm && (
        <section className="grid grid-cols-12 gap-10">
          <div className="col-span-12 xl:col-span-4 flex flex-col gap-6">
            {/* Score gauge */}
            <div className="glass rounded-[2rem] p-10 flex flex-col items-center justify-center text-center">
              <ScoreGauge score={comm.score} label="Install QA" />
              <div className="mt-6">
                <Badge
                  variant={comm.verdict === 'PASS' ? 'success' : comm.verdict === 'MARGINAL' ? 'warning' : 'error'}
                  className="px-6 py-1.5 text-sm uppercase tracking-widest font-bold"
                >
                  {comm.verdict}
                </Badge>
              </div>
            </div>

            {/* Reset button */}
            <Button onClick={resetComm} variant="outline" className="w-full h-9 rounded-xl font-bold uppercase tracking-widest text-[10px] border-white/10">
              <RotateCcw size={14} className="mr-2" /> Run Again
            </Button>
          </div>

          {/* Right column: recommendations + checks + heatmap + torque signature */}
          <div className="col-span-12 xl:col-span-8 flex flex-col gap-6">
            {/* Recommendations */}
            {comm.diagnostics.length > 0 && (() => {
              const verdictStyles = {
                PASS:     { border: 'border-[#00ff9f]/20', bg: 'bg-[#00ff9f]/5',  icon: '#00ff9f', label: 'All Clear', labelBg: 'bg-[#00ff9f]/10 text-[#00ff9f]' },
                MARGINAL: { border: 'border-amber-400/20',  bg: 'bg-amber-400/5',   icon: '#fbbf24', label: 'Action Suggested', labelBg: 'bg-amber-400/10 text-amber-400' },
                FAIL:     { border: 'border-red-500/20',    bg: 'bg-red-500/5',     icon: '#ef4444', label: 'Action Required', labelBg: 'bg-red-500/10 text-red-400' },
              };
              const vs = verdictStyles[comm.verdict] || verdictStyles.MARGINAL;
              return (
                <div className={`glass rounded-[2rem] p-8 ${vs.border} border`}>
                  <div className="flex items-center justify-between mb-5">
                    <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Recommendations</h4>
                    <span className={`text-[9px] font-bold uppercase tracking-widest px-3 py-1 rounded-full ${vs.labelBg}`}>
                      {vs.label}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {comm.diagnostics.map((d, i) => (
                      <div key={i} className={`flex items-start gap-3 p-3 rounded-xl ${vs.bg}`}>
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: vs.icon }} />
                        <span className="text-sm text-zinc-300">{d}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Validation Checklist */}
            <div className="glass rounded-[2rem] p-8">
              <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-6">Validation Checklist</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Object.values(comm.checks).map((check) => (
                  <QAModule
                    key={check.label}
                    label={check.label}
                    status={check.passed ? 'pass' : 'warning'}
                    value={`${check.value.toFixed(1)} ${check.unit}`}
                  />
                ))}
              </div>
            </div>

            {/* Resistance Heatmap */}
            {commResult?.trace && commResult.trace.length > 0 && (
              <ResistanceHeatmap segments={computeResistanceSegments(commResult.trace)} />
            )}

            {/* Torque–Position Signature */}
            {commResult?.trace && commResult.trace.length > 0 && (() => {
              const torquePosData = traceToTorquePosition(commResult.trace);
              return (
                <div className="glass rounded-[2rem] p-6">
                  <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">
                    Torque–Position Signature
                  </h4>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={torquePosData}>
                        <CartesianGrid strokeDasharray="4 4" stroke="#ffffff05" />
                        <XAxis dataKey="position" stroke="#71717a" tick={{ fontSize: 10 }}
                          label={{ value: 'Stroke Position (%)', position: 'insideBottom', offset: -5, style: { fontSize: 10, fill: '#71717a' } }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }}
                          label={{ value: 'Torque (N·mm)', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#71717a' } }} />
                        <Tooltip
                          cursor={{ stroke: 'rgba(255,255,255,0.05)' }}
                          contentStyle={{ background: '#18181b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                          labelFormatter={(v: number) => `Position: ${v}%`}
                        />
                        <Line type="monotone" dataKey="torqueUp" name="Up-stroke ↑" stroke="#00ff9f" strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="torqueDown" name="Down-stroke ↓" stroke="#a78bfa" strokeWidth={2} dot={false} connectNulls strokeDasharray="6 3" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center justify-center gap-6 mt-3">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-0.5 bg-[#00ff9f]" />
                      <span className="text-[10px] text-zinc-500 font-mono">Up-stroke</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-0.5 border-t-2 border-dashed border-[#a78bfa]" />
                      <span className="text-[10px] text-zinc-500 font-mono">Down-stroke</span>
                    </div>
                  </div>
                </div>
              );
            })()}

          </div>
        </section>
      )}
    </>
  );
}


// ============================================================================
// SHARED COMPONENTS
// ============================================================================

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-6 mb-2">
      <div>
        <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-[0.2em] mb-1">{subtitle}</h2>
        <span className="text-2xl font-bold text-white tracking-tight">{title}</span>
      </div>
      <div className="h-px flex-1 bg-white/5" />
    </div>
  );
}

function ScoreGauge({ score, label }: { score: number; label: string }) {
  const color = scoreColor(score);
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const level = score >= 80 ? 'Optimal Performance' : score >= 50 ? 'Elevated Deviation' : 'Critical Deviation';

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-48 h-48">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
          <motion.circle
            cx="100" cy="100" r={radius} fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 2, ease: 'circOut' }}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 15px ${color}80)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-5xl font-black text-white tracking-tighter text-glow">{score.toFixed(0)}</span>
          <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.15em] mt-1">{label}</span>
        </div>
      </div>
      <div className="mt-6">
        <Badge
          variant={score >= 80 ? 'success' : score >= 50 ? 'warning' : 'error'}
          className="px-6 py-1.5 text-xs uppercase tracking-widest font-bold"
        >
          {level}
        </Badge>
      </div>
    </div>
  );
}

function RailItem({ icon, active, onClick, label }: { icon: React.ReactNode; active?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-1 transition-all",
        active ? "text-diagnostic" : "text-zinc-600 hover:text-zinc-400"
      )}
    >
      <div className={cn(
        "w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300",
        active ? "bg-diagnostic/10 shadow-[inset_0_0_10px_rgba(0,255,159,0.1)]" : "group-hover:bg-white/5"
      )}>
        {icon}
      </div>
      <span className="text-[8px] font-bold uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">{label}</span>
      {active && (
        <motion.div
          layoutId="railActive"
          className="absolute -left-4 top-1/2 -translate-y-1/2 w-1 h-6 bg-diagnostic rounded-r-full shadow-[0_0_10px_rgba(0,255,159,0.8)]"
        />
      )}
    </button>
  );
}

function MetricModule({ label, value, unit, icon, trend, data, color }: { label: string; value: string; unit: string; icon: React.ReactNode; trend: string; data: number[]; color: string }) {
  return (
    <div className="glass rounded-[2rem] p-6 group hover:border-white/10 transition-all duration-500">
      <div className="flex items-center justify-between mb-4">
        <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center border border-white/5 group-hover:border-white/10 transition-colors">
          <div className="text-zinc-500 group-hover:text-diagnostic transition-colors">{icon}</div>
        </div>
        {trend && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md text-zinc-500 bg-zinc-500/5">
            {trend}
          </span>
        )}
      </div>
      <div className="space-y-1 mb-4">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</p>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-black text-white tracking-tighter">{value}</span>
          <span className="text-xs font-bold text-zinc-600">{unit}</span>
        </div>
      </div>
      {data.length > 0 && (
        <div className="h-10 w-full opacity-50 group-hover:opacity-100 transition-opacity duration-500">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.map((v, i) => ({ v, i }))}>
              <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function QAModule({ label, status, value }: { label: string; status: 'pass' | 'warning' | 'error'; value: string; key?: string }) {
  const colors = {
    pass: "text-emerald-400 border-emerald-400/20 bg-emerald-400/5",
    warning: "text-amber-400 border-amber-400/20 bg-amber-400/5",
    error: "text-red-400 border-red-400/20 bg-red-400/5"
  };

  return (
    <div className="glass rounded-2xl p-4 flex items-center justify-between group hover:bg-white/[0.04] transition-all">
      <div className="flex items-center gap-4">
        <div className={cn("w-2 h-2 rounded-full", status === 'pass' ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" : status === 'warning' ? "bg-amber-400" : "bg-red-400")} />
        <span className="text-xs font-bold text-zinc-400 group-hover:text-zinc-200 transition-colors uppercase tracking-widest">{label}</span>
      </div>
      <div className={cn("px-3 py-1 rounded-lg border text-[10px] font-mono font-bold", colors[status])}>
        {value}
      </div>
    </div>
  );
}
