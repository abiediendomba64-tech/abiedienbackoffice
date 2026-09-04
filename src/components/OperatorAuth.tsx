import React, { useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { verifyDashboardAccess } from '../lib/api';
import { ShieldCheck, Lock, Mail, ArrowRight, AlertCircle, Cpu } from 'lucide-react';

interface OperatorAuthProps {
  onLoginSuccess: (user: any) => void;
}

export const OperatorAuth: React.FC<OperatorAuthProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('abiediendomba64@gmail.com');
  const [password, setPassword] = useState('••••••••••••');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (isSupabaseConfigured) {
      try {
        const { data, error: authError } = await supabase.auth.signInWithPassword({
          email,
          password
        });
        if (authError) {
          setError(authError.message);
          setLoading(false);
          return;
        }
        if (data.user) {
          // Strict server-side / database capability check for dashboard_access
          const hasAccess = await verifyDashboardAccess(data.user.id);
          if (!hasAccess) {
            setError('Access Denied: Strict server validation indicates account lacks `dashboard_access` capability.');
            await supabase.auth.signOut();
            setLoading(false);
            return;
          }
          onLoginSuccess(data.user);
        }
      } catch (err: any) {
        setError(err.message || 'Authentication error occurred.');
      }
    } else {
      setTimeout(async () => {
        if (email.includes('@')) {
          const hasAccess = await verifyDashboardAccess('USR-001');
          if (!hasAccess) {
            setError('Access Denied: `dashboard_access` capability not permitted.');
            setLoading(false);
            return;
          }
          onLoginSuccess({
            id: 'USR-001',
            email,
            user_metadata: { name: 'Abied Iendomba', role: 'Super Admin', dashboard_access: true }
          });
        } else {
          setError('Please enter a valid operator email.');
        }
        setLoading(false);
      }, 600);
    }
  };

  const handleDemoLogin = async () => {
    setLoading(true);
    const hasAccess = await verifyDashboardAccess('USR-001');
    if (!hasAccess) {
      setError('Access Denied: `dashboard_access` required.');
      setLoading(false);
      return;
    }
    onLoginSuccess({
      id: 'USR-001',
      email: 'abiediendomba64@gmail.com',
      user_metadata: { name: 'Abied Iendomba', role: 'Super Admin', dashboard_access: true }
    });
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700/80 rounded-3xl p-8 max-w-md w-full shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 bg-blue-600/20 border border-blue-500/30 rounded-2xl flex items-center justify-center mx-auto text-blue-400 shadow-inner">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Abiedien Backoffice</h1>
          <p className="text-xs text-slate-400">GitHub & Supabase Enterprise Access Control for Admin, Dev & Super Admin</p>
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3.5 rounded-xl text-xs flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Operator Email</label>
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="operator@abiedien.internal"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Secure Password / Token</label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="••••••••••••"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2 transition-all cursor-pointer"
          >
            <span>{loading ? 'Validating Dashboard Access...' : 'Authenticate Operator Session'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="pt-4 border-t border-slate-700/60 text-center space-y-2">
          <button
            onClick={handleDemoLogin}
            disabled={loading}
            className="text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
          >
            Quick Demo Login as Abied Iendomba (Super Admin)
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-500 font-mono">
            <Cpu className="w-3 h-3 text-blue-500" />
            <span>Enforcing `dashboard_access` RBAC validation schema</span>
          </div>
        </div>
      </div>
    </div>
  );
};
