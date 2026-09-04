import React, { useState, useEffect } from 'react';
import { AuditLog } from '../types';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { FileText, Shield, Filter, Download, Search, RefreshCw, Radio, AlertCircle, Loader2 } from 'lucide-react';

interface LogsViewProps {
  searchTerm: string;
}

export const LogsView: React.FC<LogsViewProps> = ({ searchTerm }) => {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);

  const fetchAuditLogs = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('audit_logs')
          .select('*')
          .order('timestamp', { ascending: false });

        if (error) {
          throw error;
        }

        if (data && data.length > 0) {
          setAuditLogs(data as AuditLog[]);
        } else {
          // Fallback initial sample audit logs if table is empty
          setAuditLogs([
            {
              id: 'LOG-9001',
              timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
              user: 'Abied Iendomba',
              action: 'SYSTEM_BOOT',
              target: 'Enterprise Backoffice Core',
              severity: 'info',
              ipAddress: '192.168.1.1'
            }
          ]);
        }
      } catch (err: any) {
        console.warn('Failed to fetch audit logs from Supabase:', err.message);
        setErrorMessage(`Failed to fetch live audit logs: ${err.message}. Showing local cached logs.`);
        // Fallback to mock logs
        setAuditLogs([
          {
            id: 'LOG-8821',
            timestamp: '2026-09-03 10:30:12',
            user: 'Abied Iendomba',
            action: 'USER_ROLE_UPDATE',
            target: 'User USR-002 upgraded to Admin',
            severity: 'info',
            ipAddress: '192.168.1.45'
          },
          {
            id: 'LOG-8822',
            timestamp: '2026-09-03 10:45:00',
            user: 'System Guard',
            action: 'AUTH_FAILED_ATTEMPT',
            target: 'IP 203.0.113.42 blocked',
            severity: 'warn',
            ipAddress: '203.0.113.42'
          }
        ]);
      }
    } else {
      // Offline / Local development mode
      setAuditLogs([
        {
          id: 'LOG-7701',
          timestamp: '2026-09-03 09:15:00',
          user: 'Abied Iendomba',
          action: 'LOCAL_MODE_INIT',
          target: 'Supabase credentials not detected',
          severity: 'info',
          ipAddress: '127.0.0.1'
        }
      ]);
    }

    setIsLoading(false);
  };

  useEffect(() => {
    fetchAuditLogs();

    if (isSupabaseConfigured) {
      const channel = supabase
        .channel('public:audit_logs')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'audit_logs' },
          (payload) => {
            const newLog = payload.new as AuditLog;
            setAuditLogs((prev) => [newLog, ...prev]);
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setIsLiveConnected(true);
          }
        });

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, []);

  const filteredLogs = auditLogs.filter((l) => {
    const matchesSearch =
      l.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.target.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSeverity = severityFilter === 'all' || l.severity === severityFilter;
    return matchesSearch && matchesSeverity;
  });

  const handleExportLogs = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(auditLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `audit_logs_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header controls & real-time badge */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Radio className={`w-4 h-4 ${isLiveConnected ? 'text-emerald-500 animate-pulse' : 'text-amber-500'}`} />
            <span className="text-xs font-bold text-slate-700">
              {isLiveConnected ? 'Supabase Realtime Subscribed' : 'Local / Simulated Audit Stream'}
            </span>
          </div>

          <div className="h-4 w-px bg-slate-200 hidden sm:block" />

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-700">Severity:</span>
            {['all', 'info', 'warn', 'error'].map((sev) => (
              <button
                key={sev}
                onClick={() => setSeverityFilter(sev)}
                className={`text-xs px-3 py-1.5 rounded-xl font-medium capitalize transition-all cursor-pointer ${
                  severityFilter === sev
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {sev}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchAuditLogs}
            disabled={isLoading}
            className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer"
            title="Refresh Logs"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleExportLogs}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-sm transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Export Audit Trail (JSON)</span>
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-2xl flex items-center gap-3 text-xs font-medium">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Logs Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center flex flex-col items-center justify-center space-y-3">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            <p className="text-xs font-semibold text-slate-500">Fetching immutable audit logs from database...</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider font-semibold">
                  <th className="py-3.5 px-6">Event ID & Time</th>
                  <th className="py-3.5 px-4">Operator</th>
                  <th className="py-3.5 px-4">Action</th>
                  <th className="py-3.5 px-4">Target Resource</th>
                  <th className="py-3.5 px-4">Severity</th>
                  <th className="py-3.5 px-6 text-right">IP Address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400 text-xs font-medium">
                      No audit log events found matching your filter.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-4 px-6 font-mono">
                        <div className="text-xs font-bold text-slate-800">{log.id}</div>
                        <div className="text-[11px] text-slate-400">{log.timestamp}</div>
                      </td>
                      <td className="py-4 px-4 font-semibold text-slate-800 text-xs">
                        {log.user}
                      </td>
                      <td className="py-4 px-4 font-mono text-xs text-blue-600 font-semibold">
                        {log.action}
                      </td>
                      <td className="py-4 px-4 text-xs text-slate-700">
                        {log.target}
                      </td>
                      <td className="py-4 px-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${
                          log.severity === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                          log.severity === 'warn' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                          'bg-blue-50 text-blue-700 border border-blue-200'
                        }`}>
                          {log.severity}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-right font-mono text-xs text-slate-500">
                        {log.ipAddress}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
