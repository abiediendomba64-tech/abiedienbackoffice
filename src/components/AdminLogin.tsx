import React, { useState, useEffect } from 'react';
import { 
  Lock, 
  Mail, 
  Key, 
  Globe2, 
  Send, 
  Phone, 
  ShieldAlert, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle,
  MessageCircle,
  Crown,
  ExternalLink
} from 'lucide-react';
import { 
  loginWithEmail, 
  loginWithGoogle, 
  loginWithWhatsApp, 
  verifyWhatsAppOtp, 
  verifyAdminAccess, 
  verifyTelegramWidgetPayload,
  signOut 
} from '../lib/auth';
import { ForgotPasswordModal } from './ForgotPasswordModal';

interface AdminLoginProps {
  onSuccess: (role: 'super_admin' | 'dev' | 'admin', name: string, token: string) => void;
  onNavigateToMember: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onSuccess, onNavigateToMember }) => {
  const [activeTab, setActiveTab] = useState<'email' | 'whatsapp' | 'telegram'>('email');
  const [showForgotModal, setShowForgotModal] = useState(false);
  
  // Email Form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  // WhatsApp Form
  const [phone, setPhone] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [otpSent, setOtpSent] = useState(false);

  // Status
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Telegram Login Widget listener & Popup receiver
  useEffect(() => {
    (window as any).onTelegramAuth = async (tgPayload: any) => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const res = await verifyTelegramWidgetPayload(tgPayload);
        if (!res.success) {
          setErrorMessage(res.error || 'Validasi signature Telegram gagal');
          setLoading(false);
          return;
        }

        const role = (res.role as any) || 'super_admin';
        if (role !== 'super_admin' && role !== 'dev' && role !== 'admin') {
          setErrorMessage('Akses ditolak: Akun Telegram ini bukan Super Admin / Staf terdaftar.');
          setLoading(false);
          return;
        }

        const name = res.user?.full_name || tgPayload.first_name || 'Super Admin';
        onSuccess(role, name, 'tg-admin-session');
      } catch (err: any) {
        setErrorMessage(err.message || 'Gagal verifikasi Telegram');
      } finally {
        setLoading(false);
      }
    };

    // Receive postMessage from popup OAuth window if completed
    const handleMessage = (event: MessageEvent) => {
      try {
        let data = event.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { return; }
        }
        if (data && (data.event === 'auth_result' || data.tgAuthResult || data.id)) {
          const payload = data.result || data.tgAuthResult || data;
          if (payload && payload.hash) {
            (window as any).onTelegramAuth?.(payload);
          }
        }
      } catch {
        // ignore cross-origin noise
      }
    };
    window.addEventListener('message', handleMessage);

    return () => {
      delete (window as any).onTelegramAuth;
      window.removeEventListener('message', handleMessage);
    };
  }, [onSuccess]);

  // 1. Google OAuth
  const handleGoogleLogin = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await loginWithGoogle('/admin/login');
      if (!res.success) {
        setErrorMessage(res.error || 'Gagal memulai otentikasi Google');
        setLoading(false);
      }
    } catch (err: any) {
      setErrorMessage(err.message);
      setLoading(false);
    }
  };

  // 2. Email + Password
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const res = await loginWithEmail(email.trim(), password);
      if (!res.success) {
        setErrorMessage(res.error || 'Email atau password salah');
        setLoading(false);
        return;
      }

      // Verify role post-login
      const verification = await verifyAdminAccess();
      if (!verification.allowed) {
        await signOut();
        setErrorMessage(verification.reason || `Akses ditolak: Akun (${email}) bukan Super Admin / Backoffice Staff yang terdaftar.`);
        setLoading(false);
        return;
      }

      const role = (verification.role as any) || 'super_admin';
      const name = verification.full_name || email;
      const token = res.user?.id || 'admin-session';
      onSuccess(role, name, token);
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setLoading(false);
    }
  };

  // 3. WhatsApp Send OTP
  const handleSendWhatsAppOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) return;
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await loginWithWhatsApp(phone);
      if (res.success) {
        setOtpSent(true);
        setInfoMessage(`Kode OTP telah dikirimkan ke WhatsApp nomor ${phone}. Masukkan 6 digit kode verifikasi.`);
      } else {
        setErrorMessage(res.error || 'Gagal mengirim OTP ke nomor tersebut.');
      }
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 4. WhatsApp Verify OTP
  const handleVerifyWhatsAppOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpToken) return;
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await verifyWhatsAppOtp(phone, otpToken);
      if (!res.success) {
        setErrorMessage(res.error || 'Kode OTP tidak valid.');
        setLoading(false);
        return;
      }

      const verification = await verifyAdminAccess();
      if (!verification.allowed) {
        await signOut();
        setErrorMessage(verification.reason || 'Akses ditolak: Nomor WhatsApp ini tidak terhubung ke akun Super Admin.');
        setLoading(false);
        return;
      }

      const role = (verification.role as any) || 'super_admin';
      const name = verification.full_name || phone;
      onSuccess(role, name, res.user?.id || 'wa-session');
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950 text-slate-100 font-sans selection:bg-rose-500 selection:text-white">
      <div className="w-full max-w-lg bg-slate-900/95 border border-rose-500/25 shadow-2xl rounded-3xl p-6 sm:p-8 backdrop-blur-xl relative overflow-hidden">
        
        {/* Decorative ambient aura */}
        <div className="absolute -top-24 -right-24 w-60 h-60 bg-rose-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-60 h-60 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-5 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-rose-600 to-amber-600 flex items-center justify-center text-white shadow-lg shadow-rose-900/40">
              <Crown size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-black text-white tracking-wide">SUPER ADMIN PORTAL</h1>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  Restricted
                </span>
              </div>
              <p className="text-xs text-slate-400">Master Control Center &bull; Gated Access</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onNavigateToMember}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white transition flex items-center gap-1.5 cursor-pointer"
            title="Pindah ke Halaman Login Member"
          >
            <span>Portal Member</span>
            <ArrowRight size={13} />
          </button>
        </div>

        {/* Security Alert Banner */}
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-200 flex items-start gap-2.5 mb-5">
          <ShieldAlert size={16} className="text-rose-400 shrink-0 mt-0.5" />
          <div>
            <strong>Otorisasi Terpisah:</strong> Hanya akun terdaftar di <code>public.admin_accounts</code> yang diizinkan masuk.
          </div>
        </div>

        {/* Error / Info Messages */}
        {errorMessage && (
          <div className="p-3.5 rounded-2xl bg-red-500/15 border border-red-500/30 text-xs text-red-200 flex items-start gap-2.5 mb-4 animate-shake">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">{errorMessage}</div>
          </div>
        )}

        {infoMessage && (
          <div className="p-3.5 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-xs text-cyan-200 flex items-start gap-2.5 mb-4">
            <CheckCircle2 size={16} className="text-cyan-400 shrink-0 mt-0.5" />
            <div className="flex-1">{infoMessage}</div>
          </div>
        )}

        {/* 4 PRIMARY LOGIN BUTTON CHOICES */}
        <div className="space-y-2.5 mb-6">
          {/* 1. Login with Google */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full py-3 px-4 rounded-2xl bg-white hover:bg-slate-100 text-slate-900 font-bold text-xs flex items-center justify-between transition shadow-md cursor-pointer disabled:opacity-50"
          >
            <div className="flex items-center gap-3">
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              <span>Login with Google</span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">OAuth</span>
          </button>

          {/* 2. Login with Email */}
          <button
            type="button"
            onClick={() => { setActiveTab('email'); setErrorMessage(null); }}
            className={`w-full py-3 px-4 rounded-2xl border font-bold text-xs flex items-center justify-between transition cursor-pointer ${
              activeTab === 'email'
                ? 'bg-rose-600/20 border-rose-500/60 text-white shadow-md'
                : 'bg-black/40 hover:bg-black/60 border-white/10 text-slate-300 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-3">
              <Mail size={16} className="text-rose-400" />
              <span>Login with Email</span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">Password / Auth</span>
          </button>

          {/* 3. Login with Telegram */}
          <button
            type="button"
            onClick={() => { setActiveTab('telegram'); setErrorMessage(null); }}
            className={`w-full py-3 px-4 rounded-2xl border font-bold text-xs flex items-center justify-between transition cursor-pointer ${
              activeTab === 'telegram'
                ? 'bg-cyan-600/20 border-cyan-500/60 text-white shadow-md'
                : 'bg-black/40 hover:bg-black/60 border-white/10 text-slate-300 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-3">
              <Send size={16} className="text-cyan-400" />
              <span>Login with Telegram</span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">Widget & Bot</span>
          </button>

          {/* 4. Login with WhatsApp */}
          <button
            type="button"
            onClick={() => { setActiveTab('whatsapp'); setErrorMessage(null); }}
            className={`w-full py-3 px-4 rounded-2xl border font-bold text-xs flex items-center justify-between transition cursor-pointer ${
              activeTab === 'whatsapp'
                ? 'bg-emerald-600/20 border-emerald-500/60 text-white shadow-md'
                : 'bg-black/40 hover:bg-black/60 border-white/10 text-slate-300 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-3">
              <MessageCircle size={16} className="text-emerald-400" />
              <span>Login with WhatsApp</span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">Phone OTP (Twilio)</span>
          </button>
        </div>

        {/* EXPANDED INTERFACE FOR SELECTED AUTH METHOD */}
        <div className="border-t border-white/10 pt-5">
          {/* TAB CONTENT 1: EMAIL & PASSWORD */}
          {activeTab === 'email' && (
            <form onSubmit={handleEmailSubmit} className="space-y-3.5 animate-fade-in">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Mail size={12} className="text-slate-400" />
                  <span>Email Super Admin</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="abiediendomba64@gmail.com"
                  required
                  className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/60 transition"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Key size={12} className="text-slate-400" />
                    <span>Password Master / Auth</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowForgotModal(true)}
                    className="text-[11px] text-rose-400 hover:text-rose-300 font-medium transition cursor-pointer"
                  >
                    Lupa Password?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/60 transition"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white font-bold text-xs shadow-lg shadow-rose-950/50 transition cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Memverifikasi...' : 'Masuk dengan Email & Password'}
              </button>
            </form>
          )}

          {/* TAB CONTENT 2: WHATSAPP OTP */}
          {activeTab === 'whatsapp' && (
            <div className="space-y-3.5 animate-fade-in">
              {!otpSent ? (
                <form onSubmit={handleSendWhatsAppOtp} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Phone size={12} className="text-slate-400" />
                      <span>Nomor WhatsApp Terdaftar</span>
                    </label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={e => setPhone(e.target.value)}
                      placeholder="08123456789 atau +628123456789"
                      required
                      className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/60 transition"
                    />
                    <p className="text-[11px] text-slate-500">Kode verifikasi OTP 6 digit akan dikirim melalui WhatsApp / Twilio Verify.</p>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-950/50 transition cursor-pointer disabled:opacity-50"
                  >
                    {loading ? 'Mengirim OTP...' : 'Kirim Kode OTP WhatsApp'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleVerifyWhatsAppOtp} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Key size={12} className="text-slate-400" />
                      <span>Kode OTP (6 Digit)</span>
                    </label>
                    <input
                      type="text"
                      maxLength={6}
                      value={otpToken}
                      onChange={e => setOtpToken(e.target.value)}
                      placeholder="123456"
                      required
                      className="w-full bg-black/50 border border-emerald-500/50 rounded-xl p-3 text-sm text-center tracking-widest font-mono text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOtpSent(false)}
                      className="w-1/3 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold border border-white/10 cursor-pointer"
                    >
                      Ubah Nomor
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-2/3 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-50"
                    >
                      {loading ? 'Memverifikasi...' : 'Verifikasi OTP & Masuk'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* TAB CONTENT 3: TELEGRAM WIDGET & BOT */}
          {activeTab === 'telegram' && (
            <div className="space-y-4 py-2 text-center animate-fade-in">
              <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-200 text-left space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <Send size={13} />
                  <span>Otorisasi Telegram Super Admin</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  Gunakan akun Telegram yang terdaftar sebagai Super Admin / Staf di bot resmi <strong>@sandekalabot</strong>.
                </p>
              </div>

              {/* METODE 1: BUKA BOT TELEGRAM SECARA LANGSUNG (100% RELIABLE) */}
              <div className="space-y-2.5">
                <a
                  href="https://t.me/sandekalabot?start=login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-cyan-600 via-blue-600 to-indigo-600 hover:from-cyan-500 hover:via-blue-500 hover:to-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-950/50 transition cursor-pointer"
                >
                  <Send size={16} />
                  <span>Buka Bot @sandekalabot (Ketik /login)</span>
                  <ExternalLink size={13} className="text-cyan-200" />
                </a>

                <div className="p-3.5 rounded-xl bg-black/30 border border-white/5 text-left text-[11px] text-slate-300 space-y-1.5">
                  <div className="font-semibold text-cyan-300 flex items-center gap-1.5">
                    <CheckCircle2 size={13} />
                    <span>Langkah Masuk Cepat:</span>
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-slate-400 pl-1">
                    <li>Klik tombol <strong className="text-white">Buka Bot @sandekalabot</strong> di atas.</li>
                    <li>Kirim pesan <code className="px-1.5 py-0.5 rounded bg-white/10 text-cyan-200 font-mono">/login</code> di Telegram.</li>
                    <li>Bot akan mengirimkan link <strong className="text-white">🚀 Masuk ke Dashboard</strong> untuk login otomatis.</li>
                  </ol>
                </div>
              </div>

              {/* PILIHAN TELEGRAM WEB */}
              <div className="pt-2 border-t border-white/5 space-y-2.5">
                <a
                  href="https://web.telegram.org/k/#@sandekalabot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-2.5 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-semibold border border-white/10 flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Globe2 size={14} className="text-cyan-400" />
                  <span>Buka di Telegram Web (Browser)</span>
                  <ExternalLink size={12} className="text-slate-400" />
                </a>
                <p className="text-[10px] text-slate-500">
                  🛡️ Otentikasi aman terenkripsi sekali pakai via Telegram Bot API resmi
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-white/5 text-center">
          <p className="text-[11px] text-slate-400">
            Bukan Super Admin / Staf?{' '}
            <button
              type="button"
              onClick={onNavigateToMember}
              className="text-cyan-400 hover:text-cyan-300 font-bold underline cursor-pointer"
            >
              Buka Halaman Login Member
            </button>
          </p>
        </div>

        {/* Forgot Password Modal */}
        <ForgotPasswordModal
          isOpen={showForgotModal}
          onClose={() => setShowForgotModal(false)}
          defaultEmail={email}
        />

      </div>
    </div>
  );
};
