import React, { useState } from 'react';
import { SupportTicket } from '../types';
import { LifeBuoy, AlertTriangle, CheckCircle, Clock, Plus } from 'lucide-react';

interface TicketsViewProps {
  tickets: SupportTicket[];
  onUpdateStatus: (id: string, status: SupportTicket['status']) => void;
  searchTerm: string;
}

export const TicketsView: React.FC<TicketsViewProps> = ({ tickets, onUpdateStatus, searchTerm }) => {
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredTickets = tickets.filter((t) => {
    const matchesSearch = t.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          t.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          t.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          t.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-700">Status Filter:</span>
          {['all', 'open', 'in_progress', 'resolved', 'closed'].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`text-xs px-3 py-1.5 rounded-xl font-medium capitalize transition-all ${
                statusFilter === st
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {st.replace('_', ' ')}
            </button>
          ))}
        </div>

        <div className="text-xs text-slate-500 font-medium">
          Showing {filteredTickets.length} of {tickets.length} tickets
        </div>
      </div>

      {/* Tickets List */}
      <div className="grid grid-cols-1 gap-4">
        {filteredTickets.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center text-slate-400 border border-slate-200">
            No support tickets found matching your search.
          </div>
        ) : (
          filteredTickets.map((ticket) => (
            <div key={ticket.id} className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-6 hover:shadow-md transition-all">
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">{ticket.id}</span>
                  <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${
                    ticket.priority === 'urgent' ? 'bg-rose-100 text-rose-700' :
                    ticket.priority === 'high' ? 'bg-amber-100 text-amber-700' :
                    ticket.priority === 'medium' ? 'bg-blue-100 text-blue-700' :
                    'bg-slate-100 text-slate-700'
                  }`}>
                    {ticket.priority} priority
                  </span>
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium">{ticket.category}</span>
                </div>
                <h4 className="text-base font-bold text-slate-900">{ticket.subject}</h4>
                <div className="flex items-center gap-4 text-xs text-slate-500 font-medium">
                  <span>Reported by: <strong className="text-slate-700">{ticket.user}</strong> ({ticket.email})</span>
                  <span>•</span>
                  <span>{ticket.createdAt}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <select
                  value={ticket.status}
                  onChange={(e) => onUpdateStatus(ticket.id, e.target.value as any)}
                  className={`text-xs font-semibold px-3 py-2 rounded-xl border focus:outline-none transition-all ${
                    ticket.status === 'open' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                    ticket.status === 'in_progress' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                    ticket.status === 'resolved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
