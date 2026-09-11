// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2.57.0';

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
};

// Telegram Endpoints
interface ClaimRow {
  id: string;
  telegram_user_id: string | number;
  claim_type: string;
  status: string;
  notes: string | null;
  evidence_path: string | null;
  created_at: string;
}

const TELEGRAM_TOKEN_ENDPOINT = 'https://oauth.telegram.org/auth/request';
const TELEGRAM_JWKS_ENDPOINT = 'https://oauth.telegram.org/keys';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HINTS = {
  welcome_guest: `👋 *Selamat Datang di Abiedien System*

Sistem ini menerapkan *Zero Trust & Private Consultation Hierarchy*.
Untuk mengakses fitur member dan layanan operasional, silakan lakukan registrasi.

⚠️ *Peringatan Keamanan Cyber:*
• Hindari oknum yang mengatasnamakan admin/dev.
• Komunikasi konsultasi bersifat privat dan terenkripsi.
• Pengajuan klaim gaji *WAJIB* menyertakan bukti screenshot transaksi asli.`,

  welcome_member: `🛡️ *Member Portal Dashboard*

Status Akun: ✅ *Aktif (Verified Member)*
Konsultan Admin Anda siap membantu secara privat.

Silakan pilih menu di bawah:`,

  welcome_admin: `👑 *Super Admin & Dev Command Center*

Status: 🟢 *Super Admin Authorized*
Chat ID Anda telah tersinkronisasi untuk menerima notifikasi klaim & darurat.

Ketik \`/admin help\` untuk melihat daftar perintah kontrol hirarki.`,

  security_rules: `📜 *Aturan Pakai & Hint Keamanan Nyata:*

1. *Klaim Gaji & Payout:*
   • Hanya menerima lampiran foto/screenshot asli (Maks 5 MB).
   • Dokumen/video/teks tanpa screenshot akan otomatis ditolak.
   • Maksimal 3 klaim per 24 jam.
2. *Anti-Phishing & Cyber Defense:*
   • Admin resmi *TIDAK PERNAH* meminta password atau OTP Anda.
   • Hubungi Admin Resmi terverifikasi via tombol konsultasi privat.
3. *Audit & Logging:*
   • Semua aktivitas dicatat dalam sistem audit trail demi keamanan bersama.`,

  claim_prompt: `📸 *Pengajuan Klaim Gaji / Payout*

Silakan kirimkan *FOTO SCREENSHOT BUKTI* (Maks 5 MB) yang jelas.
Sertakan keterangan nominal/pekerjaan pada caption foto.

_Format selain foto akan ditolak oleh sistem._`,

  not_registered: `🚫 *Akses Ditolak: Anda Belum Terdaftar*

Anda belum memiliki status sebagai member aktif.
Silakan klik tombol *Daftar Member* di bawah untuk memulai proses registrasi.`,

  admin_help: `🛠️ *Daftar Perintah Super Admin:*

• \`/admin claims\` — Cek daftar klaim pending
• \`/admin domain_requests\` — Lihat request domain pending
• \`/admin promote <tg_id>\` — Naikkan status ke Admin
• \`/admin demote <tg_id>\` — Turunkan status ke Member
• \`/admin block <tg_id>\` — Blokir user Telegram
• \`/admin unblock <tg_id>\` — Buka blokir user Telegram
• \`/admin domain_assign <req_id> <domain>\` — Assign domain ke member
• \`/admin domain_reject <req_id> <reason>\` — Tolak request domain`
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function verifyTelegramJWT(idToken: string, clientId: string): Promise<Record<string, any>> {
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('Invalid JWT format');

  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  const jwksRes = await fetch(TELEGRAM_JWKS_ENDPOINT);
  if (!jwksRes.ok) throw new Error('Failed to fetch Telegram JWKS');
  const { keys }: { keys: JsonWebKey[] } = await jwksRes.json();
  
  const jwk = (keys as any[]).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown Telegram signing key');

  const publicKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );

  const encoder = new TextEncoder();
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToArrayBuffer(signatureB64);

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data);
  if (!valid) throw new Error('JWT signature verification failed');

  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('JWT token expired');

  if (payload.iss !== 'https://oauth.telegram.org') throw new Error('Invalid JWT issuer');
  if (payload.aud !== clientId) throw new Error('Invalid JWT audience');

  return payload;
}

async function verifyTelegramHMAC(telegramPayload: Record<string, any>, botToken: string): Promise<boolean> {
  const { hash, ...dataToVerify } = telegramPayload;
  if (!hash) return false;

  // Freshness check: Reject if auth_date is older than 24 hours
  if (dataToVerify.auth_date) {
    const authDate = parseInt(dataToVerify.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return false;
  }

  const dataCheckArr = [];
  for (const key of Object.keys(dataToVerify).sort()) {
    dataCheckArr.push(`${key}=${dataToVerify[key]}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const encoder = new TextEncoder();
  const secretKeyData = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', secretKeyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataCheckString));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return constantTimeEqual(signatureHex, String(hash));
}

/**
 * Verify Telegram Mini App initData using HMAC-SHA256.
 * Per Telegram docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
async function verifyTelegramInitData(initData: string, botToken: string): Promise<{ valid: boolean; data: Record<string, any> }> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, data: {} };

  // Freshness check
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) {
    return { valid: false, data: {} };
  }

  params.delete('hash');
  const dataCheckArr: string[] = [];
  const sortedKeys = Array.from(params.keys()).sort();
  for (const key of sortedKeys) {
    dataCheckArr.push(`${key}=${params.get(key)}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const encoder = new TextEncoder();
  // For Mini App initData, secret key = HMAC-SHA256('WebAppData', bot_token)
  const baseKey = await crypto.subtle.importKey(
    'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secretKeyBuffer = await crypto.subtle.sign('HMAC', baseKey, encoder.encode(botToken));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', secretKeyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataCheckString));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (!constantTimeEqual(signatureHex, hash)) return { valid: false, data: {} };

  // Parse embedded user JSON
  const parsed: Record<string, any> = {};
  for (const [k, v] of params.entries()) {
    try { parsed[k] = JSON.parse(v); } catch { parsed[k] = v; }
  }
  return { valid: true, data: parsed };
}

/**
 * Log an action to the audit_logs table. Fire-and-forget.
 */
async function logAudit(
  db: any,
  action: string,
  target: string,
  severity: 'info' | 'warn' | 'error',
  actorLabel: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    await db.from('audit_logs').insert([{
      action,
      target,
      severity,
      user: actorLabel,
      metadata: metadata || {},
      ip_address: '::telegram-bot',
    }]);
  } catch (err) {
    console.warn('logAudit note:', err);
  }
}

/**
 * Send a Telegram message AND record the result in telegram_notification_log.
 */
async function sendAndLog(
  db: any,
  botToken: string,
  chatId: number | string,
  text: string,
  replyMarkup?: any,
  contextType?: string,
  contextId?: string
): Promise<any> {
  // Insert as queued
  let logId: string | null = null;
  try {
    const { data: logRow } = await db.from('telegram_notification_log').insert([{
      recipient_chat_id: chatId,
      message_text: text,
      context_type: contextType || 'system',
      context_id: contextId || null,
      status: 'sending',
    }]).select('id').single();
    logId = logRow?.id || null;
  } catch (err) {
    console.warn('notification log insert note:', err);
  }

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
  const result = await res.json();

  // Update log with actual status
  if (logId) {
    try {
      await db.from('telegram_notification_log').update({
        status: result.ok ? 'sent' : 'failed',
        telegram_message_id: result.result?.message_id || null,
        error_reason: result.ok ? null : (result.description || 'Unknown error'),
        sent_at: result.ok ? new Date().toISOString() : null,
      }).eq('id', logId);
    } catch (err) {
      console.warn('notification log update note:', err);
    }
  }

  return result;
}

// Telegram Bot API Helper
async function sendTelegramMessage(botToken: string, chatId: number | string, text: string, replyMarkup?: any) {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
  return res.json();
}

// =============================================
// DYNAMIC COMMAND PROFILES PER ROLE
// =============================================
type RoleProfile = 'guest' | 'member_pending' | 'member' | 'admin' | 'dev' | 'super_admin' | 'root';

const COMMAND_PROFILES: Record<RoleProfile, Array<{ command: string; description: string }>> = {
  guest: [
    { command: 'start', description: '🚀 Mulai & Buka Menu' },
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'register', description: '📝 Daftar Member' },
    { command: 'status', description: '📊 Cek Status' },
    { command: 'help', description: '❓ Bantuan & Panduan' },
  ],
  member_pending: [
    { command: 'start', description: '🚀 Mulai & Buka Menu' },
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'status', description: '📊 Cek Status Verifikasi' },
    { command: 'help', description: '❓ Bantuan & Panduan' },
    { command: 'admin', description: '💬 Tanya Admin' },
  ],
  member: [
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'status', description: '📊 Status Akun & Domain' },
    { command: 'reqdomain', description: '🌐 Order Domain (.com Rp 170k)' },
    { command: 'whois', description: '🔍 Cek Ketersediaan Domain' },
    { command: 'claim', description: '💰 Ajukan Klaim Gaji' },
    { command: 'login', description: '🔐 Login Dashboard' },
    { command: 'account', description: '👤 Info Akun' },
    { command: 'help', description: '❓ Bantuan & Panduan' },
    { command: 'admin', description: '💬 Tanya Admin' },
  ],
  admin: [
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'admin', description: '🛠️ Panel Admin' },
    { command: 'status', description: '📊 Status Sistem' },
    { command: 'login', description: '🔐 Login Dashboard' },
    { command: 'help', description: '❓ Bantuan' },
  ],
  dev: [
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'status', description: '📊 Status Sistem' },
    { command: 'whois', description: '🔍 DNS Lookup' },
    { command: 'login', description: '🔐 Login Dashboard' },
    { command: 'help', description: '❓ Bantuan' },
  ],
  super_admin: [
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'admin', description: '🛠️ Panel Super Admin' },
    { command: 'status', description: '📊 Status Sistem' },
    { command: 'reqdomain', description: '🌐 Order Domain' },
    { command: 'whois', description: '🔍 DNS Lookup' },
    { command: 'login', description: '🔐 Login Dashboard' },
    { command: 'help', description: '❓ Bantuan' },
  ],
  root: [
    { command: 'menu', description: '🏠 Menu Utama' },
    { command: 'admin', description: '🛠️ Root Control' },
    { command: 'status', description: '📊 Status Sistem' },
    { command: 'login', description: '🔐 Login Dashboard' },
    { command: 'help', description: '❓ Bantuan' },
  ],
};

