// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';

declare const Deno: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';

// Per-bot token resolution map (bot handle → token)
const SUPPORTED_BOTS: Array<{ handle: string; tokenEnv: string; description: string; role: string }> = [
  { handle: '@sandekalabot', tokenEnv: 'BOT_TOKEN_DEFAULT', description: 'Bot Utama Super Admin', role: 'super_admin' },
  { handle: '@mrssandebot', tokenEnv: 'BOT_TOKEN_PAYMENT', description: 'Bot Payment & Payroll Admin', role: 'super_admin' },
  { handle: '@felixsnd', tokenEnv: 'BOT_TOKEN_ADMIN', description: 'Bot Admin Operations', role: 'admin' },
  { handle: '@Sandeteam', tokenEnv: 'BOT_TOKEN_DEV', description: 'Bot Developer & Engineering', role: 'dev' },
  { handle: '@asiangaming11', tokenEnv: 'BOT_TOKEN_OPERATOR', description: 'Bot Operator & Payment', role: 'operator' },
  { handle: '@rianbayubastian', tokenEnv: 'BOT_TOKEN_FORUM', description: 'Bot Forum & Community Group', role: 'operator' },
  { handle: '@abiedien_monitoring_bot', tokenEnv: 'BOT_TOKEN_MONITORING', description: 'Bot Monitoring & Health Check', role: 'dev' },
  { handle: '@sandekala_hr_bot', tokenEnv: 'BOT_TOKEN_HR_PAYROLL', description: 'Bot HR / Payroll & Gaji', role: 'admin' },
  { handle: '@domain_ops_bot', tokenEnv: 'BOT_TOKEN_DOMAIN', description: 'Bot Operasional Domain & Hosting', role: 'dev' },
  { handle: '@community_support_bot', tokenEnv: 'BOT_TOKEN_SUPPORT', description: 'Bot Komunitas & Support Member', role: 'operator' },
];

function resolveBotToken(tokenEnv: string): string {
  return Deno.env.get(tokenEnv) || Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
}

const BOT_TOKEN_MAP: Record<string, string> = {};
for (const b of SUPPORTED_BOTS) {
  BOT_TOKEN_MAP[b.handle] = resolveBotToken(b.tokenEnv);
}

const BOT_TO_GROUP_MAP: Record<string, string[]> = {
  '@sandekalabot': [
    'Sandekala Inc. Board',
    'Sandekala Operations Room',
    'Sandekala Public Channel',
    'Sandekala Test Lab',
    'Super Admin Command Center'
  ],
  '@mrssandebot': [
    'Payment & Payroll Admin',
    'Finance Operations',
    'Salary Processing Room'
  ],
  '@felixsnd': [
    'Admin Operations',
    'Staff Management'
  ],
  '@Sandeteam': [
    'Development Team',
    'Engineering Lab'
  ],
  '@asiangaming11': [
    'Operator Hub',
    'Payment Processing'
  ],
  '@rianbayubastian': [
    'Forum Community',
    'Group Discussion'
  ],
  '@abiedien_monitoring_bot': ['Monitoring & Alert Room', 'System Health Dashboard'],
  '@sandekala_hr_bot': ['HR & Payroll Team', 'Employees Direct'],
  '@domain_ops_bot': ['Domain Operations Team', 'DNS & Registrar Alerts'],
  '@community_support_bot': ['Member Community Support', 'Verified Member Forum'],
};

