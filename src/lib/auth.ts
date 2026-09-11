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
// HELPERS
// ==========================================

async function checkUserAdminAccess(authUserId: string): Promise<{ access: boolean; role?: string }> {
  const { data, error } = await supabase.from('admin_accounts').select('role, is_active').eq('auth_user_id', authUserId).maybeSingle();
  if (error || !data || !data.is_active) return { access: false };
  return { access: true, role: data.role };
}

export async function isSuperAdmin(authUserId: string): Promise<boolean> {
  const { data } = await supabase.from('admin_accounts').select('role').eq('auth_user_id', authUserId).maybeSingle();
  return data?.role === 'super_admin';
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getCurrentUserRole(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from('admin_accounts').select('role').eq('auth_user_id', user.id).maybeSingle();
  return data?.role || null;
}
