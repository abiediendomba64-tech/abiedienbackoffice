import React, { useState } from 'react';
import { 
  Key, 
  CheckCircle2, 
  AlertCircle, 
  ShieldCheck, 
  ArrowRight, 
  Lock,
  Eye,
  EyeOff
} from 'lucide-react';
import { updateNewPassword } from '../lib/auth';

interface ResetPasswordPageProps {
  onNavigate: (path: string) => void;
}

export const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({ onNavigate }) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Validation rules
  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasLetter = /[a-zA-Z]/.test(password);
  const passwordsMatch = password.length > 0 && password === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!hasMinLength || !hasNumber || !hasLetter) {
      setErrorMsg('Password harus memiliki minimal 8 karakter dan mengandung huruf serta angka.');
      return;
    }

    if (!passwordsMatch) {
      setErrorMsg('Konfirmasi password tidak cocok dengan password baru.');
      return;
    }

    setLoading(true);

    try {
      const res = await updateNewPassword(password);
      if (res.success) {
        setSuccess(true);
      } else {
        setErrorMsg(res.error || 'Gagal memperbarui password. Tautan mungkin telah kadaluarsa.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem saat memperbarui password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950 text-slate-100 font-sans selection:bg-blue-500 selection:text-white">
      <div className="w-full max-w-md bg-slate-900/95 border border-slate-800 shadow-2xl rounded-3xl p-6 sm:p-8 backdrop-blur-xl relative overflow-hidden">
        
        {/* Ambient background decoration */}
        <div className="absolute -top-24 -right-24 w-60 h-60 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-60 h-60 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white mx-auto mb-3 shadow-lg shadow-blue-900/30">
            <Key size={22} />
          </div>
          <h1 className="text-lg font-black text-white tracking-wide">SETEL PASSWORD BARU</h1>
          <p className="text-xs text-slate-400 mt-1">
            Buat kata sandi baru yang aman untuk mengakses akun Anda
          </p>
        </div>

        {/* Success State */}
        {success ? (
          <div className="space-y-5 text-center py-4 animate-fade-in">
            <div className="w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
              <CheckCircle2 size={32} />
            </div>

            <div className="space-y-1">
              <h2 className="text-sm font-bold text-white">Password Berhasil Diperbarui!</h2>
              <p className="text-xs text-slate-300">
                Kredensial baru Anda telah aktif. Silakan pilih portal masuk di bawah ini untuk melanjutkan.
              </p>
            </div>

            <div className="space-y-2.5 pt-2">
              <button
                type="button"
                onClick={() => onNavigate('/member/login')}
                className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-950/50 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <span>Masuk ke Portal Member</span>
                <ArrowRight size={14} />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('/admin/login')}
                className="w-full py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white font-semibold text-xs border border-white/10 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <span>Masuk ke Portal Admin</span>
              </button>
            </div>
          </div>
        ) : (
          /* Form State */
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMsg && (
              <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-200 flex items-start gap-2 animate-shake">
                <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed">{errorMsg}</div>
              </div>
            )}

            {/* Input Password Baru */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span>Password Baru</span>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer"
                >
                  {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span>{showPassword ? 'Sembunyikan' : 'Lihat'}</span>
                </button>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Minimal 8 karakter (huruf & angka)"
                  required
                  className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
                />
              </div>
            </div>

            {/* Input Konfirmasi Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">
                Konfirmasi Password Baru
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Ulangi password baru Anda"
                required
                className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/60 transition"
              />
            </div>

            {/* Password Requirement Checklist */}
            <div className="p-3 rounded-xl bg-black/30 border border-white/5 space-y-1 text-[11px]">
              <div className="text-slate-400 font-medium mb-1">Standar Keamanan Kata Sandi:</div>
              <div className={`flex items-center gap-1.5 ${hasMinLength ? 'text-emerald-400' : 'text-slate-500'}`}>
                <CheckCircle2 size={12} />
                <span>Minimal 8 karakter</span>
              </div>
              <div className={`flex items-center gap-1.5 ${hasNumber && hasLetter ? 'text-emerald-400' : 'text-slate-500'}`}>
                <CheckCircle2 size={12} />
                <span>Kombinasi huruf dan angka</span>
              </div>
              <div className={`flex items-center gap-1.5 ${passwordsMatch ? 'text-emerald-400' : 'text-slate-500'}`}>
                <CheckCircle2 size={12} />
                <span>Konfirmasi password cocok</span>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || !hasMinLength || !passwordsMatch}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-blue-950/50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <span>Memproses Pembaruan...</span>
              ) : (
                <>
                  <Lock size={14} />
                  <span>Simpan & Aktifkan Password</span>
                </>
              )}
            </button>

            {/* Back link */}
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => onNavigate('/member/login')}
                className="text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
              >
                Kembali ke Halaman Login
              </button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
};
