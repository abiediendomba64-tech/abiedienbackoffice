import { supabase } from './supabase';

// ==========================================
// ADMIN ACCOUNT MANAGEMENT (Super Admin only)
// ==========================================

export interface AdminAccount {
  id: string;
  email: string;
  role: 'super_admin' | 'dev' | 'admin';
  telegram_id?: number;
  full_name: string;
  created_at: string;
  last_login?: string;
  is_active: boolean;
}

// Server-side admin account management.
// The browser never receives service_role. All privileged mutations go through
// backoffice-api-v3 with the real Supabase Auth access token.
async function adminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Sesi login tidak valid.');

  const base = (
    import.meta.env.VITE_BACKOFFICE_API_URL ||
    `${import.meta.env.VITE_SUPABASE_URL || 'https://pnvnpencatzspkwxspac.supabase.co'}/functions/v1/backoffice-api-v3`
  ).replace(/\\/$/, '');

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Request gagal (${response.status})`);
  return body as T;
}

export async function createAdminAccount(
  _creatorTelegramId: number,
  email: string,
  password: string,
  role: 'dev' | 'admin',
  fullName: string,
  telegramId?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    await adminApi('/admin/users/create', {
      method: 'POST',
      body: JSON.stringify({ email, password, role, fullName, telegramId }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Gagal membuat akun admin.' };
  }
}

export async function updateAdminAccount(
  adminId: string,
  updates: { email?: string; role?: string; full_name?: string; telegram_id?: number; is_active?: boolean }
): Promise<{ success: boolean; error?: string }> {
  try {
    await adminApi('/admin/users/update', {
      method: 'PUT',
      body: JSON.stringify({ adminId, updates }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Gagal memperbarui akun admin.' };
  }
}

export async function resetAdminPassword(
  adminId: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await adminApi('/admin/users/reset-password', {
      method: 'POST',
      body: JSON.stringify({ adminId, newPassword }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Gagal mereset password admin.' };
  }
}

export async function deleteAdminAccount(
  adminId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await adminApi('/admin/users/delete', {
      method: 'DELETE',
      body: JSON.stringify({ adminId }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Gagal menghapus akun admin.' };
  }
}

// Get all admin accounts (Super Admin only)
export async function getAdminAccounts(): Promise<AdminAccount[]> {
  try {
    const { data, error } = await supabase.from('admin_accounts').select('*').order('created_at', { ascending: false });
    if (error || !data) return [];
    return data;
  } catch { return []; }
}


// ==========================================
// EMAIL + PASSWORD LOGIN (Option A - canonical, role-agnostic)
// Contract:
//   - This function ONLY authenticates against Supabase Auth.
//   - It NEVER decides role (no admin/member check here).
//   - Role is decided by the caller via verifyAdminAccess() or
//     verifyMemberAccess() AFTER a real session exists.
//   - Returns the REAL session.access_token, NEVER user.id.
// ==========================================

export async function loginWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; user?: any; session?: any; access_token?: string; error?: string }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    if (!data.user || !data.session?.access_token) return { success: false, error: 'Login failed: no session' };

    return { success: true, user: data.user, session: data.session, access_token: data.session.access_token };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Admin email login: Supabase Auth + verify_admin_access (RPC, fail-closed)
export async function loginAdminWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; user?: any; session?: any; access_token?: string; role?: string; error?: string }> {
  const base = await loginWithEmail(email, password);
  if (!base.success) return base;

    const { access, role } = await checkUserAdminAccess(base.user.id);
    if (!access) {
      await supabase.auth.signOut();
      return { success: false, error: 'Akses ditolak. Hubungi Super Admin.' };
    }

    await supabase.from('admin_accounts').update({ last_login: new Date().toISOString() }).eq('auth_user_id', base.user.id);
    return { ...base, role };
}

// Member email login: Supabase Auth + verify_member_access (RPC, fail-closed)
export async function loginMemberWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; user?: any; session?: any; access_token?: string; role?: string; full_name?: string; username?: string; error?: string }> {
  const base = await loginWithEmail(email, password);
  if (!base.success) return base;

  const check = await verifyMemberAccess();
  if (!check.allowed) {
    await supabase.auth.signOut();
    return { success: false, error: check.reason || 'Akses ditolak: akun belum terdaftar sebagai member terverifikasi.' };
  }

  return { ...base, role: check.role, full_name: check.full_name, username: check.username };
}

// ==========================================
// MAGIC LINK LOGIN (Option C)
// ==========================================

export async function sendMagicLink(email: string): Promise<{ success: boolean; error?: string }> {
  try {
    const isSuper = typeof window !== 'undefined' && 
      (window.location.pathname.toLowerCase().startsWith('/super') || window.location.pathname.toLowerCase().startsWith('/admin'));
    const redirectTo = isSuper ? `${window.location.origin}/superadm` : `${window.location.origin}/member/login`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function verifyMagicLink(email: string, token: string): Promise<{ success: boolean; error?: string; role?: string }> {
  try {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'magiclink' });
    if (error) return { success: false, error: error.message };
    if (!data.user) return { success: false, error: 'Verifikasi gagal' };

    const { access, role } = await checkUserAdminAccess(data.user.id);
    if (!access) return { success: false, error: 'Akses ditolak' };
    return { success: true, role };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// TELEGRAM + EMAIL HYBRID (Option B)
// ==========================================

export async function loginTelegramWithEmail(telegramPayload: any, email: string): Promise<{ success: boolean; error?: string; role?: string }> {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://pnvnpencatzspkwxspac.supabase.co';
    const anonKey =
      import.meta.env.VITE_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBudm5wZW5jYXR6c3Brd3hzcGFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzE4NjgsImV4cCI6MjEwMzg0Nzg2OH0.dgpzQb7cnDkikLHqtw2RyYE_j5RUHI3QIELcjmy4_tY';
    const functionUrl = `${supabaseUrl}/functions/v1/telegram-auth`;
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
      body: JSON.stringify({ telegramPayload, email }),
    });
    const result = await response.json();
    if (!response.ok) return { success: false, error: result.error || 'Autentikasi gagal' };
    return { success: true, role: result.role };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// TELEGRAM LOGIN WIDGET VERIFICATION
// ==========================================

export async function verifyTelegramWidgetPayload(payload: any): Promise<{ success: boolean; user?: any; role?: string; token_hash?: string; email?: string; error?: string }> {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://pnvnpencatzspkwxspac.supabase.co';
    const anonKey =
      import.meta.env.VITE_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBudm5wZW5jYXR6c3Brd3hzcGFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzE4NjgsImV4cCI6MjEwMzg0Nzg2OH0.dgpzQb7cnDkikLHqtw2RyYE_j5RUHI3QIELcjmy4_tY';
    const res = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ action: 'verify-widget', telegramPayload: payload }),
    });
    const result = await res.json();
    if (!res.ok || !result.valid) {
      return { success: false, error: result.error || 'Verifikasi widget Telegram gagal' };
    }
    return { success: true, user: result.user, role: result.role, token_hash: result.token_hash, email: result.email };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// GOOGLE OAUTH LOGIN
// ==========================================

export async function loginWithGoogle(returnPath: string = '/admin/login'): Promise<{ success: boolean; error?: string }> {
  try {
    const redirectTo = `${window.location.origin}${returnPath}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (error) {
      if (error.message?.toLowerCase().includes('provider is not enabled') || (error as any).error_code === 'validation_failed') {
        return {
          success: false,
          error: 'Google Sign-In belum diaktifkan di Supabase Dashboard (Authentication > Providers > Google). Silakan gunakan Email & Password.',
        };
      }
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// WHATSAPP / PHONE OTP LOGIN
// ==========================================

export async function loginWithWhatsApp(phone: string): Promise<{ success: boolean; error?: string }> {
  try {
    let cleanPhone = phone.trim().replace(/\s+/g, '').replace(/-/g, '');
    if (cleanPhone.startsWith('08')) {
      cleanPhone = '+62' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('62')) {
      cleanPhone = '+' + cleanPhone;
    } else if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+62' + cleanPhone;
    }

    const { error } = await supabase.auth.signInWithOtp({
      phone: cleanPhone,
    });
    if (error) {
      if (error.message?.toLowerCase().includes('provider is not enabled') || (error as any).error_code === 'validation_failed' || error.message?.toLowerCase().includes('sms provider')) {
        return {
          success: false,
          error: 'Layanan WhatsApp/SMS OTP belum diaktifkan di Supabase Dashboard (Authentication > Providers > Phone). Silakan login dengan Email & Password.',
        };
      }
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function verifyWhatsAppOtp(phone: string, token: string): Promise<{ success: boolean; user?: any; session?: any; access_token?: string; error?: string }> {
  try {
    let cleanPhone = phone.trim().replace(/\s+/g, '').replace(/-/g, '');
    if (cleanPhone.startsWith('08')) {
      cleanPhone = '+62' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('62')) {
      cleanPhone = '+' + cleanPhone;
    } else if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+62' + cleanPhone;
    }

    const { data, error } = await supabase.auth.verifyOtp({
      phone: cleanPhone,
      token: token.trim(),
      type: 'sms',
    });
    if (error) return { success: false, error: error.message };
    if (!data.session?.access_token) return { success: false, error: 'Verifikasi OTP gagal: tidak ada session.' };
    return { success: true, user: data.user, session: data.session, access_token: data.session.access_token };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// ROLE VERIFICATION RPCS
// ==========================================

export async function verifyAdminAccess(): Promise<{ allowed: boolean; role?: string; email?: string; full_name?: string; reason?: string }> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { allowed: false, reason: 'Sesi tidak valid atau belum login' };

    // 1. First attempt atomic RPC verify_admin_access
    const { data, error } = await supabase.rpc('verify_admin_access');
    if (!error && data?.allowed && data.role) {
      return {
        allowed: true,
        role: data.role,
        email: data.email || user.email,
        full_name: data.full_name || user.user_metadata?.full_name || user.email?.split('@')[0],
      };
    }

    if (error) {
      console.warn('RPC verify_admin_access note (checking direct database model):', error);
    }

    // 2. Direct database model verification (admin_accounts / dashboard_access)
    const { access, role } = await checkUserAdminAccess(user.id);
    if (access && role && ['super_admin', 'admin', 'dev'].includes(role)) {
      return {
        allowed: true,
        role,
        email: user.email,
        full_name: user.user_metadata?.full_name || user.email?.split('@')[0],
      };
    }

    // Fail closed: neither RPC nor direct database confirmed an active admin role
    return {
      allowed: false,
      reason: data?.reason || 'Akses ditolak: Akun Anda bukan Super Admin atau Admin yang terdaftar di database.',
    };
  } catch (e: any) {
    return { allowed: false, reason: e.message || 'Gagal memverifikasi izin akses admin.' };
  }
}

export async function verifyMemberAccess(): Promise<{ allowed: boolean; role: string; user_id?: number; username?: string; full_name?: string; reason?: string }> {
  // Fail-closed canonical resolver: Supabase Auth -> verify_member_access RPC.
  // Any error, missing session, or denied RPC result returns allowed:false. No fail-open.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || !session.user) {
      return { allowed: false, role: 'member', reason: 'Belum login' };
    }
    const { data, error } = await supabase.rpc('verify_member_access');
    if (error) {
      console.warn('RPC verify_member_access error (fail-closed):', error);
      return { allowed: false, role: 'member', reason: 'Verifikasi member gagal. Hubungi admin.' };
    }
    if (!data || typeof data.allowed !== 'boolean') {
      return { allowed: false, role: 'member', reason: 'Respons verifikasi tidak valid.' };
    }
    if (!data.allowed) {
      return { allowed: false, role: 'member', reason: data.reason || 'Akses ditolak: akun belum terdaftar sebagai member terverifikasi.' };
    }
    return { allowed: true, role: data.role || 'member', user_id: data.user_id, username: data.username, full_name: data.full_name };
  } catch (e: any) {
    console.warn('verifyMemberAccess exception (fail-closed):', e?.message);
    return { allowed: false, role: 'member', reason: 'Verifikasi member gagal. Hubungi admin.' };
  }
}

