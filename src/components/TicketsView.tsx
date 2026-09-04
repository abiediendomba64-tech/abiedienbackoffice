import React, { useState } from 'react';
import { SupportTicket } from '../types';
import { LifeBuoy, AlertTriangle, CheckCircle, Clock, Plus, UserCheck, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { claimTicket, assignTicket, resolveTicket } from '../lib/api';

interface TicketsViewProps {
  tickets: SupportTicket[];
  onUpdateStatus: (id: string, status: SupportTicket['status']) => void;
  searchTerm: string;
}

export const TicketsView: React.FC<TicketsViewProps> = ({ tickets, onUpdateStatus, searchTerm }) => {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [assigningTicketId, setAssigningTicketId] = useState<string | null>(null);
  const [assigneeName, setAssigneeName] = useState('Sarah Jenkins');

  const currentOperator = 'Abied Iendomba';

  const filteredTickets = tickets.filter((t) => {
    const matchesSearch =
      t.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleClaim = async (ticketId: string) => {
    await claimTicket(ticketId, currentOperator);
    onUpdateStatus(ticketId, 'in_progress');
    setActionMessage(`Successfully claimed ticket #${ticketId}. Logged in audit trail & notified Telegram.`);
    setTimeout(() => setActionMessage(null), 4000);
  };

  const handleAssignSubmit = async (e: React.FormEvent, ticketId: string) => {
    e.preventDefault();
    await assignTicket(ticketId, assigneeName, currentOperator);
    onUpdateStatus(ticketId, 'in_progress');
    setAssigningTicketId(null);
    setActionMessage(`Assigned ticket #${ticketId} to ${assigneeName}. Action recorded in audit logs.`);
    setTimeout(() => setActionMessage(null), 4000);
  };

  const handleResolveSubmit = async (e: React.FormEvent, ticketId: string) => {
    e.preventDefault();
    await resolveTicket(ticketId, resolutionNotes || 'Resolved by operator', currentOperator);
    onUpdateStatus(ticketId, 'resolved');
    setResolvingTicketId(null);
    setResolutionNotes('');
    setActionMessage(`Resolved ticket #${ticketId}. Telegram alert dispatched & audit log recorded.`);
    setTimeout(() => setActionMessage(null), 4000);
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      {actionMessage && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-2xl flex items-center gap-3 shadow-xs animate-fade-in">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span className="text-sm font-semibold">{actionMessage}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-slate-700">Status Filter:</span>
          {['all', 'open', 'in_progress', 'resolved', 'closed'].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`text-xs px-3 py-1.5 rounded-xl font-medium capitalize transition-all cursor-pointer ${
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
          Showing {filteredTickets.length} of {tickets.length} support tickets
        </div>
      </div>

      {/* Tickets List */}
      <div className="grid grid-cols-1 gap-4">
        {filteredTickets.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center text-slate-400 border border-slate-200">
            No support tickets found matching your query.
          </div>
        ) : (
          filteredTickets.map((ticket) => (
            <div key={ticket.id} className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs flex flex-col gap-5 hover:shadow-md transition-all">
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded border border-blue-100">{ticket.id}</span>
                    <span className={`text-[10px] uppercase tracking-wider font-bold px-2.5 py-0.5 rounded-full ${
                      ticket.priority === 'urgent' ? 'bg-rose-100 text-rose-700' :
                      ticket.priority === 'high' ? 'bg-amber-100 text-amber-700' :
                      ticket.priority === 'medium' ? 'bg-blue-100 text-blue-700' :
                      'bg-slate-100 text-slate-700'
                    }`}>
                      {ticket.priority} priority
                    </span>
                    <span className="text-xs bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded font-medium">{ticket.category}</span>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full capitalize ${
                      ticket.status === 'open' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                      ticket.status === 'in_progress' ? 'bg-blue-50 text-blue-700 border border-blue-200' :
                      ticket.status === 'resolved' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                      'bg-slate-100 text-slate-700 border border-slate-200'
                    }`}>
                      {ticket.status.replace('_', ' ')}
                    </span>
                  </div>
                  <h4 className="text-base font-bold text-slate-900">{ticket.subject}</h4>
                  <div className="flex items-center gap-4 text-xs text-slate-500 font-medium flex-wrap">
                    <span>Reported by: <strong className="text-slate-700">{ticket.user}</strong> ({ticket.email})</span>
                    <span>•</span>
                    <span>{ticket.createdAt}</span>
                  </div>
                </div>

                {/* Ticket Action Buttons */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  <button
                    onClick={() => handleClaim(ticket.id)}
                    className="bg-blue-50 hover:bg-blue-100 text-blue-700 px-3.5 py-2 rounded-xl text-xs font-semibold border border-blue-200 transition-all cursor-pointer"
                  >
                    Claim Ticket
                  </button>
                  <button
                    onClick={() => setAssigningTicketId(assigningTicketId === ticket.id ? null : ticket.id)}
                    className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-200 transition-all cursor-pointer"
                  >
                    Assign
                  </button>
                  <button
                    onClick={() => setResolvingTicketId(resolvingTicketId === ticket.id ? null : ticket.id)}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-semibold shadow-xs transition-all cursor-pointer"
                  >
                    Resolve
                  </button>
                </div>
              </div>

              {/* Assign Form Drawer */}
              {assigningTicketId === ticket.id && (
                <form onSubmit={(e) => handleAssignSubmit(e, ticket.id)} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-center gap-3 animate-fade-in">
                  <span className="text-xs font-semibold text-slate-700">Assign to Operator:</span>
                  <select
                    value={assigneeName}
                    onChange={(e) => setAssigneeName(e.target.value)}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
                  >
                    <option value="Sarah Jenkins">Sarah Jenkins (Admin)</option>
                    <option value="Marcus Vance">Marcus Vance (Manager)</option>
                    <option value="Elena Rostova">Elena Rostova (Support)</option>
                    <option value="Amina Diallo">Amina Diallo (Manager)</option>
                  </select>
                  <button
                    type="submit"
                    className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer"
                  >
                    Confirm Assignment
                  </button>
                </form>
              )}

              {/* Resolve Form Drawer */}
              {resolvingTicketId === ticket.id && (
                <form onSubmit={(e) => handleResolveSubmit(e, ticket.id)} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3 animate-fade-in">
                  <span className="text-xs font-bold text-slate-800 block">Resolution Summary / Notes</span>
                  <input
                    type="text"
                    required
                    value={resolutionNotes}
                    onChange={(e) => setResolutionNotes(e.target.value)}
                    placeholder="Describe fix implemented (e.g. Cleared Redis cache and re-ran migration script)..."
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setResolvingTicketId(null)}
                      className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer"
                    >
                      Submit & Audit Log
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
