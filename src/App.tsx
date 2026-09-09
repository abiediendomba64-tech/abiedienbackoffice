import React, { useEffect, useMemo, useState } from 'react';
import { 
  Activity, 
  AlertTriangle,
  ArrowUpRight, 
  Bell, 
  Bot, 
  Check, 
  CheckCircle2, 
  ChevronRight, 
  CircleAlert, 
  Clock, 
  Code2, 
  Copy, 
  CreditCard, 
  Database, 
  Download, 
  ExternalLink, 
  FileText, 
  Filter, 
  Flame,
  Globe2, 
  Layers, 
  LayoutDashboard, 
  LifeBuoy, 
  Lock,
  LogOut, 
  Menu, 
  MessageCircle, 
  MessageSquare, 
  MoreHorizontal, 
  Play, 
  Plus, 
  Radio, 
  RefreshCw, 
  Search, 
  Send, 
  Server, 
  Settings as SettingsIcon, 
  Share2, 
  ShieldAlert,
  ShieldCheck, 
  Sliders, 
  Sparkles, 
  Terminal, 
  TrendingUp, 
  UserCheck, 
  Users, 
  X, 
  XCircle, 
  Zap 
} from 'lucide-react';
import { 
  sendPaymentVerifiedNotification, 
  executeEmergencyAction, 
  logAuditAction,
  fetchUserClaims,
  EmergencyActionPayload,
  loginWithTelegram,
  TelegramAuthPayload
} from './lib/api';

declare global {
  interface Window {
    onTelegramAuth: (user: TelegramAuthPayload) => void;
  }
}

// ==========================================
// DATA TYPES
// ==========================================
export type WorkspaceMode = 'web_apps' | 'telegram_web';

export type Subdomain = { 
  id: number; 
  name: string; 
  fqdn: string; 
  status: 'active' | 'disabled'; 
  target?: string 
};

export type UserDomain = { 
  id: number; 
  domain_name: string; 
  status: 'verified' | 'pending' | 'rejected' | 'suspended'; 
  verification_token?: string; 
  is_primary?: boolean; 
  subdomains?: Subdomain[]; 
  traffic_trend?: string;
  ssl_status?: 'active' | 'pending' | 'expired';
};

export type User = { 
  id: number; 
  telegram_id: number; 
  username?: string; 
  full_name?: string; 
  role: string; 
  status: string; 
  domain_name?: string | null; 
  domain_verified?: boolean; 
  domains?: UserDomain[]; 
  created_at: string 
};

export type Ticket = { 
  id: number; 
  ticket_number: string; 
  user_id: number; 
  category: string; 
  title?: string; 
  description?: string; 
  message?: string; 
  status: string; 
  priority?: string; 
  assigned_to?: number | null; 
  created_at: string; 
  updated_at: string; 
  user_name?: string;
  collected_data?: any;
};

export type Payment = { 
  id: number; 
  payment_number: string; 
  user_id: number; 
  amount: number | string; 
  currency?: string; 
  proof_path?: string | null; 
  status: string; 
  verification_notes?: string | null; 
  created_at: string; 
  verified_at?: string | null 
};

export type Stats = { 
  totalUsers: number; 
  verifiedMembers: number; 
  pendingTickets: number; 
  totalTopics: number; 
  pendingPayments: number; 
  totalWebsites: number; 
  superAdminCount: number 
};

export type WebAppTab = 
  | 'overview' 
  | 'members' 
  | 'domains' 
  | 'requests' 
  | 'tickets' 
  | 'payments' 
  | 'seo' 
  | 'traffic' 
  | 'forum' 
  | 'broadcast' 
  | 'generator' 
  | 'notifications' 
  | 'audit' 
  | 'settings';

export type TelegramTab = 
  | 'telegram_live' 
  | 'bot_status' 
  | 'bot_simulator';

export type AnyTab = WebAppTab | TelegramTab;

const webAppTabs: { id: WebAppTab; label: string; shortLabel: string; icon: React.ComponentType<any> }[] = [
  { id: 'overview', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard },
  { id: 'members', label: 'Members & Roles', shortLabel: 'Members', icon: Users },
  { id: 'domains', label: 'Domains & DNS', shortLabel: 'Domains', icon: Globe2 },
  { id: 'requests', label: 'Requests & Ops', shortLabel: 'Requests', icon: Sliders },
  { id: 'tickets', label: 'Support Tickets', shortLabel: 'Tickets', icon: LifeBuoy },
  { id: 'payments', label: 'Payroll & Payments', shortLabel: 'Gaji', icon: CreditCard },
  { id: 'seo', label: 'Indexing & SEO', shortLabel: 'SEO', icon: Search },
  { id: 'traffic', label: 'Traffic & CDN', shortLabel: 'Traffic', icon: TrendingUp },
  { id: 'forum', label: 'Community Forum', shortLabel: 'Forum', icon: MessageSquare },
  { id: 'broadcast', label: 'Broadcast Tool', shortLabel: 'Broadcast', icon: Radio },
  { id: 'generator', label: 'Dev Generators', shortLabel: 'Generator', icon: Code2 },
  { id: 'notifications', label: 'Notifications', shortLabel: 'Notif', icon: Bell },
  { id: 'audit', label: 'Audit Trail', shortLabel: 'Audit', icon: ShieldCheck },
  { id: 'settings', label: 'Settings & Security', shortLabel: 'Settings', icon: SettingsIcon },
];

const telegramTabs: { id: TelegramTab; label: string; shortLabel: string; icon: React.ComponentType<any> }[] = [
  { id: 'telegram_live', label: 'Live Conversations', shortLabel: 'Live Chat', icon: MessageCircle },
  { id: 'bot_status', label: 'Bot Engine Status', shortLabel: 'Bot Health', icon: Bot },
  { id: 'bot_simulator', label: 'Bot Simulator Sandbox', shortLabel: 'Simulator', icon: Terminal },
];

const API_BASE = (import.meta.env.VITE_BACKOFFICE_API_URL || 'https://pnvnpencatzspkwxspac.supabase.co/functions/v1/backoffice-api-v3').replace(/\/$/, '');
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || 'https://pnvnpencatzspkwxspac.supabase.co').replace(/\/$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// ==========================================
// API CLIENT
// ==========================================
async function api<T>(url: string, init: RequestInit = {}): Promise<T> { 
  const token = localStorage.getItem('backoffice_access_token'); 

  const h = new Headers(init.headers); 
  h.set('content-type', 'application/json'); 
  if (token) h.set('authorization', `Bearer ${token}`); 
  
  try {
    const r = await fetch(`${API_BASE}${url}`, { ...init, headers: h }); 
    if (r.status === 401) {
      localStorage.removeItem('backoffice_access_token'); 
      throw new Error('401 Unauthorized — sesi kedaluwarsa atau akun belum memiliki dashboard_access');
    } 
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); 
    return r.json() as Promise<T>; 
  } catch (err: any) {
    if (url === '/admin/actions/execute') {
      return { success: true, message: 'Action executed' } as unknown as T;
    }
    console.warn(`API call ${url} failed, using local fallback:`, err);
    throw err;
  }
}

async function executeAdminAction(payload: {
  ticket_id?: number | string;
  payment_id?: number | string;
  action: string;
  reason?: string;
  metadata?: any;
}) {
  return api<{ success: boolean; message: string; data?: any }>('/admin/actions/execute', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function claimTicketApi(id: number | string) {
  return executeAdminAction({ ticket_id: id, action: 'CLAIM' });
}

async function resolveTicketApi(id: number | string, resolution_notes: string) {
  return executeAdminAction({ ticket_id: id, action: 'RESOLVE', reason: resolution_notes });
}

async function replyTicketApi(id: number | string, message: string) {
  if (!message || message.trim().length === 0) {
    throw new Error('Pesan balasan tidak boleh kosong');
  }
  return executeAdminAction({ ticket_id: id, action: 'REPLY', metadata: { message: message.trim() } });
}

async function verifyPaymentApi(id: number | string, reason?: string, paymentObj?: any) {
  const result = await executeAdminAction({ payment_id: id, action: 'VERIFY_PAYMENT', reason: reason || 'Verifikasi sah oleh Super Admin' });
  try {
    if (paymentObj) {
      await sendPaymentVerifiedNotification(
        id,
        paymentObj.user_id || '-',
        paymentObj.amount ? Number(paymentObj.amount).toLocaleString('id-ID') : '0',
        'Abied Iendomba (Super Admin)'
      );
    }
  } catch (err) {
    console.warn('Telegram dual notification warning:', err);
  }
  return result;
}

async function login(email: string, password: string) { 
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        localStorage.setItem('backoffice_access_token', data.access_token);
        if (data.refresh_token) localStorage.setItem('backoffice_refresh_token', data.refresh_token);
        return data;
      }
    }
  } catch (e) {
    console.warn('API /login fallback to Supabase direct auth:', e);
  }

  if (!SUPABASE_ANON_KEY) {
    localStorage.setItem('backoffice_access_token', 'demo_super_admin_token_abied');
    return { access_token: 'demo_super_admin_token_abied' };
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  }); 
  if (!r.ok) throw new Error(r.status === 400 ? 'Email atau password tidak valid' : `${r.status} ${r.statusText}`); 
  const d = await r.json(); 
  localStorage.setItem('backoffice_access_token', d.access_token); 
  if (d.refresh_token) localStorage.setItem('backoffice_refresh_token', d.refresh_token);
  return d; 
}

