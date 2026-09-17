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
  ExternalLink,
  Eye,
  EyeOff,
  ArrowLeft
} from 'lucide-react';
import {
  loginAdminWithEmail,
  loginWithGoogle,
  loginWithWhatsApp,
  verifyWhatsAppOtp,
  verifyAdminAccess,
  verifyTelegramWidgetPayload,
  signOut
} from '../lib/auth';
import { supabase } from '../lib/supabase';
import { ForgotPasswordModal } from './ForgotPasswordModal';

interface AdminLoginProps {
  onSuccess: (role: 'super_admin' | 'dev' | 'admin', name: string, token: string) => void;
  onNavigateToMember: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onSuccess, onNavigateToMember }) => {
  const [authMode, setAuthMode] = useState<'email' | 'whatsapp' | 'telegram'>('email');
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  
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

  // Check OAuth callback / session on mount
  useEffect(() => {
    let isMounted = true;
    const checkOAuthReturn = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user && session?.access_token) {
          if (!isMounted) return;
          setLoading(true);
          const verification = await verifyAdminAccess();
          if (!verification.allowed) {
            await signOut();
            if (isMounted) {
              setErrorMessage(
                verification.reason ||
                'Akses ditolak: Akun Google ini tidak terdaftar sebagai Super Admin / Staf aktif di database backoffice.'
              );
              setLoading(false);
            }
            return;
          }
          const role = (verification.role as any) || 'super_admin';
          const name = verification.full_name || session.user.email || 'Admin';
          onSuccess(role, name, session.access_token);
        }
      } catch (err: any) {
        await signOut();
        if (isMounted) {
          setErrorMessage(err.message || 'Gagal memverifikasi sesi OAuth.');
          setLoading(false);
        }
      }
    };
    checkOAuthReturn();
    return () => { isMounted = false; };
  }, [onSuccess]);

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

        const role = (res.role as any) || 'guest';
        if (role !== 'super_admin' && role !== 'dev' && role !== 'admin') {
          setErrorMessage('Akses ditolak: Akun Telegram ini bukan Super Admin / Staf terdaftar.');
          setLoading(false);
          return;
        }

        setInfoMessage(
          'Akun Telegram terverifikasi! Untuk sesi login aman, silakan masukkan password akun admin atau gunakan link /login dari bot.'
        );
      } catch (err: any) {
        setErrorMessage(err.message || 'Gagal verifikasi Telegram');
      } finally {
        setLoading(false);
      }
    };

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
      const res = await loginAdminWithEmail(email.trim(), password);
      if (!res.success) {
        setErrorMessage(res.error || 'Email atau password salah');
        setLoading(false);
        return;
      }

      if (!res.access_token) {
        await signOut();
        setErrorMessage('Login gagal: tidak ada session.');
        setLoading(false);
        return;
      }

      const role = (res.role as any) || 'super_admin';
      const name = res.user?.email || email;
      onSuccess(role, name, res.access_token);
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
        setInfoMessage(`Kode OTP telah dikirim ke WhatsApp nomor ${phone}.`);
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

      if (!res.session?.access_token) {
        await signOut();
        setErrorMessage('Login gagal: tidak ada session.');
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
      onSuccess(role, name, res.session.access_token);
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between p-3.5 sm:p-6 bg-slate-950 text-slate-100 font-sans selection:bg-rose-500 selection:text-white">
      {/* Top Header Navigation */}
      <div className="w-full max-w-md mx-auto flex items-center justify-between pt-1 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-600 flex items-center justify-center text-white shadow-md shadow-rose-900/40">
            <Crown size={16} />
          </div>
          <span className="font-extrabold text-sm tracking-wide text-white">
            SUPER ADMIN
          </span>
        </div>

        <button
          type="button"
          onClick={onNavigateToMember}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white transition flex items-center gap-1.5 cursor-pointer"
        >
          <span>Portal Member</span>
          <ArrowRight size={13} />
        </button>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md mx-auto bg-slate-900/90 border border-rose-500/25 shadow-2xl rounded-3xl p-5 sm:p-7 backdrop-blur-xl relative overflow-hidden my-auto">
        {/* Ambient aura glow */}
        <div className="absolute -top-20 -right-20 w-48 h-48 bg-rose-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -left-20 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Card Title */}
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg sm:text-xl font-black text-white tracking-tight">
              {authMode === 'email' && 'Masuk Akun Admin'}
              {authMode === 'whatsapp' && 'Login WhatsApp OTP'}
              {authMode === 'telegram' && 'Login Telegram Bot'}
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
              Gated
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {authMode === 'email' && 'Gunakan kredensial Super Admin / Staf terdaftar'}
            {authMode === 'whatsapp' && 'Verifikasi login via kode OTP WhatsApp'}
            {authMode === 'telegram' && 'Masuk otomatis via link bot Telegram resmi'}
          </p>
        </div>

        {/* Error / Info Messages */}
        {errorMessage && (
          <div className="p-3 rounded-2xl bg-red-500/15 border border-red-500/30 text-xs text-red-200 flex items-start gap-2.5 mb-4 animate-shake">
            <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {infoMessage && (
          <div className="p-3 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-xs text-cyan-200 flex items-start gap-2.5 mb-4">
            <CheckCircle2 size={15} className="text-cyan-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{infoMessage}</div>
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 1: EMAIL & PASSWORD (PRIMARY DIRECT FORM) */}
        {/* ======================================================== */}
        {authMode === 'email' && (
          <div className="space-y-4">
            {/* Quick 1-Tap Google Button */}
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={loading}
              className="w-full h-11 px-4 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-bold text-xs flex items-center justify-center gap-2.5 transition shadow-sm cursor-pointer disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              <span>Lanjutkan dengan Google</span>
            </button>

            {/* Divider */}
            <div className="relative flex items-center justify-center my-1">
              <div className="border-t border-white/10 w-full" />
              <span className="bg-slate-900 px-3 text-[11px] text-slate-400 font-medium tracking-wider uppercase shrink-0">
                atau gunakan email
              </span>
            </div>

            {/* Direct Email / Password Form */}
            <form onSubmit={handleEmailSubmit} className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Mail size={13} className="text-slate-400" />
                  <span>Email Admin</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="abiediendomba64@gmail.com"
                  required
                  autoComplete="email"
                  className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/60 transition"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Key size={13} className="text-slate-400" />
                    <span>Password Master</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowForgotModal(true)}
                    className="text-[11px] text-rose-400 hover:text-rose-300 font-medium transition cursor-pointer"
                  >
                    Lupa?
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full h-11 bg-black/40 border border-white/10 rounded-xl pl-3.5 pr-10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/60 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition cursor-pointer"
                    title={showPassword ? 'Sembunyikan' : 'Tampilkan'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-12 rounded-xl bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white font-bold text-xs shadow-lg shadow-rose-950/50 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 mt-1"
              >
                {loading ? 'Memverifikasi...' : 'Masuk ke Dashboard Admin'}
              </button>
            </form>

            {/* Alternative Login Options Row */}
            <div className="pt-3 border-t border-white/10">
              <p className="text-[11px] text-slate-400 text-center mb-2.5">Metode login alternatif:</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => { setAuthMode('telegram'); setErrorMessage(null); }}
                  className="h-10 px-3 rounded-xl bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-500/30 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Send size={14} className="text-cyan-400" />
                  <span>Telegram Bot</span>
                </button>

                <button
                  type="button"
                  onClick={() => { setAuthMode('whatsapp'); setErrorMessage(null); }}
                  className="h-10 px-3 rounded-xl bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/30 text-emerald-200 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <MessageCircle size={14} className="text-emerald-400" />
                  <span>WhatsApp OTP</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 2: WHATSAPP OTP */}
        {/* ======================================================== */}
        {authMode === 'whatsapp' && (
          <div className="space-y-4 animate-fade-in">
            <button
              type="button"
              onClick={() => { setAuthMode('email'); setErrorMessage(null); }}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition cursor-pointer mb-1"
            >
              <ArrowLeft size={13} />
              <span>Kembali ke Login Email</span>
            </button>

            {!otpSent ? (
              <form onSubmit={handleSendWhatsAppOtp} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Phone size={13} className="text-emerald-400" />
                    <span>Nomor WhatsApp Terdaftar</span>
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="08123456789 atau +628123456789"
                    required
                    className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/60 transition"
                  />
                  <p className="text-[11px] text-slate-400">Kode OTP 6 digit akan dikirim melalui WhatsApp resmi.</p>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-950/50 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? 'Mengirim OTP...' : 'Kirim Kode OTP WhatsApp'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyWhatsAppOtp} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Key size={13} className="text-emerald-400" />
                    <span>Masukkan 6 Digit OTP</span>
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={otpToken}
                    onChange={e => setOtpToken(e.target.value)}
                    placeholder="123456"
                    required
                    autoFocus
                    className="w-full h-12 bg-black/50 border border-emerald-500/60 rounded-xl px-3 text-base text-center tracking-widest font-mono text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOtpSent(false)}
                    className="w-1/3 h-11 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold border border-white/10 cursor-pointer transition"
                  >
                    Ubah Nomor
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-2/3 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-50"
                  >
                    {loading ? 'Memverifikasi...' : 'Verifikasi & Masuk'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 3: TELEGRAM BOT */}
        {/* ======================================================== */}
        {authMode === 'telegram' && (
          <div className="space-y-4 animate-fade-in">
            <button
              type="button"
              onClick={() => { setAuthMode('email'); setErrorMessage(null); }}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition cursor-pointer mb-1"
            >
              <ArrowLeft size={13} />
              <span>Kembali ke Login Email</span>
            </button>

            <div className="space-y-3">
              <a
                href="https://t.me/sandekalabot?start=login"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full h-12 rounded-xl bg-gradient-to-r from-cyan-600 via-blue-600 to-indigo-600 hover:from-cyan-500 hover:via-blue-500 hover:to-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-950/50 transition cursor-pointer"
              >
                <Send size={15} />
                <span>Buka Bot Telegram (@sandekalabot)</span>
                <ExternalLink size={13} className="text-cyan-200" />
              </a>

              <div className="p-3.5 rounded-2xl bg-black/40 border border-white/10 text-left text-[11px] text-slate-300 space-y-2">
                <div className="font-semibold text-cyan-300 flex items-center gap-1.5">
                  <CheckCircle2 size={13} />
                  <span>3 Langkah Masuk Otomatis:</span>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 pl-0.5">
                  <li>Klik tombol <strong className="text-white">Buka Bot Telegram</strong>.</li>
                  <li>Kirim pesan <code className="px-1.5 py-0.5 rounded bg-white/10 text-cyan-200 font-mono">/login</code> di chat bot.</li>
                  <li>Bot memverifikasi akun Anda dan memberikan tombol link instan.</li>
                </ol>
              </div>

              <a
                href="https://web.telegram.org/k/#@sandekalabot"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full h-10 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-semibold border border-white/10 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Globe2 size={13} className="text-cyan-400" />
                <span>Buka di Telegram Web (Browser)</span>
                <ExternalLink size={12} className="text-slate-400" />
              </a>
            </div>
          </div>
        )}

        {/* Security Alert Badge */}
        <div className="mt-5 pt-3.5 border-t border-white/10 flex items-start gap-2 text-[11px] text-slate-400">
          <ShieldAlert size={14} className="text-rose-400 shrink-0 mt-0.5" />
          <span>Akses terbatas untuk administrator terdaftar di database Backoffice.</span>
        </div>

        {/* Forgot Password Modal */}
        <ForgotPasswordModal
          isOpen={showForgotModal}
          onClose={() => setShowForgotModal(false)}
          defaultEmail={email}
        />
      </div>

      {/* Footer Info */}
      <div className="w-full max-w-md mx-auto text-center py-2">
        <p className="text-[11px] text-slate-500">
          Bukan Admin?{' '}
          <button
            type="button"
            onClick={onNavigateToMember}
            className="text-cyan-400 hover:text-cyan-300 font-bold underline cursor-pointer"
          >
            Masuk sebagai Member
          </button>
        </p>
      </div>
    </div>
  );
};

