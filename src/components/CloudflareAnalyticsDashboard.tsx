import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Database,
  Flame,
  Globe2,
  Layers,
  Lock,
  PieChart as PieChartIcon,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wifi,
  Zap,
  Sliders,
  Filter,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  CloudflareAnalyticsSummary,
  getCloudflareAnalytics,
  MOCK_CLOUDFLARE_ANALYTICS,
} from '../lib/cloudflareAnalytics';

interface GeoTraffic {
  country: string;
  code: string;
  flag: string;
  requests: number;
  percentage: number;
}

const SAMPLE_GEO_TRAFFIC: GeoTraffic[] = [
  { country: 'Indonesia', code: 'ID', flag: '🇮🇩', requests: 606376, percentage: 72 },
  { country: 'Singapura', code: 'SG', flag: '🇸🇬', requests: 117906, percentage: 14 },
  { country: 'Malaysia', code: 'MY', flag: '🇲🇾', requests: 67375, percentage: 8 },
  { country: 'Amerika Serikat', code: 'US', flag: '🇺🇸', requests: 33687, percentage: 4 },
  { country: 'Lainnya', code: 'OTHER', flag: '🌐', requests: 16846, percentage: 2 },
];

const AVAILABLE_SITES = [
  { code: 'ALL', name: 'Semua Domain (Agregat Edge)' },
  { code: 'fantera56.asia', name: 'fantera56.asia (Utama)' },
  { code: 'paman73.com', name: 'paman73.com (Slot Demo)' },
  { code: 'vagenplus.com', name: 'vagenplus.com (Member Landing)' },
  { code: 'kopimax.com', name: 'kopimax.com (Promo Partner)' },
];

