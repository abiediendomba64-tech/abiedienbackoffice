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

// Create new admin account (Super Admin only)
//
// SECURITY BOUNDARY: creating, updating, or deleting Supabase Auth users
// requires the service_role key. Browsers only have the anon key, so these
// operations must be performed by a server-side Edge Function. These helpers
// fail closed with an explicit server-required error instead of calling the
// unavailable admin API (and they never confuse admin_accounts.id with
// auth.users.id).
export async function createAdminAccount(
  _creatorTelegramId: number,
  _email: string,
  _password: string,
  _role: 'dev' | 'admin',
  _fullName: string,
  _telegramId?: number
): Promise<{ success: boolean; error?: string }> {
  return {
    success: false,
    error: 'Operasi ini hanya tersedia melalui server Edge Function (service_role).',
  };
}

// Update admin account (Super Admin only)
export async function updateAdminAccount(
  adminId: string,
  updates: { email?: string; role?: string; full_name?: string; telegram_id?: number; is_active?: boolean }
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('admin_accounts').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', adminId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Reset admin password (Super Admin only)
//
// Server-only: resetting another user's Auth password requires service_role.
// The browser helper fails closed so the UI cannot imply success. It also
// accepts only the Auth user id (never admin_accounts.id) to avoid id mixing.
export async function resetAdminPassword(_authUserId: string, _newPassword: string): Promise<{ success: boolean; error?: string }> {
  return {
    success: false,
    error: 'Reset password admin hanya tersedia melalui server Edge Function (service_role).',
  };
}

// Delete admin account (Super Admin only)
//
// Server-only for the same reason. Accepts only the Auth user id; deleting
// the admin_accounts row must happen server-side in one transaction.
export async function deleteAdminAccount(_authUserId: string): Promise<{ success: boolean; error?: string }> {
  return {
    success: false,
    error: 'Hapus akun admin hanya tersedia melalui server Edge Function (service_role).',
  };
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
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
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
    const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
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

export async function verifyTelegramWidgetPayload(payload: any): Promise<{ success: boolean; user?: any; role?: string; error?: string }> {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
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
    return { success: true, user: result.user, role: result.role };
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
    if (error) return { success: false, error: error.message };
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
    if (error) return { success: false, error: error.message };
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
    const { data, error } = await supabase.rpc('verify_admin_access');
    if (error) {
      console.warn('RPC verify_admin_access error, checking direct table:', error);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { allowed: false, reason: 'Belum login' };
      const { access, role } = await checkUserAdminAccess(user.id);
      return { allowed: access, role, email: user.email, reason: access ? undefined : 'Akses ditolak' };
    }
    return data || { allowed: false, reason: 'Verifikasi gagal' };
  } catch (e: any) {
    return { allowed: false, reason: e.message };
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
}): Promise<{ success: boolean; user?: any; error?: string }> {
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

    // 2. public.users row is REQUIRED. Canonical schema (live):
    //    telegram_id BIGINT UNIQUE NOT NULL, phone_encrypted BYTEA — there is
    //    NO phone_number column. The browser cannot mint a telegram_id, so the
    //    row is created by an admin/telegram onboarding path; the browser can
    //    only CLAIM (link) the pre-provisioned row matching the confirmed
    //    email via the link_identity() RPC (Security Definer, one-to-one
    //    guarded). Any failure here is a hard registration failure — no
    //    silent false-success orphaning auth.users.
    const { data: link, error: linkError } = await supabase.rpc('link_identity');
    if (linkError || !link?.linked) {
      // Roll the Auth account back so no orphan auth user survives a failed claim.
      await supabase.auth.signOut();
      const reason = linkError?.message || link?.reason || 'unknown';
      return {
        success: false,
        error:
          'Pendaftaran tercatat di Supabase Auth, tetapi gagal dikaitkan ke akun member ' +
          `(${reason}). Gunakan email yang sudah didaftarkan admin, atau hubungi admin.`,
      };
    }

    return { success: true, user: authData.user };
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
    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase().trim();

    // 1. Check by auth_user_id
    const { data, error } = await supabase.from('admin_accounts').select('role, is_active').eq('auth_user_id', authUserId).maybeSingle();
    if (data && data.is_active) {
      return { access: true, role: data.role };
    }

    // 2. Check by email fallback
    if (email) {
      const { data: byEmail } = await supabase.from('admin_accounts').select('role, is_active').eq('email', email).maybeSingle();
      if (byEmail && byEmail.is_active) {
        // Auto-link auth_user_id
        await supabase.from('admin_accounts')
          .update({ auth_user_id: authUserId, last_login: new Date().toISOString() })
          .eq('email', email);
        return { access: true, role: byEmail.role };
      }
    }

    // 3. Fallback to dashboard_access
    const { data: da } = await supabase.from('dashboard_access').select('role, is_active').eq('auth_user_id', authUserId).maybeSingle();
    if (da && da.is_active) {
      return { access: true, role: da.role };
    }

    return { access: false };
  } catch (_e) {
    return { access: false };
  }
}

export async function isSuperAdmin(authUserId: string): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase().trim();

    const { data } = await supabase.from('admin_accounts').select('role').eq('auth_user_id', authUserId).maybeSingle();
    if (data?.role === 'super_admin') return true;

    if (email) {
      const { data: byEmail } = await supabase.from('admin_accounts').select('role').eq('email', email).maybeSingle();
      if (byEmail?.role === 'super_admin') return true;
    }

    const { data: da } = await supabase.from('dashboard_access').select('role').eq('auth_user_id', authUserId).maybeSingle();
    return da?.role === 'super_admin';
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
    const email = user.email?.toLowerCase().trim();

    const { data } = await supabase.from('admin_accounts').select('role').eq('auth_user_id', user.id).maybeSingle();
    if (data?.role) return data.role;

    if (email) {
      const { data: byEmail } = await supabase.from('admin_accounts').select('role').eq('email', email).maybeSingle();
      if (byEmail?.role) return byEmail.role;
    }

    const { data: da } = await supabase.from('dashboard_access').select('role').eq('auth_user_id', user.id).maybeSingle();
    if (da?.role) return da.role;

    return 'member';
  } catch {
    return null;
  }
}

