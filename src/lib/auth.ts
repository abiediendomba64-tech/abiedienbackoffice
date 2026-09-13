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
export async function createAdminAccount(
  creatorTelegramId: number,
  email: string,
  password: string,
  role: 'dev' | 'admin',
  fullName: string,
  telegramId?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role, telegram_id: telegramId, created_by: creatorTelegramId },
    });
    if (authError) return { success: false, error: authError.message };
    if (!authData.user) return { success: false, error: 'Failed to create user' };

    const { error: dbError } = await supabase.from('admin_accounts').insert({
      auth_user_id: authData.user.id, email, role, telegram_id: telegramId, full_name: fullName, is_active: true, created_by: creatorTelegramId,
    });
    if (dbError) return { success: false, error: dbError.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
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
export async function resetAdminPassword(adminId: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.auth.admin.updateUserById(adminId, { password: newPassword });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Delete admin account (Super Admin only)
export async function deleteAdminAccount(adminId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error: dbError } = await supabase.from('admin_accounts').delete().eq('id', adminId);
    if (dbError) return { success: false, error: dbError.message };
    const { error: authError } = await supabase.auth.admin.deleteUser(adminId);
    if (authError) return { success: false, error: authError.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
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
// EMAIL + PASSWORD LOGIN (Option A)
// ==========================================

export async function loginWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; user?: any; error?: string; role?: string }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    if (!data.user) return { success: false, error: 'Login failed' };

    const { access, role } = await checkUserAdminAccess(data.user.id);
    if (!access) return { success: false, error: 'Akses ditolak. Hubungi Super Admin.' };

    await supabase.from('admin_accounts').update({ last_login: new Date().toISOString() }).eq('auth_user_id', data.user.id);
    return { success: true, user: data.user, role };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
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

export async function verifyWhatsAppOtp(phone: string, token: string): Promise<{ success: boolean; user?: any; error?: string }> {
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
    if (!data.user) return { success: false, error: 'Verifikasi OTP gagal' };
    return { success: true, user: data.user };
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
  try {
    const { data, error } = await supabase.rpc('verify_member_access');
    if (error) {
      const { data: { user } } = await supabase.auth.getUser();
      return { allowed: !!user, role: 'member', full_name: user?.email };
    }
    return data || { allowed: true, role: 'member' };
  } catch (e: any) {
    return { allowed: true, role: 'member', reason: e.message };
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

    // 2. Insert/sync to public.users
    try {
      await supabase.from('users').insert({
        username: email.split('@')[0],
        full_name: fullName.trim(),
        role: 'member',
        status: 'active',
        phone_number: phone?.trim() || null,
        domain_verified: false,
      });
    } catch (dbErr) {
      console.warn('Sync to public.users note:', dbErr);
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

const SUPER_ADMIN_EMAILS = ['abiediendomba64@gmail.com', 'teamsande22@gmail.com'];

async function checkUserAdminAccess(authUserId: string): Promise<{ access: boolean; role?: string }> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase().trim();

    if (email && SUPER_ADMIN_EMAILS.includes(email)) {
      // Auto-link auth_user_id in admin_accounts
      await supabase.from('admin_accounts')
        .update({ auth_user_id: authUserId, is_active: true, role: 'super_admin', updated_at: new Date().toISOString() })
        .eq('email', email);
      return { access: true, role: 'super_admin' };
    }

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
    if (email && SUPER_ADMIN_EMAILS.includes(email)) return true;

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
    if (email && SUPER_ADMIN_EMAILS.includes(email)) return 'super_admin';

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

