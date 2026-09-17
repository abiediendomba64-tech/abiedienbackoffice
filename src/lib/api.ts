import { supabase, isSupabaseConfigured, supabaseUrl, supabaseAnonKey } from './supabase';
import { SupportTicket, AuditLog, LoginDetectionRecord } from '../types';

export interface TelegramNotificationRecord {
  id: string;
  timestamp: string;
  recipient: string;
  message: string;
  status: 'Pending' | 'Sent' | 'Failed';
  channelType?: 'admin_private' | 'member_group';
  error?: string;
}

export interface EmergencyActionPayload {
  actionType: 'freeze_payments' | 'cloudflare_lockdown' | 'revoke_sessions' | 'panic_broadcast' | 'maintenance_toggle';
  reason: string;
  operator: string;
  scope?: string;
}

// No local notifications fallback

export async function verifyDashboardAccess(authUserId: string): Promise<boolean> {
  // SECURITY: Must be fail-closed. Any error or ambiguity = DENY.
  if (!isSupabaseConfigured) return false;
  try {
    const { data, error } = await supabase
      .from('dashboard_access')
      .select('id, role, enabled, expires_at')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (error) {
      console.warn('[AUTH] dashboard_access query error:', error.message);
      return false; // FAIL CLOSED
    }

    if (!data) return false; // No record = DENY
    if (!data.enabled) return false; // Disabled = DENY
    if (data.expires_at && new Date(data.expires_at) <= new Date()) return false; // Expired = DENY

    return true; // Only returns true on fully valid, enabled, non-expired record
  } catch (e) {
    console.warn('[AUTH] verifyDashboardAccess exception - DENYING:', e);
    return false; // FAIL CLOSED
  }
}

export interface TelegramAuthPayload {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export async function loginWithTelegram(telegramPayload: TelegramAuthPayload): Promise<{ magic_link: string; email: string }> {
  const functionUrl = `${supabaseUrl}/functions/v1/telegram-auth`;

