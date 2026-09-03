import React, { useState } from 'react';
import { NavTab, User, SupportTicket } from './types';
import { initialUsers, initialLogs, initialTickets } from './data/mockData';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardView } from './components/DashboardView';
import { UsersView } from './components/UsersView';
import { AnalyticsView } from './components/AnalyticsView';
import { LogsView } from './components/LogsView';
import { TicketsView } from './components/TicketsView';
import { SettingsView } from './components/SettingsView';
import { AIAssistantModal } from './components/AIAssistantModal';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>('dashboard');
  const [searchTerm, setSearchTerm] = useState('');
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [tickets, setTickets] = useState<SupportTicket[]>(initialTickets);
  const [isAIModalOpen, setIsAIModalOpen] = useState(false);

  const handleAddUser = (newUser: User) => {
    setUsers(prev => [newUser, ...prev]);
  };

  const handleUpdateUserStatus = (id: string, status: 'active' | 'inactive' | 'suspended') => {
    setUsers(prev => prev.map(u => u.id === id ? { ...u, status } : u));
  };

  const handleDeleteUser = (id: string) => {
    setUsers(prev => prev.filter(u => u.id !== id));
  };

  const handleUpdateTicketStatus = (id: string, status: SupportTicket['status']) => {
    setTickets(prev => prev.map(t => t.id === id ? { ...t, status } : t));
  };

  const unreadTicketsCount = tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length;

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        unreadTicketsCount={unreadTicketsCount}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          currentTab={currentTab}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          onOpenAIAssistant={() => setIsAIModalOpen(true)}
        />

        <main className="flex-1 overflow-y-auto">
          {currentTab === 'dashboard' && <DashboardView onNavigate={setCurrentTab} />}
          {currentTab === 'users' && (
            <UsersView
              users={users}
              onAddUser={handleAddUser}
              onUpdateUserStatus={handleUpdateUserStatus}
              onDeleteUser={handleDeleteUser}
              searchTerm={searchTerm}
            />
          )}
          {currentTab === 'analytics' && <AnalyticsView />}
          {currentTab === 'logs' && <LogsView logs={initialLogs} searchTerm={searchTerm} />}
          {currentTab === 'tickets' && (
            <TicketsView
              tickets={tickets}
              onUpdateStatus={handleUpdateTicketStatus}
              searchTerm={searchTerm}
            />
          )}
          {currentTab === 'settings' && <SettingsView />}
        </main>
      </div>

      {/* AI Assistant Modal */}
      <AIAssistantModal
        isOpen={isAIModalOpen}
        onClose={() => setIsAIModalOpen(false)}
      />
    </div>
  );
}
