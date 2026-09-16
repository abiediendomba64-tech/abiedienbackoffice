import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, WifiOff } from 'lucide-react';
import { getCloudflareAnalytics, CloudflareAnalyticsSummary } from '../lib/cloudflareAnalytics';

export const CloudflareAnalyticsDashboard: React.FC = () => {
  const [data, setData] = useState<CloudflareAnalyticsSummary | null>(null);
  const [token, setToken] = useState('');
  const [zone, setZone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setToken(localStorage.getItem('cf_api_token') || '');
    setZone(localStorage.getItem('cf_zone_id') || '');
  }, []);

  const load = async (tokenOverride = token, zoneOverride = zone) => {
    setLoading(true);
    setError('');
    try {
      const result = await getCloudflareAnalytics(tokenOverride.trim(), zoneOverride.trim());
      setData(result);
      if (result.source !== 'live') {
        setData(null);
        setError('Cloudflare Live API belum terhubung. Tidak ada data simulasi yang ditampilkan.');
      }
    } catch (e: any) {
      setData(null);
      setError(e?.message || 'Cloudflare API gagal dihubungi.');
    } finally {
      setLoading(false);
    }
  };

  const saveAndLoad = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || !zone.trim()) {
      setError('Cloudflare API Token dan Zone ID wajib diisi.');
      return;
    }
    localStorage.setItem('cf_api_token', token.trim());
    localStorage.setItem('cf_zone_id', zone.trim());
    await load(token, zone);
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="glass-card p-5 rounded-3xl border border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-white">Cloudflare Live Analytics</h2>
            <p className="text-xs text-slate-400 mt-1">Data hanya berasal dari Cloudflare API nyata.</p>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${data?.source === 'live' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
            {data?.source === 'live' ? 'LIVE' : 'NOT CONNECTED'}
          </span>
        </div>

        <form onSubmit={saveAndLoad} className="grid md:grid-cols-[1fr_1fr_auto] gap-2 mt-4">
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Cloudflare API Token" autoComplete="off" className="h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-xs text-white" />
          <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone ID" className="h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-xs text-white font-mono" />
          <button type="submit" disabled={loading} className="h-10 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50">
            {loading ? 'Menghubungkan...' : 'Hubungkan & Refresh'}
          </button>
        </form>

        {error && (
          <div className="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-xs flex gap-2 items-start">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {!data || data.source !== 'live' ? (
        <div className="glass-card p-8 rounded-3xl border border-white/10 text-center">
          <WifiOff className="w-8 h-8 mx-auto text-slate-500 mb-3" />
          <div className="text-sm font-bold text-slate-300">Belum ada telemetry live</div>
          <div className="text-xs text-slate-500 mt-1">Dashboard tidak mengisi angka contoh. Hubungkan API untuk membaca data aktual.</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Metric label="Requests" value={data.traffic.totalRequests.toLocaleString('id-ID')} />
            <Metric label="Cache Hit" value={`${data.traffic.cacheHitRatio}%`} />
            <Metric label="DNS Queries" value={data.dns.totalQueries.toLocaleString('id-ID')} />
            <Metric label="Threats Blocked" value={data.security.threatsBlocked.toLocaleString('id-ID')} />
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="glass-card p-5 rounded-3xl border border-white/10">
              <h3 className="text-xs font-black text-white mb-3">Live Security</h3>
              <div className="text-xs text-slate-300">Threats blocked: <b>{data.security.threatsBlocked.toLocaleString('id-ID')}</b></div>
              <div className="text-xs text-slate-400 mt-1">Rate limit actions: {data.security.rateLimitActions.toLocaleString('id-ID')}</div>
            </div>
            <div className="glass-card p-5 rounded-3xl border border-white/10">
              <h3 className="text-xs font-black text-white mb-3">Connection</h3>
              <div className="text-xs text-slate-300">Zone: {data.zoneName}</div>
              <div className="text-xs text-slate-400 mt-1">Updated: {new Date(data.lastUpdated).toLocaleString('id-ID')}</div>
            </div>
          </div>

          <button type="button" onClick={() => load()} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 border border-white/10 text-xs font-bold text-slate-200 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh live data
          </button>
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            Control actions are hidden until a server-side Cloudflare management integration exists.
          </div>
        </>
      )}
    </div>
  );
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-card p-4 rounded-2xl border border-white/10">
      <div className="text-[10px] uppercase font-bold text-slate-400">{label}</div>
      <div className="text-xl font-black text-white mt-1 font-mono">{value}</div>
    </div>
  );
}