// ==========================================
// REGISTRATION & PASSWORD RECOVERY
// ==========================================

export async function registerMember(params: {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  telegramUsername?: string;
}): Promise<{ success: boolean; pending?: boolean; message?: string; user?: any; error?: string }> {
  try {
    const { email, password, fullName, phone, telegramUsername } = params;
    
    // 1. Register with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: phone?.trim(),
          telegram: telegramUsername?.trim(),
          role: 'member',
        },
      },
    });

    if (authError) return { success: false, error: authError.message };
    if (!authData.user) return { success: false, error: 'Gagal membuat akun member' };

    // Two DISTINCT contracts after Supabase Auth signup:
    //
    // 1. CLAIM (existing member): a pre-provisioned public.users row matching
    //    the confirmed email exists -> link_identity() binds them one-to-one.
    // 2. NEW APPLICANT: no matching row -> an onboarding request with status
    //    PENDING_REVIEW is created for admin review. The caller is signed out;
    //    they become a member only after an admin APPROVES and provisions the
    //    canonical public.users row. Auth identity ≠ business membership.
    const { data: link, error: linkError } = await supabase.rpc('link_identity');

    if (link?.linked) {
      return { success: true, user: authData.user, pending: false };
    }

    const reason = linkError?.message || link?.reason || 'unknown';
    const isNewApplicant = reason === 'no_matching_public_user';

    if (isNewApplicant) {
      const { error: obError } = await supabase
        .from('member_onboarding_requests')
        .insert({
          auth_user_id: authData.user.id,
          email: email.trim().toLowerCase(),
          full_name: fullName.trim(),
          phone: phone?.trim() || null,
          telegram_username: telegramUsername?.trim() || null,
        });
      if (obError) {
        await supabase.auth.signOut();
        return { success: false, error: 'Gagal membuat permintaan onboarding: ' + obError.message };
      }
      await supabase.auth.signOut();
      return {
        success: true,
        pending: true,
        user: authData.user,
        message: 'Pendaftaran diterima dan menunggu persetujuan admin (PENDING_REVIEW). Anda akan diberi tahu setelah akun diaktifkan.',
      };
    }

    // Any other link failure is a hard failure — no orphan auth user, no
    // silent false-success.
    await supabase.auth.signOut();
    return {
      success: false,
      error:
        'Pendaftaran tercatat di Supabase Auth, tetapi gagal dikaitkan ke akun member ' +
        `(${reason}). Gunakan email yang sudah didaftarkan admin, atau hubungi admin.`,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function sendPasswordResetEmail(email: string): Promise<{ success: boolean; error?: string }> {
  try {
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function updateNewPassword(newPassword: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// HELPERS
// ==========================================

async function checkUserAdminAccess(authUserId: string): Promise<{ access: boolean; role?: string }> {
  try {
    const validRoles = ['super_admin', 'admin', 'dev'];

    // 1. Check dashboard_access first (direct read model, no RLS recursion risk)
    try {
      const { data: da, error: daErr } = await supabase
        .from('dashboard_access')
        .select('role, is_active')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      if (!daErr && da && da.is_active && validRoles.includes(da.role)) {
        return { access: true, role: da.role };
      }
    } catch {
      // non-fatal, proceed to next check
    }

    // 2. Check by auth_user_id in admin_accounts (Canonical Identity)
    try {
      const { data, error } = await supabase
        .from('admin_accounts')
        .select('role, is_active')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      if (!error && data && data.is_active && validRoles.includes(data.role)) {
        return { access: true, role: data.role };
      }
    } catch {
      // non-fatal
    }

    // 3. Check by email fallback only if user is active and not bound to a different auth_user_id
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const email = user?.email?.toLowerCase().trim();
      if (email) {
        const { data: byEmail, error: emailErr } = await supabase
          .from('admin_accounts')
          .select('id, role, is_active, auth_user_id')
          .eq('email', email)
          .maybeSingle();

        if (!emailErr && byEmail && byEmail.is_active && validRoles.includes(byEmail.role)) {
          if (!byEmail.auth_user_id || byEmail.auth_user_id === authUserId) {
            await supabase
              .from('admin_accounts')
              .update({ auth_user_id: authUserId, last_login: new Date().toISOString() })
              .eq('id', byEmail.id);
            return { access: true, role: byEmail.role };
          }
        }
      }
    } catch {
      // non-fatal
    }

    return { access: false };
  } catch (_e) {
    return { access: false };
  }
}

export async function isSuperAdmin(authUserId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('admin_accounts')
      .select('role, is_active')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (data && data.is_active && data.role === 'super_admin') return true;

    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase().trim();
    if (email) {
      const { data: byEmail } = await supabase
        .from('admin_accounts')
        .select('role, is_active')
        .eq('email', email)
        .maybeSingle();
      if (byEmail && byEmail.is_active && byEmail.role === 'super_admin') return true;
    }

    const { data: da } = await supabase
      .from('dashboard_access')
      .select('role, is_active')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    return da?.is_active === true && da?.role === 'super_admin';
  } catch {
    return false;
  }
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  localStorage.removeItem('backoffice_access_token');
  localStorage.removeItem('backoffice_refresh_token');
  localStorage.removeItem('user_role');
  localStorage.removeItem('user_name');
  localStorage.removeItem('user_tg_id');
}

export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getCurrentUserRole(): Promise<string | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const validRoles = ['super_admin', 'admin', 'dev'];

    const { data } = await supabase
      .from('admin_accounts')
      .select('role, is_active')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (data && data.is_active && validRoles.includes(data.role)) return data.role;

    const email = user.email?.toLowerCase().trim();
    if (email) {
      const { data: byEmail } = await supabase
        .from('admin_accounts')
        .select('role, is_active')
        .eq('email', email)
        .maybeSingle();
      if (byEmail && byEmail.is_active && validRoles.includes(byEmail.role)) return byEmail.role;
    }

    const { data: da } = await supabase
      .from('dashboard_access')
      .select('role, is_active')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (da && da.is_active && validRoles.includes(da.role)) return da.role;

    return null;
  } catch {
    return null;
  }
}