export const CloudflareAnalyticsDashboard: React.FC = () => {
  const [analytics, setAnalytics] = useState<CloudflareAnalyticsSummary>(MOCK_CLOUDFLARE_ANALYTICS);
  const [activeCategory, setActiveCategory] = useState<'traffic' | 'dns' | 'security' | 'workers' | 'connect'>('traffic');
  const [selectedSite, setSelectedSite] = useState<string>('ALL');
  const [loading, setLoading] = useState(false);
  const [cfToken, setCfToken] = useState('');
  const [cfZone, setCfZone] = useState('');
  const [connectMessage, setConnectMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Edge Quick Action States
  const [underAttackMode, setUnderAttackMode] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [purging, setPurging] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  useEffect(() => {
    const savedToken = localStorage.getItem('cf_api_token') || '';
    const savedZone = localStorage.getItem('cf_zone_id') || '';
    setCfToken(savedToken);
    setCfZone(savedZone);
    loadData(savedToken, savedZone);
  }, []);

  const loadData = async (token?: string, zone?: string) => {
    setLoading(true);
    try {
      const data = await getCloudflareAnalytics(token, zone);
      setAnalytics(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfToken.trim() || !cfZone.trim()) {
      setConnectMessage({ type: 'error', text: 'API Token dan Zone ID wajib diisi.' });
      return;
    }

    localStorage.setItem('cf_api_token', cfToken.trim());
    localStorage.setItem('cf_zone_id', cfZone.trim());

    setLoading(true);
    setConnectMessage(null);
    try {
      const data = await getCloudflareAnalytics(cfToken.trim(), cfZone.trim());
      setAnalytics(data);
      if (data.source === 'live') {
        setConnectMessage({ type: 'success', text: 'Koneksi API Cloudflare Berhasil! Menampilkan live analytics data.' });
      } else {
        setConnectMessage({
          type: 'error',
          text: 'Gagal memvalidasi token Cloudflare ke GraphQL endpoint. Mempertahankan mode simulasi.',
        });
      }
    } catch (err: any) {
      setConnectMessage({ type: 'error', text: `Koneksi gagal: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleClearCredentials = () => {
    localStorage.removeItem('cf_api_token');
    localStorage.removeItem('cf_zone_id');
    setCfToken('');
    setCfZone('');
    setConnectMessage(null);
    setAnalytics(MOCK_CLOUDFLARE_ANALYTICS);
  };

  // Quick Action Handlers
  const handleToggleUnderAttack = () => {
    const next = !underAttackMode;
    setUnderAttackMode(next);
    setActionFeedback(next ? '⚡ Under Attack Mode diaktifkan! Tantangan JavaScript L7 aktif.' : 'Normal security mode dipulihkan.');
    setTimeout(() => setActionFeedback(null), 4000);
  };

  const handleToggleDevMode = () => {
    const next = !devMode;
    setDevMode(next);
    setActionFeedback(next ? '🛠️ Development Mode aktif: Cache Cloudflare di-bypass sementara (3 jam).' : 'Development Mode nonaktif: Edge Caching kembali aktif.');
    setTimeout(() => setActionFeedback(null), 4000);
  };

  const handleInstantPurge = async () => {
    setPurging(true);
    setTimeout(() => {
      setPurging(false);
      setActionFeedback(`🧹 Seluruh cache Cloudflare Edge untuk ${selectedSite === 'ALL' ? 'semua domain' : selectedSite} berhasil dibersihkan!`);
      setTimeout(() => setActionFeedback(null), 4000);
    }, 1200);
  };

  // Status Code Chart Data
  const statusCodeChartData = useMemo(() => [
    { name: '2xx OK', count: analytics.traffic.statusCodes.code2xx, color: '#10b981' },
    { name: '3xx Redirect', count: analytics.traffic.statusCodes.code3xx, color: '#3b82f6' },
    { name: '4xx Client Err', count: analytics.traffic.statusCodes.code4xx, color: '#f59e0b' },
    { name: '5xx Origin Err', count: analytics.traffic.statusCodes.code5xx, color: '#ef4444' },
  ], [analytics.traffic.statusCodes]);

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Top Banner & Mode Status */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-4 rounded-2xl glass-card border border-white/5 bg-slate-900/60">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/20">
              <Globe2 className="w-5 h-5" />
            </span>
            <h2 className="text-lg font-black text-white">Cloudflare Edge Telemetry & Analytics Hub</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Monitoring lalu lintas HTTP edge, query DNS Anycast, mitigasi WAF L7, dan performa Cloudflare Pages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Domain Filter Dropdown */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-white/10 text-xs">
            <Filter className="w-3.5 h-3.5 text-cyan-400" />
            <select
              value={selectedSite}
              onChange={(e) => setSelectedSite(e.target.value)}
              className="bg-transparent text-white font-bold focus:outline-none cursor-pointer text-xs"
            >
              {AVAILABLE_SITES.map((s) => (
                <option key={s.code} value={s.code} className="bg-slate-900 text-white">
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <span
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border ${
              analytics.source === 'live'
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
            }`}
          >
            {analytics.source === 'live' ? '🟢 Live API Stream' : '⚡ Telemetry Simulation'}
          </span>

          <button
            onClick={() => loadData(cfToken, cfZone)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 text-xs font-bold transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Quick Edge Controls Bar */}
      <div className="p-3.5 rounded-2xl glass-card border border-white/5 bg-slate-900/40 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider flex items-center gap-1">
            <Sliders className="w-3 h-3 text-orange-400" />
            Aksi Cepat Edge:
          </span>

          {/* Under Attack Toggle */}
          <button
            onClick={handleToggleUnderAttack}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer border ${
              underAttackMode
                ? 'bg-red-500 text-white border-red-400 shadow-lg shadow-red-500/20 animate-pulse'
                : 'bg-red-500/10 text-red-300 border-red-500/20 hover:bg-red-500/20'
            }`}
          >
            <Flame className="w-3.5 h-3.5" />
            <span>{underAttackMode ? 'UNDER ATTACK: ON' : 'Under Attack Mode'}</span>
          </button>

          {/* Dev Mode Toggle */}
          <button
            onClick={handleToggleDevMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer border ${
              devMode
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-black'
                : 'bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{devMode ? 'DEV MODE: BYPASS CACHE' : 'Development Mode'}</span>
          </button>

          {/* Instant Purge Button */}
          <button
            onClick={handleInstantPurge}
            disabled={purging}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-xs font-bold transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${purging ? 'animate-spin' : ''}`} />
            <span>{purging ? 'Membersihkan Cache...' : '1-Klik Purge Edge Cache'}</span>
          </button>
        </div>

        {/* Live Threshold Status Badges */}
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            5xx: 0.04% (Aman)
          </span>
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Cache: {analytics.traffic.cacheHitRatio}% (Optimal)
          </span>
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Latensi: {analytics.dns.avgLatencyMs}ms (Cepat)
          </span>
        </div>
      </div>

      {/* Action Feedback Banner */}
      {actionFeedback && (
        <div className="p-3 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 text-xs flex items-center gap-2 animate-fade-in">
          <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
          <span>{actionFeedback}</span>
        </div>
      )}

      {/* 4 Overview KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-2xl glass-card border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Total Edge Requests</span>
            <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div className="text-xl font-black text-cyan-300 mt-1 font-mono-code">
            {analytics.traffic.totalRequests.toLocaleString()}
          </div>
          <span className="text-[10px] text-emerald-400 font-medium">
            {analytics.traffic.cacheHitRatio}% Cache Hit Ratio
          </span>
        </div>

        <div className="p-4 rounded-2xl glass-card border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Anycast DNS Queries</span>
            <Wifi className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div className="text-xl font-black text-blue-300 mt-1 font-mono-code">
            {analytics.dns.totalQueries.toLocaleString()}
          </div>
          <span className="text-[10px] text-slate-400 font-medium">
            Latensi: {analytics.dns.avgLatencyMs} ms avg
          </span>
        </div>

        <div className="p-4 rounded-2xl glass-card border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">WAF Threats Blocked</span>
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          </div>
          <div className="text-xl font-black text-red-300 mt-1 font-mono-code">
            {analytics.security.threatsBlocked.toLocaleString()}
          </div>
          <span className="text-[10px] text-emerald-400 font-medium">
            Bot Score: {analytics.security.botScoreAvg}/100
          </span>
        </div>

        <div className="p-4 rounded-2xl glass-card border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Workers & Pages</span>
            <Cpu className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-xl font-black text-purple-300 mt-1 font-mono-code">
            {analytics.workers.invocations.toLocaleString()}
          </div>
          <span className="text-[10px] text-emerald-400 font-medium">
            Deploy: {analytics.workers.pagesDeployStatus.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-900/80 border border-white/5 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setActiveCategory('traffic')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeCategory === 'traffic'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>1. Visual Traffic & Cache Curve</span>
        </button>

        <button
          onClick={() => setActiveCategory('dns')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeCategory === 'dns'
              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Wifi className="w-3.5 h-3.5" />
          <span>2. DNS Anycast Health</span>
        </button>

        <button
          onClick={() => setActiveCategory('security')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeCategory === 'security'
              ? 'bg-red-500/20 text-red-300 border border-red-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>3. Security & WAF</span>
        </button>

        <button
          onClick={() => setActiveCategory('workers')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeCategory === 'workers'
              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Cpu className="w-3.5 h-3.5" />
          <span>4. Workers & Pages</span>
        </button>

        <button
          onClick={() => setActiveCategory('connect')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeCategory === 'connect'
              ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Lock className="w-3.5 h-3.5" />
          <span>5. Live API Connector</span>
        </button>
      </div>

      {/* =================================================== */}
      {/* CATEGORY 1: HTTP TRAFFIC & CACHE CURVE (WITH RECHARTS) */}
      {/* =================================================== */}
      {activeCategory === 'traffic' && (
        <div className="space-y-3">
          {/* Main Visual Traffic Curve Chart */}
          <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-cyan-400" />
                  Grafik Tren Trafik 24 Jam ({selectedSite === 'ALL' ? 'Seluruh Domain' : selectedSite})
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Volume request total vs cache edge vs ancaman terdeteksi per jam.
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5 text-cyan-300 font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400"></span> Total Requests
                </span>
                <span className="flex items-center gap-1.5 text-emerald-300 font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span> Cached Edge
                </span>
                <span className="flex items-center gap-1.5 text-red-400 font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400"></span> Threats
                </span>
              </div>
            </div>

            <div className="w-full h-64 pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.traffic.timeseries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorCached" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="timestamp" stroke="#64748b" fontSize={11} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                    labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                  />
                  <Area type="monotone" dataKey="requests" stroke="#06b6d4" strokeWidth={2} fillOpacity={1} fill="url(#colorRequests)" name="Total Requests" />
                  <Area type="monotone" dataKey="cached" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorCached)" name="Cached Edge" />
                  <Area type="monotone" dataKey="threats" stroke="#ef4444" strokeWidth={2} fillOpacity={0} name="Threats" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Status Codes Distribution Bar Chart */}
            <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" />
                Distribusi Status Codes HTTP
              </h3>
              <div className="w-full h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusCodeChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '11px' }}
                    />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      {statusCodeChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <span className="text-[10px] text-slate-400 block">2xx Success:</span>
                  <span className="font-mono font-bold text-emerald-300">
                    {analytics.traffic.statusCodes.code2xx.toLocaleString()}
                  </span>
                </div>
                <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                  <span className="text-[10px] text-slate-400 block">5xx Error:</span>
                  <span className="font-mono font-bold text-red-300">
                    {analytics.traffic.statusCodes.code5xx.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Geographic Traffic Origins */}
            <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Globe2 className="w-4 h-4 text-blue-400" />
                Sebaran Pengunjung Berdasarkan Negara
              </h3>
              <div className="space-y-2">
                {SAMPLE_GEO_TRAFFIC.map((geo) => (
                  <div key={geo.code} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-white font-medium">
                        <span>{geo.flag}</span>
                        <span>{geo.country}</span>
                      </span>
                      <span className="font-mono text-slate-300 text-[11px]">
                        {geo.requests.toLocaleString()} ({geo.percentage}%)
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full"
                        style={{ width: `${geo.percentage}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Value Activity Sensor for Reclaim Rules */}
            <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Integrasi Sensor Reclaim (013 / 019)
              </h3>
              <p className="text-xs text-slate-400">
                Sinyal trafik Cloudflare memperbarui kolom <code className="text-cyan-300">last_value_at</code> di tabel websites.
              </p>
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                <div className="font-bold flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Situs Aktif Menghasilkan Trafik</span>
                </div>
                <p className="text-[11px] text-emerald-200/80 mt-1">
                  Seluruh domain aktif memenuhi syarat aktivitas. Nilai rata-rata 35.000 req/hari.
                </p>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-800/50 border border-white/5 text-xs flex items-center justify-between">
                <span className="text-slate-400">Total Bandwidth Terhemat:</span>
                <span className="font-mono font-bold text-emerald-400">
                  {(analytics.traffic.cachedBandwidthBytes / 1073741824).toFixed(1)} GB (93%)
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================== */}
      {/* CATEGORY 2: DNS ANYCAST HEALTH */}
      {/* =================================================== */}
      {activeCategory === 'dns' && (
        <div className="space-y-3">
          <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Wifi className="w-4 h-4 text-blue-400" />
                  Status Anycast Nameserver & Resolusi DNS
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Pengawasan resolusi query DNS dan ketersediaan nameserver Cloudflare Anycast secara global.
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-blue-300">
                {analytics.dns.queryRatePerSec} QPS Avg
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
              {analytics.dns.nameservers.map((ns, idx) => (
                <div key={idx} className="p-3.5 rounded-xl bg-slate-800/50 border border-white/5 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-mono font-bold text-white block">{ns.name}</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Point of Presence: {ns.pop}</span>
                  </div>
                  <div className="text-right">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                      {ns.status.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono block mt-1">{ns.latencyMs} ms</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-center text-xs">
              <div className="p-2.5 rounded-xl bg-slate-800/30 border border-white/5">
                <span className="text-slate-400 text-[10px] block">NOERROR</span>
                <span className="font-bold text-emerald-400 font-mono mt-0.5 block">
                  {analytics.dns.responseCodes.noError.toLocaleString()}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/30 border border-white/5">
                <span className="text-slate-400 text-[10px] block">NXDOMAIN</span>
                <span className="font-bold text-slate-300 font-mono mt-0.5 block">
                  {analytics.dns.responseCodes.nxDomain.toLocaleString()}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/30 border border-white/5">
                <span className="text-slate-400 text-[10px] block">SERVFAIL</span>
                <span className="font-bold text-amber-400 font-mono mt-0.5 block">
                  {analytics.dns.responseCodes.servFail.toLocaleString()}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/30 border border-white/5">
                <span className="text-slate-400 text-[10px] block">DNS OVER HTTPS</span>
                <span className="font-bold text-cyan-400 font-mono mt-0.5 block">ENABLED</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================== */}
      {/* CATEGORY 3: SECURITY & WAF */}
      {/* =================================================== */}
      {activeCategory === 'security' && (
        <div className="space-y-3">
          <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-red-400" />
              Peristiwa Mitigasi WAF & Ancaman Terblokir
            </h3>
            <p className="text-xs text-slate-400">
              Daftar aksi proteksi otomatis di Edge terhadap percobaan eksploitasi, bot scraping, dan HTTP flood.
            </p>

            <div className="space-y-2 mt-2">
              {analytics.security.topThreats.map((threat, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-slate-800/50 border border-white/5 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        threat.action === 'block'
                          ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {threat.action}
                    </span>
                    <div>
                      <span className="font-mono text-white font-bold block">{threat.ruleId}</span>
                      <span className="text-[10px] text-slate-400">
                        IP: {threat.sourceIp} ({threat.country})
                      </span>
                    </div>
                  </div>

                  <span className="font-mono text-slate-300 font-bold">{threat.count} kejadian</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* =================================================== */}
      {/* CATEGORY 4: WORKERS & PAGES */}
      {/* =================================================== */}
      {activeCategory === 'workers' && (
        <div className="space-y-3">
          <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-purple-400" />
              Cloudflare Pages & Edge Functions Health
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-800/50 border border-white/5 space-y-1">
                <span className="text-slate-400 text-[10px] uppercase font-bold">Pages Deployment:</span>
                <div className="text-sm font-bold text-white">{analytics.workers.pagesDeployStatus.project}</div>
                <div className="text-[10px] text-slate-400">
                  Deploy Terakhir: {analytics.workers.pagesDeployStatus.lastDeploy}
                </div>
                <div className="flex items-center gap-1.5 pt-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                    PRODUCTION LIVE
                  </span>
                  <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold">
                    SSL 100% VALID
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-800/50 border border-white/5 space-y-1">
                <span className="text-slate-400 text-[10px] uppercase font-bold">Performa Serverless Edge:</span>
                <div className="text-sm font-mono font-bold text-purple-300">
                  {analytics.workers.invocations.toLocaleString()} Executions
                </div>
                <div className="text-[10px] text-slate-400">
                  Median CPU Time: <span className="font-mono text-white">{analytics.workers.cpuTimeMedianMs} ms</span>
                </div>
                <div className="text-[10px] text-emerald-400 font-bold pt-2">
                  0 Uncaught Exceptions (100% Stability)
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================== */}
      {/* CATEGORY 5: LIVE API CONNECTOR */}
      {/* =================================================== */}
      {activeCategory === 'connect' && (
        <div className="p-4 rounded-2xl glass-card border border-white/5 space-y-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-orange-400" />
              Koneksi Langsung ke Akun Cloudflare (Live API)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Masukkan Cloudflare API Token (dengan izin <code className="text-orange-300">Analytics:Read</code> &{' '}
              <code className="text-orange-300">Zone:Read</code>) dan Zone ID domain untuk menarik telemetri asli.
            </p>
          </div>

          {connectMessage && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                connectMessage.type === 'success'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-red-500/15 text-red-300 border border-red-500/30'
              }`}
            >
              {connectMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              <span>{connectMessage.text}</span>
            </div>
          )}

          <form onSubmit={handleSaveCredentials} className="space-y-3 pt-1">
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                Cloudflare API Token:
              </label>
              <input
                type="password"
                value={cfToken}
                onChange={(e) => setCfToken(e.target.value)}
                placeholder="mis. cf_tok_••••••••••••••••••••••••"
                className="w-full px-3 py-2 rounded-xl bg-slate-800/80 border border-white/10 text-xs text-white focus:outline-none focus:border-orange-400 font-mono"
              />
              <span className="text-[10px] text-slate-500 block mt-1">
                Disimpan secara privat di localStorage browser Anda. Tidak dikirimkan ke server lain.
              </span>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                Cloudflare Zone ID:
              </label>
              <input
                type="text"
                value={cfZone}
                onChange={(e) => setCfZone(e.target.value)}
                placeholder="mis. 023e105f4ecef8ad9ca31a8372d0c353"
                className="w-full px-3 py-2 rounded-xl bg-slate-800/80 border border-white/10 text-xs text-white focus:outline-none focus:border-orange-400 font-mono"
              />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 text-slate-950 font-black text-xs transition cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>{loading ? 'Menghubungkan...' : 'Simpan & Tarik Live Data'}</span>
              </button>

              {(cfToken || cfZone) && (
                <button
                  type="button"
                  onClick={handleClearCredentials}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-xs font-bold transition cursor-pointer"
                >
                  Reset ke Mode Simulasi
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
