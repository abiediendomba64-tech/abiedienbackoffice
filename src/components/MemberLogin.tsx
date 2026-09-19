import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Mail, 
  Key, 
  Phone, 
  Send, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  MessageCircle, 
  Globe2,
  ShieldCheck,
  UserPlus,
  Lock,
  Eye,
  EyeOff,
  User,
  ExternalLink,
  ArrowLeft
} from 'lucide-react';
import {
  loginMemberWithEmail,
  loginWithGoogle,
  loginWithWhatsApp,
  verifyWhatsAppOtp,
  verifyMemberAccess,
  verifyTelegramWidgetPayload,
  verifyTelegramMiniAppInitData,
  registerMember,
  signOut
} from '../lib/auth';
import { supabase } from '../lib/supabase';
import { ForgotPasswordModal } from './ForgotPasswordModal';

interface MemberLoginProps {
  onSuccess: (role: 'member', name: string, token: string) => void;
  onNavigateToAdmin: () => void;
}

export const MemberLogin: React.FC<MemberLoginProps> = ({ onSuccess, onNavigateToAdmin }) => {
  const [authMode, setAuthMode] = useState<'email' | 'telegram'>('telegram');
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Email login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // WhatsApp state
  const [phone, setPhone] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [otpSent, setOtpSent] = useState(false);

  // Registration state
  const [regFullName, setRegFullName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regTelegram, setRegTelegram] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);

  // Status state
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    (window as any).onTelegramAuth = async (tgPayload: any) => {
      setLoading(true);
      setErrorMessage(null);
      setInfoMessage(null);
      try {
        const res = await verifyTelegramWidgetPayload(tgPayload);
        if (!res.success) {
          setErrorMessage(res.error || 'Validasi signature Telegram gagal');
          setLoading(false);
          return;
        }

        if (res.role !== 'member') {
          setErrorMessage('Akses ditolak: Akun Telegram ini belum terdaftar sebagai member.');
          setLoading(false);
          return;
        }

        // Real session exchange via token_hash
        if (res.token_hash) {
          const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
            token_hash: res.token_hash,
            type: 'magiclink',
          });

          if (!otpErr && otpData?.session?.access_token) {
            const name = res.user?.full_name || res.user?.username || `Member (${tgPayload.first_name || 'TG'})`;
            onSuccess('member', name, otpData.session.access_token);
            return;
          }
        }

        // Direct session verification if already authenticated
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          const name = res.user?.full_name || res.user?.username || `Member (${tgPayload.first_name || 'TG'})`;
          onSuccess('member', name, session.access_token);
          return;
        }

        setInfoMessage(
          'Akun Telegram terverifikasi! Masukkan password akun member Anda atau gunakan link login instan dari bot.'
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

    // Auto-detect Telegram WebApp environment
    const tgWebApp = (window as any).Telegram?.WebApp;
    if (tgWebApp?.initData) {
      void verifyTelegramMiniAppInitData(tgWebApp.initData).then((verified) => {
        if (!isMounted) return;
        if (!verified.valid && verified.error) {
          console.warn('Telegram Mini App verification note:', verified.error);
        }
      });
    }

    return () => {
      delete (window as any).onTelegramAuth;
      window.removeEventListener('message', handleMessage);
    };
  }, [onSuccess]);

  // Mount Telegram Login Widget dynamically
  useEffect(() => {
    if (authMode === 'telegram') {
      const container = document.getElementById('telegram-widget-member-container');
      if (container) {
        container.innerHTML = '';
        const script = document.createElement('script');
        script.src = 'https://telegram.org/js/telegram-widget.js?22';
        script.setAttribute('data-telegram-login', 'sandekalabot');
        script.setAttribute('data-size', 'large');
        script.setAttribute('data-radius', '12');
        script.setAttribute('data-request-access', 'write');
        script.setAttribute('data-userpic', 'false');
        script.setAttribute('data-onauth', 'onTelegramAuth(user)');
        script.async = true;
        container.appendChild(script);
      }
    }
  }, [authMode]);

  // 1. Google OAuth
  const handleGoogleLogin = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await loginWithGoogle('/member/login');
      if (!res.success) {
        setErrorMessage(res.error || 'Gagal memulai otentikasi Google');
        setLoading(false);
      }
    } catch (err: any) {
      setErrorMessage(err.message);
      setLoading(false);
    }
  };

  // 2. Email Submit (Login)
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const res = await loginMemberWithEmail(email.trim(), password);
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

      const name = res.full_name || res.username || email;
      onSuccess('member', name, res.access_token);
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan autentikasi');
    } finally {
      setLoading(false);
    }
  };

  // 3. WhatsApp OTP Send
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

  // 4. WhatsApp OTP Verify
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

      if (!res.access_token) {
        await signOut();
        setErrorMessage('Login gagal: tidak ada session.');
        setLoading(false);
        return;
      }

      const verification = await verifyMemberAccess();
      if (!verification.allowed) {
        await signOut();
        setErrorMessage(verification.reason || 'Akses ditolak: Nomor WhatsApp ini tidak terhubung ke akun member.');
        setLoading(false);
        return;
      }

      const name = verification.full_name || verification.username || phone;
      onSuccess('member', name, res.access_token);
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 5. Member Registration Submit
  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (regPassword.length < 8) {
      setErrorMessage('Password minimal harus 8 karakter.');
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setErrorMessage('Konfirmasi password tidak cocok.');
      return;
    }

    setLoading(true);
    try {
      const res = await registerMember({
        email: regEmail,
        password: regPassword,
        fullName: regFullName,
        phone: regPhone,
        telegramUsername: regTelegram
      });

      if (res.pending) {
        setInfoMessage(res.message || 'Pendaftaran diterima. Menunggu persetujuan admin.');
        setEmail(regEmail);
        setPassword('');
        setIsRegisterMode(false);
        return;
      }

      if (!res.success) {
        setErrorMessage(res.error || 'Pendaftaran gagal. Periksa kembali data Anda.');
        setLoading(false);
        return;
      }

      setInfoMessage('Pendaftaran berhasil! Akun Anda telah dibuat. Silakan masuk dengan email dan password.');
      setEmail(regEmail);
      setPassword('');
      setIsRegisterMode(false);
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem pendaftaran.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between p-3.5 sm:p-6 bg-slate-950 text-slate-100 font-sans selection:bg-blue-500 selection:text-white">
      {/* Top Header Navigation */}
      <div className="w-full max-w-md mx-auto flex items-center justify-between pt-1 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center text-white shadow-md shadow-blue-900/40">
            {isRegisterMode ? <UserPlus size={16} /> : <Users size={16} />}
          </div>
          <span className="font-extrabold text-sm tracking-wide text-white">
            MEMBER PORTAL
          </span>
        </div>

        <button
          type="button"
          onClick={onNavigateToAdmin}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-300 hover:text-white transition flex items-center gap-1.5 cursor-pointer"
        >
          <span>Akses Admin</span>
          <ArrowRight size={13} />
        </button>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md mx-auto bg-slate-900/90 border border-blue-500/25 shadow-2xl rounded-3xl p-5 sm:p-7 backdrop-blur-xl relative overflow-hidden my-auto">
        {/* Ambient aura glow */}
        <div className="absolute -top-20 -right-20 w-48 h-48 bg-blue-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -left-20 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Mode Switcher Banner: Login vs Register */}
        <div className="flex items-center justify-between p-1 bg-black/50 rounded-2xl border border-white/10 mb-4">
          <button
            type="button"
            onClick={() => { setIsRegisterMode(false); setErrorMessage(null); setAuthMode('email'); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              !isRegisterMode
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Masuk Akun
          </button>
          <button
            type="button"
            onClick={() => { setIsRegisterMode(true); setErrorMessage(null); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              isRegisterMode
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Daftar Baru
          </button>
        </div>

        {/* Card Subtitle */}
        <div className="mb-4">
          <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
            {isRegisterMode
              ? 'Daftar Akun Member'
              : authMode === 'telegram'
              ? 'Login Bot Telegram'
              : 'Masuk ke Portal Member'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {isRegisterMode
              ? 'Kelola domain, tiket bantuan, dan riwayat pesanan Anda'
              : authMode === 'telegram'
              ? 'Masuk otomatis via link bot Telegram resmi'
              : 'Gunakan email dan password terdaftar Anda'}
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
        {/* VIEW A: REGISTER FORM */}
        {/* ======================================================== */}
        {isRegisterMode ? (
          <form onSubmit={handleRegisterSubmit} className="space-y-3 animate-fade-in">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <User size={13} className="text-slate-400" />
                <span>Nama Lengkap</span>
              </label>
              <input
                type="text"
                value={regFullName}
                onChange={e => setRegFullName(e.target.value)}
                placeholder="Contoh: Budi Santoso"
                required
                className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Mail size={13} className="text-slate-400" />
                <span>Email Aktif</span>
              </label>
              <input
                type="email"
                value={regEmail}
                onChange={e => setRegEmail(e.target.value)}
                placeholder="nama@domain.com"
                required
                autoComplete="email"
                className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                  <Phone size={12} className="text-slate-400" />
                  <span>No. WhatsApp</span>
                </label>
                <input
                  type="tel"
                  value={regPhone}
                  onChange={e => setRegPhone(e.target.value)}
                  placeholder="081234..."
                  className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 transition"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                  <Send size={12} className="text-slate-400" />
                  <span>Username TG</span>
                </label>
                <input
                  type="text"
                  value={regTelegram}
                  onChange={e => setRegTelegram(e.target.value)}
                  placeholder="@username"
                  className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 transition"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Lock size={13} className="text-slate-400" />
                  <span>Password (Min. 8 Karakter)</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowRegPassword(!showRegPassword)}
                  className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer"
                >
                  {showRegPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span>{showRegPassword ? 'Tutup' : 'Lihat'}</span>
                </button>
              </div>
              <input
                type={showRegPassword ? 'text' : 'password'}
                value={regPassword}
                onChange={e => setRegPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 transition"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Key size={13} className="text-slate-400" />
                <span>Konfirmasi Password</span>
              </label>
              <input
                type={showRegPassword ? 'text' : 'password'}
                value={regConfirmPassword}
                onChange={e => setRegConfirmPassword(e.target.value)}
                placeholder="Ulangi password di atas"
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold text-xs shadow-lg shadow-blue-950/50 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <span>Mendaftarkan Akun...</span>
              ) : (
                <>
                  <UserPlus size={15} />
                  <span>Daftar Sebagai Member</span>
                </>
              )}
            </button>
          </form>
        ) : (
          /* ======================================================== */
          /* VIEW B: LOGIN CHOICES */
          /* ======================================================== */
          <div>
            {/* SUBMODE 1: EMAIL & PASSWORD (DIRECT FORM) */}
            {authMode === 'email' && (
              <div className="space-y-4 animate-fade-in">
                {/* Direct Email / Password Form */}
                <form onSubmit={handleEmailSubmit} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Mail size={13} className="text-slate-400" />
                      <span>Email Member</span>
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="member@domain.com"
                      required
                      autoComplete="email"
                      className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <Key size={13} className="text-slate-400" />
                        <span>Password</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowForgotModal(true)}
                        className="text-[11px] text-blue-400 hover:text-blue-300 font-medium transition cursor-pointer"
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
                        className="w-full h-11 bg-black/40 border border-white/10 rounded-xl pl-3.5 pr-10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
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
                    className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-950/50 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 mt-1"
                  >
                    {loading ? 'Memverifikasi...' : 'Masuk ke Portal Member'}
                  </button>
                </form>

                {/* Alternative Login Options Row */}
                <div className="pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => { setAuthMode('telegram'); setErrorMessage(null); }}
                    className="w-full h-11 px-3 rounded-xl bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-500/30 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <Send size={14} className="text-cyan-400" />
                    <span>Masuk via 1-Click Telegram Resmi</span>
                  </button>
                </div>
              </div>
            )}

            {/* SUBMODE 2: TELEGRAM BOT */}
            {authMode === 'telegram' && (
              <div className="space-y-4 animate-fade-in">

                <div className="space-y-3">
                  {/* Live Telegram 1-Click Login Widget */}
                  <div className="p-3 bg-black/40 rounded-2xl border border-cyan-500/30 flex flex-col items-center justify-center gap-2">
                    <span className="text-[11px] font-semibold text-cyan-300">1-Click Login Resmi Telegram:</span>
                    <div id="telegram-widget-member-container" className="flex items-center justify-center min-h-[44px]" />
                  </div>

                  <div className="relative flex items-center justify-center my-1">
                    <div className="border-t border-white/10 w-full" />
                    <span className="bg-slate-900 px-3 text-[11px] text-slate-400 font-medium tracking-wider uppercase shrink-0">
                      atau buka bot langsung
                    </span>
                  </div>

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
                      <li>Bot mengenali akun Anda dan memberikan link instan ke dashboard.</li>
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

                  <div className="pt-2 border-t border-white/10 text-center">
                    <button
                      type="button"
                      onClick={() => { setAuthMode('email'); setErrorMessage(null); }}
                      className="text-xs text-blue-400 hover:text-blue-300 font-semibold cursor-pointer transition"
                    >
                      Atau masuk menggunakan Email & Password →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Feature Highlights Badge */}
        <div className="mt-5 pt-3.5 border-t border-white/10 flex items-start gap-2 text-[11px] text-slate-400">
          <ShieldCheck size={14} className="text-blue-400 shrink-0 mt-0.5" />
          <span>Layanan klien terintegrasi: Pesan domain, request payroll, dan dukungan teknis 24/7.</span>
        </div>

        {/* Forgot Password Modal */}
        <ForgotPasswordModal
          isOpen={showForgotModal}
          onClose={() => setShowForgotModal(false)}
          defaultEmail={email}
        />
      </div>

      {/* Footer Info & Recovery */}
      <div className="w-full max-w-md mx-auto text-center py-2 space-y-1.5">
        <button
          type="button"
          onClick={() => setShowForgotModal(true)}
          className="text-[11px] text-slate-400 hover:text-blue-300 underline font-medium transition cursor-pointer"
        >
          Kendala Akses? Buka Pemulihan Akun
        </button>
      </div>
    </div>
  );
};

