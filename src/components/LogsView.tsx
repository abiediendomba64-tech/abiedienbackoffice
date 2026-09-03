import React, { useState } from 'react';
import { AuditLog } from '../types';
import { FileText, Shield, Filter, Download, Search } from 'lucide-react';

interface LogsViewProps {
  logs: AuditLog[];
  searchTerm: string;
}

export const LogsView: React.FC<LogsViewProps> = ({ logs, searchTerm }) => {
  const [severityFilter, setSeverityFilter] = useState<string>('all');

  const filteredLogs = logs.filter((l) => {
    const matchesSearch = l.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          l.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          l.target.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          l.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSeverity = severityFilter === 'all' || l.severity === severityFilter;
    return matchesSearch && matchesSeverity;
  });

  const handleExportLogs = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `audit_logs_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-700">Severity:</span>
          {['all', 'info', 'warn', 'error'].map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`text-xs px-3 py-1.5 rounded-xl font-medium capitalize transition-all ${
                severityFilter === sev
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>

        <button
          onClick={handleExportLogs}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-sm transition-all"
        >
          <Download className="w-4 h-4" />
          <span>Export Audit Trail (JSON)</span>
        </button>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider font-semibold">
                <th className="py-3.5 px-6">Event ID & Time</th>
                <th className="py-3.5 px-4">User</th>
                <th className="py-3.5 px-4">Action</th>
                <th className="py-3.5 px-4">Target Resource</th>
                <th className="py-3.5 px-4">Severity</th>
                <th className="py-3.5 px-6 text-right">IP Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    No audit logs matching your query.
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
      </div>
    </div>
  );
};