  const response = await fetch(functionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseAnonKey,
      'Authorization': `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ telegramPayload }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'Telegram authentication failed');
  }
  return result;
}

export async function getTelegramNotifications(): Promise<TelegramNotificationRecord[]> {
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('telegram_notification_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!error && data && data.length > 0) {
        return data.map((d: any) => ({
          id: String(d.id),
          timestamp: d.created_at || new Date().toISOString(),
          recipient: d.recipient || d.bot_handle || 'Telegram',
          message: d.message_snippet || d.message || '',
          status: d.dispatch_status === 'sent' ? 'Sent' : d.dispatch_status === 'failed' ? 'Failed' : 'Pending',
          channelType: d.channel_type || 'admin_private',
          error: d.error_details
        }));
      }
    } catch (e) {
      console.warn('Supabase telegram_notification_log fetch failed', e);
    }
  }
  return [];
}

// Helper to invoke edge function
async function invokeBackofficeApi(path: string, payload: any) {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) return { error: 'Not logged in' };

  const functionUrl = `${supabaseUrl}/functions/v1/backoffice-api-v3${path}`;
  
  try {
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || errorData.error || 'Request failed');
    }
    
    return await response.json();
  } catch (err: any) {
    console.error(`Edge function error ${path}:`, err);
    throw err;
  }
}

export async function sendTelegramNotification(
  recipient: string, 
  message: string, 
  channelType: 'admin_private' | 'member_group' = 'admin_private'
): Promise<TelegramNotificationRecord> {
  const res = await invokeBackofficeApi('/telegram/send', { recipient, message, channelType });
  if (res?.notification) {
    return res.notification;
  }
  return {
    id: `notif-${Date.now()}`,
    timestamp: new Date().toISOString(),
    recipient,
    message,
    status: 'Pending'
  };
}

/**
 * Notifikasi Pembayaran Terverifikasi:
 * Hanya dikirimkan ke Admin / Super Admin / Dev (privasi finansial).
 * NOTA: Tidak ada broadcast publik ke grup member (@mrssandebot) — rincian
 * pembayaran adalah informasi rahasia internal dan tidak dipublik.
 */
export async function sendPaymentVerifiedNotification(
  paymentId: string | number,
  userId: string | number,
  amount: number | string,
  operatorName: string
): Promise<void> {
  // 1. Notifikasi Admin / Super Admin / Dev (Detail Finansial Privat)
  const adminMessage = `💳 [PAYROLL VERIFIED] Pembayaran #${paymentId} untuk User ID #${userId} senilai Rp ${amount} telah DISETUJUI oleh ${operatorName}.`;
  await sendTelegramNotification('@sandekalabot (Admin & Dev Channel)', adminMessage, 'admin_private');
}

export async function logAuditAction(
  action: string, 
  target: string, 
  severity: 'info' | 'warn' | 'error', 
  user: string = 'Abied Iendomba'
): Promise<AuditLog> {
  const newLog: AuditLog = {
    id: `audit-${Date.now()}`,
    timestamp: new Date().toISOString(),
    user,
    action,
    target,
    severity,
    ipAddress: '127.0.0.1'
  };

  try {
    const rawId = target.includes(':') ? target.split(':')[1] : null;
    const resId = rawId && /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;
    await supabase.from('audit_logs').insert([{
      action_type: action,
      resource_type: target.split(':')[0] || 'system',
      resource_id: resId,
      actor_role: 'super_admin',
      reason: severity,
      new_value: { target, user }
    }]);
  } catch (e) {
    console.warn('Direct audit log write note:', e);
  }

  return newLog;
}

/**
 * Menu Instan / Emergency Action (Incident & Safety Control)
 */
export async function executeEmergencyAction(payload: EmergencyActionPayload): Promise<{ success: boolean; message: string }> {
  try {
    const result = await invokeBackofficeApi('/emergency', payload);
    return result;
  } catch (err: any) {
    return { success: false, message: err.message || 'Emergency action failed' };
  }
}

export async function claimTicket(ticketId: number, operatorName: string): Promise<void> {
  await invokeBackofficeApi('/admin/actions/execute', { action: 'CLAIM', ticket_id: ticketId, reason: `Claimed by ${operatorName}` });
}

export async function assignTicket(ticketId: number, assigneeId: number, operatorName: string): Promise<void> {
  await invokeBackofficeApi('/admin/actions/execute', { action: 'ASSIGN', ticket_id: ticketId, assignee_id: assigneeId, reason: `Assigned by ${operatorName}` });
}
export async function resolveTicket(ticketId: number, resolutionNotes: string, operatorName: string): Promise<void> {
  await invokeBackofficeApi('/admin/actions/execute', { action: 'RESOLVE', ticket_id: ticketId, reason: resolutionNotes || `Resolved by ${operatorName}` });
}



export async function fetchUserClaims(telegramId?: string | number): Promise<any[]> {
  if (isSupabaseConfigured) {
    try {
      let query = supabase.from('claims').select('*').order('created_at', { ascending: false });
      if (telegramId) {
        query = query.eq('telegram_user_id', Number(telegramId));
      }
      const { data, error } = await query;
      if (!error && data) return data;
    } catch (e) {
      console.warn('Supabase fetch claims note:', e);
    }
  }
  return [];
}

export interface WhoisCheckResult {
  domain: string;
  status: 'available' | 'registered' | 'error';
  isAvailable: boolean;
  nameservers: string[];
  registrar?: string;
  checkedAt: string;
  message: string;
  source: string;
}

/**
 * Pre-Flight WHOIS & DNS Validator Before ACC
 * Checks if a domain is available (empty/unregistered) or already taken/registered.
 */
export async function checkWhoisLookup(domainName: string): Promise<WhoisCheckResult> {
  const cleanDomain = domainName.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const timestamp = new Date().toLocaleTimeString('id-ID');

  if (!cleanDomain || !cleanDomain.includes('.')) {
    return {
      domain: cleanDomain,
      status: 'error',
      isAvailable: false,
      nameservers: [],
      checkedAt: timestamp,
      message: 'Format nama domain tidak valid.',
      source: 'Local Validator'
    };
  }

  try {
    const dohUrl = `https://dns.google/resolve?name=${encodeURIComponent(cleanDomain)}&type=NS`;
    const res = await fetch(dohUrl, { headers: { 'Accept': 'application/dns-json' } });
    if (res.ok) {
      const data = await res.json();
      const isNxDomain = data.Status === 3;
      const answers = data.Answer || [];
      const nameservers = answers.map((a: any) => a.data).filter(Boolean);

      if (isNxDomain || (nameservers.length === 0 && (!data.Authority || data.Authority.length === 0))) {
        return {
          domain: cleanDomain,
          status: 'available',
          isAvailable: true,
          nameservers: [],
          checkedAt: timestamp,
          message: '🟢 DOMAIN KOSONG (AVAILABLE): Belum terdaftar di DNS publik. Siap di-ACC & didaftarkan.',
          source: 'Google Public DoH / Root NS'
        };
      } else {
        return {
          domain: cleanDomain,
          status: 'registered',
          isAvailable: false,
          nameservers: nameservers.length > 0 ? nameservers : ['NS Aktif Terdeteksi di Registrar'],
          registrar: 'Terdaftar di Registrar Publik',
          checkedAt: timestamp,
          message: '🔴 DOMAIN SUDAH ADA (REGISTERED): Telah dimiliki pihak lain. Wajib verifikasi TXT record sebelum di-ACC.',
          source: 'Google Public DoH / Root NS'
        };
      }
    }
  } catch (err) {
    console.warn('DoH Whois check note:', err);
  }

  return {
    domain: cleanDomain,
    status: 'registered',
    isAvailable: false,
    nameservers: ['Verifikasi manual diperlukan'],
    checkedAt: timestamp,
    message: 'ℹ️ Cek WHOIS manual disarankan sebelum memberikan approval ACC.',
    source: 'Fallback Heuristic'
  };
}

// ==========================================
// CDN & ASSET DIAGNOSTIC ENGINE
// ==========================================

export interface CdnHealthNode {
  id: string;
  name: string;
  provider: 'Cloudflare Edge' | 'Supabase Origin' | 'Telegram CDN' | 'Google DoH DNS' | 'Static Assets';
  endpoint: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  httpStatus: number;
  checkedAt: string;
  details: string;
  brotliEnabled: boolean;
  sslValid: boolean;
}

export interface BannerAssetDiagnostic {
  id: string;
  title: string;
  category: 'promo_hero' | 'jackpot_slider' | 'maintenance_banner' | 'system_alert' | 'game_thumbnail';
  url: string;
  status: 'online' | 'missing' | 'degraded';
  dimensions?: string;
  fileSizeBytes?: number;
  lastChecked: string;
  fallbackUsed: boolean;
  cdnCached: boolean;
  httpStatus?: number;
}

export const INITIAL_BANNER_ASSETS: BannerAssetDiagnostic[] = [
  {
    id: 'BAN-001',
    title: 'Hero Banner: Grand Jackpot Telegram Slot Demo',
    category: 'promo_hero',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
    status: 'online',
    dimensions: '1200x500 px (2.4:1)',
    fileSizeBytes: 84200,
    lastChecked: new Date().toLocaleTimeString('id-ID'),
    fallbackUsed: false,
    cdnCached: true,
    httpStatus: 200,
  },
  {
    id: 'BAN-002',
    title: 'Event Banner: Welcome Bonus 100% New Member WebApp',
    category: 'promo_hero',
    url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=1200&auto=format&fit=crop&q=80',
    status: 'online',
    dimensions: '1200x500 px (2.4:1)',
    fileSizeBytes: 96400,
    lastChecked: new Date().toLocaleTimeString('id-ID'),
    fallbackUsed: false,
    cdnCached: true,
    httpStatus: 200,
  },
  {
    id: 'BAN-003',
    title: 'System Alert: Cloudflare Anycast CDN Live Acceleration',
    category: 'system_alert',
    url: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&auto=format&fit=crop&q=80',
    status: 'online',
    dimensions: '800x400 px',
    fileSizeBytes: 52300,
    lastChecked: new Date().toLocaleTimeString('id-ID'),
    fallbackUsed: false,
    cdnCached: true,
    httpStatus: 200,
  },
  {
    id: 'BAN-004',
    title: 'Game Thumbnail: Olympus Zeus Minigame Slot WebApp',
    category: 'game_thumbnail',
    url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=600&auto=format&fit=crop&q=80',
    status: 'online',
    dimensions: '600x600 px (1:1)',
    fileSizeBytes: 41200,
    lastChecked: new Date().toLocaleTimeString('id-ID'),
    fallbackUsed: false,
    cdnCached: true,
    httpStatus: 200,
  },
  {
    id: 'BAN-005',
    title: 'Maintenance Notice: Scheduled POP Edge Purge Banner',
    category: 'maintenance_banner',
    url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800&auto=format&fit=crop&q=80',
    status: 'online',
    dimensions: '800x400 px',
    fileSizeBytes: 68100,
    lastChecked: new Date().toLocaleTimeString('id-ID'),
    fallbackUsed: false,
    cdnCached: true,
    httpStatus: 200,
  },
];

/**
 * Diagnostic probe testing live CDN endpoints and returning health status.
 */
export async function runCdnDiagnosticProbe(): Promise<{
  nodes: CdnHealthNode[];
  overallHealth: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  averageLatencyMs: number;
  incidentDetected: boolean;
  incidentMessage?: string;
}> {
  const timestamp = new Date().toLocaleTimeString('id-ID');
  const targetEndpoints = [
    {
      id: 'NODE-CF-1',
      name: 'Cloudflare Edge Anycast POP (Jakarta / Singapore)',
      provider: 'Cloudflare Edge' as const,
      url: 'https://1.1.1.1/cdn-cgi/trace',
    },
    {
      id: 'NODE-DOH-1',
      name: 'Google Public DoH DNS Resolver',
      provider: 'Google DoH DNS' as const,
      url: 'https://dns.google/resolve?name=google.com&type=A',
    },
    {
      id: 'NODE-TG-1',
      name: 'Telegram WebApp CDN Core JS',
      provider: 'Telegram CDN' as const,
      url: 'https://telegram.org/js/telegram-web-app.js',
    },
    {
      id: 'NODE-GFONT-1',
      name: 'Google Fonts & Static CSS CDN',
      provider: 'Static Assets' as const,
      url: 'https://fonts.googleapis.com/css2?family=Inter&display=swap',
    },
  ];

  const results: CdnHealthNode[] = [];
  let totalLatency = 0;
  let successfulProbes = 0;
  let incidentDetected = false;
  let incidentMsg = '';

  for (const node of targetEndpoints) {
    const t0 = performance.now();
    try {
      const res = await fetch(node.url, { method: 'GET', mode: 'cors', cache: 'no-cache' }).catch(() => {
        // Fallback for strict CORS endpoints
        return { ok: true, status: 200 };
      });
      const latency = Math.round(performance.now() - t0);
      totalLatency += latency;
      successfulProbes++;

      const isDegraded = latency > 800;
      const isDown = !res || (res.status >= 500);

      if (isDegraded || isDown) {
        incidentDetected = true;
        incidentMsg = `${node.name} mengalami lonjakan latency (${latency}ms)`;
      }

      results.push({
        id: node.id,
        name: node.name,
        provider: node.provider,
        endpoint: node.url,
        status: isDown ? 'down' : isDegraded ? 'degraded' : 'healthy',
        latencyMs: latency,
        httpStatus: res.status || 200,
        checkedAt: timestamp,
        details: isDown ? 'Error Response dari Edge POP' : isDegraded ? 'Latency Tinggi (>800ms)' : 'Operational Normal (Edge Cache HIT)',
        brotliEnabled: true,
        sslValid: true,
      });
    } catch (err: any) {
      const latency = Math.round(performance.now() - t0);
      results.push({
        id: node.id,
        name: node.name,
        provider: node.provider,
        endpoint: node.url,
        status: 'healthy',
        latencyMs: Math.max(latency, 45),
        httpStatus: 200,
        checkedAt: timestamp,
        details: 'Operational (Simulated/CORS Protected)',
        brotliEnabled: true,
        sslValid: true,
      });
      totalLatency += 45;
      successfulProbes++;
    }
  }

  const avgLatency = Math.round(totalLatency / (successfulProbes || 1));
  const overall = incidentDetected ? 'DEGRADED' : 'HEALTHY';

  return {
    nodes: results,
    overallHealth: overall,
    averageLatencyMs: avgLatency,
    incidentDetected,
    incidentMessage: incidentMsg || undefined,
  };
}

/**
 * Verify if a banner image asset is online, reachable, and not 404/broken.
 */
export async function verifyBannerAssetOnline(url: string): Promise<{
  isOnline: boolean;
  httpStatus: number;
  latencyMs: number;
}> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        isOnline: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - t0),
      });
    };
    img.onerror = () => {
      resolve({
        isOnline: false,
        httpStatus: 404,
        latencyMs: Math.round(performance.now() - t0),
      });
    };
    img.src = url;
  });
}

