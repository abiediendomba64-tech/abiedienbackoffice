// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';

declare const Deno: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const authClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });

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
      return null;
    }
    return { authUser: data.user, access: a };
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
      try {
        let q = db.from(table).select('*').limit(500);
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

    if (p === '/notifications') {
      try {
        const { data } = await db.from('telegram_notification_log').select('*').order('created_at', { ascending: false }).limit(200);
        return wrap(json(data || []), req);
      } catch (_e) {
        return wrap(json([]), req);
      }
    }

    if (p === '/bot-status') {
      if (!BOT_TOKEN) {
        return wrap(json({ status: 'DEGRADED', reason: 'TELEGRAM_BOT_TOKEN_UNSET', timestamp: new Date().toISOString() }), req);
      }
      try {
        const whRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
        if (whRes.ok) {
          const whData = await whRes.json();
          return wrap(json({
            status: whData.result?.url ? 'ACTIVE' : 'NO_WEBHOOK',
            webhook_url: whData.result?.url,
            pending_updates: whData.result?.pending_update_count,
            last_error_date: whData.result?.last_error_date,
            last_error_message: whData.result?.last_error_message,
            timestamp: new Date().toISOString()
          }), req);
        }
        return wrap(json({ status: 'DEGRADED', reason: 'TELEGRAM_API_ERROR', timestamp: new Date().toISOString() }), req);
      } catch (e: any) {
        return wrap(json({ status: 'DEGRADED', error: e.message, timestamp: new Date().toISOString() }), req);
      }
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