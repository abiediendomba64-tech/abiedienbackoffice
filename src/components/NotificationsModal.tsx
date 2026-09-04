import React, { useState, useEffect } from 'react';
import { Bell, X, Send, CheckCircle2, Clock, AlertTriangle, RefreshCw, MessageSquare } from 'lucide-react';
import { TelegramNotificationRecord, getTelegramNotifications, sendTelegramNotification } from '../lib/api';

interface NotificationsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NotificationsModal: React.FC<NotificationsModalProps> = ({ isOpen, onClose }) => {
  const [notifications, setNotifications] = useState<TelegramNotificationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [recipient, setRecipient] = useState('@AbiedOpsBot');
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);

  const loadNotifications = async () => {
    setLoading(true);
    const data = await getTelegramNotifications();
    setNotifications(data);
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen) {
      loadNotifications();
      const interval = setInterval(loadNotifications, 4000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  const handleSendTestMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim()) return;
    setSending(true);
    await sendTelegramNotification(recipient, messageText);
    setMessageText('');
    await loadNotifications();
    setSending(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh] animate-fade-in">
        {/* Modal Header */}
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-xs">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">Telegram Bot Delivery System</h3>
              <p className="text-xs text-slate-500 font-medium">Real-time notification tracking, queue status, and emergency dispatch</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Send Notification Form */}
        <div className="p-6 border-b border-slate-100 bg-slate-50/40">
          <form onSubmit={handleSendTestMessage} className="space-y-3">
            <div className="flex gap-3">
              <select
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="@AbiedOpsBot">@AbiedOpsBot (Admin Group)</option>
                <option value="@AbiedSecurityAlerts">@AbiedSecurityAlerts</option>
                <option value="@AbiedClusterDeploy">@AbiedClusterDeploy</option>
              </select>
              <input
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Type emergency alert or operator notification..."
                className="flex-1 bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                type="submit"
                disabled={sending || !messageText.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{sending ? 'Dispatching...' : 'Dispatch'}</span>
              </button>
            </div>
          </form>
        </div>

        {/* Notification Delivery List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase text-slate-400 tracking-wider">Delivery Tracking Status Logs</span>
            <button
              onClick={loadNotifications}
              className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh Status</span>
            </button>
          </div>

          {notifications.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-xs font-medium">
              No Telegram delivery records found.
            </div>
          ) : (
            notifications.map((notif) => (
              <div key={notif.id} className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 space-y-2 hover:border-slate-300 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-slate-800">{notif.id}</span>
                    <span className="text-xs bg-slate-200/80 text-slate-700 px-2 py-0.5 rounded font-medium">{notif.recipient}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {notif.status === 'Sent' && (
                      <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Sent
                      </span>
                    )}
                    {notif.status === 'Pending' && (
                      <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                        <Clock className="w-3 h-3 text-amber-600 animate-spin" /> Pending
                      </span>
                    )}
                    {notif.status === 'Failed' && (
                      <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-700 border border-rose-200 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                        <AlertTriangle className="w-3 h-3 text-rose-600" /> Failed
                      </span>
                    )}
                    <span className="text-[11px] text-slate-400 font-mono">{notif.timestamp}</span>
                  </div>
                </div>
                <p className="text-xs text-slate-700">{notif.message}</p>
                {notif.error && (
                  <div className="text-[11px] bg-rose-50/80 text-rose-600 px-3 py-1.5 rounded-xl border border-rose-100 font-mono">
                    Diagnostic Error: {notif.error}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between text-xs text-slate-500 font-medium">
          <span>Telegram Webhook Sync Active • End-to-End Encrypted</span>
          <button
            onClick={onClose}
            className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