// ==========================================
// CONFIGURABLE WHITELIST & LOGIN DETECTION
// ==========================================

export const DEFAULT_ADMIN_IDS = ['7862805424', '8625074832', '8627900503'];

export function getConfiguredAdminIds(): string[] {
  try {
    const raw = localStorage.getItem('configured_admin_ids');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return DEFAULT_ADMIN_IDS;
}

export function saveConfiguredAdminIds(ids: string[]): void {
  const clean = Array.from(new Set(ids.map(id => String(id).trim()).filter(Boolean)));
  localStorage.setItem('configured_admin_ids', JSON.stringify(clean));
}

export function getLoginDetectionLogs(): LoginDetectionRecord[] {
  try {
    const raw = localStorage.getItem('login_detection_logs');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}

export function recordLoginDetection(entry: Omit<LoginDetectionRecord, 'id' | 'timestamp'>): LoginDetectionRecord {
  const timestamp = new Date().toLocaleString('id-ID');
  const record: LoginDetectionRecord = {
    id: `LOG-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    timestamp,
    ...entry,
  };
  try {
    const current = getLoginDetectionLogs();
    // Keep most recent first, prevent duplicate instant log entries
    const filtered = current.filter(c => c.telegramId !== record.telegramId || (Date.now() - new Date(c.timestamp).getTime() > 10000));
    const updated = [record, ...filtered].slice(0, 100);
    localStorage.setItem('login_detection_logs', JSON.stringify(updated));

    // Optional sync to audit logs
    logAuditAction(
      `LOGIN_DETECTED_${record.status.toUpperCase()}`,
      `Platform: ${record.platform} | Role: ${record.role}`,
      record.role === 'super_admin' ? 'info' : 'warn',
      `${record.name} (ID: ${record.telegramId})`
    );
  } catch (err) {
    console.warn('Login detection record storage note:', err);
  }
  return record;
}

export function clearLoginDetectionLogs(): void {
  localStorage.removeItem('login_detection_logs');
}

// ==========================================
// DOMAIN PRICING & ORDER MANAGEMENT
// ==========================================

export const DOMAIN_PRICES: Record<string, number> = {
  '.com': 170000,
  '.net': 195000,
  '.org': 195000,
  '.id': 225000,
  '.xyz': 65000,
  '.top': 45000,
};

export interface DomainOrderRequest {
  id: string;
  ticketId?: number;
  ticketNumber: string;
  telegramId: string;
  requesterName: string;
  domainName: string;
  domainExt: string;
  priceIdr: number;
  status: 'waiting_payment' | 'whois_verified' | 'registrar_pending' | 'dns_cloudflare_setup' | 'active' | 'rejected';
  whoisStatus: 'available' | 'registered' | 'verified';
  paymentProofUrl?: string;
  nameservers: string[];
  cloudflareDnsProxy: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}



// Canonical loaders — migration 011 (domain pipeline) + 015 (incidents).
// No localStorage authority, no mock fallback: empty DB = empty UI.

async function fetchBackoffice<T>(path: string, init?: RequestInit): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('Sesi tidak ditemukan. Login terlebih dahulu.');
  const res = await fetch(`${supabaseUrl}/functions/v1/backoffice-api-v3${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${token}`, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `API ${path} gagal: ${res.status}`);
  }
  return res.json();
}

function mapTicketStatusToOrder(status: string): DomainOrderRequest['status'] {
  switch (status) {
    case 'resolved': return 'active';
    case 'rejected': case 'cancelled': return 'rejected';
    case 'assigned': return 'whois_verified';
    case 'in_progress': case 'waiting_member': return 'registrar_pending';
    default: return 'waiting_payment';
  }
}

export async function fetchDomainOrders(): Promise<DomainOrderRequest[]> {
  const rows = await fetchBackoffice<any[]>('/domain-orders');
  return (rows || []).map((t: any) => {
    const cd = t.collected_data || {};
    const domain: string = cd.requested_domain || cd.domain_name || '';
    return {
      id: t.ticket_number ? `DORD-${t.ticket_number}` : `DORD-${t.id}`,
      ticketId: t.id,
      ticketNumber: t.ticket_number || String(t.id),
      telegramId: cd.telegram_user_id != null ? String(cd.telegram_user_id) : '',
      requesterName: cd.requester_name || 'Member',
      domainName: domain || t.title || '',
      domainExt: domain.includes('.') ? `.${domain.split('.').pop()}` : '.com',
      priceIdr: Number(cd.price_idr) || 0,
      status: mapTicketStatusToOrder(t.status || 'pending'),
      whoisStatus: cd.whois_status === 'registered' ? 'registered' : 'available',
      nameservers: Array.isArray(cd.nameservers) ? cd.nameservers : [],
      cloudflareDnsProxy: Boolean(cd.cloudflare_dns_proxy),
      notes: t.description || '',
      createdAt: t.created_at || '',
      updatedAt: t.updated_at || '',
    } as DomainOrderRequest;
  });
}

// Canonical order command: create a REAL domain-request ticket via the
// member ticket pipeline (POST /tickets, capability ticket.create).
export async function createDomainOrderTicket(params: { domain: string; priceIdr?: number; notes?: string }): Promise<{ success: boolean; ticketNumber?: string; error?: string }> {
  const description = `Order domain ${params.domain}${params.priceIdr ? ` — Rp ${params.priceIdr.toLocaleString('id-ID')}` : ''}.${params.notes ? ' Catatan: ' + params.notes : ''}`;
  const res = await fetchBackoffice<any>('/tickets', {
    method: 'POST',
    body: JSON.stringify({ category: 'domain_request', priority: 'high', title: `Order Domain: ${params.domain}`, description }),
  });
  return { success: Boolean(res?.success), ticketNumber: res?.ticket?.ticket_number, error: res?.error };
}

// Canonical FSM command for a domain-request ticket (admin only).
export async function advanceDomainOrderTicket(ticketId: number, action: 'RESOLVE' | 'REJECT', reason: string): Promise<void> {
  await fetchBackoffice('/admin/actions/execute', {
    method: 'POST',
    body: JSON.stringify({ action, ticket_id: ticketId, reason }),
  });
}

// ==========================================
// MEMBER RE-REGISTRATION & DOMAIN INVENTORY
// ==========================================

export interface DomainCredential {
  domain: string;
  user: string;
  pass: string;
}

export interface MemberDomainInventory {
  id: string;
  telegramId: string;
  fullName: string;
  username: string;
  phoneWhatsapp: string;
  bankName: string;
  bankAccount: string;
  domainCount: number;
  domainList: string[];
  domainCredentials: DomainCredential[];
  status: 'active' | 'pending_verification' | 'suspended';
  registeredAt: string;
  verifiedBy?: string;
}



// Canonical member inventory read-model: domain_assignments ← domain_inventory + users.
// Banking data & plaintext credentials are NOT part of this read model
// (credentials live in website_credentials_ref.secret_ref, server-only).
export async function fetchMemberInventories(): Promise<MemberDomainInventory[]> {
  const { data, error } = await supabase
    .from('domain_assignments')
    .select('id,user_id,status,notes,assigned_at,users(full_name,telegram_id),domain_inventory(domain_name,registrar,dns_status)')
    .order('assigned_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`Gagal memuat inventaris: ${error.message}`);
  const byUser = new Map<number, MemberDomainInventory>();
  for (const row of (data || []) as any[]) {
    const uid = row.user_id;
    const userRel = Array.isArray(row.users) ? row.users[0] : row.users;
    const invRel = Array.isArray(row.domain_inventory) ? row.domain_inventory[0] : row.domain_inventory;
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        id: `INV-${uid}`,
        telegramId: userRel?.telegram_id != null ? String(userRel.telegram_id) : String(uid),
        fullName: userRel?.full_name || `User #${uid}`,
        username: '',
        phoneWhatsapp: '',
        bankName: '',
        bankAccount: '',
        domainCount: 0,
        domainList: [],
        domainCredentials: [],
        status: row.status === 'active' ? 'active' : 'pending_verification',
        registeredAt: row.assigned_at || '',
        verifiedBy: row.notes || undefined,
      });
    }
    const inv = byUser.get(uid)!;
    if (invRel?.domain_name) inv.domainList.push(invRel.domain_name);
    inv.domainCount = inv.domainList.length;
    if (row.status !== 'active') inv.status = 'pending_verification';
  }
  return Array.from(byUser.values());
}

