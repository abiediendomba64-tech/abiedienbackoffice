import React, { useState } from 'react';
import { 
  X, 
  Mail, 
  Phone, 
  Send, 
  Key, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink,
  ShieldCheck,
  HelpCircle,
  ArrowRight
} from 'lucide-react';
import { 
  sendPasswordResetEmail, 
  loginWithWhatsApp, 
  verifyWhatsAppOtp, 
  updateNewPassword 
} from '../lib/auth';

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultEmail?: string;
  onPasswordResetSuccess?: () => void;
}

export const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  defaultEmail = '',
  onPasswordResetSuccess
}) => {
  const [activeTab, setActiveTab] = useState<'email' | 'whatsapp' | 'telegram'>('email');

  // Email recovery state
  const [email, setEmail] = useState(defaultEmail);
  const [emailSent, setEmailSent] = useState(false);

  // WhatsApp recovery state
  const [phone, setPhone] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [waResetSuccess, setWaResetSuccess] = useState(false);

  // General state
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  // Handle Email Reset Link
  const handleEmailReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await sendPasswordResetEmail(email.trim());
      if (res.success) {
        setEmailSent(true);
        setSuccessMsg(
          `Tautan pemulihan kata sandi telah dikirim ke ${email}. Silakan periksa kotak masuk (inbox) atau folder spam email Anda.`
        );
      } else {
        setErrorMsg(res.error || 'Gagal mengirim email reset password. Pastikan alamat email terdaftar.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem.');
    } finally {
      setLoading(false);
    }
  };

  // Handle WhatsApp OTP Request
  const handleRequestWaOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await loginWithWhatsApp(phone.trim());
      if (res.success) {
        setOtpSent(true);
        setSuccessMsg(`Kode verifikasi 6 digit telah dikirim ke WhatsApp nomor ${phone}.`);
      } else {
        setErrorMsg(res.error || 'Gagal mengirim OTP ke nomor WhatsApp tersebut.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengirim OTP.');
    } finally {
      setLoading(false);
    }
  };

  // Handle WhatsApp OTP Verification
  const handleVerifyWaOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpToken.trim()) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await verifyWhatsAppOtp(phone.trim(), otpToken.trim());
      if (res.success) {
        setOtpVerified(true);
        setSuccessMsg('Nomor WhatsApp terverifikasi! Masukkan password baru Anda.');
      } else {
        setErrorMsg(res.error || 'Kode OTP salah atau telah kadaluarsa.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal verifikasi OTP.');
    } finally {
      setLoading(false);
    }
  };

  // Handle Update Password after WhatsApp OTP
  const handleSaveNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setErrorMsg('Password baru minimal harus 8 karakter.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('Konfirmasi password tidak cocok.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await updateNewPassword(newPassword);
      if (res.success) {
        setWaResetSuccess(true);
        setSuccessMsg('Password berhasil diperbarui! Anda sekarang dapat masuk dengan password baru.');
        if (onPasswordResetSuccess) onPasswordResetSuccess();
      } else {
        setErrorMsg(res.error || 'Gagal memperbarui password.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem.');
    } finally {
      setLoading(false);
    }
  };

  const resetFormState = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setEmailSent(false);
    setOtpSent(false);
    setOtpVerified(false);
    setWaResetSuccess(false);
    setOtpToken('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700/80 shadow-2xl rounded-3xl p-6 sm:p-7 relative overflow-hidden text-slate-100">
        
        {/* Ambient Top Glow */}
        <div className="absolute -top-20 -right-20 w-48 h-48 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <Key size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-wide">Pemulihan Akun & Password</h2>
              <p className="text-[11px] text-slate-400">Pilih metode verifikasi identitas resmi Anda</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { resetFormState(); onClose(); }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
            aria-label="Tutup"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="grid grid-cols-3 gap-1.5 p-1 bg-black/40 rounded-2xl border border-white/10 mb-5">
          <button
            type="button"
            onClick={() => { setActiveTab('email'); resetFormState(); }}
            className={`py-2 px-2 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'email'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Mail size={13} />
            <span>Email</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveTab('whatsapp'); resetFormState(); }}
            className={`py-2 px-2 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'whatsapp'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Phone size={13} />
            <span>WhatsApp</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveTab('telegram'); resetFormState(); }}
            className={`py-2 px-2 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'telegram'
                ? 'bg-cyan-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Send size={13} />
            <span>Telegram Bot</span>
          </button>
        </div>

        {/* Feedback Alerts */}
        {errorMsg && (
          <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-200 flex items-start gap-2 mb-4">
            <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{errorMsg}</div>
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2 mb-4">
            <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{successMsg}</div>
          </div>
        )}

        {/* TAB 1: EMAIL RECOVERY */}
        {activeTab === 'email' && (
          <div className="space-y-4">
            {!emailSent ? (
              <form onSubmit={handleEmailReset} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                    <Mail size={12} className="text-slate-400" />
                    <span>Alamat Email Akun</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="nama@domain.com"
                    required
                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
                  />
                  <p className="text-[11px] text-slate-500">
                    Kami akan mengirimkan link khusus terenkripsi untuk mereset kata sandi Anda.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-950/50 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? 'Mengirim Permintaan...' : 'Kirim Tautan Reset Password'}
                </button>
              </form>
            ) : (
              <div className="space-y-3 text-center py-2">
                <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-200 space-y-2 text-left">
                  <p className="font-semibold flex items-center gap-1.5">
                    <ShieldCheck size={14} className="text-blue-400" />
                    <span>Langkah Selanjutnya:</span>
                  </p>
                  <ol className="list-decimal list-inside text-slate-300 space-y-1 text-[11px]">
                    <li>Buka inbox email <strong>{email}</strong></li>
                    <li>Klik tombol atau tautan <strong>Reset Password</strong></li>
                    <li>Halaman pembuat password baru akan terbuka secara aman</li>
                  </ol>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailSent(false)}
                  className="text-xs text-blue-400 hover:text-blue-300 underline font-medium cursor-pointer"
                >
                  Kirim ulang ke email lain
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: WHATSAPP OTP RECOVERY */}
        {activeTab === 'whatsapp' && (
          <div className="space-y-4">
            {waResetSuccess ? (
              <div className="text-center py-4 space-y-3">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
                  <CheckCircle2 size={24} />
                </div>
                <p className="text-xs text-slate-300">
                  Password akun Anda berhasil diganti. Silakan masuk kembali dengan password baru Anda.
                </p>
                <button
                  type="button"
                  onClick={() => { resetFormState(); onClose(); }}
                  className="py-2.5 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition cursor-pointer"
                >
                  Selesai & Masuk
                </button>
              </div>
            ) : !otpVerified ? (
              !otpSent ? (
                <form onSubmit={handleRequestWaOtp} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
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
                    <p className="text-[11px] text-slate-500">
                      Sistem akan mengirimkan OTP verifikasi instan via WhatsApp Twilio.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-950/50 transition cursor-pointer disabled:opacity-50"
                  >
                    {loading ? 'Mengirim OTP...' : 'Kirim Kode Verifikasi WhatsApp'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleVerifyWaOtp} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                      <Key size={12} className="text-slate-400" />
                      <span>Kode Verifikasi (6 Digit OTP)</span>
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
                      className="w-1/3 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold border border-white/10 cursor-pointer"
                    >
                      Ubah Nomor
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-2/3 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-50"
                    >
                      {loading ? 'Memverifikasi...' : 'Verifikasi OTP'}
                    </button>
                  </div>
                </form>
              )
            ) : (
              <form onSubmit={handleSaveNewPassword} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">Password Baru (Min 8 Karakter)</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    minLength={8}
                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">Konfirmasi Password Baru</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    minLength={8}
                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-950/50 transition cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Menyimpan...' : 'Simpan & Aktifkan Password Baru'}
                </button>
              </form>
            )}
          </div>
        )}

        {/* TAB 3: TELEGRAM BOT RECOVERY */}
        {activeTab === 'telegram' && (
          <div className="space-y-4 py-1">
            <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-200 space-y-2">
              <div className="font-bold flex items-center gap-1.5">
                <Send size={14} />
                <span>Pemulihan Mandiri via Bot Telegram Resmi</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Jika akun Anda telah ditautkan dengan Telegram, Anda dapat meminta tautan pemulihan instan langsung dari bot:
              </p>
              <ol className="list-decimal list-inside text-slate-300 space-y-1 text-[11px]">
                <li>Buka bot Telegram <strong>@sandekalabot</strong></li>
                <li>Ketik perintah <code className="bg-cyan-950 px-1.5 py-0.5 rounded text-cyan-300 font-mono">/reset_password</code> atau <code className="bg-cyan-950 px-1.5 py-0.5 rounded text-cyan-300 font-mono">/login</code></li>
                <li>Bot akan menerbitkan tiket token pemulihan khusus untuk akun Anda</li>
              </ol>
            </div>

            <a
              href="https://t.me/sandekalabot"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-950/50 transition cursor-pointer"
            >
              <span>Buka @sandekalabot di Telegram</span>
              <ExternalLink size={14} />
            </a>
          </div>
        )}

        {/* FOOTER: BANTUAN LUPA USERNAME / RECOVERY SKEMA */}
        <div className="mt-5 pt-4 border-t border-white/10 flex items-start gap-2 text-[11px] text-slate-400 bg-white/[0.02] p-3 rounded-xl">
          <HelpCircle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <strong className="text-slate-300">Lupa Email atau Username Terdaftar?</strong>
            <p className="mt-0.5">
              Hubungi tim keamanan teknis via tiket darurat atau Telegram <strong>@sandekalabot</strong> dengan melampirkan nama domain website aktif Anda atau bukti pembayaran terakhir untuk verifikasi kepemilikan.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
};