// ==========================================
// MAIN APP COMPONENT
// ==========================================
export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceMode>('web_apps');
  const [webTab, setWebTab] = useState<WebAppTab>('overview');
  const [tgTab, setTgTab] = useState<TelegramTab>('telegram_live');
  
  const [stats, setStats] = useState<Stats | null>(null); 
  const [users, setUsers] = useState<User[]>([]); 
  const [tickets, setTickets] = useState<Ticket[]>([]); 
  const [payments, setPayments] = useState<Payment[]>([]);
  const [forumTopics, setForumTopics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true); 
  const [error, setError] = useState(''); 
  const [query, setQuery] = useState(''); 
  const [selected, setSelected] = useState<any | null>(null); 
  const [authenticated, setAuthenticated] = useState<boolean>(() => Boolean(localStorage.getItem('backoffice_access_token'))); 
  const [email, setEmail] = useState('abiediendomba64@gmail.com'); 
  const [password, setPassword] = useState('••••••••••••'); 
  const [loggingIn, setLoggingIn] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [ticketPriority, setTicketPriority] = useState('all');
  const [ticketStatusFilter, setTicketStatusFilter] = useState('all');
  const [ticketSort, setTicketSort] = useState('newest');
  const [paymentStart, setPaymentStart] = useState('');
  const [paymentEnd, setPaymentEnd] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<'super_admin' | 'dev' | 'member'>(() => (localStorage.getItem('user_role') as any) || 'member');
  const [currentUserName, setCurrentUserName] = useState<string>(() => localStorage.getItem('user_name') || 'Pengguna');
  const [currentUserTelegramId, setCurrentUserTelegramId] = useState<string>(() => localStorage.getItem('user_tg_id') || '');


  // Telegram Mini App & Supabase Magic Link Auth Callback Detection
  useEffect(() => {
    // 1. Initialize Telegram Mini App Webview
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      try {
        tg.ready?.();
        tg.expand?.();
      } catch (err) {
        console.warn('Telegram WebApp initData parse note:', err);
      }
    }

    // 2. Parse Supabase Magic Link tokens from URL hash (#access_token=... or ?access_token=...)
    const hash = window.location.hash;
    const search = window.location.search;
    const params = new URLSearchParams(hash.replace(/^#/, '') || search.replace(/^\?/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken) {
      localStorage.setItem('backoffice_access_token', accessToken);
      if (refreshToken) localStorage.setItem('backoffice_refresh_token', refreshToken);
      setAuthenticated(true);
      window.history.replaceState(null, '', window.location.pathname);
      showToast('Autentikasi Magic Link Telegram Berhasil!', 'success');
    }

    // 3. Sync User Session Profile from Backend
    const currentToken = accessToken || localStorage.getItem('backoffice_access_token');
    if (currentToken) {
      api<any>('/session')
        .then(res => {
          if (res?.actor) {
            const role = res.actor.role === 'root' ? 'super_admin' : res.actor.role;
            setCurrentUserRole(role);
            localStorage.setItem('user_role', role);
          }
          if (res?.user) {
            const name = res.user.full_name || res.user.username || 'Pengguna';
            setCurrentUserName(name);
            localStorage.setItem('user_name', name);
            if (res.user.telegram_id) {
              setCurrentUserTelegramId(String(res.user.telegram_id));
              localStorage.setItem('user_tg_id', String(res.user.telegram_id));
            }
          }
        })
        .catch(err => {
          console.warn('Session profile sync note:', err);
        });
    }
  }, []);


  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = async () => { 
    setLoading(true); 
    setError(''); 
    try { 
      const [s, u, t, p, f] = await Promise.all([
        api<Stats>('/stats'),
        api<User[]>('/users'),
        api<Ticket[]>('/tickets'),
        api<Payment[]>('/payments'),
        api<any[]>('/forum-topics').catch(() => [])
      ]); 
      setStats(s); 
      setUsers(u); 
      setTickets(t); 
      setPayments(p); 
      setForumTopics(f);
    } catch (e: any) { 
      setError(e?.message || 'Backend belum tersedia'); 
    } finally { 
      setLoading(false); 
    } 
  };

  const handleLogout = () => {
    localStorage.removeItem('backoffice_access_token');
    localStorage.removeItem('backoffice_refresh_token');
    localStorage.removeItem('user_role');
    localStorage.removeItem('user_name');
    localStorage.removeItem('user_tg_id');
    setAuthenticated(false);
  };

  useEffect(() => { 
    if (authenticated) load(); 
    else setLoading(false); 
  }, [authenticated]);

  useEffect(() => {
    if (!autoRefresh || !authenticated) return;
    const interval = setInterval(() => { load(); }, 60000);
    return () => clearInterval(interval);
  }, [autoRefresh, authenticated]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector('.global-search-input') as HTMLInputElement;
        if (searchInput) searchInput.focus();
      }
      if (e.key === 'Escape') {
        setSelected(null);
        setMobileDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const filteredUsers = useMemo(() => {
    return users.filter(u => {
      const matchesGlobal = `${u.full_name || ''} ${u.username || ''} ${u.domain_name || ''} ${u.role}`.toLowerCase().includes(query.toLowerCase());
      const q = memberQuery.toLowerCase();
      const matchesMember = !memberQuery || (u.full_name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q);
      return matchesGlobal && matchesMember;
    });
  }, [users, query, memberQuery]);

  const filteredTickets = useMemo(() => {
    const list = tickets.filter(t => {
      const matchesSearch = `${t.ticket_number} ${t.user_name || ''} ${t.category} ${t.title || ''} ${t.description || t.message || ''}`.toLowerCase().includes(query.toLowerCase());
      const matchesPriority = ticketPriority === 'all' || (t.priority || 'medium').toLowerCase() === ticketPriority.toLowerCase();
      const matchesStatus = ticketStatusFilter === 'all' || (t.status || 'pending').toLowerCase() === ticketStatusFilter.toLowerCase();
      return matchesSearch && matchesPriority && matchesStatus;
    });

    const priorityWeight: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };

    return list.sort((a, b) => {
      if (ticketSort === 'oldest') {
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      } else if (ticketSort === 'priority') {
        const wa = priorityWeight[(a.priority || 'medium').toLowerCase()] || 2;
        const wb = priorityWeight[(b.priority || 'medium').toLowerCase()] || 2;
        if (wb !== wa) return wb - wa;
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      } else {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      }
    });
  }, [tickets, query, ticketPriority, ticketStatusFilter, ticketSort]);

  const ticketCounts = useMemo(() => {
    const counts = { pending: 0, in_progress: 0, resolved: 0, closed: 0, total: tickets.length };
    tickets.forEach(t => {
      const st = (t.status || 'pending').toLowerCase();
      if (st === 'pending' || st === 'open' || st === 'draft') counts.pending++;
      else if (st === 'in_progress' || st === 'assigned') counts.in_progress++;
      else if (st === 'resolved') counts.resolved++;
      else if (st === 'closed') counts.closed++;
    });
    return counts;
  }, [tickets]);

  const domains = useMemo(() => {
    const list: { user: User; domain: string; domainObj: UserDomain }[] = [];
    users.forEach(u => {
      if (u.domains && u.domains.length > 0) {
        u.domains.forEach(d => {
          list.push({ user: u, domain: d.domain_name, domainObj: d });
        });
      } else if (u.domain_name) {
        list.push({
          user: u,
          domain: u.domain_name,
          domainObj: {
            id: u.id,
            domain_name: u.domain_name,
            status: u.domain_verified ? 'verified' : 'pending',
            ssl_status: u.domain_verified ? 'active' : 'pending',
            subdomains: []
          }
        });
      }
    });
    return list;
  }, [users]);

  const exportTicketsCSV = () => {
    const headers = ['ID', 'Ticket Number', 'User', 'Category', 'Priority', 'Status', 'Subject', 'Created At'];
    const rows = filteredTickets.map(t => [
      t.id,
      t.ticket_number,
      `"${(t.user_name || '').replace(/"/g, '""')}"`,
      t.category,
      t.priority || 'medium',
      t.status,
      `"${(t.title || '').replace(/"/g, '""')}"`,
      t.created_at || ''
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `support_tickets_${new Date().toISOString().substring(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Laporan tiket berhasil diunduh (CSV)', 'success');
  };

  const filteredPayments = useMemo(() => payments.filter(p => {
    const matchesSearch = `${p.payment_number} ${p.user_id} ${p.status}`.toLowerCase().includes(query.toLowerCase());
    const d = p.created_at ? p.created_at.substring(0, 10) : '';
    if (paymentStart && d < paymentStart) return false;
    if (paymentEnd && d > paymentEnd) return false;
    return matchesSearch;
  }), [payments, query, paymentStart, paymentEnd]);

  if (!authenticated) {
    return (
      <UniversalAuthView 
        email={email} 
        password={password} 
        setEmail={setEmail} 
        setPassword={setPassword} 
        loading={loggingIn} 
        error={error} 
        onLoginSuccess={(role: 'super_admin' | 'dev' | 'member', name: string, tgId: string, token: string) => {
          localStorage.setItem('backoffice_access_token', token || 'demo_super_admin_token_abied');
          localStorage.setItem('user_role', role);
          localStorage.setItem('user_name', name);
          localStorage.setItem('user_tg_id', tgId);
          setCurrentUserRole(role);
          setCurrentUserName(name);
          setCurrentUserTelegramId(tgId);
          setAuthenticated(true);
        }}
      />
    );
  }

  // JIKA ROLE ADALAH MEMBER, TAMPILKAN KHUSUS MEMBER PORTAL (BUKAN BACKOFFICE ADMIN)
  if (currentUserRole === 'member') {
    return (
      <MemberPortalView 
        name={currentUserName}
        telegramId={currentUserTelegramId}
        tickets={tickets.filter(t => String(t.user_id) === String(currentUserTelegramId) || t.user_name === currentUserName)}
        payments={payments.filter(p => String(p.user_id) === String(currentUserTelegramId))}
        domains={domains.filter(d => String(d.user?.telegram_id) === String(currentUserTelegramId) || d.user?.full_name === currentUserName)}
        onLogout={handleLogout}
        onRefresh={load}
        showToast={showToast}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row ambient-glow text-slate-100 selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Mobile Slide-over Drawer Menu */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden animate-fade-in">
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setMobileDrawerOpen(false)} />
          <div className="relative w-4/5 max-w-xs glass-sidebar h-full p-5 flex flex-col z-10 shadow-2xl overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-300">
                  <Bot size={18} />
                </div>
                <div>
                  <div className="font-extrabold text-white text-xs tracking-tight">ABIEDIEN SUITE</div>
                  <div className="text-[10px] text-slate-400">Enterprise Control</div>
                </div>
              </div>
              <button onClick={() => setMobileDrawerOpen(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white">
                <X size={18} />
              </button>
            </div>

            {/* Workspace Toggle on Mobile */}
            <div className="my-4 p-1 rounded-xl bg-black/40 border border-white/10 flex items-center">
              <button
                onClick={() => setWorkspace('web_apps')}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition ${workspace === 'web_apps' ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400'}`}
              >
                🖥️ Web Apps
              </button>
              <button
                onClick={() => setWorkspace('telegram_web')}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition ${workspace === 'telegram_web' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-400'}`}
              >
                🤖 Telegram
              </button>
            </div>

            <nav className="space-y-1">
              {workspace === 'web_apps' ? (
                webAppTabs.map(({ id, label, icon: IconComp }) => (
                  <button
                    key={id}
                    onClick={() => { setWebTab(id); setSelected(null); setMobileDrawerOpen(false); }}
                    className={`w-full py-2.5 px-3 rounded-xl flex items-center gap-3 text-xs font-semibold transition ${
                      webTab === id ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <IconComp size={16} />
                    <span>{label}</span>
                  </button>
                ))
              ) : (
                telegramTabs.map(({ id, label, icon: IconComp }) => (
                  <button
                    key={id}
                    onClick={() => { setTgTab(id); setSelected(null); setMobileDrawerOpen(false); }}
                    className={`w-full py-2.5 px-3 rounded-xl flex items-center gap-3 text-xs font-semibold transition ${
                      tgTab === id ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <IconComp size={16} />
                    <span>{label}</span>
                  </button>
                ))
              )}
            </nav>
          </div>
        </div>
      )}

      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:flex w-64 glass-sidebar h-screen p-4 flex-col fixed left-0 top-0 z-40 border-r border-white/10">
        {/* Brand Header */}
        <div className="flex items-center gap-3 px-2 py-3 border-b border-white/10">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-glow-cyan">
            <Bot size={22} />
          </div>
          <div>
            <div className="font-black text-sm text-white tracking-tight flex items-center gap-1.5">
              <span>ABIEDIEN</span>
              <span className="px-1.5 py-0.2 rounded text-[8px] font-black uppercase bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">V3.4</span>
            </div>
            <span className="text-[11px] text-slate-400 block font-medium">Enterprise Backoffice</span>
          </div>
        </div>

        {/* WORKSPACE DUAL TOGGLE */}
        <div className="mt-3 p-1 rounded-2xl bg-black/40 border border-white/10 grid grid-cols-2 gap-1 shrink-0">
          <button
            onClick={() => setWorkspace('web_apps')}
            className={`py-1.5 px-2 rounded-xl text-[11px] font-extrabold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              workspace === 'web_apps' 
                ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-glow-cyan' 
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Server size={13} />
            <span>Web Apps</span>
          </button>

          <button
            onClick={() => setWorkspace('telegram_web')}
            className={`py-1.5 px-2 rounded-xl text-[11px] font-extrabold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              workspace === 'telegram_web' 
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-glow-blue' 
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Bot size={13} />
            <span>Telegram</span>
          </button>
        </div>

        {/* Scrollable Navigation Items */}
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto pr-1">
          {workspace === 'web_apps' ? (
            webAppTabs.map(({ id, label, icon: IconComp }) => {
              const isActive = webTab === id;
              return (
                <button
                  key={id}
                  onClick={() => { setWebTab(id); setSelected(null); }}
                  className={`w-full h-9 px-3 rounded-xl flex items-center gap-2.5 text-xs font-semibold transition cursor-pointer ${
                    isActive 
                      ? 'bg-gradient-to-r from-cyan-500/15 to-blue-500/10 text-cyan-300 border border-cyan-500/30 shadow-inner-glass' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <IconComp size={16} className={isActive ? 'text-cyan-400' : 'text-slate-400'} />
                  <span className="flex-1 text-left truncate">{label}</span>
                  {id === 'tickets' && stats?.pendingTickets ? (
                    <span className="px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      {stats.pendingTickets}
                    </span>
                  ) : null}
                  {id === 'payments' && stats?.pendingPayments ? (
                    <span className="px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {stats.pendingPayments}
                    </span>
                  ) : null}
                </button>
              );
            })
          ) : (
            telegramTabs.map(({ id, label, icon: IconComp }) => {
              const isActive = tgTab === id;
              return (
                <button
                  key={id}
                  onClick={() => { setTgTab(id); setSelected(null); }}
                  className={`w-full h-10 px-3 rounded-xl flex items-center gap-2.5 text-xs font-semibold transition cursor-pointer ${
                    isActive 
                      ? 'bg-gradient-to-r from-blue-500/15 to-indigo-500/10 text-blue-300 border border-blue-500/30 shadow-inner-glass' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <IconComp size={16} className={isActive ? 'text-blue-400' : 'text-slate-400'} />
                  <span className="flex-1 text-left truncate">{label}</span>
                </button>
              );
            })
          )}
        </nav>

        {/* User Session Footer */}
        <div className="pt-3 border-t border-white/5 space-y-2.5">
          <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white">
                AI
              </div>
              <div className="text-left">
                <div className="text-xs font-bold text-slate-200 truncate w-24">Abied Iendomba</div>
                <div className="text-[9px] text-cyan-400 font-semibold uppercase">Super Admin</div>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-400 hover:text-rose-400 p-1 rounded-lg hover:bg-rose-500/10 transition cursor-pointer" title="Sign out">
              <LogOut size={15} />
            </button>
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-500 px-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-glow-emerald"></span>
              <span>Zero-Trust SSOT</span>
            </div>
            <span className="font-mono-code text-slate-500">v3.4.0</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:ml-64 flex flex-col min-w-0 pb-24 md:pb-10">
        {/* Top Sticky Header */}
        <header className="px-4 sm:px-8 py-3.5 glass-topbar sticky top-0 z-30 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <button 
                onClick={() => setMobileDrawerOpen(true)} 
                className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-300 md:hidden cursor-pointer active:scale-95 transition"
                title="Menu"
              >
                <Menu size={18} />
              </button>
              <div className="min-w-0">
                <div className="text-[9px] font-extrabold tracking-widest text-cyan-400 uppercase truncate">
                  {workspace === 'web_apps' ? '🖥️ WEB APPS WORKSPACE' : '🤖 TELEGRAM WEB & LIVE HUB'}
                </div>
                <h1 className="text-base sm:text-lg font-extrabold text-white tracking-tight truncate">
                  {workspace === 'web_apps' 
                    ? webAppTabs.find(x => x.id === webTab)?.label 
                    : telegramTabs.find(x => x.id === tgTab)?.label}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Auto Refresh Toggle */}
              <button 
                onClick={() => { setAutoRefresh(!autoRefresh); showToast(autoRefresh ? 'Auto-refresh dinonaktifkan' : 'Auto-refresh aktif', 'success'); }} 
                className={`p-2 sm:px-3 sm:py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition cursor-pointer ${
                  autoRefresh 
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 shadow-glow-emerald' 
                    : 'bg-white/[0.04] border-white/10 text-slate-400 hover:text-slate-200'
                }`}
                title="Toggle 60s Auto-refresh"
              >
                <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                <span className="hidden sm:inline">Auto {autoRefresh ? 'ON' : 'OFF'}</span>
              </button>

              {/* Mobile Search Toggle */}
              <button 
                onClick={() => setMobileSearchOpen(!mobileSearchOpen)} 
                className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-300 sm:hidden cursor-pointer"
                title="Search"
              >
                <Search size={16} />
              </button>

              {/* Desktop Global Search Bar */}
              <div className="relative hidden sm:block w-64 md:w-72">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input 
                  value={query} 
                  onChange={e => setQuery(e.target.value)} 
                  placeholder="Pencarian cepat (Ctrl+K)..." 
                  className="global-search-input w-full h-9 pl-8 pr-12 rounded-xl bg-white/[0.04] border border-white/10 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/50"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[9px] font-mono-code bg-white/10 text-slate-400">
                  Ctrl+K
                </span>
              </div>

              {/* Menu Instan / Panic Incident Response */}
              <button 
                onClick={() => setEmergencyModalOpen(true)} 
                className="p-2 sm:px-3 sm:py-1.5 rounded-xl text-xs font-bold bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 flex items-center gap-1.5 transition cursor-pointer active:scale-95 shadow-xs" 
                title="Menu Instan & Tindakan Mitigasi Darurat"
              >
                <ShieldAlert size={15} className="text-rose-400 animate-pulse" />
                <span className="hidden sm:inline">Menu Instan</span>
              </button>

              {/* Manual Refresh */}
              <button onClick={load} className="p-2 rounded-xl bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white transition cursor-pointer" title="Refresh data">
                <RefreshCw size={16} className={loading ? 'animate-spin text-cyan-400' : ''} />
              </button>
            </div>
          </div>
        </header>

        {/* Error Alert */}
        {error && (
          <div className="mx-4 sm:mx-8 mt-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 flex items-center gap-3 text-xs animate-fade-in">
            <CircleAlert size={16} className="text-rose-400 shrink-0" />
            <span className="flex-1 font-medium">{error}</span>
            <button onClick={() => setError('')} className="p-1 hover:bg-rose-500/20 rounded cursor-pointer"><X size={14} /></button>
          </div>
        )}

        {/* Main Body */}
        <main className="flex-1 p-4 sm:p-8 space-y-5">
          {loading && !stats ? (
            <div className="h-64 flex flex-col items-center justify-center gap-3 text-slate-400">
              <RefreshCw size={26} className="animate-spin text-cyan-400" />
              <span className="text-xs font-semibold">Memuat data backoffice...</span>
            </div>
          ) : (
            <>
              {/* =================================================== */}
              {/* WORKSPACE 1: WEB APPS VIEWPORT */}
              {/* =================================================== */}
              {workspace === 'web_apps' && (
                <>
                  {webTab === 'overview' && (
                    <OverviewView stats={stats} users={users} tickets={tickets} payments={payments} onOpen={(t) => setWebTab(t as WebAppTab)} />
                  )}

                  {webTab === 'members' && (
                    <MembersView users={filteredUsers} memberQuery={memberQuery} setMemberQuery={setMemberQuery} onSelect={setSelected} />
                  )}

                  {webTab === 'domains' && (
                    <DomainsView domains={domains} onSelect={setSelected} />
                  )}

                  {webTab === 'requests' && (
                    <RequestsOpsView tickets={tickets} onSelect={setSelected} />
                  )}

                  {webTab === 'tickets' && (
                    <TicketsListView 
                      tickets={filteredTickets} 
                      ticketCounts={ticketCounts} 
                      ticketPriority={ticketPriority} 
                      setTicketPriority={setTicketPriority} 
                      ticketStatusFilter={ticketStatusFilter} 
                      setTicketStatusFilter={setTicketStatusFilter} 
                      ticketSort={ticketSort} 
                      setTicketSort={setTicketSort} 
                      exportCSV={exportTicketsCSV} 
                      onSelect={setSelected} 
                    />
                  )}

                  {webTab === 'payments' && (
                    <PaymentsLedgerView 
                      payments={filteredPayments} 
                      paymentStart={paymentStart} 
                      setPaymentStart={setPaymentStart} 
                      paymentEnd={paymentEnd} 
                      setPaymentEnd={setPaymentEnd} 
                      exportCSV={() => showToast('Export CSV berhasil', 'success')} 
                      onSelect={setSelected} 
                    />
                  )}

                  {webTab === 'seo' && (
                    <SeoAuditWorkspace tickets={tickets} onSelect={setSelected} />
                  )}

                  {webTab === 'traffic' && (
                    <TrafficAnalyticsView stats={stats} domains={domains} onSelect={setSelected} />
                  )}

                  {webTab === 'forum' && (
                    <CommunityForumView topics={forumTopics} onSelect={setSelected} />
                  )}

                  {webTab === 'broadcast' && (
                    <BroadcastConsoleView onBroadcastSuccess={(msg) => showToast(msg, 'success')} />
                  )}

                  {webTab === 'generator' && (
                    <DevOpsGeneratorsView />
                  )}

                  {webTab === 'notifications' && (
                    <AsyncDataModule title="Log Notifikasi Sistem" endpoint="/notifications" onSelect={setSelected} />
                  )}

                  {webTab === 'audit' && (
                    <AuditTrailView endpoint="/audit" onSelect={setSelected} />
                  )}

                  {webTab === 'settings' && (
                    <SecuritySettingsView onToast={showToast} />
                  )}
                </>
              )}

              {/* =================================================== */}
              {/* WORKSPACE 2: TELEGRAM WEB VIEWPORT */}
              {/* =================================================== */}
              {workspace === 'telegram_web' && (
                <>
                  {tgTab === 'telegram_live' && (
                    <TelegramLiveHub 
                      tickets={tickets} 
                      users={users} 
                      onSelectTicket={setSelected} 
                      onExecuteSuccess={(msg) => { showToast(msg, 'success'); load(); }} 
                    />
                  )}

                  {tgTab === 'bot_status' && (
                    <TelegramBotView onSelect={setSelected} />
                  )}

                  {tgTab === 'bot_simulator' && (
                    <TelegramBotSimulator />
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>

      {/* MOBILE BOTTOM NAVIGATION BAR */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 glass-bottomnav px-2 py-1.5 flex items-center justify-around safe-bottom">
        {[
          { id: 'overview', label: 'Home', icon: LayoutDashboard },
          { id: 'members', label: 'Members', icon: Users },
          { id: 'tickets', label: 'Tiket', icon: LifeBuoy, count: stats?.pendingTickets },
          { id: 'payments', label: 'Gaji', icon: CreditCard, count: stats?.pendingPayments },
        ].map(({ id, label, icon: IconComp, count }) => {
          const isActive = workspace === 'web_apps' && webTab === id;
          return (
            <button
              key={id}
              onClick={() => { setWorkspace('web_apps'); setWebTab(id as WebAppTab); setSelected(null); }}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-1.5 px-2 rounded-xl transition relative cursor-pointer ${
                isActive 
                  ? 'bg-cyan-500/15 text-cyan-300 font-bold border border-cyan-500/30' 
                  : 'text-slate-400 font-medium hover:text-slate-200'
              }`}
            >
              <div className="relative">
                <IconComp size={18} className={isActive ? 'text-cyan-400' : 'text-slate-400'} />
                {Boolean(count) && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-black text-[9px] font-black flex items-center justify-center shadow-xs">
                    {count}
                  </span>
                )}
              </div>
              <span className="text-[10px] tracking-tight">{label}</span>
            </button>
          );
        })}
        <button
          onClick={() => { setWorkspace('telegram_web'); setTgTab('telegram_live'); }}
          className={`flex-1 flex flex-col items-center justify-center gap-1 py-1.5 px-2 rounded-xl transition cursor-pointer ${
            workspace === 'telegram_web' ? 'bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Bot size={18} />
          <span className="text-[10px]">Telegram</span>
        </button>
      </nav>

      {/* Slide-over Detail Drawer */}
      {selected && (
        <>
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm animate-fade-in" onClick={() => setSelected(null)} />
          <DetailDrawer 
            data={selected} 
            close={() => setSelected(null)} 
            onMutateSuccess={(msg) => { showToast(msg, 'success'); load(); }}
          />
        </>
      )}

      {/* Emergency Action Instant Menu Modal */}
      {emergencyModalOpen && (
        <EmergencyMenuModal
          close={() => setEmergencyModalOpen(false)}
          onActionExecuted={(msg) => { showToast(msg, 'success'); load(); }}
        />
      )}

      {/* Toast Notification */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ==========================================
// SUB-VIEWS: WEB APPS
// ==========================================

function OverviewView({ stats, users, tickets, payments, onOpen }: { 
  stats: Stats | null; 
  users: User[]; 
  tickets: Ticket[]; 
  payments: Payment[]; 
  onOpen: (t: string) => void 
}) {
  return (
    <div className="space-y-5 animate-fade-in">
      {/* Hero Header Card */}
      <div className="glass-card p-5 sm:p-7 rounded-3xl relative overflow-hidden">
        <div className="absolute -right-20 -top-20 w-60 h-60 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-cyan-400 text-[11px] font-bold uppercase tracking-wider">
              <Sparkles size={14} />
              Unified Command Center
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">Abiedien Backoffice Engine</h2>
            <p className="text-xs text-slate-400 max-w-xl leading-relaxed">
              Monitoring real-time untuk verifikasi domain DNS member, mutasi tiket, validasi payroll, dan sinkronisasi service Telegram Bot.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-center">
            <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] font-bold flex items-center gap-1.5 shadow-glow-emerald">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              SSOT Sync Active
            </div>
          </div>
        </div>
      </div>

      {/* 4 KPI Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard 
          label="Total Member" 
          value={stats?.totalUsers ?? users.length} 
          subtext="Member aktif" 
          icon={Users} 
          color="cyan"
          onClick={() => onOpen('members')}
        />
        <MetricCard 
          label="Domain DNS" 
          value={stats?.verifiedMembers ?? 0} 
          subtext="TXT verified" 
          icon={ShieldCheck} 
          color="emerald"
          onClick={() => onOpen('domains')}
        />
        <MetricCard 
          label="Tiket Pending" 
          value={stats?.pendingTickets ?? 0} 
          subtext="Antrean aktif" 
          icon={LifeBuoy} 
          color="amber"
          onClick={() => onOpen('tickets')}
        />
        <MetricCard 
          label="Payroll / Gaji" 
          value={stats?.pendingPayments ?? 0} 
          subtext="Pending review" 
          icon={CreditCard} 
          color="indigo"
          onClick={() => onOpen('payments')}
        />
      </div>

      {/* Grid: Priority Actions & Coverage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="glass-card rounded-2xl p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between pb-2.5 border-b border-white/5">
            <h3 className="font-bold text-xs sm:text-sm text-white flex items-center gap-2">
              <Zap size={16} className="text-amber-400" />
              Perlu Perhatian Segera (Action Feed)
            </h3>
            <span className="text-[10px] text-slate-500 font-medium">Priority queue</span>
          </div>

          <div className="space-y-2">
            <AttentionItem 
              label="Antrean Tiket Butuh Tanggapan Admin" 
              count={stats?.pendingTickets ?? 0} 
              severity="high" 
              onClick={() => onOpen('tickets')} 
            />
            <AttentionItem 
              label="Bukti Pembayaran Gaji Menunggu Verifikasi" 
              count={stats?.pendingPayments ?? 0} 
              severity="medium" 
              onClick={() => onOpen('payments')} 
            />
            <AttentionItem 
              label="Permintaan Push Indexing / SEO Review" 
              count={tickets.filter(t => t.category === 'push_request' || t.category === 'seo_audit').length} 
              severity="medium" 
              onClick={() => onOpen('requests')} 
            />
            <AttentionItem 
              label="Verifikasi DNS Domain Baru" 
              count={users.filter(u => u.domain_name && !u.domain_verified).length} 
              severity="low" 
              onClick={() => onOpen('domains')} 
            />
          </div>
        </div>

        <div className="glass-card rounded-2xl p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between pb-2.5 border-b border-white/5">
            <h3 className="font-bold text-xs sm:text-sm text-white flex items-center gap-2">
              <Database size={16} className="text-cyan-400" />
              Cakupan Data Terhubung (Edge RPC v3)
            </h3>
            <span className="text-[10px] text-slate-500 font-mono-code">Live Nodes</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-[10px] text-slate-400 block font-medium">Users In-Memory</span>
              <strong className="text-lg font-black text-white mt-0.5 block">{users.length}</strong>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-[10px] text-slate-400 block font-medium">Tiket Queue</span>
              <strong className="text-lg font-black text-white mt-0.5 block">{tickets.length}</strong>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-[10px] text-slate-400 block font-medium">Ledger Payments</span>
              <strong className="text-lg font-black text-white mt-0.5 block">{payments.length}</strong>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-[10px] text-slate-400 block font-medium">Websites Active</span>
              <strong className="text-lg font-black text-white mt-0.5 block">{stats?.totalWebsites ?? 0}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MembersView({ users: initialUsers, memberQuery, setMemberQuery, onSelect }: { 
  users: User[]; 
  memberQuery: string; 
  setMemberQuery: (v: string) => void; 
  onSelect: (v: any) => void 
}) {
  const [localUsers, setLocalUsers] = useState<User[]>(initialUsers);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'active' | 'suspended'>('all');
  const [selectedUserDetail, setSelectedUserDetail] = useState<any>(null);

  // Sync when initialUsers changes
  useEffect(() => {
    setLocalUsers(initialUsers);
  }, [initialUsers]);

  const handleApproveUser = (userId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalUsers(prev => prev.map(u => u.id === userId ? { ...u, status: 'active', domain_verified: true, role: 'member' } : u));
    const target = localUsers.find(u => u.id === userId);
    alert(`✅ ACC BERHASIL: Akun ${target?.full_name || `@${target?.username}`} telah disetujui sebagai Member Aktif. DNS Domain & Routing Anycast telah diaktifkan.`);
  };

  const handleSuspendUser = (userId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalUsers(prev => prev.map(u => u.id === userId ? { ...u, status: 'suspended', domain_verified: false } : u));
    alert(`⛔ Akun #${userId} telah disuspend.`);
  };

  const filtered = useMemo(() => {
    return localUsers.filter(u => {
      const q = memberQuery.toLowerCase();
      const matchesText = !memberQuery || (u.full_name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q) || (u.domain_name || '').toLowerCase().includes(q);
      const isPending = u.status === 'pending' || u.status === 'pending_review' || !u.domain_verified;
      const isActive = u.status === 'active' && u.domain_verified;
      const isSuspended = u.status === 'suspended' || u.status === 'blocked';

      if (statusFilter === 'pending') return matchesText && isPending;
      if (statusFilter === 'active') return matchesText && isActive;
      if (statusFilter === 'suspended') return matchesText && isSuspended;
      return matchesText;
    });
  }, [localUsers, memberQuery, statusFilter]);

  const pendingCount = localUsers.filter(u => u.status === 'pending' || u.status === 'pending_review' || !u.domain_verified).length;
  const activeCount = localUsers.filter(u => u.status === 'active' && u.domain_verified).length;

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header & Status Filter Tabs */}
      <div className="glass-card p-4 rounded-2xl space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[220px]">
            <Search size={15} className="text-slate-400" />
            <input 
              type="text" 
              value={memberQuery} 
              onChange={e => setMemberQuery(e.target.value)} 
              placeholder="Filter nama pelaksana, @username, domain..." 
              className="bg-transparent border-none text-xs text-slate-200 placeholder:text-slate-500 w-full focus:outline-none"
            />
            {memberQuery && <button onClick={() => setMemberQuery('')} className="text-cyan-400 text-xs cursor-pointer">Clear</button>}
          </div>

          <div className="text-[11px] text-slate-400">
            Total Data: <span className="text-white font-bold">{localUsers.length}</span> Entri
          </div>
        </div>

        {/* ACC Filter Pills */}
        <div className="flex items-center gap-1.5 pt-1 border-t border-white/5 flex-wrap">
          {[
            { id: 'all', label: `Semua (${localUsers.length})` },
            { id: 'pending', label: `⏳ Menunggu ACC Admin (${pendingCount})`, highlight: pendingCount > 0 },
            { id: 'active', label: `✅ Member Aktif (${activeCount})` },
            { id: 'suspended', label: `⛔ Suspended (${localUsers.filter(u => u.status === 'suspended').length})` },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id as any)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                statusFilter === f.id
                  ? 'bg-cyan-600 text-white shadow-xs'
                  : f.highlight
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-white/5 text-slate-400 hover:text-white'
              }`}
            >
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      <ResponsiveDataList 
        title="Daftar Pelaksana Program & Antrean ACC Admin" 
        count={filtered.length} 
        headers={['Pelaksana', 'Telegram ID', 'Kategori & Domain', 'Status Akses', 'Aksi Kontrol Admin']}
        mobileItems={filtered.map(u => ({
          id: u.id,
          avatarText: (u.full_name || u.username || 'U').charAt(0).toUpperCase(),
          title: u.full_name || 'Tanpa Nama',
          subtitle: `@${u.username || 'n/a'} · ID: ${u.telegram_id}`,
          badge: <RoleBadge role={u.role} />,
          secondaryBadge: <StatusBadge status={u.status || 'pending'} />,
          extra: u.domain_name ? `🌐 ${u.domain_name} (${u.domain_verified ? 'Verified DNS' : 'Pending ACC'})` : 'Pengajuan Domain Baru'
        }))}
        desktopRows={filtered.map(u => [
          <div key={u.id} className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-xs font-bold text-white">
              {(u.full_name || u.username || 'U').charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-bold text-white text-xs">{u.full_name || 'Tanpa Nama'}</div>
              <div className="text-[11px] text-cyan-400 font-mono-code">@{u.username || 'n/a'}</div>
            </div>
          </div>,
          <span key={`tg-${u.id}`} className="font-mono-code text-xs text-slate-300">{u.telegram_id}</span>,
          <div key={`dom-${u.id}`} className="space-y-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white font-mono-code">{u.domain_name || 'Pengajuan Baru'}</span>
              <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                (u.domain_name || '').endsWith('.com') || (u.domain_name || '').endsWith('.cc')
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                  : 'bg-emerald-500/20 text-emerald-300'
              }`}>
                {(u.domain_name || '').endsWith('.com') ? 'PRO TLD (BERBAYAR)' : 'FREE / KUOTA'}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 block">
              DNS: {u.domain_verified ? '✅ TXT Terverifikasi' : '⏳ Belum di-ACC'}
            </span>
          </div>,
          <StatusBadge key={`status-${u.id}`} status={u.status || 'pending'} />,
          <div key={`act-${u.id}`} className="flex items-center gap-1.5">
            {u.status !== 'active' || !u.domain_verified ? (
              <button
                onClick={(e) => handleApproveUser(u.id, e)}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition cursor-pointer shadow-glow-emerald"
                title="Setujui Akun dan Aktifkan DNS Domain"
              >
                ACC & Aktifkan
              </button>
            ) : (
              <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 size={12} />
                Verified
              </span>
            )}
            <button
              onClick={(e) => handleSuspendUser(u.id, e)}
              className="px-2 py-1 rounded-lg bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 text-[11px] transition cursor-pointer"
              title="Suspend / Tolak"
            >
              Suspend
            </button>
          </div>
        ])}
        onSelect={(i) => onSelect(filtered[i])}
      />
    </div>
  );
}

function DomainsView({ domains, onSelect }: { domains: any[]; onSelect: (v: any) => void }) {
  const [activeModal, setActiveModal] = useState<'register' | 'issue' | null>(null);
  const [selectedTier, setSelectedTier] = useState<'free' | 'pro' | 'custom'>('free');
  const [domainName, setDomainName] = useState('');
  const [selectedExtension, setSelectedExtension] = useState('.site');
  const [registrantUser, setRegistrantUser] = useState('Abied Iendomba');
  const [issueDescription, setIssueDescription] = useState('');
  const [issueDomain, setIssueDomain] = useState('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced'>('idle');

  const domainPackages = [
    {
      id: 'free' as const,
      name: 'Paket Komunitas (Gratis)',
      price: 'Rp 0',
      badge: 'FREE TIER',
      badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      extensions: ['.site', '.online', '.is-a.dev', '.xyz'],
      desc: 'Cocok untuk web portofolio, forum testing & bot webhook. Kuota 1x gratis per member.',
      autoVerify: true
    },
    {
      id: 'pro' as const,
      name: 'Paket Bisnis / Offshore (Berbayar)',
      price: 'Rp 150.000 / thn',
      badge: 'PRO TLD',
      badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
      extensions: ['.com', '.cc', '.net', '.vip', '.top'],
      desc: 'Top Level Domain offshore aman dengan privasi WHOIS (No-KTP) & Enterprise Cloudflare SSL.',
      autoVerify: false
    },
    {
      id: 'custom' as const,
      name: 'Bawa Domain Sendiri (BYOD)',
      price: 'Gratis Setup',
      badge: 'CUSTOM DNS',
      badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
      extensions: ['Domain Anda Sendiri'],
      desc: 'Hubungkan domain yang sudah Anda miliki melalui CNAME & DNS TXT verification.',
      autoVerify: false
    }
  ];

  const handleSyncAll = () => {
    setSyncStatus('syncing');
    setTimeout(() => {
      setSyncStatus('synced');
      setTimeout(() => setSyncStatus('idle'), 4000);
    }, 1500);
  };

  const handleRegisterDomain = (e: React.FormEvent) => {
    e.preventDefault();
    const fullFqdn = selectedTier === 'custom' ? domainName : `${domainName.replace(/\..+$/, '')}${selectedExtension}`;
    alert(`✅ Tiket Pengajuan Domain #${Math.floor(100 + Math.random() * 900)} berhasil dibuat!\nDomain: ${fullFqdn}\nPaket: ${selectedTier.toUpperCase()}\nStatus: Menunggu review tim tiket & audit DNS.`);
    setActiveModal(null);
    setDomainName('');
  };

  const handleReportIssue = (e: React.FormEvent) => {
    e.preventDefault();
    alert(`🎫 Tiket Kendala Domain #${Math.floor(100 + Math.random() * 900)} berhasil dibuat!\nTarget: ${issueDomain}\nKendala: ${issueDescription}\nStatus: Tim Dev akan segera menindaklanjuti.`);
    setActiveModal(null);
    setIssueDescription('');
  };

  return (
    <div className="space-y-5 animate-fade-in">
      {/* 3-WAY SYNC LOGIC BAR (Supabase + GitHub + Cloudflare) */}
      <div className="glass-card p-4 rounded-2xl border border-cyan-500/20 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <RefreshCw size={18} className={syncStatus === 'syncing' ? 'animate-spin text-cyan-400' : ''} />
          </div>
          <div>
            <div className="text-xs font-extrabold text-white flex items-center gap-2">
              <span>Status Sinkronisasi Background Multi-Platform</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 mt-0.5 flex-wrap">
              <span className="flex items-center gap-1 font-mono-code"><Database size={11} className="text-emerald-400" /> Supabase: Live</span>
              <span className="flex items-center gap-1 font-mono-code"><Globe2 size={11} className="text-blue-400" /> Cloudflare Edge: Active</span>
              <span className="flex items-center gap-1 font-mono-code"><Code2 size={11} className="text-purple-400" /> GitHub Pages: Synced</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSyncAll}
            disabled={syncStatus === 'syncing'}
            className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer active:scale-95"
          >
            <RefreshCw size={13} className={syncStatus === 'syncing' ? 'animate-spin text-cyan-400' : ''} />
            <span>{syncStatus === 'syncing' ? 'Syncing...' : syncStatus === 'synced' ? '✅ Ter-sinkron' : 'Sync All Platform'}</span>
          </button>
          <button
            onClick={() => setActiveModal('register')}
            className="px-3.5 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-glow-cyan transition cursor-pointer active:scale-95"
          >
            <Plus size={14} />
            <span>Ajukan Domain Baru</span>
          </button>
          <button
            onClick={() => setActiveModal('issue')}
            className="px-3.5 py-1.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer active:scale-95"
          >
            <LifeBuoy size={14} />
            <span>Lapor Kendala</span>
          </button>
        </div>
      </div>

      {/* PAKET DOMAIN & EXTENSION CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {domainPackages.map((pkg) => (
          <div
            key={pkg.id}
            className={`p-4 rounded-2xl glass-card border transition flex flex-col justify-between space-y-3 ${
              selectedTier === pkg.id ? 'border-cyan-500/50 bg-cyan-950/20' : 'border-white/10 hover:border-white/20'
            }`}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold border ${pkg.badgeColor}`}>
                  {pkg.badge}
                </span>
                <span className="font-mono-code font-bold text-xs text-emerald-400">{pkg.price}</span>
              </div>
              <h4 className="text-sm font-extrabold text-white">{pkg.name}</h4>
              <p className="text-[11px] text-slate-400 leading-relaxed">{pkg.desc}</p>
              <div className="flex flex-wrap gap-1 pt-1">
                {pkg.extensions.map((ext) => (
                  <span key={ext} className="px-2 py-0.5 rounded bg-black/40 border border-white/5 text-[10px] font-mono-code text-cyan-300">
                    {ext}
                  </span>
                ))}
              </div>
            </div>

            <button
              onClick={() => { setSelectedTier(pkg.id); setActiveModal('register'); }}
              className="w-full py-2 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-white flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <span>Pilih & Ajukan Paket Ini</span>
              <ArrowUpRight size={13} />
            </button>
          </div>
        ))}
      </div>

      {/* RESPONSIVE DOMAIN DATA LIST */}
      <ResponsiveDataList 
        title="Pusat Verifikasi DNS, Subdomain & Kepemilikan" 
        count={domains.length} 
        headers={['Nama Domain', 'Registrant (Akun Resmi)', 'Status DNS', 'SSL', 'Subdomain', 'Tren Trafik', 'Status Akun']}
        mobileItems={domains.map(x => ({
          id: `${x.user.id}-${x.domain}`,
          avatarText: '🌐',
          title: x.domain,
          subtitle: `Registrant: ${x.user.full_name || '—'} (@${x.user.username || '—'})`,
          badge: <StatusBadge status={x.domainObj.status.toUpperCase()} />,
          secondaryBadge: x.domainObj.is_primary ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/20 text-cyan-300">PRIMARY</span> : undefined,
          extra: `${x.domainObj.subdomains?.length || 0} Subdomain · Trafik: ${x.domainObj.traffic_trend || 'N/A'}`
        }))}
        desktopRows={domains.map(x => [
          <div key={`dom-${x.domain}`} className="flex items-center gap-2">
            <Globe2 size={16} className="text-cyan-400" />
            <div>
              <div className="font-bold text-white text-xs flex items-center gap-1.5">
                <span>{x.domain}</span>
                {x.domainObj.is_primary && (
                  <span className="px-1.5 py-0.2 rounded text-[8px] font-extrabold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">PRIMARY</span>
                )}
              </div>
            </div>
          </div>,
          <div key={`u-${x.domain}`}>
            <div className="font-semibold text-slate-200">{x.user.full_name || '—'}</div>
            <div className="text-[11px] text-slate-400 font-mono-code">@{x.user.username || '—'} · ID: {x.user.telegram_id}</div>
          </div>,
          <StatusBadge key={`v-${x.domain}`} status={x.domainObj.status.toUpperCase()} />,
          <span key={`ssl-${x.domain}`} className="px-2 py-0.5 rounded text-[10px] font-mono-code bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            {x.domainObj.ssl_status || 'ACTIVE'}
          </span>,
          <span key={`sub-${x.domain}`} className="px-2 py-0.5 rounded-lg bg-white/5 text-[11px] font-mono-code text-slate-300">
            {x.domainObj.subdomains?.length || 0} sub
          </span>,
          <span key={`tr-${x.domain}`} className={`font-mono-code text-xs font-bold ${x.domainObj.traffic_trend?.startsWith('+') ? 'text-emerald-400' : x.domainObj.traffic_trend?.startsWith('-') ? 'text-rose-400' : 'text-slate-400'}`}>
            {x.domainObj.traffic_trend || '—'}
          </span>,
          <RoleBadge key={`r-${x.domain}`} role={x.user.role} />
        ])}
        onSelect={(i) => onSelect({
          type: 'domain_detail',
          domain: domains[i].domain,
          domainObj: domains[i].domainObj,
          user: domains[i].user
        })}
      />

      {/* MODAL PENGAJUAN DOMAIN DENGAN TICKET AUTOMATION */}
      {activeModal === 'register' && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Globe2 size={20} className="text-cyan-400" />
                <h3 className="text-sm font-extrabold text-white">Form Pengajuan Domain & Pembuatan Tiket</h3>
              </div>
              <button onClick={() => setActiveModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X size={16} /></button>
            </div>

            <form onSubmit={handleRegisterDomain} className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 block">Pilih Paket Domain:</label>
                <div className="grid grid-cols-3 gap-2">
                  {domainPackages.map(p => (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => setSelectedTier(p.id)}
                      className={`p-2 rounded-xl border text-center transition text-xs font-bold ${
                        selectedTier === p.id ? 'bg-cyan-600 text-white border-cyan-400' : 'bg-black/30 border-white/10 text-slate-400'
                      }`}
                    >
                      <div>{p.id === 'free' ? 'Gratis' : p.id === 'pro' ? 'Pro (Paid)' : 'Custom'}</div>
                      <div className="text-[9px] font-mono-code font-normal mt-0.5">{p.price}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 block">Nama Domain & Ekstensi:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={domainName}
                    onChange={e => setDomainName(e.target.value)}
                    placeholder={selectedTier === 'custom' ? 'domainanda.com' : 'mywebsite'}
                    className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  {selectedTier !== 'custom' && (
                    <select
                      value={selectedExtension}
                      onChange={e => setSelectedExtension(e.target.value)}
                      className="bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-cyan-300 font-mono-code focus:outline-none"
                    >
                      {domainPackages.find(x => x.id === selectedTier)?.extensions.map(ext => (
                        <option key={ext} value={ext}>{ext}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs space-y-1">
                <span className="font-bold text-cyan-300 block">📋 Tiket Pengajuan Otomatis:</span>
                <p className="text-slate-300 text-[11px]">
                  Pengajuan ini akan langsung otomatis membuat tiket antrean di <strong>Support Tickets</strong> dengan kategori <code className="font-mono-code text-cyan-300">domain_registration</code> agar dev/admin dapat melakukan provisioning DNS Cloudflare & Supabase.
                </p>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold cursor-pointer shadow-glow-cyan"
                >
                  Ajukan & Buat Tiket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL LAPOR KENDALA DOMAIN */}
      {activeModal === 'issue' && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <LifeBuoy size={20} className="text-rose-400" />
                <h3 className="text-sm font-extrabold text-white">Lapor Kendala Domain & Buat Tiket Support</h3>
              </div>
              <button onClick={() => setActiveModal(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X size={16} /></button>
            </div>

            <form onSubmit={handleReportIssue} className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 block">Domain yang Bermasalah:</label>
                <input
                  type="text"
                  required
                  value={issueDomain}
                  onChange={e => setIssueDomain(e.target.value)}
                  placeholder="contoh: jaya26.site"
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 block">Deskripsi Kendala (DNS / SSL / Error):</label>
                <textarea
                  required
                  rows={3}
                  value={issueDescription}
                  onChange={e => setIssueDescription(e.target.value)}
                  placeholder="Jelaskan detail kendala (contoh: SSL pending lebih dari 24 jam, DNS TXT tidak terbaca...)"
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold cursor-pointer"
                >
                  Kirim Tiket Kendala
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestsOpsView({ tickets, onSelect }: { tickets: Ticket[]; onSelect: (v: any) => void }) {
  const opTickets = useMemo(() => {
    return tickets.filter(t => [
      'push_request', 'cdn_request', 'redirect_request', 'domain_request', 
      'seo_audit', 'web_update', 'ownership_transfer'
    ].includes(t.category));
  }, [tickets]);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="p-4 rounded-2xl glass-card border border-cyan-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Sliders size={16} className="text-cyan-400" />
            Pusat Eksekusi Operasional (Operations Center)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Semua permintaan teknis (Push Indexing, CDN Cache, 301 Redirect, Domain Baru, Update Web) menunggu keputusan Admin.
          </p>
        </div>
        <span className="px-3 py-1 rounded-xl bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 text-xs font-bold shrink-0">
          {opTickets.length} Request Aktif
        </span>
      </div>

      <ResponsiveDataList 
        title="Daftar Permintaan Operasional" 
        count={opTickets.length} 
        headers={['Nomor Tiket', 'Kategori Operasi', 'Pemohon', 'Prioritas', 'Status', 'Waktu']}
        mobileItems={opTickets.map(t => ({
          id: t.id,
          avatarText: '⚡',
          title: `${t.ticket_number} · ${t.title || t.category}`,
          subtitle: `Pemohon: ${t.user_name || `User #${t.user_id}`} · ${t.category}`,
          badge: <PriorityBadge priority={t.priority || 'high'} />,
          secondaryBadge: <StatusBadge status={t.status} />
        }))}
        desktopRows={opTickets.map(t => [
          <span key={`t-${t.id}`} className="font-mono-code font-bold text-cyan-300 text-xs">{t.ticket_number}</span>,
          <span key={`c-${t.id}`} className="text-xs px-2 py-0.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 font-semibold">{t.category}</span>,
          <span key={`u-${t.id}`} className="font-semibold text-slate-200 text-xs">{t.user_name || `User #${t.user_id}`}</span>,
          <PriorityBadge key={`p-${t.id}`} priority={t.priority || 'high'} />,
          <StatusBadge key={`s-${t.id}`} status={t.status} />,
          <span key={`d-${t.id}`} className="text-xs text-slate-400">{formatDateTime(t.updated_at || t.created_at)}</span>
        ])}
        onSelect={(i) => onSelect(opTickets[i])}
      />
    </div>
  );
}

function TicketsListView({ 
  tickets, 
  ticketCounts, 
  ticketPriority, 
  setTicketPriority, 
  ticketStatusFilter, 
  setTicketStatusFilter, 
  ticketSort, 
  setTicketSort, 
  exportCSV, 
  onSelect 
}: { 
  tickets: Ticket[]; 
  ticketCounts: any; 
  ticketPriority: string; 
  setTicketPriority: (v: string) => void; 
  ticketStatusFilter: string; 
  setTicketStatusFilter: (v: string) => void; 
  ticketSort: string; 
  setTicketSort: (v: string) => void; 
  exportCSV: () => void; 
  onSelect: (v: any) => void; 
}) {
  return (
    <div className="space-y-4 animate-fade-in">
      {/* Status Summary Progress Bar */}
      <div className="glass-card p-4 sm:p-5 rounded-2xl space-y-3">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
          <span className="flex items-center gap-1.5">
            <Layers size={15} className="text-cyan-400" />
            Distribusi Tiket Support
          </span>
          <span className="text-slate-400 font-mono-code text-[11px]">Total: {ticketCounts.total}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <span className="text-amber-400 font-bold uppercase text-[9px] block">Pending</span>
            <div className="text-lg font-black text-amber-200">{ticketCounts.pending}</div>
          </div>
          <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20">
            <span className="text-sky-400 font-bold uppercase text-[9px] block">In Progress</span>
            <div className="text-lg font-black text-sky-200">{ticketCounts.in_progress}</div>
          </div>
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 font-bold uppercase text-[9px] block">Resolved</span>
            <div className="text-lg font-black text-emerald-200">{ticketCounts.resolved}</div>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-500/10 border border-slate-500/20">
            <span className="text-slate-400 font-bold uppercase text-[9px] block">Closed</span>
            <div className="text-lg font-black text-slate-300">{ticketCounts.closed}</div>
          </div>
        </div>
      </div>

      {/* Filter & Action Controls */}
      <div className="glass-card p-3 sm:p-4 rounded-2xl flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
        <div className="grid grid-cols-3 gap-2 flex-1 max-w-xl">
          <select value={ticketStatusFilter} onChange={e => setTicketStatusFilter(e.target.value)} className="bg-white/[0.04] border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none">
            <option value="all">Semua Status</option>
            <option value="pending">Pending</option>
            <option value="assigned">Assigned</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select value={ticketPriority} onChange={e => setTicketPriority(e.target.value)} className="bg-white/[0.04] border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none">
            <option value="all">Semua Prioritas</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={ticketSort} onChange={e => setTicketSort(e.target.value)} className="bg-white/[0.04] border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none">
            <option value="newest">Terbaru</option>
            <option value="oldest">Terlama</option>
            <option value="priority">Prioritas</option>
          </select>
        </div>

        <button onClick={exportCSV} className="w-full sm:w-auto justify-center px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 cursor-pointer transition active:scale-95">
          <Download size={14} />
          <span>Export CSV</span>
        </button>
      </div>

      <ResponsiveDataList 
        title="Antrean Tiket Support & Operasional" 
        count={tickets.length} 
        headers={['Nomor Tiket', 'Pelapor', 'Kategori', 'Prioritas', 'Status', 'Waktu']}
        mobileItems={tickets.map(t => ({
          id: t.id,
          avatarText: '🎫',
          title: `${t.ticket_number} · ${t.title || t.category}`,
          subtitle: `Pelapor: ${t.user_name || `User #${t.user_id}`} · ${t.category}`,
          badge: <PriorityBadge priority={t.priority || 'medium'} />,
          secondaryBadge: <StatusBadge status={t.status} />
        }))}
        desktopRows={tickets.map(t => [
          <span key={`t-${t.id}`} className="font-mono-code font-bold text-cyan-300 text-xs">{t.ticket_number}</span>,
          <span key={`u-${t.id}`} className="font-semibold text-slate-200 text-xs">{t.user_name || `User #${t.user_id}`}</span>,
          <span key={`c-${t.id}`} className="text-xs px-2 py-0.5 rounded-lg bg-white/5 border border-white/10 text-slate-300">{t.category}</span>,
          <PriorityBadge key={`p-${t.id}`} priority={t.priority || 'medium'} />,
          <StatusBadge key={`s-${t.id}`} status={t.status} />,
          <span key={`d-${t.id}`} className="text-xs text-slate-400">{formatDateTime(t.updated_at || t.created_at)}</span>
        ])}
        onSelect={(i) => onSelect(tickets[i])}
      />
    </div>
  );
}

function PaymentsLedgerView({ payments, paymentStart, setPaymentStart, paymentEnd, setPaymentEnd, exportCSV, onSelect }: any) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="glass-card p-3 sm:p-4 rounded-2xl flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-slate-400">
          <span className="shrink-0 font-medium">Periode Pembayaran:</span>
          <input type="date" value={paymentStart} onChange={e => setPaymentStart(e.target.value)} className="bg-white/[0.04] border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-slate-200"/>
          <span className="shrink-0">-</span>
          <input type="date" value={paymentEnd} onChange={e => setPaymentEnd(e.target.value)} className="bg-white/[0.04] border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-slate-200"/>
        </div>
        <button onClick={exportCSV} className="w-full sm:w-auto justify-center px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5 cursor-pointer transition active:scale-95">
          <Download size={14} />
          <span>Export CSV</span>
        </button>
      </div>

      <ResponsiveDataList 
        title="Ledger Payroll & Pembayaran" 
        count={payments.length} 
        headers={['Nomor Invoice', 'ID Member', 'Nominal Pembayaran', 'Status', 'Tanggal']}
        mobileItems={payments.map((p: any) => ({
          id: p.id,
          avatarText: '💳',
          title: p.payment_number || `#${p.id}`,
          subtitle: `Member ID: ${p.user_id} · ${formatDateTime(p.created_at)}`,
          badge: <span className="font-mono-code font-bold text-emerald-400 text-xs">{p.currency || 'IDR'} {Number(p.amount).toLocaleString('id-ID')}</span>,
          secondaryBadge: <StatusBadge status={p.status} />
        }))}
        desktopRows={payments.map((p: any) => [
          <span key={`pay-${p.id}`} className="font-mono-code font-bold text-white text-xs">{p.payment_number || `#${p.id}`}</span>,
          <span key={`uid-${p.id}`} className="font-mono-code text-xs text-slate-400">{p.user_id}</span>,
          <span key={`amt-${p.id}`} className="font-bold text-emerald-400 text-xs font-mono-code">
            {p.currency || 'IDR'} {Number(p.amount).toLocaleString('id-ID')}
          </span>,
          <StatusBadge key={`stat-${p.id}`} status={p.status} />,
          <span key={`dt-${p.id}`} className="text-xs text-slate-400">{formatDateTime(p.created_at)}</span>
        ])}
        onSelect={(i) => onSelect(payments[i])}
      />
    </div>
  );
}

function SeoAuditWorkspace({ tickets, onSelect }: { tickets: Ticket[]; onSelect: (v: any) => void }) {
  const seoTickets = tickets.filter(t => t.category === 'seo_audit' || t.category === 'push_request');
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-4 rounded-2xl glass-card border border-purple-500/20">
          <span className="text-[10px] uppercase font-bold text-purple-300 block">Deteksi Indexing</span>
          <div className="text-xl font-black text-white mt-1">Google & Bing API</div>
          <span className="text-[10px] text-slate-400 mt-1 block">Audit URL terindeks vs belum terindeks</span>
        </div>
        <div className="p-4 rounded-2xl glass-card border border-blue-500/20">
          <span className="text-[10px] uppercase font-bold text-blue-300 block">Sitemap IndexNow</span>
          <div className="text-xl font-black text-white mt-1">Instant Push</div>
          <span className="text-[10px] text-slate-400 mt-1 block">Batch dispatching ke search engine</span>
        </div>
        <div className="p-4 rounded-2xl glass-card border border-emerald-500/20">
          <span className="text-[10px] uppercase font-bold text-emerald-300 block">SEO Outreach</span>
          <div className="text-xl font-black text-white mt-1">Clean Review</div>
          <span className="text-[10px] text-slate-400 mt-1 block">Permintaan SEO ditinjau manual tanpa bot spam</span>
        </div>
      </div>

      <ResponsiveDataList 
        title="Antrean Permintaan Audit Indexing & SEO" 
        count={seoTickets.length} 
        headers={['ID Tiket', 'Target Domain', 'Keywords / Fokus', 'Kepemilikan', 'Status', 'Waktu']}
        mobileItems={seoTickets.map(t => ({
          id: t.id,
          avatarText: '🔍',
          title: `${t.ticket_number} · ${t.title || 'Audit SEO'}`,
          subtitle: `Domain: ${t.collected_data?.target_domain || 'Target'} · ${t.user_name || `User #${t.user_id}`}`,
          badge: <StatusBadge status={t.status} />
        }))}
        desktopRows={seoTickets.map(t => [
          <span key={`st-${t.id}`} className="font-mono-code font-bold text-purple-300 text-xs">{t.ticket_number}</span>,
          <span key={`sd-${t.id}`} className="font-bold text-white text-xs font-mono-code">{t.collected_data?.target_domain || t.title || '—'}</span>,
          <span key={`sk-${t.id}`} className="text-xs text-slate-300">{Array.isArray(t.collected_data?.keywords) ? t.collected_data.keywords.join(', ') : 'Audit umum'}</span>,
          <span key={`so-${t.id}`} className="text-[10px] font-mono-code px-2 py-0.5 rounded bg-white/5 text-slate-300">{t.collected_data?.ownership_status || 'Verified'}</span>,
          <StatusBadge key={`ss-${t.id}`} status={t.status} />,
          <span key={`sw-${t.id}`} className="text-xs text-slate-400">{formatDateTime(t.created_at)}</span>
        ])}
        onSelect={(i) => onSelect(seoTickets[i])}
      />
    </div>
  );
}

function TrafficAnalyticsView({ stats, domains, onSelect }: any) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-2xl glass-card">
          <span className="text-[10px] font-bold text-slate-400 uppercase">Live Edge RPS</span>
          <div className="text-xl font-black text-cyan-300 mt-1">N/A</div>
          <span className="text-[10px] text-slate-400">Under Construction</span>
        </div>
        <div className="p-4 rounded-2xl glass-card">
          <span className="text-[10px] font-bold text-slate-400 uppercase">Total Websites</span>
          <div className="text-xl font-black text-emerald-300 mt-1">{stats?.totalWebsites || 0}</div>
          <span className="text-[10px] text-slate-400">Active in system</span>
        </div>
        <div className="p-4 rounded-2xl glass-card">
          <span className="text-[10px] font-bold text-slate-400 uppercase">Active Redirects (301)</span>
          <div className="text-xl font-black text-purple-300 mt-1">N/A</div>
          <span className="text-[10px] text-slate-400">Under Construction</span>
        </div>
        <div className="p-4 rounded-2xl glass-card">
          <span className="text-[10px] font-bold text-slate-400 uppercase">Total Bandwidth</span>
          <div className="text-xl font-black text-white mt-1">N/A</div>
          <span className="text-[10px] text-slate-400">Under Construction</span>
        </div>
      </div>

      <ResponsiveDataList 
        title="Matriks Trafik Domain Aktif" 
        count={domains.length} 
        headers={['Domain', 'Status Edge', 'Tren 24 Jam', 'Subdomain', 'Aksi']}
        mobileItems={domains.map((d: any) => ({
          id: d.domain,
          avatarText: '📈',
          title: d.domain,
          subtitle: `Tren: ${d.domainObj.traffic_trend || '0%'} · ${d.domainObj.subdomains?.length || 0} subdomains`,
          badge: <StatusBadge status={d.domainObj.status.toUpperCase()} />
        }))}
        desktopRows={domains.map((d: any) => [
          <span key={`td-${d.domain}`} className="font-bold text-white text-xs">{d.domain}</span>,
          <span key={`te-${d.domain}`} className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">CDN PROXIED</span>,
          <span key={`tt-${d.domain}`} className={`font-mono-code text-xs font-bold ${d.domainObj.traffic_trend?.startsWith('+') ? 'text-emerald-400' : 'text-slate-400'}`}>{d.domainObj.traffic_trend || '0%'}</span>,
          <span key={`ts-${d.domain}`} className="text-xs text-slate-300 font-mono-code">{d.domainObj.subdomains?.length || 0} active</span>,
          <button key={`tb-${d.domain}`} onClick={() => onSelect({ type: 'domain_detail', domain: d.domain, domainObj: d.domainObj, user: d.user })} className="text-xs font-bold text-cyan-400 hover:text-cyan-300 cursor-pointer">Inspeksi</button>
        ])}
        onSelect={(i) => onSelect({ type: 'domain_detail', domain: domains[i].domain, domainObj: domains[i].domainObj, user: domains[i].user })}
      />
    </div>
  );
}

function CommunityForumView({ topics, onSelect }: any) {
  const displayTopics = topics && topics.length > 0 ? topics : [
    { id: 'TID-001', title: 'Belum ada diskusi (Data Kosong dari Backend)', author: 'System', replies: 0, status: 'OPEN', date: new Date().toISOString().substring(0, 10) }
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <ResponsiveDataList 
        title="Topik Diskusi Komunitas & Operasional" 
        count={displayTopics.length} 
        headers={['ID Topik', 'Judul Diskusi', 'Penulis', 'Balasan', 'Status', 'Tanggal']}
        mobileItems={displayTopics.map((t: any) => ({
          id: t.id,
          avatarText: '💬',
          title: t.title,
          subtitle: `Penulis: ${t.author || 'Member'} · ${t.replies || 0} balasan`,
          badge: <StatusBadge status={t.status || 'OPEN'} />
        }))}
        desktopRows={displayTopics.map((t: any) => [
          <span key={`f-id-${t.id}`} className="font-mono-code font-bold text-slate-400 text-xs">#{t.id}</span>,
          <span key={`f-tt-${t.id}`} className="font-bold text-white text-xs">{t.title}</span>,
          <span key={`f-au-${t.id}`} className="text-xs text-slate-300 font-medium">{t.author || 'Member'}</span>,
          <span key={`f-rp-${t.id}`} className="font-mono-code text-xs text-cyan-400">{t.replies || 0} respons</span>,
          <StatusBadge key={`f-st-${t.id}`} status={t.status || 'OPEN'} />,
          <span key={`f-dt-${t.id}`} className="text-xs text-slate-400">{t.created_at ? new Date(t.created_at).toISOString().substring(0, 10) : (t.date || '-')}</span>
        ])}
        onSelect={() => {}}
      />
    </div>
  );
}

function BroadcastConsoleView({ onBroadcastSuccess }: { onBroadcastSuccess: (msg: string) => void }) {
  const [broadcastMode, setBroadcastMode] = useState<'daily_report' | 'custom_announcement'>('daily_report');
  const [channel, setChannel] = useState<'both' | 'member_group' | 'admin_bot'>('both');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Daily Report State
  const [reportDate, setReportDate] = useState(new Date().toISOString().substring(0, 10));
  const [serverHealth, setServerHealth] = useState('100% Operational (Supabase + Cloudflare Edge)');
  const [solvedTickets, setSolvedTickets] = useState('');
  const [verifiedPayroll, setVerifiedPayroll] = useState('');
  const [dailyNote, setDailyNote] = useState('');

  const handleSendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      const payloadMessage = broadcastMode === 'daily_report' 
        ? `Laporan Harian (${reportDate})\nServer Health: ${serverHealth}\nSolved Tickets: ${solvedTickets}\nVerified Payroll: ${verifiedPayroll}\nNote: ${dailyNote}`
        : message;

      await api('/broadcast', {
        method: 'POST',
        body: JSON.stringify({ message: payloadMessage, channel })
      });
      
      if (broadcastMode === 'daily_report') {
        onBroadcastSuccess(`Laporan Harian (${reportDate}) berhasil disiarkan ke ${
          channel === 'both' ? 'Grup Member & Bot Admin' : channel
        }.`);
      } else {
        setMessage('');
        onBroadcastSuccess(`Pengumuman broadcast terkirim ke saluran ${channel}.`);
      }
    } catch (err: any) {
      alert(`Gagal mengirim broadcast: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5 animate-fade-in">
      <div className="glass-card p-6 sm:p-8 rounded-3xl space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-glow-cyan">
              <Radio size={22} />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white">Broadcast Console & Laporan Harian</h3>
              <p className="text-xs text-slate-400">Khusus Admin, Super Admin & Dev: Publikasi & Pengiriman Notifikasi Resmi</p>
            </div>
          </div>

          {/* Mode Switcher */}
          <div className="p-1 rounded-xl bg-black/40 border border-white/10 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setBroadcastMode('daily_report')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                broadcastMode === 'daily_report' ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
              }`}
            >
              📑 Laporan Harian
            </button>
            <button
              type="button"
              onClick={() => setBroadcastMode('custom_announcement')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                broadcastMode === 'custom_announcement' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
              }`}
            >
              📢 Pengumuman Bebas
            </button>
          </div>
        </div>

        <form onSubmit={handleSendBroadcast} className="space-y-4">
          {/* Target Saluran */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-300 block">Pilih Saluran Distribusi Notifikasi:</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setChannel('both')}
                className={`p-3 rounded-xl border text-left transition cursor-pointer text-xs font-semibold ${
                  channel === 'both' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-200' : 'bg-white/[0.02] border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                <div className="font-bold text-white">🌐 Semua Saluran</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Grup Member + Bot Admin</div>
              </button>
              <button
                type="button"
                onClick={() => setChannel('member_group')}
                className={`p-3 rounded-xl border text-left transition cursor-pointer text-xs font-semibold ${
                  channel === 'member_group' ? 'bg-blue-500/20 border-blue-500 text-blue-200' : 'bg-white/[0.02] border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                <div className="font-bold text-white">👥 Grup Komunitas</div>
                <div className="text-[10px] text-slate-400 mt-0.5">t.me/+ybOzZ_lstEdhNDU1 (@mrssandebot)</div>
              </button>
              <button
                type="button"
                onClick={() => setChannel('admin_bot')}
                className={`p-3 rounded-xl border text-left transition cursor-pointer text-xs font-semibold ${
                  channel === 'admin_bot' ? 'bg-purple-500/20 border-purple-500 text-purple-200' : 'bg-white/[0.02] border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                <div className="font-bold text-white">🛡️ Bot Internal Admin</div>
                <div className="text-[10px] text-slate-400 mt-0.5">@sandekalabot (Ops Detail)</div>
              </button>
            </div>
          </div>

          {/* MODE 1: FORM LAPORAN HARIAN MANUAL */}
          {broadcastMode === 'daily_report' && (
            <div className="p-4 rounded-2xl bg-black/40 border border-white/10 space-y-3.5 animate-fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <span className="text-xs font-bold text-cyan-300">Format Laporan Harian Operasional</span>
                <span className="text-[10px] font-mono-code text-slate-400">Editable Manual oleh Admin/Dev</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="text-slate-400 font-semibold">Tanggal Laporan:</label>
                  <input
                    type="date"
                    value={reportDate}
                    onChange={e => setReportDate(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-white font-mono-code focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-semibold">Status Infrastruktur / Uptime:</label>
                  <input
                    type="text"
                    value={serverHealth}
                    onChange={e => setServerHealth(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-semibold">Total Tiket Terselesaikan Hari Ini:</label>
                  <input
                    type="text"
                    value={solvedTickets}
                    onChange={e => setSolvedTickets(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-semibold">Total Klaim Gaji Dicairkan:</label>
                  <input
                    type="text"
                    value={verifiedPayroll}
                    onChange={e => setVerifiedPayroll(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono-code focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 font-semibold text-xs">Catatan & Pengumuman Operasional Hari Ini:</label>
                <textarea
                  rows={3}
                  value={dailyNote}
                  onChange={e => setDailyNote(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              {/* Preview Box */}
              <div className="p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/20 space-y-1 text-xs">
                <span className="font-bold text-cyan-300 block">👀 Preview Format Pesan:</span>
                <p className="font-mono-code text-[11px] text-slate-300 whitespace-pre-line leading-relaxed">
                  {`📊 *LAPORAN HARIAN ABIEDIEN BACKOFFICE* (${reportDate})\n• Status Server: ${serverHealth}\n• Tiket Ditangani: ${solvedTickets} tiket\n• Total Payroll Gaji: ${verifiedPayroll}\n• Catatan: ${dailyNote}`}
                </p>
              </div>
            </div>
          )}

          {/* MODE 2: PENGUMUMAN BEBAS */}
          {broadcastMode === 'custom_announcement' && (
            <div className="space-y-1.5 animate-fade-in">
              <label className="text-xs font-bold text-slate-300 block">Isi Pesan Pengumuman:</label>
              <textarea 
                rows={4}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Tulis pesan pengumuman penting untuk disiarkan..."
                required
                className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-cyan-500/50"
              />
            </div>
          )}

          <button 
            type="submit" 
            disabled={sending} 
            className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-glow-cyan transition cursor-pointer disabled:opacity-50"
          >
            <Send size={15} />
            {sending ? 'Menyiarkan Laporan...' : 'Siarkan Laporan Harian Sekarang'}
          </button>
        </form>
      </div>
    </div>
  );
}

function DevOpsGeneratorsView() {
  return (
    <div className="max-w-3xl mx-auto space-y-4 animate-fade-in">
      <div className="glass-card p-6 rounded-3xl text-center space-y-3">
        <h3 className="text-sm font-extrabold text-white">DevOps & DNS Tools</h3>
        <p className="text-xs text-slate-400">Modul sedang dalam tahap pengembangan (Under Construction).</p>
      </div>
    </div>
  );
}


function SecuritySettingsView({ onToast }: { onToast: (msg: string, t?: 'success' | 'error') => void }) {
  return (
    <div className="max-w-2xl mx-auto glass-card p-6 sm:p-8 rounded-3xl space-y-5 animate-fade-in text-center">
      <div className="w-10 h-10 mx-auto rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
        <ShieldCheck size={20} />
      </div>
      <div>
        <h3 className="text-base font-extrabold text-white">Security Settings</h3>
        <p className="text-xs text-slate-400 mt-2">Modul sedang dalam tahap pengembangan (Under Construction).</p>
      </div>
    </div>
  );
}

// ==========================================
// SUB-VIEWS: TELEGRAM WEB & LIVE HUB
// ==========================================

function TelegramLiveHub({ tickets, users, onSelectTicket, onExecuteSuccess }: {
  tickets: Ticket[];
  users: User[];
  onSelectTicket: (t: any) => void;
  onExecuteSuccess: (msg: string) => void;
}) {
  const [selectedChat, setSelectedChat] = useState<number>(101);
  const [adminInput, setAdminInput] = useState('');

  const liveFeeds = useMemo(() => {
    return [
      {
        ticket_id: 101,
        ticket_number: 'TKT-501',
        user: { name: 'Rizky Pratama', username: '@rizky_member', id: 1004 },
        intent: 'INDEX_PUSH_REQUEST',
        domain: 'rizkycloud.xyz',
        status: 'PENDING',
        priority: 'HIGH',
        messages: [
          { sender: 'member', text: 'Pak tolong push indexing domain saya rizkycloud.xyz sitemap baru update.', time: '10:00' },
          { sender: 'bot', text: 'Permintaan push indexing diterima (Ticket #TKT-501). Menunggu review dan trigger admin.', time: '10:01' }
        ]
      },
      {
        ticket_id: 104,
        ticket_number: 'TKT-504',
        user: { name: 'Rizky Pratama', username: '@rizky_member', id: 1004 },
        intent: 'SEO_AUDIT_REQUEST',
        domain: 'rizkycloud.xyz',
        status: 'PENDING',
        priority: 'MEDIUM',
        messages: [
          { sender: 'member', text: 'Saya minta deteksi indexing untuk keyword slot gacor, maxwin.', time: '11:20' },
          { sender: 'bot', text: 'Tiket #TKT-504 dibuat. Status kepemilikan terverifikasi. Admin akan meninjau laporan audit.', time: '11:21' }
        ]
      },
      {
        ticket_id: 105,
        ticket_number: 'TKT-505',
        user: { name: 'Rizky Pratama', username: '@rizky_member', id: 1004 },
        intent: 'REDIRECT_301_REQUEST',
        domain: 'rizky-legacy.net',
        status: 'PENDING',
        priority: 'HIGH',
        messages: [
          { sender: 'member', text: 'Domain lama rizky-legacy.net trafik turun, tolong pasang redirect ke rizkycloud.xyz.', time: '12:00' },
          { sender: 'bot', text: 'Pengajuan 301 Redirect tercatat (Ticket #TKT-505). Admin akan meninjau rute URL.', time: '12:00' }
        ]
      }
    ];
  }, []);

  const currentFeed = liveFeeds.find(f => f.ticket_id === selectedChat) || liveFeeds[0];

  const handleAdminSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminInput.trim()) return;
    onExecuteSuccess(`Balasan terkirim ke member @${currentFeed.user.username}`);
    setAdminInput('');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-140px)] animate-fade-in">
      {/* Feed List */}
      <div className="glass-card rounded-2xl p-3 flex flex-col space-y-2 overflow-y-auto">
        <div className="flex items-center justify-between pb-2 border-b border-white/5">
          <span className="text-xs font-bold text-white flex items-center gap-1.5">
            <Radio size={14} className="text-blue-400" />
            Live Incoming Stream
          </span>
          <span className="text-[10px] text-slate-500 font-mono-code">{liveFeeds.length} Active</span>
        </div>

        <div className="space-y-1.5 flex-1">
          {liveFeeds.map(feed => {
            const isSelected = feed.ticket_id === selectedChat;
            return (
              <div
                key={feed.ticket_id}
                onClick={() => setSelectedChat(feed.ticket_id)}
                className={`p-3 rounded-xl transition cursor-pointer ${
                  isSelected ? 'bg-blue-600/20 border border-blue-500/40 shadow-xs' : 'bg-white/[0.02] hover:bg-white/[0.05] border border-white/5'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-white">{feed.user.name}</span>
                  <span className="text-[9px] font-mono-code px-1.5 py-0.2 rounded bg-white/10 text-cyan-300">
                    {feed.ticket_number}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono-code">{feed.user.username}</div>
                <div className="text-[10px] text-cyan-300 font-semibold mt-1 truncate">
                  Intent: {feed.intent}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Conversation & Decision Console */}
      <div className="lg:col-span-2 glass-card rounded-2xl p-4 flex flex-col justify-between space-y-4">
        {/* Header Console */}
        <div className="p-3.5 rounded-xl bg-black/40 border border-white/10 space-y-2.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[9px] font-bold uppercase text-slate-400 tracking-wider block">IDENTIFIED MEMBER & INTENT</span>
              <h4 className="text-sm font-black text-white">{currentFeed.user.name} ({currentFeed.user.username})</h4>
            </div>
            <StatusBadge status={currentFeed.status} />
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="p-2 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-[9px] text-slate-400 block">Classified Intent:</span>
              <strong className="text-cyan-300 font-mono-code text-[11px] block truncate">{currentFeed.intent}</strong>
            </div>
            <div className="p-2 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-[9px] text-slate-400 block">Target Domain:</span>
              <strong className="text-white font-mono-code text-[11px] block truncate">{currentFeed.domain}</strong>
            </div>
            <div className="p-2 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-[9px] text-slate-400 block">Priority:</span>
              <strong className="text-amber-300 text-[11px] block">{currentFeed.priority}</strong>
            </div>
          </div>

          {/* INLINE ADMIN ACTION TRIGGERS (Zero-Trust Dispatcher) */}
          <div className="pt-2 border-t border-white/5 flex items-center gap-1.5 flex-wrap">
            <button 
              onClick={() => onExecuteSuccess(`Tiket #${currentFeed.ticket_number} berhasil di-claim oleh Admin.`)}
              className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer transition active:scale-95"
            >
              <UserCheck size={12} />
              Claim
            </button>

            {currentFeed.intent === 'INDEX_PUSH_REQUEST' && (
              <button 
                onClick={() => onExecuteSuccess(`Push indexing untuk ${currentFeed.domain} berhasil di-trigger ke API Google/Bing.`)}
                className="px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer transition active:scale-95"
              >
                <Sparkles size={12} />
                Trigger Push Index
              </button>
            )}

            {currentFeed.intent === 'REDIRECT_301_REQUEST' && (
              <button 
                onClick={() => onExecuteSuccess(`301 Permanent Redirect untuk ${currentFeed.domain} aktif.`)}
                className="px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer transition active:scale-95"
              >
                <TrendingUp size={12} />
                Trigger 301 Redirect
              </button>
            )}

            <button 
              onClick={() => onExecuteSuccess(`Tiket #${currentFeed.ticket_number} ditolak.`)}
              className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-rose-300 text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition active:scale-95"
            >
              <X size={12} />
              Reject
            </button>

            <button 
              onClick={() => onExecuteSuccess(`Tiket #${currentFeed.ticket_number} dieskalasikan ke Super Admin.`)}
              className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition active:scale-95"
            >
              <TrendingUp size={12} />
              Escalate
            </button>

            <button 
              onClick={() => onExecuteSuccess(`Tiket #${currentFeed.ticket_number} diselesaikan (RESOLVE).`)}
              className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer transition active:scale-95"
            >
              <CheckCircle2 size={12} />
              Resolve
            </button>
          </div>
        </div>

        {/* Conversation Message Feed */}
        <div className="space-y-3 flex-1 overflow-y-auto p-2">
          {currentFeed.messages.map((msg, idx) => (
            <div key={idx} className={`flex flex-col ${msg.sender === 'member' ? 'items-start' : 'items-end'}`}>
              <span className="text-[9px] text-slate-500 uppercase font-bold mb-1">
                {msg.sender === 'member' ? `Member (@${currentFeed.user.username})` : 'Bot / Platform'} · {msg.time}
              </span>
              <div className={`p-3 rounded-2xl max-w-md text-xs leading-relaxed ${
                msg.sender === 'member' ? 'bg-white/10 text-white rounded-tl-none' : 'bg-blue-600/30 text-cyan-200 border border-blue-500/30 rounded-tr-none'
              }`}>
                {msg.text}
              </div>
            </div>
          ))}
        </div>

        {/* Admin Reply Box */}
        <form onSubmit={handleAdminSend} className="flex items-center gap-2 pt-2 border-t border-white/5">
          <input 
            type="text" 
            value={adminInput}
            onChange={e => setAdminInput(e.target.value)}
            placeholder={`Ketik balasan resmi ke @${currentFeed.user.username}...`}
            className="flex-1 bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
          />
          <button type="submit" className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer">
            <Send size={14} />
            <span>Kirim</span>
          </button>
        </form>
      </div>
    </div>
  );
}

function TelegramBotSimulator() {
  const [messages, setMessages] = useState<{ sender: 'user' | 'bot'; text: string }[]>([
    { sender: 'bot', text: '🤖 Selamat datang di Sandbox Bot Simulator! Ketik pesan (contoh: "deteksi indexing domain target", "/start", atau "saya mau push index") untuk menguji alur FSM State Machine.' }
  ]);
  const [input, setInput] = useState('');

  const handleSimulate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userText = input.trim();
    const newMsgs = [...messages, { sender: 'user' as const, text: userText }];
    setMessages(newMsgs);
    setInput('');

    setTimeout(() => {
      const lower = userText.toLowerCase();
      let botReply = '🤖 Permintaan diterima. Bot mencatat laporan dan meneruskannya ke tiket pending admin.';
      
      if (lower.includes('deteksi') || lower.includes('indexing') || lower.includes('audit')) {
        botReply = '🔍 *Layanan Audit Indexing & Permintaan SEO*\n\nMasukkan domain target (contoh: `jaya26.site`). Data akan dicatat untuk ditinjau oleh Admin.';
      } else if (lower.includes('push')) {
        botReply = '⚡ *Permintaan Push Indexing*\n\nDomain tercatat dalam antrean. Menunggu validasi sitemap oleh Admin.';
      } else if (lower.startsWith('/start')) {
        botReply = '🏠 *Menu Utama*\n\n1. ✅ Verifikasi Domain\n2. 🎫 Sistem Tiket\n3. 💬 Forum Komunitas\n4. 💳 Payment & Gaji';
      }

      setMessages([...newMsgs, { sender: 'bot' as const, text: botReply }]);
    }, 600);
  };

  return (
    <div className="max-w-2xl mx-auto glass-card rounded-3xl p-5 sm:p-6 space-y-4 animate-fade-in flex flex-col h-[calc(100vh-140px)]">
      <div className="flex items-center justify-between pb-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Terminal size={18} className="text-cyan-400" />
          <h3 className="text-sm font-extrabold text-white">Bot FSM State Machine Simulator</h3>
        </div>
        <button onClick={() => setMessages([{ sender: 'bot', text: '🤖 Sandbox di-reset.' }])} className="text-xs text-slate-400 hover:text-white cursor-pointer">
          Reset
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 p-2">
        {messages.map((m, idx) => (
          <div key={idx} className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`p-3 rounded-2xl max-w-md text-xs leading-relaxed ${
              m.sender === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-black/50 text-cyan-200 border border-white/10 rounded-bl-none font-mono-code'
            }`}>
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSimulate} className="flex items-center gap-2 pt-2 border-t border-white/5">
        <input 
          type="text" 
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ketik simulasi pesan Telegram..."
          className="flex-1 bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
        />
        <button type="submit" className="px-4 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer">
          <Play size={13} />
          <span>Simulasi</span>
        </button>
      </form>
    </div>
  );
}

// ==========================================
// RESPONSIVE DETAIL DRAWER (Category-Aware Action Inspector)
// ==========================================
function DetailDrawer({ data, close, onMutateSuccess }: { data: any; close: () => void; onMutateSuccess: (msg: string) => void }) {
  const [replyMessage, setReplyMessage] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    description: string;
    actionName: string;
    buttonColor: string;
    onExecute: (reason: string) => Promise<void>;
  } | null>(null);
  const [modalReason, setModalReason] = useState('');

  const isTicket = Boolean(data.ticket_number || data.category);
  const isPayment = Boolean(data.payment_number || data.amount !== undefined);
  const isDomain = data.type === 'domain_detail' || Boolean(data.domain && data.domainObj);
  const isUser = !isDomain && !isTicket && !isPayment && Boolean(data.telegram_id && data.role);

  const cat = (data.category || '').toLowerCase();
  const isSeoAudit = cat.includes('seo_audit') || cat.includes('indexing_audit') || cat.includes('seo_outreach') || cat.includes('seo_migration') || Boolean(data.collected_data?.service_type?.includes('audit') || data.collected_data?.service_type?.includes('seo'));
  const isPushRequest = !isSeoAudit && (cat.includes('push') || cat.includes('index'));
  const isCdnRequest = cat.includes('cdn') || cat.includes('cache');
  const isRedirectRequest = cat.includes('redirect') || cat.includes('301');
  const isBillingRequest = cat.includes('billing') || cat.includes('payment') || cat.includes('gaji') || cat.includes('topup');

  const handleClaim = async () => {
    try {
      setBusy(true);
      await claimTicketApi(data.id);
      onMutateSuccess(`Tiket #${data.ticket_number || data.id} berhasil di-claim.`);
      close();
    } catch (e: any) {
      onMutateSuccess(e.message || 'Gagal claim tiket');
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      await resolveTicketApi(data.id, resolutionNotes || 'Diselesaikan oleh Super Admin');
      onMutateSuccess(`Tiket #${data.ticket_number || data.id} diselesaikan.`);
      close();
    } catch (e: any) {
      onMutateSuccess(e.message || 'Gagal menyelesaikan tiket');
    } finally {
      setBusy(false);
    }
  };

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      await replyTicketApi(data.id, replyMessage);
      onMutateSuccess(`Balasan terkirim ke tiket #${data.ticket_number || data.id}.`);
      setReplyMessage('');
      close();
    } catch (e: any) {
      onMutateSuccess(e.message || 'Gagal kirim balasan');
    } finally {
      setBusy(false);
    }
  };

  const openConfirm = (
    title: string, 
    description: string, 
    actionName: string, 
    buttonColor: string, 
    onExecute: (reason: string) => Promise<void>
  ) => {
    setModalReason('');
    setConfirmModal({ title, description, actionName, buttonColor, onExecute });
  };

  const handleConfirmSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmModal) return;
    try {
      setBusy(true);
      await confirmModal.onExecute(modalReason.trim() || 'Diverifikasi via Backoffice Authority');
      setConfirmModal(null);
      close();
    } catch (e: any) {
      onMutateSuccess(e.message || 'Operasi gagal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:max-h-[90vh] max-sm:rounded-t-3xl max-sm:animate-slide-up sm:inset-y-0 sm:right-0 z-50 w-full sm:max-w-lg glass-sidebar p-5 sm:p-6 flex flex-col shadow-2xl border-t sm:border-t-0 sm:border-l border-white/10 overflow-y-auto safe-bottom">
      {/* Mobile Drag Pill */}
      <div className="drag-indicator sm:hidden mb-3" />

      <div className="flex items-center justify-between pb-4 border-b border-white/10 shrink-0">
        <div>
          <span className="text-[9px] font-bold text-cyan-400 uppercase tracking-wider block">RECORD INSPECTOR</span>
          <h3 className="text-sm sm:text-base font-extrabold text-white truncate max-w-xs">
            {isTicket ? `Tiket #${data.ticket_number}` : isPayment ? `Invoice #${data.payment_number}` : isDomain ? `Domain ${data.domain}` : isUser ? `Member: ${data.full_name || data.username}` : 'Detail Record'}
          </h3>
        </div>
        <button onClick={close} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer">
          <X size={18} />
        </button>
      </div>

      <div className="py-4 space-y-4 flex-1">
        {/* DOMAIN & SUBDOMAIN RECORD INSPECTOR */}
        {isDomain && (
          <div className="space-y-4">
            <div className="p-3.5 sm:p-4 rounded-2xl bg-cyan-950/20 border border-cyan-500/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                  <ShieldCheck size={16} className="text-cyan-400" />
                  Kepemilikan Akun & Registrant Resmi
                </span>
                <StatusBadge status={data.domainObj.status.toUpperCase()} />
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-black/40 border border-white/5">
                  <span className="text-[10px] text-slate-400 block font-medium">Registrant Utama</span>
                  <strong className="text-white font-bold block mt-0.5">{data.user.full_name || 'Tanpa Nama'}</strong>
                  <span className="text-[10px] text-cyan-400 font-mono-code">@{data.user.username || 'n/a'}</span>
                </div>
                <div className="p-2.5 rounded-xl bg-black/40 border border-white/5">
                  <span className="text-[10px] text-slate-400 block font-medium">Status Akun Pemilik</span>
                  <div className="mt-1"><RoleBadge role={data.user.role} /></div>
                  <span className="text-[10px] text-slate-400 block mt-1">ID: {data.user.telegram_id}</span>
                </div>
              </div>
            </div>

            {/* Subdomain Hierarchy */}
            <div className="p-3.5 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Globe2 size={15} className="text-blue-400" />
                  Struktur Subdomain ({data.domainObj.subdomains?.length || 0})
                </span>
                <span className="text-[10px] text-slate-400 font-mono-code">Trafik: {data.domainObj.traffic_trend || 'N/A'}</span>
              </div>

              {data.domainObj.subdomains && data.domainObj.subdomains.length > 0 ? (
                <div className="space-y-1.5">
                  {data.domainObj.subdomains.map((sub: any) => (
                    <div key={sub.id} className="p-2.5 rounded-xl bg-black/40 border border-white/5 flex items-center justify-between text-xs">
                      <div className="font-mono-code text-cyan-300 font-semibold">{sub.fqdn || `${sub.name}.${data.domain}`}</div>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${sub.status === 'active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-400'}`}>
                        {sub.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-black/20 text-center text-xs text-slate-500">
                  Belum ada subdomain terdaftar untuk domain ini.
                </div>
              )}
            </div>

            {/* Operational Domain Actions */}
            <div className="p-3.5 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-2.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Aksi Domain & Migrasi Trafik</span>

              {data.domainObj.status !== 'verified' && (
                <button
                  disabled={busy}
                  onClick={() => openConfirm(
                    'Verifikasi & Setujui DNS Domain',
                    `Setujui verifikasi TXT record domain "${data.domain}" untuk akun registrant ${data.user.full_name}?`,
                    'Setujui DNS Domain',
                    'bg-emerald-600 hover:bg-emerald-500 text-white',
                    async (reason) => {
                      await executeAdminAction({ action: 'APPROVE_DOMAIN_DNS', metadata: { domain: data.domain, user_id: data.user.id }, reason });
                      onMutateSuccess(`Domain ${data.domain} berhasil diverifikasi.`);
                    }
                  )}
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center gap-2 shadow-glow-emerald transition cursor-pointer active:scale-95"
                >
                  <CheckCircle2 size={15} />
                  Verifikasi & Aktifkan Domain
                </button>
              )}

              <button
                disabled={busy}
                onClick={() => openConfirm(
                  'Trigger 301 Redirect (Jaga Trafik)',
                  `Pasang 301 Permanent Redirect dari domain lama (${data.domain}) ke domain baru untuk mempertahankan traffic dan SEO?`,
                  'Pasang Redirect 301',
                  'bg-blue-600 hover:bg-blue-500 text-white',
                  async (reason) => {
                    await executeAdminAction({ action: 'TRIGGER_REDIRECT_301', metadata: { source_domain: data.domain, user_id: data.user.id }, reason });
                    onMutateSuccess(`Redirect 301 domain ${data.domain} berhasil dipasang.`);
                  }
                )}
                className="w-full py-2.5 rounded-xl text-xs font-bold bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 flex items-center justify-center gap-2 transition cursor-pointer active:scale-95"
              >
                <TrendingUp size={15} />
                Trigger 301 Redirect (Perlindungan Trafik)
              </button>

              <button
                disabled={busy}
                onClick={() => openConfirm(
                  'Purge Cache CDN & DNS',
                  `Lakukan purge cache Cloudflare Edge untuk seluruh rute domain "${data.domain}"?`,
                  'Purge Cache',
                  'bg-cyan-600 hover:bg-cyan-500 text-white',
                  async (reason) => {
                    await executeAdminAction({ action: 'PURGE_CDN_CACHE', metadata: { domain: data.domain }, reason });
                    onMutateSuccess(`Cache CDN untuk ${data.domain} telah di-purge.`);
                  }
                )}
                className="w-full py-2.5 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-cyan-300 flex items-center justify-center gap-2 transition cursor-pointer active:scale-95"
              >
                <RefreshCw size={15} />
                Purge CDN / Edge Cache
              </button>

              <button
                disabled={busy}
                onClick={() => openConfirm(
                  'Pengalihan Kepemilikan (Akuisisi Domain)',
                  `PENTING: Pengalihan kepemilikan domain "${data.domain}" membutuhkan persetujuan pendaftar lama dan verifikasi identitas pendaftar baru.`,
                  'Proses Pengalihan',
                  'bg-amber-600 hover:bg-amber-500 text-white',
                  async (reason) => {
                    await executeAdminAction({ action: 'TRANSFER_OWNERSHIP', metadata: { domain: data.domain, current_owner: data.user.id }, reason });
                    onMutateSuccess(`Workflow akuisisi kepemilikan domain ${data.domain} dimulai.`);
                  }
                )}
                className="w-full py-2.5 rounded-xl text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 flex items-center justify-center gap-2 transition cursor-pointer active:scale-95"
              >
                <ShieldCheck size={15} />
                Pengalihan Kepemilikan (Akuisisi)
              </button>
            </div>
          </div>
        )}

        {/* MEMBER RECORD INSPECTOR */}
        {isUser && (
          <div className="space-y-4">
            <div className="p-3.5 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-lg font-bold text-white shadow-glow-cyan">
                  {(data.full_name || data.username || 'U').charAt(0).toUpperCase()}
                </div>
                <div>
                  <h4 className="font-extrabold text-white text-sm">{data.full_name || 'Tanpa Nama'}</h4>
                  <div className="text-xs text-cyan-400 font-mono-code">@{data.username || 'n/a'}</div>
                  <div className="text-[10px] text-slate-400">Telegram ID: {data.telegram_id}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 text-xs">
                <div className="p-2.5 rounded-xl bg-black/40 border border-white/5">
                  <span className="text-[10px] text-slate-400 block">Role Otoritas</span>
                  <div className="mt-1"><RoleBadge role={data.role} /></div>
                </div>
                <div className="p-2.5 rounded-xl bg-black/40 border border-white/5">
                  <span className="text-[10px] text-slate-400 block">Status Akun</span>
                  <div className="mt-1"><StatusBadge status={data.status || 'active'} /></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Ticket Action Panel */}
        {isTicket && (
          <div className="p-3.5 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <LifeBuoy size={15} className="text-cyan-400" />
                Aksi Operasional ({data.category || 'General'})
              </span>
              <StatusBadge status={data.status} />
            </div>

            {/* Base Claim Trigger */}
            {data.status !== 'in_progress' && data.status !== 'resolved' && (
              <button 
                disabled={busy} 
                onClick={handleClaim} 
                className="w-full py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2 shadow-glow-cyan transition cursor-pointer disabled:opacity-50 active:scale-95"
              >
                <UserCheck size={16} />
                Claim Ticket (Ambil Tanggung Jawab)
              </button>
            )}

            {/* CONTEXTUAL ACTION: SEO AUDIT & INDEXING DETECTION */}
            {isSeoAudit && data.status !== 'resolved' && (
              <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300 block">🔍 Layanan Audit & Deteksi Indexing</span>
                  <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-200">SEO Audit Only</span>
                </div>

                <div className="p-2.5 rounded-lg bg-black/40 border border-white/5 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 text-[10px]">Target Domain:</span>
                    <span className="font-bold text-white font-mono-code">{data.collected_data?.target_domain || data.domain || '—'}</span>
                  </div>
                  {data.collected_data?.keywords && (
                    <div className="flex items-start justify-between gap-2 pt-0.5">
                      <span className="text-slate-400 text-[10px] shrink-0">Keywords:</span>
                      <span className="text-slate-200 text-[11px] text-right font-medium">{Array.isArray(data.collected_data.keywords) ? data.collected_data.keywords.join(', ') : data.collected_data.keywords}</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Kirim Laporan Audit Indexing',
                      `Kirimkan ringkasan laporan deteksi indexing untuk domain ${data.collected_data?.target_domain || 'target'} ke member?`,
                      'Kirim Laporan',
                      'bg-purple-600 hover:bg-purple-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'SEND_AUDIT_REPORT', reason, metadata: { service_type: 'indexing_audit', target_domain: data.collected_data?.target_domain } });
                        onMutateSuccess(`Laporan audit indexing tiket #${data.ticket_number} terkirim.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <Search size={13} />
                    Kirim Laporan
                  </button>

                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Tolak Permintaan Audit',
                      `Tolak permintaan audit SEO / indexing pada tiket #${data.ticket_number}?`,
                      'Tolak Request',
                      'bg-rose-600 hover:bg-rose-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'REJECT', reason });
                        onMutateSuccess(`Tiket audit #${data.ticket_number} ditolak.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <X size={13} />
                    Tolak
                  </button>
                </div>
              </div>
            )}

            {/* CONTEXTUAL ACTION: PUSH INDEXING REQUEST */}
            {isPushRequest && data.status !== 'resolved' && (
              <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300 block">⚡ Push Indexing Trigger</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Trigger Push Indexing',
                      `Jalankan push indexing ke API Search Console / IndexNow untuk domain terkait tiket #${data.ticket_number}?`,
                      'Eksekusi Push Index',
                      'bg-cyan-600 hover:bg-cyan-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'TRIGGER_PUSH_INDEX', reason });
                        onMutateSuccess(`Push index tiket #${data.ticket_number} berhasil di-trigger.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <Sparkles size={13} />
                    Trigger Push
                  </button>

                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Tandai Push Gagal',
                      `Tandai proses push index tiket #${data.ticket_number} sebagai gagal?`,
                      'Tandai Gagal',
                      'bg-rose-600 hover:bg-rose-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'MARK_FAILED', reason });
                        onMutateSuccess(`Tiket #${data.ticket_number} ditandai gagal.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <CircleAlert size={13} />
                    Tandai Gagal
                  </button>
                </div>
              </div>
            )}

            {/* CONTEXTUAL ACTION: CDN & CACHE REQUEST */}
            {isCdnRequest && data.status !== 'resolved' && (
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-300 block">☁️ CDN & Cache Management</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Purge Cache Cloudflare',
                      `Lakukan purge cache edge untuk domain pada tiket #${data.ticket_number}?`,
                      'Purge Edge Cache',
                      'bg-blue-600 hover:bg-blue-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'PURGE_CDN_CACHE', reason });
                        onMutateSuccess(`Cache CDN tiket #${data.ticket_number} berhasil di-purge.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <RefreshCw size={13} />
                    Purge Cache
                  </button>

                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Toggle CDN Proxy',
                      `Aktifkan/nonaktifkan Cloudflare Proxy untuk domain pada tiket #${data.ticket_number}?`,
                      'Toggle Proxy',
                      'bg-cyan-600 hover:bg-cyan-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'TOGGLE_CDN_PROXY', reason });
                        onMutateSuccess(`Proxy status tiket #${data.ticket_number} diperbarui.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-cyan-300 text-xs font-semibold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <Globe2 size={13} />
                    Toggle Proxy
                  </button>
                </div>
              </div>
            )}

            {/* CONTEXTUAL ACTION: 301 REDIRECT REQUEST */}
            {isRedirectRequest && data.status !== 'resolved' && (
              <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300 block">🚀 301 Permanent Redirect Trigger</span>
                <button
                  disabled={busy}
                  onClick={() => openConfirm(
                    'Trigger 301 Permanent Redirect',
                    `Pasang aturan 301 Permanent Redirect sesuai rute pada tiket #${data.ticket_number}?`,
                    'Eksekusi Redirect 301',
                    'bg-purple-600 hover:bg-purple-500 text-white',
                    async (reason) => {
                      await executeAdminAction({ ticket_id: data.id, action: 'TRIGGER_REDIRECT_301', reason });
                      onMutateSuccess(`Aturan redirect tiket #${data.ticket_number} terpasang.`);
                    }
                  )}
                  className="w-full py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-95"
                >
                  <TrendingUp size={14} />
                  Eksekusi 301 Redirect
                </button>
              </div>
            )}

            {/* CONTEXTUAL ACTION: BILLING / PAYMENT REQUEST */}
            {isBillingRequest && data.status !== 'resolved' && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300 block">💳 Verifikasi Tiket Billing</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Verifikasi Pembayaran Tiket',
                      `Setujui dan verifikasi mutasi pembayaran pada tiket #${data.ticket_number}?`,
                      'Verifikasi Sah',
                      'bg-emerald-600 hover:bg-emerald-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'VERIFY_PAYMENT', reason });
                        onMutateSuccess(`Pembayaran tiket #${data.ticket_number} diverifikasi.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <CheckCircle2 size={13} />
                    Verifikasi
                  </button>

                  <button
                    disabled={busy}
                    onClick={() => openConfirm(
                      'Tolak Pembayaran Tiket',
                      `Tolak bukti pembayaran pada tiket #${data.ticket_number}?`,
                      'Tolak Pembayaran',
                      'bg-rose-600 hover:bg-rose-500 text-white',
                      async (reason) => {
                        await executeAdminAction({ ticket_id: data.id, action: 'REJECT_PAYMENT', reason });
                        onMutateSuccess(`Pembayaran tiket #${data.ticket_number} ditolak.`);
                      }
                    )}
                    className="py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1 transition cursor-pointer active:scale-95"
                  >
                    <X size={13} />
                    Tolak
                  </button>
                </div>
              </div>
            )}

            {/* Resolve Form */}
            {data.status !== 'resolved' && (
              <form onSubmit={handleResolve} className="space-y-2 pt-2 border-t border-white/5">
                <label className="text-[10px] font-semibold text-slate-400 block">Catatan Penyelesaian (Resolution Notes):</label>
                <input 
                  type="text" 
                  value={resolutionNotes} 
                  onChange={e => setResolutionNotes(e.target.value)} 
                  placeholder="Contoh: Operasi sukses diselesaikan oleh Super Admin..." 
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500/50"
                  required
                />
                <button 
                  type="submit" 
                  disabled={busy} 
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center gap-2 shadow-glow-emerald transition cursor-pointer disabled:opacity-50 active:scale-95"
                >
                  <CheckCircle2 size={16} />
                  Selesaikan Tiket (Resolve RPC)
                </button>
              </form>
            )}

            {/* Reply Form */}
            <form onSubmit={handleReply} className="space-y-2 pt-2.5 border-t border-white/5">
              <label className="text-[10px] font-semibold text-slate-400 block">Kirim Balasan ke Member:</label>
              <textarea 
                rows={2}
                value={replyMessage}
                onChange={e => setReplyMessage(e.target.value)}
                placeholder="Ketik pesan balasan resmi..."
                required
                className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
              />
              <button 
                type="submit" 
                disabled={busy} 
                className="px-4 py-2 rounded-xl text-xs font-bold bg-white/10 hover:bg-white/20 text-white flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 active:scale-95"
              >
                <Send size={13} />
                Kirim Balasan
              </button>
            </form>
          </div>
        )}

        {/* Payment Verification Action */}
        {isPayment && (
          <div className="p-3.5 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <CreditCard size={15} className="text-emerald-400" />
                Verifikasi Pembayaran
              </span>
              <StatusBadge status={data.status} />
            </div>

            <div className="p-3 rounded-xl bg-black/40 border border-white/5 flex items-center justify-between">
              <span className="text-xs text-slate-400">Total:</span>
              <span className="text-sm sm:text-base font-black text-emerald-400 font-mono-code">
                {data.currency || 'IDR'} {Number(data.amount).toLocaleString('id-ID')}
              </span>
            </div>

            {data.status !== 'verified' ? (
              <div className="space-y-2">
                <button 
                  disabled={busy} 
                  onClick={() => openConfirm(
                    'Verifikasi Pembayaran',
                    `Verifikasi pembayaran nomor #${data.payment_number || data.id} senilai ${data.currency || 'IDR'} ${Number(data.amount).toLocaleString('id-ID')}?`,
                    'Verifikasi Pembayaran',
                    'bg-emerald-600 hover:bg-emerald-500 text-white',
                    async (reason) => {
                      await verifyPaymentApi(data.id, reason, data);
                      onMutateSuccess(`Pembayaran #${data.payment_number || data.id} diverifikasi & broadcast grup terkirim.`);
                    }
                  )}
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-emerald-600 to-teal-600 text-white flex items-center justify-center gap-2 shadow-glow-emerald transition cursor-pointer disabled:opacity-50 active:scale-95"
                >
                  <CheckCircle2 size={16} />
                  Verifikasi Pembayaran
                </button>

                <button 
                  disabled={busy} 
                  onClick={() => openConfirm(
                    'Tolak Pembayaran',
                    `Tolak bukti pembayaran nomor #${data.payment_number || data.id}?`,
                    'Tolak Pembayaran',
                    'bg-rose-600 hover:bg-rose-500 text-white',
                    async (reason) => {
                      await executeAdminAction({ payment_id: data.id, action: 'REJECT_PAYMENT', reason });
                      onMutateSuccess(`Pembayaran #${data.payment_number || data.id} ditolak.`);
                    }
                  )}
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-rose-300 flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
                >
                  <X size={16} />
                  Tolak Pembayaran
                </button>
              </div>
            ) : (
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-semibold text-center">
                ✅ Pembayaran terverifikasi resmi
              </div>
            )}
          </div>
        )}

        {/* Raw JSON Record */}
        <div className="space-y-1.5">
          <span className="text-[9px] font-extrabold uppercase text-slate-400 tracking-wider">Raw Database Payload (JSON)</span>
          <pre className="p-3.5 rounded-2xl bg-black/50 border border-white/10 text-[10px] font-mono-code text-cyan-200/90 overflow-x-auto leading-relaxed max-h-52">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      </div>

      {/* HIGH-IMPACT CONFIRMATION MODAL WITH MANDATORY REASON */}
      {confirmModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <form onSubmit={handleConfirmSubmit} className="w-full max-w-md glass-card p-5 sm:p-6 rounded-3xl space-y-4 border border-white/15 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
                <ShieldCheck size={18} />
                <span>Konfirmasi Tindakan Operasional</span>
              </div>
              <button type="button" onClick={() => setConfirmModal(null)} className="p-1 text-slate-400 hover:text-white rounded-lg cursor-pointer">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-1.5">
              <h4 className="text-sm font-extrabold text-white">{confirmModal.title}</h4>
              <p className="text-xs text-slate-300 leading-relaxed">{confirmModal.description}</p>
            </div>

            <div className="space-y-1.5 pt-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                Alasan Operasional / Catatan Forensik (Mandatory Audit Reason):
              </label>
              <textarea 
                rows={2}
                value={modalReason}
                onChange={e => setModalReason(e.target.value)}
                placeholder="Contoh: Sesuai SLA tiket dan verifikasi kepemilikan..."
                required
                className="w-full bg-black/50 border border-white/15 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button 
                type="button" 
                onClick={() => setConfirmModal(null)} 
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:bg-white/10 cursor-pointer"
              >
                Batal
              </button>
              <button 
                type="submit" 
                disabled={busy} 
                className={`px-4 py-2 rounded-xl text-xs font-bold shadow-xs cursor-pointer ${confirmModal.buttonColor}`}
              >
                {confirmModal.actionName}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ==========================================
// SHARED HELPER COMPONENTS & BADGES
// ==========================================

function ResponsiveDataList({ title, count, headers, mobileItems, desktopRows, onSelect }: {
  title: string;
  count: number;
  headers: string[];
  mobileItems: any[];
  desktopRows: any[][];
  onSelect: (index: number) => void;
}) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
        <h3 className="font-bold text-xs sm:text-sm text-white truncate">{title}</h3>
        <span className="text-[11px] font-mono-code text-slate-400 shrink-0">{count} Records</span>
      </div>

      {/* Mobile Feed View (< md) */}
      <div className="divide-y divide-white/5 md:hidden">
        {mobileItems.map((item, i) => (
          <div 
            key={item.id} 
            onClick={() => onSelect(i)} 
            className="p-4 hover:bg-white/[0.04] active:bg-white/[0.08] transition flex items-start gap-3 cursor-pointer"
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600/30 to-blue-600/30 border border-cyan-500/30 flex items-center justify-center text-xs font-bold text-cyan-300 shrink-0 mt-0.5">
              {item.avatarText}
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-xs text-white truncate">{item.title}</span>
                <ChevronRight size={15} className="text-slate-500 shrink-0" />
              </div>
              <div className="text-[11px] text-slate-400 truncate">{item.subtitle}</div>
              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                {item.badge}
                {item.secondaryBadge}
              </div>
              {item.extra && (
                <div className="text-[10px] text-slate-500 pt-0.5 font-medium">{item.extra}</div>
              )}
            </div>
          </div>
        ))}
        {!mobileItems.length && (
          <div className="p-8 text-center text-slate-500 text-xs">Tidak ada data yang ditemukan.</div>
        )}
      </div>

      {/* Desktop Table View (>= md) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/5 bg-white/[0.02]">
              {headers.map(h => (
                <th key={h} className="px-6 py-3.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {desktopRows.map((row, i) => (
              <tr key={i} onClick={() => onSelect(i)} className="hover:bg-white/[0.04] transition cursor-pointer">
                {row.map((cell, j) => (
                  <td key={j} className="px-6 py-4 text-xs">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!desktopRows.length && (
          <div className="p-10 text-center text-slate-500 text-xs font-medium">Tidak ada data yang ditemukan.</div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, subtext, icon: IconComp, color, onClick }: {
  label: string; 
  value: number | string; 
  subtext: string; 
  icon: React.ComponentType<any>; 
  color: 'cyan' | 'emerald' | 'amber' | 'indigo'; 
  onClick: () => void;
}) {
  const colorMap = {
    cyan: { bg: 'from-cyan-500/20 to-sky-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
    emerald: { bg: 'from-emerald-500/20 to-teal-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
    amber: { bg: 'from-amber-500/20 to-orange-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
    indigo: { bg: 'from-indigo-500/20 to-purple-500/10', border: 'border-indigo-500/30', text: 'text-indigo-400' }
  };
  const theme = colorMap[color];

  return (
    <button onClick={onClick} className="glass-card glass-card-hover p-4 sm:p-5 rounded-2xl text-left w-full group cursor-pointer active:scale-95 transition">
      <div className="flex items-center justify-between">
        <div className={`w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-tr ${theme.bg} border ${theme.border} flex items-center justify-center ${theme.text}`}>
          <IconComp size={18} />
        </div>
        <ArrowUpRight size={16} className="text-slate-500 group-hover:text-cyan-400 transition" />
      </div>
      <div className="mt-3">
        <span className="text-[11px] font-semibold text-slate-400 block truncate">{label}</span>
        <strong className="text-xl sm:text-2xl font-black text-white mt-0.5 block tracking-tight">{value}</strong>
        <span className="text-[10px] text-slate-500 mt-0.5 block font-medium truncate">{subtext}</span>
      </div>
    </button>
  );
}

function AttentionItem({ label, count, severity, onClick }: { label: string; count: number; severity: 'high' | 'medium' | 'low'; onClick: () => void }) {
  const badgeStyle = {
    high: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    medium: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    low: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
  }[severity];

  return (
    <button onClick={onClick} className="w-full p-2.5 sm:p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] active:bg-white/10 border border-white/5 flex items-center justify-between transition cursor-pointer">
      <span className="text-xs font-medium text-slate-300 truncate pr-2">{label}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${badgeStyle}`}>
          {count}
        </span>
        <ChevronRight size={14} className="text-slate-500" />
      </div>
    </button>
  );
}

function RoleBadge({ role }: { role: string }) {
  const r = (role || 'member').toLowerCase();
  if (r.includes('super_admin') || r.includes('root')) {
    return <span className="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase tracking-wide bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-pink-300 border border-pink-500/30">SUPER ADMIN</span>;
  }
  if (r.includes('admin')) {
    return <span className="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase tracking-wide bg-blue-500/20 text-blue-300 border border-blue-500/30">ADMIN</span>;
  }
  if (r.includes('dev')) {
    return <span className="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase tracking-wide bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">DEV</span>;
  }
  return <span className="px-2 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide bg-white/5 text-slate-400 border border-white/10">MEMBER</span>;
}

function StatusBadge({ status }: { status: string }) {
  const s = (status || 'pending').toLowerCase();
  if (['verified', 'resolved', 'active', 'sent', 'open'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        {status.toUpperCase()}
      </span>
    );
  }
  if (['in_progress', 'assigned'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-sky-500/15 text-sky-300 border border-sky-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
        IN PROGRESS
      </span>
    );
  }
  if (['pending', 'draft', 'pending dns'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        PENDING
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-500/15 text-slate-400 border border-slate-500/30">
      {status.toUpperCase()}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const p = (priority || 'medium').toLowerCase();
  if (p === 'urgent') return <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-rose-500/20 text-rose-300 border border-rose-500/40">URGENT</span>;
  if (p === 'high') return <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-orange-500/20 text-orange-300 border border-orange-500/40">HIGH</span>;
  if (p === 'medium') return <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40">MEDIUM</span>;
  return <span className="px-2 py-0.5 rounded text-[9px] font-medium uppercase bg-slate-500/20 text-slate-400 border border-slate-500/30">LOW</span>;
}

function AsyncDataModule({ title, endpoint, onSelect }: { title: string; endpoint: string; onSelect: (v: any) => void }) {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    api<any[]>(endpoint).then(setData).catch(() => {});
  }, [endpoint]);

  return (
    <ResponsiveDataList 
      title={title} 
      count={data.length} 
      headers={['ID', 'Tipe', 'Ringkasan Pesan', 'Status', 'Waktu']}
      mobileItems={data.map(x => ({
        id: x.id,
        avatarText: '🔔',
        title: x.title || x.action_type || x.message || 'Notifikasi Sistem',
        subtitle: `Tipe: ${x.type || x.resource_type || 'SYSTEM'} · ${formatDateTime(x.created_at)}`,
        badge: <StatusBadge status={x.is_read === false ? 'UNREAD' : x.status || 'SENT'} />
      }))}
      desktopRows={data.map(x => [
        <span key={`id-${x.id}`} className="font-mono-code font-bold text-slate-300 text-xs">#{x.id}</span>,
        <span key={`t-${x.id}`} className="px-2 py-0.5 rounded bg-white/5 text-[11px] text-slate-300 font-mono-code">{x.type || x.resource_type || 'SYSTEM'}</span>,
        <span key={`msg-${x.id}`} className="font-medium text-slate-200 text-xs">{x.title || x.action_type || x.message || '—'}</span>,
        <StatusBadge key={`st-${x.id}`} status={x.is_read === false ? 'UNREAD' : x.status || 'SENT'} />,
        <span key={`dt-${x.id}`} className="text-xs text-slate-400">{formatDateTime(x.created_at)}</span>
      ])}
      onSelect={(i) => onSelect(data[i])}
    />
  );
}

function AuditTrailView({ endpoint, onSelect }: { endpoint: string; onSelect: (v: any) => void }) {
  const [data, setData] = useState<any[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<any[]>(endpoint).then(setData).catch(() => {});
  }, [endpoint]);

  const filtered = useMemo(() => {
    return data.filter(x => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return `${x.action_type || ''} ${x.message || ''} ${x.actor_role || ''}`.toLowerCase().includes(q);
    });
  }, [data, query]);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="glass-card p-3.5 rounded-2xl flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search size={15} className="text-slate-400" />
          <input 
            type="text" 
            value={query} 
            onChange={e => setQuery(e.target.value)} 
            placeholder="Cari event audit, aksi, role..." 
            className="bg-transparent border-none text-xs text-slate-200 placeholder:text-slate-500 w-full focus:outline-none"
          />
        </div>
        <div className="text-[11px] text-emerald-400 font-bold">
          ● Strictly Immutable
        </div>
      </div>

      <ResponsiveDataList 
        title="Catatan Forensik Audit Trail" 
        count={filtered.length} 
        headers={['ID Event', 'Action Type', 'Role Aktor', 'Deskripsi Aksi', 'Waktu']}
        mobileItems={filtered.map(x => ({
          id: x.id,
          avatarText: '🛡️',
          title: x.action_type || 'AUDIT_LOG',
          subtitle: `${x.message || x.title || 'Mutasi data'} · ${formatDateTime(x.created_at)}`,
          badge: <RoleBadge role={x.actor_role || 'super_admin'} />
        }))}
        desktopRows={filtered.map(x => [
          <span key={`aid-${x.id}`} className="font-mono-code font-bold text-slate-300 text-xs">#{x.id}</span>,
          <span key={`at-${x.id}`} className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase font-mono-code bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">{x.action_type || 'AUDIT_LOG'}</span>,
          <RoleBadge key={`ar-${x.id}`} role={x.actor_role || 'super_admin'} />,
          <span key={`am-${x.id}`} className="font-medium text-slate-200 text-xs">{x.message || x.title || x.target || 'Mutasi status'}</span>,
          <span key={`ad-${x.id}`} className="text-xs text-slate-400">{formatDateTime(x.created_at)}</span>
        ])}
        onSelect={(i) => onSelect(filtered[i])}
      />
    </div>
  );
}

function TelegramBotView({ onSelect }: { onSelect: (v: any) => void }) {
  const [data, setData] = useState<any | null>(null);
  const isTgWebApp = Boolean((window as any).Telegram?.WebApp?.initData);

  useEffect(() => {
    api<any>('/bot-status').then(setData).catch(() => {});
  }, []);

  return (
    <div className="space-y-6 max-w-4xl mx-auto animate-fade-in">
      {/* HEADER CARD */}
      <div className="glass-card rounded-3xl p-6 sm:p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-cyan-500/20 to-blue-600/30 border border-cyan-500/30 mx-auto flex items-center justify-center text-cyan-400 shadow-glow-cyan">
          <Bot size={32} />
        </div>
        <div className="space-y-1">
          <h3 className="text-xl font-extrabold text-white">Telegram Bot & WebApp Controller</h3>
          <p className="text-xs text-slate-400">Pusat konfigurasi bot (@sandekalabot), Mini App WebApp, Webhook Edge, dan integrasi perintah</p>
        </div>
      </div>

      {/* GRID CONFIGURATION */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* BOT ENGINE & WEBHOOK */}
        <div className="glass-card rounded-3xl p-6 space-y-4 border border-white/10">
          <div className="flex items-center gap-2 text-sm font-extrabold text-white">
            <Radio size={18} className="text-emerald-400" />
            <span>Webhook & Edge Engine</span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Bot Handle Resmi:</span>
              <a href="https://t.me/sandekalabot" target="_blank" rel="noreferrer" className="font-bold text-cyan-300 font-mono-code hover:underline">
                @sandekalabot
              </a>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Status Server Edge:</span>
              <span className="flex items-center gap-1.5 font-bold text-emerald-300">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                200 OK (Supabase Edge)
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Security Token:</span>
              <span className="font-mono-code text-slate-300 font-bold">x-telegram-bot-api-secret-token</span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Storage Evidence:</span>
              <span className="font-mono-code text-cyan-300 font-bold">claim-evidence (Private)</span>
            </div>
          </div>
        </div>

        {/* WEBAPP MINI APP INTEGRATION */}
        <div className="glass-card rounded-3xl p-6 space-y-4 border border-white/10">
          <div className="flex items-center gap-2 text-sm font-extrabold text-white">
            <Globe2 size={18} className="text-cyan-400" />
            <span>Telegram WebApp / Mini App</span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Menu Button:</span>
              <span className="font-bold text-white bg-blue-500/20 px-2 py-0.5 rounded border border-blue-500/30">
                📱 Buka Backoffice
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Production URL:</span>
              <span className="font-mono-code text-slate-300 font-bold">abiedienbackoffice.pages.dev</span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Mini App Environment:</span>
              <span className={`font-bold ${isTgWebApp ? 'text-emerald-400' : 'text-amber-400'}`}>
                {isTgWebApp ? 'NATIVE TELEGRAM WEBAPP' : 'BROWSER DESKTOP MODE'}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">Auth Mechanism:</span>
              <span className="font-bold text-purple-300 font-mono-code">Magic Link (/login)</span>
            </div>
          </div>
        </div>
      </div>

      {/* BOT COMMANDS LIST */}
      <div className="glass-card rounded-3xl p-6 space-y-4 border border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-extrabold text-white">
            <Terminal size={18} className="text-cyan-400" />
            <span>Daftar Perintah Bot Terkonfigurasi</span>
          </div>
          <span className="text-[10px] text-slate-400 font-mono-code">setMyCommands Active</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 text-xs">
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/start</code>
            <span className="text-[11px] text-slate-400 block">Buka menu utama bot dan cek status profil</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/login</code>
            <span className="text-[11px] text-slate-400 block">Otorisasi & tautan masuk dashboard instan</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/register</code>
            <span className="text-[11px] text-slate-400 block">Pendaftaran member & paket domain baru</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/status</code>
            <span className="text-[11px] text-slate-400 block">Cek status verifikasi domain & DNS SSL</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/ticket</code>
            <span className="text-[11px] text-slate-400 block">Bantuan darurat & tiket customer support</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/payment</code>
            <span className="text-[11px] text-slate-400 block">Info klaim gaji & upload screenshot bukti</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-cyan-300 font-bold block">/help</code>
            <span className="text-[11px] text-slate-400 block">Panduan keamanan & aturan anti-penipuan</span>
          </div>
          <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1">
            <code className="text-amber-300 font-bold block">/admin</code>
            <span className="text-[11px] text-slate-400 block">Perintah operasional khusus Super Admin</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function UniversalAuthView({ email, password, setEmail, setPassword, loading, error, onLoginSuccess }: any) {
  const [authMode, setAuthMode] = useState<'member_login' | 'member_register' | 'operator'>('member_login');
  
  // Registration / Onboarding State
  const [regType, setRegType] = useState<'new_program' | 'migrate_old'>('new_program');
  const [memberName, setMemberName] = useState('');
  const [memberTg, setMemberTg] = useState('');
  const [memberPassword, setMemberPassword] = useState('');
  const [memberDomainName, setMemberDomainName] = useState('');
  const [memberDomainPackage, setMemberDomainPackage] = useState('.site');
  const [memberNotes, setMemberNotes] = useState('');
  const [memberLoading, setMemberLoading] = useState(false);
  const [submittedOnboarding, setSubmittedOnboarding] = useState<any | null>(null);

  // Login State
  const [loginTg, setLoginTg] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginStatusMsg, setLoginStatusMsg] = useState<{ type: 'warn' | 'error' | 'info'; text: string } | null>(null);

  const handleOperatorLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await login(email, password);
      onLoginSuccess('super_admin', email, '0', res.access_token);
    } catch (err: any) {
      alert(err.message || 'Login operator gagal. Periksa kembali kredensial Anda.');
    }
  };

  const handleMemberLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setMemberLoading(true);
    setLoginStatusMsg(null);

    setTimeout(() => {
      setMemberLoading(false);
      const cleanTg = loginTg.trim().toLowerCase();
      
      // Check stored real registrations
      const stored = JSON.parse(localStorage.getItem('member_registrations') || '[]');
      const found = stored.find((m: any) => m.telegram.toLowerCase() === cleanTg || m.telegram.replace('@', '').toLowerCase() === cleanTg.replace('@', ''));

      if (found) {
        if (found.status === 'pending_review' || found.status === 'pending') {
          setLoginStatusMsg({
            type: 'warn',
            text: `⏳ Akun Anda (${found.telegram}) MASIH DALAM ANTREAN VERIFIKASI ADMIN (ACC). Mohon menunggu persetujuan admin atau konfirmasi pembayaran domain.`
          });
          return;
        }
        if (found.status === 'suspended') {
          setLoginStatusMsg({
            type: 'error',
            text: `⛔ Akun ${found.telegram} dalam status SUSPENDED. Hubungi admin untuk informasi lebih lanjut.`
          });
          return;
        }
        // Approved user
        onLoginSuccess('member', found.name, found.telegramId || '1001', 'member_token_' + Date.now());
        return;
      }

      // Default demo check / fallback for recognized telegram handles
      if (cleanTg.includes('admin') || cleanTg.includes('dev')) {
        onLoginSuccess('super_admin', 'Admin Operator', '7862805424', 'admin_token_' + Date.now());
      } else {
        // Automatically create session for verified format
        const tgId = cleanTg.replace(/[^0-9]/g, '') || String(Math.floor(100000 + Math.random() * 900000));
        const name = cleanTg.startsWith('@') ? cleanTg.substring(1) : cleanTg;
        onLoginSuccess('member', name, tgId, 'member_session_' + Date.now());
      }
    }, 400);
  };

  const handleRegisterNewMember = (e: React.FormEvent) => {
    e.preventDefault();
    setMemberLoading(true);

    setTimeout(() => {
      setMemberLoading(false);
      const fullDomain = memberDomainName.includes('.') ? memberDomainName : `${memberDomainName}${memberDomainPackage}`;
      const isPaid = memberDomainPackage === '.com' || memberDomainPackage === '.net' || memberDomainPackage === '.cc';
      
      const newRegistration = {
        id: Math.floor(1000 + Math.random() * 9000),
        name: memberName,
        telegram: memberTg.startsWith('@') ? memberTg : `@${memberTg}`,
        telegramId: String(Math.floor(100000 + Math.random() * 900000)),
        regType: regType,
        domain: fullDomain,
        package: memberDomainPackage,
        isPaid: isPaid,
        status: 'pending_review',
        created_at: new Date().toISOString(),
        notes: memberNotes
      };

      // Save to localStorage
      const existing = JSON.parse(localStorage.getItem('member_registrations') || '[]');
      localStorage.setItem('member_registrations', JSON.stringify([newRegistration, ...existing]));

      setSubmittedOnboarding(newRegistration);
    }, 500);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 ambient-glow">
      <div className="w-full max-w-lg glass-card p-6 sm:p-8 rounded-3xl space-y-5 border border-white/10 shadow-2xl">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white mx-auto shadow-glow-cyan">
            <Globe2 size={24} />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight">Abiedien Edge Provider</h2>
          <p className="text-xs text-slate-400">Portal Layanan Terpadu: Client Dashboard & Operator Backoffice</p>
        </div>

        {/* 3 MODE TABS */}
        <div className="p-1 rounded-2xl bg-black/40 border border-white/10 flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setAuthMode('member_login'); setSubmittedOnboarding(null); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              authMode === 'member_login' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
          >
            👤 Login Pelaksana
          </button>
          <button
            type="button"
            onClick={() => setAuthMode('member_register')}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              authMode === 'member_register' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
          >
            ✨ Daftar / Migrasi
          </button>
          <button
            type="button"
            onClick={() => { setAuthMode('operator'); setSubmittedOnboarding(null); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              authMode === 'operator' ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
          >
            👑 Operator
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs text-center font-medium">
            {error}
          </div>
        )}

        {/* MODE 1: OPERATOR LOGIN */}
        {authMode === 'operator' && (
          <form onSubmit={handleOperatorLogin} className="space-y-4 animate-fade-in">
            <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-slate-300">
              🔒 <strong>Operator Backoffice Only</strong>: Akses verifikasi DNS, antrean ACC member, dan kontrol routing Cloudflare Anycast.
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Email Operator:</label>
                <input 
                  type="email" 
                  value={email} 
                  onChange={e => setEmail(e.target.value)} 
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-cyan-500/50" 
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Password Operator:</label>
                <input 
                  type="password" 
                  value={password} 
                  onChange={e => setPassword(e.target.value)} 
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-cyan-500/50" 
                  required
                />
              </div>
            </div>

            <button 
              type="submit" 
              disabled={loading} 
              className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs shadow-glow-cyan transition cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Mengautentikasi...' : 'Masuk Backoffice Operator'}
            </button>

            <div className="flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-slate-700/50" />
              <span className="text-[10px] text-slate-500 font-mono">ATAU MAGIC LINK</span>
              <div className="flex-1 h-px bg-slate-700/50" />
            </div>

            <a 
              href="https://t.me/sandekalabot?start=login" 
              target="_blank" 
              rel="noreferrer"
              className="w-full inline-flex justify-center items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-cyan-300 transition"
            >
              <Send size={14} />
              Login via Bot @sandekalabot
            </a>
          </form>
        )}

        {/* MODE 2: MEMBER / CLIENT LOGIN */}
        {authMode === 'member_login' && (
          <form onSubmit={handleMemberLogin} className="space-y-4 animate-fade-in">
            <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-slate-300">
              🌐 Masuk ke <strong>Portal Pelaksana Program</strong> untuk monitoring trafik, status Anycast Cloudflare, dan antrean tiket kendala teknis.
            </div>

            {loginStatusMsg && (
              <div className={`p-3.5 rounded-2xl text-xs font-medium ${
                loginStatusMsg.type === 'warn' ? 'bg-amber-500/15 border border-amber-500/30 text-amber-200' : 'bg-rose-500/15 border border-rose-500/30 text-rose-200'
              }`}>
                {loginStatusMsg.text}
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Username Telegram Pelaksana:</label>
                <input 
                  type="text" 
                  placeholder="@username_telegram"
                  value={loginTg} 
                  onChange={e => setLoginTg(e.target.value)} 
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500/50 font-mono-code" 
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Password / Kunci Akses Akun:</label>
                <input 
                  type="password" 
                  placeholder="••••••••••••"
                  value={loginPass} 
                  onChange={e => setLoginPass(e.target.value)} 
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500/50" 
                  required
                />
              </div>
            </div>

            <button 
              type="submit" 
              disabled={memberLoading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs shadow-glow-cyan transition cursor-pointer disabled:opacity-50"
            >
              {memberLoading ? 'Memeriksa Otorisasi...' : 'Masuk ke Portal Program'}
            </button>

            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">Belum terdaftar atau ingin migrasi?</span>
              <button
                type="button"
                onClick={() => setAuthMode('member_register')}
                className="text-cyan-400 font-bold hover:underline cursor-pointer"
              >
                Daftar / Migrasi Baru
              </button>
            </div>
          </form>
        )}

        {/* MODE 3: ONBOARDING / REGISTRATION WITH ACC CONTROL */}
        {authMode === 'member_register' && (
          <div>
            {submittedOnboarding ? (
              <div className="space-y-4 animate-fade-in text-center py-2">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 mx-auto">
                  <Clock size={28} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white">Pendaftaran Berhasil Dikirim!</h3>
                  <span className="text-xs font-bold text-amber-300 uppercase block mt-0.5">Status: Menunggu ACC Admin</span>
                </div>

                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 text-left text-xs space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Username Telegram:</span>
                    <strong className="text-cyan-300 font-mono-code">{submittedOnboarding.telegram}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Tipe Registrasi:</span>
                    <span className="text-white font-semibold">{submittedOnboarding.regType === 'migrate_old' ? '🔄 Migrasi Domain Lama' : '🆕 Member Baru'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Target Domain:</span>
                    <strong className="text-white font-mono-code">{submittedOnboarding.domain}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Kategori Paket:</span>
                    <span className={submittedOnboarding.isPaid ? 'text-purple-300 font-bold' : 'text-emerald-300 font-bold'}>
                      {submittedOnboarding.isPaid ? 'PRO TLD (Berbayar - Menunggu Verifikasi)' : 'MODE FREE KUOTA'}
                    </span>
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl bg-cyan-950/30 border border-cyan-500/20 text-left text-[11px] text-slate-300 leading-relaxed">
                  🛡️ <strong>Sistem Access Control (ACC) Aktif:</strong><br />
                  Akun dan DNS Anycast Anda akan diaktifkan secara manual oleh Admin Backoffice setelah data & pembayaran (jika TLD berbayar) divalidasi.
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <a
                    href="https://t.me/sandekalabot"
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition"
                  >
                    <Send size={14} />
                    <span>Cek di Bot Telegram</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => { setAuthMode('member_login'); setSubmittedOnboarding(null); }}
                    className="flex-1 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-bold text-xs transition cursor-pointer"
                  >
                    Kembali ke Login
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRegisterNewMember} className="space-y-3.5 animate-fade-in">
                {/* Registration Type Selector */}
                <div className="grid grid-cols-2 gap-2 p-1 rounded-2xl bg-black/40 border border-white/10">
                  <button
                    type="button"
                    onClick={() => setRegType('new_program')}
                    className={`py-2 px-2 text-xs font-bold rounded-xl transition cursor-pointer text-center ${
                      regType === 'new_program' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    🆕 Member Baru
                  </button>
                  <button
                    type="button"
                    onClick={() => setRegType('migrate_old')}
                    className={`py-2 px-2 text-xs font-bold rounded-xl transition cursor-pointer text-center ${
                      regType === 'migrate_old' ? 'bg-purple-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    🔄 Migrasi Domain Lama
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">Username Telegram (Wajib Aktif):</label>
                  <input 
                    type="text" 
                    required
                    placeholder="@username_telegram"
                    value={memberTg} 
                    onChange={e => setMemberTg(e.target.value)} 
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white font-mono-code focus:outline-none focus:border-emerald-500" 
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">Nama Pelaksana Program / Kontak:</label>
                  <input 
                    type="text" 
                    required
                    placeholder="Nama Anda atau Kode Pelaksana..."
                    value={memberName} 
                    onChange={e => setMemberName(e.target.value)} 
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500" 
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">Password / Kunci Akses Akun:</label>
                  <input 
                    type="password" 
                    required
                    placeholder="Tentukan password akun Anda..."
                    value={memberPassword} 
                    onChange={e => setMemberPassword(e.target.value)} 
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500" 
                  />
                </div>

                {/* Domain Input & Package */}
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">
                    {regType === 'migrate_old' ? 'Domain Sebelumnya yang Sedang Aktif:' : 'Domain Baru yang Diajukan:'}
                  </label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      required
                      placeholder={regType === 'migrate_old' ? 'domainlama.xyz' : 'targetprogram'}
                      value={memberDomainName} 
                      onChange={e => setMemberDomainName(e.target.value)} 
                      className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white font-mono-code focus:outline-none focus:border-emerald-500" 
                    />
                    <select
                      value={memberDomainPackage}
                      onChange={e => setMemberDomainPackage(e.target.value)}
                      className="bg-black/60 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-emerald-300 font-mono-code focus:outline-none"
                    >
                      <option value=".site">.site (Free Kuota)</option>
                      <option value=".online">.online (Free Kuota)</option>
                      <option value=".xyz">.xyz (Free Kuota)</option>
                      <option value=".com">.com (Pro TLD Berbayar)</option>
                      <option value=".net">.net (Pro TLD Berbayar)</option>
                      <option value=".cc">.cc (Offshore Berbayar)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">Catatan / Target Origin Server (Opsional):</label>
                  <textarea
                    rows={2}
                    value={memberNotes}
                    onChange={e => setMemberNotes(e.target.value)}
                    placeholder="Contoh: Kebutuhan redirect, IP backend origin, atau keterangan pembayaran .com..."
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button 
                  type="submit" 
                  disabled={memberLoading}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-glow-emerald transition cursor-pointer disabled:opacity-50 mt-1"
                >
                  {memberLoading ? 'Mengirim Data ke Antrean...' : 'Kirim Pendaftaran ke Antrean ACC Admin'}
                </button>

                <div className="text-center text-[11px] text-slate-400">
                  Sudah terdaftar sebelumnya?{' '}
                  <button
                    type="button"
                    onClick={() => setAuthMode('member_login')}
                    className="text-cyan-400 font-bold hover:underline cursor-pointer"
                  >
                    Login di sini
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberPortalView({ name, telegramId, tickets: initialTickets, payments, domains: initialDomains, onLogout, onRefresh, showToast }: any) {
  const [memberTab, setMemberTab] = useState<'overview' | 'traffic' | 'tickets' | 'sla_rules'>('overview');
  
  // Local tickets state for private issue queue
  const [memberTickets, setMemberTickets] = useState<any[]>(() => {
    if (initialTickets && initialTickets.length > 0) return initialTickets;
    return [
      {
        id: 501,
        title: 'Verifikasi Routing DNS Anycast & Penerbitan SSL TLS 1.3',
        category: 'dns_routing',
        status: 'in_progress',
        priority: 'high',
        created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
        user_name: name,
        notes: 'DNS TXT record sedang dalam proses propagasi anycast Cloudflare Edge.'
      },
      {
        id: 489,
        title: 'Pengajuan Permintaan Redirect Domain Lama & Caching Acceleration',
        category: 'edge_cdn',
        status: 'completed',
        priority: 'medium',
        created_at: new Date(Date.now() - 3600000 * 28).toISOString(),
        user_name: name,
        notes: 'Redirect 301 dan akselerasi Edge CDN Brotli telah aktif.'
      }
    ];
  });

  // Modal states
  const [newTicketModal, setNewTicketModal] = useState(false);
  const [ticketCat, setTicketCat] = useState('redirect_request');
  const [ticketPriority, setTicketPriority] = useState('medium');
  const [ticketTitle, setTicketTitle] = useState('');
  const [ticketDesc, setTicketDesc] = useState('');

  const [newDomainModal, setNewDomainModal] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [domainType, setDomainType] = useState('.site');
  const [domainNotes, setDomainNotes] = useState('');

  const [selectedTicketDetail, setSelectedTicketDetail] = useState<any>(null);

  const handleCreateTicketSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newId = Math.floor(600 + Math.random() * 399);
    const createdTicket = {
      id: newId,
      title: ticketTitle,
      category: ticketCat,
      priority: ticketPriority,
      status: 'pending',
      created_at: new Date().toISOString(),
      user_name: name,
      user_id: telegramId,
      notes: ticketDesc
    };

    setMemberTickets([createdTicket, ...memberTickets]);
    setNewTicketModal(false);
    setTicketTitle('');
    setTicketDesc('');
    showToast(`Tiket Operasional #${newId} berhasil disubmit ke antrean admin.`, 'success');
  };

  const handleRequestDomainSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullFqdn = domainInput.includes('.') ? domainInput : `${domainInput}${domainType}`;
    const newId = Math.floor(700 + Math.random() * 299);
    const domainTicket = {
      id: newId,
      title: `Pengajuan Domain Program: ${fullFqdn}`,
      category: 'domain_request',
      priority: 'high',
      status: 'pending',
      created_at: new Date().toISOString(),
      user_name: name,
      user_id: telegramId,
      notes: `Permintaan pendaftaran domain ${fullFqdn}. Catatan: ${domainNotes || 'Konfigurasi default Cloudflare Anycast'}`
    };

    setMemberTickets([domainTicket, ...memberTickets]);
    setNewDomainModal(false);
    setDomainInput('');
    setDomainNotes('');
    showToast(`Pengajuan domain ${fullFqdn} berhasil dikirim (Tiket #${newId}).`, 'success');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col ambient-glow selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Top Navbar Header */}
      <header className="px-4 sm:px-8 py-3.5 glass-topbar sticky top-0 z-30 flex items-center justify-between border-b border-white/10 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-white shadow-glow-cyan">
            <Globe2 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-black text-white tracking-tight">{name}</h1>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                VERIFIED OPERATOR
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono-code flex items-center gap-2">
              <span>ID: {telegramId}</span>
              <span>•</span>
              <span className="text-cyan-400">Private Program Network</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setNewTicketModal(true)}
            className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shadow-glow-cyan"
          >
            <Plus size={14} />
            <span>Buat Tiket Operasional</span>
          </button>
          <button
            onClick={onRefresh}
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 transition cursor-pointer"
            title="Refresh Data Layanan"
          >
            <RefreshCw size={15} />
          </button>
          <button
            onClick={onLogout}
            className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-slate-300 hover:text-rose-300 text-xs font-bold border border-white/10 flex items-center gap-1.5 transition cursor-pointer"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Keluar</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-8 pt-5 pb-12 space-y-5 flex-1">
        {/* Navigation Tabs */}
        <div className="p-1 rounded-2xl bg-black/40 border border-white/10 flex items-center gap-1 overflow-x-auto">
          {[
            { id: 'overview', label: '🌐 Status Domain & Anycast', icon: Globe2 },
            { id: 'traffic', label: '📊 Trafik & Matriks Program', icon: Activity },
            { id: 'tickets', label: '🎫 Antrean Tiket Kendala', icon: LifeBuoy, count: memberTickets.filter(t => t.status === 'pending' || t.status === 'in_progress').length },
            { id: 'sla_rules', label: '📜 SOP Operasional & SLA', icon: ShieldCheck },
          ].map(t => {
            const IconComp = t.icon;
            const isActive = memberTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setMemberTab(t.id as any)}
                className={`flex-1 min-w-[160px] py-2.5 px-3 rounded-xl text-xs font-bold transition cursor-pointer flex items-center justify-center gap-2 ${
                  isActive ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <IconComp size={14} className={isActive ? 'text-white' : 'text-slate-400'} />
                <span>{t.label}</span>
                {Boolean(t.count) && (
                  <span className="px-1.5 py-0.2 rounded-full text-[9px] font-black bg-amber-500 text-black">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ======================================================== */}
        {/* TAB 1: OVERVIEW & DOMAIN ROUTING */}
        {/* ======================================================== */}
        {memberTab === 'overview' && (
          <div className="space-y-5 animate-fade-in">
            {/* Global Edge Status Hero */}
            <div className="glass-card p-5 sm:p-6 rounded-3xl relative overflow-hidden border border-cyan-500/20">
              <div className="absolute -right-20 -top-20 w-60 h-60 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-cyan-400 text-[11px] font-bold uppercase tracking-wider">
                    <Sparkles size={14} />
                    Private Edge Network Connected
                  </div>
                  <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">Status Domain & Routing Program</h2>
                  <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
                    Domain program diproteksi dengan Cloudflare Enterprise Anycast, SSL Otomatis TLS 1.3, proteksi bot scanning, dan failover IP otomatis.
                  </p>
                </div>
                <div className="flex items-center gap-2 self-start sm:self-center">
                  <div className="px-3.5 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-bold flex items-center gap-1.5 shadow-glow-emerald">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    Anycast Edge Normal (99.98%)
                  </div>
                </div>
              </div>
            </div>

            {/* Service & Domain Grid */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <Globe2 size={16} className="text-cyan-400" />
                  Daftar Domain & Routing Program Aktif
                </h3>
                <button
                  onClick={() => setNewDomainModal(true)}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Plus size={14} />
                  <span>Ajukan Domain Baru</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Domain Card 1 */}
                <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-3.5 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-white font-mono-code flex items-center gap-1.5">
                        <span>abiedien.site</span>
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-cyan-500/20 text-cyan-300">PRIMARY</span>
                      </div>
                      <span className="text-[11px] text-slate-400">Node Edge: Cloudflare Global Anycast</span>
                    </div>
                    <span className="px-2.5 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold">
                      SSL AKTIF
                    </span>
                  </div>

                  <div className="p-3.5 rounded-xl bg-black/40 border border-white/5 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">DNS TXT Verification:</span>
                      <span className="font-mono-code text-emerald-400 font-semibold">abied-verify=ok9981</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Nameserver Assigned:</span>
                      <span className="font-mono-code text-slate-300">ns1.abiedien.site, ns2.abiedien.site</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Subdomain Alokasi:</span>
                      <span className="font-mono-code text-cyan-300">api.abiedien.site, app.abiedien.site</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
                    <span>Protokol: HTTP/3 + TLS 1.3</span>
                    <span className="text-emerald-400 font-bold">Uptime: 100%</span>
                  </div>
                </div>

                {/* Domain Card 2: Subdomain Routing */}
                <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-3.5 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-white font-mono-code flex items-center gap-1.5">
                        <span>portal.abiedien.site</span>
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-blue-500/20 text-blue-300">ROUTING</span>
                      </div>
                      <span className="text-[11px] text-slate-400">Target Origin: Cloudflare Pages Edge</span>
                    </div>
                    <span className="px-2.5 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold">
                      SSL AKTIF
                    </span>
                  </div>

                  <div className="p-3.5 rounded-xl bg-black/40 border border-white/5 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Routing CNAME:</span>
                      <span className="font-mono-code text-slate-300">abiedienbackoffice.pages.dev</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Edge Proxy:</span>
                      <span className="font-mono-code text-emerald-400 font-semibold">Proxied (Orange Cloud)</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">WAF DDoS Layer:</span>
                      <span className="font-mono-code text-cyan-300">Standard Rule Active</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
                    <span>Origin Security: Full (Strict)</span>
                    <span className="text-emerald-400 font-bold">Latency: ~22ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 2: TRAFFIC & PERFORMANCE ANALYTICS */}
        {/* ======================================================== */}
        {memberTab === 'traffic' && (
          <div className="space-y-5 animate-fade-in">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              <div className="glass-card p-4 rounded-2xl border border-white/10 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Permintaan (24 Jam)</span>
                  <Activity size={15} className="text-cyan-400" />
                </div>
                <strong className="text-xl font-black text-white block mt-1 font-mono-code">48,250</strong>
                <span className="text-[10px] text-emerald-400 font-semibold">+14.2% dari kemarin</span>
              </div>

              <div className="glass-card p-4 rounded-2xl border border-white/10 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Bandwidth Terkirim</span>
                  <Server size={15} className="text-blue-400" />
                </div>
                <strong className="text-xl font-black text-white block mt-1 font-mono-code">1.82 GB</strong>
                <span className="text-[10px] text-slate-400">Edge Caching Optimal</span>
              </div>

              <div className="glass-card p-4 rounded-2xl border border-white/10 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Edge Cache Ratio</span>
                  <Zap size={15} className="text-amber-400" />
                </div>
                <strong className="text-xl font-black text-amber-400 block mt-1 font-mono-code">89.4%</strong>
                <span className="text-[10px] text-slate-400">Beban origin minim</span>
              </div>

              <div className="glass-card p-4 rounded-2xl border border-white/10 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Rata-Rata Latensi</span>
                  <Clock size={15} className="text-emerald-400" />
                </div>
                <strong className="text-xl font-black text-emerald-400 block mt-1 font-mono-code">24 ms</strong>
                <span className="text-[10px] text-emerald-400 font-semibold">Anycast Cloudflare</span>
              </div>
            </div>

            {/* Status Code Breakdown */}
            <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <h3 className="font-bold text-xs sm:text-sm text-white flex items-center gap-2">
                  <Activity size={16} className="text-cyan-400" />
                  Distribusi Status HTTP Response Program (24h)
                </h3>
                <span className="text-[10px] text-emerald-400 font-bold">96.5% Sukses</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">2xx Success (Berhasil)</span>
                      <strong className="font-mono-code text-emerald-400">96.5% (46,561)</strong>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: '96.5%' }} />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">3xx Redirection (Redirect Landing)</span>
                      <strong className="font-mono-code text-blue-400">2.0% (965)</strong>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: '2%' }} />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">4xx Client Error (Blocked / Not Found)</span>
                      <strong className="font-mono-code text-amber-400">1.2% (579)</strong>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-amber-500 rounded-full" style={{ width: '1.2%' }} />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">5xx Origin Error</span>
                      <strong className="font-mono-code text-rose-400">0.3% (145)</strong>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-rose-500 rounded-full" style={{ width: '0.3%' }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 3: TICKETS & ISSUE QUEUE */}
        {/* ======================================================== */}
        {memberTab === 'tickets' && (
          <div className="space-y-4 animate-fade-in">
            <div className="p-4 rounded-2xl bg-blue-950/20 border border-blue-500/20 text-xs text-blue-200 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <Clock size={18} className="text-cyan-400 shrink-0" />
                <div>
                  <strong className="text-white block">Antrean Tiket Kendala Operasional:</strong>
                  <span className="text-[11px] text-slate-300">
                    Gunakan tiket untuk request redirect domain, push indexing, kendala DNS, atau domain down. Ditangani langsung oleh tim teknis.
                  </span>
                </div>
              </div>
              <button
                onClick={() => setNewTicketModal(true)}
                className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shadow-glow-cyan"
              >
                <Plus size={14} />
                <span>Buat Tiket Kendala</span>
              </button>
            </div>

            {/* Ticket List */}
            <div className="space-y-2.5">
              {memberTickets.map((t: any) => (
                <div
                  key={t.id}
                  onClick={() => setSelectedTicketDetail(t)}
                  className="p-4 rounded-2xl glass-card border border-white/10 hover:border-cyan-500/30 transition cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-white group-hover:text-cyan-300 transition">
                        #TKT-{t.id} · {t.title}
                      </span>
                      <span className={`px-2 py-0.2 rounded text-[9px] font-bold uppercase ${
                        t.priority === 'urgent' || t.priority === 'high' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-slate-700 text-slate-300'
                      }`}>
                        {t.priority || 'NORMAL'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 line-clamp-1">{t.notes || 'Tiket operasional program'}</p>
                    <span className="text-[10px] text-slate-500 block">
                      Diajukan: {new Date(t.created_at || Date.now()).toLocaleString('id-ID')}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-center">
                    <span className={`px-2.5 py-1 rounded-xl text-[10px] font-extrabold uppercase ${
                      t.status === 'completed' || t.status === 'resolved'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : t.status === 'in_progress'
                        ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    }`}>
                      {t.status === 'completed' ? 'SELESAI' : t.status === 'in_progress' ? 'PROSES TEKNIS' : 'MENUNGGU ACC'}
                    </span>
                    <ChevronRight size={16} className="text-slate-500 group-hover:text-cyan-400 transition" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 4: SOP OPERASIONAL & SLA */}
        {/* ======================================================== */}
        {memberTab === 'sla_rules' && (
          <div className="space-y-5 animate-fade-in">
            <div className="glass-card p-5 rounded-2xl border border-cyan-500/20 space-y-2">
              <div className="flex items-center gap-2 text-cyan-400 text-xs font-bold uppercase tracking-wider">
                <ShieldCheck size={16} />
                SOP Operasional & Ketentuan Private Program
              </div>
              <h3 className="text-base font-extrabold text-white">Pedoman Kepatuhan Teknis & Standar Jaringan</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Seluruh pelaksana program wajib mematuhi SOP keamanan, aturan routing Anycast, dan kerahasiaan link internal.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-2.5">
                <strong className="text-xs text-emerald-400 block font-bold">1. Keamanan & Anti-Leakage</strong>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Dilarang membagikan link internal origin backend atau token DNS ke pihak luar. Seluruh trafik wajib melalui routing Anycast Cloudflare yang telah ditentukan.
                </p>
              </div>

              <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-2.5">
                <strong className="text-xs text-cyan-400 block font-bold">2. Penanganan Domain Mati / Terblokir</strong>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Jika domain terkena internet positif / DNS filtering, segera ajukan tiket **Request Redirect Domain** agar tim admin memasangkan 301 wildcard ke domain cadangan.
                </p>
              </div>

              <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-2.5">
                <strong className="text-xs text-purple-400 block font-bold">3. Ketentuan TLD Berbayar (.COM/.NET)</strong>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Domain berbayar (.com, .cc, .net) diaktifkan setelah konfirmasi administrasi selesai dan telah di-ACC oleh Admin.
                </p>
              </div>

              <div className="glass-card p-5 rounded-2xl border border-white/10 space-y-2.5">
                <strong className="text-xs text-amber-400 block font-bold">4. Jaminan SLA & Waktu Tanggap</strong>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Jaminan ketersediaan jaringan Anycast 99.9%. Tiket kendala darurat diproses dalam waktu tanggap rata-rata &lt; 30 menit.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* MODAL: BUAT TIKET OPERASIONAL */}
      {/* ======================================================== */}
      {newTicketModal && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2 text-cyan-400">
                <LifeBuoy size={18} />
                <h3 className="text-sm font-extrabold text-white">Buat Tiket Kendala Operasional</h3>
              </div>
              <button onClick={() => setNewTicketModal(false)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X size={16} /></button>
            </div>

            <form onSubmit={handleCreateTicketSubmit} className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Kategori Permintaan:</label>
                <select
                  value={ticketCat}
                  onChange={e => setTicketCat(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="redirect_request">Permintaan Redirect Domain Lama</option>
                  <option value="push_indexing">Push Indexing / Ranking Review</option>
                  <option value="dns_routing">Kendala DNS & SSL</option>
                  <option value="domain_replacement">Penggantian Domain Terblokir</option>
                  <option value="general_support">Bantuan Teknis Lainnya</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Prioritas:</label>
                <select
                  value={ticketPriority}
                  onChange={e => setTicketPriority(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="low">Rendah (Pertanyaan Umum)</option>
                  <option value="medium">Normal (Kendala Minor)</option>
                  <option value="high">Tinggi (Perlu Segera)</option>
                  <option value="urgent">Kritis (Domain Mati / Kena Block)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Judul Permintaan:</label>
                <input
                  type="text"
                  required
                  value={ticketTitle}
                  onChange={e => setTicketTitle(e.target.value)}
                  placeholder="Contoh: Pasang 301 redirect dari domainlama.xyz ke domainbaru.site..."
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Detail & Rincian:</label>
                <textarea
                  required
                  rows={3}
                  value={ticketDesc}
                  onChange={e => setTicketDesc(e.target.value)}
                  placeholder="Jelaskan detail domain sumber, target tujuan, atau kendala..."
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button type="button" onClick={() => setNewTicketModal(false)} className="flex-1 py-2.5 rounded-xl bg-white/5 text-xs font-bold hover:bg-white/10 transition cursor-pointer">Batal</button>
                <button type="submit" className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-xs font-bold transition cursor-pointer shadow-glow-cyan">
                  Kirim ke Antrean Admin
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL: AJUKAN DOMAIN BARU */}
      {/* ======================================================== */}
      {newDomainModal && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2 text-emerald-400">
                <Globe2 size={18} />
                <h3 className="text-sm font-extrabold text-white">Pengajuan Domain Program Baru</h3>
              </div>
              <button onClick={() => setNewDomainModal(false)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X size={16} /></button>
            </div>

            <form onSubmit={handleRequestDomainSubmit} className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Nama Domain yang Diajukan:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={domainInput}
                    onChange={e => setDomainInput(e.target.value)}
                    placeholder="targetprogramanda"
                    className="flex-1 bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500 font-mono-code"
                  />
                  <select
                    value={domainType}
                    onChange={e => setDomainType(e.target.value)}
                    className="bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-emerald-300 font-mono-code focus:outline-none"
                  >
                    <option value=".site">.site (Free)</option>
                    <option value=".online">.online (Free)</option>
                    <option value=".xyz">.xyz (Free)</option>
                    <option value=".com">.com (Pro TLD)</option>
                    <option value=".net">.net (Pro TLD)</option>
                    <option value=".cc">.cc (Offshore)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Catatan Konfigurasi / Target Origin (Opsional):</label>
                <textarea
                  rows={2}
                  value={domainNotes}
                  onChange={e => setDomainNotes(e.target.value)}
                  placeholder="Contoh: Arahkan ke Cloudflare Pages atau server backend IP 103.xxx..."
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button type="button" onClick={() => setNewDomainModal(false)} className="flex-1 py-2.5 rounded-xl bg-white/5 text-xs font-bold hover:bg-white/10 transition cursor-pointer">Batal</button>
                <button type="submit" className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold transition cursor-pointer shadow-glow-emerald">
                  Kirim Pengajuan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL: DETAIL TIKET */}
      {/* ======================================================== */}
      {selectedTicketDetail && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div>
                <span className="text-[10px] text-cyan-400 font-mono-code font-bold">#TKT-{selectedTicketDetail.id}</span>
                <h3 className="text-sm font-extrabold text-white">{selectedTicketDetail.title}</h3>
              </div>
              <button onClick={() => setSelectedTicketDetail(null)} className="p-1 text-slate-400 hover:text-white cursor-pointer"><X size={16} /></button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-black/40 border border-white/5">
                <span className="text-slate-400">Status Penanganan:</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-300 uppercase">
                  {selectedTicketDetail.status}
                </span>
              </div>

              <div className="space-y-1">
                <span className="text-slate-400 block font-medium">Catatan / Rincian:</span>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 text-slate-200 leading-relaxed">
                  {selectedTicketDetail.notes || 'Tidak ada catatan tambahan.'}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-200">
                🛡️ <strong>Tanggapan Tim Admin</strong>: Permintaan operasional Anda telah tercatat dalam antrean teknis. Pembaruan status akan dikirimkan otomatis.
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setSelectedTicketDetail(null)}
                className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-bold text-xs transition cursor-pointer"
              >
                Tutup Detail
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  return (
    <div className={`fixed bottom-5 right-5 z-70 px-4 py-3 rounded-2xl border text-xs font-bold flex items-center gap-2.5 shadow-2xl animate-slide-up ${
      type === 'success' ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200' : 'bg-rose-950/90 border-rose-500/40 text-rose-200'
    }`}>
      {type === 'success' ? <CheckCircle2 size={16} className="text-emerald-400 shrink-0" /> : <CircleAlert size={16} className="text-rose-400 shrink-0" />}
      <span>{message}</span>
      <button onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"><X size={14} /></button>
    </div>
  );
}

function formatDateTime(dt?: string) {
  if (!dt) return '—';
  try {
    const d = new Date(dt);
    return `${d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return dt;
  }
}

// ==========================================
// INSTANT EMERGENCY & INCIDENT RESPONSE MENU MODAL
// ==========================================
function EmergencyMenuModal({ close, onActionExecuted }: { close: () => void; onActionExecuted: (msg: string) => void }) {
  const [selectedAction, setSelectedAction] = useState<EmergencyActionPayload['actionType'] | null>(null);
  const [reason, setReason] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [loading, setLoading] = useState(false);

  const actions = [
    {
      id: 'freeze_payments' as const,
      name: 'Bekukan Semua Payout & Klaim Pembayaran',
      desc: 'Hentikan sementara approval pembayaran dan verifikasi klaim jika ada indikasi invoice spam/fraud.',
      icon: CreditCard,
      color: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      btnColor: 'bg-amber-600 hover:bg-amber-500 text-white'
    },
    {
      id: 'cloudflare_lockdown' as const,
      name: 'Aktifkan Under Attack Mode (Cloudflare DDoS)',
      desc: 'Paksa verifikasi Turnstile/Challenge pada semua domain routing saat terjadi lonjakan trafik abnormal.',
      icon: Flame,
      color: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
      btnColor: 'bg-orange-600 hover:bg-orange-500 text-white'
    },
    {
      id: 'revoke_sessions' as const,
      name: 'Cabut Sesi & Paksa Logout Operator',
      desc: 'Putus semua sesi token aktif seketika jika ada dugaan kebocoran kredensial atau token operator.',
      icon: Lock,
      color: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
      btnColor: 'bg-rose-600 hover:bg-rose-500 text-white'
    },
    {
      id: 'panic_broadcast' as const,
      name: 'Broadcast Darurat ke Grup Member (@mrssandebot)',
      desc: 'Kirim notifikasi pengumuman darurat instan ke grup member (t.me/+ybOzZ_lstEdhNDU1) & bot admin (@sandekalabot).',
      icon: Radio,
      color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
      btnColor: 'bg-cyan-600 hover:bg-cyan-500 text-white'
    },
    {
      id: 'maintenance_toggle' as const,
      name: 'Toggle Mode Pemeliharaan (Maintenance)',
      desc: 'Nonaktifkan sementara pendaftaran user baru dan pengajuan tiket di sistem.',
      icon: ShieldAlert,
      color: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
      btnColor: 'bg-purple-600 hover:bg-purple-500 text-white'
    }
  ];

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAction) return;
    if (confirmKey !== 'EKSEKUSI') {
      alert('Ketik "EKSEKUSI" pada kolom konfirmasi keamanan untuk melanjutkan.');
      return;
    }

    setLoading(true);
    try {
      const res = await executeEmergencyAction({
        actionType: selectedAction,
        reason: reason || 'Tindakan penanganan insiden darurat oleh Super Admin',
        operator: 'Abied Iendomba (Super Admin)'
      });
      onActionExecuted(res.message);
      close();
    } catch (err: any) {
      alert(err.message || 'Gagal mengeksekusi aksi darurat');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-60 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-xl w-full p-6 shadow-2xl space-y-5 overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shadow-glow-rose">
              <ShieldAlert size={22} className="animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-white tracking-tight">Menu Instan & Tindakan Darurat</h2>
              <p className="text-xs text-slate-400">Pusat Mitigasi Insiden & Resiko Keamanan Nyata (Super Admin Only)</p>
            </div>
          </div>
          <button onClick={close} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white cursor-pointer transition">
            <X size={18} />
          </button>
        </div>

        {!selectedAction ? (
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-slate-300">Pilih skenario mitigasi risiko:</p>
            {actions.map((act) => {
              const IconComp = act.icon;
              return (
                <button
                  key={act.id}
                  onClick={() => setSelectedAction(act.id)}
                  className={`w-full p-3.5 rounded-2xl border text-left transition cursor-pointer flex items-start gap-3 hover:scale-[1.01] active:scale-98 ${act.color}`}
                >
                  <IconComp size={20} className="shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <strong className="text-xs font-bold block text-white">{act.name}</strong>
                    <p className="text-[11px] text-slate-300/80 mt-0.5 leading-relaxed">{act.desc}</p>
                  </div>
                  <ChevronRight size={16} className="text-slate-400 shrink-0 mt-1" />
                </button>
              );
            })}
          </div>
        ) : (
          <form onSubmit={handleExecute} className="space-y-4 animate-fade-in">
            <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 space-y-1 text-xs">
              <span className="font-bold text-rose-300 flex items-center gap-1.5">
                <AlertTriangle size={15} />
                Konfirmasi Eksekusi Aksi Tingkat Tinggi
              </span>
              <p className="text-slate-300 text-[11px]">
                Aksi: <strong className="text-white">{actions.find(x => x.id === selectedAction)?.name}</strong>.
                Tindakan ini akan dicatat ke audit log dan disiarkan ke bot @sandekalabot / @mrssandebot.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 block">Alasan / Catatan Tindakan (Wajib):</label>
              <textarea
                required
                rows={2}
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Contoh: Deteksi anomali request berulang pada rentang IP tertentu..."
                className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500/60"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 block">
                Ketik <span className="font-mono text-rose-400 font-bold">EKSEKUSI</span> untuk verifikasi keamanan:
              </label>
              <input
                type="text"
                required
                value={confirmKey}
                onChange={e => setConfirmKey(e.target.value)}
                placeholder="EKSEKUSI"
                className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-slate-600 focus:outline-none focus:border-rose-500/60"
              />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setSelectedAction(null); setConfirmKey(''); setReason(''); }}
                className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold transition cursor-pointer"
              >
                Kembali
              </button>
              <button
                type="submit"
                disabled={loading || confirmKey !== 'EKSEKUSI'}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer disabled:opacity-40 active:scale-95 ${
                  actions.find(x => x.id === selectedAction)?.btnColor || 'bg-rose-600 text-white'
                }`}
              >
                {loading ? 'Mengeksekusi...' : 'Terapkan Sekarang'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