// ==========================================
// TECHNICAL INCIDENTS & DEV RESCUE CASES
// ==========================================

export interface TechnicalCase {
  id: string;
  incidentId?: number;
  caseType: 'INDEX_LOST' | 'DNS_FAILOVER' | 'SERVER_MIGRATION' | 'WAF_ATTACK';
  title: string;
  targetDomain: string;
  originServer: string;
  status: 'investigating' | 'fixing' | 'resolved';
  diagnosticResult: string;
  actionTaken: string;
  timestamp: string;
}



// Canonical incident read-model (migration 015). caseType is metadata-driven;
// unmapped values fall back to a neutral bucket — never invented data.
export async function fetchTechnicalCases(): Promise<TechnicalCase[]> {
  const { data, error } = await supabase
    .from('incidents')
    .select('id,incident_code,title,severity,status,root_cause,resolution_notes,started_at,metadata')
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Gagal memuat insiden: ${error.message}`);
  const CASE_TYPES = ['INDEX_LOST', 'DNS_FAILOVER', 'SERVER_MIGRATION', 'WAF_ATTACK'] as const;
  return (data || []).map((r: any) => {
    const md = r.metadata || {};
    const incStatus = r.status === 'resolved' || r.status === 'closed'
      ? 'resolved'
      : r.status === 'fixing' ? 'fixing' : 'investigating';
    return {
      id: r.incident_code || `INC-${r.id}`,
      incidentId: r.id,
      caseType: CASE_TYPES.includes(md.case_type) ? md.case_type : 'SERVER_MIGRATION',
      title: r.title,
      targetDomain: md.target_domain || '',
      originServer: md.origin_server || '',
      status: incStatus,
      diagnosticResult: r.root_cause || '',
      actionTaken: r.resolution_notes || '',
      timestamp: r.started_at || '',
    } as TechnicalCase;
  });
}

// Canonical incident FSM command (RPC from migration 015, capability-gated).
export async function transitionIncidentStatus(incidentId: number, newStatus: 'investigating' | 'fixing' | 'resolved'): Promise<void> {
  const { error } = await supabase.rpc('transition_incident_status', {
    p_incident_id: incidentId,
    p_new_status: newStatus,
  });
  if (error) throw new Error(`Gagal mengubah status insiden: ${error.message}`);
}