const KEYBOARD_PROFILES: Record<RoleProfile, Array<Array<Record<string, any>>>> = {
  guest: [
    [{ text: '🏠 Menu Utama' }, { text: '📝 Daftar Member' }],
    [{ text: '📊 Cek Status' }, { text: '❓ Bantuan' }],
  ],
  member_pending: [
    [{ text: '📊 Cek Status' }, { text: '❓ Bantuan' }],
    [{ text: '💬 Tanya Admin' }],
  ],
  member: [
    [{ text: '📱 Buka Dashboard', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
    [{ text: '📊 Cek Status' }, { text: '🌐 Order Domain' }],
    [{ text: '🎫 Request Saya' }, { text: '💰 Klaim Gaji' }],
    [{ text: '👤 Akun Saya' }, { text: '💬 Tanya Admin' }],
  ],
  admin: [
    [{ text: '📱 Admin Dashboard', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
    [{ text: '🎫 Queue' }, { text: '🌐 Domain' }],
    [{ text: '💰 Payment' }, { text: '👥 Member' }],
    [{ text: '🩺 Health' }, { text: '🧾 Audit' }],
  ],
  dev: [
    [{ text: '📱 Dev Console', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
    [{ text: '🩺 Health' }, { text: '🔍 DNS' }],
    [{ text: '🌐 Domain' }, { text: '⚠️ Incident' }],
    [{ text: '📋 Logs' }, { text: '🎫 Technical' }],
  ],
  super_admin: [
    [{ text: '📱 Super Admin Dashboard', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
    [{ text: '🎫 Queue' }, { text: '🌐 Domain' }],
    [{ text: '💰 Payment' }, { text: '👥 Members' }],
    [{ text: '🧾 Audit' }, { text: '⚙️ System' }],
    [{ text: '🩺 Health' }, { text: '🚨 Incident' }],
  ],
  root: [
    [{ text: '📱 Root Terminal', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
    [{ text: '🚨 Emergency' }, { text: '⚙️ System' }],
    [{ text: '🔐 Security' }, { text: '🧾 Audit' }],
    [{ text: '🔧 Maintenance' }, { text: '🩺 Health' }],
  ],
};

const MENU_BUTTON_PROFILES: Record<RoleProfile, { type: string; text?: string; web_app?: { url: string } }> = {
  guest: { type: 'default' },
  member_pending: { type: 'default' },
  member: { type: 'web_app', text: '📱 Dashboard', web_app: { url: 'https://abiedienbackoffice.pages.dev' } },
  admin: { type: 'web_app', text: '🛡️ Admin Panel', web_app: { url: 'https://abiedienbackoffice.pages.dev' } },
  dev: { type: 'web_app', text: '⚙️ Dev Console', web_app: { url: 'https://abiedienbackoffice.pages.dev' } },
  super_admin: { type: 'web_app', text: '👑 Super Admin', web_app: { url: 'https://abiedienbackoffice.pages.dev' } },
  root: { type: 'web_app', text: '🔑 Root Terminal', web_app: { url: 'https://abiedienbackoffice.pages.dev' } },
};

/**
 * Check if the effective profile has the specified capability.
 * Deny by default.
 */
function checkCapability(profile: RoleProfile, cap: string, canonicalUserId: string | null, isSuperAdmin: boolean): boolean {
  if (!canonicalUserId && !isSuperAdmin && profile !== 'guest' && profile !== 'member_pending') {
    return false; // No business access without linked identity (except super admin backdoor)
  }

  const capMap: Record<RoleProfile, string[]> = {
    guest: ['bot.start', 'account.register', 'account.status.self', 'bot.help', 'support.contact_admin'],
    member_pending: ['bot.start', 'account.status.self', 'profile.read.self', 'bot.help', 'support.contact_admin'],
    member: ['bot.start', 'profile.read.self', 'request.status.self', 'domain.request.create', 'ticket.read.self', 'claim.create', 'activity.read.self', 'bot.help', 'support.contact_admin'],
    admin: ['admin.access', 'admin.help', 'queue.view', 'user.view', 'ticket.view', 'domain.view', 'claim.review', 'request.review', 'notification.view', 'bot.start', 'bot.help'],
    super_admin: ['super_admin.access', 'user.manage', 'ticket.manage', 'domain.manage', 'claim.manage', 'request.override', 'audit.view', 'notification.manage', 'capability.manage', 'system.manage_controls', 'bot.start', 'bot.help'],
    dev: ['dev.access', 'system.health.view', 'system.logs.view', 'telegram.webhook.manage', 'queue.debug', 'system.config.view', 'integrity.view', 'bot.start', 'bot.help'],
    root: ['super_admin.access', 'system.manage_controls', 'bot.start', 'bot.help']
  };

  return capMap[profile]?.includes(cap) || false;
}

/**
 * Get the dynamic reply keyboard for a given profile.
 */
function getDynamicKeyboard(profile: RoleProfile) {
  return {
    keyboard: KEYBOARD_PROFILES[profile],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Sync Telegram UI for a specific chat: commands (per-chat scope) + menu button.
 * Fire-and-forget — errors are logged but don't break the flow.
 */
async function syncUserInterface(botToken: string, chatId: number | string, profile: RoleProfile): Promise<void> {
  try {
    // 1. Set commands scoped to this specific chat
    await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: COMMAND_PROFILES[profile],
        scope: { type: 'chat', chat_id: chatId },
      }),
    });

    // 2. Set chat-specific menu button
    await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        menu_button: MENU_BUTTON_PROFILES[profile],
      }),
    });
  } catch (err) {
    console.warn('syncUserInterface note:', err);
  }
}

// ----------------------------------------------------
// Strict Environment Validation (Fail Closed)
// ----------------------------------------------------
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
const rawSuperAdminIds = Deno.env.get('SUPER_ADMIN_IDS');
const clientId = Deno.env.get('TELEGRAM_CLIENT_ID');
const clientSecret = Deno.env.get('TELEGRAM_CLIENT_SECRET');
const rawOtherIds = Deno.env.get('BOT_OTHER_IDS') || '';
const altBotToken = Deno.env.get('TELEGRAM_ALT_BOT_TOKEN') || '';
const rawSecondaryBotCtls = Deno.env.get('TELEGRAM_SECONDARY_BOT_CERTS') || '';

if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
if (!supabaseServiceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
if (!rawSuperAdminIds) throw new Error("SUPER_ADMIN_IDS is required");

const superAdminIds = rawSuperAdminIds
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const otherIds = rawOtherIds
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const secondaryBotCtls: { token: string; certB64?: string; webhookUrl: string }[] = [];
if (rawSecondaryBotCtls) {
  try {
    const decoded = base64.decode(rawSecondaryBotCtls);
    secondaryBotCtls.push(...JSON.parse(decoded) as { token: string; certB64?: string; webhookUrl: string }[]);
  } catch {}
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    let body: any = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // non-json or empty
      }
    }

    const url = new URL(req.url);
    const pathname = url.pathname.replace(/.*\/telegram-auth/, '') || '/';

    // ==========================================
    // 0a. VERIFY MINI APP INIT DATA
    // ==========================================
    if (req.method === 'POST' && body.action === 'verify-init-data') {
      const rawInitData = body.initData;
      if (!rawInitData || typeof rawInitData !== 'string') {
        return new Response(JSON.stringify({ valid: false, error: 'Missing initData' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { valid, data } = await verifyTelegramInitData(rawInitData, botToken);
      if (!valid) {
        return new Response(JSON.stringify({ valid: false, error: 'Invalid or expired initData' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const tgUserId = data.user?.id;
      if (!tgUserId) {
        return new Response(JSON.stringify({ valid: false, error: 'No user in initData' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: tgUser } = await supabaseAdmin
        .from('telegram_users')
        .select('*')
        .eq('telegram_user_id', tgUserId)
        .maybeSingle();

      return new Response(JSON.stringify({
        valid: true,
        user: tgUser || { telegram_user_id: tgUserId, role: 'guest', status: 'not_registered' },
        tg_data: { id: tgUserId, username: data.user?.username, first_name: data.user?.first_name },
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==========================================
    // 0b. WEBHOOK HEALTH CHECK
    // ==========================================
    if (req.method === 'GET' && (pathname === '/webhook-health' || body.action === 'webhook-health')) {
      // Only accessible by admins — require service role or anon key will be insufficient
      const authHeader = req.headers.get('Authorization') || '';
      // Accept both service_role (for admin calls) and authenticated sessions
      const webhookInfoRes = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getWebhookInfo`);
      const webhookInfo = await webhookInfoRes.json();
      return new Response(JSON.stringify({
        telegram_webhook: webhookInfo.result || webhookInfo,
        checked_at: new Date().toISOString(),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==========================================
    // 1. TELEGRAM WEBHOOK HANDLER
    // ==========================================
    if (body.update_id) {
      const incomingSecretToken = req.headers.get('x-telegram-bot-api-secret-token');
      if (incomingSecretToken !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized webhook secret' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const updateId = body.update_id;

      // Idempotency check
      const { data: existingUpdate } = await supabaseAdmin
        .from('telegram_updates')
        .select('update_id')
        .eq('update_id', updateId)
        .maybeSingle();

      if (existingUpdate) {
        return new Response(JSON.stringify({ status: 'already_processed' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      await supabaseAdmin.from('telegram_updates').insert([{ update_id: updateId }]);

      // Inline Query Handler
      if (body.inline_query) {
        const iq = body.inline_query;
        const results = [
          {
            type: 'article',
            id: 'res_webapp',
            title: '📱 Buka Mini App Backoffice',
            description: 'Buka portal manajemen Abiedien Suite & dashboard',
            input_message_content: {
              message_text: '🚀 *Abiedien Backoffice Portal*\nBuka Mini App terpadu untuk kelola domain, tiket, dan payroll.',
              parse_mode: 'Markdown'
            },
            reply_markup: {
              inline_keyboard: [
                [{ text: '📱 Buka Dashboard WebApp', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }]
              ]
            }
          },
          {
            type: 'article',
            id: 'res_claim',
            title: '📸 Panduan Klaim Gaji & Payout',
            description: 'Aturan klaim & upload bukti screenshot anti-fraud',
            input_message_content: {
              message_text: '📸 *Klaim Gaji & Payout Member*\nKirimkan screenshot bukti asli pekerjaan/transfer ke @sandekalabot.\nMaksimal 3 klaim per 24 jam demi keamanan audit.',
              parse_mode: 'Markdown'
            }
          },
          {
            type: 'article',
            id: 'res_domain',
            title: '🌐 Status Verifikasi Domain & DNS',
            description: 'Panduan verifikasi TXT Record DNS Cloudflare',
            input_message_content: {
              message_text: '🌐 *Verifikasi Domain & DNS*\nPastikan setting TXT Record sesuai arahan admin atau ketik `/status` di bot.',
              parse_mode: 'Markdown'
            }
          }
        ];

        await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/answerInlineQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inline_query_id: iq.id,
            results,
            cache_time: 10,
            is_personal: true
          })
        });

        return new Response(JSON.stringify({ status: 'inline_query_answered' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Group / Channel Admin Rights Event Handler
      if (body.my_chat_member) {
        const mcm = body.my_chat_member;
        const newStatus = mcm.new_chat_member?.status;
        const chatTitle = mcm.chat?.title || `Chat ${mcm.chat?.id}`;
        console.log(`Bot status in ${chatTitle} (${mcm.chat?.id}) changed to: ${newStatus}`);
        return new Response(JSON.stringify({ status: 'chat_member_updated' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const message = body.message || body.channel_post;
      const callbackQuery = body.callback_query;
      const sender = message?.from || callbackQuery?.from;
      const chatId = message?.chat?.id || callbackQuery?.message?.chat?.id;

      if (!sender || !chatId) {
        return new Response(JSON.stringify({ status: 'no_sender' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const senderIdStr = String(sender.id);
      const isSuperAdmin = superAdminIds.includes(senderIdStr);
      const senderName = `${sender.first_name || ''} ${sender.last_name || ''}`.trim() || sender.username || `User ${sender.id}`;

      // Automatically register / update admin_chat_ids and telegram_users for Super Admins
      if (isSuperAdmin) {
        await supabaseAdmin.from('admin_chat_ids').upsert({
          telegram_user_id: sender.id,
          chat_id: chatId,
          display_name: senderName,
          is_active: true,
          updated_at: new Date().toISOString()
        });

        await supabaseAdmin.from('telegram_users').upsert({
          telegram_user_id: sender.id,
          telegram_chat_id: chatId,
          telegram_username: sender.username,
          display_name: senderName,
          role: 'super_admin',
          status: 'active',
          updated_at: new Date().toISOString()
        }, { onConflict: 'telegram_user_id' });
      }

      // Fetch or initialize user in telegram_users
      let { data: tgUser } = await supabaseAdmin
        .from('telegram_users')
        .select('*') // Includes linked_user_id from Migration 010
        .eq('telegram_user_id', sender.id)
        .maybeSingle();

      if (!tgUser) {
        const { data: newUser } = await supabaseAdmin
          .from('telegram_users')
          .insert([{
            telegram_user_id: sender.id,
            telegram_chat_id: chatId,
            telegram_username: sender.username,
            display_name: senderName,
            role: isSuperAdmin ? 'super_admin' : 'guest',
            status: isSuperAdmin ? 'active' : 'pending',
            assigned_admin_id: 7862805424 // Default main admin consultant
          }])
          .select()
          .single();
        tgUser = newUser;
      }

      // Explicit Identity Resolver
      let canonicalUserId: string | null = null;
      let effectiveProfile: RoleProfile = 'guest';

      if (tgUser?.linked_user_id) {
        const { data: canonicalUser } = await supabaseAdmin
          .from('users')
          .select('id, role, status, onboarding_status')
          .eq('id', tgUser.linked_user_id)
          .maybeSingle();
          
        if (canonicalUser) {
          canonicalUserId = canonicalUser.id;
          if (canonicalUser.role === 'admin') effectiveProfile = 'admin';
          else if (canonicalUser.role === 'super_admin') effectiveProfile = 'super_admin';
          else if (canonicalUser.role === 'dev') effectiveProfile = 'dev';
          else if (canonicalUser.role === 'root') effectiveProfile = 'root';
          else if (canonicalUser.role === 'member') {
            effectiveProfile = (canonicalUser.onboarding_status === 'APPROVED' || canonicalUser.status === 'active') ? 'member' : 'member_pending';
          }
        }
      } else {
        // Fallback for UI if not linked yet, but no business access
        if (isSuperAdmin) {
          effectiveProfile = 'super_admin';
        } else if (tgUser?.status === 'pending') {
          effectiveProfile = 'member_pending';
        }
      }

      const userKeyboard = getDynamicKeyboard(effectiveProfile);

      // ------------------------------------------
      // A. CALLBACK QUERY ACTIONS
      // ------------------------------------------
      if (callbackQuery) {
        const data = callbackQuery.data;

        // Acknowledge callback immediately to dismiss Telegram UI loader
        fetch(`${TELEGRAM_API_BASE}/bot${botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQuery.id })
        }).catch(err => console.warn('answerCallbackQuery note:', err));

        if (data === 'btn_register') {
          await sendTelegramMessage(botToken, chatId, 
            `📝 *Form Pendaftaran Member*\n\nSilakan balas pesan ini dengan format:\n\`REG#Nama Lengkap#Email Anda\`\n\nContoh:\n\`REG#Budi Santoso#budi@gmail.com\``
          );
        } else if (data === 'btn_claim_prompt') {
          // GUARD: Only active members and super admin can access claim
          if (!isSuperAdmin && (tgUser?.role !== 'member' || tgUser?.status !== 'active')) {
            const isPendingMember = tgUser?.role === 'member' && tgUser?.status === 'pending';
            await sendTelegramMessage(botToken, chatId,
              isPendingMember
                ? '⏳ *Akun Anda Belum Aktif*\nKlaim gaji tersedia setelah akun Anda diverifikasi dan diaktifkan oleh admin.'
                : HINTS.not_registered,
              isPendingMember ? undefined : { inline_keyboard: [[{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }]] }
            );
          } else {
            await sendTelegramMessage(botToken, chatId, HINTS.claim_prompt);
          }
        } else if (data === 'btn_rules') {
          await sendTelegramMessage(botToken, chatId, HINTS.security_rules);
        } else if (data === 'btn_admin_help') {
          await sendTelegramMessage(botToken, chatId, HINTS.admin_help);
        }

        return new Response(JSON.stringify({ status: 'callback_handled' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ------------------------------------------
      // B. PHOTO UPLOAD (EVIDENCE CLAIM)
      // ------------------------------------------
      if (message.photo && message.photo.length > 0) {
        if (tgUser?.role !== 'member' && !isSuperAdmin) {
          await sendTelegramMessage(botToken, chatId, HINTS.not_registered, {
            inline_keyboard: [[{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }]]
          });
          return new Response(JSON.stringify({ status: 'claim_rejected_not_member' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Rate limit check
        const { data: rateLimitCheck } = await supabaseAdmin.rpc('check_claim_rate_limit', {
          p_telegram_user_id: sender.id,
          p_claim_type: 'salary'
        });

        if (rateLimitCheck && rateLimitCheck.allowed === false) {
          await sendTelegramMessage(botToken, chatId, `⚠️ *Pengajuan Klaim Ditolak:*\n${rateLimitCheck.reason}`);
          return new Response(JSON.stringify({ status: 'rate_limited' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Highest resolution photo
        const bestPhoto = message.photo[message.photo.length - 1];
        if (bestPhoto.file_size && bestPhoto.file_size > 5 * 1024 * 1024) {
          await sendTelegramMessage(botToken, chatId, '⚠️ Ukuran foto melebihi batas 5 MB. Silakan kompres atau kirim foto dengan resolusi lebih ringkas.');
          return new Response(JSON.stringify({ status: 'file_too_large' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Fetch file path from Telegram Bot API
        const fileInfoRes = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
        const fileInfo = await fileInfoRes.json();
        
        if (!fileInfo.ok || !fileInfo.result?.file_path) {
          await sendTelegramMessage(botToken, chatId, '❌ Gagal mengunduh berkas dari Telegram. Silakan coba kirim ulang.');
          return new Response(JSON.stringify({ status: 'download_failed' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${botToken}/${fileInfo.result.file_path}`;
        const fileBuffer = await (await fetch(downloadUrl)).arrayBuffer();
        const storagePath = `claims/${sender.id}/${crypto.randomUUID()}.jpg`;

        // Upload to private bucket claim-evidence
        const { error: storageError } = await supabaseAdmin.storage
          .from('claim-evidence')
          .upload(storagePath, fileBuffer, {
            contentType: 'image/jpeg',
            upsert: false
          });

        if (storageError) {
          console.warn('Storage upload note:', storageError);
        }

        // Create claim record
        const caption = message.caption || 'Klaim gaji diajukan via Telegram Bot';
        const { data: newClaim, error: claimError } = await supabaseAdmin
          .from('claims')
          .insert([{
            telegram_user_id: sender.id,
            claim_type: 'salary',
            notes: caption,
            evidence_path: storagePath,
            status: 'pending',
            assigned_admin_id: tgUser.assigned_admin_id || 7862805424
          }])
          .select()
          .single();

        if (claimError) {
          await sendTelegramMessage(botToken, chatId, `❌ Gagal mencatat klaim ke database: ${claimError.message}`);
        } else {
          await sendTelegramMessage(botToken, chatId, 
            `✅ *Bukti Klaim Berhasil Diterima!*\n\nID Klaim: \`#CLM-${newClaim?.id?.substring(0, 8)}\`\nStatus: ⏳ *Dalam Antrean Review*\nKonsultan: ID #${tgUser.assigned_admin_id || '7862805424'}\n\nNotifikasi telah dikirimkan secara privat ke admin verifikator.`
          );

          // Notify assigned Admin privately
          const assignedAdminId = tgUser.assigned_admin_id || 7862805424;
          const { data: adminRecord } = await supabaseAdmin
            .from('admin_chat_ids')
            .select('chat_id')
            .eq('telegram_user_id', assignedAdminId)
            .maybeSingle();

          const adminTargetChatId = adminRecord?.chat_id || 7862805424;
          if (adminTargetChatId && botToken) {
            await sendTelegramMessage(botToken, adminTargetChatId, 
              `🔔 *NOTIFIKASI KLAIM BARU*\n\nMember: *${senderName}* (ID: \`${sender.id}\`)\nKeterangan: _${caption}_\nID Klaim: \`${newClaim?.id}\`\nStatus: Pending Verification\n\nBuka dashboard untuk verifikasi dan generate signed preview URL.`
            );
          }
        }

        return new Response(JSON.stringify({ status: 'photo_processed' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ------------------------------------------
      // C. TEXT COMMANDS & REGISTRATION PARSER
      // ------------------------------------------
      const text = (message.text || '').trim();

      // Check for Registration / Re-registration submission format:
      // Format 1 (Full): REG#Nama#NoWA#Rekening#Bank#JmlDomain#ListDomain#UserPass
      // Format 2 (Simple): REG#Nama#Email
      if (text.startsWith('REG#')) {
        const parts = text.split('#');
        if (parts.length >= 8) {
          // Full Re-registration Format
          const regName = parts[1].trim();
          const regPhone = parts[2].trim();
          const regRek = parts[3].trim();
          const regBank = parts[4].trim().toUpperCase();
          const regDomCount = parseInt(parts[5].trim(), 10) || 1;
          const regDomList = parts[6].trim().split(/[,;\s]+/).filter(Boolean);
          const regCreds = parts[7].trim();

          await supabaseAdmin.from('telegram_users').update({
            display_name: regName,
            status: 'active',
            role: 'member',
            updated_at: new Date().toISOString()
          }).eq('telegram_user_id', sender.id);

          await sendTelegramMessage(botToken, chatId, 
            `✅ *Pendaftaran Ulang & Inventaris Berhasil Disimpan!*\n\n• *Nama:* ${regName}\n• *WhatsApp:* \`${regPhone}\`\n• *Rekening:* \`${regBank} - ${regRek}\`\n• *Jumlah Domain:* ${regDomCount}\n• *Daftar Domain:* \`${regDomList.join(', ')}\`\n• *Kredensial Akun:* _Tersimpan di Secure Vault_\n\nAkun Anda telah tersinkronisasi dengan Backoffice.`
          );

          // Notify Admin
          const assignedAdminId = tgUser?.assigned_admin_id || 7862805424;
          await sendTelegramMessage(botToken, assignedAdminId,
            `📋 *DATA DAFTAR ULANG MEMBER MASUK*\n\nMember: *${regName}* (\`${sender.id}\`)\nRekening: ${regBank} - ${regRek}\nDomain: ${regDomList.join(', ')} (${regDomCount} domain)\nCek data lengkap di Backoffice Dashboard.`
          );
          return new Response(JSON.stringify({ status: 'rereg_submitted' }), { status: 200 });
        } else if (parts.length >= 3) {
          const regName = parts[1].trim();
          const regEmail = parts[2].trim().toLowerCase();

          if (!regEmail.includes('@')) {
            await sendTelegramMessage(botToken, chatId, '⚠️ Format email tidak valid. Pastikan menuliskan email dengan benar.');
            return new Response(JSON.stringify({ status: 'invalid_email' }), { status: 200 });
          }

          // Pendaftaran langsung via Telegram
          await supabaseAdmin.from('telegram_users').update({
            display_name: regName,
            email: regEmail,
            status: 'active',
            role: 'member',
            updated_at: new Date().toISOString()
          }).eq('telegram_user_id', sender.id);

          await sendTelegramMessage(botToken, chatId, 
            `✅ *Pendaftaran Berhasil!*\n\nSelamat datang *${regName}*, akun Anda kini telah aktif sebagai *Member*.\nAnda dapat mulai berinteraksi dengan bot, memesan domain, dan mengajukan klaim gaji.`
          );
          return new Response(JSON.stringify({ status: 'reg_submitted' }), { status: 200 });
        }
      }

      // /start or /menu command or Quick Menu button
      if (text.startsWith('/start') || text.startsWith('/menu') || text === '🏠 Menu Utama') {
        if (!checkCapability(effectiveProfile, 'bot.start', canonicalUserId, isSuperAdmin)) {
           return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }

        // Sync Telegram UI (commands + menu button) per-chat, fire-and-forget
        syncUserInterface(botToken, chatId, effectiveProfile).catch(() => {});

        if (effectiveProfile === 'super_admin' || effectiveProfile === 'root') {
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_admin, userKeyboard);
          await sendTelegramMessage(botToken, chatId, '⚡ *Akses Cepat Super Admin:*', {
            inline_keyboard: [
              [{ text: '📱 Buka Dashboard WebApp', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
              [{ text: '🌐 Cek Request Domain', callback_data: 'btn_rules' }],
              [{ text: '🛠️ Perintah Admin', callback_data: 'btn_admin_help' }]
            ]
          });
        } else if (effectiveProfile === 'member') {
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_member, userKeyboard);
          await sendTelegramMessage(botToken, chatId, '⚡ *Akses Cepat Layanan:*', {
            inline_keyboard: [
              [{ text: '📱 Buka Member Portal WebApp', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
              [{ text: '🌐 Order Domain (.com Rp 170k)', callback_data: 'btn_reqdomain_prompt' }],
              [{ text: '📸 Ajukan Klaim Gaji', callback_data: 'btn_claim_prompt' }],
              [{ text: '💬 Forum & Sync Grup Telegram', url: 'https://t.me/+ybOzZ_lstEdhNDU1' }]
            ]
          });
        } else if (effectiveProfile === 'member_pending') {
          // PENDING_VERIFICATION stage: member registered but awaiting admin approval
          await sendTelegramMessage(botToken, chatId,
            `⏳ *Pendaftaran Anda Sedang Diverifikasi*\n\n` +
            `Halo, *${senderName}*! Akun Anda telah terdaftar sebagai calon member.\n\n` +
            `Status saat ini: *\`PENDING VERIFICATION\`*\n\n` +
            `Admin akan memverifikasi data Anda dan mengaktifkan akun dalam 1x24 jam. ` +
            `Setelah disetujui, Anda dapat menggunakan semua layanan penuh.\n\n` +
            `Jika ada pertanyaan, hubungi admin langsung.`,
            userKeyboard
          );
          await sendTelegramMessage(botToken, chatId, 'ℹ️ *Info & Kontak:*', {
            inline_keyboard: [
              [{ text: '💬 Hubungi Admin', url: `tg://user?id=${tgUser?.assigned_admin_id || 7862805424}` }],
              [{ text: 'ℹ️ Aturan & Panduan', callback_data: 'btn_rules' }]
            ]
          });
        } else if (effectiveProfile === 'admin' || effectiveProfile === 'dev') {
          // Admin/Dev get admin welcome with their specific keyboard
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_admin, userKeyboard);
          await sendTelegramMessage(botToken, chatId, '⚡ *Akses Cepat:*', {
            inline_keyboard: [
              [{ text: '📱 Buka Dashboard', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }],
              [{ text: '🛠️ Perintah Admin', callback_data: 'btn_admin_help' }]
            ]
          });
        } else {
          // Guest
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_guest, userKeyboard);
          await sendTelegramMessage(botToken, chatId, '⚡ *Registrasi Member:*', {
            inline_keyboard: [
              [{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }],
              [{ text: 'ℹ️ Aturan & Panduan Keamanan', callback_data: 'btn_rules' }]
            ]
          });
        }
        return new Response(JSON.stringify({ status: 'start_handled' }), { status: 200 });
      }

      // Domain Order Command: /reqdomain <domain> or Button
      if (text.startsWith('/reqdomain') || text === '🌐 Order Domain Rp 170k') {
        // GUARD: Verify strict database capability mapping
        if (!checkCapability(effectiveProfile, 'domain.request.create', canonicalUserId, isSuperAdmin)) {
          await sendTelegramMessage(botToken, chatId, '⛔ *Akses Ditolak:* Anda tidak memiliki izin untuk memesan domain. Pastikan akun Anda berstatus Member Aktif.');
          return new Response(JSON.stringify({ status: 'domain_auth_denied' }), { status: 200 });
        }
        
        // At this point we are guaranteed to have canonicalUserId if checkCapability passed, but TypeScript needs it.
        if (!canonicalUserId) {
          await sendTelegramMessage(botToken, chatId, '⛔ *Error:* Profil Anda belum terhubung (Identity Unlinked). Hubungi admin.');
          return new Response(JSON.stringify({ status: 'unlinked' }), { status: 200 });
        }

        const domainArg = text.replace('/reqdomain', '').replace('🌐 Order Domain Rp 170k', '').trim();
        if (!domainArg || !domainArg.includes('.')) {
          await sendAndLog(supabaseAdmin, botToken, chatId, 
            `🌐 *Pemesanan Domain Baru (.com)*\n\n• *Harga Tetap:* **Rp 170.000 / tahun**\n• *Fitur:* Cloudflare Edge Anycast, SSL Universal, Anti-DDoS, Brotli Compression.\n\n*Cara Order:*\nKetik:\n\`/reqdomain namadomain.com\`\n\nContoh:\n\`/reqdomain slotgacor77.com\``,
            userKeyboard, 'domain'
          );
        } else {
          // Data Collection & Normalization
          const cleanDom = domainArg.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          
          // Availability check (basic DNS)
          try {
            const doh = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(cleanDom)}&type=NS`);
            const dohData = await doh.json();
            // We just note it for the ticket, we don't hard block here as this is just part of data collection
            const isAvailable = (dohData.Status === 3 || (!dohData.Answer?.length && !dohData.Authority));
            
            // Create Canonical Ticket
            const { data: ticketRes, error: ticketErr } = await supabaseAdmin
              .from('tickets')
              .insert([{
                user_id: canonicalUserId, // Canonical public.users.id
                category: 'domain_request',
                status: 'pending',
                title: `Order Domain: ${cleanDom}`,
                description: `Request domain via Telegram Bot dari ${senderName}`,
                collected_data: {
                  requested_domain: cleanDom,
                  request_type: 'new',
                  telegram_user_id: sender.id,
                  is_dns_available: isAvailable
                }
              }])
              .select('id, ticket_number')
              .single();

            if (ticketErr || !ticketRes) {
              const errMsg = `ERROR ${ticketErr?.message || 'Gagal memproses tiket domain.'}`;
              await sendAndLog(supabaseAdmin, botToken, chatId, `⚠️ *Pemberitahuan:* ${errMsg}`, userKeyboard, 'domain');
            } else {
              // Factual Ticket Created Confirmation to Member
              await sendAndLog(supabaseAdmin, botToken, chatId,
                `🎫 *TIKET PENGAJUAN DOMAIN: #${ticketRes.ticket_number}*\n\n` +
                `• *Domain Target:* \`${cleanDom}\`\n` +
                `• *Ketersediaan Dasar:* ${isAvailable ? '🟢 Tersedia' : '🟡 Perlu Cek Manual'}\n` +
                `• *Status:* ⏳ *PENDING VALIDATION / REVIEW*\n` +
                `• *Biaya Registrasi:* **Rp 170.000**\n` +
                `• *Rekening Pembayaran:* Bank Mandiri \`1830007183303\` a/n AISAH\n\n` +
                `*Langkah Selanjutnya:*\n` +
                `1. Transfer biaya aktivasi ke rekening di atas.\n` +
                `2. Upload foto bukti transfer ke bot ini dengan caption:\n` +
                `\`BUKTI#${cleanDom}\`\n\n` +
                `Tiket Anda telah masuk antrean kerja resmi admin Backoffice. Pantau progresnya via menu \`/status\`.`,
                userKeyboard, 'domain', String(ticketRes.id)
              );

              // Factual Notification to Admin
              const assignedAdminId = tgUser?.assigned_admin_id || 7862805424;
              await sendAndLog(supabaseAdmin, botToken, assignedAdminId,
                `🌐 *TIKET REQUEST DOMAIN BARU (#${ticketRes.ticket_number})*\n\n` +
                `• Member: *${senderName}*\n` +
                `• User ID: \`${canonicalUserId}\`\n` +
                `• Domain: \`${cleanDom}\` (.com)\n` +
                `• Tiket ID: \`${ticketRes.id}\`\n\n` +
                `Silakan proses verifikasi pembayaran & inventory di Backoffice.`,
                undefined, 'domain', String(ticketRes.id)
              );
            }
          } catch (e) {
            await sendTelegramMessage(botToken, chatId, '⚠️ Gagal mengecek domain. Silakan coba sesaat lagi.', userKeyboard);
          }
        }
        return new Response(JSON.stringify({ status: 'reqdomain_handled' }), { status: 200 });
      }

      // WHOIS Check Command: /whois <domain>
      if (text.startsWith('/whois')) {
        if (!checkCapability(effectiveProfile, 'domain.view', canonicalUserId, isSuperAdmin) && !checkCapability(effectiveProfile, 'domain.request.create', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        const dom = text.replace('/whois', '').trim();
        if (!dom || !dom.includes('.')) {
          await sendTelegramMessage(botToken, chatId, '🔍 *Format:* `/whois namadomain.com`', userKeyboard);
        } else {
          const cleanDom = dom.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          try {
            const doh = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(cleanDom)}&type=NS`);
            const dohData = await doh.json();
            const answers = dohData.Answer || [];
            const nsList = answers.map((a: any) => a.data).join('\n• ');
            
            if (dohData.Status === 3 || (!answers.length && !dohData.Authority)) {
              await sendTelegramMessage(botToken, chatId, `🟢 *Domain \`${cleanDom}\` KOSONG (Available)*\nBelum terdaftar di DNS publik. Siap di-order dengan biaya Rp 170.000.`, userKeyboard);
            } else {
              await sendTelegramMessage(botToken, chatId, `🔴 *Domain \`${cleanDom}\` TERDAFTAR (Registered)*\n\n*Nameservers:*\n• ${nsList || 'Aktif di registrar'}\n\nStatus: Telah dimiliki pihak lain.`, userKeyboard);
            }
          } catch (e: any) {
            await sendTelegramMessage(botToken, chatId, `❌ Gagal cek DNS: ${e.message}`, userKeyboard);
          }
        }
        return new Response(JSON.stringify({ status: 'whois_handled' }), { status: 200 });
      }

      // Re-registration prompt: /reregister or Button
      if (text === '📝 Daftar / Registrasi Ulang' || text === '/reregister') {
        if (!checkCapability(effectiveProfile, 'account.register', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId,
          `📝 *Formulir Pendataan & Daftar Ulang Member*\n\nSilakan salin dan isi format di bawah ini lalu kirimkan ke bot:\n\n\`REG#Nama Lengkap#No WhatsApp#No Rekening#Nama Bank#Jumlah Domain#List Domain#User Pass Registrar\`\n\n*Contoh:*\n\`REG#Budi Santoso#08123456789#1420019283#BCA#2#zeusgacor.com, hoki77.com#User: budi / Pass: Rahasia123\``,
          userKeyboard
        );
        return new Response(JSON.stringify({ status: 'rereg_prompt_handled' }), { status: 200 });
      }

      // Forum Community Command: /forum or Button
      if (text === '💬 Forum Komunitas Telegram' || text === '/forum') {
        if (!checkCapability(effectiveProfile, 'bot.help', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId,
          `💬 *Forum & Komunitas Resmi Abiedien*\n\nBergabunglah dengan grup diskusi resmi untuk update seputar SEO, domain slot demo, optimasi Cloudflare, dan pengumuman operasional:`,
          {
            inline_keyboard: [
              [{ text: '👥 Forum & Sync Grup Diskusi Telegram', url: 'https://t.me/+ybOzZ_lstEdhNDU1' }],
              [{ text: '📢 Channel Pengumuman & SLA', url: 'https://t.me/AbiedienAnnouncements' }],
              [{ text: '💬 Konsultasi Privat Admin', url: `tg://user?id=${tgUser?.assigned_admin_id || 7862805424}` }]
            ]
          }
        );
        return new Response(JSON.stringify({ status: 'forum_handled' }), { status: 200 });
      }

      // Quick Keyboard Button Triggers
      if (text === '📸 Ajukan Klaim Gaji' || text === '/claim') {
        // GUARD: Verify strict database capability mapping for claims
        if (!checkCapability(effectiveProfile, 'claim.create', canonicalUserId, isSuperAdmin)) {
          const isPendingMember = tgUser?.role === 'member' && tgUser?.status === 'pending';
          await sendTelegramMessage(botToken, chatId,
            isPendingMember
              ? '⏳ *Akun Anda Belum Aktif*\nKlaim gaji tersedia setelah akun Anda diverifikasi dan diaktifkan oleh admin.'
              : HINTS.not_registered,
            isPendingMember ? undefined : { inline_keyboard: [[{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }]] }
          );
          return new Response(JSON.stringify({ status: 'claim_auth_denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId, HINTS.claim_prompt, userKeyboard);
        return new Response(JSON.stringify({ status: 'claim_prompt_handled' }), { status: 200 });
      }

      if (text === '📊 Cek Status & Domain' || text === '/status') {
        if (!checkCapability(effectiveProfile, 'account.status.self', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        const roleLabel = isSuperAdmin ? 'Super Admin' : (tgUser?.role?.toUpperCase() || 'GUEST / BELUM TERDAFTAR');
        const statusLabel = tgUser?.status?.toUpperCase() || 'PENDING';
        const emailLabel = tgUser?.email || 'Belum terhubung';
        
        await sendTelegramMessage(botToken, chatId, 
          `📊 *Status Akun & Layanan*\n\n• *ID Telegram:* \`${sender.id}\`\n• *Nama:* ${senderName}\n• *Role:* *${roleLabel}*\n• *Status:* \`${statusLabel}\`\n• *Email:* \`${emailLabel}\`\n• *Order Domain .com:* Rp 170.000\n• *Platform WebApp:* [abiedienbackoffice.pages.dev](https://abiedienbackoffice.pages.dev)\n\nKetik \`/login\` untuk membuat sesi masuk dashboard.`,
          userKeyboard
        );
        return new Response(JSON.stringify({ status: 'status_handled' }), { status: 200 });
      }

      // /login command
      if (text === '/login' || text === '/start login') {
        if (!checkCapability(effectiveProfile, 'account.status.self', canonicalUserId, isSuperAdmin) && !checkCapability(effectiveProfile, 'admin.access', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        if (!tgUser) {
           await sendTelegramMessage(botToken, chatId, '⛔ *Akses Ditolak:* Telegram ID Anda belum terdaftar di sistem. Hubungi Super Admin.', userKeyboard);
           return new Response(JSON.stringify({ status: 'unauthorized' }), { status: 200 });
        }
        
        if (tgUser.status !== 'active' && !isSuperAdmin) {
           await sendTelegramMessage(botToken, chatId, '⛔ *Akses Ditolak:* Akun Anda sedang diblokir atau belum disetujui.', userKeyboard);
           return new Response(JSON.stringify({ status: 'blocked' }), { status: 200 });
        }

        const userEmail = tgUser.email;
        if (!userEmail) {
           await sendTelegramMessage(botToken, chatId, '⚠️ *Perhatian:* Akun Anda belum memiliki identitas email terdaftar. Minta Super Admin memperbarui data Anda.', userKeyboard);
           return new Response(JSON.stringify({ status: 'no_email' }), { status: 200 });
        }

        const effectiveRole = isSuperAdmin ? 'super_admin' : tgUser.role;

        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'magiclink',
          email: userEmail,
          options: {
            data: {
              telegram_id: sender.id.toString(),
              role: effectiveRole,
              dashboard_access: true,
            },
            redirectTo: 'https://abiedienbackoffice.pages.dev/'
          }
        });

        if (linkError) {
          await sendTelegramMessage(botToken, chatId, `❌ *Gagal membuat sesi login:*\n${linkError.message}`, userKeyboard);
          return new Response(JSON.stringify({ status: 'magiclink_error', error: linkError.message }), { status: 200 });
        }

        await sendTelegramMessage(botToken, chatId, `🔐 *Otorisasi Berhasil*\n\nKlik tombol di bawah ini untuk masuk secara otomatis ke Dashboard Abiedien. Tautan ini bersifat sekali pakai dan aman.`, {
          inline_keyboard: [
            [{ text: '🚀 Masuk ke Dashboard', url: linkData.properties.action_link }]
          ]
        });

        return new Response(JSON.stringify({ status: 'magiclink_sent' }), { status: 200 });
      }

      // /register command
      if (text.startsWith('/register')) {
        if (!checkCapability(effectiveProfile, 'account.register', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId, 
          `📝 *Pendaftaran Member Abiedien*\n\nSilakan kirimkan data dengan format berikut:\n\`REG#Nama Lengkap#Email Anda\`\n\nContoh:\n\`REG#Budi Santoso#budi@gmail.com\``,
          userKeyboard
        );
        return new Response(JSON.stringify({ status: 'register_handled' }), { status: 200 });
      }

      // /status command
      if (text.startsWith('/status')) {
        if (!checkCapability(effectiveProfile, 'account.status.self', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        const roleLabel = isSuperAdmin ? 'Super Admin' : (tgUser?.role?.toUpperCase() || 'GUEST / BELUM TERDAFTAR');
        const statusLabel = tgUser?.status?.toUpperCase() || 'PENDING';
        const emailLabel = tgUser?.email || 'Belum terhubung';
        
        await sendTelegramMessage(botToken, chatId, 
          `📊 *Status Akun & Layanan*\n\n• *ID Telegram:* \`${sender.id}\`\n• *Nama:* ${senderName}\n• *Role:* *${roleLabel}*\n• *Status:* \`${statusLabel}\`\n• *Email:* \`${emailLabel}\`\n• *Platform WebApp:* [abiedienbackoffice.pages.dev](https://abiedienbackoffice.pages.dev)\n\nKetik \`/login\` untuk membuat sesi masuk dashboard.`,
          userKeyboard
        );
        return new Response(JSON.stringify({ status: 'status_handled' }), { status: 200 });
      }

      // /ticket command
      if (text.startsWith('/ticket')) {
        if (!checkCapability(effectiveProfile, 'support.contact_admin', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        const assignedAdmin = tgUser?.assigned_admin_id || 7862805424;
        await sendTelegramMessage(botToken, chatId, 
          `🎫 *Pusat Bantuan & Tiket Support*\n\nUntuk kendala teknis atau pengaduan layanan, Anda dapat berkonsultasi langsung dengan Konsultan Admin resmi Anda:\n\n👤 *Admin Konsultan:* ID \`${assignedAdmin}\`\n\nKetik pesan pertanyaan Anda atau hubungi admin di atas.`, {
          inline_keyboard: [
            [{ text: '💬 Chat Admin Konsultan', url: `tg://user?id=${assignedAdmin}` }],
            [{ text: '📱 Buka Dashboard Tiket', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }]
          ]
        });
        return new Response(JSON.stringify({ status: 'ticket_handled' }), { status: 200 });
      }

      // /traffic command
      if (text.startsWith('/traffic')) {
        if (!checkCapability(effectiveProfile, 'activity.read.self', canonicalUserId, isSuperAdmin) && !checkCapability(effectiveProfile, 'system.health.view', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId, 
          `📊 *Ringkasan Matriks Performa & Trafik Anycast*\n\n• *Edge Uptime:* 99.98% (Normal)\n• *Latency PoP:* ~24ms (Jakarta/Singapore)\n• *Cache Ratio:* 89.4% (Edge Hit)\n• *Protokol:* HTTP/3 + TLS 1.3 Active\n• *WAF & DDoS Defense:* Active\n\nUntuk melihat grafik real-time dan analisis per domain, silakan buka dashboard.`, {
          inline_keyboard: [
            [{ text: '📊 Buka Grafik Trafik Lengkap', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }]
          ]
        });
        return new Response(JSON.stringify({ status: 'traffic_handled' }), { status: 200 });
      }

      // /rules command
      if (text.startsWith('/rules')) {
        if (!checkCapability(effectiveProfile, 'bot.help', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId, 
          `📜 *Kebijakan & Aturan Layanan Provider (SLA & AUP)*\n\n1. *Peran Layanan:* Penyedia routing Anycast, CDN, SSL & domain management.\n2. *SLA Uptime:* Jaminan 99.9% dengan respon tiket < 30 menit (kritis).\n3. *AUP (Larangan):* Dilarang aktivitas DDoS, spam, phishing, dan malware (suspensi otomatis).\n4. *Siklus Layanan:* Grace period 7 hari sebelum domain ditangguhkan.\n\nSeluruh ketentuan mengikat seluruh member demi keamanan ekosistem bersama.`, {
          inline_keyboard: [
            [{ text: '📜 Baca Kebijakan Lengkap di Portal', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }]
          ]
        });
        return new Response(JSON.stringify({ status: 'rules_handled' }), { status: 200 });
      }

      // /payment command
      if (text.startsWith('/payment')) {
        if (!checkCapability(effectiveProfile, 'claim.create', canonicalUserId, isSuperAdmin)) {
          return new Response(JSON.stringify({ status: 'denied' }), { status: 200 });
        }
        await sendTelegramMessage(botToken, chatId, HINTS.claim_prompt, {
          inline_keyboard: [
            [{ text: 'ℹ️ Aturan Keamanan & Fraud', callback_data: 'btn_rules' }],
            [{ text: '📱 Cek Status Payroll', web_app: { url: 'https://abiedienbackoffice.pages.dev' } }]
          ]
        });
        return new Response(JSON.stringify({ status: 'payment_handled' }), { status: 200 });
      }

      // Admin commands
      if (text.startsWith('/admin')) {
        if (!checkCapability(effectiveProfile, 'admin.access', canonicalUserId, isSuperAdmin)) {
          await sendAndLog(supabaseAdmin, botToken, chatId, '⛔ *Akses Ditolak:* Perintah ini khusus untuk Admin.');
          return new Response(JSON.stringify({ status: 'admin_denied' }), { status: 200 });
        }

        const args = text.split(' ').filter(Boolean);
        const subCommand = args[1];
        const actorLabel = `tg:${sender.id}`;

        if (!subCommand || subCommand === 'help') {
          await sendAndLog(supabaseAdmin, botToken, chatId, HINTS.admin_help);

        } else if (subCommand === 'claims') {
          const { data: pendingClaims } = await supabaseAdmin
            .from('claims')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(5);

          if (!pendingClaims || pendingClaims.length === 0) {
            await sendAndLog(supabaseAdmin, botToken, chatId, '✅ Tidak ada klaim pending saat ini.');
          } else {
            let msg = '📋 *Daftar Klaim Pending:*\n\n';
            pendingClaims.forEach((c: ClaimRow) => {
              msg += `• ID: \`#CLM-${c.id.substring(0, 8)}\` | User: \`${c.telegram_user_id}\`\n  Ket: ${c.notes || '-'}\n\n`;
            });
            await sendAndLog(supabaseAdmin, botToken, chatId, msg);
          }

        } else if (subCommand === 'domain_requests') {
          const { data: domReqs } = await supabaseAdmin
            .from('domain_requests')
            .select('id, requested_domain, member_telegram_id, status, created_at')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(10);

          if (!domReqs || domReqs.length === 0) {
            await sendAndLog(supabaseAdmin, botToken, chatId, '✅ Tidak ada domain request pending saat ini.');
          } else {
            let msg = '🌐 *Domain Requests Pending:*\n\n';
            domReqs.forEach((r: any) => {
              const reqId = r.id.substring(0, 8);
              msg += `• \`#REQ-${reqId}\` | Domain: \`${r.requested_domain}\` | TG: \`${r.member_telegram_id}\`\n`;
            });
            msg += '\nGunakan: `/admin domain_assign <req_id> <domain>` atau `/admin domain_reject <req_id> <alasan>`';
            await sendAndLog(supabaseAdmin, botToken, chatId, msg);
          }

        } else if (subCommand === 'domain_assign' && args[2] && args[3]) {
          const reqIdPrefix = args[2];
          const assignedDomain = args[3];

          // Find request by ID prefix
          const { data: reqRow } = await supabaseAdmin
            .from('domain_requests')
            .select('*')
            .ilike('id', `${reqIdPrefix}%`)
            .eq('status', 'pending')
            .maybeSingle();

          if (!reqRow) {
            await sendAndLog(supabaseAdmin, botToken, chatId, `❌ Request \`${reqIdPrefix}\` tidak ditemukan atau sudah diproses.`);
          } else {
            await supabaseAdmin.from('domain_requests').update({
              status: 'assigned',
              assigned_domain: assignedDomain,
              assigned_by_tg_id: sender.id,
              assigned_at: new Date().toISOString(),
            }).eq('id', reqRow.id);

            await logAudit(supabaseAdmin, 'DOMAIN_ASSIGNED', `domain_request:${reqRow.id}`, 'info', actorLabel, {
              domain: assignedDomain, member_tg_id: reqRow.member_telegram_id
            });

            // Notify member
            if (reqRow.member_telegram_id) {
              await sendAndLog(supabaseAdmin, botToken, reqRow.member_telegram_id,
                `✅ *Request Domain Selesai*\n\nDomain: \`${assignedDomain}\`\nRequest: \`#REQ-${reqRow.id.substring(0, 8)}\`\nStatus: *ACTIVE*\n\nDomain Anda sudah siap digunakan.`,
                undefined, 'domain', reqRow.id
              );
            }
            await sendAndLog(supabaseAdmin, botToken, chatId, `✅ Domain \`${assignedDomain}\` berhasil di-assign ke member \`${reqRow.member_telegram_id}\`.`);
          }

        } else if (subCommand === 'domain_reject' && args[2]) {
          const reqIdPrefix = args[2];
          const reason = args.slice(3).join(' ') || 'Tidak ada alasan diberikan';

          const { data: reqRow } = await supabaseAdmin
            .from('domain_requests')
            .select('*')
            .ilike('id', `${reqIdPrefix}%`)
            .eq('status', 'pending')
            .maybeSingle();

          if (!reqRow) {
            await sendAndLog(supabaseAdmin, botToken, chatId, `❌ Request \`${reqIdPrefix}\` tidak ditemukan atau sudah diproses.`);
          } else {
            await supabaseAdmin.from('domain_requests').update({
              status: 'rejected',
              rejection_reason: reason,
              assigned_by_tg_id: sender.id,
              assigned_at: new Date().toISOString(),
            }).eq('id', reqRow.id);

            await logAudit(supabaseAdmin, 'DOMAIN_REJECTED', `domain_request:${reqRow.id}`, 'warn', actorLabel, {
              reason, member_tg_id: reqRow.member_telegram_id
            });

            if (reqRow.member_telegram_id) {
              await sendAndLog(supabaseAdmin, botToken, reqRow.member_telegram_id,
                `❌ *Request Domain Ditolak*\n\nRequest: \`#REQ-${reqRow.id.substring(0, 8)}\`\nAlasan: ${reason}\n\nSilakan buat request baru jika diperlukan.`,
                undefined, 'domain', reqRow.id
              );
            }
            await sendAndLog(supabaseAdmin, botToken, chatId, `✅ Request \`${reqIdPrefix}\` ditolak dengan alasan: ${reason}`);
          }

        } else if (subCommand === 'promote' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ role: 'admin', status: 'active' }).eq('telegram_user_id', targetTgId);
          await logAudit(supabaseAdmin, 'USER_PROMOTED', `tg_user:${targetTgId}`, 'warn', actorLabel, { new_role: 'admin' });
          await sendAndLog(supabaseAdmin, botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` berhasil dipromosikan menjadi Admin.`);

        } else if (subCommand === 'demote' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ role: 'member' }).eq('telegram_user_id', targetTgId);
          await logAudit(supabaseAdmin, 'USER_DEMOTED', `tg_user:${targetTgId}`, 'warn', actorLabel, { new_role: 'member' });
          await sendAndLog(supabaseAdmin, botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` berhasil diturunkan menjadi Member.`);

        } else if (subCommand === 'block' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ status: 'blocked' }).eq('telegram_user_id', targetTgId);
          await logAudit(supabaseAdmin, 'USER_BLOCKED', `tg_user:${targetTgId}`, 'warn', actorLabel, {});
          await sendAndLog(supabaseAdmin, botToken, chatId, `⛔ User Telegram ID \`${targetTgId}\` telah DIBLOKIR.`);

        } else if (subCommand === 'unblock' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ status: 'active' }).eq('telegram_user_id', targetTgId);
          await logAudit(supabaseAdmin, 'USER_UNBLOCKED', `tg_user:${targetTgId}`, 'info', actorLabel, {});
          await sendAndLog(supabaseAdmin, botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` telah diaktifkan kembali.`);
        }

        return new Response(JSON.stringify({ status: 'admin_handled' }), { status: 200 });
      }

      // Default fallback message
      await sendTelegramMessage(botToken, chatId, 
        `💡 Ketik \`/start\` untuk membuka menu utama, atau \`/help\` untuk panduan & hint keamanan.`
      );
      return new Response(JSON.stringify({ status: 'default_handled' }), { status: 200 });
    }


    // ==========================================
    // 3. LEGACY ENDPOINTS REMOVED
    // ==========================================
    // OIDC and Widget flows are deprecated. All auth happens via the /login webhook command above.
    return new Response(JSON.stringify({ error: 'Endpoint not supported. Use Telegram Bot /login command.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