const SUPPORTED_GROUPS: Array<{ groupId: string; title: string; botHandle: string; type: 'staff' | 'public' | 'private' }> = [
  { groupId: 'Sandekala Inc. Board', title: 'Sandekala Inc. Board', botHandle: '@sandekalabot', type: 'staff' },
  { groupId: 'Sandekala Operations Room', title: 'Sandekala Operations Room', botHandle: '@sandekalabot', type: 'staff' },
  { groupId: 'Sandekala Public Channel', title: 'Sandekala Public Channel', botHandle: '@sandekalabot', type: 'public' },
  { groupId: 'Sandekala Test Lab', title: 'Sandekala Test Lab', botHandle: '@sandekalabot', type: 'public' },
  { groupId: 'Super Admin Command Center', title: 'Super Admin Command Center', botHandle: '@sandekalabot', type: 'private' },
  { groupId: 'Payment & Payroll Admin', title: 'Payment & Payroll Admin', botHandle: '@mrssandebot', type: 'private' },
  { groupId: 'Finance Operations', title: 'Finance Operations', botHandle: '@mrssandebot', type: 'staff' },
  { groupId: 'Salary Processing Room', title: 'Salary Processing Room', botHandle: '@mrssandebot', type: 'private' },
  { groupId: 'Admin Operations', title: 'Admin Operations', botHandle: '@felixsnd', type: 'staff' },
  { groupId: 'Staff Management', title: 'Staff Management', botHandle: '@felixsnd', type: 'private' },
  { groupId: 'Development Team', title: 'Development Team', botHandle: '@Sandeteam', type: 'staff' },
  { groupId: 'Engineering Lab', title: 'Engineering Lab', botHandle: '@Sandeteam', type: 'private' },
  { groupId: 'Operator Hub', title: 'Operator Hub', botHandle: '@asiangaming11', type: 'staff' },
  { groupId: 'Payment Processing', title: 'Payment Processing', botHandle: '@asiangaming11', type: 'private' },
  { groupId: 'Forum Community', title: 'Forum Community', botHandle: '@rianbayubastian', type: 'public' },
  { groupId: 'Group Discussion', title: 'Group Discussion', botHandle: '@rianbayubastian', type: 'public' },
  { groupId: 'Monitoring & Alert Room', title: 'Monitoring & Alert Room', botHandle: '@abiedien_monitoring_bot', type: 'staff' },
  { groupId: 'System Health Dashboard', title: 'System Health Dashboard', botHandle: '@abiedien_monitoring_bot', type: 'public' },
  { groupId: 'HR & Payroll Team', title: 'HR & Payroll Team', botHandle: '@sandekala_hr_bot', type: 'staff' },
  { groupId: 'Employees Direct', title: 'Employees Direct', botHandle: '@sandekala_hr_bot', type: 'private' },
  { groupId: 'Domain Operations Team', title: 'Domain Operations Team', botHandle: '@domain_ops_bot', type: 'staff' },
  { groupId: 'DNS & Registrar Alerts', title: 'DNS & Registrar Alerts', botHandle: '@domain_ops_bot', type: 'public' },
  { groupId: 'Member Community Support', title: 'Member Community Support', botHandle: '@community_support_bot', type: 'staff' },
  { groupId: 'Verified Member Forum', title: 'Verified Member Forum', botHandle: '@community_support_bot', type: 'public' },
];

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

const wrap = (r: Response, req: Request) => {
  const h = new Headers(r.headers);
  const requestOrigin = req.headers.get('origin') || '*';
  h.set('access-control-allow-origin', requestOrigin);
  h.set('vary', 'Origin');
  h.set('access-control-allow-credentials', 'true');
  h.set('access-control-allow-headers', 'authorization, content-type, apikey, x-client-info');
  h.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  return new Response(r.body, { status: r.status, headers: h });
};

async function actor(req: Request) {
  const h = req.headers.get('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();

  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) {
      return null;
    }
    const { data: a } = await db
      .from('dashboard_access')
      .select('id,user_id,role,is_active')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();

    if (!a || !a.is_active) {
      // MEMBER PATH: resolve the operator identity from the Telegram-linked
      // canonical user (fail-closed: requires active status AND a linked user).
      // dashboard_access only covers staff; members authenticate via magic link.
      const email = data.user.email;
      if (!email) return null;

      const { data: tgUser } = await db
        .from('telegram_users')
        .select('telegram_user_id, role, status, linked_user_id')
        .eq('email', email)
        .maybeSingle();

      if (!tgUser || tgUser.status !== 'active' || !tgUser.linked_user_id) {
        return null;
      }

      return {
        authUser: data.user,
        access: {
          id: null,
          user_id: tgUser.linked_user_id,
          role: tgUser.role || 'member',
          is_active: true,
          telegram_user_id: tgUser.telegram_user_id
        },
        isMember: true
      };
    }
    return { authUser: data.user, access: a, isMember: false };
  } catch (e) {
    console.error('Actor token resolution error:', e);
    return null;
  }
}

