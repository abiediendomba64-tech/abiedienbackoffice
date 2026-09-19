// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts';

declare const Deno: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';

const db = createClient(SUPABASE_URL, SERVICE);
const authClient = createClient(SUPABASE_URL, ANON);

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
  const corsH = buildCorsHeaders(req);
  for (const [k, v] of Object.entries(corsH)) h.set(k, v);
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

    const email = data.user.email?.toLowerCase() || '';

    // 2. Check dashboard_access mapping table
    let { data: a } = await db
      .from('dashboard_access')
      .select('id,user_id,role,is_active')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();

    if (a && a.is_active) {
      return { authUser: data.user, access: a, isMember: false };
    }

    // 3. Check admin_accounts table (from multi-auth migration)
    let adminQuery = db.from('admin_accounts').select('id,role,is_active,telegram_id');
    if (email) {
      adminQuery = adminQuery.or(`auth_user_id.eq.${data.user.id},email.eq.${email}`);
    } else {
      adminQuery = adminQuery.eq('auth_user_id', data.user.id);
    }
    const { data: adminAcc } = await adminQuery.maybeSingle();

    if (adminAcc && adminAcc.is_active) {
      return {
        authUser: data.user,
        access: {
          id: adminAcc.id,
          user_id: adminAcc.id,
          role: adminAcc.role || 'admin',
          is_active: true,
          telegram_user_id: adminAcc.telegram_id
        },
        isMember: false
      };
    }

    // 4. MEMBER PATH: Check public.users
    let canonicalUser = null;
    if (email) {
      const { data } = await db
        .from('users')
        .select('id,role,status')
        .eq('email', email)
        .maybeSingle();
      canonicalUser = data;
    }

    if (canonicalUser && canonicalUser.status === 'active') {
      return {
        authUser: data.user,
        access: {
          id: null,
          user_id: canonicalUser.id,
          role: 'member',
          is_active: true
        },
        isMember: true
      };
    }

    // 5. MEMBER PATH: Check telegram_users
    let tgUser = null;
    if (email) {
      const { data } = await db
        .from('telegram_users')
        .select('telegram_user_id, role, status, linked_user_id')
        .eq('email', email)
        .maybeSingle();
      tgUser = data;
    }

    if (tgUser && tgUser.status === 'active') {
      return {
        authUser: data.user,
        access: {
          id: null,
          user_id: tgUser.linked_user_id || tgUser.telegram_user_id,
          role: tgUser.role || 'member',
          is_active: true,
          telegram_user_id: tgUser.telegram_user_id
        },
        isMember: true
      };
    }

    return null;
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
    return handlePreflight(req);
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
      const cleanEmail = b.email.trim().toLowerCase();
      const { data, error } = await authClient.auth.signInWithPassword({
        email: cleanEmail,
        password: b.password
      });

      if (error || !data?.session) {
        return wrap(json({ error: 'invalid_credentials' }, 401), req);
      }

      let role = '';

      if (!role) {
        // Verify user has active dashboard access or admin_accounts
        const { data: da } = await db
          .from('dashboard_access')
          .select('id,role,is_active')
          .eq('auth_user_id', data.user.id)
          .maybeSingle();

        if (da && da.is_active) {
          role = da.role;
        } else {
          const { data: adminAcc } = await db
            .from('admin_accounts')
            .select('id,role,is_active')
            .or(`auth_user_id.eq.${data.user.id},email.eq.${cleanEmail}`)
            .maybeSingle();

          if (adminAcc && adminAcc.is_active) {
            role = adminAcc.role;
          }
        }
      }

      if (!role) {
        return wrap(json({ error: 'access_denied', message: 'Akun Anda tidak memiliki akses ke Backoffice.' }, 403), req);
      }

      return wrap(
        json({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          user: { id: data.user?.id, email: data.user?.email, role }
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
      let user = null;
      if (a.access.user_id) {
        const { data: u } = await db
          .from('users')
          .select('id,telegram_id,username,full_name,email,role,status,domain_name,domain_verified,onboarding_status,risk_status,created_at')
          .eq('id', a.access.user_id)
          .maybeSingle();
        user = u;
      }

      if (!user) {
        let adminQuery = db.from('admin_accounts').select('id,email,role,full_name,telegram_id,is_active');
        if (a.authUser.email) {
          adminQuery = adminQuery.or(`auth_user_id.eq.${a.authUser.id},email.eq.${a.authUser.email}`);
        } else {
          adminQuery = adminQuery.eq('auth_user_id', a.authUser.id);
        }
        const { data: adminUser } = await adminQuery.maybeSingle();

        if (adminUser) {
          user = {
            id: adminUser.id,
            email: adminUser.email,
            full_name: adminUser.full_name,
            role: adminUser.role,
            telegram_id: adminUser.telegram_id,
            status: 'active'
          };
        }
      }

      // Fail-closed: an authenticated caller with NO canonical row (users or
      // admin_accounts) must not receive a fabricated profile. Never default
      // to 'super_admin' — that was the SEC-03 fail-open in the integrity
      // baseline. Return 403 so the client drops the session.
      if (!user) {
        return wrap(
          json({ error: 'forbidden', message: 'Tidak ada profil canonical terkait sesi ini. Hubungi Super Admin.' }, 403),
          req
        );
      }

      return wrap(
        json({
          authenticated: true,
          actor: { auth_user_id: a.authUser.id, user_id: user.id, role: a.access.role },
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
      '/claims': 'claims',
      '/audit': 'audit_logs',
      '/forum-topics': 'forum_topics'
    };

    if (routes[p] && req.method === 'GET') {
      const table = routes[p];

      // MEMBER DATA SCOPING (fail-closed): a member may only read rows they own.
      // Operational/admin tables are not exposed to member sessions at all.
      if (a.isMember) {
        const memberAllowed = new Set(['/tickets', '/payments', '/forum-topics', '/domains', '/claims']);
        if (!memberAllowed.has(p)) {
          return wrap(json([]), req);
        }
      }

      try {
        let q = db.from(table).select('*').limit(500);
        if (a.isMember && (p === '/tickets' || p === '/payments' || p === '/domains' || p === '/claims')) {
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

    // ============ MEMBER ONBOARDING REVIEW ============
    if (p === '/onboarding-requests' && req.method === 'GET') {
      if (!await can(a, 'member.manage')) return wrap(json({ error: 'forbidden' }, 403), req);
      const { data, error } = await db.from('member_onboarding_requests').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) return wrap(json({ error: error.message }, 400), req);
      return wrap(json(data || []), req);
    }

    if (p === '/admin/onboarding/decision' && req.method === 'POST') {
      if (!await can(a, 'member.manage')) return wrap(json({ error: 'forbidden' }, 403), req);
      const b = await req.json();
      const requestId = Number(b.request_id);
      const decision = typeof b.decision === 'string' ? b.decision.toUpperCase() : '';
      const reason = typeof b.rejection_reason === 'string' ? b.rejection_reason.trim() : '';
      if (!Number.isInteger(requestId) || requestId <= 0 || !['APPROVED','REJECTED'].includes(decision)) {
        return wrap(json({ error: 'invalid_input', message: 'request_id dan decision tidak valid.' }, 422), req);
      }
      if (decision === 'REJECTED' && !reason) {
        return wrap(json({ error: 'invalid_input', message: 'Alasan penolakan wajib diisi.' }, 422), req);
      }
      try {
        const { data, error } = await db.rpc('review_member_onboarding_atomic', {
          p_request_id: requestId,
          p_decision: decision,
          p_actor_id: a.access.user_id,
          p_actor_role: a.access.role,
          p_rejection_reason: reason || null
        });
        if (error) throw error;
        return wrap(json(data || { success: true }), req);
      } catch (err: any) {
        return wrap(json({ error: err.message || 'onboarding_review_failed', message: err.message || 'Keputusan onboarding gagal.' }, 409), req);
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

    // ============ CLAIM / PAYROLL (member) — real atomic submit ============
    if (p === '/claims' && req.method === 'POST') {
      if (!await can(a, 'claim.create')) {
        return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin mengajukan klaim.' }, 403), req);
      }
      const body = (await req.json()) as any;
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return wrap(json({ error: 'invalid_input', message: 'Nominal klaim tidak valid.' }, 422), req);
      }
      const bank = typeof body.bank === 'string' ? body.bank.trim().toUpperCase() : '';
      const account = typeof body.account === 'string' ? body.account.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : '';
      if (!bank || !account || !fileName) {
        return wrap(json({ error: 'invalid_input', message: 'Bank, nomor rekening, dan bukti klaim wajib diisi.' }, 422), req);
      }
      if (!/^\d+\//.test(fileName) || !fileName.startsWith(`${a.access.user_id}/`)) {
        return wrap(json({ error: 'invalid_evidence_path', message: 'Lokasi bukti klaim tidak sesuai dengan identitas member.' }, 422), req);
      }
      try {
        const { data: canonical } = await db.from('users').select('id,telegram_id,auth_user_id,status').eq('id', a.access.user_id).maybeSingle();
        if (!canonical || canonical.status !== 'active' || !canonical.telegram_id) {
          return wrap(json({ error: 'member_identity_incomplete', message: 'Identitas Telegram member belum terhubung.' }, 409), req);
        }
        const notes = description || `Klaim transfer gaji sebesar Rp ${amount.toLocaleString('id-ID')}.`;
        const { data, error } = await db.rpc('submit_claim_atomic', {
          p_telegram_user_id: Number(canonical.telegram_id),
          p_claim_type: 'salary',
          p_amount: amount,
          p_notes: notes,
          p_evidence_path: fileName,
          p_submitted_by: a.authUser.id
        });
        if (error) throw error;
        if (!data?.success) {
          return wrap(json({ error: data?.error_code || 'claim_rejected', message: data?.error_code || 'Klaim tidak dapat diajukan.' }, 409), req);
        }
        return wrap(json({ success: true, claim: data, message: 'Klaim berhasil diajukan dan masuk antrean review.' }, 201), req);
      } catch (err: any) {
        return wrap(json({ error: err.message || 'claim_submit_failed', message: 'Gagal membuat klaim.' }, 400), req);
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

      // REPLY -> insert message and transition state atomically
      if (action === 'REPLY') {
        if (!await can(a, 'ticket.transition')) {
          return wrap(json({ error: 'forbidden' }, 403), req);
        }
        const ticketId = Number(b.ticket_id || b.ticketId);
        const message = typeof b.message === 'string' ? b.message : (typeof b.reason === 'string' ? b.reason : b.notes);
        
        if (!ticketId || !message) {
          return wrap(json({ error: 'invalid_input', message: 'ticket_id and message required.' }, 422), req);
        }
        try {
          const { data, error } = await db.rpc('reply_ticket_atomic', {
            p_ticket_id: ticketId,
            p_actor_id: a.access.user_id,
            p_message: message
          });
          if (error) throw error;
          return wrap(json({ success: true, data, message: `REPLY success` }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'reply_failed', message: err.message || 'Ticket reply failed.' }, 400), req);
        }
      }

      // MEMBER ACCESS ACTIONS -> canonical public.users mutation + audit.
      if (action === 'APPROVE_MEMBER' || action === 'SUSPEND_MEMBER') {
        if (!await can(a, 'member.manage')) {
          return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin mengelola member.' }, 403), req);
        }
        const userId = Number(b.metadata?.user_id || b.user_id);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          return wrap(json({ error: 'invalid_input', message: 'user_id wajib valid.' }, 422), req);
        }
        const { data: target, error: targetError } = await db.from('users')
          .select('id,role,status,domain_verified').eq('id', userId).maybeSingle();
        if (targetError || !target) return wrap(json({ error: 'not_found', message: 'Member tidak ditemukan.' }, 404), req);
        if (target.role === 'root' || target.role === 'super_admin') {
          return wrap(json({ error: 'forbidden', message: 'Akun privileged tidak dapat diproses sebagai member.' }, 403), req);
        }
        const next = action === 'APPROVE_MEMBER'
          ? { status: 'active', role: 'member' }
          : { status: 'suspended' };
        const { data: updated, error: updateError } = await db.from('users').update(next)
          .eq('id', userId).select('id,role,status,domain_verified').single();
        if (updateError || !updated) return wrap(json({ error: updateError?.message || 'member_update_failed', message: 'Perubahan member gagal disimpan.' }, 400), req);
        await db.from('audit_logs').insert({
          actor_id: a.access.user_id, actor_role: a.access.role, action_type: action,
          resource_type: 'users', resource_id: userId, old_value: target, new_value: updated,
          reason: typeof b.reason === 'string' ? b.reason : null
        });
        return wrap(json({ success: true, data: updated, message: action + ' success' }), req);
      }

      // CLAIM PAYOUT -> atomic claim approval + payout transaction + double-entry ledger.
      if (action === 'APPROVE_CLAIM') {
        if (!await can(a, 'payment.manage')) {
          return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin memproses payout klaim.' }, 403), req);
        }
        const claimId = String(b.metadata?.claim_id || b.claim_id || '').trim();
        if (!claimId) {
          return wrap(json({ error: 'invalid_input', message: 'claim_id required.' }, 422), req);
        }
        try {
          const { data, error } = await db.rpc('approve_claim_atomic', {
            p_claim_id: claimId,
            p_actor_id: a.access.user_id,
            p_actor_role: a.access.role,
            p_notes: typeof b.reason === 'string' ? b.reason.trim() : null
          });
          if (error) throw error;
          return wrap(json({ success: true, data, message: 'Klaim disetujui dan payout tercatat secara atomik.' }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'claim_approval_failed', message: err.message || 'Approval klaim gagal.' }, 400), req);
        }
      }

      // CLAIM REJECTION -> atomic status/audit/notification, with no payout transaction or ledger entry.
      if (action === 'REJECT_CLAIM') {
        if (!await can(a, 'payment.manage')) {
          return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin menolak payout klaim.' }, 403), req);
        }
        const claimId = String(b.metadata?.claim_id || b.claim_id || '').trim();
        const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
        if (!claimId || !reason) {
          return wrap(json({ error: 'invalid_input', message: 'claim_id dan rejection reason wajib diisi.' }, 422), req);
        }
        try {
          const { data, error } = await db.rpc('reject_claim_atomic', {
            p_claim_id: claimId,
            p_actor_id: a.access.user_id,
            p_actor_role: a.access.role,
            p_rejection_reason: reason
          });
          if (error) throw error;
          return wrap(json({ success: true, data, message: 'Klaim ditolak secara atomik; tidak ada jurnal payout.' }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'claim_rejection_failed', message: err.message || 'Penolakan klaim gagal.' }, 400), req);
        }
      }

      // CLAIM PAYOUT SETTLEMENT -> bank/provider confirmation is a separate phase.
      // Approval never reduces the bank account and never reports a transfer as completed.
      if (action === 'SETTLE_CLAIM') {
        if (!await can(a, 'payment.manage')) {
          return wrap(json({ error: 'forbidden', message: 'Anda tidak memiliki izin menyelesaikan payout klaim.' }, 403), req);
        }
        const claimId = String(b.metadata?.claim_id || b.claim_id || '').trim();
        const providerReference = typeof b.metadata?.provider_reference === 'string'
          ? b.metadata.provider_reference.trim()
          : (typeof b.provider_reference === 'string' ? b.provider_reference.trim() : '');
        if (!claimId || !providerReference) {
          return wrap(json({ error: 'invalid_input', message: 'claim_id dan provider_reference wajib diisi.' }, 422), req);
        }
        try {
          const { data, error } = await db.rpc('settle_claim_payout_atomic', {
            p_claim_id: claimId,
            p_actor_id: a.access.user_id,
            p_actor_role: a.access.role,
            p_provider_reference: providerReference,
            p_notes: typeof b.reason === 'string' ? b.reason.trim() : null
          });
          if (error) throw error;
          return wrap(json({ success: true, data, message: 'Payout ditandai settled berdasarkan referensi transfer.' }), req);
        } catch (err: any) {
          return wrap(json({ error: err.message || 'claim_settlement_failed', message: err.message || 'Settlement payout gagal.' }, 400), req);
        }
      }

      // VERIFY_PAYMENT / REJECT_PAYMENT -> atomic database RPC.
      // The RPC receives the authenticated Supabase UUID and resolves the
      // canonical operator role + public.users identity internally.
      if (action === 'VERIFY_PAYMENT' || action === 'REJECT_PAYMENT') {
        if (!await can(a, 'payment.manage')) {
          return wrap(json({
            error: 'forbidden',
            message: 'Anda tidak memiliki izin mengelola pembayaran.'
          }, 403), req);
        }

        const paymentId = Number(b.payment_id || b.paymentId);
        if (!Number.isInteger(paymentId) || paymentId <= 0) {
          return wrap(json({
            error: 'invalid_input',
            message: 'payment_id required.'
          }, 422), req);
        }

        const actorAuthUserId = a.authUser?.id;
        if (!actorAuthUserId) {
          return wrap(json({
            error: 'unauthorized',
            message: 'Authenticated actor ID tidak tersedia.'
          }, 401), req);
        }

        try {
          let rpcResponse;

          if (action === 'VERIFY_PAYMENT') {
            const { data, error } = await db.rpc('verify_payment_slip_atomic', {
              p_payment_id: paymentId,
              p_actor_auth_user_id: actorAuthUserId
            });
            if (error) throw error;
            rpcResponse = data;
          } else {
            const reason = String(
              b.reason || b.rejection_reason || b.verification_notes || ''
            ).trim();

            if (!reason) {
              return wrap(json({
                error: 'invalid_input',
                message: 'Alasan penolakan (reason) wajib diisi.'
              }, 422), req);
            }

            const { data, error } = await db.rpc('reject_payment_slip_atomic', {
              p_payment_id: paymentId,
              p_actor_auth_user_id: actorAuthUserId,
              p_reason: reason
            });
            if (error) throw error;
            rpcResponse = data;
          }

          return wrap(json({
            success: true,
            data: rpcResponse,
            message: `${action} success`
          }), req);
        } catch (err: any) {
          console.error(`[${action}] Error:`, err);
          const message = err?.message || 'Gagal memproses pembayaran.';
          const status = String(message).startsWith('UNAUTHORIZED_ACTOR:')
            ? 403
            : String(message).startsWith('FORBIDDEN_ROLE:')
              ? 403
              : String(message).startsWith('PAYMENT_NOT_FOUND:')
                ? 404
                : String(message).startsWith('INVALID_STATE:')
                  ? 409
                  : 400;

          return wrap(json({
            error: err?.code || 'payment_action_failed',
            message
          }, status), req);
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

    // ============ SERVER-SIDE ADMIN ACCOUNT MANAGEMENT ============
    // Replaces unsafe client-side calls to supabase.auth.admin.*
    if (p.startsWith('/admin/users')) {
      if (a.access.role !== 'root' && a.access.role !== 'super_admin') {
        return wrap(json({ error: 'forbidden', message: 'Hanya Super Admin yang dapat mengelola akun operator.' }, 403), req);
      }

      if (p === '/admin/users/create' && req.method === 'POST') {
        const body = await req.json();
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
        const role = body.role === 'dev' || body.role === 'admin' ? body.role : null;
        const telegramId = body.telegramId == null || body.telegramId === '' ? null : Number(body.telegramId);

        if (!email || !password || !fullName || !role || password.length < 8 || (telegramId !== null && !Number.isSafeInteger(telegramId))) {
          return wrap(json({ error: 'invalid_input', message: 'Email, nama, role (admin/dev), password minimal 8 karakter, dan Telegram ID valid wajib diisi.' }, 422), req);
        }

        const { data: existing } = await db.from('admin_accounts')
          .select('id')
          .eq('email', email)
          .maybeSingle();
        if (existing) {
          return wrap(json({ error: 'conflict', message: 'Email admin sudah terdaftar.' }, 409), req);
        }

        const { data: authData, error: authError } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName, role, telegram_id: telegramId }
        });

        if (authError || !authData?.user?.id) {
          return wrap(json({ error: authError?.message || 'Gagal membuat user Auth.' }, 400), req);
        }

        const { data: account, error: dbError } = await db.from('admin_accounts').insert({
          auth_user_id: authData.user.id,
          email,
          role,
          telegram_id: telegramId,
          full_name: fullName,
          is_active: true
        }).select('id,email,role,telegram_id,full_name,is_active,created_at').single();

        // Compensating action: never leave an orphan auth.users account if the
        // canonical admin_accounts row cannot be created.
        if (dbError || !account) {
          await db.auth.admin.deleteUser(authData.user.id).catch(() => {});
          return wrap(json({ error: dbError?.message || 'Gagal membuat record admin.' }, 400), req);
        }

        return wrap(json({ success: true, account }), req);
      }

      if (p === '/admin/users/update' && req.method === 'PUT') {
        const body = await req.json();
        const adminId = typeof body.adminId === 'string' ? body.adminId : '';
        const input = body.updates && typeof body.updates === 'object' ? body.updates : {};
        if (!adminId || !Object.keys(input).length) {
          return wrap(json({ error: 'invalid_input', message: 'ID akun dan perubahan wajib diisi.' }, 422), req);
        }

        // Never spread client-controlled fields into admin_accounts.
        const updates: Record<string, any> = {};
        if (typeof input.email === 'string' && input.email.trim()) updates.email = input.email.trim().toLowerCase();
        if (typeof input.full_name === 'string' && input.full_name.trim()) updates.full_name = input.full_name.trim();
        if (input.telegram_id === null || (Number.isSafeInteger(Number(input.telegram_id)) && Number(input.telegram_id) > 0)) {
          updates.telegram_id = input.telegram_id === null ? null : Number(input.telegram_id);
        }
        if (input.role !== undefined) {
          if (input.role !== 'admin' && input.role !== 'dev') {
            return wrap(json({ error: 'invalid_input', message: 'Role target hanya admin atau dev.' }, 422), req);
          }
          updates.role = input.role;
        }
        if (input.is_active !== undefined) {
          if (typeof input.is_active !== 'boolean') {
            return wrap(json({ error: 'invalid_input', message: 'is_active harus boolean.' }, 422), req);
          }
          updates.is_active = input.is_active;
        }
        if (!Object.keys(updates).length) {
          return wrap(json({ error: 'invalid_input', message: 'Tidak ada field yang dapat diubah.' }, 422), req);
        }

        const { data: target, error: targetError } = await db.from('admin_accounts')
          .select('id,auth_user_id,role,is_active')
          .eq('id', adminId)
          .maybeSingle();
        if (targetError || !target) {
          return wrap(json({ error: 'not_found', message: 'Akun admin tidak ditemukan.' }, 404), req);
        }
        if (target.role === 'super_admin' || target.role === 'root') {
          return wrap(json({ error: 'forbidden', message: 'Akun Super Admin tidak boleh diubah melalui operator account CRUD.' }, 403), req);
        }
        if (target.auth_user_id === a.authUser.id && updates.is_active === false) {
          return wrap(json({ error: 'invalid_action', message: 'Tidak boleh menonaktifkan sesi sendiri.' }, 409), req);
        }

        const { error } = await db.from('admin_accounts')
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq('id', adminId);
        if (error) return wrap(json({ error: error.message }, 400), req);

        // Keep Auth metadata aligned with the canonical admin_accounts identity.
        if (target.auth_user_id) {
          const metadataPatch: Record<string, any> = {};
          if (updates.full_name !== undefined) metadataPatch.full_name = updates.full_name;
          if (updates.role !== undefined) metadataPatch.role = updates.role;
          if (updates.telegram_id !== undefined) metadataPatch.telegram_id = updates.telegram_id;
          if (Object.keys(metadataPatch).length) {
            const { error: metaError } = await db.auth.admin.updateUserById(target.auth_user_id, { user_metadata: metadataPatch });
            if (metaError) {
              return wrap(json({ error: 'Auth metadata update failed: ' + metaError.message }, 500), req);
            }
          }
        }
        return wrap(json({ success: true }), req);
      }

      if (p === '/admin/users/reset-password' && req.method === 'POST') {
        const body = await req.json();
        const adminId = typeof body.adminId === 'string' ? body.adminId : '';
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        if (!adminId || newPassword.length < 8) {
          return wrap(json({ error: 'invalid_input', message: 'ID admin wajib diisi dan password minimal 8 karakter.' }, 422), req);
        }

        const { data: acc } = await db.from('admin_accounts')
          .select('auth_user_id,role,is_active')
          .eq('id', adminId)
          .maybeSingle();
        if (!acc?.auth_user_id) {
          return wrap(json({ error: 'not_found', message: 'Akun admin tidak ditemukan.' }, 404), req);
        }
        if (acc.role === 'super_admin' || acc.role === 'root') {
          return wrap(json({ error: 'forbidden', message: 'Password Super Admin tidak diubah melalui endpoint operator CRUD.' }, 403), req);
        }

        const { error } = await db.auth.admin.updateUserById(acc.auth_user_id, { password: newPassword });
        if (error) return wrap(json({ error: error.message }, 400), req);
        return wrap(json({ success: true }), req);
      }

      if (p === '/admin/users/delete' && req.method === 'DELETE') {
        const body = await req.json();
        const adminId = typeof body.adminId === 'string' ? body.adminId : '';
        if (!adminId) {
          return wrap(json({ error: 'invalid_input', message: 'ID admin wajib diisi.' }, 422), req);
        }

        const { data: acc } = await db.from('admin_accounts')
          .select('auth_user_id,role,is_active')
          .eq('id', adminId)
          .maybeSingle();
        if (!acc?.auth_user_id) {
          return wrap(json({ error: 'not_found', message: 'Akun admin tidak ditemukan.' }, 404), req);
        }
        if (acc.role === 'super_admin' || acc.role === 'root' || acc.auth_user_id === a.authUser.id) {
          return wrap(json({ error: 'forbidden', message: 'Akun Super Admin/root atau sesi sendiri tidak boleh dihapus.' }, 403), req);
        }

        const { error: dbError } = await db.from('admin_accounts').delete().eq('id', adminId);
        if (dbError) return wrap(json({ error: dbError.message }, 400), req);

        const { error: accessError } = await db.from('dashboard_access').delete().eq('auth_user_id', acc.auth_user_id);
        if (accessError) {
          return wrap(json({ error: accessError.message }, 500), req);
        }

        const { error: authError } = await db.auth.admin.deleteUser(acc.auth_user_id);
        if (authError) {
          // Do not report success if Auth deletion failed. The DB row is already
          // removed, so an operator can safely retry reconciliation.
          return wrap(json({ error: authError.message, code: 'auth_delete_failed' }, 502), req);
        }

        return wrap(json({ success: true }), req);
      }
    }

    return wrap(json({ error: 'not_found' }, 404), req);
  } catch (e: any) {
    console.error('Unhandled Edge Function error:', e);
    return wrap(json({ error: 'internal_error', message: e?.message || 'Unknown error' }, 500), req);
  }
});