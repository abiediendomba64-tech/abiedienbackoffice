import React from 'react';
import { Search, Bell, Sparkles, User as UserIcon } from 'lucide-react';
import { NavTab } from '../types';

interface HeaderProps {
  currentTab: NavTab;
  searchTerm: string;
  onSearchChange: (val: string) => void;
  onOpenAIAssistant: () => void;
  onOpenNotifications: () => void;
}

export const Header: React.FC<HeaderProps> = ({ currentTab, searchTerm, onSearchChange, onOpenAIAssistant, onOpenNotifications }) => {
  const tabTitles: Record<NavTab, { title: string; subtitle: string }> = {
    dashboard: { title: 'Executive Dashboard', subtitle: 'Overview of system operations, metrics, and real-time activity.' },
    users: { title: 'User & Role Management', subtitle: 'Manage organization accounts, permissions, and security status.' },
    analytics: { title: 'Analytics & Performance', subtitle: 'Revenue, traffic trends, and infrastructure latency metrics.' },
    logs: { title: 'System Audit Logs', subtitle: 'Immutable event logs and security compliance tracking.' },
    tickets: { title: 'Support & Incident Tickets', subtitle: 'Internal support requests and escalated system incidents.' },
    settings: { title: 'System Configurations', subtitle: 'Global parameters, API integrations, and security policies.' },
  };

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0 shadow-xs">
      <div>
        <h2 className="text-lg font-bold text-slate-800 tracking-tight">{tabTitles[currentTab].title}</h2>
        <p className="text-xs text-slate-500 font-medium">{tabTitles[currentTab].subtitle}</p>
      </div>

      <div className="flex items-center gap-4">
        {/* Search Bar */}
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search records, users, logs..."
            className="w-full bg-slate-100 border border-slate-200 rounded-xl pl-9 pr-4 py-1.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 transition-all"
          />
        </div>

        {/* AI Assistant Quick Trigger */}
        <button
          onClick={onOpenAIAssistant}
          className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-3.5 py-1.5 rounded-xl font-medium text-xs shadow-sm shadow-blue-500/20 transition-all active:scale-95 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 animate-pulse text-blue-200" />
          <span>Ask AI Assistant</span>
        </button>

        {/* Notifications / Telegram Delivery Status */}
        <button
          onClick={onOpenNotifications}
          className="relative p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
          title="Telegram Bot Notifications & Delivery Status"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-600"></span>
        </button>

        {/* User Profile Pill */}
        <div className="flex items-center gap-3 pl-3 border-l border-slate-200">
          <img
            src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80"
            alt="Abied Iendomba"
            className="w-8 h-8 rounded-full object-cover ring-2 ring-slate-200"
          />
          <div className="text-left hidden sm:block">
            <p className="text-xs font-semibold text-slate-800 leading-none">Abied Iendomba</p>
            <p className="text-[10px] text-blue-600 font-medium mt-0.5">Super Admin</p>
          </div>
        </div>
      </div>
    </header>
  );
};