async function can(a: any, c: string) {
  if (!a?.access?.role) return false;
  // Root and super_admin hold full administrative capability
  if (a.access.role === 'root' || a.access.role === 'super_admin') {
    return true;
  }
  try {
    const { data } = await db
      .from('backoffice_role_capabilities')
      .select('capability_code')
      .eq('role', a.access.role)
      .eq('capability_code', c)
      .maybeSingle();
    return !!data;
  } catch (_err) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return wrap(new Response(null, { status: 204 }), req);
  }

  try {
    const rawPath = new URL(req.url).pathname;
    const p = rawPath
      .replace(/^\/functions\/v1\/backoffice-api-v3/, '')
      .replace(/^\/backoffice-api-v3/, '')
      .replace(/\/+$/, '') || '/';

    // Public auth routes
    if (p === '/login' && req.method === 'POST') {
      const b = await req.json();
      if (typeof b?.email !== 'string' || typeof b?.password !== 'string') {
        return wrap(json({ error: 'invalid_input' }, 422), req);
      }
      const { data, error } = await authClient.auth.signInWithPassword({
        email: b.email.trim(),
        password: b.password
      });

      if (error || !data?.session) {
        return wrap(json({ error: 'invalid_credentials' }, 401), req);
      }

      // Verify user has active dashboard access
      const { data: da } = await db
        .from('dashboard_access')
        .select('id,role,is_active')
        .eq('auth_user_id', data.user.id)
        .maybeSingle();

      if (!da || !da.is_active) {
        return wrap(json({ error: 'access_denied', message: 'Akun Anda tidak memiliki akses ke Backoffice.' }, 403), req);
      }

      return wrap(
        json({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          user: { id: data.user?.id, email: data.user?.email, role: da.role }
        }),
        req
      );
    }

    if (p === '/refresh' && req.method === 'POST') {
      const b = await req.json();
      if (typeof b?.refresh_token !== 'string' || !b.refresh_token) {
        return wrap(json({ error: 'invalid_input' }, 422), req);
      }
      const { data, error } = await authClient.auth.refreshSession({ refresh_token: b.refresh_token });
      if (error || !data?.session) {
        return wrap(json({ error: 'invalid_refresh_token' }, 401), req);
      }
      return wrap(
        json({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at
        }),
        req
      );
    }

    // Authenticate operator for all subsequent endpoints
    const a = await actor(req);
    if (!a) return wrap(json({ error: 'unauthorized' }, 401), req);

    // EMERGENCY CONTROLS ENFORCEMENT
    try {
      const { data: sysData } = await db.from('system_controls').select('value').eq('id', 'emergency_flags').maybeSingle();
      if (sysData?.value) {
        if (sysData.value.payment_frozen && p.startsWith('/payments')) {
          return wrap(json({ error: 'forbidden', message: 'Payments are currently frozen by system emergency control.' }, 403), req);
        }
        if (sysData.value.login_frozen && p === '/session' && a.access.role !== 'root' && a.access.role !== 'super_admin') {
          return wrap(json({ error: 'forbidden', message: 'Operator logins are currently frozen.' }, 403), req);
        }
      }
    } catch(e) {
      console.warn('System controls check note:', e);
    }

    if (p === '/session') {
      const { data: user, error: uErr } = await db
        .from('users')
        .select('id,telegram_id,username,full_name,email,role,status,domain_name,domain_verified,onboarding_status,risk_status,created_at')
        .eq('id', a.access.user_id)
        .maybeSingle();

      if (uErr || !user) {
        return wrap(json({ error: 'user_not_found', message: 'Operator internal record not found.' }, 404), req);
      }

      return wrap(
        json({
          authenticated: true,
          actor: { auth_user_id: a.authUser.id, user_id: a.access.user_id, role: a.access.role },
          user
        }),
        req
      );
    }

    if (p === '/stats') {
      let totalUsers = 0;
      let verifiedMembers = 0;
      let pendingTickets = 0;
      let pendingPayments = 0;
      let totalWebsites = 0;
      let superAdminCount = 1;

      try {
        const [uRes, tRes, pRes, dRes] = await Promise.all([
          db.from('users').select('id,domain_verified,role').catch(() => ({ data: [] })),
          db.from('tickets').select('id,status').catch(() => ({ data: [] })),
          db.from('payments').select('id,status').catch(() => ({ data: [] })),
          db.from('domain_inventory').select('id,status').catch(() => ({ data: [] }))
        ]);

        const uList = uRes?.data || [];
        const tList = tRes?.data || [];
        const pList = pRes?.data || [];
        const dList = dRes?.data || [];

        totalUsers = uList.length;
        verifiedMembers = uList.filter((x: any) => x.domain_verified).length;
        pendingTickets = tList.filter((x: any) => ['pending', 'assigned', 'waiting_member', 'in_progress', 'escalated'].includes(x.status)).length;
        pendingPayments = pList.filter((x: any) => x.status === 'pending').length;
        superAdminCount = uList.filter((x: any) => x.role === 'super_admin').length || 1;
        totalWebsites = dList.filter((d: any) => d.status === 'assigned').length || verifiedMembers;
      } catch (err) {
        console.warn('Stats fetch error:', err);
      }

      return wrap(
        json({
          totalUsers,
          verifiedMembers,
          pendingTickets,
          totalTopics: 0,
          pendingPayments,
          totalWebsites,
          superAdminCount
        }),
        req
      );
    }

    // Table Data Routes
    const routes: Record<string, string> = {
      '/users': 'users',
      '/tickets': 'tickets',
      '/payments': 'payments',
      '/domains': 'domain_inventory',
      '/audit': 'audit_logs',
      '/forum-topics': 'forum_topics'
    };

    if (routes[p]) {
      const table = routes[p];

      // MEMBER DATA SCOPING (fail-closed): a member may only read rows they own.
      // Operational/admin tables are not exposed to member sessions at all.
      if (a.isMember) {
        const memberAllowed = new Set(['/tickets', '/payments', '/forum-topics']);
        if (!memberAllowed.has(p)) {
          return wrap(json([]), req);
        }
      }

      try {
        let q = db.from(table).select('*').limit(500);
        if (a.isMember && (p === '/tickets' || p === '/payments')) {
          q = q.eq('user_id', a.access.user_id);
        }
        const orderCol = table === 'tickets' ? 'updated_at' : 'created_at';
        q = q.order(orderCol, { ascending: false });
        const { data, error } = await q;
        if (error) {
          console.warn(`Table ${table} query error:`, error.message);
          return wrap(json([]), req);
        }
        return wrap(json(data || []), req);
      } catch (_e) {
        return wrap(json([]), req);
      }
    }

    // ============ TICKET CREATION (member + staff) ============
    // Real ticket creation path for member pages (Kendala / Update requests).
    // Gated by ticket.create (granted to member, admin, super_admin in migration 004).
    if (p === '/tickets' && req.method === 'POST') {
      const b = await req.json();
      if (!await can(a, 'ticket.create')) {
        return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin membuat tiket.' }, 403), req);
      }
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      const description = typeof b.description === 'string' ? b.description.trim() : '';
      const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : 'web_update';
      const priority = typeof b.priority === 'string' && ['low', 'medium', 'high', 'urgent'].includes(b.priority) ? b.priority : 'medium';
      if (!title || !description) {
        return wrap(json({ error: 'invalid_input', message: 'Judul dan deskripsi wajib diisi.' }, 422), req);
      }
      try {
        const { data, error } = await db.from('tickets').insert([{
          user_id: a.access.user_id,
          category,
          priority,
          status: 'pending',
          title,
          description,
          collected_data: { source: 'backoffice_web', telegram_user_id: a.authUser.id }
        }]).select('id,ticket_number,category,priority,status,title,description,created_at').single();
        if (error) {
          return wrap(json({ error: error.message, message: 'Gagal membuat tiket.' }, 400), req);
        }
        return wrap(json({ success: true, ticket: data, message: 'Tiket berhasil dibuat.' }), req);
      } catch (err: any) {
        return wrap(json({ error: err.message, message: 'Gagal membuat tiket.' }, 400), req);
      }
    }

    // ============ CLAIM / PAYROLL (member) — 75% auto-payout ============
    // Real claim creation: payout_amount = amount * 0.75.
    if (p === '/claims' && req.method === 'POST') {
      if (!await can(a, 'ticket.create')) {
        return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin mengajukan klaim.' }, 403), req);
      }
      const body = (await req.json()) as any;
      const amount = Number(body.amount);
      if (!amount || amount <= 0 || !Number.isFinite(amount)) {
        return wrap(json({ error: 'invalid_input', message: 'Nominal klaim tidak valid.' }, 422), req);
      }
      const payoutAmount = Math.floor(amount * 0.75);
      const bank = typeof body.bank === 'string' && body.bank.trim() ? body.bank.trim().toUpperCase() : '';
      const account = typeof body.account === 'string' && body.account.trim() ? body.account.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : '';
      const fileSize = typeof body.file_size === 'string' ? body.file_size.trim() : '';
      if (!bank || !account) {
        return wrap(json({ error: 'invalid_input', message: 'Bank dan nomor rekening wajib diisi.' }, 422), req);
      }
      try {
        const { data, error } = await db.from('claims').insert([{
          telegram_user_id: a.authUser.id,
          user_id: a.access.user_id,
          claim_type: 'salary',
          amount,
          payout_amount: payoutAmount,
          bank,
          account_number: account,
          status: 'pending',
          evidence_required: !!fileName,
          description: description || `Klaim transfer gaji sebesar Rp ${amount.toLocaleString('id-ID')}. Payout otomatis 75% = Rp ${payoutAmount.toLocaleString('id-ID')}.`,
          collected_data: {
            source: 'backoffice_web',
            file_name: fileName,
            file_size: fileSize
          }
        }]).select('id,claim_number,claim_type,amount,payout_amount,bank,account_number,status,created_at').single();
        if (error) {
          return wrap(json({ error: error.message, message: 'Gagal membuat klaim.' }, 400), req);
        }
        return wrap(json({
          success: true,
          claim: data,
          message: `Klaim berhasil diajukan. Payout 75% = Rp ${payoutAmount.toLocaleString('id-ID')}.`
        }, 201), req);
      } catch (err: any) {
        return wrap(json({ error: err.message, message: 'Gagal membuat klaim.' }, 400), req);
      }
    }

    if (p === '/notifications') {
      try {
        const { data } = await db.from('telegram_notification_log').select('*').order('created_at', { ascending: false }).limit(200);
        return wrap(json(data || []), req);
      } catch (_e) {
        return wrap(json([]), req);
      }
    }

    if (p === '/bot-status') {
      // Multi-bot status: check all SUPPORTED_BOTS, not just the default token.
      const statuses: Array<{ handle: string; description: string; status: string; error?: string; timestamp: string }> = [];
      let anyActive = false;
      for (const bot of SUPPORTED_BOTS) {
        const token = BOT_TOKEN_MAP[bot.handle] || '';
        if (!token) {
          statuses.push({ handle: bot.handle, description: bot.description, status: 'TOKEN_UNSET', timestamp: new Date().toISOString() });
          continue;
        }
        try {
          const whRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
          if (whRes.ok) {
            const whData = await whRes.json();
            const ok = whData.result?.url ? 'ACTIVE' : 'NO_WEBHOOK';
            statuses.push({
              handle: bot.handle,
              description: bot.description,
              status: ok,
              webhook_url: whData.result?.url,
              pending_updates: whData.result?.pending_update_count,
              last_error_date: whData.result?.last_error_date,
              last_error_message: whData.result?.last_error_message,
              timestamp: new Date().toISOString()
            });
            if (ok === 'ACTIVE') anyActive = true;
          } else {
            statuses.push({ handle: bot.handle, description: bot.description, status: 'DEGRADED', error: 'TELEGRAM_API_ERROR', timestamp: new Date().toISOString() });
          }
        } catch (e: any) {
          statuses.push({ handle: bot.handle, description: bot.description, status: 'DEGRADED', error: e.message, timestamp: new Date().toISOString() });
        }
      }
      return wrap(json({
        overall: anyActive ? 'ACTIVE' : statuses.some(s => s.status === 'NO_WEBHOOK') ? 'PARTIAL' : 'DEGRADED',
        bots: statuses,
        timestamp: new Date().toISOString()
      }), req);
    }

    if (p === '/bot-groups') {
      return wrap(json({
        bots: SUPPORTED_BOTS.map(b => ({
          handle: b.handle,
          description: b.description,
          groups: BOT_TO_GROUP_MAP[b.handle] || [],
          token_configured: Boolean(BOT_TOKEN_MAP[b.handle])
        })),
        groups: SUPPORTED_GROUPS,
        total_bots: SUPPORTED_BOTS.length,
        total_groups: SUPPORTED_GROUPS.length,
        timestamp: new Date().toISOString()
      }), req);
    }

    if (p === '/tickets/mutate' && req.method === 'POST') {
      const b = await req.json();
      if (!await can(a, 'ticket.transition')) {
        return wrap(json({ error: 'forbidden' }, 403), req);
      }
      try {
        const { data, error } = await db.rpc('mutate_ticket_state_atomic', {
          p_ticket_id: b.ticketId,
          p_actor_id: a.access.user_id,
          p_new_status: b.newStatus,
          p_assigned_to: b.assignedTo,
          p_notes: b.notes,
          p_resolution_notes: b.resolutionNotes
        });
        if (error) throw error;
        return wrap(json({ success: true, ticket: data }), req);
      } catch (err: any) {
        return wrap(json({ error: err.message }, 400), req);
      }
    }

    // ============ DOMAIN ORDERS (canonical Phase C pipeline) ============
    // GET: list real domain-request tickets. POST: create via create_domain_request_ticket RPC.
    if (p === '/domain-orders' && req.method === 'GET') {
      if (!await can(a, 'member.read')) {
        return wrap(json({ error: 'forbidden' }, 403), req);
      }
      try {
        const { data } = await db
          .from('tickets')
          .select('id,ticket_number,user_id,status,title,description,collected_data,created_at,updated_at')
          .eq('category', 'domain_request')
          .order('updated_at', { ascending: false })
          .limit(200);
        return wrap(json(data || []), req);
      } catch (_e) {
        return wrap(json([]), req);
      }
    }

    if (p === '/domain-orders' && req.method === 'POST') {
      const b = await req.json();
      if (!await can(a, 'admin.access')) {
        return wrap(json({ error: 'forbidden' }, 403), req);
      }
      const tgId = Number(b.telegram_user_id || b.telegramId || b.telegram_id);
      const domain = typeof b.requested_domain === 'string' ? b.requested_domain.trim() : '';
      if (!tgId || !domain) {
        return wrap(json({ error: 'invalid_input', message: 'telegram_user_id and requested_domain required.' }, 422), req);
      }
      try {
        const { data, error } = await db.rpc('create_domain_request_ticket', {
          p_telegram_user_id: tgId,
          p_requested_domain: domain,
          p_request_type: typeof b.request_type === 'string' ? b.request_type : 'new',
          p_notes: typeof b.requester_name === 'string' && b.requester_name.trim()
            ? `Pemohon: ${b.requester_name.trim()}${b.notes ? ' — ' + b.notes : ''}`
            : (typeof b.notes === 'string' ? b.notes : null)
        });
        if (error) {
          return wrap(json({ error: error.message }, 500), req);
        }
        if (data && data.success === false) {
          return wrap(json({ error: data.error_code || 'REJECTED', message: data.message || 'Domain request failed.' }, 400), req);
        }
        return wrap(json({ success: true, ticket: data }), req);
      } catch (err: any) {
        return wrap(json({ error: err.message }, 400), req);
      }
    }

    // ============ ADMIN ACTIONS EXECUTOR (single real dispatch) ============
    // Replaces the previous silent fake-success funnel: every action either reaches a real
    // DB/RPC/notify path or returns an honest error (501) instead of pretending to succeed.
    if (p === '/admin/actions/execute' && req.method === 'POST') {
      const b = await req.json();
      const action = b.action;
      if (typeof action !== 'string' || !action) {
        return wrap(json({ error: 'invalid_input', message: 'action required.' }, 422), req);
      }

      // CLAIM / RESOLVE / REJECT -> canonical ticket FSM via mutate_ticket_state_atomic
      if (action === 'CLAIM' || action === 'RESOLVE' || action === 'REJECT') {
        if (!await can(a, 'ticket.transition')) {
          return wrap(json({ error: 'forbidden' }, 403), req);
        }
        const ticketId = Number(b.ticket_id);
        if (!ticketId) {
          return wrap(json({ error: 'invalid_input', message: 'ticket_id required.' }, 422), req);
        }
        const toStatus = action === 'RESOLVE' ? 'resolved' : action === 'REJECT' ? 'rejected' : 'in_progress';
        try {
          const { data, error } = await db.rpc('mutate_ticket_state_atomic', {
            p_ticket_id: ticketId,
            p_actor_id: a.access.user_id,
            p_new_status: toStatus,
            p_assigned_to: action === 'CLAIM' ? a.access.user_id : null,
            p_notes: typeof b.reason === 'string' ? b.reason : null,
            p_resolution_notes: toStatus === 'resolved' ? (typeof b.reason === 'string' ? b.reason : (b.metadata?.resolution_notes || null)) : null
          });
          if (error) throw error;
          return wrap(json({ success: true, data, message: `${action} success` }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'transition_failed', message: err.message || 'Ticket transition failed.' }, 400), req);
        }
      }

      // VERIFY_PAYMENT / REJECT_PAYMENT -> real payments table mutation + admin notif
      if (action === 'VERIFY_PAYMENT' || action === 'REJECT_PAYMENT') {
        const paymentId = Number(b.payment_id || b.paymentId);
        if (!paymentId) {
          return wrap(json({ error: 'invalid_input', message: 'payment_id required.' }, 422), req);
        }
        const toStatus = action === 'VERIFY_PAYMENT' ? 'verified' : 'rejected';
        try {
          const { data, error } = await db.from('payments')
            .update({ status: toStatus, verified_at: new Date().toISOString(), verified_by: a.access.user_id })
            .eq('id', paymentId)
            .select('id,payment_number,user_id,amount,currency,status')
            .single();
          if (error) throw error;
          try {
            const { data: chatRows } = await db.from('admin_chat_ids').select('chat_id').eq('is_active', true).limit(1);
            const chatId = chatRows && chatRows[0]?.chat_id;
            if (chatId && BOT_TOKEN) {
              await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: `${toStatus === 'verified' ? '✅' : '⛔'} [PAYROLL ${toStatus.toUpperCase()}] Pembayaran #${data.payment_number || paymentId} senilai ${data.currency} ${Number(data.amount || 0).toLocaleString('id-ID')} diverifikasi oleh operator #${a.access.user_id}.`,
                  parse_mode: 'Markdown'
                })
              });
            }
          } catch (dispatchErr) {
            console.warn('Payment notify dispatch warning:', dispatchErr);
          }
          return wrap(json({ success: true, data, message: `${action} success` }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'payment_update_failed', message: err.message || 'Payment update failed.' }, 400), req);
        }
      }

      // Honest: operations without a real backend integration yet must NOT fake success.
      return wrap(json({
        error: 'not_implemented',
        message: `Action '${action}' belum terintegrasi di backend (belum tersedia). Tidak ada data yang diubah.`
      }, 501), req);
    }

    if (p === '/telegram/send' && req.method === 'POST') {
      const b = await req.json();
      if (!await can(a, 'telegram.send_notification')) {
        return wrap(json({ error: 'forbidden' }, 403), req);
      }

      const recipientChatId = Number(b.recipient || b.chatId);
      if (!recipientChatId || !b.message) {
        return wrap(json({ error: 'invalid_input', message: 'Recipient and message required.' }, 422), req);
      }

      // 1. Insert into telegram_notification_log as queued
      const { data: logEntry, error: logErr } = await db
        .from('telegram_notification_log')
        .insert([{
          recipient_chat_id: recipientChatId,
          message_text: b.message,
          context_type: b.channelType || 'admin_message',
          status: 'queued',
          attempt_count: 1,
          last_attempt_at: new Date().toISOString()
        }])
        .select('*')
        .single();

      if (logErr) {
        return wrap(json({ error: logErr.message }, 500), req);
      }

      // 2. Dispatch via Telegram Bot API
      if (BOT_TOKEN) {
        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: recipientChatId,
              text: b.message,
              parse_mode: 'Markdown'
            })
          });
          const tgData = await tgRes.json();
          if (tgData.ok) {
            await db.from('telegram_notification_log').update({
              status: 'sent',
              telegram_message_id: tgData.result?.message_id,
              sent_at: new Date().toISOString()
            }).eq('id', logEntry.id);

            return wrap(json({ success: true, status: 'sent', notification_id: logEntry.id }), req);
          } else {
            await db.from('telegram_notification_log').update({
              status: 'failed',
              error_code: String(tgData.error_code || 'TELEGRAM_ERROR'),
              error_reason: tgData.description
            }).eq('id', logEntry.id);

            return wrap(json({ success: false, status: 'failed', reason: tgData.description }, 502), req);
          }
        } catch (dispatchErr: any) {
          await db.from('telegram_notification_log').update({
            status: 'failed',
            error_code: 'NETWORK_ERROR',
            error_reason: dispatchErr.message
          }).eq('id', logEntry.id);

          return wrap(json({ success: false, status: 'failed', reason: dispatchErr.message }, 502), req);
        }
      }

      return wrap(json({ success: true, status: 'queued', notification_id: logEntry.id }), req);
    }

    if (p === '/emergency' && req.method === 'POST') {
      const b = await req.json();
      if (!await can(a, 'system.manage_controls')) {
        return wrap(json({ error: 'forbidden' }, 403), req);
      }

      let patch: Record<string, boolean> = {};
      switch (b.actionType) {
        case 'freeze_payments': patch.payment_frozen = true; break;
        case 'unfreeze_payments': patch.payment_frozen = false; break;
        case 'lockdown': patch.login_frozen = true; break;
        case 'unlock': patch.login_frozen = false; break;
        case 'freeze_claims': patch.claims_frozen = true; break;
        case 'unfreeze_claims': patch.claims_frozen = false; break;
        case 'maintenance_on': patch.bot_maintenance = true; break;
        case 'maintenance_off': patch.bot_maintenance = false; break;
        default:
          return wrap(json({ error: 'invalid_action', message: 'Unknown emergency action type.' }, 422), req);
      }

      const reason = b.reason || `Emergency action ${b.actionType} triggered from Backoffice`;

      // Call hardened update_system_control RPC
      const { data: rpcResult, error: rpcErr } = await db.rpc('update_system_control', {
        p_id: 'emergency_flags',
        p_patch: patch,
        p_reason: reason,
        p_actor_id: a.access.user_id
      });

      if (rpcErr) {
        return wrap(json({ error: rpcErr.message }, 400), req);
      }

      return wrap(json({ success: true, result: rpcResult }), req);
    }

    if (p === '/broadcast' && req.method === 'POST') {
      return wrap(json({
        error: 'not_implemented',
        status: 'DEGRADED',
        message: 'Broadcast queue service is awaiting worker deployment.'
      }, 501), req);
    }

    return wrap(json({ error: 'not_found' }, 404), req);
  } catch (e: any) {
    console.error('Unhandled Edge Function error:', e);
    return wrap(json({ error: 'internal_error', message: e?.message || 'Unknown error' }, 500), req);
  }
});