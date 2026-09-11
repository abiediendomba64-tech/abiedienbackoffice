import React, { useState } from 'react';
import { AdminAccount } from '../lib/auth';
import { Shield, Plus, Edit2, Trash2, Key, RefreshCw, UserPlus, Mail, User as UserIcon } from 'lucide-react';

interface AdminManagerProps {
  admins: AdminAccount[];
  onRefresh: () => void;
}

export const AdminManager: React.FC<AdminManagerProps> = ({ admins, onRefresh }) => {
  const [showCreate, setShowCreate] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<AdminAccount | null>(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'admin', full_name: '', telegram_id: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleCreate = async () => {
    if (!form.email || !form.password || !form.full_name) return;
    setSaving(true);
    setMessage('');
    try {
      const { createAdminAccount } = await import('../lib/auth');
      const result = await createAdminAccount(0, form.email, form.password, form.role as 'admin' | 'dev', form.full_name, form.telegram_id ? parseInt(form.telegram_id) : undefined);
      if (result.success) {
        setShowCreate(false);
        setForm({ email: '', password: '', role: 'admin', full_name: '', telegram_id: '' });
        setMessage('Akun admin berhasil dibuat!');
        onRefresh();
      } else { setMessage(result.error || 'Gagal membuat akun'); }
    } catch (e: any) { setMessage(e.message); }
    finally { setSaving(false); }
  };

  const handleUpdate = async () => {
    if (!editingAdmin) return;
    setSaving(true);
    setMessage('');
    try {
      const { updateAdminAccount } = await import('../lib/auth');
      const result = await updateAdminAccount(editingAdmin.id, { email: form.email, role: form.role, full_name: form.full_name, telegram_id: form.telegram_id ? parseInt(form.telegram_id) : undefined });
      if (result.success) {
        setEditingAdmin(null);
        setForm({ email: '', password: '', role: 'admin', full_name: '', telegram_id: '' });
        setMessage('Akun berhasil diperbarui!');
        onRefresh();
      } else { setMessage(result.error || 'Gagal memperbarui'); }
    } catch (e: any) { setMessage(e.message); }
    finally { setSaving(false); }
  };

  const handleResetPassword = async (adminId: string) => {
    const newPass = window.prompt('Password baru (min 8 karakter):');
    if (!newPass || newPass.length < 8) return;
    try {
      const { resetAdminPassword } = await import('../lib/auth');
      const result = await resetAdminPassword(adminId, newPass);
      setMessage(result.success ? 'Password berhasil direset!' : (result.error || 'Gagal reset'));
    } catch (e: any) { setMessage(e.message); }
  };

  const handleDelete = async (adminId: string) => {
    if (!window.confirm('Hapus akun ini?')) return;
    try {
      const { deleteAdminAccount } = await import('../lib/auth');
      const result = await deleteAdminAccount(adminId);
      if (result.success) { setMessage('Akun dihapus!'); onRefresh(); }
      else setMessage(result.error || 'Gagal hapus');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          <Shield className="w-5 h-5 text-red-400" />
          Manajemen Admin & Akses
        </h3>
        <div className="flex gap-2">
          <button onClick={onRefresh} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setShowCreate(!showCreate); setEditingAdmin(null); setForm({ email: '', password: '', role: 'admin', full_name: '', telegram_id: '' }); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition">
            <UserPlus className="w-4 h-4" />Tambah Admin
          </button>
        </div>
      </div>
      {message && <div className={`px-4 py-3 rounded-lg text-sm ${message.includes('berhasil') || message.includes('dihapus') ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'}`}>{message}</div>}
      {(showCreate || editingAdmin) && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-4">
          <h4 className="text-sm font-semibold text-slate-200">{editingAdmin ? 'Edit Admin' : 'Tambah Admin Baru'}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Nama</label><input type="text" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-red-500 focus:outline-none" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-red-500 focus:outline-none" /></div>
            {!editingAdmin && <div><label className="text-xs text-slate-400 mb-1 block">Password</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-red-500 focus:outline-none" placeholder="Min 8 karakter" /></div>}
            <div><label className="text-xs text-slate-400 mb-1 block">Role</label><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-red-500 focus:outline-none"><option value="admin">Admin</option><option value="dev">Dev</option></select></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Telegram ID</label><input type="text" value={form.telegram_id} onChange={(e) => setForm({ ...form, telegram_id: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-red-500 focus:outline-none" placeholder="Opsional" /></div>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={editingAdmin ? handleUpdate : handleCreate} disabled={saving || !form.email || !form.full_name || (!editingAdmin && !form.password)} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium transition">
              <UserPlus className="w-4 h-4" />{saving ? 'Menyimpan...' : editingAdmin ? 'Perbarui' : 'Buat'}
            </button>
            <button onClick={() => { setShowCreate(false); setEditingAdmin(null); }} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm transition">Batal</button>
          </div>
        </div>
      )}
    } catch (e: any) { setMessage(e.message); }

      <div className="space-y-3">
        {admins.length === 0 ? (
          <div className="text-center py-8 text-slate-500"><Shield className="w-12 h-12 mx-auto mb-3 opacity-40" /><p>Belum ada akun admin.</p></div>
        ) : admins.map((a) => (
          <div key={a.id} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-200">{a.full_name}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${a.role === 'super_admin' ? 'bg-red-500/20 text-red-300 border-red-500/30' : a.role === 'dev' ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-sky-500/20 text-sky-300 border-sky-500/30'}`}>{a.role.toUpperCase()}</span>
                  {!a.is_active && <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-500/20 text-slate-400 border border-slate-500/30">NONAKTIF</span>}
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{a.email}</span>
                  {a.telegram_id && <span>TG: {a.telegram_id}</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => startEdit(a)} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => handleResetPassword(a.id)} className="p-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 transition"><Key className="w-3.5 h-3.5" /></button>
                {a.role !== 'super_admin' && <button onClick={() => handleDelete(a.id)} className="p-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 transition"><Trash2 className="w-3.5 h-3.5" /></button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
  };

  const startEdit = (admin: AdminAccount) => {
    setEditingAdmin(admin);
    setForm({ email: admin.email, password: '', role: admin.role, full_name: admin.full_name, telegram_id: admin.telegram_id?.toString() || '' });
    setShowCreate(false);
  };